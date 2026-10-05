# Шрам: картинка принята Codex, но durable receipt остаётся audit-pending

## Подтверждённый случай 2026-09-05

Изолированный physical E2E, handoff `project-send:07501ced-da4c-416f-9b90-3540115797a4`, показал три представления одной отправки:

- исходный request: 3583 символа, hash `771bcdfd7914f8ff`, `[imagePath: /…/icon.png]`;
- реально подготовленный PTY transport: 3605 символов, hash `e8f14d6ece349948`, whitespace-free alias того же файла;
- native user carrier: 3510 символов, hash `eedd2ac5484b3664`, канонический image slot.

`CodexPasteAudit:CANONICAL_MATCH` правильно подтвердил transport→native по `codex_image_placeholder_canonical`. Но `publishAgentPromptAuditResult` передал transport hash как identity исходного request. Строгая durable-проверка справедливо отвергла `promptHash,expectedHash`; renderer уже показал SENT, а `presentation ACK` получил `delivery-not-confirmed`. Ошибка не в распознавании картинки и не в SQLite CAS — потерялось доказательство промежуточного преобразования самим приложением.

## Контракт исправления

`codex-image-request-projection.js` создаёт перед Enter доказательство **только image marker→alias**. Оно связано с exact tab/handoff/operation/attempt и содержит исходный текст, hashes/lengths и упорядоченные image identities. Повторная сборка через существующий `buildCodexImagePastePlan` должна побайтно воспроизвести staged transport; неизвестный source, другая картинка/порядок, потерянный marker или любое изменение обычного текста не получают доказательства.

На публикации exact audit main объединяет это доказательство с существующим `codex_image_placeholder_canonical`. Только при совпадении durable original hash, всей operation identity, staged path/ref order и transport hash/length наружу идёт исходный request hash. Нативный `actualHash` остаётся прежним; transport hash/length доступны в диагностике как `transportExpectedHash/transportExpectedLen` и в `[CodexImageAuditProjection]`.

`agent-send-receipt-store`, runtime registry и `agent-prompt-audit-identity` не ослаблены. Нет общего правила «разные hashes допустимы», нет попытки угадать предыдущий prompt по сходству. Missing-image degradation и произвольные преобразования текста этим доказательством не покрываются.

## Перезапуск — то же доказательство, не повторное угадывание

Structured authoring дополнительно несёт точные spans выбранных image parts и
hash подготовленного prompt. Это ограничение того же image-formatter, не второй
staging: похожий `imagePath` в file/paste тексте остаётся буквальным. Plan целиком
проверяется до первого staging callback; raw request→alias replay использует
те же spans. Они сохраняются внутри прежней imageRequestProjection до Enter и
проверяются при SQLite reopen. Отсутствующий/повреждённый span не разрешает
угадать другую картинку по тексту, а обычный plain path сохраняет прежний parser.

Доказательство создаётся до `stageAttemptContext` и вместе с упорядоченными `expectedImageRefs` сохраняется в receipt **до paste/Enter**. Live audit получает тот же объект; отдельной memory-only версии больше нет. Новых таблиц и ослабления CAS нет. Desktop History, уже использующий transport hash как свою durable identity, не сохраняет ненужную request→transport projection.

Startup reconciliation по-прежнему выбирает `transportText`. Если его hash/length отличаются от immutable request, разрешение даёт только сохранённая typed projection: exact operation/attempt, сырой `promptText`, transport, hashes, paths и refs проверяются повторной сборкой. Отсутствующая/повреждённая projection не заменяется fallback'ом на `promptText`. После этого реальный native carrier в сохранённой byte boundary обязан отдельно пройти image canonical proof; строка с голыми alias-путями не доказывает приём картинки. Итоговый audit использует исходный request hash, но сохраняет raw native `actualHash` без переписывания.

## Canonical History: typed image parts вместо staged transport

