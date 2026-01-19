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
- **Frontend:** React 19 + Vite + TypeScript
- **State Management:** Zustand
- **Terminal:** xterm.js (WebGL rendering)
- **Styling:** Tailwind CSS v4 (JIT, @layer components)
- **Backend:** Node.js + node-pty
- **Storage:** JSON files (~/Library/Application Support)
- **AI Integration:** Gemini API 3-flash-preview (Direct fetch)
- **Syntax Highlighting:** Highlight.js (VS2015 theme)

## Навигация (Project Mapping)

### Backend (Main Process)
- `main.js` — Главный процесс Electron, управление PTY и IPC.
- `project-manager.js` — Менеджер проектов, сохранение в JSON.
- `session-manager.js` — Управление сессиями AI (Gemini/Claude).
- `database.js` — SQLite для сессий и проектов.

### Frontend (Renderer Process - React)
- `src/renderer/App.tsx` — Корневой компонент, роутинг.
- `src/renderer/store/` — Zustand stores (useProjectsStore, useWorkspaceStore).
- `src/renderer/components/Dashboard/` — Dashboard UI (проекты, настройки).
- `src/renderer/components/Workspace/` — Workspace UI (табы, терминалы).
- `src/renderer/components/Workspace/Terminal.tsx` — xterm.js wrapper.

### Build & Config
- `electron.vite.config.js` — Vite config для Electron.
- `index.html` — HTML entry point.
- `input.css` — Tailwind входной файл.
- `output.css` — Скомпилированный Tailwind.

### Docs
- `docs/` — База знаний (Gold Standard v3.4).
- `MIGRATION-COMPLETE.md` — Документация по миграции на React.

## Правила Кодирования
- **Язык:** TypeScript + React 19 (frontend), CommonJS (backend).
- **Стили:** Tailwind CSS v4, кастомные стили через `input.css` (@layer).
- **Именование:** PascalCase для компонентов, camelCase для функций/переменных.
- **State:** Zustand stores (`useProjectsStore`, `useWorkspaceStore`).
- **Модули:** ESM в React, CommonJS в main process.

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