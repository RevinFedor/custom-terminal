# Мини-оркестратор завершённых ответов

Source-функция для PTY Codex/Claude: один встроенный Gemini reviewer на основную
вкладку, по умолчанию Off. Это не ещё один терминальный процесс, встроенный Codex
child или самостоятельная Terminal MCP-сессия. Он не меняет busy/Stop/Goal/FIFO.

```text
Active → точная завершённая итерация → закреплённый снимок
       → Gemini: инструкция + ссылка на итерацию
          → read_review_iteration (только этот снимок)
          → вывод в собственном чате
             обычный App: без обратной отправки
             private dev:mini: декларативный вердикт → приложение → прежний guarded Send
```

## Источник и ограничения

Codex использует уже разобранные записи current watcher после exact process/
terminal/generation/byte-boundary guards и прежний classified task_complete.
Несколько canonical final items собираются по порядку; commentary, дубликаты
carrier и прерванный/неподтверждённый ход не становятся завершённым ответом.
Claude получает исходный UserPromptSubmit и private admitted Stop result.
Нет нового JSONL reader, периодического History/Timeline read или PTY chunk
listener. Parent/child и writer identity не выводятся из имени или текста.

Первый managed Codex turn может прийти через source-proof-replay: реальный
writer уже подтверждён, но общая публикация ещё удерживается до конца scan.
Mini read-only capture принимает именно этот текущий bounded byte range, не
любой suppressed catch-up. Его ready явно false до прежнего release; после
release private flush передаёт пару один раз. Consume-once audit мог пройти
раньше: source→handoff берётся из существующего livePromptOwnersBySource,
а не повторного сравнения текста/нового receipt. Иначе терялся первый input
или оставался неснятый pending input. Shared busy/receipt/Run After не меняются.

Preferred response-only metadata фильтруется common classifiers primary History:
environment/project instructions/goal context не становится запросом reviewer.
Exact audited human quotation такой формы сохраняется. Main request/receipt и
исторический факт уже отправленных данных не переписываются ради внешнего вида.

Нужны захваченные при Active исходные inputs, а не восстановленная по догадке
старая задача: включение посреди неизвестного хода не запускает full History.
Неполная пара/превышение250k UTF16 для inputs или ответа даёт explicit unknown,
не усечённую «успешную» проверку. До16inputs, один текущий payload/inflight на
вкладку, bounded64-entry ledger. Попытка сохраняется до MCP effect; restart
сохраняет dedup/unknown, но не восстанавливает enabled/job/write guard.

Response/event carrier одного ввода объединяются по exact aliases существующего
общего pairer: поздний canonical UUID заменяет provisional ID в Mini, не создаёт
второй request. Равенство текста двух отдельных Send не является такой связью.
Иначе primary History уже показывает одну строку, а Gemini получает две.

Gemini сначала получает reference без исходных body, затем единственный
read_review_iteration возвращает захваченные request/answer и source IDs.
Аргументов выбора чужой сессии нет, полного History/MCP-чтения не выполняется.
Это материал проверки, не новый запрос reviewer. Workspace/tools graph не
сериализуется; отсутствие действий не доказывает их невыполнение. Качество
оценки не гарантируется инструкцией; честный отказ из-за стенда не равен багу
исходного агента.

Native task_complete подтверждает окончание ответа, не исполнение всех
обязательных пунктов поручения. Проверяющий не вправе сам назвать незавершённую
работу достаточным «текущим шагом»: если пользователь требовал результат либо
доказанный предел, нужны выполненные пункты или проверенное препятствие.
Само «ещё не установлено/не загружено» не является таким препятствием. Явное
пользовательское ограничение только просмотром/планом сохраняет приоритет.
Для архивной проверки брать настоящий исходный запрос и относящиеся уточнения,
не заменять их поздним узким вопросом или повторной генерацией на новых данных.
Это не разрешение читать всю History при каждом live review; неизвестный старый
контекст остаётся явным пределом оценки.

## Только чтение и отмена

Модель остаётся read-only: send_prompt/send_message,
редактирование и запуск других вкладок не предоставляются. Разрешён только
локальный read_review_iteration. Первая Gemini generateContent запрашивает
этот read, вторая получает functionResponse и возвращает текст; максимум2RPC,
одна общая failure deadline, без цикла. Полный model Content/thoughtSignature
сохраняется между ними без изменений. Unexpected tools/args и слепой вердикт
без чтения отклоняются. Legacy4-arg Gemini transport других функций прежний.

