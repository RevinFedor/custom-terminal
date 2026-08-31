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
публиковать сетевой stream и распарсенный xterm как две
«возможные версии»: даже одинаковый текст при разном порядке событий даст
дубли и resurrection. Дополнительные каналы сначала работают как наблюдатели и
сравниваются с текущим владельцем.

## Текущие владельцы по провайдерам

| Провайдер | Видимый live-источник | Что остаётся за xterm | Durable truth |
|---|---|---|---|
| Codex | Provider Proxy: точный main Responses stream | input, readiness, picker, screen debug | rollout JSONL |
| Claude PTY | committed headless-xterm кадр, ограниченный hook-доказательствами tool-блоков | весь TUI и assistant prose до JSONL | Claude JSONL |
| Claude | Provider Proxy semantic shadow, пока только сравнение | transport не меняется | Claude JSONL |

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

## Codex: provider stream и точная materialization

Codex получает Responses stream через per-tab маршрут Provider Proxy. Прокси
копирует только уже декодированные main-события в History: `assistant_delta`,
item/turn lifecycle и полный `item_completed`. Assistant delta несёт сырой
Markdown с `threadId`, `turnId`, `itemId`; полный item закрывает неполную
дельту без повторного разбора TUI. `turnId` является только транспортной
корреляцией, а не правом рисовать ответ: main-запрос дополнительно требует
живой причинный prompt/turn/startup той же вкладки и не может противоречить уже
принятой writer-session. Prewarm, subagent, запрос без такого владельца и
запрос с чужой session остаются наблюдаемыми, но никогда не становятся видимым
ответом.

Владелец stream привязан к точному Codex launch. Поздний ответ старого процесса
на том же tab route отбрасывается. HTTP tool-продолжения одного launch сохраняют
предыдущие завершённые блоки, а оборванный request удаляет только собственный
незавершённый текст перед retry. Это не позволяет старому transport-close
стереть или продублировать соседний main-блок.

JSONL assistant-record несёт тот же Responses `itemId`. После exact match item
сразу исключается из preview-state; поздний `item_completed` становится
идемпотентной квитанцией и не может воскресить уже сохранённые несколько
абзацев. Exact-text fallback разрешён только legacy producer'у без `itemId` и
только после полного completed item — близость по времени или похожий текст не
являются identity.

WebSocket и HTTP fallback питают одного launch-владельца. Ошибка transport не
разрешает xterm угадывать прозу: незавершённый request снимается, а следующий
точный provider request продолжает тот же ход. Приложение запускает актуальный
пользовательский Codex; отдельной патченной сборки для preview больше нет.

### Codex 0.151: Conversation recap после compact

После физически завершённого `/compact` Codex может отдельным TUI-запросом
сгенерировать короткий `Conversation recap`. Это человекочитаемое резюме для
нативного terminal UI, а не новый пользовательский turn и не контекст, которым
продолжается агент: durable continuation принадлежит opaque/encrypted
compaction item. Поэтому proxy по-прежнему форвардит recap в Codex без
изменений, но semantic observer классифицирует запрос без причинного turn как
side traffic. Raw `{"recap": ...}` не получает `Working`, live History row или
право ждать rollout `task_complete`, которого у TUI-only запроса нет.
Поэтому History сейчас намеренно не рисует отдельный recap в конце: в
проверенных canonical rollout `/compact` оставляет только один encrypted
compact-marker, а текста recap там нет. Если будущий протокол добавит отдельный
durable recap-carrier, он может стать одним обновляемым хвостовым элементом по
точной source identity; TUI/Provider preview и обычный same-turn assistant после
auto-compact таким carrier не являются.

Связанный шрам: Run after/programmatic `/compact` раньше видел ordered
`compacted → context_compacted → task_complete`, но generic callback завершал
операцию как failed, потому что canonical catch-up был разрешён только
`manual-xterm-enter`. Causal byte/session/generation proof теперь одинаков для
всех принятых compact-source; preceding `compacted` выигрывает независимо от
того, кто физически инициировал slash-команду.

Production `tab-4410` показал обратную сторону: первый Enter в Codex 0.151 лишь
выбрал `/compact` из autocomplete, поэтому ни `task_started`, ни active compact
не появились, а более поздний независимый recap ошибочно выглядел продолжением
этой отправки. Незапущенный pending intent не является provider turn. PTY-flow
теперь либо получает causal `task_started` после первого Enter, либо доказывает
тот же `/compact` в новом committed headless-кадре и допускает один второй
Enter. Без старта результат остаётся `delivery-unknown`; raw recap не получает
его `Working`/`SENT` ownership.

### Шрам 29.08.2026: canonical receipt был ошибочно связан с public live-row

Production `tab-754` сохранил точный assistant `response_item`, затем продолжил
тот же turn через tool call и новый Provider Proxy request, но фиолетовый live-
ответ остался со статусом «ещё не сохранён». Rollout reader намеренно подавлял
публичные live rows, пока Resume-source ждал writer adoption; вместе с ними он
случайно подавил и внутреннюю exact-item квитанцию для preview. Даже при доставке
controller считал provider session `f9edf20d` durable owner и отвергал бы
rollout owner `b6de8a1a` как session mismatch.

