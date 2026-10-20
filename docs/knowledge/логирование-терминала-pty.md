# Логирование терминала — PTY

Справочник для симптомов «клавиша не сработала», «вставка не появилась», «команда
не отправилась», «форма не открылась», «долго загружался вывод терминала».
Он описывает, что сохраняет диагностика ввода/вывода, зачем нужны эти данные и
как читать их без повторения неизвестной операции. Поиск через `docs_search`
и передача этого Markdown агенту используют один и тот же документ.

CPU, память, очередь работы, native style/layout/paint и причины зависания
разбираются отдельно: [логирование оптимизации](логирование-оптимизации.md).
Метод запуска и проверки настоящего приложения — актуальный `electron-e2e-testing`;
этот справочник не выдаёт разрешение на Send, Stop, replay или установку.

## Какие факты необходимо различать

```text
действие в UI / API
  → приём сценария и проверка текущего владельца
  → конкретный вызов записи в PTY
  → outbound enqueue → собственный fd-call → callback
  → чтение/обработка ввода CLI (отдельный факт)
  → app onData → headless apply/flush → committed frame → renderer
  → причинный результат команды / точная квитанция сообщения
```

Не каждый отказ означает потерянную клавишу. Проверка может намеренно не
допустить запись; вызов write может только поставить её в очередь; CLI может
прочитать ввод, но ещё не завершить перерисовку. Успешный fd callback доказывает
границу записи, не `read(stdin)` и не обработку команды моделью.

Владелец диагностической записи включает physical terminal, tab, lifecycle/run,
mirror generation, input и Stop revisions. Для Send добавляются исходные H/O/A
(handoff/operation/attempt), для остальных действий — свой request/action ID.
Отсутствующий ID остаётся отсутствующим: его не достраивают из похожего текста,
сохранённой сессии или текущего фокуса. Внешняя строка production.log имеет UTC;
интервалы внутри PTY collectors используют один absolute monotonic clock.

## Почему нужны исходные порции вывода

Скриншот и очищенный текст теряют ANSI, границы порций, начало незакрытого
DEC2026-блока и порядок применения. Close-маркер может пересекать две порции:
grep каждого chunk отдельно способен ошибочно объявить его потерянным.
Снимок после разморозки также не восстанавливает предыдущие8–30 секунд.

Поэтому постоянно удерживается ограниченное недавнее окно вывода, а в момент
захвата ошибки фиксируются его доступная часть и последующий хвост. Это позволяет
разобрать и отказ, и позднюю реакцию того же PTY. Начало захвата должно предшествовать
ожиданию renderer или записи на диск. Более поздний снимок renderer получает своё
время, не подменяет состояние на границе отказа.

«Все символы сохранённого диапазона» не равно «весь вывод процесса» и не равно
«полный replay от исходного экрана». Если начало уже вытеснено, pin его не вернёт.
Для полного replay дополнительно нужны доказанный baseline, resize ordering и
соответствие app-raw/headless с его synthetic insertions.

## Точка захвата и представление данных

Raw window получает строки первого app `onData` после проверки физического
владельца, до OSC/presentation-преобразований. Source point —
`app-onData-decoded-v1`. Сохраняются доставленные UTF-16 code units в собственных
UTF-16LE buffers, включая управляющие символы и разделённые surrogate halves.
Это **не исходные kernel bytes**: декодирование node-pty произошло раньше.

Порция имеет sequence, время, owner, исходную и сохранённую длины, смещение
сохранённой части и явный пропуск prefix/suffix. Бинарный stream хранит framing
descriptor + payload, а не очищенный terminal text. `chars` — UTF-16 units;
`utf8Bytes` в progress — сумма перекодирований отдельных chunks, не физический
объём обмена с ядром. FD task имеет отдельные byte counters.

У исходящего ввода отдельная bounded ledger: receive-owner и write-owner,
attempt/return/throw, task ID, enqueue, fd-call, partial/EAGAIN/error/complete.
Нативный typeahead может пересечь run на том же PTY; оба owner сохраняются.
Полный текст каждой ручной вставки эта ledger не обещает. Hook отсутствует —
`unavailable`, не выдуманный ACK. Generic picker/rewind writes автоматически не
получают покрытие только от наличия manual-input collector.

## Окна, фиксация ошибки и пределы

