# Fix: «Helper not reachable» в copy-prompt / grab-input

## Симптом для юзера

Юзер пишет промпт в Claude TUI, жмёт **⎘ prompt** (copy) или **+ grab**. Через 3 секунды появляется красный toast **«Helper not reachable»** (или **«Helper never reported back»** в overlay). Inputа Claude никак не реагирует — текст на месте, ничего не скопировалось, ничего не очистилось. Никаких других ошибок в UI.

В `~/Library/Logs/noted-terminal/production.log`:
```
[capture-input:copy] Tab vsg-tab-180: sending Ctrl+G
[capture-input:copy] Tab vsg-tab-180: timeout            ← ровно 3000ms спустя
```
И **ноль** строк `[ClaudeHook] GrabInput …` — helper-script вообще не запустился (или запустился, но не дошёл до socket).

## Два разных сценария с одинаковым симптомом

### Сценарий A: stale PID в `bridgePidCache`

`captureClaudeInput()` пишет lock-файл в `/tmp/noted-grab-<claudePid>.json` где `claudePid` берётся из `bridgePidCache` (Claude PID → tabId, заполняется через SessionBridge). Если юзер **перезапустил Claude в shell** (Esc → `claude --resume` руками, или Claude упал и юзер сам поднял), а наш `Bridge:Fresh` hook не сработал — в cache остался **мёртвый** PID. Lock пишется в `/tmp/noted-grab-<deadPID>.json`, **живой** Claude (с другим PID) на Ctrl+G ищет `/tmp/noted-grab-<livePID>.json`, не находит → helper уходит в **passthrough mode** (`NOTED_ORIGINAL_EDITOR` = Sublime), Sublime тихо открывает temp-файл где-то на десктопе, в socket ничего не приходит → таймаут 3s.

Косвенное подтверждение: в логах production для `tab-180` (баг в 10:19 UTC) последний `Bridge:Fresh` был в **07:44 UTC** — 2.5 часа разрыва. За это время Claude мог быть рестартован вне нашего spawn-pipeline.

### Сценарий B: Claude ещё в bootstrap

Если копировать промпт в течение первых ~10 секунд после старта Claude (`Bridge:Fresh` ← spawn ← `Claude Handshake` ← первый Anthropic API call), TUI ещё инициализируется. `chat:externalEditor` keybinding не зарегистрирован → Ctrl+G попадает в stdin как обычный байт, никакой `getExternalEditor()` не вызывается, helper-script не стартует.

Косвенное подтверждение: `tab-422` падал через **9 секунд** после `Bridge:Fresh`. На этот момент `Claude Runner` только что spawnил `claude`, прошёл первый `Anthropic[…] passthrough: /v1/messages`, прежде чем TUI отрисовал prompt input.

## Fix

**`src/main/main.js::captureClaudeInput`** — alive-probe перед всем pipeline:

```js
const claudePid = findClaudePidByTab(tabId);
if (claudePid) {
  let alive = true;
  try { process.kill(claudePid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
  if (!alive) {
    return { success: false, error: 'stale_pid', claudePid };
  }
  // ...existing EDITOR-check
}
```

Renderer переводит `stale_pid` в осмысленный toast: **«Claude was restarted in shell — close & reopen this tab»**. Юзер сразу понимает что делать, не сидит в недоумении 3 секунды.

Для сценария B (Claude в bootstrap) — отдельный фикс не сделан, нужно дождаться `claudeTurnBusy=false` после первой настоящей `UserPromptSubmit`/`Stop` пары. Workaround юзеру: подождать пока TUI полностью отрисует input bar (~5-10s) перед первым copy.

## Opt-in helper diag log

`~/.claude/hooks/noted-code-grab.js` принимает env `NOTED_GRAB_DEBUG=1` — тогда каждый запуск helper'а добавляет строку в `/tmp/noted-grab-helper.log`: ppid, EDITOR, lockPath, lock content, mode, socket connect status. Используется когда баг повторится — запустить Claude `NOTED_GRAB_DEBUG=1 claude …` и смотреть лог.

По умолчанию выключено чтобы не плодить файл при каждом нажатии.

## Что пробовали и почему отбросили

- **«Helper читал старый lock-file»** — отброшено, helper делает `unlinkSync` сразу после `readFileSync`, stale lock не может выстрелить дважды. Live-проверка через прямой запуск helper'а с подложенным lock'ом — exit=0, lock потреблён, file content корректный.
- **«ppid mismatch через /bin/sh wrapper»** — отброшено, Claude использует `child_process.spawn(binary, args, {stdio:'inherit'})`, не shell wrapper (см. `packages/claude-code-src/utils/editor.ts::openFileInExternalEditor`). `process.ppid` в helper'е = настоящий Claude PID.
- **«wrong EDITOR в env»** — проверили все долгоживущие Claude процессы через `ps -p <pid> -wwwE`: у всех `EDITOR=/Users/fedor/.claude/hooks/noted-code-grab.js`. Шарящий `setupShellIntegration` guard работает корректно.

## Path-зависимости

| Файл | Что изменено |
|---|---|
| `src/main/main.js::captureClaudeInput` | Добавлен `process.kill(claudePid, 0)` alive-check перед EDITOR-check |
| `src/renderer/components/Workspace/panels/InfoPanel.tsx` | Toast-map для `stale_pid` |
| `src/renderer/components/Workspace/PromptQueueOverlay.tsx` | Toast-map для `stale_pid` |
| `~/.claude/hooks/noted-code-grab.js` | Opt-in диагностический лог через `NOTED_GRAB_DEBUG=1` |

Переносимый принцип — см. `methodology/design.md::Cached external resource: alive-probe перед использованием`.
