# Fix: Claude CLI Busy State Detection (Spinner & OSC)

### Симптомы
- Пульсирующая точка на вкладке (индикатор активности) застревает в состоянии "busy" (пульсация не прекращается), даже когда Claude Code закончил отвечать.
- Индикатор начинает мигать сразу при запуске Claude, хотя агент еще не начал выполнять задачу.
- Детекция активности работает нестабильно в зависимости от текущей цветовой схемы терминала.

---

## 1. Проблема: Ненадёжные визуальные маркеры

### Цветовая детекция (ОТБРОШЕНО)
Ранее система полагалась на поиск символов спиннера (`✢✳✶✻✽`), окрашенных в специфический оранжевый цвет Claude (RGB `215, 119, 87`).
- **Почему не сработало:** Claude Code изменил механизм рендеринга TUI. Теперь цвет спиннера может меняться (например, на красный при ошибках или задержках), а в некоторых темах оформления RGB-коды вовсе не передаются в явном виде.

### Window Title Branding (Ловушка)
Claude Code устанавливает заголовок терминала (через OSC 0/2), который содержит статический символ брендинга: `✳ Claude Code`.
- **Проблема:** Этот символ физически присутствует в потоке данных PTY. Стандартный метод очистки `stripVTControlCharacters()` удаляет только CSI-последовательности, но **не удаляет OSC-последовательности** (заголовки окон).
- **Результат:** Детектор видел символ `✳` внутри "протекшего" заголовка окна и ошибочно считал, что это активный спиннер, включая пульсацию индикатора на IDLE-сессии.

---

## 2. Решение: Глубокая очистка и контентный анализ

Для обеспечения 100% точности детекции без привязки к цветам внедрен новый алгоритм обработки потока.

### Алгоритм детекции (PTY Middleware):
1. **Стриппинг OSC:** Перед анализом из чанка данных принудительно вырезаются все OSC-последовательности (маркеры `\x1b] ... \x07`). Это гарантирует, что символы из заголовка окна не попадут в область видимости детектора.
2. **Очистка ANSI:** Применяется стандартный стриппинг VT-символов.
3. **Контентный фильтр:** Поиск символов `✢✳✶✻✽` в очищенном тексте.
    - **Исключение:** Символ `·` (middle dot) исключен из списка, так как Claude использует его как статичный разделитель в статус-баре.
4. **Debounce (500ms):** Состояние `idle` устанавливается только если в течение 500мс в потоке не появилось ни одного символа спиннера. Это сглаживает микро-паузы между кадрами анимации Ink TUI.

### Неочевидная связь: OSC vs CSI
Критически важно помнить: библиотека `strip-ansi` (или аналоги) часто игнорирует OSC-коды (Operating System Commands). Если ваш детектор ищет спецсимволы, вы **обязаны** сначала применить регулярное выражение для удаления OSC, иначе вы получите ложные срабатывания от window title или OSC 7 (CWD).

## 3. Cleanup при выходе PTY (fix 2026-03)

### Проблема
`claudeSpinnerBusy` и `claudeSpinnerIdleTimer` не очищались при выходе PTY-процесса или `terminal:kill`. Если Claude-таб закрывался пока busy=true — renderer никогда не получал `busy: false`, индикатор залипал.

### Решение
В обоих местах (PTY `onExit` + `terminal:kill`) добавлен cleanup:
1. `clearTimeout` для pending debounce timer.
2. Отправка `claude:busy-state { busy: false }` если был busy.
3. `.delete()` из обеих Map.
4. Лог `[Spinner] Tab X: IDLE (PTY exit cleanup)` / `(terminal kill cleanup)` для диагностики.

Аналогичный cleanup для Gemini (`geminiSpinnerBusy.delete`) уже существовал — Claude был пропущен.

## 3a. Manual Stop ≠ PTY exit cleanup

### Проблема
Кнопка Stop в UI делает `terminal:stop-ai-process` → `ps`-lookup claude/gemini ребёнка под PTY-shell'ом → `process.kill(childPid, SIGTERM)`. Claude-процесс умирает, но **PTY shell живёт** (мы убили child, не parent). `onExit` секции 3 **не сработает**. `claudeTurnBusy` / `claudeSpinnerBusy` / `claudeTurnWatchdog` остаются в активном состоянии — спиннер таба продолжает мигать, watchdog продолжает крутиться 60 минут, prompt queue думает что turn идёт. Юзер: *«нажал остановку сессии, loader не остановился, мигание вкладки продолжается»*.