Актуальные default-бюджеты SOURCE; manifest конкретного случая имеет приоритет:

| Ресурс | Предел |
|---|---|
| Rolling одного physical PTY | 2 MiB /8192 events, возраст до120s в пределах бюджета |
| Все rolling windows | 32 MiB |
| Один pin | до2 MiB pre +2 MiB late tail |
| Активные pins | 4 глобально, один на physical owner; повторные incidents становятся bounded aliases |
| Worker transport | 8 MiB /128 pending messages, вместе со staged batches |
| Raw disk archive | 128 MiB /10 artifacts /7 дней, применяется наиболее строгий предел |

Это бюджеты диагностических allocations/артефактов, не предел RSS приложения
и не гарантия двух минут при любом потоке. Очень большой chunk может оставить
только suffix в rolling; pinned tail сохраняет раннюю часть и учитывает
последующее переполнение, не вытесняя уже зафиксированный prefix.

Обычное окно наблюдает хвост до current committed/closed/flushed кадра,
смены owner epoch, завершения/dispose либо diagnostic deadline60s. У отказавшего
owned `/model`/`/fast`/`/compact` применяется более точная граница: matching
receipt/trace удерживает pin до release именно этой служебной операции. Первый
поздний OSC может commit'ить неизменённый экран и не завершает её диагностику.
При release сохраняется отдельный existing forensic snapshot конечного экрана
со ссылкой на тот же raw manifest, без нового pin/ввода/повтора команды.

Deadline60s и byte budgets не продлеваются; если они закончились до release,
`completion.pending` и причина `tail-deadline` явно оставляют прикладной конец
непокрытым. Complete сохранённого диапазона не означает complete всей попытки.
Завершённый кадр не обязательно означает пустой input, доставку Send или конец
ответа. Диагностический срок не является Main preparation deadline и ничего
не разрешает писать в терминал.

Обычное успешное действие не создаёт raw incident само по себе. Уже сохранённый
инцидент **не удаляется немедленно от позднего успеха**: хвост как раз может
объяснить задержку. После seal действует обычный ограниченный retention.
Metadata summaries продолжают попадать в общий logger независимо от raw pin.

## Запись на диск и неполные артефакты

Основной журнал — штатный tagged console logger: packaged `production.log`,
DEV `logs/dev.log`. Не создавай параллельный appendFile logger для нового caller.
Структурированный incident и raw payload — существующий специализированный
forensic storage, а не второй текстовый журнал.

Incident packet расположен в `app.getPath('logs')/terminal-history-preview-diagnostics`;
его `rawWindow.manifestPath` ведёт в `terminal-raw-incidents/raw-<id>/`.
Путь берётся из конкретного runtime/пакета, не угадывается по имени вкладки.
Worker сначала сохраняет доступный prefix (`stream.part`), затем tail. Manifest
различает partial/sealed, queued-not-yet-confirmed/persisted, fsynced и потери.
Seal ACK не стирает предыдущую persistence failure. Частичная запись посреди batch
учитывает и повреждённую запись, и ещё не записанный остаток.

Сверяй `lossBeforeCapture`, completeWithinRetainedRange, tail dropped counters,
`persistenceComplete`, `persistenceOmissions`, `persistenceLost`, diagnostic errors,
quota/owner omissions и reasons. `rawWindowCompleteWithinAdvertisedRange` не
поднимает `replayFromBaselineComplete`. Пустой/непрочитанный manifest или потеря
payload не означают отсутствие события.

У worker bounded очередь; её отказ теряет только диагностику. Active incident
не вытесняется prune, место зарезервировано также под обе версии manifest при
atomic publication. Неполный прерванный пакет остаётся читаемым; cleanup не
объявляет его полным. Shutdown присоединяет dispose/worker drain к awaited quit
с общим bounded ожиданием, но crash/kill/ошибка диска не превращаются в fsync proof.

Raw payload может содержать переписку и секреты, напечатанные CLI. Не помещай его
в обычные console summaries, рабочий Markdown или внешнюю консультацию целиком
без проверки состава и полномочий. Диапазоны для передачи должны быть минимальны,
а удаление/маскирование — явно обозначено. Retention raw не удаляет пользовательские
JSONL, БД, вложения или диагностические пакеты другой подсистемы.

