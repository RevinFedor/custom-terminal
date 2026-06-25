# Fix: Boundary Marker Injection Race (Bridge Gate)

## Симптомы
- Timeline Claude полностью красный (все entries unreachable) после запуска
- `[BoundaryMarker]` логи отсутствуют в dev.log
- `boundaryCount: 0` в terminalRegistry
- Клик по точкам Timeline не скроллит терминал (нет маркеров)

## Корневая причина
OSC 7777 boundary injection state machine в `main.js` была загейчена на `bridgeKnownSessions.has(tabId)`.

**Bridge detection** работает через:
1. Чтение bridge-файлов из `~/.claude/bridge/`
2. PID resolution (связывание PID процесса Claude с tabId)
3. Polling каждые 2 секунды

**Проблема:** Claude начинает выводить данные мгновенно после запуска. Bridge detection догоняет только через несколько секунд. В итоге 99% data chunks (292 из 295 в диагностике) приходили когда `bridgeKnownSessions.has(tabId) === false`. State machine пропускала весь цикл BUSY→IDLE → ноль маркеров инжектилось.

```
Timeline: data chunks vs bridge detection

  Claude output: ████████████████████████████████░░░  (292 chunks, bridge=false)
  Bridge ready:                                  ███  (3 chunks, bridge=true)
  Boundaries:                                     0   (SM missed entire cycle)
```

## Решение
Заменили gate с `bridgeKnownSessions.has(tabId)` на `claudeSpinnerBusy.has(tabId)`.

Spinner detection (символы ✢✳✶✻✽) срабатывает на первом же data chunk от Claude — без задержки на PID resolution. `claudeSpinnerBusy.has(tabId)` остаётся `true` перманентно после первого обнаружения spinner'а.

```javascript
// БЫЛО (main.js ~line 3190):
if (bridgeKnownSessions.has(tabId)) { // ← задержка секунды

// СТАЛО:
if (claudeSpinnerBusy.has(tabId)) {   // ← мгновенно
```

## Дополнение 2026-06-18: restart-счётчик и служебные slash-команды

Поздний bridge был не единственным способом потерять boundary. В stopped-session Rewind Claude process умирает, но xterm buffer/renderer markers остаются жить в той же вкладке. Если `clearBridgeTab` сбрасывает `promptBoundarySeq`, следующий старт снова инжектит `prompt:1`; renderer уже видел marker #1 и не разбудит `waitForPromptBoundaryAfter(afterSeq)`. Пользовательский симптом: `/model` и `/effort` визуально прошли, но Rewind не стартует, потому что gate ждёт marker который main считает отправленным, а renderer считает старым.

Второй слой — service slash-команды вроде `/model`/`/effort`: они могут вернуть prompt без content-spinner, поэтому state machine `idle → busy → idle` не сработает сама. Для таких команд caller обязан явно взвести boundary state в `busy` на submit. Это не optimistic success: marker всё равно появляется только когда PTY реально показал prompt glyph (`⏵`/`❯`/`›`/`╰`). Timeout после этого остаётся ошибкой detector'а/готовности, не разрешением продолжать цепочку.

## Дополнение 2026-06-21: direct prompt-boundary, не только xterm marker

Третий слой — источник доказательства для `waitForPromptBoundaryAfter`. Продовый шрам: `/model haiku` применился, `/effort low` был вставлен и Claude визуально вернулся в готовый prompt; main уже залогировал `[BoundaryMarker] ... Injected prompt #19`, но renderer-side wait всё равно дошёл до timeout и показал ошибку resume. Причина не в том, что Claude не был готов, а в том, что completion-gate зависел от того, что hidden OSC 7777 marker пройдёт через xterm parser и зарегистрирует line marker.

Фикс: в момент той же main-side детекции prompt glyph main теперь шлёт прямой `claude:prompt-boundary { tabId, seq }` в renderer. `terminalRegistry` хранит последний seq отдельно от xterm markers и будит waiters по direct event; xterm marker остаётся для Timeline/scroll anchors, но больше не является единственным source of truth для `/effort` gate. Диагностическая пара в логах: `[BoundaryMarker] ... Injected prompt #N` → `[BoundaryMarkerAck] ... seq=N source=renderer-direct`. Если первая строка есть, а ack нет — проблема доставки IPC/listener; если обе есть, boundary wait не должен падать по timeout из-за xterm parser.

## Дополнительные изменения

### Text-based Fallback (Timeline.tsx, computePositions)
Для случаев когда boundaries всё же отсутствуют (HMR, первый mount до взаимодействия), добавлен fallback через `buildPositionIndex()` — тот же текстовый поиск что используется для Gemini.

### Reachability Guard (Timeline.tsx, checkReachability)
**Обновлено:** Прежний guard `hasAnyPosition` (красить только если >= 1 entry нашла позицию) заменён на `canDetermineReachability = !!terminalRegistry.get(tabId)`. Старый guard блокировал покраснение при закрытом Gemini (0 found из 106 → guard false → timeline не красный, хотя все entries unreachable). Новый guard: нет терминала (startup, HMR) → не красить; терминал есть → `pos < 0` = unreachable.

## Диагностика
Для воспроизведения бага добавлялось временное логирование:
```javascript
console.log('[BoundaryDiag] bridge=' + bridgeKnownSessions.has(tabId) +
  ' spinBusy=' + !!claudeSpinnerBusy.get(tabId) +
  ' st=' + (promptBoundaryState.get(tabId) || 'idle'));
```
6 итераций E2E теста (`auto/sandbox/test-timeline-red-diagnostic.js`) подтвердили гипотезу.

## Связанные файлы
- `src/main/main.js` (~line 3190): Boundary injection state machine
- `src/renderer/components/Workspace/Timeline.tsx`: `computePositions()`, `checkReachability()`
- `docs/knowledge/fact-timeline.md`: Архитектура Timeline
- `docs/knowledge/fix-claude-busy-detection.md`: Spinner detection logic
