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

### Этап 4: Множественные ложные синие полоски при «дырявом» snapshot

**Симптомы:** В дочернем форке появляются 2+ синих полоски, хотя fork marker в БД ровно один. У родительской сессии своих fork-полосок нет (фикс этапа 1 убрал `fromMe` markers). Воспроизводится когда родитель между двумя форками успел сделать rewind / edit-range / delete-range.

**Причина:** Snapshot UUID сохраняется в момент форка как набор Timeline-eligible UUID активной ветки родителя. Раньше edge detection рисовал полоску на **каждой** границе `entry∈snapshot && next∉snapshot`. Логика подразумевала, что snapshot — это **префикс** активной ветки (всё до точки форка). Это верно только если родитель не модифицировал активную ветку после форка.

После rewind / edit-range / delete-range активная ветка родителя получает «дыры» — например edit-range в середине удаляет N записей и вставляет один compact entry, чьего UUID в snapshot нет. Теперь активная ветка дочернего форка пересекает snapshot **прерывисто**: куски IN-snapshot чередуются с кусками OUT-of-snapshot. На каждом таком переходе старая edge-логика рисовала отдельную синюю полоску. В реальном случае получалось **67 точек** вместо одной.

**Решение:** Полоска рисуется **только в позиции последнего entry активной ветки, чей UUID входит в snapshot** (`forkMarkerLastSnapIndex` useMemo). Это семантически = «последняя точка, которая была в родителе на момент форка». Один marker → одна полоска, всегда. Дыры в snapshot игнорируются — нам важна только верхняя граница.

**Что не пострадало:**
- `forkSnapshotSets` (подавление наследованных plan-mode boundary внутри snapshot, этап 2) — остался независимой логикой. Если плэн-мод переход случился ВНУТРИ snapshot обоих entries — он по-прежнему подавляется как наследованный. Если ВНЕ — рисуется как реальный.
- `directParent` selection в renderer (этап 1) — логика не тронута, по-прежнему передаётся ровно один marker.

**Невидимый контекст: что не сработало бы.**
- *Перерасчёт snapshot при сохранении*: можно было бы при saveForkMarker писать только UUID последнего user-сообщения родителя. Отбросили: snapshot нужен в нескольких местах (suppression наследованных границ, fork tooltip, export-from-fork-point), все они опираются на полный набор. Сужение до одного UUID сломает их.
- *Сторнирование snapshot при edit-range/delete-range родителя*: чтобы поддерживать инвариант «snapshot = префикс ветки», пришлось бы хранить позицию форка (не UUID) и перевычислять при изменениях родителя. Это race condition: пока пересчёт идёт, форки в других вкладках могут увидеть пустой snapshot. Выбрали интерпретировать на стороне renderer'а — БД остаётся simple-write.

### Этап 5: Перенос Timeline metadata при форке (notes + rewind markers)

**Проблема:** Фиолетовые заметки (`timeline_notes`) и розовые rewind-точки (`timeline_rewind_markers`) хранятся в SQLite по уникальному ключу `(entry_uuid, session_id)`. Форк копирует JSONL и **переписывает sessionId на newSessionId** (этап 3), но строки в этих двух таблицах остаются с **оригинальным** session_id. В новой fork-вкладке они не отрисовывались, хотя UUID entries те же самые.

**Решение:** `db.copyTimelineMetadataForFork(newSessionId, allUuids, forkTabId)` вызывается из обоих мест форка (`claude:fork-session-file` и Claude Runner auto-fork при `claude-f <uuid>`). Берёт **все** UUID из новой копии JSONL (не только Timeline-eligible), для каждого ищет существующие notes/rewind-markers любых session_id и вставляет копию с `session_id = newSessionId`. `INSERT OR IGNORE` — повторный форк безопасен.

**Невидимый контекст (почему именно так):**

- **Match по UUID, а не по `source_session_id`.** Cascade-форки и Plan Mode внутри parent-файла дают entries с разными sessionId внутри одного JSONL (например 4 разных sid в файле, который сам результат форка). Match по «копировать все строки где `session_id = X`» промахивается — заметка может висеть на UUID, чей `session_id` отличается от UUID-аргумента форка. Match по UUID с `session_id != newSessionId` корректно подбирает все цепочки.
- **`MAX(updated_at) GROUP BY entry_uuid` для дедупликации.** Если один и тот же UUID есть в нескольких sessionId (накопилось от прошлых форков), при простом копировании получим N строк → конфликт `UNIQUE`. GROUP BY оставляет одну, самую свежую.
- **Чанки по 800 UUID.** SQLite лимит параметров 999, но `WHERE entry_uuid IN (...)` с переменным числом ставит каждый UUID параметром. На больших сессиях (1500+ UUID) без чанкинга падает с `too many SQL variables`.
- **Один транзакционный блок на чанк.** Без `db.transaction` каждая `INSERT OR IGNORE` дёргает fsync — 1500 UUID = ~5 секунд блокировки. Транзакция = одна запись, миллисекунды.

**Что не делаем:**

- **Не удаляем оригинальные строки.** Если пользователь закроет fork-вкладку и вернётся в parent — заметки в parent останутся видны.
- **Не фильтруем по Timeline-eligibility.** Заметки рисуются Timeline'ом только для `user`/`compact` entry, но мы копируем строки для **всех** UUID JSONL. Лишние строки в БД безвредны (привязаны к существующим UUID); если в будущем заметки разрешим вешать на assistant — данные уже на месте.

**Связанные факты:**
- [`fact-timeline.md`](fact-timeline.md) — Fork & Plan Mode Markers (визуальные разделители)
- [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) — Section 3: Fork vs Bridge isolation
