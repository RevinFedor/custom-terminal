# Fix: Vite Prebundle Cache Trap для file:-dep пакетов

## Симптомы
- Правки в `gt-editor/packages/markdown-editor/src/` не проявляются в custom-terminal после перезапуска `npm run dev`.
- `grep` по `node_modules/@gt-editor/markdown-editor/dist/index.cjs` показывает свежий код, но в runtime поведение старое.
- Лог пишет старые `[Tag]` сообщения, новые `console.warn` не появляются.
- Пересборка gt-editor через `npm run build` отрабатывает, `dist/index.cjs` timestamp обновлён, но эффекта в custom-terminal нет.

## Корневая причина
Vite кеширует **prebundled** копии npm-зависимостей в `node_modules/.vite/deps/`. Файлы вида:
```
node_modules/.vite/deps/@gt-editor_markdown-editor.js
node_modules/.vite/deps/_metadata.json
```
Это снимок пакета **в момент первого** `npm run dev`. При последующих стартах Vite сверяет hash зависимостей из `package.json`/`package-lock.json`. Если hash не изменился — берёт prebundled копию **без чтения** свежего `dist/index.cjs`.

Custom-terminal зависит от `@gt-editor/markdown-editor` через npm `file:`-зависимость (через локальный alias `@anthropic/markdown-editor`). При локальной правке исходников пакета:
- `package.json` версия пакета не меняется → hash в `_metadata.json` не меняется → Vite не инвалидирует prebundle.
- Сам файл `dist/index.cjs` обновляется, но Vite его игнорирует.

Эффект: 4-5 итераций «пересобрал → не работает → пересобрал ещё раз» — потому что фикс физически не загружался.

## Решение
Текущий переносимый checkout собирает `vendor/markdown-editor` как npm workspace;
соседний GT source автоматически в него не переносится. Актуальный flow и npm-link
описаны в `fact-file-preview-markdown.md::Build Process`. Для dev при сохранённом
старом prebundle отдельно очищается `node_modules/.vite` и перезапускается dev.

Историческая pipeline-команда до перехода на vendored workspace:

```json
"build:markdown": "cd ../gt-editor/packages/markdown-editor && npm run build && rsync -a --delete dist/ ../../../custom-terminal/node_modules/@gt-editor/markdown-editor/dist/ && rm -rf ../../../custom-terminal/node_modules/.vite && echo '[build:markdown] gt-editor → custom-terminal node_modules synced, vite cache cleared'"
```

Три шага в одной команде:
1. **Build** в gt-editor packages — обновляет `dist/index.cjs`.
2. **Rsync `dist/`** в `custom-terminal/node_modules/@gt-editor/markdown-editor/dist/` — потому что npm `file:`-install скопировал dist при `npm install`, дальше копии живут независимо.
3. **`rm -rf node_modules/.vite`** — заставляет Vite на следующем `dev` start заново prebundle'ить пакет, читая свежий dist.

Дальше — перезапуск `npm run dev` обязателен. Hot reload **не** перебирает prebundle, эта инвалидация только на старте.

## Что пробовали и почему не сработало (graveyard)
- **Только `npm run build` в gt-editor.** Custom-terminal не видел изменений потому что его `node_modules` — отдельная копия, не симлинк.
- **`npm run build` + rsync без удаления `.vite`.** `node_modules` обновился, но Vite читал свой prebundle cache.
- **`npm install` в custom-terminal после rsync.** Слишком медленно (60+ сек) и не очищает `.vite`. `rm -rf .vite` решает проблему за 200ms.

## Принцип переносимый
Любой проект, который зависит от локально разрабатываемого пакета через npm `file:` и использует Vite — будет упираться в этот трап. Минимальный fix-pipeline всегда из трёх шагов: build → propagate to node_modules → invalidate Vite cache.

Принцип «build-time tooling должен иметь явный pipeline-script, а не цепочку shell-команд» — см. `fact-file-preview-markdown.md` Build Process.

## Связанные файлы
- `package.json` custom-terminal — `scripts.build:markdown`.
- `fact-file-preview-markdown.md` — Build Process секция.
- `fix-codemirror-controlled-editor.md` — конкретный сценарий, когда этот трап маскировал реальный фикс.
