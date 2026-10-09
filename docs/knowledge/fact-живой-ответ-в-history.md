# Живой ответ в History до записи в JSONL

Пользовательский симптом этой подсистемы — во время ответа в History появляется
не ответ, а хвост `Read`/`Edit`, старый `Working`, user prompt или dim-thinking;
либо правильный временный текст остаётся после появления JSONL, исчезает и
возвращается поздним событием. Корень класса ошибок один: экранная строка,
структурное событие и долговечная запись отвечают на разные вопросы и не могут
подменять друг друга.

## Шрам05.09: сохранённая Claude-реплика не убирала synchronizing preview

Финальный H1 на Claude2.1.261 воспроизвёл дубль: commentary уже присутствует в
History, после него есть настоящий Bash и финальный ответ, busy=false/Stop,
но Footer продолжает показывать старое commentary как `Live response ·
synchronizing view`. В main произошло правильное `canonical-materialized`;
потерялся не ответ, а совпадение идентичности на границе renderer.

Main передал сырой JSONL UUID `a48cac1c-5f58-4d3b-b502-20559ef7ef2d`.
History представляла тот же record как `assistant-uuid:<UUID>` и сравнивала
строки буквально. Handoff навсегда оставался waiting-canonical даже при
видимой canonical row. Новый `historyTerminalPreviewHasCanonicalIdentity`
в одном месте принимает обе точные формы assistant identity и существующие
opaque/source aliases. Этот matcher используется для поиска replacement,
group membership, проверки durable presentation и удаления его live-дубля.
Глобальные row keys/merge алгоритм и публичный main payload не меняются.
Равный текст, чужой UUID и user UUID не являются заменой assistant identity.

Ни TTL, ни «очистить при любом Stop» не добавлены. Прежние owner/generation/
presentation-visit, collapsed-group, virtualized range и scroll-anchor guards
остались. Red regression до изменения не находила exact UUID; после — проходит.
Финальный физический retake: clear-pending17:27:12.937UTC → handoff-done12.966,
Stop17:27:16.148; final DOM previewcount0, runningtail0, точный финальный ответ
и настоящий Bash row. Артефакты `h1-retake-executor.Jj3CsD` в evidence root
`/private/tmp/noted-control-20260905.NgdE2L`. Правка установлена в
`timtop72040a70be57` (05.09.2026,21:10:48 MSK). Фактический ASAR содержит
App-CrMYhyA7.js с проверенным SHA d6d4e40f…16b8f71;19 source/compiled hashes
и подпись совпали. Та же root-сессия вернулась автоматически: один Resume join,
5/5 AutoResume без ошибок и один подтверждённый callback. Полное доказательство:
`final-history-install-return-verified.json` в том же evidence root.

## Четыре слоя и один видимый владелец

1. PTY и main-side headless xterm воспроизводят экран TUI. Они авторитетны для
   composer, курсора, readiness, picker'ов, cell-style и диагностики кадра.
2. Структурный producer сообщает, какой смысл имел фрагмент до превращения в
   клетки терминала: assistant text, thinking, tool, activity или side request.
3. Временная проекция History показывает только ещё не материализованный
   assistant text: растущий item помечен `Live response · not yet saved to history`,
   завершённый без receipt — `Response · history not confirmed`; после canonical
   proof до замены представления — `Response · synchronizing view`. Завершение
   одного ответа и продолжающийся tool-turn могут существовать одновременно.
4. JSONL/rollout остаётся долговечной истиной. Его точная запись вытесняет
   только соответствующий временный item.

В один момент у History ровно один видимый live-writer. Нельзя одновременно
публиковать сетевой stream и распарсенный xterm как две
«возможные версии»: даже одинаковый текст при разном порядке событий даст
дубли и resurrection. Дополнительные каналы сначала работают как наблюдатели и
сравниваются с текущим владельцем.

## Текущие владельцы по провайдерам

Codex `thread_settings_applied` — уже сохранённое подтверждение пары, не
пользовательский prompt. Его короткая проекция теперь приходит от существующего
main turn watcher сразу как `history_entry/role:slash` в Desktop IPC и SSE,
без ожидания full History refresh и без нового чтения rollout. Full parser и
live используют один formatter; `sourceIdentity` содержит physical session,
kind model/effort и byte offset. Канонический UUID остаётся прежним line-based,
а React key — source-based, поэтому adoption не пересоздаёт строку.
Если первым показался alias более ранней canonical строки, клиент удерживает
выбранный display key и после удаления live-копии, до смены History owner/rewrite
generation. Иначе сам adoption пройдёт, но следующий кадр снова remount'ит row.

