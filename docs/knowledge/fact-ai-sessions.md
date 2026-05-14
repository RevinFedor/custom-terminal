# Feature: AI Sessions Overview

## Intro
Noted Terminal обеспечивает глубокую интеграцию с внешними AI-агентами (Claude Code и Gemini CLI), превращая их из разрозненных терминальных процессов в управляемые сессии с поддержкой персистентности, ветвления и истории.

## Сравнение систем

| Аспект | Claude | Gemini |
| :--- | :--- | :--- |
| **Механизм Fork** | Resume UUID (через `PendingAction`) | **True Fork** (Клонирование JSON) |
| **Time Machine** | Нет (в планах) | **Есть** (Snapshots turns) |
| **Захват ID** | Мгновенно (через `mcp:claude-cli-active` для субагентов или Sniper для обычных) | После 1-го сообщения (Sniper) |
| **Хранение** | `~/.claude/projects/` | `~/.gemini/tmp/<hash>/` |
| **История Minayu** | Нет | `~/.minayu/history/<id>/` |

## Детальные описания
- **Claude Sessions:** [`claude-sessions.md`](claude-sessions.md) — Sniper Watcher и управление UUID.
- **Gemini Sessions:** [`gemini-sessions.md`](gemini-sessions.md) — True Fork и особенности Gemini 0.25+.
- **Time Machine:** [`time-machine.md`](time-machine.md) — Система откатов для Gemini.

## InfoPanel: AI Session block (компактный layout)
Блок в `InfoPanel.tsx` — единственная строка:
`[⎘ copy] [SessionActionChip] [↻ refresh]  …  [⑂→▭ Fork-tab] [⑂→SDK]`.
Снизу к этой строке примыкает компактный chip Copy session (см. [`fact-clipboard-tools.md::Copy Session: размещение и UX`](fact-clipboard-tools.md)).

- **`SessionActionChip`** — fixed-width 64px кнопка с tri-state поведением:
    - idle: `Claude` / `Gemini` (accent-цвет, прозрачный фон) — клик копирует sessionId (дублирует ⎘).
    - hover + сессия есть + процесс **не** запущен: `Continue` — клик шлёт `claude:run-command`/`gemini:run-command` с `--resume`.
    - hover + процесс **запущен** (`isCommandRunning`): `Stop` (красный `#ef4444`) — клик шлёт `\x03` (Ctrl+C) через `terminal:input`.
    Fixed-width 64px необходим, иначе layout прыгает при смене лейбла (Claude → Continue → Stop разной ширины) и кнопки правее сдвигаются. Stop **намеренно** через Ctrl+C, не `terminal:kill` — kill убивает PTY вместе с табом, юзеру нужно прервать процесс **внутри** живого таба. См. также методологический принцип tri-state в [`methodology/design-bugs.md::Tri-state кнопка действия`](../methodology/design-bugs.md).
- **Тултип на SessionActionChip** — sessionId появляется мгновенно (CSS `group-hover`), всплывает сверху вплотную к чипу.
- **↻ Refresh timeline** — слева от Fork-кнопок, прижата к chip'у. Размер 16x16, шрифт 12px (выровнено с ⎘ через `inline-flex items-center justify-center`).
- **Fork → tab** (`⑂→[icon]`) и **Fork → SDK** (`⑂→SDK`) — справа, ширина ~30–50px каждая. ПКМ по `⑂→tab` конвертирует текущий таб в SDK.
- **Кнопка ✎ Replace session ID удалена из UI** — функционал нестабилен (плохо состыковывает Zustand-store `claudeSessionId` ↔ JSONL ↔ Sniper-bridge: при «вручную» вписанном ID Timeline не подхватывает реальный файл сессии). Код `sessionInputMode`/`renderSessionInput` сохранён в `InfoPanel.tsx` под фичу, но триггер скрыт. Перед возвращением — пересмотреть `setupClaudeChainResolver` и invariants Sniper-watcher'а.
- ID полной строкой под заголовком больше **не показывается** — экономия высоты. Доступен через тултип на заголовке или клик по ⎘ / клик по самому chip'у.

## Общие механизмы
- **Sniper Watcher:** Фоновое наблюдение за файловой системой для захвата идентификаторов сессий.
- **Interrupted Sessions:** Детекция некорректного завершения и предложение восстановления через Overlay. Покажется только если `currentView === 'terminal'`, чтобы не мешать на вкладке Home. State management — исключительно в main process (`will-quit`). Renderer НЕ трогает `wasInterrupted`. Подробности о гонке lifecycle и выборе сигнала (`bridgeKnownSessions` vs `claudeCliActive`) — см. [`fix-interrupted-session-lifecycle.md`](fix-interrupted-session-lifecycle.md).
- **Process Monitor (Dashboard):** Глобальный экран мониторинга всех запущенных в системе AI-агентов. Разделен на две колонки (Claude и Gemini).
    - **Ownership:** Приложение автоматически определяет, какие процессы запущены внутри него (In-App), а какие во внешних терминалах (External) через PPID mapping.
    - **Batch Kill:** Возможность остановки любого процесса прямо из Dashboard.
    - **In-App Kill идёт через `terminal:kill` IPC**, не через сырой `kill PID`. Сырой kill оставлял бы наши Maps (`terminals`, `terminalOutputBuffer`, `terminalCommandState`) с фантомными записями — UI продолжал бы показывать живой таб для убитого процесса. Через `terminal:kill` запускается полный onExit cleanup. Подтверждение через `confirm()` потому что юзер легко промахивается по крестику.
    - **MCP processes блок (свёрнут):** Под Claude/Gemini показывается счётчик MCP-серверов с пометкой `(N orphan)` — сироты от мёртвых сессий. `isAlive` определяется как PPID, входящий в живые PTY shells ИЛИ их CLI-детей (claude/gemini). Mass-kill работает только для orphan, потому что Claude Code сам респавнит свои MCP при следующем tool-call. По умолчанию свёрнут чтобы не показывать 50+ записей.
- **PendingAction Pattern:** Очередь команд, выполняемых сразу после готовности Shell в новом табе. См. CLAUDE.md.
- **Orchestration (Gemini → Claude):** Автоматический перехват паттерна `:::claude ... :::` из вывода Gemini для запуска Claude Agent SDK. См. [`fact-claude-agent-orchestration.md`](fact-claude-agent-orchestration.md). Также поддерживается полноценная делегация задач через MCP в реальные PTY-табы. См. [`fact-mcp-delegation.md`](fact-mcp-delegation.md).