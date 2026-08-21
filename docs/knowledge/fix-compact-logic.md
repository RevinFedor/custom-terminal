# Fix: Compact Logic & False Fork Detection

## 0.1 Compact summary не является вторым live user-message (2026-08-20)

Claude физически пишет compact как `compact_boundary`, затем user-запись с
`isCompactSummary:true`. Полный History объединяет их в одну compact-карточку,
но старый инкрементальный поток считал summary обычным user prompt и успевал
добавить вторую коричневую карточку. После remount она исчезала, потому что
durable parser уже классифицировал ту же запись правильно.

Main transcript service по-прежнему отдаёт summary сырому lifecycle-observer,
но не публикует её как `agent-transcript:live-message`. Единственный
presentation-owner — durable compact projection с точными UUID boundary и
summary; похожий текст и позиция рядом не используются.

## 0. Живая фаза `/compact` и вечный `SENT` (2026-07-31)

### Симптом

Во время ручного `/compact` History показывал только общий loader. После
завершения и возврата во вкладку возле старой команды мог оставаться `SENT`,
как будто сжатие всё ещё идёт.

### Точная причина

History одновременно видел две разные сущности:

1. сохранённую Claude-команду как специальную slash-строку;
2. временную локальную строку доставки как обычное сообщение со статусом
   `SENT`.

Общий механизм склейки временной и сохранённой строк принимает только обычные
user/queued-сообщения. Slash-строка намеренно в эту группу не входит. После
compact boundary старый carrier команды может уйти за границу активной ветки,
а временная строка продолжала жить в renderer store и volatile History cache.
При remount она проигрывалась снова. Иными словами, совпадение текста
`/compact` не было доказательством одной и той же записи, а точного отдельного
сигнала завершения для временной строки не существовало.

### Новый контракт

- Статус доставки сообщения и текущая операция сжатия — разные сущности.
- Живая фаза хранится только в main process как неперсистентная операция
  `compact/compacting`. Она не восстанавливается из History/JSONL.
- Старт разрешён только после принятия точной команды `/compact` владельцем
  текущей session/generation. Упоминание или цитата `/compact` не подходит.
- Claude стартует после доказанного Enter в PTY; завершает фазу только ручной
  `compact_boundary`, парный `isCompactSummary`, точный stdout результата либо
  причинное прерывание/ошибка того же владельца.
- Codex local slash-команда не обязана создавать rollout `user_message`.
  Поэтому ручной exact `/compact` сначала проходит общий xterm input-line
  tracker и отдельный PTY Enter boundary. Enter создаёт только невидимое
  ожидание с точными terminal/session/process/prompt generation, rollout EOF и
  event sequence: History ещё не получает `COMPACTING`, loader или `SENT`.
  Только первый post-boundary `task_started` того же владельца атомарно
  переводит ожидание в live `COMPACTING`; exact `user_message` ручного пути
  остаётся телеметрией, а не доказательством старта. Успех завершает только
  top-level `type:"compacted"`; `context_compacted` остаётся телеметрией.
  Внешний History submit сохраняет прежний `user_message` audit.
- History подписывается на live-событие и при каждом mount запрашивает snapshot.
  Поэтому переключение вкладок и renderer reload сохраняют реальную активную
  фазу. Новый main process имеет пустой registry, поэтому app restart не может
  воскресить старый `COMPACTING`.
- **Продуктовое решение принято 2026-08-17: slash-команды отправляются из
  History.** Прежний абзац требовал вводить `/compact` только в живой TUI, потому
  что разрешение «заодно» меняло контракт всех slash-команд. Пользователь принял
  это решение отдельно и явно («пускай можно будет отправлять команды слэш»),
  поэтому запрет и подсказка `← Terminal only` удалены. Само сообщение
  отображается как обычное user message; отсутствие видимого результата у
  локальной команды принято сознательно. Расписка об отправке для таких команд не
  создаётся (см. `fact-история-как-основная-поверхность.md`) — иначе она ждала бы
  запись `user_message`, которой у локальной команды нет.
- Ручной ввод в живом xterm остаётся полноценным путём и по-прежнему доказывается
  PTY Enter boundary. E2E, проверяющий compact lifecycle, должен использовать
  именно его: отправка из History доказывает доставку сообщения, а не переход
  фазы.