30.09 tab4505: main получил настоящие settings records примерно через155мс
после окончания picker (сама append-пачка читалась221мс), однако History не
имела этого live-пути. Отдельная
предположительная строка по requested model/ACK здесь не нужна: готовая запись
уже доступна. Если записи ещё нет, отсутствие не превращается в mismatch.
Malformed/incomplete pair, чужая session и suppressed historical catch-up не
публикуют такое подтверждение; живые settings/loader/Send authority не меняются.

Codex повторяет полную пару при изменении одного поля. `settingsFact`
(`version:1,provider:codex,kind,value,source`) сохраняется и в offscreen stubs.
Проекция показывает только изменившееся значение, как full parser; повторный
record неизменного поля получает exact source alias прежней строки. Это
сверка структурного состояния, не дедупликация prompt по тексту. После rollback
display baseline перечитывается по оставшимся строкам, а live baseline сбрасывается:
нельзя прикрепить новый record к уже удалённой модели. При конфликте value у
ОДНОЙ physical identity History оставляет `History mismatch` рядом со строкой;
поздняя другая смена модели не конфликтует, ввод и settings executor не блокируются.

В ограниченном HTTP/native окне preceding settings могут лежать далеко выше
tail80. Canonical `settingsBaseline` v1 даёт максимум два facts перед окном из
того же row/stub index и связывает их с read SID/revision/generation. Клиент
редуцирует окно поверх них, не берёт params как History truth и не публикует
unknown startup pair до baseline. Around не заменяет latest live состояние;
unchanged удерживает прежний bound baseline. Physical rollback публикует
`history_settings_reset`, rewrite/read-owner/stream gap снимают его право на
показ. A→B→A и exact alias adoption сохранены. Wire —
`fact-mobile-web.md::Canonical settings baseline для ограниченного окна`.

Та же граница была пропущена у `Conversation interrupted`: main watcher уже
прочитал `turn_aborted` и снял busy, но передавал только turn_boundary; строка
ждала полного History refresh. Source04.10 сразу публикует в desktop IPC и SSE
`history_entry/role:interrupted` тем же formatter, что canonical parser, с exact
physical SID/byte offset. Нажатие Escape, transport ACK, idle и timeout такого
права не дают; historical catch-up suppression остаётся. Если provider ещё не
записал abort, приложение не выдумывает его по клавише, которая может открыть Rewind.
Canonical row иногда выбирает более ранний reserved user carrier: event offset
остаётся exact alias. Display key переживает эту adoption и offscreen stub, поэтому
не возникает remove/reinsert или второго interrupted. Другая session/новый prompt
не схлопываются по одинаковому тексту. Lifecycle, outcome и notification eligibility
этот display-путь не меняет; native получает тот же additive service envelope.

Локальные Claude `/model` и `/effort` не создают сетевой AI-turn. Их уже
записанные JSONL carriers приходят по существующему Transcript Service и сразу
показываются в History служебными строками, включая `isMeta` записи. Это тот же
UUID и тот же общий formatter, что у полного parser; поздний canonical apply
заменяет строку по identity без дубля. Метка `local-setting` отделяет их от
пользовательского prompt: они не получают handoff ownership, не создают новую
Timeline-итерацию и не снимают Rewind draft.

Причина выделения этого пути — Run after 12.09: model/effort уже выполнены,
следующий prompt отправлен, а полный History refresh ещё20с ждал input quiet.
Приоритет тяжёлого refresh не ослабляется и очередь не ждёт UI paint: две
готовые короткие записи не зависят от обновления всего списка. Эти строки
показывают записанные команды; авторитетное подтверждение их выполнения
по-прежнему принадлежит main local-command proof, не факту появления строки.

Шрам13.09: после compact и одной пары настроек History показывала всё больше
`/model`/`/effort` и дёргалась при скролле. Команды не повторялись: API и журнал
отправки подтверждали по одной физической записи. В новой live-ветке `slash`
не имела identity для сопоставления с полной History: UUID попадал в React key,
но не участвовал в удалении live-копии. Два одинаковых ключа затем оставляли
лишние DOM-строки при изменении отрисовываемого диапазона. В отдельном Electron
шесть прокруток превратили одну пару в восемь копий и увели от низа на355px.

