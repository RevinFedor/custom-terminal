# Fix: Ложные синие полоски (Fork Markers) в родительской сессии

### Симптомы
После форка в родительской сессии появляется синяя полоска в самом конце таймлайна, хотя это родитель — разветвление произошло от НЕГО, а не К нему.

## Причина

`saveForkMarker(source, forkedTo, uuids)` при создании форка A→B **наследует** маркеры от A. Если A сам был форком от Z, в DB есть маркер `Z → A`. При наследовании создаётся `Z → B`.

`getForkMarkers(sessionId)` ищет `WHERE source = ? OR forked_to = ?` — возвращает маркеры в обе стороны.

Для сессии A результат:
- `A → B` — **правильный** (форк ОТ меня, показать где)
- `Z → A` — **лишний** (я сам форк ОТ Z, не показывать)

Лишние маркеры имеют snapshot со ВСЕМИ uuid из A (snapshot делался при создании A из Z). Все entries в snapshot → синяя полоска на последнем entry (`isLastEntry = true`).

## Отброшенные подходы
- **Merge всех chain files в один файл при форке** (remap sessionIds): Ломало plan mode маркеры, augmentation, resolveSessionChain. Откачено.
- **Augmentation entries** (сканирование sessionId transitions): Блокировалось forkUuids (все UUID в snapshot), все transitions считались fork transitions.

## Решение
Только `directParent` маркер в renderer — показывается **только в дочерней сессии**:
```javascript
// Только маркер "я дочерняя сессия" (forked_to === sessionId)
// fromMe (source === sessionId) убран — в родителе не нужны синие полоски,
// fork point уже виден в дочерней сессии через её directParent маркер.
toMe = markers.filter(m => m.fork_session_id === sessionId)
directParent = toMe с максимальным entry_uuids.length
markers = directParent ? [directParent] : []
```

**Почему нужен directParent:** В форке entries имеют `sessionId` оригинала (`2fa76efe`), а compact/новые entries — `sessionId` форка (`79fb8d32`). Без fork marker на границе `isPlanModeBoundary` видит смену sessionId и рисует бирюзовую полоску (plan mode). Fork marker подавляет это (`if (forkMarker) return false` в `isPlanModeBoundary`).

**Почему только ОДИН:** Inherited маркеры (от дедушек) имеют snapshot из других сессий — показывают синие полоски в неправильных местах. Direct parent = самый большой snapshot = самый свежий.

**Почему fromMe убран:** При форке из сессии A→B, маркер `A→B` (fromMe) показывал синюю полоску в Timeline родителя A. Пользователь видел лишние синие полоски в сессии, из которой он форкал. Fork point уже виден в дочерней сессии B (через directParent `A→B`), дублирование в родителе не нужно.

**Связанные факты:**
- [`fact-timeline.md`](fact-timeline.md) — Fork & Plan Mode Markers (визуальные разделители)
