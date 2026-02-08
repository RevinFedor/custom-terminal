# Noted Terminal

<instructions>
  <step index="1">
    CRITICAL: Before generating ANY solution, you MUST issue read_file commands for:
    - docs/architecture.md
    - docs/main-feature.md
  </step>
  <step index="2">
    After reading `architecture.md`, scan it for EVERY reference to `knowledge/` files.
    Issue read_file for EACH one. Do NOT skip any — even if they seem irrelevant to the question.

    Then: find the relevant feature file(s) for the user's request from `main-feature.md`.
    Read each feature file. For each — extract ALL `knowledge/` paths and read them too.
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
- **Terminal:** xterm.js (Canvas renderer) — см. `docs/knowledge/fix-ui-stability.md`
- **Styling:** Tailwind CSS v4 — см. `docs/knowledge/fix-tailwind-v4-source.md`
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DB:** SQLite (Sessions & Projects)

## 3. Карта Документации
- **Главная (Flows):** `docs/main-feature.md`
- **Код (Архитектура):** `docs/architecture.md`
- **Инфраструктура (Ops):** `docs/infrastructure/`
- **База Знаний:** `docs/knowledge/`
- **Тестирование (Automation):** `auto/` — Playwright-тесты для Electron. Запуск: `./auto/run.sh sandbox/test-name.js`