Physical iOS case14.09: exact alias audit был confirmed, thumbnail присутствовал,
но user-row содержала staged `/tmp/...png` после `Rewind.`. Delivery mapping
правильно доказывал отправку, но normalizer sidecar сохранял только imagePaths,
а read decorator оставлял transportText нетронутым. Подтверждение доставки не
является готовой authoring-проекцией.

Для typed image spans confirmed receipt теперь материализуется в постоянный
`history_prompt_presentations` schema4 item `authoring-projection`. Сохраняются
точные text/image parts, request/transport SHA256, original tab/handoff/operation/
attempt и отдельная canonical session/UUID/source/timestamp binding. Перед
созданием повторно проверяется прежний image mapping, все spans/hash/refs и
подтверждённая audit identity; filename/похожий текст не используются.

GET History/Timeline меняет только доказанные image spans на `[Image #N]`,
сохраняет все text parts дословно, включая такой же путь или буквальный
`[imagePath: ...]` вне image-part. Exact source aliases связывают response/event
carriers одной user-row. Исходный JSONL, audit transport hash и delivery truth
не переписываются. Полный DTO пользовательского ввода не угадывается: chips и
context metadata остаются в своих прежних sidecars/wrappers.

Future audit сохраняет проекцию сразу через существующий audit consumer;
старые confirmed receipts мигрируются прежним startup-pass до чтения History.
Сам reader не зависит от TTL receipt. Поздний обычный audit не стирает item,
а проверенная source→child metadata copy переносит binding без смены original
send identity; другой/неоднозначный mapping остаётся отказом. При отсутствии
точного typed proof transport не очищается догадками. Native canonical image
slots сохраняют parser text, но16.09 их original refs также проходят тот же
schema4 pass. Physical native tab122 уже имела confirmed mapping/ответ15:20,
однако staged ref рядом с source upload footer создавал два previews. Canonical
slot proof теперь хранит original path/mediaType/size и аннотирует transportPath/
sourcePath для каждой ordered occurrence. Это не удаление literal footer и не
вторая картинка. Swift consumer сливает две representations one-to-one по exact
path; повтор одного файла в двух slots остаётся двумя. Нельзя выводить это из
basename/count/глобального path equality. Native canonical hash остаётся отдельным
от staged hash; exact confirmed scope/body/path checks и late audit/reopen/copy
сохраняют projection, без переписывания JSONL/доставки.

### 03.10: promotion сохранила alias, но read lookup потерял original refs

Native31728 и три exact sends1D6A/63E6/8885 имели persisted schema4 projection
уже в production log. Первый audit связывал response31727/source236434874,
а parser повысил его до event31728/source237217420 с exact source alias,
timestamp +1ms и другим canonical hash. Старый lookup по UUID/time/hash не
нашёл sidecar; API оставила transport symlinks, native добавила их к двум
original footer paths как ещё две картинки и preview получил403.

Reader индексирует native projection также по её immutable physical source
binding. Изменившиеся timestamp/hash принимаются только для parser-proven
paired carrier, с совпавшим текущим audit timestamp/body hash и полным image
canonical proof. Session, прежний stored audit binding, staged formatter replay,
весь обычный текст и ordered slots/paths проверяются по-прежнему. Missing alias,
foreign scope/body/hash/order не заменяются basename/count/realpath inference.
DTO оставляет UUID/content/literal footer и original `/var/...` path, аннотирует
sourcePath/transportPath у ОДНОГО occurrence. Production receipts/JSONL не правятся;
существующей постоянной projection достаточно после обновления reader.

Desktop missing refs уже существующего local handoff дополняются read-only
`imagePresentation` v1 из той же request proof на bounded receipt IPC. Exact
operation/attempt/session/request text обязательны; новый row/status/send не
создаётся. Adjacent image occurrences стоят в одной inline полосе, same-path
повторы потребляют разные ordinal refs. Preview использует прежний mobile
upload-root owner с12MB cap, не разрешает arbitrary transport aliases.
Actual captured projector/три request→handoff regressions и private actual
History gestures + отдельный source-extracted Main preview handler прошли;
это SOURCE/isolated acceptance, не installed/iPhone proof. Wire/артефакты —
`/private/tmp/ios-settings-images-20261003/MAIN-RESULT.md`.

