# Context: Noted Terminal

<instructions>
  <step index="1">
    CRITICAL: Before generating ANY solution, you MUST issue read_file commands for:
    - docs/architecture.md
    - docs/main-feature.md
  </step>
  <step index="2">
    Analyze the user request against `main-feature.md`.
    Find ALL relevant feature files (may be multiple — read each).
    For each feature file — follow links to `knowledge/` and READ them.
  </step>
  <step index="3">
    ONLY after steps 1-2, propose a solution.
    Start your response with: "Я проверил файлы: [list of files you read]"
    If you skip this — your answer is considered a hallucination.
  </step>
</instructions>

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
