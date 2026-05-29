# Fact: Mobile-web → PTY+Claude tabs

Расширение mobile-web (см. `fact-mobile-web.md`) на работу с **CLAUDE-табами в обычном терминале** (commandType='claude', tabType='terminal') — не SDK. До этого с phone можно было только смотреть JSONL такого таба read-only + форкнуть в SDK; теперь — открывать, отправлять сообщения, Resume после crash'а, переключать модель/effort, останавливать процесс.

Архитектурно это **тот же mobile-web UI** что для SDK-табов — `SDKParamsButton`, `ChatView`, Virtuoso, composer. Под капотом подменяется источник истории, путь отправки, и появляется ещё одна точка управления lifecycle (Resume + Stop).

## Lifecycle states

PTY+Claude-таб для phone имеет четыре состояния (расширены поверх trivial busy/idle SDK):

- **`inactive`** — PTY жив, но внутри shell, не Claude. Либо Claude exit'нулся (Ctrl+C×2, crash, app restart), либо изначально не запускался. JSONL на диске есть (если когда-то была сессия). UI: Resume-баннер вместо composer, серый dot.
- **`starting`** — Claude процесс существует (bridge.json есть, `bridgeKnownSessions.has(tabId)`), но TUI **ещё не отрендерил prompt-символ `⏵`**. Между этими событиями 1-6 секунд. UI: «Starting Claude…» strip вместо composer.
- **`active`** — Claude TUI готов принимать ввод (`⏵` отрендерён хотя бы раз = `claudePromptReady.has(tabId)`). UI: composer открыт, зелёная dot.
- **`busy`** — Claude в середине turn'а (`claudeSpinnerBusy` или `claudeTurnBusy`). UI: composer disabled, янтарная dot, Stop кнопка в header.

Переходы между состояниями — **только** event-driven, без polling:
- `inactive → starting` — Bridge:Fresh (StatusLine bridge.json) → `notifyClaudeSessionAvailable(tabId)`
- `starting → active` — детектор `⏵` в PTY-выводе → `claudePromptReady.add(tabId)` + WS snapshot
- `active ↔ busy` — Stop hook (UserPromptSubmit / Stop / StopFailure) → `claude:busy-state` → WS broadcast
- `* → inactive` — PTY exit / terminal:kill / clearBridgeTab → WS snapshot + reset обоих Set'ов

## REST endpoints (расширение mobile-web)

```
POST /api/projects/:id/claude-tabs           — создать PTY+Claude таб (Terminal.tsx сам spawn'ит claude по pendingAction)
POST /api/sdk-tabs/:tabId/resume             — claude --resume <sid> в существующий PTY
POST /api/sdk-tabs/:tabId/status             — GET тоже — текущий status + sessionId + commandType
POST /api/sdk-tabs/:tabId/send               — sendMessageAuto (single dispatch) — backend сам роутит SDK vs PTY
POST /api/sdk-tabs/:tabId/stop               — расширен: для PTY делает SIGTERM по claude-child-PID через stopClaudeTab bridge (terminal:stop-ai-process)
```

Все ID — через `decId()` (см. `fact-mobile-web.md::URL-encoded path параметры`).

## Bridge actions