- После terminal outcome main отдаёт точный `handoffId`; History удаляет именно
  соответствующую временную строку. Небольшой count-bounded список завершённых
  операций существует только в памяти main, чтобы remount мог забрать
  пропущенный handoff; время не определяет исход операции.
- В Claude History принятый queue item с точным `/compact` переводится в обычную
  slash-строку при dequeue/remove/popAll. Boundary и `Compaction canceled` —
  fallback для версий Claude без отдельного queue transition. Поэтому
  историческая команда остаётся, но вечного `SENT` рядом больше нет.

### Инварианты

- Невидимое ожидание после ручного Enter не попадает в operational snapshot и
  не включает loader/`SENT`; подтверждённый `COMPACTING` показывается вместе с
  loader, но не блокирует уже существующий background History/composer flow.
- `SENT` не используется как признак активности compact и не скрывается
  глобально для обычных сообщений.
- Fixed timeout и polling не решают, закончился ли compact.
- Повторный compact имеет новый operation identity; старый владелец не может
  завершить новый по одному совпадению текста.
- Обычный prompt после compact не наследует фазу завершённой операции.
- Pending operation, зарегистрированная перед PTY paste, не считается чужим
  busy-сигналом для своей же exact identity. Write-boundary игнорирует только
  её `operationId`; все независимые busy-причины проверяются как раньше.

### Codex: причинная граница completion

Для Codex одной проверки `tabId + sessionId + process generation` недостаточно:
в текущем rollout могут находиться старые записи, скопированные до нового
запуска. Поэтому внешний submit сохраняет byte-offset точной
`event_msg.user_message` с текстом `/compact`, а ручной xterm-путь — EOF и event
sequence до Enter плюс точного владельца. Ручное ожидание сначала требует новый
`task_started`; любой outcome до него игнорируется. После старта transcript
outcome принимается только строго после EOF и при том же владельце. Старый
top-level `compacted` не завершает новую operation. Явные `error`, `turn_failed`
и `task_failed` для уже стартовавшей операции дают
`failed/compact-provider-error`; `context_compacted` остаётся telemetry.

#### Шрам: completion callback опережает provider marker (2026-07-31)

Независимый DEV E2E `/tmp/codex-manual-compact-e2e-e8jzyR/` записал одну
операцию в rollout в таком порядке: `task_started` на offset `81384`,
`compacted` на `81617`, `context_compacted` на `85872` и `task_complete` на
`85971` (event boundary ручного Enter — `56`). При этом main-log показал, что
generic lifecycle consumer мог обработать callback `task_complete` раньше
видимого для runtime provider-доказательства и закрыть operation как failed.

Теперь canonical rollout consumer сохраняет `compacted` как доказательство
этой конкретной operation по offset, откладывает generic `task_complete` до
catch-up границы собственного record и публикует terminal outcome один раз.
`compacted` с offset до manual source boundary, после `task_complete`, либо с
чужими session/generation не подходит. Таймеров и polling для решения исхода
нет; `context_compacted` по-прежнему только telemetry.

### Codex local slash: causal start без `user_message`

#### Exclusive EOF semantics (2026-07-31)

Manual Codex `/compact` stores the watcher/file EOF as an exclusive source
boundary: the first post-Enter `task_started` may start at exactly that byte
offset, but must have a strictly newer event sequence. Completion evidence
(`compacted`) remains strictly after the source boundary.

#### Шрам: первый Enter выбирает slash suggestion (2026-07-31)

DEV E2E `/tmp/codex-manual-compact-final-followup-20260731-151714/` отправил
`/compact` и Enter почти одновременно. Main принял exact-команду и сразу
показал `COMPACTING` на EOF `133304`, event sequence `30`, но rollout не получил
`task_started`: снимок `final-failed-compacting.png` доказал, что `/compact`
остался в composer, потому что Enter только выбрал slash-подсказку.

Физический Enter теперь означает лишь точное намерение. Оно хранится приватно
и переживает повторный Enter с исходными границами. Только новый
`task_started` (offset может быть равен старому EOF, sequence обязан быть
больше) создаёт одну видимую operation. Новое ручное содержимое, другая
отправка, Esc/Ctrl+C, Stop или смена terminal/session/process/prompt generation
удаляют ожидание без публичного terminal outcome. Таймер, polling и idle для
этого не используются.