## Прикладной coverage: что нельзя обещать автоматически

Наличие rolling collector не означает, что **каждая** ошибка UI запускает pin.
Проверяй caller: в SOURCE покрыты соответствующие Send refusals/unknown,
preparation failures, ручная preview diagnostic и некоторые owned short-control
ошибки. Часть incidents намеренно metadata-only и не захватывает текст.
У native question `control-unconfirmed` сам console log не вызывает raw pin;
для нового caller требуется отдельная проверка этой связи. Это описание покрытия,
не поручение сейчас менять question flow.

Старые composer forensics/replay journal дополняют пакет, но не заменяют raw window:
они ограничивают текст, coalesce одинаковые семантические кадры и зависят от
checkpoint. Длинный незакрытый кадр может потерять prefix до нового checkpoint.
Сумма двух частичных окон не является доказательством полного потока.

## Порядок разбора инцидента

1. Зафиксируй исходное действие, точную вкладку, время/часовой пояс и incident/
   request/H/O/A, если они есть. Проверь исполнявшийся build и его покрытие;
   CURRENT source, bundle на диске и уже запущенный процесс — разные версии.
2. Прочитай сохранённый пакет и соответствующий интервал общего журнала.
   Включи отказ/error/cancel/unknown каналы, не только happy path. Новый snapshot
   сейчас не восстанавливает состояние старого кадра. Живые app-данные читай через
   Application API; сохранённые diagnostic files — напрямую.
3. Восстанови последовательность из первой схемы. Если записи не было — ищи
   причину admission/refusal; если была — отдельно исследуй outbound и реакцию CLI.
   Для frame сравни applied/flushed/committed sequence и начало/конец sync-open.
   Применённый незакрытый кадр не является разрешением ввода.
4. Ordinary Send подтверждается своим exact canonical receipt. Native command/
   вопрос/Compact имеет иной причинный результат. Durable Enter arm не доказывает
   запись, write-throw не доказывает её отсутствие. Перед ordinary paste нужен
   current draft guard; standalone Compact сохраняет собственный exact-owned
   post-paste proof. Не распространяй правило одного пути на остальные.
5. При отсутствии звена назови конкретное недостающее измерение и добавляй его
   в существующий bounded collector у границы действия. Для нового caller должны
   различаться получение запроса, отказ до записи, возможная запись, последний
   допустимый кадр, наблюдённый результат и ошибка самой диагностики. Нельзя
   снимать guards, вслепую нажимать Escape/Enter или повторять старую операцию
   ради появления доказательства.
6. Профильную проверку проводи на разрешённом isolated target по актуальному skill.
   Headless grammar/controlled fd tests подтверждают свои границы, не всю цепь
   настоящего UI/CLI. Успех capture проверяй также после overflow/prune/shutdown.
   В результате отдели установленную причину, unknown, Source repair и живую проверку.

Если внешний клиент не доставил действие до Main, проверь отдельно его запрос,
TLS ingress, tunnel и app endpoint: TCP connect не доказывает payload. Это не
основание менять PTY parser; operational детали — [remote access](fact-remote-access.md).
Если задержка находится в CPU/очереди/отрисовке, переходи к справочнику оптимизации,
сохранив те же action ID и временной интервал.

## Владельцы и актуализация

PTY3163 владеет этим диагностическим контуром: raw/input/frame, хранение и явные
потери. Main3314 сохраняет authority Send/FIFO/receipt/lifecycle/Stop. Renderer/
performance telemetry принадлежит соответствующему владельцу оптимизации;
вопросная и subagent presentation — владельцу этих фич. Владелец collector не
обязан чинить все обнаруженные им дефекты. Любая вкладка может собрать пакет по
этому справочнику; передача находки не означает автоматический запуск адресата.

Переносимое правило расследования: лог рядом с симптомом — ещё не причина;
timeout — исход ограниченного наблюдения, а не причина задержки; отсутствие
данных — unknown до проверки coverage. Короткий probe не завершает принятый
Send сам по себе: действующий срок и продолжение описаны в
[Main FIFO](fact-terminal-mcp.md#main-fifo-принятых-send) и [Codex](fact-codex.md).
Внешний аудит — дополнительное evidence, не runtime proof и не вечное требование
вызывать конкретную модель. Следуй текущему поручению пользователя.