Renderer App.tsx::handleWebBridge новые actions для CLAUDE-PTY:
- `createClaudeTab` — `state.createTab` с `commandType:'claude', pendingAction:{type:'claude-new'}`. **Не зовёт** `claude:spawn-with-watcher` сам — Terminal.tsx mount'нется и обработает pendingAction. Двойной spawn ломал bridge fresh detection.
- `resumeClaudeTab` — pre-check через `claude:get-presence`; если **active/busy** → refuse + return `alreadyRunning:true` (Ctrl+U стёр бы typed text на desktop). Иначе `markPendingResume` + `clearInterruptedState` + `\x15claude --dangerously-skip-permissions --resume <sid>\r` в PTY.
- `stopClaudeTab` — `ipcRenderer.invoke('terminal:stop-ai-process', tabId)` (тот же handler что desktop Stop-кнопка). SIGTERM по claude-child-PID, через 800ms эскалация в SIGKILL. Shell PTY жив → Resume в этом же табе работает. Graveyard `\x03+\x03 setTimeout(250ms)` — Ink TUI redraws prompt между Ctrl+C, второй трактуется как новый первый, Claude не выходит. См. `fact-claude-tui-control.md::Mobile preserve-shell Stop`, `fix-claude-busy-detection.md::4`.
- `sendMessageAuto` — единая точка для `/api/sdk-tabs/:id/send`. Раньше было 2 bridge round-trip'а (status check + send) = +50ms latency. Теперь dispatch внутри одного action: если `tab.commandType==='claude' && tab.tabType!=='claude-sdk'` → `terminal:paste {fast:false}`, иначе → `claude-sdk:send-message`.
- `getClaudeTabStatus` / `getClaudeTabStatusBatch` — обёртки над `claude:get-presence` (одиночная и batch). Batch используется в `getProjectTabsLive` для списка табов в проекте.
- `getProjectTabsLive` расширен — для CLAUDE-табов отдаёт `sessionStatus` (active/busy/inactive/starting).

## fs.watch JSONL tail для live-сообщений

SDK-таб получает live-стрим через `webBroadcast` вызываемый из main на каждом message в `query()` loop. PTY+Claude — нет такого внутреннего callback'а, Claude пишет JSONL сам через append. Решение: при первом WS subscribe на CLAUDE-таб поднимается `fs.watch(filePath)` watcher (`startClaudeTabWatcher` в web-server.js), который при каждом write читает incremental delta и шлёт каждую запись как `{type:'message', message: inner}` — тот же формат что SDK pipeline.

Watcher имеет три неочевидных guard'а:
- **`entry.inflight`** — fs.watch на macOS может fire несколько раз между нашим scheduleRead debounce и `stream.on('end')`. Без guard'а два concurrent reads делят `entry.offset` и пропускают байты (тот же паттерн что в `fix-incremental-reader-race.md`).
- **`entry.leftover`** — если Claude append'ит строку в два write'а, `buf.split('\n')` обрежет JSON в середине → `JSON.parse` бросит → запись потеряна. Незавершённая последняя строка carry-forward'тся в next read.
- **Re-read после end** — `nowSize > entry.offset` после consume → schedule ещё раз. Защищает от записи которая landed между `fs.stat` и нашим чтением (race window ~10ms).

Offset стартует с EOF (`fs.statSync(filePath).size`). Mobile reducer дедупит по uuid, так что повторных broadcast'ов от warm-cache fetch не появится.

## Event-driven session promotion

Когда mobile подписывается на WS для tab у которого ещё **нет sessionId** (Claude только спавнится после `createClaudeTab`), watcher не может стартовать. Раньше был **polling** retry каждые 2 секунды до 60 секунд — костыль.

Сейчас: `claudeTabWatcherPending: Set<tabId>` — таб припаркован в ожидании. Main.js на каждом `claude:session-detected` (4 call sites: Bridge:Fresh, CwdGuard skip, MCP-delegate resume, Claude Runner new) вызывает `_notifyClaudeSession(tabId, sessionId)`. Это:
1. `notifyClaudeSessionAvailable(tabId)` экспорт из web-server → promote pending в живой watcher.
2. `_webBroadcast(tabId, {type:'snapshot', sessionId, sessionStatus:'active'})` → mobile UI получает sessionId моментально без `/status` polling.

Один-выстрел event-driven, никаких retry-таймеров. Edge case: sessionId известен но JSONL ещё не на диске — `fs.watch(~/.claude/projects/)` на корне ждёт появления файла с UUID в имени, при appear → promote.

## Resume guard rails

Mobile-web Resume для CLAUDE-таба обязан соблюдать три инварианта:

