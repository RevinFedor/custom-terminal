# Живой ответ в History до записи в JSONL

Пользовательский симптом этой подсистемы — во время ответа в History появляется
не ответ, а хвост `Read`/`Edit`, старый `Working`, user prompt или dim-thinking;
либо правильный временный текст остаётся после появления JSONL, исчезает и
возвращается поздним событием. Корень класса ошибок один: экранная строка,
структурное событие и долговечная запись отвечают на разные вопросы и не могут
подменять друг друга.

## Четыре слоя и один видимый владелец

1. PTY и main-side headless xterm воспроизводят экран TUI. Они авторитетны для
   composer, курсора, readiness, picker'ов, cell-style и диагностики кадра.
2. Структурный producer сообщает, какой смысл имел фрагмент до превращения в
   клетки терминала: assistant text, thinking, tool, activity или side request.
3. Временная проекция History показывает только ещё не материализованный
   assistant text с явной пометкой `Terminal output · not yet saved to JSONL`.
4. JSONL/rollout остаётся долговечной истиной. Его точная запись вытесняет
   только соответствующий временный item.

В один момент у History ровно один видимый live-writer. Нельзя одновременно
публиковать сетевой stream, semantic socket и распарсенный xterm как три
«возможные версии»: даже одинаковый текст при разном порядке событий даст
дубли и resurrection. Дополнительные каналы сначала работают как наблюдатели и
сравниваются с текущим владельцем.

## Текущие владельцы по провайдерам

| Провайдер | Видимый live-источник | Что остаётся за xterm | Durable truth |
|---|---|---|---|
| Codex | локальный semantic socket патченной CLI | input, readiness, picker, screen debug | rollout JSONL |
| Claude PTY | committed headless-xterm кадр, ограниченный hook-доказательствами tool-блоков | весь TUI и assistant prose до JSONL | Claude JSONL |
| Оба | Provider Proxy semantic shadow, пока только сравнение | transport не меняется | тот же JSONL/rollout |

Это не второй headless terminal. Semantic producer передаёт типизированные
события до экранной отрисовки, а headless xterm по-прежнему получает те же PTY-
байты, что единственный видимый terminal. Подмена headless большого размера
также не решает semantic-задачу: resize и scroll меняют перенос строк, но не
возвращают потерянное значение «это дочерняя строка Edit».

## Почему классификация хвоста экрана принципиально недостаточна

Tool-карточка может быть выше текущего viewport, а её многострочный diff/output
— остаться внизу. После resize корень `Read`/`Update` может находиться на десятки
логических строк выше видимого хвоста; обрезанный остаток выглядит как обычная
проза. Поэтому порядок «сначала обрезать экран, потом угадать тип по словам»
неисправим добавлением новых regex. Ownership должен появиться до clipping.

Экранный fallback всё равно обязан быть fail-closed. Полностью dim-фрагмент
непосредственно перед точным activity footer вроде `Doing…` считается
обрезанным thinking только когда в кадре нет доказанного answer-root. Обычная
проза с похожими словами сохраняется. Неизвестный marker, потерянный root или
sequence gap замораживают последнюю безопасную проекцию, а не разрешают
публиковать весь хвост «чтобы хоть что-то показать».

## Codex: semantic socket и точная materialization

Сборка Codex 0.147 отправляет в короткий локальный Unix socket ограниченный
NDJSON: `assistant_delta`, item/turn lifecycle и полный `item_completed`.
Assistant delta несёт сырой Markdown с `threadId`, `turnId`, `itemId`; полный
item закрывает sequence gap без повторного разбора TUI. Socket намеренно живёт
под коротким `/tmp/noted-codex-*`: обычный macOS temp path может превысить
лимит `sockaddr_un`, при котором Node listener уже создан, а Rust-клиент не
может к нему подключиться.

JSONL assistant-record несёт тот же Responses `itemId`. После exact match item
сразу исключается из preview-state; поздний `item_completed` становится
идемпотентной квитанцией и не может воскресить уже сохранённые несколько
абзацев. Exact-text fallback разрешён только legacy producer'у без `itemId` и
только после полного completed item — близость по времени или похожий текст не
являются identity.

Reconnect того же процесса не начинает новую semantic generation и не стирает
накопленный Markdown. Новый connection вытесняет старый, а поздний close старого
не замораживает replacement. Gap после reconnect остаётся закрытым до полного
item completion. Если установленная пара `codex` + `codex-code-mode-host` не
совпадает, приложение предпочитает рабочий stock Codex без semantic enrichment,
а не ломает инструменты ради preview; подробности запуска — `fact-codex.md`.

## Claude: hook ownership и headless prose

Интерактивный Claude binary не экспортирует raw Markdown той же PTY-сессии.
Режим `stream-json --include-partial-messages` относится к отдельному `--print`
процессу и не может наблюдать живой TUI. Поэтому до promotion сетевого канала
assistant prose берётся из committed headless-кадра.

