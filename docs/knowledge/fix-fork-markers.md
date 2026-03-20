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
Фильтр в renderer при загрузке маркеров:
```javascript
markers.filter(m => m.source_session_id === sessionId)
```
Показывать только маркеры где текущая сессия — **source** (форки ОТ меня). Маркеры где сессия — **forked_to** (я сам форк) — прятать.

**Связанные факты:**
- [`fact-timeline.md`](fact-timeline.md) — Fork & Plan Mode Markers (визуальные разделители)
