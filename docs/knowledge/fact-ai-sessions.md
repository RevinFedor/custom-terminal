# Feature: AI Sessions Overview

## Intro
Noted Terminal обеспечивает глубокую интеграцию с внешними AI-агентами (Claude Code, Gemini CLI и Codex CLI), превращая их из разрозненных терминальных процессов в управляемые сессии с поддержкой персистентности, ветвления и истории.

## Сравнение систем

| Аспект | Claude | Gemini | Codex |
| :--- | :--- | :--- | :--- |
| **Механизм Fork** | Resume UUID (через `PendingAction`) | **True Fork** (Клонирование JSON) | `codex-f` создаёт новый rollout, source id отслеживает watcher |
| **Time Machine** | Нет (в планах) | **Есть** (Snapshots turns) | Нет, есть rollout compact/rollback markers |
| **Захват ID** | Sniper Watcher (после 1-го обмена) или StatusLine Bridge | После 1-го сообщения (Sniper) | Из `session_meta.payload.id` в `~/.codex/sessions/.../rollout-*.jsonl` |
| **Хранение** | `~/.claude/projects/` | `~/.gemini/tmp/<hash>/` | `~/.codex/sessions/YYYY/MM/DD/` |
| **История Minayu** | Нет | `~/.minayu/history/<id>/` | Нет |

## Детальные описания
- **Claude Sessions:** [`claude-sessions.md`](claude-sessions.md) — Sniper Watcher и управление UUID.
- **Gemini Sessions:** [`gemini-sessions.md`](gemini-sessions.md) — True Fork и особенности Gemini 0.25+.
- **Codex Sessions:** [`fact-codex.md`](fact-codex.md) — rollout JSONL, Model/Effort picker, Codex Continue/Fork и interrupted recovery.
- **Time Machine:** [`time-machine.md`](time-machine.md) — Система откатов для Gemini.

## InfoPanel: AI Session block (компактный layout)
Блок в `InfoPanel.tsx` — единственная строка:
`[⎘ copy] [SessionActionChip] [↻ refresh]  …  [⑂→▭ Fork-tab] [⑂→SDK]`.
Снизу к этой строке примыкает компактный chip Copy session (см. [`fact-clipboard-tools.md::Copy Session: размещение и UX`](fact-clipboard-tools.md)).

- **`SessionActionChip`** — fixed-width 64px кнопка с двумя матрицами состояний в зависимости от `mode` prop:
    - **PTY-режим** (`mode='pty'`, default — терминал с claude/gemini CLI):
        - idle: `Claude` / `Gemini` (accent-цвет, прозрачный фон) — клик копирует sessionId (дублирует ⎘).
        - hover + сессия есть + процесс **не** запущен: `Continue` — клик шлёт `claude:run-command`/`gemini:run-command` с `--resume`.
        - hover + процесс **запущен** (`isCommandRunning`): `Stop` (красный `#ef4444`) — клик шлёт `\x03` (Ctrl+C) через `terminal:input`.
    - **SDK-режим** (`mode='sdk'`, для Anthropic Agent SDK табов где нет PTY):
        - idle: `Claude` (accent-цвет) — клик → focus composer (`claude-sdk:focus-composer` event). НЕ `Continue` и НЕ `Start`, потому что у SDK нет «процесс между turn'ами» как state — query живёт ровно один turn, новый prompt и есть continue. Юзер: *«должна отображаться просто кнопка „Claude“, которая никакого функционала не выполняет»*.
        - hover + query активен (`isCommandRunning` = `sdkBusy` из `claude:busy-state` IPC): `Stop` (красный) — `claude-sdk:stop` IPC + dispatch `claude-sdk:was-stopped` для overlay'я «Process stopped — history preserved».

    Fixed-width 64px необходим, иначе layout прыгает при смене лейбла (Claude → Continue → Stop разной ширины) и кнопки правее сдвигаются. PTY Stop **намеренно** через Ctrl+C, не `terminal:kill` — kill убивает PTY вместе с табом, юзеру нужно прервать процесс **внутри** живого таба. SDK Stop — через `claude-sdk:stop` IPC (закрывает AbortController + `query.close()`), но **с guard'ом**: dispatch'ится только при `sdkBusy=true` — без этого middle-click / context-menu Stop на idle SDK табе показывал overlay «Process stopped» без причины. См. также методологический принцип в [`methodology/сценарии-багов-design.md::12.6 Матрица состояний = lifecycle модели`](../methodology/сценарии-багов-design.md).