Финальный независимый DEV E2E подтвердил новый контракт на настоящем Codex:
перед командой composer был доказанно пуст, source boundary составил EOF
`192537` / event sequence `58`, а следующий `task_started` того же владельца
пришёл с sequence `59` и только тогда включил одну видимую фазу `COMPACTING`.
Далее rollout записал top-level `compacted`, `context_compacted` и
`task_complete`; loader исчез и не воскрес после переключения вкладки. Обычная
фраза с упоминанием `/compact` осталась обычным prompt. Артефакты:
`/tmp/codex-compact-final-e2e-20260731/`.

В реальном Codex rollout local `/compact` выглядел как `task_started` →
top-level `compacted` → `event_msg.context_compacted`, без
`event_msg.user_message`. Поэтому ожидание `user_message` как единственного
start proof оставляло History без live loader. Исправленный путь использует
общий manual input-line tracker: он принимает только exact строку `/compact`,
учитывает редактирование/backspace/Ctrl+U/bracketed paste, игнорирует
terminal-response и сохраняет owner текущего terminal/session/process/prompt
generation. После отдельного Enter registry сохраняет только private pending
intent и текущие rollout EOF/event sequence. Только `task_started` после обеих
границ публикует `COMPACTING`. Старые события, другая generation, обычный
prompt и цитата не подходят; первый Enter, который лишь выбрал slash suggestion,
не даёт ложного loader и не теряет границу для второго Enter.

### Шрам: `/compact` после ручной `/model` или `/effort`

Один DEV E2E показал ситуацию, в которой Claude действительно выполнил compact,
но Noted Terminal не включил `COMPACTING`. Причин было две:

1. локальная строка ручного ввода переживала появление нового prompt и могла
   склеить предыдущую `/model` с новой `/compact`;
2. резервная проверка JSONL выполнялась один раз сразу после PTY-вывода. Если
   запись `/compact` ещё не успела попасть на диск, проверка видела предыдущий
   prompt и больше не возвращалась.

Строка ручного ввода теперь принадлежит точным terminal/session/launch/prompt
generation. Enter может подтвердить команду только в том же поколении. Ответы
терминального протокола не попадают в эту строку. Резервная проверка создаёт
одну точную попытку, подписывается на изменение соответствующего JSONL и
повторяется по файловому событию, пока не появится доказательство команды либо
та же попытка не будет отменена сменой владельца, обычным новым prompt,
автоматическим compact или Stop.

Важно: предварительный JSONL-снимок без `/compact` — это «запись ещё не
появилась», а не доказанный отказ. Для этого пути нельзя использовать polling,
фиксированную задержку или принимать любой последующий `/compact` из другой
сессии/генерации.

### Корректирующий DEV E2E 2026-07-31

Один корректирующий прогон использовал настоящий terminal-only путь: floating
xterm получил exact `/compact` через trusted `Input.insertText` и настоящий
Enter. Main зафиксировал точные tab/session/generation/operation identity,
History показал `COMPACTING` вместе с loader. Обычный prompt, который только
упоминал `/compact`, фазу не включил.

Успешное сжатие в этом fixture не состоялось: Claude TUI ответил
`Not enough messages to compact.` Большой seed содержал всего один
user/assistant-turn, поэтому provider не создал `compact_boundary` и summary.
Из-за этого post-completion tab switch/remount, удаление старого `SENT` и
Codex-subcase имеют честный verdict `PRECONDITION-NOT-MET`, а не PASS.

Прогон при этом доказал отдельный lifecycle-дефект. Ответ Claude был записан в
JSONL как точный `<local-command-stdout>`, но watcher до разбора отбрасывал все
новые строки без success-маркеров `compact_boundary`, `isCompactSummary` или
`Compacted`. Уже существующий classifier не видел отказ, и фаза оставалась
`COMPACTING` больше пяти минут вплоть до cleanup. Исправление убирает этот
преждевременный фильтр: все новые записи после доказанного Enter разбираются
существующим JSONL-классификатором, а exact provider rejection завершается как
`failed` с reason `compact-not-enough-messages`. Та же фраза в обычном assistant
text не является доказательством. Timeout и idle/polling источником истины не
стали.