OSC 133 D от shell-а в этот момент приходит (shell вернул prompt после смерти claude) и `terminal:command-finished` IPC летит в renderer — но `claudeTurnBusy/claudeSpinnerBusy` Map'ы это отдельный канал, OSC 133 их не трогает. Renderer's `claudeBusyMap` подписан только на `claude:busy-state`.

### Решение
В IPC-handler'е `terminal:stop-ai-process` добавлен дубль cleanup'а из секции 3 — `stopBusyState()` функция, которая вызывается **после** успешного SIGTERM (и после SIGKILL escalation если SIGTERM зависнет):

```js
const stopBusyState = () => {
  clearTimeout(claudeSpinnerIdleTimer.get(tabId));
  claudeSpinnerIdleTimer.delete(tabId);
  clearTimeout(claudeTurnWatchdog.get(tabId));
  claudeTurnWatchdog.delete(tabId);
  const wasBusy = claudeSpinnerBusy.get(tabId) === true || claudeTurnBusy.get(tabId) === true;
  claudeSpinnerBusy.set(tabId, false);
  claudeTurnBusy.set(tabId, false);
  claudeHookLastEvent.set(tabId, { event: 'ManualStop', ts: Date.now(), sessionId: bridgeKnownSessions.get(tabId) || null });
  if (wasBusy) {
    mainWindow.webContents.send('claude:busy-state', { tabId, busy: false, reason: 'manual-stop' });
    mainWindow.webContents.send('claude:turn-state', { tabId, event: 'ManualStop', busy: false, success: false, ... });
  }
  stopInterruptWatcher(tabId);
};
```

Дубликат cleanup-логики осознанный — важна **симметрия teardown гарантии**: natural exit (секция 3) и manual stop (секция 3a) оба производят одинаковое финальное состояние. Принцип см. `methodology/переносимый-дизайн.md::Manual interrupt = explicit teardown, не natural onExit`.

### reason:'manual-stop' payload

`claude:busy-state` event теперь несёт необязательный `reason` field — `'manual-stop'` при явной остановке юзером. `usePromptQueueRunner` ловит `busy:true→false` edge и обычно слал next prompt из очереди / делал stop-after. Без `reason` руной Stop запускал следующий prompt — *«я выключил, а оно опять работает»*. С `reason:'manual-stop'` runner делает early return:

```ts
if (reason === 'manual-stop') return;  // skip auto-run / stop-after
```

`claudeHookLastEvent.set(tabId, {event: 'ManualStop', ...})` обязателен **независимо** от `wasBusy`. Без записи `system:dump-claude-state` показывал бы stale `UserPromptSubmit` часами после ручного Stop'а, и любой будущий debug подумал бы что Stop hook молча уронился (см. `fix-claude-hook-silent-dropouts.md::Observability`). Сам по себе факт пользовательского Stop'а полезен для диагностики, не только когда был busy.

### Local-command watcher тоже входит в busy cleanup (compact-cancel)

После добавления `/compact` watcher'а появился третий busy-source рядом с `claudeTurnBusy` и `claudeSpinnerBusy`: `claudeLocalCommandWatchers.has(tabId)`. Он bracket'ит локальную slash-команду Claude через `reason:'local-command'`, но не является model-turn'ом и не обязан завершаться Stop hook'ом. Симптом в проде: юзер нажимает Escape, compact отменяется, RunAfter больше не стреляет лишний раз, но вертикальная process-bar полоска на вкладке и project badge продолжают анимироваться.

Cleanup paths теперь учитывают `wasLocalBusy`:
- pure `Escape` / `Ctrl+C` в `terminal:input` вызывает `cancelClaudeLocalCommandFromInput()` и завершает watcher;
- `terminal:stop-ai-process` вызывает `stopClaudeLocalCommandWatcher(tabId, 'manual-stop')`, а `wasBusy` считает local watcher как busy;
- `clearBridgeTab`, PTY `onExit` и `terminal:kill` перед удалением state эмитят `claude:busy-state busy:false` с `reason:'local-command'`, если watcher был активен.

