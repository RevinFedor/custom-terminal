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
В проекте используется Playwright для автоматизированного тестирования Electron-приложения.

### Запуск тестов
Для запуска тестов используйте скрипт `auto/run.sh`:
```bash
# Запуск конкретного теста
./auto/run.sh sandbox/test-timeline.js

# Запуск всех тестов в папке
./auto/run.sh sandbox/
```

### Структура тестов
- `auto/core/`: Ядро тестового фреймворка (лаунчер, перехват логов).
- `auto/sandbox/`: Пользовательские сценарии (Timeline, Hover, Fork Markers).

### Отладка
Тесты автоматически выводят логи из Renderer и Main процессов в консоль терминала с префиксами `[Renderer]` и `[Main]`.
