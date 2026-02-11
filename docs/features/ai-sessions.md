# Feature: AI Sessions Overview

## Intro
Noted Terminal обеспечивает глубокую интеграцию с внешними AI-агентами (Claude Code и Gemini CLI), превращая их из разрозненных терминальных процессов в управляемые сессии с поддержкой персистентности, ветвления и истории.

## Сравнение систем

| Аспект | Claude | Gemini |
| :--- | :--- | :--- |
| **Механизм Fork** | Resume UUID (через `PendingAction`) | **True Fork** (Клонирование JSON) |
| **Time Machine** | Нет (в планах) | **Есть** (Snapshots turns) |
| **Захват ID** | Мгновенно (при старте) | После 1-го сообщения (Sniper) |
| **Хранение** | `~/.claude/projects/` | `~/.gemini/tmp/<hash>/` |
| **История Minayu** | Нет | `~/.minayu/history/<id>/` |

## Детальные описания
- **Claude Sessions:** [`claude-sessions.md`](claude-sessions.md) — Sniper Watcher и управление UUID.
- **Gemini Sessions:** [`gemini-sessions.md`](gemini-sessions.md) — True Fork и особенности Gemini 0.25+.
- **Time Machine:** [`time-machine.md`](time-machine.md) — Система откатов для Gemini.

## Общие механизмы
- **Sniper Watcher:** Фоновое наблюдение за файловой системой для захвата идентификаторов сессий.
- **Interrupted Sessions:** Детекция некорректного завершения и предложение восстановления через Overlay. Покажется только если `currentView === 'terminal'`, чтобы не мешать на вкладке Home.
- **Process Monitor (Dashboard):** Глобальный экран мониторинга всех запущенных в системе AI-агентов. Разделен на две колонки (Claude и Gemini).
    - **Ownership:** Приложение автоматически определяет, какие процессы запущены внутри него (In-App), а какие во внешних терминалах (External) через PPID mapping.
    - **Batch Kill:** Возможность остановки любого процесса прямо из Dashboard.
- **PendingAction Pattern:** Очередь команд, выполняемых сразу после готовности Shell в новом табе. См. `architecture.md`.