# Fix: Гонка при сохранении прерванных сессий (Shutdown Lifecycle)

### Симптомы
- После перезапуска ВСЕ claude-табы (20+) в "синем режиме" (Продолжить сессию), хотя активным был только один.
- После повторного перезапуска табы, которые были в синем режиме, **не очищаются** — остаются синими навсегда.
- Активная вкладка с Claude (idle, на промпте) **не попадает** в синий режим после перезапуска.
- Auto-resume запускает stale сессии, которые пользователь не планировал восстанавливать.
- Auto-resume запускает 11 сессий при каждом рестарте; закрытие Claude через Ctrl+C не разрывает цикл — при следующем рестарте сессии снова auto-resume.

---

## Отброшенные подходы (5+ итераций)

### 1. `claudeCliActive` как сигнал
`claudeCliActive` Map = "Claude обрабатывает запрос прямо сейчас". При idle на промпте — **пуст** (OSC 133 D удаляет). Shutdown находит `claude=0`, ничего не маркирует.

### 2. `terminals` Map как сигнал
Все восстановленные табы получают PTY shell при старте → `terminals.size = 30`. Все табы с sessionId маркируются → массовое "синее" состояние.

### 3. `commandType === 'claude'` как фильтр
Персистентное поле в DB. Таб `run-dev` с `commandType='devServer'` безопасно пропускается, но табы где Claude давно завершился всё равно имеют `commandType='claude'` → ложные маркировки.

### 4. Renderer `markAllSessionsInterrupted` + Main `before-quit`
Electron lifecycle при Cmd+Q: `before-quit` → `beforeunload` → `will-quit`.
Main маркирует в `before-quit`, затем renderer `saveSessionImmediate()` перезаписывает in-memory state (`wasInterrupted=false`) обратно в DB. Маркировка теряется.

При `pkill` обратная проблема: renderer не успевает, но main работает. Если renderer тоже запускается — гонка.

## Решение

### Правильный сигнал: known live AI sessions
Для Claude это `bridgeKnownSessions` (`tabId → sessionId`), установленный StatusLine Bridge при обнаружении Claude CLI. Для Codex это `codexKnownSessions` (`tabId → sessionId`), установленный rollout watcher'ом или явным `codex-c` resume. Shutdown работает по объединению этих map'ов, потому что пользовательский риск одинаковый: живой AI-процесс мог не успеть дописать durable transcript перед закрытием приложения.

`bridgeKnownSessions` очищается через `clearBridgeTab()` при выходе Claude (OSC 133 D) и при убийстве терминала (`terminal:kill`, PTY exit). `codexKnownSessions` очищается на `command-finished`, `terminal:kill`, PTY exit и manual stop — но не во время `_gracefulShutdownInProgress`, см. Codex-секцию ниже.

### Правильный момент: `will-quit`
Fires ПОСЛЕ `beforeunload` → renderer уже мёртв и не может перезаписать DB.

### Архитектура (единственный источник правды — main process)

```
before-quit:   additive safety — маркирует known live AI sessions (на случай если will-quit не fires)
beforeunload:  ТОЛЬКО saveSessionImmediate() — НЕ трогает wasInterrupted
will-quit:     ФИНАЛЬНЫЙ — clear stale + mark known live AI sessions (renderer уже мёртв)
```

### Логика clear/mark
- `wasInterrupted=true` при shutdown → **stale** (пользователь не кликнул Continue) → CLEAR
- `tabId ∈ bridgeKnownSessions ∪ codexKnownSessions` → **active** (AI CLI жив) → MARK

При повторном перезапуске: stale из предыдущей сессии чистятся, маркируются только реально работавшие.

---

## Bridge Cleanup: осиротевшие записи (fix 2026-04)

### Симптом
Пользователь закрывает Claude (Ctrl+C×2) → UI корректно показывает кнопку "Продолжить" → перезапуск приложения → Auto-resume снова запускает закрытую сессию. Цикл повторяется бесконечно (подтверждено production логами: 11 сессий на каждый рестарт).

### Корневая причина
`clearBridgeTab()` была объявлена, но **нигде не вызывалась** — мёртвый код. `bridgeKnownSessions` только росла, записи никогда не удалялись при выходе Claude.

### Отброшенный подход: guard по `claudeCliActive`
Первая попытка: вызывать `clearBridgeTab` внутри guard `if (claudeCliActive.has(tabId))` в обработчике OSC 133 D. **Не работает**: production логи показали `cli=false bridge=true` — `claudeCliActive` очищается другим механизмом (spinner idle path) **раньше** чем OSC 133 D, guard блокирует единственный путь очистки bridge.

