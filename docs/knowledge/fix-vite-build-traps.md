# Fix: Vite-специфичные ловушки сборки (main + renderer)

Ловушки Vite, связанные с **build-time трансформацией**, runtime-адресами
внутри ASAR и входными файлами сборки.

## Часть 1: `$` в template literals = «Unexpected character $»

### Симптом
`npm run dev` падает на старте: `Transform failed: Unexpected character '$'`, указывает на `main.js`. Приложение не запускается. До этого работало — сломалось после правки bash-команды.

### Причина
В `main.js` шаблонные строки с bash-командами, содержащими переменные shell (`$PWD`, `$HOME`, `$9` в awk). Vite транспилирует main-процесс и видит `$` внутри `` ` `` как попытку JS-интерполяции — но `PWD`/`9` — не JS-выражения.

### Решение

**Простой случай — экранируй `$`:**
```js
const cmd = `echo \$PWD`;  // bash получит literal $PWD
```

**Сложный случай (awk и др.) — конкатенация:**
```js
// awk '{print $9}' — нельзя экранировать $9 в template literal
const cmd = 'lsof -p ' + pid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'';
```
Через `+ '\$' +` Vite видит `\$` как часть обычной строки (не template literal) и не пытается интерпретировать.

### Где это всплывает
- Любые spawn'ы bash из main с переменными.
- Особенно `lsof`, `awk`, `ps -o` с positional `$1`, `$2`, ...
- Не относится к renderer'у (там обычно нет shell-команд в template literals).

---

## Часть 2: `process.env.X` в renderer = `undefined` в production

### Симптомы
- API calls возвращают `key=undefined` в **production** (packaged app)
- В **dev** (`npm run dev`) всё работает
- Gemini/Anthropic API возвращает 400 «API key not valid»

### Причина
Vite заменяет `process.env.X` в renderer-коде на **литерал при сборке**. Если env var не определён в build-time контексте — подставится `undefined`. Main process работает с настоящим Node.js `process.env` (runtime), renderer — с замороженным снапшотом времени сборки.

### Решение для ключей — runtime ENV и локальный IPC

Ключи нельзя подставлять через Vite `define`: значение окажется в renderer JS,
артефакте сборки и при ошибочном коммите — в истории. Main читает локальный `.env`
на старте приложения; `settings:get-gemini-api-key` возвращает только configured
Gemini key существующим renderer-действиям. Общий `getGeminiApiKey` используется
названиями, описаниями, EditRange и AI-Rewind. Rewind/cancel сохраняют свои guards
после await. HTTP/model runner не дублируется, синхронный IPC не добавляется.

`define` допустим для несекретных build constants. Прежнее решение inline ENV
исправляло undefined в production, но не подходило для распространяемого приложения:
renderer должен получать credential runtime, сохраняя существующие API-действия.
Runtime-key tests проверяют actual IPC registration на синтетическом ENV; сборка
с key-canary дополнительно проверяет, что значение не попало в renderer output.

---

## Часть 3: root `index.html` стал production artifact

### Симптом
`npm run build` падает в начале renderer-сборки:

```text
vite ... building client environment for production...
Error: Failed to resolve /assets/index-CC3JuWHx.js from /Users/fedor/Desktop/custom-terminal/index.html
```

Файл `/assets/index-*.js` реально не обязан существовать в source tree — это hash-артефакт предыдущей production-сборки.

### Причина
`electron.vite.config.js` использует root `index.html` как renderer input. Если этот source-файл случайно заменить содержимым из `dist/index.html` / packaged bundle, новая сборка воспринимает `<script src="/assets/index-*.js">` и `<link href="/assets/index-*.css">` как исходные зависимости и пытается резолвить старые hash-файлы до генерации новых.

Это особенно легко пропустить при правке CSP: production `dist/index.html` и source `index.html` выглядят почти одинаково, но source-файл должен ссылаться на entrypoint, а не на готовые assets.

### Решение
Root `index.html` должен оставаться Vite source input:

```html
<div id="react-root"></div>
<script type="module" src="/src/renderer/main.tsx"></script>
```

В source `index.html` не должно быть `/assets/index-*.js` и `/assets/index-*.css`. CSS приходит через import из renderer entrypoint (`main.tsx`), а hashed assets появляются только внутри `dist/` после сборки. После ручной CSP-правки проверяй оба инварианта сразу: CSP содержит нужные directives, но script entry остался `/src/renderer/main.tsx`.

---

## Часть 4: root `main-*.js` bundle или sensitive asset попал в git history

### Симптом
`git push` отклоняется GitHub push protection / secret scanning, хотя текущий working tree уже не содержит ключей. В UI при этом счётчики ahead/behind выглядят пугающе (`150↑ 146↓`), потому что локальная история и удалённая ветка разошлись после force-update/rewrites.

### Причина
Случайно отслеженный root-level generated bundle вида `main-*.js` попал в историю. Такие файлы не являются source проекта: это большой minified артефакт сборки, в котором могут оказаться inline env/config фрагменты. Даже если файл удалён в текущем коммите, secret scanning проверяет всю pushed history и блокирует push до удаления записи из истории.

Тот же класс для binary assets: README/marketing screenshot может содержать public remote URL, token-like query или IP. Замазать текущий PNG недостаточно — старые binary blob'ы остаются достижимы через git history, fork/clone/cache и будут всплывать при аудитах или публикации старого commit'а.

### Решение
Текущий source-fix — `/main-*.js` в `.gitignore`: root generated bundles не должны попадать в индекс. Если файл уже попал в pushed range и GitHub блокирует push, обычный follow-up commit с удалением недостаточен; нужно переписать историю (например, filter-branch/filter-repo по конкретным root bundle paths), затем force-push уже очищенную ветку. Для чувствительных PNG/JPG лучше работать по blob ids (`git rev-list --objects --all -- <path>` → old blob ids → `git filter-repo --strip-blobs-with-ids <file>`), потому что path может сохраняться тем же, а содержимое должно замениться только на redacted current blob. Перед force-push сделать backup branch и проверить, что старые blob ids недоступны (`git cat-file -e <old>` должен падать). Не переносить это правило на `dist/renderer/assets/main-*.js`: dist artifacts живут в своей папке и управляются build/release flow, проблема именно в root-level случайном bundle рядом с source-файлами.

---

## Часть 5: локальный CJS существует в ASAR, но main ищет его рядом с `dist`

### Симптом

Build/install завершается, но установленное приложение падает до создания окна:

```text
Cannot find module '../shared/working-directory.cjs'
Require stack: .../app.asar/dist/main/main.js
```

### Причина

Source `src/main/main.js` использовал статический
`require('../shared/working-directory.cjs')`. Electron Vite сохранил его как
относительный require в `dist/main/main.js`, поэтому runtime искал
`dist/shared/working-directory.cjs`. Builder действительно упаковал helper, но
по source-адресу `src/shared/working-directory.cjs`; наличие файла в ASAR само
по себе не исправляет неверный адрес. Добавление helper в main
`commonjsOptions` не изменило фактический bundle — это проверено изолированной
electron-vite main-сборкой и не оставлено как ложный ремонт.

### Решение и защита

Main загружает shared CJS через уже существующий `srcSharedDir`, вычисленный как
`__dirname/../../src/shared`; эта схема одинаково разрешается из `src/main` и
`dist/main`, а `src/shared/**/*` входит в electron-builder files. Renderer
бандлит те же CJS через свою Vite CommonJS admission; у DEV отдельная
optimizer/alias граница из части7 ниже, без изменения Main runtime requires.

`validate-app-asar.mjs` после проверки hashes дополнительно читает упакованный
`dist/main/main.js` и отвергает статический относительный require без реальной
цели в ASAR. Поэтому следующий такой build падает до подписи/install, а не
показывает пользователю main-process exception. Динамические `path.join`
requires проверяются отдельным source↔package wiring-тестом.

Изолированный proof: настоящий electron-vite main output содержит
`require(path.join(srcSharedDir, "working-directory.cjs"))`, не содержит старого
относительного require; synthetic ASAR подтвердил42 файла и2786043 байта.
Это source/isolated package proof, не установленная приёмка.

## Часть 6: `--configLoader runner` не заменяет обычную загрузку конфига

В приватной сборке shared markdown-editor14.10 Vite6.4.1 с добавленным
`--configLoader runner` остановился ещё при загрузке неизменённого
`vite.config.ts`: `ReferenceError: __dirname is not defined`. Наличие самого
флага в CLI не доказывает совместимость с существующим конфигом, который
использует `resolve(__dirname, ...)`.

На новой физической копии тех же исходников обычный `vite build`, как в
package script, завершил library output и declarations; последующий
electron-vite build дал Main/renderer/assets. Product config не переписывался.
Изоляцию обеспечивают приватные dependency/output/cache paths, а не смена
семантики config loader. Временные config bundles должны оставаться внутри
этой копии. Сохранять отдельно исходный exit1 и успешный новый результат;
build PASS ещё не означает Electron/runtime/installed PASS.
Evidence: `/private/tmp/noted-ui-lag-0715-jc9pi7rs/startup27/build37/evidence/shared-build-result.json`
и `build38/evidence/shared-build-result.json` в том же startup27.

## Часть 7: DEV optimizer output не доказывает browser CJS interop

15.10 actual ordinary DEV NEW04 показал видимое пустое окно: browser import
`/src/shared/workflow-drag.cjs?import` не имел named export `applyDragLayout`.
Абсолютные `optimizeDeps.include` действительно создавали optimizer output,
но относительный исходный import обходил bare-import resolution; прежние
5tests проверяли только output/needsInterop/default/transitive require.

`scripts/lib/renderer-shared-cjs.mjs` теперь в `apply:serve` перенаправляет
только production CJS из `src/shared` через bare aliases в обычный optimizer.
Named/default/re-export interop выполняет сам Vite, не format-only esbuild
transform. `?raw`/`?url`, чужие пути, tests, Main и production build не меняются.
Actual Vite transformRequest regression воспроизвёл raw browser import RED;
после ремонта его emitted ESM выполняется с реальными nested requires и
общей named/default identity. Вместе с прежними controls7PASS/0skip. Это SOURCE
проверка serving boundary, не feature acceptance. Новый actual DEV NEW05 уже
подтвердил visible Home/App bootstrap; создание native-question fixture затем
отказало по отдельному private catalog guard до Send. NEW04 evidence:
`docs/tmp/native-question-3951-20261015/e2e/retake04/main-selected.log`.