Контракт теперь разделён. Transcript service передаёт main точную физическую
границу Codex-record независимо от публичного live-row; main допускает её только
при совпадении tab, terminal, run, lifecycle, launch, watcher file/session и
post-launch byte boundary. Provider thread/session остаётся диагностикой и не
заполняет durable `sessionId`. Exact rollout `itemId` снимает только свой
provisional item; следующий reasoning/tool boundary того же turn оставляет
turn-level activity активной. `RESPONSE_END` закрывает лишь один сетевой сегмент,
а loader снимают только rollout `task_complete`/`turn_aborted` или завершение
самого process lifecycle.

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

## Общий сетевой semantic stream

Provider Proxy параллельно декодирует Anthropic SSE и Codex Responses
WebSocket/HTTP-SSE в один ограниченный event-shape. Для Codex этот shape уже
является видимым live-владельцем; для Claude он остаётся shadow. Право Claude на main
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

Observer не стоит на критическом пути: реальный response форвардится байт-в-байт,
ошибка parser'а даёт только `OBSERVER_ERROR`, а ошибка decompression отсоединяет
и дренирует tap. Незавершённый stream помечает свои items как gap и не может
засчитать parity даже при внешне полном `output_text.done`. Per-token путь не
перехеширует весь накопленный текст; item ограничен 256 KiB, полная
нормализация и hash выполняются на границе завершения.

Transport при этом остаётся настоящим двусторонним мостом, а не пассивной
копией. Закрытие Codex-клиента уничтожает соответствующий upstream HTTP request
даже пока тот ждёт свободный socket; модельный `/responses` не имеет локального
deadline и ждёт сервер до отмены самим Codex. Metadata-запросы остаются bounded.
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

Временная и сохранённая версии — одна смысловая запись с одной presentation-
грамматикой, но физически они приходят через разные места Virtuoso: растущий
preview живёт в O(1)-Footer, canonical answer — обычная строка data-list.
Поэтому «main уже распарсил JSONL» не является разрешением удалить preview:
длинный Footer исчезал за 283–804мс до монтажа replacement-row, и пользователь
видел пустую History либо терял позицию внутри ответа.

Canonical-clear несёт exact physical source identity, но proof различается по
режиму чтения. Mid-list reader ждёт exact mounted durable-row, фиксирует её
row-top и двумя layout-commit'ами до paint заменяет Footer под тем же semantic
anchor. У tail-reader требование mounted DOM замыкало ожидание: высокий Footer
сам вытеснял будущую durable-row из overscan. Поэтому exact canonical proof
сразу заменяет Footer той же live-row в общем presentation-списке; live-row
скрывается только когда durable-проекция той же physical identity реально
представлена. Никакого промежуточного дубля или пустоты нет.

Canonical proof, пришедший в hidden pane, сохраняется под owner/generation и
будится новым presented visit; случайный `rangeChanged`/scroll не является
механизмом завершения handoff. Жест пользователя во время ожидания обновляет
якорь и выигрывает у старой геометрии. Искусственного tail reserve нет:
середина сохраняется semantic anchor'ом, хвост — живым bottom-gap. Общий
переносимый принцип описан в `../methodology/переносимый-дизайн.md`.

Шрам Claude tail-reader: main уже опубликовал exact canonical assistant UUID и
`clear`, durable строка физически была видна, но Footer оставался ниже с
`Live response · synchronizing view`. Handoff всё ещё требовал производный
`canonicalTarget` из карты сгруппированных Virtuoso-units; эта карта не является
новым proof и может догнать финальный presentation array позже. Для читателя в
середине row-map/DOM всё ещё нужны ради сохранения row-top. Для читателя на
хвосте owner — нулевой bottom-gap: как только exact identity присутствует в
финальном display-массиве, Footer снимается в том же layout commit без ожидания
unit-map/DOM, а один bounded tail-pin удерживает физический низ. Равный текст,
другая identity или только main-clear без canonical display этого права не дают.

Завершение видимого ответа не ждёт полного перечитывания History. После exact
canonical presentation и `task_complete` тяжёлая сверка durable snapshot всё
ещё нужна для cache, suppressions и локальных handoff, но её применение может
намеренно ждать фонового priority-slot во время scroll/input. Production
`tab-2532` показал ожидание 21,9 секунды: ответ и composer уже были финальными,
а общий статус ошибочно показывал `Updating`, пока low-priority refresh не
получил слот. Settled/command-finished refresh теперь идёт без видимого статуса
и одновременно отменяет более старую плашку этого же refresh-поколения. Если
canonical replacement ещё не представлен, собственный live-preview остаётся
видимым доказательством синхронизации; фоновая cache-сверка не создаёт второй
loader и не меняет lifecycle терминала.

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

Network stream физически подтверждён на Claude main→tool→main с отдельным side
request и на Codex native WebSocket→tool→final без transport fallback. Codex
provider items совпали с canonical JSONL и теперь являются единственным live
History writer до materialization.
Повторяемый physical gate живёт в
`/Users/fedor/Desktop/electron-mcp/scenarios/23-provider-semantic-shadow.md`.

В source Codex переведён на Provider Proxy: side-channel patch и приватный
version-pinned binary удалены, retry очищает только request-owned provisional
items, а launch identity блокирует stale write. Unit-цепочка
provider→preview→exact rollout replacement закрыта; перед production install
остаётся физический dev-прогон штатного Codex. Для Claude этап не закрыт:
видимый preview всё ещё headless, а proxy остаётся read-only shadow до
собственной полной матрицы.
