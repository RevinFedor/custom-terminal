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

## 4. Отладка (Debug)
Скрипты отладки находятся в корне проекта:
- `debug-60s.js` — мониторинг производительности (рекомендуется).
- `debug-claude-cli.js` — отладка интеграции с Claude Code.
