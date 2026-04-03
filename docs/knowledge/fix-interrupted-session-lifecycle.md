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

**Связанные факты:**
- [`fact-ai-sessions.md`](fact-ai-sessions.md) — Interrupted Sessions overview