По новому прямому Fedor автоматический возврат для демонстрации включён только
в private `dev:mini`: Main требует одновременно E2E, prepared profile и отдельный
trusted env flag. Обычный App/default и generic E2E остаются без автокоррекций.
В этом режиме второй RPC — только декларативный finish_review с exact keys
verdict/explanation/correction, без адресата или исполнительных инструментов.
Формат включён в actual instruction text/revision, не дописан скрыто к wire.
Adapter ничего не отправляет: Core публикует критику, затем при needs_correction
использует прежний persisted attempt/owner fence/MCP sender/Main FIFO.
OK/UNKNOWN не отправляются; Off/новый ввод/смена owner отзывают старый job;
unknown ACK не разрешает повтор. По одному завершённому ответу максимум одна
новая отправка; неизменённый ответ/дословный feedback без прогресса не повторяются.
Новый ответ с новым существенным пробелом не отключается искусственным лимитом
на всю задачу. Прошлые замечания передаются только в той же root/owner цепочке.
Архив при открытии не получает enabled/job/write authority даже в этом режиме.
Реальная доставка в окне/MCP — отдельная ручная приёмка, не Node/fixture proof.

Новый input/Off/owner change отменяет старый job и повторно проверяется до read
и второй генерации. Обычные busy/Goal/Stop/FIFO/draft semantics не меняются.
Прежние accepted/queued/UNKNOWN коррекции исторического one-way режима нельзя
переписывать как неотправленные или replay ради перехода к read-only. Их старые
receipt/ledger guards сохранены, но текущая модель этот write tool не получает.

## UI, конфигурация и неактивный режим

Зелёный bot/count — отдельная строка под Play существующего Run After rail;
обычные субагенты не перемещаются. Переключатель в полосе History/Run After —
одна неизменная иконка робота без видимого On/Off: зелёный active, нейтральный
inactive, tooltip и aria-checked сохраняют понятность. Он рядом с count/Play; прежний checkbox
в «Настройках запросов» управляет тем же backend owner. Первый клик загружает
точное состояние и включает роль, открытие робота само по себе её не включает.
Popup в body portal, начальная привязка — правым краем к robot, вниз до500px.
Шапка перемещает окно; W/S/SW ручки сохраняют противоположные границы. Existing
usePointerGesture владеет cursor/cleanup; pointerdown снимает live DOM rect,
один rAF делает preview. Размер и положение по tabId сохраняются в SQLite через
прежний app-state, bounded60; renderer-memory — лишь быстрый слой. Чтение идёт
при открытии, запись — после законченного жеста, не на каждом pointermove.
Поздняя загрузка не перезаписывает новый жест; значения проверяются на read/write
и вписываются в текущий viewport. Pane hide закрывает portal, resize/layout
перемещают его, wheel не запускает geometry-read. Поверх него
остаются прежние History/Run After/MCP меню. Сообщения/инструкция рисуются общим
ConversationMessage/ComposerChip: один user bubble содержит только «Инструкция»
и «Итерация». Путь файла не добавляется в visible label; full resolved текст
инструкции открывается общим отдельным PastedContentPreview в portal. Размер
user bubble и composer при этом не меняется; Escape/outside сначала закрывают
только дочерний просмотр. Итерация вызывает прежний точный навигатор History
с записанным request UUID и SID, не с номером turn и не с текстовым fallback.
После автокоррекции переносимый root context не становится целью навигации:
используется точный request текущего хода. Неизвестная цель не заменяется соседней.
При успешном переходе Mini закрывается, чтобы не перекрыть найденное сообщение;
отмена позднего перехода не перехватывает навигацию пользователя. Нет точной
ссылки — явный отказ, без соседнего сообщения и без отдельного окна с копией
итерации. В основной ленте
белый assistant-текст принадлежит только Gemini. Raw disabled/notice не является
сообщением модели; текущий статус уже в navbar. Tool-card честно обозначает
read_review_iteration, не изображает Terminal MCP send. Clear не меняет
canonical History/ledger; у prepared archive удаляет и private saved presentation.

Каждый завершённый `complete()` открывает собственный `round` (монотонный
счётчик state), а не переписывает единственный набор entries: instruction/
request/answer/[tool]/review предыдущего раунда остаются видимыми рядом с новым,
bounded до последних `ROUND_LIMIT` (4) раундов в `src/main/mini-orchestrator.js`.
`roundSources` хранит `reviewSource` каждого раунда отдельно, чтобы чип
«Итерация» каждого блока вёл к request именно своего раунда. Рендерер группирует
entries через `miniEntriesByRound()` и рисует `MiniReviewInput`+
`HistoryTranscriptPresentation` на каждый раунд отдельно; preview инструкции
скоупится на конкретный раунд, не на единственный shared toggle. Явная кнопка
Clear по-прежнему обнуляет всю историю целиком, bounded-округление её не меняет.

