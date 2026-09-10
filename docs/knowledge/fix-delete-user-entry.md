# Fix: Delete single user-prompt from JSONL (keep assistant response)

### Симптомы
- Длинная сессия Claude, юзер видит свой громоздкий пробный промпт между парой ответов Claude и хочет вырезать его, оставив ответы — копировать всю историю целиком потом дорого по токенам.
- `Edit Range` неудобен потому что вставляет compact-entry на месте, делает розовую точку и требует Gemini-проход; для одного промпта это пушкой по воробьям.
- `Delete Range` стирает заодно весь ответ Claude — не то что нужно.

### Жест и UI
ПКМ по точке user-prompt → левая основная зона split-кнопки `Удалить запрос` (красная, иконка Trash2) в той же группе что Copy/Note/Rewind. Подтверждение остаётся в том же popup и явно говорит, что ответ Claude сохранится. Правая зона `ArrowUpToLine` — другая операция: удаляет весь диапазон от начала до выбранной точки через `claude:delete-range`. Разделение сохраняет узкую capability этой записи и не маскирует более широкий destructive scope тем же лейблом. См. `methodology/дизайн-принципы.md::Two-step inline confirm для destructive в context menu`.

Пункт скрыт для:
- Gemini табов (JSON-формат, отдельный пайплайн)
- `compact` / `continued` entries (там нет одного «user-prompt» — есть system или bridge)
- `isCompactSummary` user-entries (это автоматический результат `/compact`, не promtp юзера)

### IPC: `claude:delete-user-entry`
`{ sessionId, cwd, uuid }` → `{ success, relinkedChildren, newParent }` либо `{ success: false, error }`.

Контракт:
1. Находит JSONL через `findSessionFile(sessionId, cwd)`.
2. Читает целиком, парсит в `allRecords` + `recordMap`.
3. Валидирует целевую запись:
   - `type === 'user'` (иначе `Not a user entry`).
   - `message.content` НЕ `tool_result` и НЕ начинается с `<command-name>` / `<system-reminder>` / `<task-notification>` / `<bash-notification>` / `<local-command-stdout>` / `<local-command-caveat>` / `Caveat: The messages below` (иначе `Entry is a tool result or system wrapper, not a user prompt`).
   - Не `isCompactSummary` (иначе `Cannot delete compact summary`).
   - Есть `parentUuid` (иначе `Cannot delete the first message of a session` — корень нельзя, иначе у его детей parentUuid станет `null` и Claude `--resume` откажется грузить файл).
4. Линкует детей: проходит по всем `allRecords`, любая запись с `parentUuid === uuid` получает `parentUuid = target.parentUuid`. Симметрично — `logicalParentUuid` (используется в `compact_boundary`).
5. Atomic write: tmp-файл → rename, инвалидация `_jsonlCache`.
6. Чистит `timeline_notes` по deleted uuid — заметку прикрепить больше не к чему.

### Почему физическое удаление безопасно (в отличие от старых сценариев)
Внутри одного turn-а структура такая:
```
user(u_N) → assistant(a_N1) → assistant(a_N2) → tool_use → user(tool_result) → ... → user(u_{N+1})
```
Удаление одного `user(u_N)` затрагивает только запись, чей parentUuid === `u_N.uuid` — это первый assistant следующего turn-а если предыдущий ответ закончен (а это гарантировано: юзер удаляет turn руками, не в момент стриминга). Relink направляет первого ребёнка на `u_N.parentUuid` — то есть на последний assistant предыдущего turn-а. Получается chain: `assistant(пред. turn) → assistant(текущ. turn) → ...`. Два ответа Claude подряд без user-prompt — валидная конструкция для `--resume`, Claude грузит контекст линейно по parentUuid.

### Что НЕ делает (сознательно)
- Не вызывает forward-expand (как `Edit Range`/`Delete Range`) — удаляется ровно одна запись, ответы Claude сохраняются.
- Не пишет в `session_links`, не трогает rewind markers, не вставляет compact-entry.
- Не отображает «удалённый» tombstone-маркер на Timeline. После refresh точка просто исчезнет (необратимо, как и заявлено в UI).
- Не реализует undo. Юзер прошёл двухшаговый inline-confirm — этого достаточно.

### Edge cases
- **Несколько детей у целевой записи** (Escape + повторный ввод создаёт side-chain): все записи у которых parentUuid указывал на удалённую — перелинковываются на одного и того же нового родителя. Если потом юзер вызовет `--resume` — Claude построит DAG и выберет newest leaf по timestamp; в подавляющем большинстве случаев это последний реальный ответ active branch, мёртвая ветка отвалится. Дополнительной orphan-cleanup'а **не** делаем — для одной записи cascade-ловушка от `Edit Range` тут не применима.
- **Attachments в удалённом запросе**: если в `message.content` были image-блоки на которые ссылается следующий assistant tool_use — после удаления при `--resume` ссылки указывают в пустоту. Не блокируем — это compromise за простоту жеста.
- **Запрос внутри auto-compact-segment**: технически удаление сработает (compact summary останется), но при следующем `/compact`-проходе Claude посчитает summary без удалённого вопроса. Это ожидаемо — юзер сам выбрал удалить.

### Связанная документация
- [`fact-timeline.md`](fact-timeline.md) — общая структура Timeline и context menu.
- [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) — parentUuid chain и почему root удалять нельзя.
- [`fix-copy-range-forward-expand.md`](fix-copy-range-forward-expand.md) — синтетические user-wrapper'ы, тот же набор фильтруется здесь.
- [`fact-clipboard-tools.md`](fact-clipboard-tools.md) — `Delete Range` (отдельный путь, удаляет весь range целиком).
