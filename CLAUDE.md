# Noted Terminal

## Обзор
Noted Terminal — кастомный эмулятор терминала на базе Electron с глубокой интеграцией AI-агентов (Gemini CLI, Claude Code) и управлением проектами.

## Технический Стек
- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer)
- **Styling:** Tailwind CSS v4
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DB:** SQLite (Sessions & Projects)

## Data Layer
- **Persistence:** Основное состояние (проекты, вкладки, сессии) хранится в **SQLite**.
- **Consolidated Schema:** См. [`knowledge/fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md).
- **Settings:** Настройки UI и копирования сохраняются в `localStorage`:
    - `noted-terminal-copy-settings` — настройки фильтрации при экспорте (includeEditing, includeReading, fromStart).
- **Gemini Data:** 
    - `~/.gemini/projects.json` — маппинг путей к slug-ам (v0.30+).
    - `~/.gemini/tmp/` — временные файлы чатов (slug или SHA256).

## Документация
Вся документация в `docs/knowledge/` — единая плоская структура:
- **`fix-*`** — шрамы: баги, фиксы, обходные решения
- **`fact-*`** — факты: как работают подсистемы, платформенные ограничения, поведение фич

Нет иерархии. Семантический роутер (`???` в конце промпта) автоматически выбирает нужные файлы.

## Anti-Patterns (обязательно к соблюдению)
- **Async onData race:** Никогда не делай `await` внутри обработчика PTY `onData` без предварительной **синхронной блокировки** (cooldown/флаг). Высокочастотный вывод терминала породит десятки дублирующих асинхронных вызовов.
- **Не используй `execSync`** в main process — фризит весь UI
- **Не используй polling** для статуса процессов — используй OSC 133
- **Экранируй `$`** в bash-командах в main.js — Vite трансформирует их при сборке
- **Не используй `navigator.clipboard`** в renderer — используй `window.require('electron').clipboard`
- **TUI Logic Testing:** Для низкоуровневой логики парсинга терминала (маркеры, поиск в буфере) предпочитай **Headless Unit-тесты** (node + @xterm/headless). Playwright-тесты используй только для UI и IPC сценариев.

## Тестирование
- **Playwright-тесты:** `auto/` — entry point: `auto/context.md`, запуск: `node auto/stable/test-name.js`
