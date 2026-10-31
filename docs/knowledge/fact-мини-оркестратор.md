# Мини-оркестратор завершённых ответов

Source-функция для PTY Codex/Claude: один встроенный Gemini reviewer на основную
вкладку, по умолчанию Off. Это не ещё один терминальный процесс, встроенный Codex
child или самостоятельная Terminal MCP-сессия. Он не меняет busy/Stop/Goal/FIFO.

```text
Active → точная завершённая итерация → закреплённый снимок
       → Gemini: инструкция + ссылка на итерацию
          → read_review_iteration (только этот снимок)
          → вывод в собственном чате, без отправки/правок/вызова других вкладок
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

## Только чтение и отмена

По прямому уточнению Fedor текущая роль read-only: send_prompt/send_message,
редактирование и запуск других вкладок не предоставляются. Разрешён только
локальный read_review_iteration. Первая Gemini generateContent запрашивает
этот read, вторая получает functionResponse и возвращает текст; максимум2RPC,
одна общая failure deadline, без цикла. Полный model Content/thoughtSignature
сохраняется между ними без изменений. Unexpected tools/args и слепой вердикт
без чтения отклоняются. Legacy4-arg Gemini transport других функций прежний.

Новый input/Off/owner change отменяет старый job и повторно проверяется до read
и второй генерации. Обычные busy/Goal/Stop/FIFO/draft semantics не меняются.
Прежние accepted/queued/UNKNOWN коррекции исторического one-way режима нельзя
переписывать как неотправленные или replay ради перехода к read-only. Их старые
receipt/ledger guards сохранены, но текущая модель этот write tool не получает.

## UI, конфигурация и неактивный режим

Зелёный bot/count — отдельная строка под Play существующего Run After rail;
обычные субагенты не перемещаются. Видимый переключатель «🤖 Off/On»
находится в самой полосе History/Run After, рядом с count/Play; прежний checkbox
в «Настройках запросов» управляет тем же backend owner. Первый клик загружает
точное состояние и включает роль, открытие робота само по себе её не включает.
Popup в body portal, начальная привязка — правым краем к robot, вниз до500px.
Шапка перемещает окно; W/S/SW ручки сохраняют противоположные границы. Existing
usePointerGesture владеет cursor/cleanup; pointerdown снимает live DOM rect,
один rAF делает preview. Геометрия по tabId хранится между открытиями в bounded
renderer-memory60, не объявляется durable после restart. Pane hide закрывает portal, resize/layout
перемещают его, wheel не запускает geometry-read. Поверх него
остаются прежние History/Run After/MCP меню. Сообщения/инструкция рисуются общим
ConversationMessage/ComposerChip: один user bubble содержит только «Инструкция»
и «Итерация». Путь файла не добавляется в visible label; он вместе с full
resolved текстом/версией доступен в раскрытии. Итерация раскрывает точные SID/
turn/request IDs, исходный запрос/ответ и известные ограничения проверки;
preview использует общий HistoryTranscriptPresentation. В основной ленте
белый assistant-текст принадлежит только Gemini. Raw disabled/notice не является
сообщением модели; текущий статус уже в navbar. Tool-card честно обозначает
read_review_iteration, не изображает Terminal MCP send. Clear не меняет
canonical History/ledger; у prepared archive удаляет и private saved presentation.

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

Режим и работа — разные сигналы: кнопка содержит только Bot+On/Off, слева от
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

Headless replay на macOS не требует дополнительного outer sandbox-exec:
проверенный deny-read wrapper конфликтовал с native sandbox Codex и мешал
обычному shell. Native read-only при этом читает файлы, но может запрещать
process-info (`ps`/`top`). Read-only снимок, полученный контроллером и переданный
как timestamped данные, допустим; нельзя приписывать этот замер самой модели
или называть сумму RSS уникальной RAM/footprint. CLI-config developer_instructions
на Resume не следует считать видимым без proof: для own fixture явный operator
carrier/source mapping проверен отдельным nonce. Это условия эксперимента,
не новые требования исходного пользователя и не замена original AGENTS.
