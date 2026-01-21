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
- `src/main/main.js` — Главный процесс Electron, управление PTY и IPC. Содержит `terminal:executeCommandAsync` с защитой от Paste-режима.
- `src/main/project-manager.js` — Менеджер проектов, сохранение в JSON.
- `src/main/session-manager.js` — Логика Export/Import сессий (Trojan Horse метод).
- `src/main/database.js` — SQLite для сессий (ai_sessions) и проектов.

### Frontend (Renderer Process - React)
- `src/renderer/App.tsx` — Корневой компонент.
- `src/renderer/components/Workspace/panels/SessionsPanel.tsx` — UI и логика автоматизации импорта/экспорта. Использует `waitForSilence` и `waitForHideCursor`.

## Правила Автоматизации CLI (Gemini)
1. **Не доверяй промпту `>`**: Он появляется до того, как CLI готов принимать команды.
2. **Детекция готовности (Основной метод)**: Используй ожидание ANSI-кода `HIDE CURSOR` (`\x1b[?25l`). Это самый быстрый и точный сигнал готовности Gemini CLI.
3. **Детекция готовности (Запасной метод)**: "Окно тишины" (Silence Detection) в 1500мс. Используется, если ANSI-коды не сработали.
4. **Нажатие Enter**: Всегда разделяй ввод текста и `\r` задержкой в 150мс, чтобы обойти защиту от Paste в Raw Mode.

## Стек (Tech Stack)