Сопоставление служебной строки теперь учитывает её session+UUID до передачи
общего списка Virtuoso; commit удаляет раннюю копию по той же identity. Текст
не является ключом: повторная настоящая команда с новым UUID остаётся отдельной.
Запись другой сессии и обычный user с похожим текстом не подходят. Диагностика
`LIVE_SETTINGS_ADOPT` фиксирует удалённые ранние UUID и оставшееся число команд.
Нельзя чинить этот симптом очисткой JSONL, задержкой показа команд или новым
scroll writer: источник цел, нарушена связь двух представлений одной записи.
Повторяемый UI-прогон — `scripts/history-live-settings-regression.mjs`.

Тот же контракт распространяется на `provider-error` и `usage-limit`.23.09
у Inbox171 одна сохранённая `Connection lost mid-response` с UUIDefe79a0e
оставалась одновременно в live-хвосте: роль уже стала служебной, поэтому
assistant-identity её не покрывала. Два одинаковых React key давали лишние
строки при прокрутке. Обе error-роли теперь сопоставляются по role+session+UUID
и удаляются из live только при commit сохранённой версии. Другой UUID означает
отдельную настоящую ошибку, даже при одинаковом тексте; обычная цитата ошибки
остаётся assistant-ответом. Codex сохраняет свою source identity. Это ремонт
отображения ошибки, а не её сетевой причины. Проверки: настоящий full parser
в `claude-provider-failure.integration.test.js`, reducer regressions и
изолированный React/Virtuoso `scripts/history-live-error-adoption-regression.mjs`.

| Провайдер | Видимый live-источник | Что остаётся за xterm | Durable truth |
|---|---|---|---|
| Codex | Provider Proxy: точный main Responses stream | input, readiness, picker, screen debug | rollout JSONL |
| Claude PTY | Provider Proxy: hook-owned main Anthropic SSE | input, readiness, picker, screen debug | Claude JSONL |

Таблица описывает source после08.09.2026; physical dev подтверждён, установка
этой ревизии в рамках работы не выполнялась. SDK-вкладки имеют отдельный runtime.

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
разрешает xterm угадывать прозу: открытый partial item снимается, завершённый
неподтверждённый item сохраняется, а следующий точный provider request продолжает
тот же ход. Приложение запускает актуальный
пользовательский Codex; отдельной патченной сборки для preview больше нет.

Шрам 03.09.2026: эти два транспорта несут одну identity в разных оболочках.
WebSocket кладёт `x-codex-turn-metadata` в `response.create.client_metadata`,
а HTTPS fallback проецирует тот же JSON в HTTP-заголовок и вправе не повторять
его в body. Observer обязан объединять обе формы; иначе terminal продолжает
рисовать SSE постепенно, а History получает только цельную финальную JSONL-
запись. Известный per-tab Codex `/responses` подключает наблюдатель к копии
потока независимо от декларации `Content-Type`: production endpoint уже
возвращал читаемый Codex-ом SSE через ветку, которую proxy ошибочно считал
`non-stream`. Это не ослабляет ownership — `request_kind`, session, turn и
subagent по-прежнему проверяются из точной metadata, а основной response
форвардится байт-в-байт.

### Завершённый ответ без подтверждения после разрыва соединения

04.10.2026 History367 показывала245символов как Live после конца хода. Прокси
увидел `response.completed` request291 в13:34:11.037UTC, затем `client-close:1006`
через16мс. Из пяти assistant-items четыре получили exact canonical receipt;
245-item — нет. В bounded публичном History-read вместо него следовал другой
255-item. Это не полный raw-rollout proof отсутствия245 и не доказательство
того, что CLI принял все байты. Причина предшествующей532s паузы main не установлена.

Доказанный дефект observer: `context.finished` после `response.completed`
пропускал последующий transport-close. Теперь close сохраняет отдельный факт
`request_delivery_unknown` по exact request/turn/source. Failed/cancelled request
также не выбрасывает completed item вместе с открытым partial. При неизвестной
доставке даже равный полный текст другого item не заменяет exact `itemId`;
idle, `task_complete`, timeout и похожий следующий ответ не подтверждают сохранение.

Один O(1)-Footer проецирует неподтверждённые items отдельными стабильными
блоками: completed block не носит Live/spinner, пока следующий item того же
хода действительно растёт. Это фаза отображения ответа, не новая
lifecycle-authority: loader всего агента следует его авторитетному outcome.
Новый пользовательский turn сохраняет собственную boundary; старый
responseId/turn/thread/run не вправе вернуть предыдущий preview.

