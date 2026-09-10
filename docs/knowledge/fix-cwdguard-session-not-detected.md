# Fix: CwdGuard блокирует `claude:session-detected` при path-drift PTY

## Симптомы

- После рестарта приложения (`build:install`, ⌘Q + open, restore from DB) вкладка приходит без привязки к живой сессии Claude. В UI — «Waiting for session» и/или новый запуск `claude` без resume на ту же сессию.
- Сессия на диске цела (JSONL существует, parentUuid цепочка не порвана), Claude процесс реально работает в табе — но `Tab.claudeSessionId` в БД = `null`.
- В `production.log` есть `[Bridge:Fresh] tab=... session=<sid>`, но **нет** следующего `[Bridge] Tab ... -> session: <sid>` и **нет** renderer-side `[R] [Store:setClaudeSessionId] null -> <sid>`. Цепочка обрывается между main и renderer.
- Часто сопровождается варн-логом `[Bridge:CwdGuard] Skip overwrite: tab cwd=<A> but bridge cwd=<B> ... paths unrelated`.
- В UI у юзера часто всплывает побочно: «нажимаю Stop — туда вводится `claude --resume`», «у меня была сессия в этой вкладке, потом пропала, хотя я не закрывал».

## Конкретный инцидент (2026-05-23)

Tab «agents.md → claude.md» (`custom-terminal-tab-662`). История PTY:

```
07:55:05 PTY:CREATED tab-662 cwd=/Users/fedor/Desktop/custom-terminal
07:56:07 PTY:EXIT exitCode=1                                           ← shell упал
07:56:10 PTY:CREATED tab-662 cwd=/Users/fedor/Desktop/voice-record     ← пересоздался в ДРУГОМ cwd
10:56:17 PTY:CREATED tab-662 cwd=/Users/fedor/Desktop/voice-record     ← после рестарта Electron'а тоже /voice-record
11:11:41 Bridge:Fresh tab-662 claudePid=85540 session=871ae5e2 (bridge.cwd=custom-terminal)
11:11:41 Bridge:CwdGuard Skip overwrite: tab cwd=voice-record but bridge cwd=custom-terminal — paths unrelated
         (НЕТ setClaudeSessionId)
```

Юзер использовал tab-662 час, наработал 338 записей в `871ae5e2`. Потом `build:install` → restore прочитал tab из БД с `claudeSessionId=null` → попытался запустить новый `claude` → процесс grohnulся через 2 секунды (видно по `CtrlC-DangerZone ON — "Press Ctrl-C again to exit"`). Сессия `871ae5e2` осталась на диске, но в UI пропала.

После того как юзер вручную ввёл `claude --resume 871ae5e2...`, тот же `Bridge:Fresh` сработал, но **на этот раз** `bridge.cwd === tab.cwd` (юзер делал `cd` обратно в custom-terminal перед resume) → CwdGuard пропустил → `setClaudeSessionId` отработал → вкладка снова привязалась.

## Root cause

`processFile()` в `main.js` для bridge.json делает:

1. Liveness checks (transcript exists, updated_at fresh)
2. PID resolution (resolve через `ps`, command-name validation)
3. **CwdGuard** — сравнивает `terminalProjects.get(tabId)` (= cwd которым PTY был create'нут) с `bridge.cwd` (= cwd где живёт Claude). Если пути unrelated → `return` без дальнейшей обработки.
4. После CwdGuard — `bridgeKnownSessions.set(tabId, sessionId)` + emit `claude:session-detected` в renderer.

CwdGuard сделан для защиты от **bridge-takeover** (stale bridge с другим cwd пытается захватить чужой tab — см. [`fix-bridge-stale-takeover.md`](fix-bridge-stale-takeover.md)). Но он **тотальный** — блокирует и main-side mutate (`terminalProjects.set`), и **renderer-side broadcast** (`session-detected`). Renderer'у sessionId не приходит, `Tab.claudeSessionId` остаётся `null`, в SQLite сохраняется `null`.

Шаг между CwdGuard и emit'ом — это **разные побочки**: главная защита (от takeover) лежит в том чтобы НЕ мутировать main-side каши. Broadcast в renderer takeover'а не создаёт: renderer пишет в свой Tab-store, который специфичен для этого tab'а; PID-resolution на шаге 2 уже подтвердил что Claude процесс реально parented этим конкретным shell'ом. Источник правды — PID match, не cwd.

## Fix

В `src/main/main.js::processFile`, ветка `if (!isRelated)`:

```js
if (!isRelated) {
  const known = bridgeKnownSessions.get(tabId);
  if (known !== data.session_id) {
    console.warn('[Bridge:CwdGuard] Skip overwrite: ...');
    // Renderer-side persistence still fires. CwdGuard's job is to prevent
    // `terminalProjects.set` and `bridgeKnownSessions.set` (those are the
    // takeover vectors). But the *renderer* needs sessionId to land in
    // Tab.claudeSessionId or the tab forgets its session across app restart.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude:session-detected', { tabId, sessionId: data.session_id });
    }
  }
  return;
}
```

Emit идёт **только при первом обнаружении** (`known !== data.session_id`) — на повторных сканах того же sessionId не спамим.

Главное что **не** меняется:
- `terminalProjects.set(tabId, data.cwd)` — НЕ вызывается. Канонический cwd таба сохранён, последующие CwdGuard-сравнения остаются строгими.
- `bridgeKnownSessions.set(tabId, data.session_id)` — НЕ вызывается. Main не «забывает» что эта пара tab+session уже была видна; но это **не основной канал** хранения для tab'а — основной канал это renderer-side `Tab.claudeSessionId` + SQLite.

## Verification

- Воспроизведение: создать tab в проекте A (`/Users/fedor/proj-a`), внутри shell сделать `cd /Users/fedor/proj-b`, запустить `claude`. До фикса — sessionId не привязывается, после рестарта app таб теряет сессию. После фикса — таб помнит sessionId через рестарт.
- Защита от takeover работает: симулировать stale bridge.json с чужим cwd для PID-reused shell → `terminalProjects` не overwrites'ится (CwdGuard всё ещё блокирует main mutate), renderer получает sessionId (но он совпадёт с тем что таб уже имел через AutoResume).

## Related

- [`fix-bridge-stale-takeover.md`](fix-bridge-stale-takeover.md) — родственный fix про PID reuse + stale bridge.json. Этот fix добавляет 5-й failure mode.
- [`fact-session-capture.md::Changing directories with 'cd' inside shell`](fact-session-capture.md) — CwdGuard как concept.
- [`methodology/дизайн-принципы.md::Path-prefix tolerance для cwd-сравнений`](../methodology/дизайн-принципы.md) — переносимый принцип CwdGuard + дополнение про чёткий scope побочки.
- [`methodology/дизайн-принципы.md::Защита не должна блокировать неконфликтующий side-effect`](../methodology/дизайн-принципы.md) — переносимый принцип, обобщающий этот fix.
