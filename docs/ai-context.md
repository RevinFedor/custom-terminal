# AI Context & Gatekeeper

> **ИНСТРУКЦИЯ ДЛЯ AI:**
> 1. **Читай:** `docs/ai-context.md`, `docs/architecture.md`, `docs/dev-guide.md`, `docs/user-guide.md` и папку `docs/troubleshooting/`.
> 2. **ИГНОРИРУЙ АРХИВЫ:** `docs/dev-journal/`, `node_modules/`, `build-resources/`.
> 3. Ищи ответы на "Почему?" в `docs/philosophy.md`, а на "Как?" в `docs/architecture.md`.
> 4. **Никогда не ломай билд:** После правок проверяй `npm start`.

## Стек (Tech Stack)
- **Runtime:** Electron 28
- **Terminal:** Vanilla JS + xterm.js (WebGL)
- **Styling:** Tailwind CSS v4 (JIT)
- **Backend:** Node.js + node-pty
- **AI Integration:** Gemini API (Direct)
- **Syntax Highlighting:** Highlight.js (VS2015 theme)

## Навигация (Project Mapping)
- `main.js` — Основной процесс, управление PTY и IPC.
- `renderer.js` — Рендеринг терминала, UI и интеграция с Gemini.
- `project-manager.js` — Логика сохранения проектов и заметок.
- `docs/` — База знаний (The Gold Standard v3.4).

## Правила
- Код: Vanilla JS, никакой транспиляции.
- Стиль: Tailwind CSS v4 (input.css → output.css), Dark Mode.
- Файлы: Только kebab-case.
- CSS: Tailwind классы в HTML, кастомные стили в input.css (@layer)