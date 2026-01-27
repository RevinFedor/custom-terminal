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

## 4. Отладка (Debug)
Скрипты отладки находятся в корне проекта:
- `debug-60s.js` — мониторинг производительности.
- `debug-claude-cli.js` — отладка интеграции с Claude Code.

**Категории логов (localStorage.debug):**
- `app:gemini` — детальная отладка Sniper Watcher, True Fork и Time Machine.
- `app:claude` — сессии Клода.
- `app:tabs` — управление вкладками.