### Решение: один сигнал — `terminal:command-finished`
OSC 133 D уже отправляет `terminal:command-finished` в renderer **без каких-либо guard'ов** — именно этот сигнал показывает кнопку "Продолжить". Тот же сигнал теперь чистит bridge. Единственный guard — handshake (shell fires D при инициализации до старта Claude).

**Ключевой вывод:** если UI уже корректно реагирует на событие, main process должен использовать тот же сигнал, а не строить параллельную детекцию с собственными guard'ами.

## Codex known-session map во время shutdown (fix 2026-06)

Codex не имеет Claude bridge-файла, поэтому для shutdown recovery main держит `codexKnownSessions`. На обычном выходе Codex `terminal:command-finished` обязан чистить эту map, иначе закрытая вручную сессия будет считаться активной при следующем quit. Но во время app quit порядок другой: `before-quit` early-mark'ит interrupted tabs, затем GracefulCtrlC шлёт `\x03`, Codex может чисто выйти и сгенерировать OSC 133 D **до** `will-quit`. Если `command-finished` очистит `codexKnownSessions` в этом окне, `will-quit` сначала снимет stale `was_interrupted=1`, а re-mark уже не найдёт Codex-сессию. Пользовательский симптом — после рестарта нет синего overlay/AutoResume для Codex, хотя при закрытии он был жив.

Решение: если `_gracefulShutdownInProgress=true`, `command-finished` только логирует keep и не вызывает `clearCodexKnownSession`; map доживает до финального `will-quit` clear+mark pass. Это противоположно нормальному runtime-cleanup и выглядит контринтуитивно, но именно shutdown-window делает clear опаснее stale-записи.

---

## Закрытие последнего окна обходило recovery (fix 2026-07-10)

Прод-лог дал полную цепочку без гипотез. В 18:48:12 МСК штатный выход пометил пять живых Codex-сессий; в 18:48:43 новый процесс отправил `codex-c` во все пять вкладок. В 18:48:55 последнее окно закрылось, после чего `window-all-closed` сразу убил все PTY и очистил пять known-session записей. Сам Electron-процесс на macOS остался жить. При открытии окна в 18:49:39 renderer восстановил вкладки, но получил `[AutoResume] No interrupted tabs`, поэтому Codex внутри них больше не запустился.

Корень: обычное закрытие последнего окна не вызывает `before-quit`. Старый обработчик ошибочно считал, что штатная пометка и Ctrl+C уже произошли, сам останавливал MCP и убивал PTY, а на macOS после этого не вызывал `app.quit()`. Получалось промежуточное состояние: вкладки сохранены, процессы уничтожены, доказательство для восстановления снято.

Исправление: `window-all-closed` больше не трогает MCP и PTY напрямую, а сразу вызывает `app.quit()`. Закрытие последнего окна теперь проходит через тот же единственный путь, что Cmd+Q: ранняя пометка живых AI-сессий, Ctrl+C, финальная пометка в `will-quit`, затем завершение приложения. Это не ожидание окончания loader/turn: idle и busy Codex-сессии помечаются по факту живого процесса и при следующем запуске восстанавливаются независимо.

Форензика следующей проверки: `[Shutdown:window-all-closed] routing through graceful app quit` должен идти перед `[Shutdown:before-quit] EARLY-MARK`; после нового запуска число `AutoResume Starting N` должно совпасть с `EARLY-MARK ai=N`.

---

## Runtime Stop без процесса: stale commandRunning (fix 2026-06-21)

Продовый симптом был не похож на shutdown: пользователь вручную остановил Codex, ушёл на другую вкладку, вернулся — поверх уже закрытой сессии снова висел `Resuming Codex`; `Continue` на полсекунды показывал `Stopping`, затем `Resuming`, но в терминале не появлялась команда запуска. Форензика по session `019ed0bc-f921-7330-b14d-e5523916b004` показала разъезд: process-tree lookup давал `matches=0`, а tab status всё ещё нёс `commandRunning=true`. Это не живой Codex и не новый launch — это stale projection общего terminal command state.

Корень: no-process ветка `terminal:stop-ai-process` чистила Codex-specific state (`knownSession`, launch payload, TUI-ready/watchers), но не форсила общий `terminal:command-finished` и не сбрасывала `terminalCommandState`. Дальше `getCommandState` доверял `isRunning=true` раньше дорогого process-tree fallback, поэтому UI/API считали вкладку живой и рисовали `Resuming`. 15-секундный startup guard здесь не обязан был сработать: fresh launch payload уже не существовал, значит это был не startup lifecycle, а stale runtime state.