Повторная проверка без реального provider replay:
`scripts/history-preview-delivery-regression.mjs` — изолированный
HistoryPanel/Virtuoso, controlled incoming IPC, late exact adoption в одну
canonical строку, без дубля/remount и с bottom-gap0.
`codex-preview-delivery.integration.test.js` повторяет142/245/255/215/381 и
close после completed. Непринятие245 самим CLI остаётся недоказанным;
подделывать durable запись ради исчезновения плашки нельзя.

### Незавершённый фрагмент после native steering

09.10 History4196 удерживала48символов после полного сохранённого ответа672.
Diagnostic038c48a2 подтвердил одинаковый settled-текст в Main и renderer:
старый item оставался `completed=false`, следующий exact item уже materialized.
Это не renderer handoff и не ещё генерируемый ответ. Между partial и следующим
request того же turn был принят межвкладочный вопрос; до capture07:13 старый
`RESPONSE_END` в production.log отсутствовал. Лишь в07:33 старый observer закрыл
этот request по `upstream-close:1012`. Сам ранний wire-кадр не сохранялся, поэтому
конкретный `response.incomplete` этого инцидента — вывод, не прямой trace-proof.

В native Codex `rust-v0.159.2` уточнение во время генерации может идти через
`response.interrupt` с `mode=discard_partial_items`, затем сервер отвечает
`response.incomplete` с `reason=interrupted` на том же соединении. CLI продолжает
тот же turn, socket close не обязателен. Перехватчик раньше игнорировал этот
конец сегмента; контролируемая последовательность повторила оставшийся partial.
Теперь только exact server response-id разрешает прежнему failed-segment пути
отозвать открытый partial. Completed unconfirmed items сохраняются; содержимое
incomplete output не превращается в завершённое или canonical.

Client intent, следующий request, canonical sibling и `task_complete` сами по
себе такого права не дают. Поздний конец старого request также не снимает gap
нового потока. `INTERRUPT_REQUEST`, `OPEN_REQUEST_ON_NEXT`, `BOUNDARY_IGNORED`
и `RESPONSE_END` различают intent, отсутствие конца и exact terminal boundary
без raw body. Проверки producer/controller/actual Main используют искусственные
wire-events; это не replay инцидента и не proof физического принятия48 либо245.

### Долгий busy: ответы отдельно от полосы отправок

Шрам14.09: desktop History iOS-вкладки показывала подряд уведомления и
SEND FAILED, хотя тот же SID продолжал править Swift в TUI. Живой History API
и renderer-логи подтверждали новые assistant/tool rows. Поэтому старый
`task_started` и предупреждение WebSocket не доказывали остановку ответа.
Полная сверка была отложена до turn-end, а локальный failed/cancelled prompt
ошибочно сохранял границу будущего ввода: весь следующий хвост отправок,
включая уже принятые сообщения, оказывался ниже живых ответов.

Завершённая неуспешная карточка остаётся видимой, но больше не удерживает
последующие сообщения в pending-хвосте. Настоящий queued/неподтверждённый
ввод сохраняет прежнюю границу. Второй дефект находился в проекции квитанций:
локальный failed/cancelled безусловно отвергал поздний точный audit. Исправить
такой статус может только подтверждение той же operation+attempt, провайдера
и известной session с canonical UUID/source identity и audit proof. Очередь,
timeout, одинаковый текст и квитанция старой попытки этого права не дают.
Чтение сохранённой квитанции также не начинает новый retry поверх текущего.

Source и отдельный настоящий HistoryPanel/Virtuoso проверены: interleaving
при busy, exact promotion без полного refresh и durable adoption без дублей.
Прогон — `scripts/history-busy-ordering-regression.mjs`. Установленную версию
не обновляли; ID первой ошибочной карточки исходного живого renderer остался
недоступен без CDP. Нельзя подменять этот предел объявлением полной потери
stream, сетевым ремонтом, очисткой карточек или новым Enter.

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

Шрам24.09 показал дополнительную границу: после потерянного native Rewind
provider busy остался на прежнем ходе, а writer proof был unknown. Такой busy
ошибочно разрешил отдельный recap-request другой thread/turn и стал поддерживать
сам себя. Provider activity вправе продолжать только свой exact turn/thread;
общий `watcher.busy`, куда пишет и provider, не является независимым rollout
стартом. Новый ход требует своего `task_started`, ещё не использованного
submitted-prompt либо прежнего startup-proof. Один submitted-prompt разрешает
один provider turn, но не очищается из delivery-state: повторные сетевые
сегменты/transport retry продолжают exact turn, а новый настоящий Send получает
новую причинную запись. Это не фильтр по слову `recap` или JSON-тексту и не
permission связать provider session с durable writer. Неизвестное завершение
старого хода не превращается в idle без canonical/process proof.

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

