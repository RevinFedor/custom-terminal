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

## Остановка сессий workflow

Автоматический вариант10.10 — Run After → Settings → Auto-stop. Отдельный Main
deadline-owner переиспользует нижеприведённые exact scope/owner и Stop primitives,
но допускает только положительно подтверждённый простой AI. Политика, уже-idle,
Root/draft guards и countdown — `fact-prompt-queue.md::Автоостановка простаивающих процессов`.
Ни открытие меню, ни истечение числа секунд сами по себе не разрешают сигнал.

Desktop `SpaceStrip` вызывает `workflow:stop-sessions` с явными workflowId и
mode `idle`/`all`. Main берёт полное canonical active membership и сохраняет
точный execution subject/namespace каждой цели. Вкладки без живого процесса,
file/browser без процесса и archived provenance не получают Stop. Цели и
владельцы фиксируются до await; исполнение ограничено четырьмя параллельными
проверками, одинаковый повторный клик присоединяется к этому же набору.

`idle` требует свежего положительного отсутствия собственной/дочерней работы,
операционных фаз и pending input. Renderer может только дополнительно исключить
локальную подготовку Send/paste. Перед действием повторно проверяются membership,
subject, token/generation/run/input и process identity. Unknown lookup и поздний
replacement сохраняют процесс; частичный отказ возвращается отдельно по цели.

Для native Claude/Codex дочерняя работа включает собственный Main background
registry, не только MCP inherited projection: `turnBusy=false` родителя при
положительном `getCombinedTabBackgroundWorkCount` не разрешает `idle` Stop.
Явный `all`/ручной Stop сохраняет прежнее право завершить работающий процесс.

PTY Claude/Codex/Gemini использует прежний сериализованный Stop/graceful/escalation
и сохраняет shell/историю; script — прежний deterministic Stop без Restart.
SDK — прежний hard Stop query, включая background tasks, а не soft interrupt
хода. SDK idle определяется событиями его существующего query/channel/result,
compact и задач, без таймера. После подтверждённой остановки SDK сохраняется
обычный `was-stopped` сигнал для продолжения сессии.

Manual Stop сохраняет прежний reason и отмену accepted waiting Send/command
admission. Для workflow эти побочные действия и отмена pending compact начинаются
только после конечного guard: отказ `idle→busy` не отменяет новую чужую работу.
Этот desktop IPC не является новым HTTP/native operation wire и не меняет
системный Process Controls, composer Escape или удаление вкладок.

## Общие механизмы

- **Sniper Watcher:** Фоновое наблюдение за файловой системой для захвата идентификаторов сессий.
- **Interrupted Sessions:** Main помечает точный набор живых Claude/Codex в раннем `before-quit` и финальном `will-quit`. Красная кнопка macOS сначала удерживает живое окно и показывает общий shutdown-overlay, затем входит в тот же quit-path, что Cmd+Q; `window-all-closed` остаётся safety route, но сам по себе слишком поздний для UI. Liveness и recoverable identity разделены: process tree может добавить tab в graceful-stop set, но auto-resume target даёт только Claude bridge, valid Codex writer, exact active/stopping identity или полностью совпавший accepted Claude Resume. Main замораживает provider/session и отдаёт renderer на boot; renderer не выводит owner повторно из labels/DB. После полного restore targets возобновляются строго по одной: следующая ждёт terminal ready/manual blocker/error предыдущей. Blocking Continue-overlay и Home toggle удалены; с 2026-09-11 `wasInterrupted` вовсе не имеет визуальной презентации на вкладке/композере (плашка `SESSION INTERRUPTED` и синяя пунктирная рамка убраны) — маркер кормит только очередь AutoResume и счётчик/Resume-all в сайдбаре, а очищается после ready proof. Ошибка автозапуска объявляется жёлтым warning-тостом и не скрывает marker. Обычный Resume в SessionActionChip остаётся для намеренно остановленной, а не crash-recovery сессии. Renderer не маркирует shutdown самостоятельно. Полный контракт — [`fix-interrupted-session-lifecycle.md`](fix-interrupted-session-lifecycle.md).
- **Исторический системный монитор (UI удалён10.10):** Fedor прямо отменил `Process controls`/`MCP processes`, перенесённые с Home в ресурсы/MCP. Верхние меню больше не монтируют общий список, не читают `system:get-dashboard-processes` и не дают generic PID/bulk Stop. Не возвращать эту возможность новой группой или кнопками по прежней рекомендации. Прежние IPC/guards оставлены внутри Main; обычные Stop/close/shutdown своих вкладок и shared hub/config продолжают работать прежними путями.
    - **Почему старый orphan-counter нельзя использовать для автоматического kill:** `isAlive` legacy MCP inventory означает принадлежность к известным PTY/app owners, не OS-liveness. Проверка10.10: отдельно запущенный Appium4746 в путиios-mcp и общий detached browserbridge ошибочно попали в2orphans. Наличие строки, отсутствиеtabId и `ppid=1` не доказывают ни закрытие прежней вкладки, ни ненужность сервиса. Новый UI удалён, legacy predicate не объявлен исправленным.
    - **Сохранённые runtime-границы:** Stop своей AI-вкладки использует `terminal:stop-ai-process` с graceful/lifecycle cleanup, full tab close — собственный `terminal:kill`. Ни один не заменяется kill по отображённому PID. Other-instance guards остаются в Main; подробнее — `fix-mcp-multi-instance.md`. Удаление карточек не останавливает процессы, не меняет Resume и не удаляет сохранённую историю.
- **PendingAction Pattern:** Очередь команд, выполняемых сразу после готовности Shell в новом табе. См. CLAUDE.md.
