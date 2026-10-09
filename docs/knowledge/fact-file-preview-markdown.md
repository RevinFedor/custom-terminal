# File Preview: Unified Markdown Reader

## Контекст (WHY)

**Проблема:** До февраля 2026 в FilePreview использовалась разношёрстная связка:
- `react-markdown` + `remark-gfm` для `.md` файлов (read-only viewer)
- `highlight.js` для подсветки кода в других файлах
- Разные стили, разный UX, нет единообразия

**Решение:** Всё заменено на общий `@gt-editor/markdown-editor` в режиме `readOnly`
(прежнее имя локального пакета — `@anthropic/markdown-editor`).

## Критическая информация (что нельзя вывести из кода)

### 1. Источник пакета `@gt-editor/markdown-editor`

**ВАЖНО:** Это **НЕ** публичный npm-пакет. Это локальный проект на рабочем столе:
- Путь: `/Users/fedor/Desktop/gt-editor/packages/markdown-editor/`
- При изменении пакета перед сборкой Noted Terminal нужен `npm run build:markdown`:
  он собирает GT package и синхронизирует dist в локальную копию consumer.
- Если удалить папку `gt-editor` с десктопа — приложение сломается
- При деплое нужно либо копировать gt-editor, либо опубликовать пакет в приватный registry

### 2. ReadOnly ≠ Статичный HTML

`readOnly` в MarkdownEditor — это **НЕ** полностью мёртвый текст:
- ✅ Работают collapsible headers (складывание секций по клику на заголовок)
- ✅ Работают кликабельные ссылки
- ✅ Работает syntax highlighting для code blocks (автоопределение языка)
- ✅ Работает фолдинг секций
- ❌ Нельзя редактировать текст

Это **интерактивный** просмотрщик, в отличие от react-markdown, где всё было статичным HTML.

### 2a. Mobile/native file-tab preview — параллельный reader, не desktop FilePreview

Desktop linked file-tabs и sidebar preview остаются на `@gt-editor/markdown-editor` в `FilePreview.tsx`: это rich read-only editor с fold state, line numbers и shared font-size. Mobile/native file-tab preview intentionally не переиспользует этот компонент. Телефон открывает file-tab как bottom-sheet через `/api/file-preview`; mobile-web рендерит Markdown уже подключённым `@noted/claude-blocks::Markdown`, а native iOS переиспользует свой `GTFilePreviewSheet` с custom file-loader на тот же endpoint. Причина не в «другой визуал ради другого визуала»: phone surface — быстрый read-only inspection поверх списка, не полноценная editor-surface, и не должен зависеть от mounted desktop renderer/FilePreview state.

### 3. Почему не удалили react-markdown из dependencies

`react-markdown` + `remark-gfm` + `react-syntax-highlighter` **ещё используются** в:
- `src/renderer/components/Research/MarkdownRenderer.tsx` (AI Research модуль)
- `src/renderer/components/Research/CodeBlock.tsx` (там нужен именно react-syntax-highlighter)

Убирать их из package.json **НЕЛЬЗЯ** — сломается Research.

### 4. Clipboard API в Electron (ЛОВУШКА)

В `FilePreview.tsx` строка 17:

```ts
const { clipboard } = window.require('electron');
clipboard.writeText(filePreview.content);
```

**Почему не `navigator.clipboard.writeText()`?**

В Electron `navigator.clipboard` **ненадёжен** (race conditions, permissions issues).
Всегда использовать `window.require('electron').clipboard` для операций с буфером обмена.

См. также: `docs/knowledge/fact-input-events.md` (раздел про Clipboard).

### 5. Шапка и общий размер шрифта

По решению08.10 шапка оставляет имя файла, иконки GT Editor/Sublime, Copy All
и закрытие. Полный путь остаётся в title, inline font stepper убран: длинный
путь и вспомогательные настройки не должны вытеснять читаемое имя.
`fontSize` по-прежнему берётся из `useUIStore.filePreviewFontSize`; контрол
«Превью файла» находится в Settings → Размеры. Единое значение10..24px и прежняя
память размеров сохраняются. Его изменение переконфигурирует тему живого
EditorView, сохраняя selection/undo и scroller, к которому подписан host.

### 6. FoldStateKey — персистентное состояние фолдинга

```ts
foldStateKey={`file-preview:${filePreview.path}`}
```

Это ключ для сохранения состояния свёрнутых секций в `localStorage`.
- Если пользователь свернул заголовок H2 в файле `README.md` → при повторном открытии этот же заголовок останется свёрнутым
- Если поменять/убрать `foldStateKey` → состояние сбросится

### 6a. Память позиции чтения

