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

См. также: `docs/knowledge/ui-input-events.md` (раздел про Clipboard).

### 5. FoldStateKey — персистентное состояние фолдинга

```ts
foldStateKey={`file-preview:${filePreview.path}`}
```

Это ключ для сохранения состояния свёрнутых секций в `localStorage`.
- Если пользователь свернул заголовок H2 в файле `README.md` → при повторном открытии этот же заголовок останется свёрнутым
- Если поменять/убрать `foldStateKey` → состояние сбросится

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
  fontSize={13}
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

При сборке Noted Terminal автоматически билдится gt-editor:

```json
"build:editor": "cd ../gt-editor/packages/markdown-editor && npm run build"
```

Это происходит **перед** основной сборкой (см. package.json scripts).

## Связанные файлы

- `src/renderer/components/Workspace/FilePreview.tsx` — использует MarkdownEditor для просмотра файлов
- `src/renderer/components/Workspace/NotesEditorModal.tsx` — использует MarkdownEditor для редактирования заметок
- `src/renderer/components/Workspace/panels/InfoPanel.tsx` — использует MarkdownEditor для inline-заметок
- `src/renderer/config/theme/markdown.ts` — цветовая схема gt-editor (используется везде)

## Что МОЖНО удалить в будущем

❌ **НЕЛЬЗЯ:** `react-markdown`, `remark-gfm`, `react-syntax-highlighter` — используются в Research
✅ **МОЖНО:** строку `.hljs { background: transparent !important; }` в `globals.css` (строка 168) — больше не нужна, но не мешает

## Миграция на публичный npm (TODO)

Если gt-editor будет опубликован в npm registry:
1. Заменить `"file:../gt-editor/..."` на `"@anthropic/markdown-editor": "^0.1.0"`
2. Удалить скрипт `build:editor` из package.json
3. Обновить CLAUDE.md (убрать упоминание локального пути)

До тех пор — **обязательно** держать папку `gt-editor` на уровень выше проекта.