Текстовый fallback Codex допустим только для legacy canonical без itemId.
Явный чужой itemId не принимает другой completed item по равной прозе, в том
числе до transport close. Иначе canonical B перед close1006 удалял preview A,
а обратный порядок оставлял его unknown. Exact A сохраняет обычное adoption;
отсутствие подтверждения не фабрикуется ни в rejection, ни в durable receipt.

## Claude: сетевой ответ и точная запись

`UserPromptSubmit` закрепляет semantic producer за terminal lifecycle и ходом.
Кадр xterm больше не может дописать ответ поверх него. SSE `text`-блоки одного
main request отделены от thinking/tool/side/subagent. `message_stop` закрывает
только сетевой сегмент: между ответами могут быть инструменты, а весь ход
закрывает Stop/StopFailure либо подтверждённое native interruption.

Claude сохраняет отдельные блоки под общим API `message.id`, без обязательного
SSE block index. В обычном порядке receipt связывает точный message id, полный
текст завершённого блока и UUID канонической строки; одинаковый текст другого
сообщения не подходит. Несколько одинаковых блоков одного message сопоставляются
в порядке ещё не подтверждённых блоков, повтор того же UUID идемпотентен.
Receipt до `content_block_stop` остаётся pending, пока ход продолжается.

Шрам09.09: Stop успел отозвать сетевого владельца раньше последних107 символов.
History уже содержала полный canonical-блок1998, а settled preview1891 был его
точным началом и висел ещё142 секунды как `not yet saved`. Возвращать поздние
сетевые байты нельзя: после Stop они принадлежат закрытому lifecycle. Вместо
этого в settled-фазе exact JSONL `message.id` + UUID + порядок блока разрешают
полной записи снять её непустой точный prefix. Похожий текст с другим message id,
лишний суффикс preview или открытый незавершённый ход этого права не получают.
Последняя замена по-прежнему использует существующий viewport handoff.

Шрам первой подписки: новая session становится доступной для чтения уже ПОСЛЕ
первого ответа. Обычный watcher начинает с текущего размера файла и пропускает
его, хотя полный History уже видит строку. Поэтому первая main-owned подписка
догоняет диапазон от неизменной byte-границы UserPromptSubmit (ENOENT означает0)
до своего снимка. Это только preview canonical callbacks: без повторных user
prompts, lifecycle и renderer fan-out. Shared live cursor не откатывается;
точный ранний receipt можно принять после более нового live receipt того же
хода. При смене preview/lifecycle асинхронный catch-up теряет право записи.

Шрам отмены: после Escape нативный Claude уже показывал Interrupted, но proxy
продолжал получать брошенный upstream и наращивать History до16655символов.
Теперь закрытие клиентского HTTP-response отменяет его upstream и semantic tap,
включая оставшиеся декодированные буферы. Это не успешное завершение хода:
native JSONL interruption отдельно снимает busy и открывает следующий ввод.
Обычный завершённый HTTP-response не отбрасывает ожидающий canonical ответ.
Подробности transport — `fact-provider-proxy.md::Connection Pooling`;
путь и marker — `fix-claude-aborted-streaming-loader.md`.

### Экранные шрамы до перехода на сеть

Другой шрам того же Fable-инцидента — ложные подписи `Edit` над настоящими
Bash/read операциями. В compound script `sed -n ...; grep -i ...` grammar
проверял sed-in-place по всей строке и принимал флаг другого grep за `sed -i`.
`shellEditInfo` теперь берёт argv конкретной sed-стадии через общий quote-aware
splitter/tokenizer. Настоящие in-place/backup формы сохранены; флаги в чужой
стадии или quoted sed-программе не создают Edit. Старые JSONL строки
пересчитываются после полного app restart; renderer-only HMR может держать
старый apiFamily в локальном кэше. Регрессия включает три реальные Fable
команды для main.js, App.tsx и claude-compact-queue-projection.js. Это ошибка
presentation-классификации, не факт модификации этих файлов.

Шрам05.09, Claude2.1.261: TUI добавляет ` · summarized` к показанному концу
thinking-блока. Parser принял57-символьный хвост за assistant prose и держал
его71m49s; последующие ответы не продолжали этот ложный текст и не могли его
заменить. Structured suppression теперь учитывает этот presentation suffix
только если существенная часть перед ним точно совпадает с концом уже
известного structured thinking/tool receipt. Нет общего blacklist слова
summarized, таймера очистки или подавления обычных ответов. После suppression
существующий controller освобождает preview для настоящего следующего ответа.
138 parser/controller regressions включают реальный57-char fixture и
отрицательные совпадения. Эта правка05.09 ещё не включала сетевой producer.
07.09 хвост `clamping. · summarized` снова завис:9символов были короче32-char
collision guard. Это подтвердило необходимость сменить источник, а не снижать
порог совпадения и рисковать удалением настоящей короткой реплики.