Шапка Gemini model/thinking относится к будущим Mini-проверкам текущей вкладки.
SystemPrompt остаётся общей инструкцией/default; override хранится отдельным
app-state. Revision проверяет Main, reviewing/sending блокируют смену не только
в UI. Unknown save сохраняет RAM intent и требует явного save до генерации;
поздний metadata reply не откатывает новый выбор. Picker использует прежний
Gemini-каталог и LOW/MEDIUM/HIGH ([совместимость Google](https://ai.google.dev/gemini-api/docs/thinking/)).
Legacy NONE означает auto/omitted config, не выключенный thinking; новый picker
его не предлагает. Нет renderer API key или отдельного провайдерного launcher.

Запрос закрепляет выбранную пару до API-await. Review entry хранит requested
model, optional response modelVersion, requested thinking и wall interval.
Общий historyResponseTailLabel даёт `Worked / model / thinking`; следующий
выбор в шапке не меняет старый footer. Если modelVersion не получен, независимый
proof effective model/внутреннего thinking budget не выдумывается.

Режим и работа — разные сигналы: состояние кнопки передаёт цвет одной Bot-иконки, слева от
robot/count статичные часы при collecting, HTML-ring при reviewing/sending,
один icon при error/unknown. После успеха постоянного Done badge нет: ответ
остаётся в чате. Используются существующие pq-spinner/hidden animation pause,
не SVG rotation, новый timer или OR с busy основного агента. Runtime phase
поступает из одного controller; tagged state/capture логи содержат IDs, phase,
reason/offset/count, но не текст проверяемой пары.

Settings role ID `mini-orchestrator-review` — уже созданная custom-запись,
runtime читает её model/thinking/content/live filePaths по ID. В chip сохраняется
revision+hash фактической инструкции. Установка новой записи сама по себе роль
не исполняет; Source Main и renderer нужны вместе. Ключ — server-side общий
GEMINI_API_KEY Voice Record; DEV launcher удерживает его отдельной backend env,
не передаёт renderer/модели и не пишет в manifest. Общий Gemini REST transport
передаёт key header, не URL.

Off gate стоит до подготовки/копии reviewer payload; private completion filter
работает до detach. До первого открытия чата/settings нет per-retained-tab
Mini IPC/subscription. Тяжёлый transcript монтируется только в открытом popup;
geometry не читается на каждом scroll, токенового UI stream нет. Это описывает
границы кода, не измеренную нулевую стоимость или performance acceptance.

Ручной simple UI запуск: `npm run dev:mini -- --basic` — частный DEV-профиль, свободные порты,
подготовленная Codex/Luna вкладка без автоматического запроса. Его запускает и
проверяет Fedor; исполнитель не подменяет это отдельной production-копией или
самостоятельным GUI smoke. Default `dev:mini` может открывать подготовленные
реальные completed Codex exec/Gemini результаты в независимом профиле: это явно
помеченный headless archive, не current Main lifecycle/GUI acceptance. Он загружает
только presentation по явному Mini:get, никогда enabled/job/pendingSend/ledger
authority. Повтор не reseed/reset и не вызывает новые модели. Без verified copy
по-прежнему нет пустого fallback. Точные case IDs/пути/limits — только PLAN/DEV.
Human DEV использует regular Dock/Cmd+Tab; E2E isolation
сохраняется, но accessory/no-Dock presentation не включается. Автоподготовка
ждёт реальные load/context и restore events, не повторяет create после UNKNOWN.
Текущий handoff/результаты — `docs/tmp/мини-оркестратор-20261030/PLAN.md`.

## Один элемент управления в строке Run After

Робот был тремя сущностями: переключатель в шапке, чип «Рецензент» в
оркестрационном доке и popup, имитировавший чат. Ни шапка, ни чип не показывали
главного — какая вкладка проверяет; popup показывал это только после открытия.

```text
[▶][🤖▸Проверяющий][↻⟳│✎][+][⋯]
     ЛКМ   — вкл/выкл, имя вкладки сохраняется
     ПКМ   — выбор вкладки (общий RunAfterTabPicker)
     hover — карточка: вкладка / инструкция / итерация, каждая строка кликабельна
```

Робот живёт на border-mounted строке Run After, рядом с Loop: «пересылать каждый
завершённый ответ в такую-то вкладку» — такая же политика очереди, как Loop, а не
отдельная сущность. В шапке он прыгал, когда Run After раскрывался по наведению.

Прежний `▣ Post │✎` удалён: Loop занимает тот же слот политики. Сохранённые
`postPromptEnabled`/`postPromptText` намеренно больше не читаются — иначе старый
суффикс продолжал бы дописываться к каждому элементу очереди после исчезновения
переключателя. Единственная точка применения `withPostPrompt` оставлена функцией,
потому что семь её вызовов сравнивают identity payload между перезапусками.

Чип «Рецензент» следует жизненному циклу отправки, а не архиву: виден во время
доставки, несколько секунд после `sent`, и до ручного скрытия при `unknown`.
Прежде он читал последнюю `tool`-запись presentation-архива, который не
опустошается, поэтому одно старое «не подтверждено» оставалось на экране всю
сессию. Клик по чипу переключает popup (`toggle: true`), а не открывает его
повторно.

Строка Run After ограничена шириной панели: предок `data-history-composer-boundary`
имеет `overflow: hidden`, и выходящая за него часть строки физически обрезалась —
кнопка `⋯` оказывалась снаружи, а клики по её координатам получала рельса Timeline
(замер 03Nov: правый край строки 2565 против 2526 у обрезателя).

## Режим пересылки: робот как условие, проверяющий — обычная вкладка

Второй режим того же робота. Встроенный Gemini не участвует: робот становится
**условием** — выбирается вкладка-проверяющий, и каждый завершённый ответ
основной вкладки пересылается ей вместе с инструкцией. Проверяющий — обычная
полноценная вкладка со своей моделью; замечание он отправляет основной вкладке
сам через Terminal MCP, приложение за него ничего не решает.

```text
вкладка 1 (исполнитель)                вкладка 2 (проверяющий, своя модель)
  завершённый ответ
  → робот (условие) ──пересылка──→  инструкция + запрос + ответ
                                     читает код, выносит вердикт
       ожидает ввод  ←──send_prompt── только при существенном пробеле
  обычный Send в прежнем Main FIFO     положительный вердикт = молчание
```

Выбор проверяющего переиспользует существующий `RunAfterTabPicker`; новых
сущностей нет. Доставку выполняет прежний guarded send-путь контроллера:
`src/main/mini-orchestrator-forward.js` своей отправки не имеет и получает
`onSendPrompt` снаружи. В режиме пересылки шапка Gemini model/thinking скрыта —
модель принадлежит вкладке-проверяющему, не роботу.

Адресат пересылки отличается от проверяемой вкладки, поэтому guard принятой
отправки ищет владельца обзора по `handoffId` среди всех вкладок, а не только у
получателя: в прежнем Gemini-режиме отправитель и получатель были одной
вкладкой. Чужой `handoffId` по-прежнему отклоняется на любой вкладке.

Ответ завершённого хода берётся по Stop hook. Сам Stop-обработчик вызывает
`finishTurn()` **до** публикации завершения, поэтому к моменту слушателя turn из
реестра уже удалён: владелец определяется post-Stop резервным путём по
`bridgeKnownSessions` + последнему Stop-событию, а `claudeLastFinishedTurnId`
сохраняет turnId, иначе `sameOwner` читает `null` как смену владельца и ход
теряется молча.

Транспорт выбирается по владению хабом: обычное приложение отправляет через
общий MCP-хаб, изолированный инстанс (`canOwnGlobalHub === false`) — через
собственный Project API, не через хаб пользователя. Изолированной вкладке нужен
stdio-клиент `mcp/terminal-server.mjs` с `NOTED_DISCOVERY_DIR` своего профиля:
собственный HTTP-порт приложения отдаёт `/terminal/tabs`, а не JSON-RPC.

Проверено живьём на изолированном стенде (01Nov, исполнитель Sonnet,
проверяющий Opus): семь раундов в одном чате, подтверждённая доставка каждого
завершённого ответа, шесть обоснованных положительных вердиктов без отправки и
один возврат — проверяющий нашёл неполный список условий потери hold, сам сверил
`main.js` и вернул адресное замечание со строками `:3147`/`:3172`
(`observer-subscribe-failed`/`-error`, живой процесс) против `:3185`
(конец процесса). Замечание принято прежним Main FIFO как обычный Send.

Инструкция проверяющего — `~/Global-Templates/🧩 Code-Patterns/документация/
вкладка-проверяющий-ответов.prompt.md`: один `send_prompt` при существенном
пробеле, без `send_message`, делегаций, Stop/Resume/Rewind и правок чужих
сессий; положительный вердикт означает молчание, повтор по тем же данным
запрещён.

Headless replay на macOS не требует дополнительного outer sandbox-exec:
проверенный deny-read wrapper конфликтовал с native sandbox Codex и мешал
обычному shell. Native read-only при этом читает файлы, но может запрещать
process-info (`ps`/`top`). Read-only снимок, полученный контроллером и переданный
как timestamped данные, допустим; нельзя приписывать этот замер самой модели
или называть сумму RSS уникальной RAM/footprint. CLI-config developer_instructions
на Resume не следует считать видимым без proof: для own fixture явный operator
carrier/source mapping проверен отдельным nonce. Это условия эксперимента,
не новые требования исходного пользователя и не замена original AGENTS.
