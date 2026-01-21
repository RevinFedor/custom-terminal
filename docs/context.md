# Context: Noted Terminal

> **ИНСТРУКЦИЯ (System Prompt):**
> 1. В начале сессии читай этот файл.
> 2. Затем прочитай `features/_main.md` — карта всех фич проекта.
> 3. **ПЕРЕД ИЗМЕНЕНИЕМ КОДА** — обязательно прочитай `architecture.md` и связанные `knowledge/` файлы.
> 4. Если в описании есть ссылка на `knowledge/` — ЧИТАЙ ЕЁ ОБЯЗАТЕЛЬНО (там критический контекст и причины решений).
> 5. Игнорируй папки с пометкой ⚪ (tmp, journal) без команды.

## 1. Обзор Проекта
Noted Terminal — это кастомный эмулятор терминала на базе Electron, ориентированный на работу с проектами и интеграцию AI-агентов (Gemini CLI, Claude Code).

## 2. Технический Стек
- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer) — см. `knowledge/fix-ui-stability.md` (почему НЕ WebGL)
- **Styling:** Tailwind CSS v4
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DND:** Pragmatic Drag-and-Drop (Atlassian)
- **DB:** SQLite (Sessions & Projects)

## 3. Карта Документации
- **Фичи (Логика):** `features/main.md`
- **Код (Архитектура):** `architecture.md`
- **Инфраструктура (Ops):** `infrastructure/ops-guide.md`
- **База Знаний (Facts & Fixes):** `knowledge/`
- **История:** `dev-journal/` (⚪)
