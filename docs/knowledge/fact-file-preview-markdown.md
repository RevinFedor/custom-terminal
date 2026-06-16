# File Preview: Unified Markdown Reader

## Контекст (WHY)

**Проблема:** До февраля 2026 в FilePreview использовалась разношёрстная связка:
- `react-markdown` + `remark-gfm` для `.md` файлов (read-only viewer)
- `highlight.js` для подсветки кода в других файлах
- Разные стили, разный UX, нет единообразия

**Решение:** Всё заменено на `@anthropic/markdown-editor` в режиме `readOnly`.

## Критическая информация (что нельзя вывести из кода)

### 1. Источник пакета `@anthropic/markdown-editor`

```json
"@anthropic/markdown-editor": "file:../gt-editor/packages/markdown-editor"
```

**ВАЖНО:** Это **НЕ** публичный npm-пакет. Это локальный проект на рабочем столе:
- Путь: `/Users/fedor/Desktop/gt-editor/packages/markdown-editor/`
- Перед сборкой Noted Terminal нужно собрать gt-editor: `npm run build:editor` (см. package.json)
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

### 5. Shared font-size (header stepper ↔ Settings)

`fontSize` берётся из `useUIStore.filePreviewFontSize`, который имеет два независимых UI-контрола:
1. Inline stepper `[−] 13px [+]` в header'е FilePreview (рядом с Copy All / ×).
2. Контрол «Превью файла» в Settings → Шрифты.

Оба меняют **одно поле** в UIStore + один ключ `localStorage('noted-terminal-file-preview-font-size')`. Изменение в любом месте мгновенно отражается во втором — реактивно через Zustand-селектор.

**Почему shared, а не два разных поля:** при двух полях получили бы рассинхрон между разными окнами/табами или между inline-stepper'ом и модалкой. Inline-stepper нужен для быстрого «ткнул и читаешь дальше», модалка — для редкой централизованной настройки; обе семантики управляют одним и тем же визуалом, поэтому одно поле.

**Диапазон 10..24px** — задан и в `setFilePreviewFontSize` (clamp при записи), и в кнопках UI (`disabled` на границах). Одно место границ было бы лучше, но clamp в setter защищает от неконсистентного состояния если кто-то запишет в localStorage ручную нужное значение.

### 6. FoldStateKey — персистентное состояние фолдинга

```ts
foldStateKey={`file-preview:${filePreview.path}`}
```

Это ключ для сохранения состояния свёрнутых секций в `localStorage`.
- Если пользователь свернул заголовок H2 в файле `README.md` → при повторном открытии этот же заголовок останется свёрнутым
- Если поменять/убрать `foldStateKey` → состояние сбросится

### 7. Open in Sublime Text

FilePreview остаётся read-only поверх `MarkdownEditor`; кнопка `Sublime` в header'е — явный выход из режима чтения в полноценный внешний редактор. Это не должно идти через renderer `exec` или `shell.openPath`: production `.app` на macOS наследует launchd PATH без Homebrew/user-local bin, поэтому main-side handler сам расширяет PATH (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local/bin`), валидирует что путь абсолютный и указывает на файл, затем пробует `SUBLIME_TEXT_CLI`, app-bundle `subl`, `subl` из PATH и только потом `open -a "Sublime Text"`.

Fallback на LaunchServices нужен потому что у пользователя Sublime может быть установлен как `.app`, но `subl` не добавлен в shell PATH. Обратная ситуация тоже частая: CLI есть через Homebrew, а app path отличается. Логи `[FileOps:Sublime]` намеренно пишут и failed candidates, и successful method — если кнопка «ничего не делает» в production, сначала смотреть эти строки, а не FilePreview/MarkdownEditor. Общий принцип PATH — `methodology/переносимый-дизайн.md::Production Electron на macOS наследует launchd PATH`.

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

Custom-terminal зависит от `@gt-editor/markdown-editor` через npm `file:`-зависимость (локальный alias `@anthropic/markdown-editor`). При правке исходников пакета **трёх шагов** нужно сделать:

```json
"build:markdown": "cd ../gt-editor/packages/markdown-editor && npm run build && rsync -a --delete dist/ ../../../custom-terminal/node_modules/@gt-editor/markdown-editor/dist/ && rm -rf ../../../custom-terminal/node_modules/.vite"
```

1. **Build** в gt-editor packages → обновляет `dist/index.cjs`.
2. **Rsync** в `node_modules/@gt-editor/markdown-editor/dist/` — потому что npm `file:`-install скопировал dist при первом install, дальше копии живут независимо.
3. **`rm -rf node_modules/.vite`** — Vite prebundle cache не инвалидируется при изменении `dist/` локально-разрабатываемого пакета. Без удаления кеша Vite на следующем `dev` start читает старый prebundle, и правки не подхватываются.

После — обязателен перезапуск `npm run dev` (HMR **не** перебирает prebundle).

См. `fix-vite-prebundle-cache.md` про root cause и попытки решить иначе.

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