Интерактивный Claude binary не экспортирует raw Markdown той же PTY-сессии.
Режим `stream-json --include-partial-messages` относится к отдельному `--print`
процессу и не может наблюдать живой TUI. Сетевой producer читает ответ того же
интерактивного процесса; дополнительная AI-сессия для стриминга не запускается.

Hook socket даёт точный ownership для `PreToolUse`, `PostToolUse` и
`PostToolUseFailure`. Между началом tool и exact JSONL `tool_result` его
экранные строки не допускаются в assistant preview, даже если заголовок и `⎿`
ушли выше viewport. Post hook доказывает завершение исполнения, но не превращает
оставшийся output в prose; освобождение делает canonical `tool_use_id`.
Эти экранные ограничения сохранены для legacy parser; при semantic authority
headless-кадры вообще не публикуют assistant prose.

## Общий сетевой semantic stream

Provider Proxy параллельно декодирует Anthropic SSE и Codex Responses
WebSocket/HTTP-SSE в один ограниченный event-shape — live-владелец и для Codex,
и для Claude. Право Claude на main
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

## Порядок новой отправки относительно живого ответа

Ожидающий prompt остаётся после уже показанного ответа текущего хода. Смена
`IN APP QUEUE → SENDING → QUEUED` сама по себе не даёт ему владение этим ответом.
После точного подтверждения порядок задаёт адрес записи в transcript; новый
ответ следует за своим prompt. Это действует и до тяжёлого полного History read.

Шрам04.10: при первой привязке attemptId renderer принимал `unknown` из durable
receipt вместо известного состояния `busy` в момент клика. Проекция переставала
считать prompt ожидающим и на≈475мс ставила его ПЕРЕД уже видимым live-ответом;
provider queue ACK возвращал вниз. Первая привязка `null → A` сохраняет известное
наблюдение. Настоящая новая попытка `A → B` по-прежнему получает новое состояние,
а same-ID replay идемпотентен; stale/foreign receipt ничего не переопределяет.

После холодного восстановления `unknown` не превращается в выдуманное `busy`.
Неподтверждённая строка с неизвестным состоянием и `application-queued` остаётся
после текущего вывода; известный `active` сохраняет обычный порядок нового хода.
Failed/cancelled не удерживают будущие ответы. Эта логика меняет только порядок
History, не подтверждение доставки, очередь Main, source identity или scroll writer.
Проверка: `historyPromptOrder.test.ts` и изолированный `history-prompt-order-regression.mjs`.

## Canonical replacement и геометрия

Working имеет отдельную короткую передачу: локальная вставка сообщения →
снимок текущей работы из main. `paste-busy=false` завершает вставку, но сам по
себе не означает отсутствие работы агента. History дочитывает timing по этому
переходу и заменяет временный таймер в одном обновлении с принятым снимком.
Раньше очистка на paste=false создавала пустые кадры до async timing reply,
уменьшала документ и снова увеличивала его. Ответ без работы/ошибка чтения
убирает временный таймер; чужой owner, старый seq или новый paste не очищаются
прежним ответом. Повторные idle events не запускают новые reads. Authority
busy/SENT/main clock не меняется; это передача отображения. Влияние Footer на
прокрутку описано в `fact-история-производительность.md::Один физический низ`.

Для пользовательской карточки26.09 закрыта отдельная граница: полный read ещё
не означает, что canonical модель уже committed в History. Удаление локального
handoff и presentation ACK теперь следуют этому commit; сам live/durable merge
по-прежнему не зависит от видимого DOM. Alias upgrade того же user carrier
сохраняется на local row даже когда её дублирующий live text подавлен.
Timeline ищет эти адреса в конечном display-списке и переадресует незавершённый
jump при замене live/local UUID на canonical. Подтверждение уже показанного
prompt не является повторной отправкой и не включает tail-follow.
Подробности и узкий UI proof — `fact-timeline.md::Живые compact и переход к свежей записи`.

