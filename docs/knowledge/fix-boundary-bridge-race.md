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

## Дополнительные изменения

### Text-based Fallback (Timeline.tsx, computePositions)
Для случаев когда boundaries всё же отсутствуют (HMR, первый mount до взаимодействия), добавлен fallback через `buildPositionIndex()` — тот же текстовый поиск что используется для Gemini.

### hasAnyPosition Guard (Timeline.tsx, checkReachability)
Если ни одна entry не получила позицию (пустой буфер, свежий запуск), entries НЕ помечаются как unreachable. Красный фон активируется только когда есть хотя бы одна позиционированная entry (значит остальные реально вытеснены из scrollback).

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
