# Context: Noted Terminal

> **ИНСТРУКЦИЯ (System Prompt):**
> 1. В начале сессии ОБЯЗАТЕЛЬНО прочитай три базовых файла:
>    - `context.md` — точка входа (этот файл)
>    - `architecture.md` — технический фундамент
>    - `main-feature.md` — пользовательские сценарии
> 2. **ПЕРЕД ИЗМЕНЕНИЕМ КОДА** — найди нужную фичу в `main-feature.md`, перейди в `features/` и прочитай связанные `knowledge/`.
> 3. Если есть ссылка на `knowledge/` — ЧИТАЙ ОБЯЗАТЕЛЬНО (там причины критических решений).
> 4. Игнорируй папки с пометкой ⚪ (tmp, journal) без команды.

## 1. Обзор Проекта
Noted Terminal — это кастомный эмулятор терминала на базе Electron, ориентированный на глубокую интеграцию с AI-агентами (Gemini CLI, Claude Code) и бесшовное управление проектами.

## 2. Технический Стек
- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer) — см. `knowledge/fix-ui-stability.md`
- **Styling:** Tailwind CSS v4 — см. `knowledge/fix-tailwind-v4-source.md`
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DB:** SQLite (Sessions & Projects)

## 3. Карта Документации
- **Главная (Flows):** `main-feature.md`
- **Код (Архитектура):** `architecture.md`
- **Инфраструктура (Ops):** `infrastructure/`
- **База Знаний:** `knowledge/`
