# AI Context & Gatekeeper

> **ИНСТРУКЦИЯ ДЛЯ AI (The Gold Standard v3.4):**
> 1. **ЧИТАЙ (Core):** `docs/ai-context.md`, `docs/architecture.md`, `docs/dev-guide.md`, `docs/user-guide.md` и папку `docs/troubleshooting/`.
> 2. **ЧИТАЙ (Optional):** `docs/philosophy.md` — если нужно понять "Почему так решили".
> 3. **ИГНОРИРУЙ АРХИВЫ:** `docs/dev-journal/`, `node_modules/`, `build-resources/`, `assets/`.
> 4. **ИГНОРИРУЙ tmp-файлы:** Файлы с префиксом `tmp-` в корне `docs/` — это временные заметки, не критичны.
> 5. **Разделение:** "Почему?" → `philosophy.md`, "Как?" → `architecture.md`, "Что сломалось?" → `troubleshooting/`.
> 6. **Никогда не ломай билд:** После правок проверяй `npm start`.

## Стек (Tech Stack)
- **Runtime:** Electron 28
- **Terminal:** Vanilla JS + xterm.js (WebGL)
- **Styling:** Tailwind CSS v4 (JIT, @layer components)
- **Backend:** Node.js + node-pty
- **Storage:** JSON files (~/Library/Application Support)
- **AI Integration:** Gemini API 3-flash-preview (Direct fetch)
- **Syntax Highlighting:** Highlight.js (VS2015 theme)

## Навигация (Project Mapping)
- `main.js` — Главный процесс Electron, управление PTY и IPC.
- `renderer.js` — Рендерер, UI, терминал, Gemini интеграция.
- `project-manager.js` — Менеджер проектов, сохранение в JSON.
- `index.html` — HTML структура (Dashboard, Workspace, Modals).
- `input.css` — Tailwind входной файл с кастомными стилями (@layer).
- `output.css` — Скомпилированный Tailwind (генерируется автоматически).
- `docs/` — База знаний (Gold Standard v3.4).

## Правила Кодирования
- **Язык:** Vanilla JS, ES6+, без транспиляции.
- **Стили:** Tailwind CSS v4, кастомные стили только через `input.css` (@layer base/components/utilities).
- **Именование:** kebab-case для всех файлов и папок.
- **CSS:** Tailwind классы в HTML, никаких inline стилей кроме динамических.
- **Модули:** CommonJS (require/module.exports), не ESM.

## Структура Данных
- **Проекты:** `~/Library/Application Support/custom-terminal/projects.json`
- **Schema:** Ключ = абсолютный путь к проекту
- **Поля проекта:** id, path, name, description, geminiPrompt, notes, quickActions, tabs

## Ключевые Концепции
- **Project-Based Design:** Каждый проект = отдельный workspace с табами.
- **Level 1 Tabs:** Project chips в title bar (проекты).
- **Level 2 Tabs:** Terminal tabs внутри проекта.
- **Context-Aware Hotkeys:** Cmd+T/W работают по-разному в workspace и на dashboard.
- **Gemini Integration:** Выделение текста → контекстное меню → AI search с кастомным промптом.