- **Тултип на SessionActionChip** — sessionId появляется мгновенно (CSS `group-hover`), всплывает сверху вплотную к чипу.
- **↻ Refresh timeline** — слева от Fork-кнопок, прижата к chip'у. Размер 16x16, шрифт 12px (выровнено с ⎘ через `inline-flex items-center justify-center`).
- **Fork → tab** (`⑂→[icon]`) и **Fork → SDK** (`⑂→SDK`) — справа, ширина ~30–50px каждая. ПКМ по `⑂→tab` конвертирует текущий таб в SDK.
- **Кнопка ✎ Replace session ID удалена из UI** — функционал нестабилен (плохо состыковывает Zustand-store `claudeSessionId` ↔ JSONL ↔ Sniper-bridge: при «вручную» вписанном ID Timeline не подхватывает реальный файл сессии). Код `sessionInputMode`/`renderSessionInput` сохранён в `InfoPanel.tsx` под фичу, но триггер скрыт. Перед возвращением — пересмотреть `setupClaudeChainResolver` и invariants Sniper-watcher'а.
- ID полной строкой под заголовком больше **не показывается** — экономия высоты. Доступен через тултип на заголовке или клик по ⎘ / клик по самому chip'у.

## Общие механизмы
- **Sniper Watcher:** Фоновое наблюдение за файловой системой для захвата идентификаторов сессий.
- **Interrupted Sessions:** Детекция некорректного завершения и предложение восстановления через Overlay. Покажется только если `currentView === 'terminal'`, чтобы не мешать на вкладке Home. State management — исключительно в main process (`will-quit` + ранний `before-quit` mark). Renderer НЕ трогает `wasInterrupted`. Подробности о гонке lifecycle и выборе сигнала (`bridgeKnownSessions` / `codexKnownSessions` vs `claudeCliActive`) — см. [`fix-interrupted-session-lifecycle.md`](fix-interrupted-session-lifecycle.md).
- **Process Monitor (Dashboard):** Глобальный экран мониторинга всех запущенных в системе AI-агентов. Claude, Gemini и Codex показываются отдельными секциями; карточки компактные, раскрытие ограничено локальным scroll внутри секции, а не всей страницы.
    - **Ownership:** Для процессов текущего окна связь берётся из PTY/tab state, но этого мало: dev и production инстансы custom-terminal могут быть запущены одновременно. Dashboard дополнительно читает живые `~/.noted-terminal/mcp-port-<pid>` файлы и поднимается по parent chain процесса. Поэтому `external` означает «вне всех живых custom-terminal instance», а не просто «нет tabId в текущем renderer».
    - **Batch Kill:** Кнопка секции убивает только `killable external` процессы. Процессы, принадлежащие другому dev/prod instance, видны с бейджем владельца, но не получают destructive hover/click. Пользовательский смысл: из production нельзя случайно закрыть dev-вкладки, и наоборот.
    - **In-App Kill идёт через `terminal:kill` IPC**, не через сырой `kill PID`. Сырой kill оставлял бы наши Maps (`terminals`, `terminalOutputBuffer`, `terminalCommandState`) с фантомными записями — UI продолжал бы показывать живой таб для убитого процесса. Через `terminal:kill` запускается полный onExit cleanup. Подтверждение через `confirm()` потому что юзер легко промахивается по крестику.
    - **Codex:** отображается root wrapper процесса, а не vendor child. В дереве часто есть `shell -> node wrapper -> @openai/codex`, и если показать все уровни, пользователь увидит дубли одной сессии и может убить не тот PID.
    - **MCP processes блок:** Счётчик orphan не должен считать MCP живого соседнего custom-terminal instance сиротой. `isAlive` включает текущие PTY/CLI процессы и MCP, чей parent chain приходит к любому живому custom-terminal main PID. Mass-kill работает только для действительно orphan MCP, потому что Claude Code сам респавнит свои MCP при следующем tool-call.
    - **Loader state:** остановка процесса/секции сразу переводит карточку в in-place spinner до refresh. Это закрывает задержку между кликом и исчезновением процесса, когда OS ещё не успела убрать PID из списка.
    - **Performance guard:** внешний inventory процессов — не status polling табов. Dashboard делает один aggregate snapshot (`system:get-dashboard-processes`) из одного `ps` результата, owner/Codex/MCP/Electron Dev строятся из него же, CWD кэшируется по PID. Refresh идёт на mount/focus/visibility/terminal events и медленным visible-window интервалом; не возвращать пять отдельных IPC с `ps` каждые несколько секунд и не делать per-card `pgrep/ps`.
- **PendingAction Pattern:** Очередь команд, выполняемых сразу после готовности Shell в новом табе. См. CLAUDE.md.