Hook socket даёт точный ownership для `PreToolUse`, `PostToolUse` и
`PostToolUseFailure`. Между началом tool и exact JSONL `tool_result` его
экранные строки не допускаются в assistant preview, даже если заголовок и `⎿`
ушли выше viewport. Post hook доказывает завершение исполнения, но не превращает
оставшийся output в prose; освобождение делает canonical `tool_use_id`.

## Общий сетевой semantic shadow

Provider Proxy параллельно декодирует Anthropic SSE и Codex Responses
WebSocket/HTTP-SSE в один ограниченный event-shape. Для Claude право на main
text появляется только после exact `UserPromptSubmit`; продолжение после tool
принимается только по `tool_result`, чей `tool_use_id` выпустил предыдущий
main-response. Agent headers, structured `output_config.format`, prompt
suggestion и запрос без причинного владельца остаются subagent/side/unknown,
даже если имеют тот же session id и возвращают обычные `text_delta`.

Для Codex app-controlled вкладка получает per-tab `openai_base_url` только
после фактического старта proxy. Подписочный маршрут определяется штатным
`ChatGPT-Account-Id`, API-key остаётся на `api.openai.com/v1`. Native WebSocket
relay сохраняет text/binary тип кадров, selected response headers, close code и
reason; HTTP/SSE остаётся нормальным fallback. Принудительно переводить Codex
на HTTP ради более простого observer запрещено — это деградация транспорта.

Shadow не стоит на критическом пути: реальный response форвардится байт-в-байт,
ошибка parser'а даёт только `OBSERVER_ERROR`, а ошибка decompression отсоединяет
и дренирует tap. Незавершённый stream помечает свои items как gap и не может
засчитать parity даже при внешне полном `output_text.done`. Per-token путь не
перехеширует весь накопленный текст; item ограничен 256 KiB, полная
нормализация и hash выполняются на границе завершения.

Transport при этом остаётся настоящим двусторонним мостом, а не пассивной
копией. Закрытие Codex-клиента уничтожает соответствующий upstream HTTP request
даже пока тот ждёт свободный socket; response-header deadline освобождает
зависший slot, но после начала SSE не ограничивает длительность ответа.
WebSocket proxy проверяет upstream heartbeat отдельно от локальной половины и
при молчании закрывает её так, чтобы штатный HTTPS fallback получил чистый
pool. Шрам и точная диагностика — `fact-provider-proxy.md::Connection Pooling`.

Отдельная startup-ловушка: если production занимает первый proxy port,
проигравшая попытка listen не должна оставить `listening` callback. Иначе после
успешного fallback приложение может объявить одновременно чужой и свой порт и
дать новой вкладке адрес другого процесса. Каждая попытка владеет парой
`listening/error` и снимает оба listener'а до retry.

## Canonical replacement и геометрия

Canonical refresh не очищает весь live-хвост. Каждый item остаётся до своего
физического совпадения; уже materialized identity навсегда исключена из
проекции. Abort или новый prompt могут сбросить только незавершённый item своей
границы. Для Codex image-аудита provider envelope и `[Image #N]` — два carrier
одного slot, даже если между ними большой текст; они дедуплицируются по номеру,
а разные номера остаются разными вложениями.

Временная и сохранённая версии — одна запись с одной presentation-грамматикой.
При подтверждении снимается временная пометка/цвет, но не меняются композиция,
поля и scroll-якорь. Если пользователь у хвоста, рост preview продолжает
follow-bottom; если он прокрутил вверх, изменение высоты резервирует или
освобождает место снизу, не двигая читаемый фрагмент. Общий переносимый принцип
описан в `../methodology/переносимый-дизайн.md`.

## Диагностический incident

ПКМ по фиолетовому preview → `Save & copy diagnostic reference` атомарно
сохраняет ограниченный пакет и только после успешной записи копирует ссылку.
Пакет фиксирует именно увиденную renderer-версию, текущую main-проекцию,
последний committed/current headless frame, lifecycle/generation, кольцо PTY и
input/resize/flush transitions. Несовпадение между открытием меню и нажатием
записывается явно. Весь сырой PTY постоянно на диск не льётся.

Incident-файлы имеют `0600`, лежат в
`terminal-history-preview-diagnostics/`, ограничены 50 файлами и 14 днями.
Такой reference достаточен для расследования конкретного кадра без скриншота;
скриншот остаётся полезен только как независимое доказательство того, что видел
пользователь.

## Текущий этап и граница завершения

Network shadow физически подтверждён на Claude main→tool→main с отдельным side
request и на Codex native WebSocket→tool→final без transport fallback. Он также
совпал с текущим Codex socket и canonical JSONL, не став вторым History writer.
Повторяемый physical gate живёт в
`/Users/fedor/Desktop/electron-mcp/scenarios/23-provider-semantic-shadow.md`.

Этап не закрыт: видимый Claude preview всё ещё headless, Codex — semantic socket.
Proxy получает ownership только после расширенной матрицы compact, retry,
subagent, reconnect, gap и canonical replacement. До этого Codex patch не
удаляется, а сетевой канал остаётся read-only shadow.