Фикс именно в teardown, не в новом timeout: manual Stop для AI обязан финализировать terminal command state даже если OS-процесс уже умер или не найден. No-process Codex stop теперь эмитит финальный `command-finished`, инвалидирует process cache, чистит launch payload/session/TUI/watchers и публикует `inactive`. Natural `command-finished` после Codex exit делает тот же cleanup хвоста (`TUI-ready`, cache, inactive snapshot), кроме специального `_gracefulShutdownInProgress` окна из предыдущей секции.

---

## Delayed Codex D после Ctrl+C: stale commandRunning (fix 2026-06-24)

Похожий пользовательский симптом повторился без stop endpoint: пользователь завершил Codex через Ctrl+C, ушёл на другую вкладку и через несколько минут вернулся к session `019ef4ec-0e93-7e70-a35a-ccb3289dc1e6`; overlay `Resuming Codex` появился снова, хотя Start/Continue не нажимали. Логи 24 июня по `...-tab-375` показали: в 17:27:37 MSK два Ctrl+C дали OSC `D` (`exitCode=0`, затем `130`), delayed Codex-cleanup увидел `codex-descendant-alive matches=2` и вернул вкладку в `command-started`; в 17:36/17:41 UI всё ещё читал `commandRunning=true`.

Корень отличался от no-process stop: descendant guard был правильным как временная защита от преждевременного cleanup живого Codex, но после того как эти два процесса исчезли, нового shell `D` уже не могло прийти — shell-level finish уже произошёл. Значит fallback «оставить live пока descendants есть» обязан сам владеть финальным событием, иначе stale running живёт до закрытия вкладки/приложения.

Фикс: ветка `codex-descendant-alive` теперь ставит process-tree recheck. Пока `matches>0`, вкладка остаётся live; первый `matches=0` вызывает тот же финальный cleanup, что normal `command-finished`: сброс command state, cache invalidation, clear launch/session/TUI/watchers, runtime `inactive` и `terminal:command-finished`. Recheck отменяется на новом command-start, force-start, PTY exit и terminal kill, чтобы старый финализатор не погасил новый запуск. Логи следующего расследования: `[CodexExitRecheck] arm/still-alive/finalized/clear/stop`.

---

## AutoResume startup: global batch-loader был неверной абстракцией (fix 2026-06)

Первый пользовательский симптом был похож на CSS/React-баг: после restart/build-install приложение сразу показывало обычный терминал, global loader `Starting AI sessions...` не был виден, но Codex/Claude сессии фактически ещё стартовали в фоне. Прод-лог выглядел как `[AutoResume] Resuming ...`, затем `settled inactive ... ms=3/55` и почти мгновенный hide loader'а; пользователь видел зависший Resume только пока вручную не переходил на нужный project/tab.

Первая корневая причина действительно была не в CSS loader'а. AutoResume запускал `codex-c`, но Codex-ветка не эмитила `terminal:force-command-started`, а `waitForAutoResumeSettled` считал первый `presence.status='inactive'` завершением batch. Между отправкой `codex:run-command` и первыми runtime-сигналами есть короткое окно, где PTY launch уже инициирован, но presence ещё не успел стать `starting/busy/ready`. Для только что отправленной команды такой `inactive` означает «старт ещё не наблюдали», а не «восстановление завершилось».

Но следующий лог показал более важный архитектурный провал batch-модели: одна скрытая Codex-вкладка `YXY=-tab-337` зависла на `Starting MCP servers (0/3)`, visible buffer был недоступен (`no-terminal`), и весь global loader ждал её до timeout, хотя остальные сессии могли стартовать независимо. Поэтому финальная модель — не «дробить batch мельче», а убрать global blocker: все AutoResume-вкладки запускаются независимо, `terminal:force-command-started` поднимает per-tab `starting`, `/api/projects/:id/tabs` и `project-activity` транслируют этот runtime status наружу, а desktop блокирует клики только локальным overlay поверх конкретного Terminal. `Starting MCP servers ...` чинится в Codex readiness/watchdog layer одним controlled restart через сохранённый launch payload; iOS/History/API не должны строить свои retry или ждать весь workspace.

---

## SessionStartingOverlay на неактивной вкладке: ready-event не должен зависеть от active tab (fix 2026-06-25)

Продовый симптом 25 июня был обратным к stale process-state: Codex уже стал готов, input был доступен, но при возврате на вкладку `...-tab-1423` пользователь всё ещё видел `Resuming Codex` и закрыл overlay вручную. Логи по session `019efacc-3dab-7883-9e3d-5736e26fba46` дали детерминированную цепочку: `event-start` overlay пришёл в 19:10:37 UTC, `CodexTuiReady input ready` и cleanup startup lifecycle пришли в 19:10:40 UTC, но активной в этот момент была другая вкладка (`...-tab-1438`). В логах до ручного close был только `dismissed`, без `event-hide`.