1. **Pre-check через `claude:get-presence`** — если status=active/busy, refuse слать `claude --resume`. Ctrl+U в живом Claude TUI стёр бы typed text desktop-пользователя И выкинул бы его из TUI. Юзер видит `alreadyRunning:true`, состояние не меняется.
2. **`markPendingResume(tabId, sessionId)`** — без этого guard'а stale `~/.claude/bridge/<oldSid>.json` (Claude никогда не удаляет свои bridge-файлы) может в первые 15 секунд после Resume stomp sessionId на старый UUID. Mobile-web — пятый writer в реестре (см. `fix-bridge-stale-takeover.md::Layer 4`), наряду с AutoResume, Terminal.tsx Case 2/5, claude-f fork flow.
3. **`state.clearInterruptedState(tabId)`** — Mobile Resume снимает «Сессия была прервана» overlay на desktop. Иначе пользователь увидит stale модалку поверх работающего Claude.

## WS protocol — расширение для PTY+Claude

Поверх существующих SDK событий (`snapshot/message/busy/done`) добавлены поля и события:

- `{type:'snapshot', sessionId, busy, sessionStatus, inputReady}` — `sessionStatus` строка из четырёх состояний, `inputReady` булев флаг (приходит когда `claudePromptReady` flag flip'нулся).
- `{type:'bridge-update', sessionId, model, contextPct}` — main зеркалит `claude:bridge-update` IPC из StatusLine bridge.json (model + context %). Mobile back-derives `usedTokens = window * contextPct / 100`, header pill обновляется live без polling.
- `{type:'busy'/done', busy, sessionId}` — main зеркалит Stop hook в `_webBroadcast` для PTY-табов тоже (раньше только SDK). Без этого composer не блокировался на mobile во время turn'а → race при двойном Send.

## Mobile UI: header pill, Stop, Resume

В header чата для CLAUDE-PTY-табов появляются те же контролы что у SDK:
- **Pill «model · effort»** в центре — `SDKParamsButton` переиспользован. `canParams` open только когда status=active/busy (slash-commands нужен живой prompt).
- **Stop ■** справа от ☰ — красная, видна только когда status=active/busy. Под капотом `Api.stop` который роутит через `stopClaudeTab` bridge → `terminal:stop-ai-process` (SIGTERM по PID, тот же путь что desktop Stop).
- **Context%** под именем таба слева — через `bridge-update` WS event.
- **Resume-баннер** вместо composer когда `claudeSessionId && status==='inactive'`.

`getSDKParams` / `setSDKParams` bridge actions расширены — для PTY-таба читают `bridgeMetadata` (model) + `tab.claudeEffortLocal` (effort), пишут через `claude:send-command` (`/model X`, `/effort Y`). Думать/Think кнопки у SDK на mobile нет, у PTY тоже не добавляем.

## Symptoms (для семантического поиска)

- Открываю CLAUDE-таб с мобилы — composer виден сразу но Send уходит в shell, не в Claude
- После Resume через мобилу desktop показывает «Сессия была прервана» поверх работающего Claude
- Создаю новый Claude-tab с мобилы — sessionId никогда не появляется, UI висит на «Starting Claude…»
- Mobile composer не блокируется во время Claude turn → две одновременные отправки → одна теряется
- Stop с мобилы убил весь таб целиком, Resume не возвращает Claude (Ctrl+D вместо Ctrl+C×2)
- Status badge скачет между active/inactive каждые несколько секунд
- Long-press на CLAUDE-табе в project list работает а на тапе пустой чат (read-only условие игнорирует commandType='claude')

## Code map (неочевидные связи)

- `_notifyClaudeSession` в main.js вызывается из 4 разных call sites (`processFile` cwd-related, CwdGuard skip path, `MCP:Delegate` resume, `Claude Runner` new) — единая точка обновления для mobile WS, никакой дублирующей логики в каждом из них.
- `claudePromptReady` Set обновляется в **одной** точке (PTY data handler, расширенный детектор `⏵`/`>`) — никакого второго writer'а. Cleanup в трёх местах: PTY exit, terminal:kill, clearBridgeTab.
- `terminal:paste` IPC по умолчанию `fast=true` (для Gemini/bash). Для Claude bridge action явно передаёт `fast:false` — иначе Ink режет paste на N chip'ов (см. `fact-claude-tui-mechanics.md::Section 4`).