Повторный DEV-прогон на Haiku подтвердил второй terminal outcome:
`<local-command-stderr>Error during compaction: …</local-command-stderr>`.
Это причинная служебная ошибка уже принятой `/compact`, поэтому она завершает
точную operation как `failed` с reason `compact-provider-error`. Похожая фраза
в обычном ответе и посторонний stderr другой local-команды доказательством не
являются. Так provider-ошибка гасит `COMPACTING` сразу, без таймера и без
догадки по idle.

Первый этап того же E2E также нашёл fresh-DB дефект: миграция колонки
`timeline_notes.position` выполнялась до создания таблицы и молча пропускалась,
а базовый `CREATE TABLE` колонки не содержал. Колонка добавлена в базовую схему;
отдельная Electron-ABI регрессия проверяет новую БД.

Артефакты корректирующего прогона:
`/tmp/compact-corrective-e2e-gXVmaU/`.

Финальный чистый DEV-прогон после всех исправлений получил `10/10 PASS`.
Вкладка Claude работала на Haiku 4.5, выполнила шесть обычных ходов, отдельную
ручную `/model haiku` и только после нового готового prompt — exact `/compact`.
Наблюдатель распознал новую команду напрямую на prompt `#18`, не смешав её с
предыдущей `/model`. History показал `COMPACTING` и loader одновременно с
реальным TUI compact. Тот же operation завершился настоящими
`compact_boundary`, summary и `Compacted`; после tab switch/remount временные
`SENT`, `QUEUED`, `COMPACTING` и loader не вернулись. Обычная фраза с текстом
`/compact` operation не создала. Артефакты финального прогона:
`/private/tmp/compact-final-e2e-artifacts-wbWStd/`.

## 1. Проблема: Ложный FORK после COMPACT (Claude)

### Симптомы
В ленте истории (HistoryPanel) сразу после разделителя `═══ COMPACTED ═══` появляется метка `🔵 FORK`, хотя пользователь не создавал новую ветку диалога.

### Причина (Invisible Intent)
После выполнения команды `/compact` (или автоматического сжатия), Claude Code часто сталкивается с **Context Overflow**. В этом случае он автоматически инициирует новую сессию (с новым `sessionId`), чтобы продолжить диалог. 
Стандартная логика приложения воспринимает любую смену `sessionId` без записи-мостика (`_isBridge`) как физический форк.

### Решение: Shield Logic
В алгоритм построения истории добавлен флаг `lastWasCompact`.
- Если смена `sessionId` происходит сразу после записи типа `compact_boundary`, создание метки `FORK` блокируется.
- **Мотивация:** Сжатие само по себе является достаточной визуальной границей. Наслоение меток перегружает интерфейс и вводит в заблуждение о структуре дерева сессий.

## 2. Логика Look-ahead для Claude Summary

### Особенность JSONL
Запись `type: "system", subtype: "compact_boundary"` в логах Claude содержит технические метаданные (токены), но **не содержит** текст самого саммари. Саммари записывается Claude как *следующее* сообщение пользователя с флагом `isCompactSummary: true`.

### Реализация
При формировании списка для HistoryPanel используется алгоритм "заглядывания вперед":
1. При обнаружении `compact_boundary` система сканирует следующие записи в `activeBranch`.
2. Ищется первая запись `type: "user"` с флагом `isCompactSummary`.
3. Текст из этой записи извлекается, очищается от системных напоминаний (`<system-reminder>`) и вставляется в поле `compactSummary` объекта сжатия.
4. Это позволяет рендерить компакт как раскрывающийся блок, сохраняя связь между техническим событием и его описанием.

## 3. Детекция Compact в Gemini CLI

### Внешний факт
Gemini CLI (в отличие от Claude) не создает явных системных записей о сжатии в JSON-файле сессии. Единственный след команды `/compact` — это сообщение `type: "info"` с **абсолютно пустым** `content`.

### Алгоритм детекции
Система идентифицирует сжатие Gemini по комбинации признаков:
1. Тип сообщения `info`.
2. Содержимое — пустая строка или `null`.
3. Сопоставление с `input tokens` следующего ответа (обычно наблюдается падение на 50-100к токенов).

**Важно:** Нельзя удалять или игнорировать пустые `info` записи при парсинге Gemini JSON, так как они являются единственными якорями для отображения границ сжатия в Timeline и истории.