Позиция прокрутки хранится **по абсолютному пути файла**, а не по вкладке. Причина продуктовая: sidebar открывает preview вообще без вкладки, и пользователь ожидает вернуться туда, где читал, независимо от того, открыт файл из tab bar или из дерева. Ключ `noted-terminal-file-preview-scroll` зеркалится в SQLite общим localStorage-mirror'ом. Карта ограничена по размеру с вытеснением давно не открывавшихся: она растёт с каждым просмотренным файлом и сохраняется целиком. Позиция «в начале файла» хранится как отсутствие записи, а не как нулевое значение — иначе слот занят навсегда.

**Историческая ловушка версии пакета.** Старый build объявлял `onEditorView`/
`initialScrollTop` без действующей реализации; поэтому host использует DOM-поиск
scroller. На проверенном08.10 source и пересобранном dist callback действительно
вызывается при create/destroy; исходник также применяет initialScrollTop.
Прежнее безусловное утверждение об игнорировании props больше не актуально.
Host lifecycle в этом ремонте не переписывался: при будущем переходе на callback
нужно отдельно сохранить path/view ownership и отмену старого restore.

**Восстановление повторяется, пока документ растёт.** CodeMirror рендерит длинный файл лениво, поэтому первое присвоение упирается в текущую (неполную) высоту, и позиция сползает вверх при каждом открытии. Восстановление повторяется несколькими проходами и закрывается по фиксированному сроку — недостижимая позиция (файл стал короче) осядет у нижней границы, а окно восстановления не останется открытым навсегда. Пока идёт восстановление, события прокрутки игнорируются как эхо собственной записи: без этого промежуточное неполное значение сохранялось поверх правильного и память деградировала при каждом открытии. Переносимый принцип — `methodology/дизайн-принципы.md::Восстановление позиции в лениво растущем контейнере`.

**Проверенная граница08.10:** Parent прогнал actual full app/Main/store/SQLite
на пересобранном пакете в отдельном visible Electron: A→B→A, закрытие приложения,
новый Main, повторное открытиеA и следующий wheel. ПозицииA3664/B900 сохранились,
после restartA восстановилась3664 и новый wheel записал4764 вSQLite. Тем самым
прежняя открытая граница записи новой позиции закрыта для private full app.
Installed версия и полный пользовательский workspace этим не проверены.

### 6b. Файл из sidebar переживает переход между проектами

`sidebarPersistFile` описывает цикл «закрыл → открыл сайдбар», а не «ушёл из проекта → вернулся». Раньше sync-эффект не различал эти события: возврат в проект попадал в ту же ветку, что и закрытие сайдбара, и открытый файл терялся (а при закрытом сайдбаре ещё и стирался сохранённый путь покидаемого проекта). Теперь смена проекта отличается явно: уход ничего не очищает, а возврат восстанавливает переживший файл независимо от настройки — очищать было нечего, значит и восстанавливать нечего запрещать. Переносимый принцип — `methodology/дизайн-принципы.md::Уход из контекста — не отмена внутри него`.

### 7. Open in Sublime Text

FilePreview остаётся read-only поверх `MarkdownEditor`; кнопка `Sublime` в header'е — явный выход из режима чтения в полноценный внешний редактор. Это не должно идти через renderer `exec` или `shell.openPath`: production `.app` на macOS наследует launchd PATH без Homebrew/user-local bin, поэтому main-side handler сам расширяет PATH (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local/bin`), валидирует что путь абсолютный и указывает на файл, затем пробует `SUBLIME_TEXT_CLI`, app-bundle `subl`, `subl` из PATH и только потом `open -a "Sublime Text"`.

Fallback на LaunchServices нужен потому что у пользователя Sublime может быть установлен как `.app`, но `subl` не добавлен в shell PATH. Обратная ситуация тоже частая: CLI есть через Homebrew, а app path отличается. Логи `[FileOps:Sublime]` намеренно пишут и failed candidates, и successful method — если кнопка «ничего не делает» в production, сначала смотреть эти строки, а не FilePreview/MarkdownEditor. Общий принцип PATH — `methodology/дизайн-принципы.md::Production Electron на macOS наследует launchd PATH`.

## Архитектурное решение

**Файл:** `src/renderer/components/Workspace/FilePreview.tsx`

**До (2026-02-10):**
```tsx
{isMarkdown ? (
  <MarkdownPreview content={filePreview.content} />
) : (
  <div ref={contentRef} /> // highlight.js вручную через innerHTML
)}
```

**После:**
```tsx
<MarkdownEditor
  content={filePreview.content}
  onChange={() => {}} // noop
  readOnly
  fontSize={filePreviewFontSize}  // shared with SettingsModal stepper
  wordWrap
  showLineNumbers
  foldStateKey={`file-preview:${filePreview.path}`}
/>
```

**Выигрыш:**
- Единый рендерер для всех типов файлов (md, js, ts, json, txt, и т.д.)
- CodeMirror 6 даёт подсветку синтаксиса из коробки (не нужен highlight.js)
- Консистентный UX с остальным приложением (Notes Editor, InfoPanel тоже используют MarkdownEditor)
- Номера строк, word wrap, collapsible headers — всё работает автоматически

## Build Process

