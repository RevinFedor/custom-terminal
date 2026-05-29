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

### Правильный сигнал: `bridgeKnownSessions`
Map `tabId → sessionId`. Устанавливается StatusLine Bridge при обнаружении Claude CLI. Очищается через `clearBridgeTab()` при выходе Claude (OSC 133 D) и при убийстве терминала (`terminal:kill`, PTY exit). Это единственный надёжный сигнал "Claude CLI жив в этом табе".

### Правильный момент: `will-quit`
Fires ПОСЛЕ `beforeunload` → renderer уже мёртв и не может перезаписать DB.

### Архитектура (единственный источник правды — main process)

```
before-quit:   additive safety — маркирует bridgeKnownSessions (на случай если will-quit не fires)
beforeunload:  ТОЛЬКО saveSessionImmediate() — НЕ трогает wasInterrupted
will-quit:     ФИНАЛЬНЫЙ — clear stale + mark bridgeKnownSessions (renderer уже мёртв)
```

### Логика clear/mark
- `wasInterrupted=true` при shutdown → **stale** (пользователь не кликнул Continue) → CLEAR
- `tabId ∈ bridgeKnownSessions` → **active** (CLI жив) → MARK

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