Корень был не в Codex readiness и не в process detection. `SessionStartingOverlay` хранится как renderer state конкретной вкладки, но путь скрытия по `codex:tui-ready`/`command-finished` сначала сверялся с текущей active tab. Если ready-event приходил пока пользователь смотрел другую вкладку, событие игнорировалось, а при возврате stale overlay снова монтировался поверх уже готового терминала. Дополнительная ловушка: polling `refreshSessionStarting` продолжал уважать `holdUntilReady` даже когда presence уже стал `active`/`busy`, поэтому пропущенный event-hide не восстанавливался следующим poll'ом.

Фикс: hide-event чистит `sessionStarting` по `tabId` события, а не по active tab; active-tab ref используется только чтобы снять dismissed-key для той же вкладки. `holdUntilReady` теперь удерживает overlay только в ранней гонке `presence=inactive` сразу после `command-started`; как только presence стал `active`, `busy` или `manualActionRequired`, poll имеет право скрыть/переклассифицировать overlay. При следующем расследовании этого класса искать цепочку `[SessionStartingOverlay] event-start` → `[CodexTuiReady] input ready` → отсутствие `[SessionStartingOverlay] event-hide` при смене activeTab.

---

## Порядок операций: пометка ДО обрываемого шага (fix 2026-05-26)

### Симптом
После перезапуска **все** claude-табы открылись (терминалы поднялись, PTY созданы), но Claude внутри них **не продолжился** и окно «Продолжить сессию?» не появилось. В логе нового старта:
```
[AutoResume] No interrupted tabs
```
При этом JSONL всех сессий на диске **целые** — ничего не потеряно, ручной `claude --resume` работает. Симптом наблюдается **не каждый** рестарт, а только когда на момент закрытия в каком-то табе Claude **крутил turn**.

### Корневая причина — порядок внутри `before-quit`, не сам сигнал
`bridgeKnownSessions` (сигнал из раздела выше) был **правильным** и непустым. Проблема в том, что UPDATE `was_interrupted=1` стоял в коде **после** двух медленных/обрываемых шагов:
```
before-quit:
  1. flushOpenActivityIntervals()        ✓ быстро
  2. await proxyGracefulShutdown()        ← ЗАСТРЯЛО здесь (до 15s drain)
  3. GracefulCtrlC fan-out (Ctrl+C)       ✗ не достигнуто
  4. UPDATE was_interrupted=1             ✗ НЕ ВЫПОЛНЕНО
  5. app.quit()                           ✗ не достигнуто
```
`proxyGracefulShutdown()` ждёт, пока `proxyActiveConnections.size` упадёт до 0. Но keepAlive-прокси (`ANTHROPIC_BASE_URL` per-tab routing) держит TCP-сокет открытым, пока Claude стримит ответ. Turn в полёте → соединение не закрывается → drain крутит свой 15-секундный цикл. На этом фоне `build:install` через `graceful-quit.sh` убивает процесс по своему дедлайну → `before-quit` так и не доходит до пометки.

**Детерминированное доказательство (A/B по номерам строк production.log, append-only = хронология):**

| Рестарт | Лог при закрытии | Резюм |
|---|---|---|
| 09:04 | `GracefulCtrlC Sending` → `before-quit marked=3` → `will-quit marked=3` | ✅ 3 |
| 19:25 | … → `before-quit marked=6` → `will-quit marked=6` | ✅ 6 |
| 12:38 | `before-quit bridge=0 marked=0` (живых Claude нет) | ✅ корректный 0 |
| **16:06 (баг)** | `Activity flushed` → `Graceful shutdown: 1 active connections, draining...` → **ОБРЫВ** | ❌ marked не достигнут |

В рабочих закрытиях прокси был **пуст** (`drain` не запускался вообще) → цепочка доходила до `marked=N`. В сломанном — `1 active connection` → drain застрял → пометка потеряна. Renderer поллил Timeline до 16:06:08, прокси отвечал до 16:06:14 — старый процесс жил ~23с в quit, но до UPDATE не дошёл ни разу.