Regression: `history-authoring-projection.test.js` +
`database.history-authoring-projection.test.js`: реальные37DE user13/alias12,
actual audit consumer→SQLite→HTTP delta, receipt pruning/reopen, exact child copy,
literal paths, corrupted spans/hashes/scope, conflicting attempts. Новый parser,
iOS regex, provider send и изменение recordActivity для этой дельты не нужны.

### 04.10: local queued/SENT терял refs между публикацией и первым binding

Повторный mobile4944 был уже confirmed, canonical36520 имел original upload ref,
а локальная карточка показывала «В записи сообщения нет пути». Это другой слой:
proof request→transport был исправен. Live FIFO publisher отдавал raw receipt без
`imagePresentation`, в отличие от bounded list IPC. Список пытался обогатить
карточку до её создания/первой привязки attempt; строгая проверка закономерно
отказывала, а после begin/bind общего hydrate enrichment не повторялся.

Live и list теперь дают DTO от одного `imagePresentationFromReceipt`; общий
hydrate применяет его после exact begin/bind и возвращает уже обогащённый immutable
handoff. Новая карточка, первый null→A, поздний proof и remount проходят одну
границу. Это только attachment presentation: status/audit/source/авторский текст
не меняются, existing refs не перезаписываются. При отсутствии доказательства
путь не угадывается из marker/filename, чужой attempt/session/body остаётся отказом.
SSE остаётся компактным wake, не раздаёт тела/refs повторно; preview roots прежние.

Прежние три unit-кейса начинали с уже bound карточки, а private UI проверял
canonical row — этого недостаточно для local-before-canonical. Новые регрессии
исполняют actual Main publisher→общий renderer hydrate и captured4944 без
canonical read. Private actual styled HistoryPanel теперь проверяет local
queued/SENT, trusted image click с decoded JPG, cold/remount и позднюю canonical
adoption без второй карточки;14checks PASS. Parent просмотрел viewport с открытым
popup и сверил222 source hashes. Это synthetic IPC/captured fixture, не installed
provider retake. Протокол не добавляет fake refs до проверенной staged mapping.

## Проверки delivery mapping

SOURCE05.10: owned mobile uploads добавляют внешний exact path projection над
тем же provider codec. Frozen request остаётся авторским; только formatter/image
occurrences получают owned bytes. Для Codex image alias sourcePath прежний, document
path подменяется в transport; для Claude этот transport затем проходит прежнюю
unicode/newline нормализацию. Audit в обратном порядке восстанавливает original
request hash, не выдаёт metadata-only proof. Missing/foreign attempt/projection
не подтверждает Send. History sidecar сохраняет исходный document path и image
occurrences, в том числе native `[Image #N]`; JSONL/literal text не переписываются.
Старые4944/legacy records не backfill'ятся этой byte-ownership дельтой. Actual
Main prepare/pre-Enter/publisher→SQLite→History и startup cases —
`owned-mobile-attachments.integration.test.js`.

`ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test src/main/codex-image-request-projection.test.js src/main/agent-send-startup-reconcile.test.js src/main/agent-send-receipt-registry.test.js src/main/agent-send-receipt-store.test.js src/main/agent-prompt-audit-identity.test.js src/main/codex-prompt-audit.test.js`

Проверяются настоящий `publishAgentPromptAuditResult`, SQLite store, runtime registry и точный 3583→3605→3510 physical fixture. Отдельный тест исполняет настоящий pre-Enter staging block, закрывает/открывает SQLite и восстанавливает audit с неизменным native hash `eedd2ac5484b3664`. Подмена attempt, operation, текста, image ref/path/order и утрата projection не подтверждают доставку. Старая передача hash воспроизводит оба mismatch; новая переводит оба receipt в confirmed. Unit-тесты не заменяют финальный physical E2E нового build, его restart и presentation ACK.