Если уже показанная History исчезает в loader на каждом streaming append,
сначала проверить ложную смену data owner. После ввода source generation
renderer сравнивал её с watcher dev:ino; два разных вида идентичности давали
двойной reset на append/read. Pending canonical handoff терял свою generation,
и сохранённый ответ оставался вместе с `synchronizing view`. Исправление —
раздельные physical/generation witnesses в HistoryPanel, не сброс preview по
таймеру или по совпадению текста. Проверка должна наблюдать непрерывность
готовых rows и отсутствие loader ВСЁ время ответа, затем ровно одну canonical
реплику; проверки только конечного текста недостаточно. Контракт свидетелей:
`fact-transcript-сервис.md::Физический файл ≠ поколение содержимого`.

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
режиму чтения. Читатель внутри preview ждёт exact mounted replacement-row и
сохраняет её row-top. Читатель другой записи сохраняет identity и положение
именно этой видимой записи; canonical-row вне экрана не обязана монтироваться
для удаления preview. `followBottom=false` не означает «читает preview»:
08.09 сохранение невидимого Footer на top1619 при viewport1007 сдвинуло
читаемый текст на −148px. Общий выбор опоры использует ту же область чтения,
что ordinary History, и применяется также после hidden return/нового жеста.
Неизвестная геометрия не становится координатой 0 или bottom-gap fallback.
У tail-reader требование mounted DOM замыкало ожидание: высокий Footer
сам вытеснял будущую durable-row из overscan. Поэтому exact canonical proof
сразу заменяет Footer той же live-row в общем presentation-списке; live-row
скрывается только когда durable-проекция той же physical identity реально
представлена. Row mount-ref и layout-effect самого Footer будят handoff до
paint: один rangeChanged→rAF мог показать промежуточный дубль. После clear
tail-owner завершается только когда последний реальный элемент смонтирован;
иначе оценочная короткая строка временно укорачивала документ и следующее
измерение возвращало низ на кадр позже. Это ожидание идёт ПОСЛЕ удаления
Footer, поэтому не возвращает deadlock и не требует unit-map proof до clear.
Данные/позиция не подменяются статическим spacer.

Canonical proof, пришедший в hidden pane, сохраняется под owner/generation и
будится новым presented visit; случайный `rangeChanged`/scroll не является
механизмом завершения handoff. Жест пользователя во время ожидания обновляет
якорь и выигрывает у старой геометрии. Искусственного tail reserve нет:
середина сохраняется semantic anchor'ом, хвост — живым bottom-gap. Общий
переносимый принцип описан в `../methodology/дизайн-принципы.md`.

### Canonical-передача переживает новое поколение renderer

05.10 после пользовательского Build Install в3314 был иной дубль, чем orphan245:
617-ответ уже имел exact canonical source829539335, Main ACK/pending0 и
`SETTLE_CANONICAL`; incident86ebecb3 показывал `currentPreview/controller=null`,
но renderer держал `Response · synchronizing view` ещё92с. Старый transport fix
действительно был установлен. В17:13:23UTC hidden refresh выдал
`FILE_REPLACED reason=content-generation`, сохранил тот же read SID/owner key,
но перевёл renderer data-owner1→3. Pending handoff остался в1; прежний
`sameOwner` wake отклонял любое дальнейшее пробуждение, даже с exact replacement
в новой projection. Причина самой смены source generation здесь не расследовалась.

Нельзя разрешать старой транзакции писать в новое поколение или очищать Footer
по idle/таймеру/тексту. Wake теперь лишь будит layout-проверку. После commit
той же owner-key renderer заново проверяет exact canonical identity; для
позиционного Codex source при смене поколения дополнительно нужен full-record
hash из принятой Main-квитанции. Затем создаётся новая bound транзакция с
новыми generation/visit и текущей геометрией. Tail intent сохраняется до нового
реального жеста; старая scroll-lease снимается только при exact token match.
Другая identity, owner или body на повторно использованном offset не очищают
preview. Здесь hash — проверка целостности ПОСЛЕ identity, не text matching.

Whole-turn previewId не является identity каждого ответа. Handoff держит IDs
показанных items; новый непокрытый item снимает только старую передачу, сохраняя
новый live/unconfirmed текст. Дополнительный hidden-шрам: запись
`terminalPreviewRef.current = terminalPreview` во время render откатывала уже
принятую IPC-seq к старому painted state; deferred publisher затем ошибочно
отбрасывал новый snapshot. Ref изменяется только явным accepted/clear-путём,
как и ref самого handoff, не render-mirror.

