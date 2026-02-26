# Ops Guide: Infrastructure

## 1. Разработка (Dev)
- `npm run dev` — запуск приложения с hot-reload.
- `npm run dev:css` — watch-режим для Tailwind.
- `npm run rebuild` — пересборка `node-pty` (выполнять при ошибках модуля).

## 2. Сборка (Build)
- `npm run build` — сборка через electron-builder.
- `npm run dist` — упаковка в `.dmg` или `.app` для macOS.

## 3. Пути данных
- **DB:** `~/Library/Application Support/noted-terminal/noted-terminal.db`
- **Config:** `~/Library/Application Support/noted-terminal/projects.json`
- **AI History:** `~/.minayu/history/` — снепшоты Gemini Time Machine.
- **Claude Bridge:** `~/.claude/bridge/` — временные JSON-файлы для идентификации активных сессий Клода.

## 4. Отладка (Debug)
Скрипты отладки находятся в корне проекта:
- `debug-60s.js` — мониторинг производительности.
- `debug-claude-cli.js` — отладка интеграции с Claude Code.

**Категории логов (localStorage.debug):**
- `app:gemini` — детальная отладка Sniper Watcher, True Fork и Time Machine.
- `app:claude` — сессии Клода.
- `app:tabs` — управление вкладками.

## 5. Тестирование
В проекте используется двухуровневая система тестирования.

### 1. Unit-тесты TUI (Headless)
Для тестирования логики парсинга, OSC-маркеров и алгоритмов поиска в буфере используются изолированные Node.js скрипты на базе `@xterm/headless`.
- **Преимущество:** 100% стабильность, не зависят от состояния БД и графического окружения macOS.
- **Пример:** `node auto/sandbox/test-osc-boundary-markers.js`.

### 2. Интеграционные тесты (Playwright)
Используются для проверки сквозных сценариев (UI + Main process).
- **Файлы:** `auto/stable/` и `auto/sandbox/`.
- **Запуск:**
```bash
# Запуск конкретного теста
./auto/run.sh sandbox/test-timeline.js
```

**Важно:** Если тест проверяет низкоуровневый поток данных PTY (маркеры, навигация), приоритет отдается Headless Unit-тестам. Playwright используется только для верификации визуальных состояний React и IPC-взаимодействия.

### Отладка
Тесты автоматически выводят логи из Renderer и Main процессов в консоль терминала с префиксами `[Renderer]` и `[Main]`.