Граница с `reason:'interrupt'`: local-command cancel **не** disarm'ит Prompt Queue. Это не прерванный assistant turn, а завершение/отмена inline slash-команды (`/compact`), поэтому runner игнорирует edge как non-turn signal. См. `fact-prompt-queue.md::Auto-run стреляет ТОЛЬКО на штатный конец turn'а`.

### Что НЕ покрывает
SDK таб'ы. SDK не использует `terminal:stop-ai-process` (нет PTY) — там cleanup идёт через `claude-sdk:stop` IPC, который закрывает AbortController и `query.close()`. Сам ClaudeSDKTab компонент шлёт `claude-sdk:busy-state {busy:false}` через `useEffect([isRunning])` в `:done` обработчике iterator'а. Если SDK таб не visible (другая project / unmount) в момент Stop'а — busy-state может не отправиться (effect не запускается на unmount'ed компоненте). Это **отдельная latent проблема**, не покрытая текущим фиксом.

## 3b. Graceful Ctrl+C перед SIGTERM (anti-JSONL-corruption)

### Проблема
Raw SIGTERM/SIGKILL приходит kernel-side, **минуя Ink TUI event-loop** Claude CLI. Текущий streaming chunk не дофлашивается на диск, последняя assistant-запись остаётся без записи в JSONL. Следующий user-prompt при `--resume` будет ссылаться на virtual-parent из RAM убитого процесса → **phantom parentUuid orphan** (см. [`fix-claude-2.1.x-phantom-parentuuid.md`](fix-claude-2.1.x-phantom-parentuuid.md)).

Документировано прямо в коде: `[JsonlChainDiag:StopAI:SIGKILL] ... — JSONL flush GUARANTEED lost for in-flight write`.

### Решение: трёхступенчатый kill через все наши paths
Каждый IPC handler, который убивает Claude CLI, теперь сначала шлёт `\x03` (Ctrl+C через PTY input → Ink ловит его как обычный keypress, дофлашивает state, выходит graceful), ждёт **реальный exit-сигнал** через polling `process.kill(pid, 0)` и только если процесс всё ещё жив к deadline — эскалирует. Числа `300ms` / `1200ms` ниже — это max deadline/fallback, не статический sleep и не источник истины.

**`terminal:stop-ai-process`** (Stop button, PromptQueue Stop-after):
1. `term.write('\x03')`
2. Polling до exit, максимум 300ms
3. Если жив — SIGTERM → 800ms grace → SIGKILL fallback
4. Логи: `[StopAI] ... Ctrl+C → pid=N`, `[StopAI] ... exited gracefully via Ctrl+C`, `[StopAI] ... SIGTERM → pid=N (Ctrl+C ignored 300ms)`

**`terminal:kill`** (закрытие вкладки ✕ / PromptQueue Close-after):
1. Проверка через `bridgeKnownSessions.has(tabId)` + `claudeTurnBusy===true` — есть ли активный Claude **и** реально ли идёт turn.
2. Только если turn busy → BFS ps lookup childPid → `\x03` → polling до exit, максимум 1200ms.
3. Если Claude уже стоит на idle prompt → **никакого Ctrl+C ожидания**; сразу fast-close через `term.kill()`.
4. Логи busy-path: `[TerminalKill:GracefulCtrlC] tabId=... — \x03 → waiting for graceful exit`, либо `... exited cleanly in Xms`, либо `... did NOT exit in 1200ms, term.kill() will SIGHUP it`.
5. Лог idle-path: `[TerminalKill:FastClose] ... — skip 1200ms Ctrl+C wait`.

**`before-quit`** (app shutdown — ⌘Q, force-quit, `build:install` через `graceful-quit.sh`):
1. **`event.preventDefault()` сразу на entry** — без него Electron не awaits async handler, продолжает teardown параллельно и убивает PTY раньше polling'а. Подтверждение из production.log: до фикса логи `[Shutdown:GracefulCtrlC] ... waiting for graceful exit` были, парных `exited cleanly` или `did NOT exit in 1200ms` — **ни одного**. Polling никогда не доходил до конца.
2. Concurrent fan-out для всех табов с активным Claude в `bridgeKnownSessions`
3. Каждый: ps lookup → `\x03` → polling 1200ms
4. Promise.race с deadline 1500ms на весь fan-out (чтобы не виснуть на упрямом процессе)
5. **`app.quit()` в конце** — re-trigger выхода; re-entry guard внутри handler'а скипает второй проход и даёт Electron реально выйти.
6. Потом `window-all-closed` делает `term.kill()` уже на остывших PTY
7. Логи: `[Shutdown:GracefulCtrlC] Sending Ctrl+C to N live claude tab(s) before kill`, в конце `[Shutdown:GracefulCtrlC] graceful flow complete, calling app.quit()`. Принцип переносимый — см. [`methodology/переносимый-дизайн.md::Electron before-quit pattern`](../methodology/переносимый-дизайн.md).

### Ловушка: `term.write` vs `term.ptyProcess.write`

`terminals` Map хранит `IPty` инстанс напрямую (`pty.spawn(...)` возвращает его). У `IPty` **нет** свойства `ptyProcess` — `write()` зовётся прямо: `term.write('\x03')`. Опечатка `term.ptyProcess.write` падала в `try/catch` пустым телом, ни в одном из трёх kill-paths (Stop button, close tab, before-quit) Ctrl+C физически **не отправлялся** — везде сразу шёл fallback на SIGTERM/SIGHUP, минуя Ink. Документация фиксов 3b существовала, но **не работала по факту**. Сигнатура в production.log: `[StopAI] Ctrl+C write failed: Cannot read properties of undefined (reading 'write') — falling through to SIGTERM`. Lesson: в `catch` вокруг побочного эффекта (PTY write, IPC send) **обязательно** логировать в саму обработку ошибки, не `catch {}` молча — иначе фикс «работает по описанию, не работает по факту». Принцип — [`methodology/переносимый-дизайн.md::Catch не должен молчать`](../methodology/переносимый-дизайн.md).

### Покрытие
| Источник kill'а | Старое поведение | Новое поведение |
|---|---|---|
| Stop button | SIGTERM → 800ms → SIGKILL | **Ctrl+C → 300ms** → SIGTERM → 800ms → SIGKILL |
| Двойной Esc в TUI | Ctrl+C через PTY (нативно от юзера) | без изменений (наш код тут ни при чём) |
| PromptQueue Stop-after | через `terminal:stop-ai-process` | автоматически покрыто Stop button fix |
| Close tab (✕) | `term.kill()` сразу (SIGHUP) | **busy turn:** `Ctrl+C → 1200ms → term.kill()`; **idle prompt:** `term.kill()` сразу |
| PromptQueue Close-after | через `terminal:kill` | наследует тот же busy-only wait |
| `build:install` | `pkill` → `term.kill()` × N синхронно | **`graceful-quit.sh` → osascript quit → before-quit** (см. 3d) |
| ⌘Q / force-quit | `before-quit` async, **не awaited** Electron'ом — Ctrl+C начинался, но прерывался teardown'ом | `event.preventDefault()` + concurrent fan-out + `app.quit()` re-trigger |

### Почему 1200ms только для busy close/shutdown, а не для каждого close tab
Stop button — юзер активно ждёт ответа UI, дольше 300ms ждать визуально неприемлемо. Claude обычно дофлашивает за 50-200ms, 300ms запаса достаточно.

Для close tab и shutdown секунда паузы допустима **только когда Claude реально пишет JSONL прямо сейчас**. На idle prompt один программный `Ctrl+C` не завершает Claude: он открывает danger-zone `Press Ctrl-C again to exit`. Старый close-path честно ждал 1200ms почти на каждом закрытии уже idle-Claude, но никакого flush-бенефита это не давало. Результат — "закрываю сессию, а приложение зависает на пару секунд" без реальной работы.

Правило: graceful wait в close-path нужен не по самому факту `bridgeKnownSessions.has(tabId)`, а только по `claudeTurnBusy===true`. Иначе защитный flush-path сам превращается в UI lag.

## 3d. `build:install` через `graceful-quit.sh`, не голый `pkill`

`npm run build:install` раньше начинался с `pkill -f '/Applications/Noted Terminal.app'` — это SIGTERM **извне** Electron-процессу. Лайфсайкл-события Electron'а (`before-quit`, `will-quit`) на внешний kernel-сигнал гарантированно не срабатывают — наш graceful Ctrl+C flow к live Claude'ам не выполнялся ни одного раза за всю историю фичи. Каждый ребилд через `build:install` корраптил JSONL открытых сессий — но симптом терялся под общим фоном phantom parentUuid от других путей.

Текущее поведение: `package.json::build:install` → `bash scripts/graceful-quit.sh 5 && ...`. Скрипт шлёт `osascript -e "tell application \"Noted Terminal\" to quit"` (это **Cocoa quit** → Electron `applicationShouldTerminate` → нормальный `before-quit` с preventDefault flow), polls процесс 5 сек, если жив — **fallback на `pkill`** (упрямый процесс не должен блокировать ребилд). После исчезновения процесса дополнительно ждёт до 2 сек чтобы macOS успел освободить `/Applications/Noted Terminal.app` (иначе следующий `rm -rf` в build:install race'ится со ссылками).

Принцип: **не убивай app снаружи через kernel-сигнал если у app есть native-quit affordance**. AppleScript quit / SIGHUP в Windows / `xdotool key ctrl+q` в Linux — это всё пути через lifecycle events приложения, не минуя их. См. [`methodology/переносимый-дизайн.md::Graceful exit через Ctrl+C, не SIGTERM первым`](../methodology/переносимый-дизайн.md).

## 3c. JSONL flush ловушка: SIGTERM/SIGKILL = data loss

Это формализация принципа из 3b. Любой kill TUI-процесса (Ink/Bubble Tea/cursive/любой framework с in-memory state) который держит fd на файл и периодически флашит — **обязан** сначала пройти graceful exit signal через PTY input, не через kernel signal. Иначе:

- Ink держит pending writes в JS event loop
- SIGTERM прилетает напрямую в process, минуя event loop
- `process.on('SIGTERM')` handler в Claude Code **существует** и пытается flush, но конкурирует с в-полёте stream-write который уже начат и не закончен
- Если SIGTERM пришёл между двумя async chunk'ами SSE-streaming'а — последний chunk теряется в RAM, не доходит до диска

Это **глобальное правило**, не специфично Claude CLI. См. [`methodology/переносимый-дизайн.md::Graceful exit через Ctrl+C, не SIGTERM первым`](../methodology/переносимый-дизайн.md).

## 4. DangerZone Ctrl+C (детерминированный выход из Claude)

### Симптомы
Программный выход из Claude CLI (для edit-range, rewind) ненадёжен: Claude не закрывается или команда после выхода теряется.

### Отброшенные подходы
- **0ms delay (два Ctrl+C подряд):** Ink merges два события в одно — Claude не выходит.
- **500ms delay:** Ink успевает перерисовать prompt между Ctrl+C. Второй Ctrl+C воспринимается как НОВЫЙ первый → Claude снова показывает "Press Ctrl+C again to exit" вместо выхода.
- **setTimeout для ожидания shell:** Ненадёжно, время варьируется.

### Решение: Event-driven через DangerZone IPC
1. Отправить Ctrl+C #1.
2. Ждать IPC `claude:ctrlc-danger-zone` (PTY stream содержит "Press Ctrl-C again to exit" → main process детектирует → отправляет IPC).
3. Отправить Ctrl+C #2.
4. Poll `terminal:getCommandState` до `isRunning: false` (OSC 133 D).
5. Ждать `terminal:prompt-ready` (OSC 133 A) перед отправкой следующей команды.

Шаг 5 критичен: без ожидания OSC 133 A команда пишется в PTY до готовности shell — текст теряется или появляется в неправильном месте.

## 5. Верификация
Логика проверена на разных версиях Claude Code (v2.0 - v2.1.32+). Статус `busy` теперь корректно синхронизируется с реальным состоянием "размышления" агента.

**Связанные факты:**
- [`fact-claude-tui-mechanics.md`](fact-claude-tui-mechanics.md) — детали работы Ink Engine.
- [`fact-tabs.md`](fact-tabs.md) — визуализация (RestartZone Pulse).
- [`fix-claude-aborted-streaming-loader.md`](fix-claude-aborted-streaming-loader.md) — case когда busy=true не сбрасывается через Stop hook (user-initiated interrupt идёт мимо stopHooks через `aborted_streaming`), и mitigation через JSONL transcript watcher.