Повторная проверка: `scripts/history-preview-delivery-regression.mjs --canonical-handoff`.
Private actual HistoryPanel воспроизводит canonical receipt → response end →
task_complete → hidden durable epoch1→3 → return; до ремонта видны canonical+Footer,
после — одна painted canonical строка/bottom-gap0. Cases `mid-reader`,
`preview-reader`, `wrong-hash`, `unrelated-items` проверяют anchors/целостность/
непокрытые items. `HANDOFF_HOLD` пишет точную причину остановки и обе generation/
visit, `HANDOFF_REBASE` — основание новой транзакции. Source подтверждён отдельно
от установленной версии; Main receipt/lifecycle/launch/writer protocol не менялся.

Шрам Claude tail-reader: main уже опубликовал exact canonical assistant UUID и
`clear`, durable строка физически была видна, но Footer оставался ниже с
`Live response · synchronizing view`. Handoff всё ещё требовал производный
`canonicalTarget` из карты сгруппированных Virtuoso-units; эта карта не является
новым proof и может догнать финальный presentation array позже. Для читателя
внутри preview row-map/DOM всё ещё нужны ради сохранения row-top. Читатель
другой записи использует её собственный DOM key. Для читателя на
хвосте owner — нулевой bottom-gap: как только exact identity присутствует в
финальном display-массиве, Footer снимается в том же layout commit без ожидания
unit-map/DOM, а право на физический низ сохраняется до монтажа реального хвоста. Равный текст,
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

Для semantic preview пакет дополнительно хранит bounded controller-state без
текста ответа: phase/source, длину и hash preview, message/item/request suffix,
completed/materialized, deliveryState/reason и ожидающие canonical receipts.
`DELIVERY_UNKNOWN → SEMANTIC_DELIVERY_UNKNOWN` отдельно сохраняет close после
завершения сетевого request; это не доказательство failed/accepted. Лог-цепочка
`SETTLE_WAITING_CANONICAL → SEMANTIC_CANONICAL_RECEIPT →
SEMANTIC_CANONICAL_ACK|PENDING → CANONICAL_ROUTE → renderer
CLEAR_PENDING/HANDOFF_DONE` показывает точное оборванное звено даже после
ротации обычного production.log. `CANONICAL_ROUTE` отдельно различает строгую
полную сверку shadow и решение controller по exact identity.

Для сообщения `UNCONFIRMED` (`delivery-unknown`) обычное ПКМ → `Copy ID and
details` теперь вызывает тот же main/headless collector. В clipboard остаются
исходные ID/статус плюс `Terminal send diagnostic` и ссылка на атомарно
сохранённый файл. Payload несёт tab/message/session/handoff именно выбранной
строки, а не активной вкладки. В артефакте дополнительно лежат original
queueStatus, текущий exact-tab/handoff receipt, текст prompt с hash/length,
refs/count вложений и ANSI-сериализация видимого экрана (`scrollback:0`),
отдельно от исходных сырых chunks в bounded composer trace. Current frame
читается с `preferCommitted:false`, поэтому не маскируется повтором предыдущего
committed кадра во время незаконченной перерисовки. Write/flushed sequence и
generation позволяют отличить эти состояния.

Поздний переход `unconfirmed→sent` не отменяет заказанную диагностику: файл
сохраняет статус при открытии меню и receipt на момент копирования. Отсутствие
живого mirror или ограничение ring-buffer записываются явно; это не обещание
восстановить весь давний PTY. При ошибке диска ID всё равно копируется, но с
текстом ошибки и без несуществующей ссылки. Обычный `Copy prompt` продолжает
копировать текст и структурированные вложения, без диагностического хвоста.
Сборщик не пишет Enter, не изменяет receipt/очередь и не читает чужие handoff.

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
provider→preview→exact rollout replacement закрыта.

Claude08.09: physical main→Bash→main, первая canonical подписка, switch-away/
return и отсутствие live-дубля подтверждены Retake5; native interrupt→отмена
upstream→доступный composer→новый ответ→canonical подтверждены Retake7.
Инцидент09.09 с settled prefix1891/canonical1998 воспроизведён регрессией;
235 targeted tests проходят, включая чужой message id и отозванные после Stop
события. Новый случай физически на DEV/production ещё не перепроверялся.
Evidence старого physical этапа: `/private/tmp/noted-claude-stream-20260908.kD0N3l/artifacts/`
(`e2e-verdict-5.md`, `e2e-verdict-7.md`); source log — sibling `worktree/logs/dev.log`.
Установка/production restart не выполнялись. Это не утверждение о новой E2E
проверке всех моделей и всех альтернативных upstream-провайдеров.