### Решение: пометить ПЕРВЫМ действием
UPDATE `was_interrupted=1` перенесён в **самое начало** `before-quit`, сразу после `event.preventDefault()` — **до** flush/drain/Ctrl+C. Это синхронный better-sqlite3 UPDATE (sub-ms), он завершается мгновенно и переживает любой последующий обрыв graceful-цепочки (зависший drain, pkill, SIGKILL). Лог: `[Shutdown:before-quit] EARLY-MARK marked=N`. `will-quit` (clear+mark) остаётся финальным проходом, когда успевает выполниться.

**Второй слой — `scripts/graceful-quit.sh`:** дедлайн считался **итерациями**, а не секундами (`sleep 0.25; SECS+=1` → `DEADLINE=5` = 1.25с реального времени, ниже 15s-бюджета drain). Исправлено на сравнение wall-clock через `date +%s`; дефолт в `package.json::build:install` поднят `5 → 20`. Дедлайн — **потолок**, не фиксированное ожидание: при нормальном закрытии `is_running` сразу false, цикл выходит за ~1.3с.

### Третий слой: never-downgrade при `saveTabs` во время стопора

EARLY-MARK переживает обрыв graceful-цепочки, но есть второй вектор затирания. Во время зависшего drain (до 20с) **renderer ещё жив** — `before-quit` сделал `event.preventDefault()`, quit заблокирован, `beforeunload` не наступил. Renderer продолжает обрабатывать фоновые события, и любой из них, дёрнувший `saveTabs`, перезаписывает только что выставленную пометку. `db.saveTabs` делает **полный delete+reinsert** всех строк, подставляя `was_interrupted` из in-memory таба — а там у всех вкладок `false` (это поле не живёт в памяти renderer'а при нормальной работе). Один фоновый save во время стопора → все строки переписаны с `was_interrupted=0` → EARLY-MARK затёрт → опять `No interrupted tabs`.

Триггер фонового save в этом окне — bridge `claude:session-detected` → `setClaudeSessionId` → `saveTabs` (когда Claude дописал ответ перед смертью и сменил sessionId). **CwdGuard-фикс этой же сессии расширил окно**: теперь session-detected эмитится даже при path-drift (раньше блокировался), то есть фоновых saveTabs во время стопора стало больше.

Решение — флаг `preserveInterrupted` в `db.saveTabs`, прокинут через `saveProjectTabs` и оба IPC-хендлера (`project:save-tabs` + `-sync`), включается значением `_gracefulShutdownInProgress`. При нём перед delete снимается снимок `was_interrupted` всех строк с диска, и при reinsert значение берётся как `snapshot[tab] OR tab.wasInterrupted` — единица **никогда не падает в ноль**, остальные поля сохраняются нормально. Вне закрытия (`_gracefulShutdownInProgress=false`) — поведение прежнее, штатный dismiss оверлея (`was_interrupted=0`) работает как раньше.

Почему не проще заблокировать `saveTabs` во время закрытия целиком: потеряли бы last-second легитимный save (например MCP-субагент создан за секунды до quit). never-downgrade защищает **только** критичное поле, не трогая остальные.

### Переносимый принцип
**Критичная для восстановления пометка состояния должна стоять ДО любого медленного/обрываемого шага в shutdown-хендлере, а не после.** Цена записи (sync SQLite UPDATE) ничтожна, цена потери (тихая потеря резюма всех сессий) высока. Не ставь дешёвую необратимую запись в хвост обработчика за `await`-ами, которые могут зависнуть или быть убиты извне. См. [`methodology/переносимый-дизайн.md`](../methodology/переносимый-дизайн.md).

Парная грань: если рядом есть **full-row-rewrite** персистентного состояния (delete+reinsert всех строк из in-memory модели), он во время того же teardown-окна может затереть пометку обратно — in-memory модель не знает про неё. Защита — never-downgrade: критичное поле берётся как `max(on-disk, in-memory)`, не слепо из памяти. Точечно по полю, не блокировкой всего пути записи.

**Связанные факты:**
- [`fact-ai-sessions.md`](fact-ai-sessions.md) — Interrupted Sessions overview
- [`fact-provider-proxy.md`](fact-provider-proxy.md) — keepAlive drain, per-tab routing (источник стопора)

### Forensic grep
```bash
# Дошла ли пометка до конца? EARLY-MARK = новый ранний путь, marked=N = число помеченных
grep -E "Shutdown:before-quit\] EARLY-MARK|Shutdown:will-quit\] cleared|AutoResume\] (No interrupted|Resuming)|ProviderProxy\] Graceful shutdown:" \
  ~/Library/Logs/noted-terminal/production.log | tail -40
# Если видишь "Graceful shutdown: N active" БЕЗ последующего "EARLY-MARK" в том же закрытии — drain застрял (но теперь пометка уже сделана ДО drain)
```
