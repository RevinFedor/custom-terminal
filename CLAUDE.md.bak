# Noted Terminal

<instructions>
  <step index="1">
    CRITICAL: Before generating ANY solution, you MUST:
    1. Read `docs/main-feature.md` to understand the User Flow.
    2. Read `docs/architecture.md` to understand system constraints and Anti-Patterns.
  </step>
  <step index="2">
    IDENTIFY RELEVANCE:
    Based on the task, find the corresponding file in `docs/features/`.
    Read it and extract ONLY those `knowledge/` links that are relevant to the current problem.
    (e.g., if fixing terminal rendering → extract `knowledge/ui-terminal-rendering.md`, `knowledge/rendering-styles.md`).
    Read the selected knowledge files.
  </step>
  <step index="3">
    RED TEAM your own plan BEFORE writing code.
    List at least 3 constraints. For each — name the EXACT function/variable in the target code that will break.
    If you can't name a specific function — you haven't read deep enough, go back to step 2.

    BAD (generic, useless):
    "⚠️ terminal-core.md — use OSC 7 for CWD"
    "⚠️ ui-terminal-rendering.md — avoid flickering"

    GOOD (code-specific, actionable):
    "⚠️ terminal-core.md — CWD отслеживается через OSC 7 escape-последовательности от shell, а не через lsof/pgrep; shell-integration файлы инжектятся через ZDOTDIR при старте в ~/Library/Application Support/custom-terminal/shell-integration/"
    "⚠️ ui-terminal-rendering.md — Ink/TUI рендеринг (Claude CLI, Gemini CLI) вызывает jitter input bar; решение через конкретный механизм в xterm.js Canvas renderer"
  </step>
  <step index="4">
    ONLY after steps 1-3, propose a solution.
    Start your response with:
    1. "Я проверил файлы: [list]"
    2. "⚠️ Constraints:" followed by the list from step 3
    3. Then your implementation plan that respects EVERY listed constraint.
  </step>
</instructions>

## 1. Обзор Проекта
Noted Terminal — это кастомный эмулятор терминала на базе Electron, ориентированный на глубокую интеграцию с AI-агентами (Gemini CLI, Claude Code) и бесшовное управление проектами.

## 2. Технический Стек
- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer) — см. `docs/knowledge/ui-terminal-rendering.md`
- **Styling:** Tailwind CSS v4 — см. `docs/knowledge/rendering-styles.md`
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DB:** SQLite (Sessions & Projects)

## 3. Карта Документации
- **Главная (Flows):** `docs/main-feature.md`
- **Код (Архитектура):** `docs/architecture.md`
- **Инфраструктура (Ops):** `docs/infrastructure/`
- **База Знаний:** `docs/knowledge/`
- **Тестирование (Automation):** `auto/` — Playwright-тесты для Electron. Entry point: `auto/context.md`. Запуск: `node auto/stable/test-name.js`