В package.json consumer указан `@gt-editor/markdown-editor`; рабочий build-flow
обновляет локальный GT dist явно. При правке исходников пакета нужны три шага:

```json
"build:markdown": "cd ../gt-editor/packages/markdown-editor && npm run build && rsync -a --delete dist/ ../../../custom-terminal/node_modules/@gt-editor/markdown-editor/dist/ && rm -rf ../../../custom-terminal/node_modules/.vite"
```

1. **Build** в gt-editor packages → обновляет `dist/index.cjs`.
2. **Rsync** в `node_modules/@gt-editor/markdown-editor/dist/` — копия consumer не обновляется от редактирования соседнего GT repo; исторический `file:`-install также оставлял независимую копию dist.
3. **`rm -rf node_modules/.vite`** — Vite prebundle cache не инвалидируется при изменении `dist/` локально-разрабатываемого пакета. Без удаления кеша Vite на следующем `dev` start читает старый prebundle, и правки не подхватываются.

После — обязателен перезапуск `npm run dev` (HMR **не** перебирает prebundle).

См. `fix-vite-prebundle-cache.md` про root cause и попытки решить иначе.

## Тяжёлое открытие и scroll длинного Markdown

08.10 причинная проверка snapshot файла `окно-вкладок-и-переключатель-фичи.md`
(6587строк,733176bytes,SHA256`cc433b7e…`) отделила общий редактор от host:
baseline/candidate×standalone/actual FilePreview, одинаковые текст/шрифт/геометрия.
В FilePreview first open2.41→0.18s, три wheel4.05→0.28s, B3.35→0.11s,
возвратA12.43→0.14s. Чтение тем же handler≈4ms; на wheel native ThreadTime3524→54ms,
layout≈7ms и paint≈1ms в обеих версиях. Это одиночный private offscreen прогон,
не воспроизведение всего production renderer с retained workspace/живыми AI.
Точный временной эпизод из речи пользователя с production-логом не сопоставлен.

Источник — package `markdownSyntax`: document-wide `.some` на каждом символе
multiline-прохода и полный повтор при viewportChanged. Новый индекс сохраняет
overlap/полуоткрытые границы; успешный результат переиспользуется при scroll.
Видимый DOM до/после совпал; полный текст, line numbers, wrapping, conceal и
виртуализация сохранены. Три wheel не создают новый EditorView и не запускают
syntax build. Диагностика медленного build — `[Perf:MarkdownSyntax]`.

Отдельно устранён package-remount при смене fontSize/padding: прежний scroller
уничтожался, а host с неизменным path продолжал слушать его. Reconfiguration
сохраняет view, читаемый абзац и дальнейшую запись scroll. Header/read/scroll
код Noted этим ремонтом не менялся. A→B→A/позиция0 новогоB, readOnly, fold,
Copy All и обновление позиции проверены с изолированными stores/clipboard.
Это само по себе не подтверждает durable SQLite после production restart.
Последующая parent-проверка full app подтвердила SQLite/cold restart в private
workspace (см.6a); обычная установленная версия остаётся отдельной границей.

Source of truth ремонта/регрессий — GT Editor
`docs/knowledge/fact-markdown-engine-intro.md`. `npm run build:markdown`
обновил package dist и локальную копию Noted; Electron28/React19 и
GT Electron34/React18 проверены отдельно. Installed app.asar остался прежним:
для installed acceptance после разрешённой установки повторить исходный файл,
два длинных файла, возврат к месту чтения и смену шрифта с последующим wheel.

## Связанные файлы

- `src/renderer/components/Workspace/FilePreview.tsx` — использует MarkdownEditor для просмотра файлов (readOnly).
- `src/renderer/components/Workspace/TabNotesSlideout.tsx` — slideout per-tab notes editor с AI Paste.
- `src/renderer/components/Workspace/panels/InfoPanel.tsx` — inline tab-notes editor.
- `src/renderer/components/Workspace/ProjectHome.tsx` — readOnly preview popovers с notes.
- `src/renderer/utils/generateAITitle.ts` — callback для AI Paste с Gemini fallback chain.
- `src/renderer/config/theme/markdown.ts` — цветовая схема gt-editor (используется везде).

## Что МОЖНО удалить в будущем

❌ **НЕЛЬЗЯ:** `react-markdown`, `remark-gfm`, `react-syntax-highlighter` — используются в Research
✅ **МОЖНО:** строку `.hljs { background: transparent !important; }` в `globals.css` (строка 168) — больше не нужна, но не мешает

## Миграция на публичный npm (TODO)

Если gt-editor будет опубликован в npm registry:
1. Заменить `"file:../gt-editor/..."` на `"@anthropic/markdown-editor": "^0.1.0"`
2. Удалить скрипт `build:editor` из package.json
3. Обновить CLAUDE.md (убрать упоминание локального пути)

До тех пор — **обязательно** держать папку `gt-editor` на уровень выше проекта.
