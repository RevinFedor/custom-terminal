# Fix: Fork Markers — ложные полоски и удаление

### Симптомы
- После форка в родительской сессии появляется синяя полоска в самом конце таймлайна
- Удаление fork маркера (синей полоски) приводит к появлению ложного зелёного "Clear Context" маркера
- В каскадных форках (форк из форка) ложная синяя полоска от деда-сессии появляется вместо правильной

## Эволюция решений (хронология)

### Этап 1: directParent фильтр (ранний фикс)
**Проблема:** `getForkMarkers(sessionId)` возвращает маркеры в обе стороны (`WHERE source = ? OR forked_to = ?`). В родителе A после форка A→B появлялась лишняя синяя полоска.

**Решение:** В renderer показывается **только** маркер `forked_to === sessionId` (дочерний). В родителе не нужны синие полоски — fork point виден в дочерней сессии.

### Этап 2: forkSnapshotSets (подавление наследованных границ)
**Проблема:** `isPlanModeBoundary` проверяет `entry.sessionId !== nextEntry.sessionId`. В форке наследованные plan mode transitions (A→B→C) показывались как ложные бирюзовые полоски.

**Решение:** `forkSnapshotSets` (useMemo) — если **обе** записи в одном snapshot → граница из родительской цепочки → подавить. Остаётся как safety net.

### Этап 3: SessionId Rewrite при форке (текущее решение)

**Проблема:** При копировании JSONL все entries сохраняли sessionId оригинала. Новые entries от Claude CLI получали sessionId форка. Timeline видел разные sessionId → ложный "Clear Context" маркер. Fork marker подавлял это, но удаление маркера оголяло ложную границу.

**Ранее отброшено:** "Merge всех chain files + remap sessionIds" — ломало plan mode маркеры, augmentation, resolveSessionChain.

**Почему сейчас работает:** Не мержим файлы — просто переписываем sessionId в копии. Все entries в форке получают единый sessionId. Нет смены sessionId → нет ложных границ → fork marker нужен только как визуальный индикатор (синяя полоска), а не для подавления.

**Следствия:**
- **Наследование маркеров убрано** — `saveForkMarker` больше не копирует маркеры от родителя. Наследованные маркеры от дедушек имели БОЛЬШИЙ snapshot чем direct parent → `directParent` selection выбирала деда вместо реального родителя, создавая ложную полоску.
- **Soft-delete** — удаление маркера ставит `hidden=1` (колонка `fork_markers.hidden`). Hidden маркеры не рендерят полоску, но snapshot'ы сохраняются для `forkSnapshotSets` (safety net на случай старых форков без sessionId rewrite).
- **Bridge isolation** — `loadJsonlRecords` определяет bridge по `entry.sessionId !== fileName`. После rewrite все entries имеют sessionId = fileName → `bridgeSessionId = null` → fork-копия не может быть ошибочно «склеена» с parent chain.

**Связанные факты:**
- [`fact-timeline.md`](fact-timeline.md) — Fork & Plan Mode Markers (визуальные разделители)
- [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) — Section 3: Fork vs Bridge isolation
