# Факт: отложенная диагностика CPU и зависаний

## Зачем нужен внешний журнал

Пользователь работает обычным образом и сообщает время сбоя через несколько
дней. Ручной `ps` после жалобы не восстанавливает распределение CPU во время
неё: при разборе 11.09 одновременно встречались собственная нагрузка Noted и
отдельные пики OrbStack. Даже успокоившийся позже внешний процесс не доказывает,
что он не мешал раньше. Логи renderer приходят после разморозки; наблюдатель
должен продолжать измерение вне его event loop.

## Что остаётся после события

Source-контракт 11.09: существующий watchdog собирает native CPU-счётчики
процессов текущего пользователя и общий CPU системы. Дельты берутся за один
реальный монотонный интервал; новый или переиспользованный PID не получает
вымышленного нуля. `100%` у процесса означает одно ядро, у `systemBusy` — весь
CPU. Недоступные системные процессы и процессы, родившиеся и завершившиеся
между снимками, остаются слепой зоной. Возраст привязки PID к вкладкам сохраняется.

**Единицы исправлены 14.09:** прежний native-source принимал Mach ticks за ns,
поэтому все per-process `appCpu/tabCpu/rows` были занижены. На исследованном
M1 Pro отношение равно 125/3; маленькие значения в старых журналах не являются
доказательством простоя. Новый source нормализует время ровно один раз, frame
и 30-секундный checkpoint сохраняют `cpuTimeNormalization`, строка лога —
`cpuUnit/timebase`. `systemBusy/systemPeak` из `os.cpus()` отдельные и этой
ошибкой не затронуты. Проверка единиц и предел поправки старых округлённых
чисел — [ресурсная панель](fact-resource-usage-panel.md#загрузка-процессора-только-из-двух-замеров).

С30.09 каждый interval/checkpoint отдельно сохраняет `appCpu` (прямые Electron
процессы), `appChildCpu` (служебные потомки без tab binding), `tabCpu` и
`externalCpu`, плюс `cores`. Группы считаются до отсечения top rows. Процесс
вкладки и Docker не превращаются в CPU renderer; высокая внешняя нагрузка и
лишняя работа приложения могут присутствовать одновременно. Для вывода нужна
та же временная граница, не текущий Activity Monitor после вчерашнего события.
`external` означает отсутствие процесса в известном дереве Noted, а не
доказанную независимость нагрузки: Docker-daemon мог обслуживать команду из
нашей вкладки. Фоновый сигнал только системного CPU без Electron hotspot не
расходует профиль Noted (`system-pressure-no-electron-hotspot`); настоящий
медленный UI-жест всё равно проходит отдельную responsiveness-политику.

`[Perf:SystemPressure]` раз в30с читает только OS query (`sysctl` и `vm_stat`)
вне main/renderer. Он сохраняет raw pressure level, сжатую физическую/логическую
память, занятый swap и прирост swap/page counters, время/цену измерения. CPU frame
содержит возраст последнего memory sample. Мало свободной RAM не называется
memory pressure; page-in не называется swap-in, накопленное за boot число не
выдаётся за текущую скорость. Reset, частично недоступный счётчик и не-macOS
остаются явными unknown/partial. Эти поля объясняют условия, а не автоматически
назначают виновника задержки. GPU-process CPU также не равен загрузке видеокарты.

Постоянный сбор раз в 2с не запускает `ps`, не читает аргументы команд и не
гоняет список процессов через renderer. Каждые 30с сохраняются средние/пики
всего окна наблюдения, а не один случайный снимок. У инцидента есть подробная
минута до сигнала, 20с после, PID/type/tab, состояние видимости и heartbeat.
Записи живут рядом с production.log в `perf-incidents/`, поэтому ротация лога
или очистка `/tmp` их не стирает. Хранение — до 7 суток, общий бюджет 256MiB;
при заполнении старые диагностические артефакты удаляются раньше. Журналы
пользователя и неизвестные файлы этой очистке не принадлежат.

Сигналы инцидента: UI EventTiming от120мс, остальные delayed input/LongTask от250мс, отсутствие heartbeat
(main 500мс, focused renderer 750мс, видимый нефокусный 1500мс), либо минимум
6с нагрузки Noted от 80% одного ядра / системы от 90%. Новый подробный пакет
для фонового CPU создаётся не чаще раза в10минут, для responsiveness —30с;
активное20с окно объединяет новые события и считает неуместившиеся. Обычные
CPU/native/UI-измерения продолжаются между пакетами.

Не более четырёх раз за скользящие сутки запускается native sample и короткий
10-секундный профиль main/renderer JS плюс browser trace. Из четырёх слотов
фоновой sustained-CPU нагрузке доступны максимум два; два остаются для
responsiveness. Cooldown10минут считается по этой группе. Все причины
(`startup-warmup`, `reserved-for-responsiveness`, `capture-group-cooldown`,
`rolling-quota-exhausted`, merge/incident-window cooldown) и следующий доступный
wall time идут в `[Perf:CaptureDecision]`; повторный skip имеет счётчик.
Лимит переживает
перезапуск и восстанавливается со временем: прежние десять sample на весь boot
оставляли длинную рабочую сессию навсегда без стека. Первая минута startup не
запускает тяжёлую запись. Trace ограничен буфером 8MiB, экспортом 16MiB;
потеря данных, занятый DevTools, ошибка/опоздание захвата записываются явно.
С30.09 JS sampling1мс; профиль пишет triggerStart/end, actual start,
`triggerOverlap=trigger-already-finished|partial|unknown`, полноту экспорта и
peak buffer. Начатый после жеста профиль нельзя выдавать за стек этого жеста.
Занятый своим другим capture также оставляет явный profile status.
Профилировщик не поднимает окно и не отбирает существующий debugger/trace.
Он не собирает полный DOM, скриншоты, heap dump, тексты переписки или network
payload. Дополнение 14.09 сохраняет ограниченные метаданные элементов, описанные
ниже; это не постоянное сканирование страницы.

## UI → native counters → запрос чтения

С30.09 дешёвая цепочка не зависит от доступности тяжёлого capture. На capture
click/pointer/key/wheel сохраняются `ui-…` ID и структурный адрес цели до её
удаления. `[Perf:UIAction]` объединяет EventTiming, callback первого/второго
кадра, render/layout-effect/after-effects, presentation, focus, activity и
scroll-writer phases. `frameAbs` — доставка callback, исходный rAF timestamp
сохранён отдельно: после длинного handler он бывает раньше самого клика.
Stylesheet identities показывают добавление/удаление даже вложенного `<style>`
без чтения cssRules, текста, computed style или обхода всех потомков.

Кольцо96действий,32phases (первые8 и последние24),24stylesheet changes каждого
вида; переполнение явно помечено. Wheel — максимум один sample за200мс,
не изменение пути прокрутки. Уже существующие wheel/scroll-writer probes
сохраняют собственные owner/generation/visit и добавляют actionId. Это
временная связь, не автоматическое назначение причины чужой фоновой работе.

`[Perf:NativeWindow]` раз в секунду читает Chromium Performance counters:
ScriptDuration, RecalcStyleDuration, LayoutDuration, TaskDuration/ThreadTime,
число layout/style проходов, DOM nodes/documents и heap. Это собственное
подключение debugger без Profiler/Tracing/DOM/Runtime.evaluate. Оно уступает
DevTools и снимается на время incident profile; чужое подключение не закрывает.
Reload/crash сбрасывает baseline. `[Perf:NativeStatus]` явно сообщает паузу,
ошибку и состояние коллектора; тихие интервалы не печатаются построчно.

`[Perf:NativeAction]` связывает действие с перекрывающимися окнами счётчиков,
включая уже снятое periodic окно: нулевой следующий delta не стирает дорогой
предыдущий. Хранятся32окна, максимум6в одном action; время query — также ожидание
renderer, а не собственная CPU-цена наблюдателя. Интервал может содержать другую
работу, Script/style/layout вложены в Task/ThreadTime и не суммируются.
Недоступное значение остаётся неизвестным, не нулём.
`intervalWallMs` и `rendererThreadCpuPercent` отделяют прошедшее время от
собственной работы renderer thread: длинное ожидание при малом thread CPU
требует проверки очереди/планировщика/внешней нагрузки, но само по себе не
доказывает Docker. Высокий собственный Script/style/layout требует ремонта
соответствующей работы даже при занятой системе.

`[Perf:HistoryTransport]` добавляет `hr-…` ID и отделяет IPC wait от V8 decode,
байты полученного бинарного ответа от числа строк. ID доходит до `[HistoryRead]`
client/request/attempt/worker-generation. Диагностические поля удаляются из
payload перед service и не входят в cache/source identity, DTO и read proof.

Проверка диагностики — воспроизводимый известный CPU-блок + global restyle,
удаление нажатой кнопки, соседние periodic samples, ввод canary и wheel.
`scripts/renderer-diagnostics-regression.mjs` использует настоящий Electron28
с private userData; рабочие вкладки, native cursor и provider input не нужны.

## Cold History: чтение, проекция и ожидания

`CodexHistoryRead` после большого чтения пишет startAbs/endAbs, bytes/chunks,
maxRecordBytes/maxBufferedBytes, framingMs/parseMs/feedMs/checkpointMs/yieldMs
и readWaitMs/consumeMs. Это позволяет отличить большие физические записи,
копирование незавершённой строки, JSON-разбор, сборку проекции и паузы между
порциями. Тексты, аргументы инструментов и raw records в лог не попадают.

Времена нельзя складывать вслепую: consumeMs включает feed/checkpoint/yield,
checkpointMs содержит await и не равен чистому CPU. readWaitMs включает доставку
read callback и ожидание event loop, поэтому не измеряет скорость SSD.
Следующие CodexHistoryMetadata и TranscriptService:HistoryPrepare отделяют
подготовку строк от этого чтения; HistoryHandoff — применение и paint.
Отсутствие совпадающего CPU trace не позволяет назначить конкретному соседнему
IPC всю задержку. Процент чтения показывает продвижение именно этих байтов,
не объясняет причину медленной обработки и не гарантирует готовность viewport.

С25.09 read/preparation Codex может выполняться в Node worker. Его сообщения
доходят до обычного журнала с `[HistoryReadWorker] emitAbs=...`: время источника
отделено от доставки main. CPU/RSS процесса включает worker, а main-loop gap
и обычный main JS-profile не равны его работе. `preparedCache` отделяет запись
готовых строк от `responseTiming`. В E2E heartbeat нужно дожидаться последнего
overdue tick после ответа; screenshot/readback измерять отдельно — иначе цена
тестового захвата кадра ошибочно становится «лагом History».

Счётчик количества cache updates не измеряет write amplification: одна
continuation может быть десятками MiB. Различать continuation read/write bytes,
serialize/write ms, metadata/row/payload write bytes и `baseCache`/`preparedCache`.
Это bytes SQLite bindings, не физические записи SSD/journal. Prefix verification
учитывается отдельно от source bytes; virtual имеет свои read/verification counters.
Эти счётчики относятся к projector lanes, не ко всем file I/O приложения.
Main heartbeat подтверждает доступность main, но не ограничивает ожидание
другого запроса в синхронной фазе worker. С30.09 `[HistoryRead]` различает
sessionQueueMs и coldAdmissionMs, execution, serialization/postMessage,
main delivery, revoke/retry/worker death. Cache phases ограничены16группами;
поздний exception вытесняет обычную группу, последний отказ и счётчики причин
сохраняются отдельно от truncation. Bytes structured clone или raw records-path,
который не отдаёт измерение, обозначаются unavailable, а не оценкой по stringify.

SSD причины разделены: no-file, disk-quota, version-mismatch, source identity/
size/truncate/rewrite, контекст/owner, checksum/index corruption, disabled,
permission/disk-full и write invalidation. Prune, RAM index eviction и source
invalidation — разные события. История удалений/версий ограничена256ключами и
не переживает restart; version hint берётся из уже существующего quota scan,
без нового сканирования на каждый read. Неизвестная ошибка сохраняет класс и
безопасную точку JS-source, без message/payload. Bootstrap cache outcomes тоже
передаются; hit после RAM eviction отдельно доказывает SSD, а не новый raw parse.

С06.10 split cache отдаёт `cacheTier=rows/state/timeline` и prune counts
`obsoleteEvictedCount/stateEvictedCount/rowsEvictedCount/timelineEvictedCount`.
20GiB — общий retention budget, не RAM/peak reservation. При повторном чтении
сверять конкретный tier: отсутствие graph не означает отсутствие готовой
Timeline или страниц. Полный raw fallback после настоящей дописи и отсутствия
checkpoint отличается от лишнего raw-read неизменной Timeline.

## Как читать доказательства

`[Perf:CpuWindow]` ведёт к серии CPU-окон; `[Perf:Incident]` — к конкретному
пакету, `.sample.txt`, `.cpuprofile`, `.main.cpuprofile`, `.trace.json` и
`.profile.json`. Сначала сравни время симптома и фактические границы записи.
`requestDelayMs` и времена начала важны: main может начать JS-профиль уже после
freeze. Это запись продолжения, не стек прошедшей паузы. `complete=false`,
`traceComplete=false`, `traceDataLoss`, `unavailable` и `coverage-gap` запрещают
вывод «ничего не было». Если уснул/не получил CPU сам watchdog, его тишина не
доказывает отдельное зависание всех наблюдаемых процессов.

Высокий CPU и совпадение по времени сужают расследование, но не называют
конкретную функцию. У native sample Electron часто нет точных символов:
ближайший экспорт с большим смещением может ошибочно выглядеть как font shaping.
`during=history-load(open)` тоже не CPU-профиль: запрос мог ждать очередь минутами.
Настоящий вклад функции устанавливается профилем/trace и при необходимости A/B.

Повтор после установки14.09 показал иной доказанный источник main-нагрузки:
`[CodexJsonlCache] full/evict` содержат `by=...` и связывают повторные полные
разборы с reconciliation результатов оркестрации. За минуту8 full reads/2228.9MiB
на двух больших активных сессиях: файлы взаимно вытесняются из raw-cache768MiB.
Это логические чтения/JSON-разборы, не замер физических байтов диска. Такой
путь устанавливается по caller и последовательности cache events даже без
свежего CPU-профиля; однако не объясняет автоматически каждую отдельную паузу
renderer. Соседняя Swift-компиляция также занимала несколько ядер. Детали и
source-ремонт общего result-reader — рабочая карта окон14.09,01:45МСК.

После ремонта `[CodexResultReader] mode/readBytes/verifyBytes/sourceVerifyBytes` различает
bootstrap, append и неизменный повтор. `readBytes` — цена нового JSONL-диапазона,
`verifyBytes` — SHA прочитанного диапазона, `sourceVerifyBytes` — дополнительная
проверка frozen ancestor/child-prefix у resolver; это не повторный JSON-разбор.
`authority=0` означает наблюдение без права окончательного commit, `authority=1`
— проверку для решения. Повтор после rewrite учитывает затраты обоих проходов;
ошибка проверки тоже не обнуляет её цену. На больших synthetic files проверены
unbound и ID-less пути: обычные busy-wakes, готовый A с append следующего B и
pending child с растущим parent не хэшируют прежний prefix при каждом событии.
Перед окончательным результатом и отказом digest по-прежнему проверяется.
Эти счётчики не измеряют
рендеринг History/hover и не заменяют общий CPU/paint профиль после установки.

### Первый scroll после возврата: вход, обработчик и движение не одно время

Прежний `SCROLL_GESTURE_BEGIN` находился внутри intent-handler после capture
и части подготовки. Поэтому его `inputDelayMs` нельзя целиком приписывать
доставке ОС, складывать с пересекающимся LongTask или считать началом handler.
В эпизоде4196 первый scroll наблюдался≈405мс после wheel, хотя высота/строки
не менялись; соседний тяжёлый projector начал работу только после этого scroll.
Повторный ремонт loader/anchors не следует из такого симптома.

`[HistoryHandoff] WHEEL_PIPELINE` теперь связывает по instance/owner/generation/
visit/id вход и выход tool-capture и intent, route `none/inner/edge`, cancelable/
defaultPrevented/propagationStopped, первый наблюдаемый scroll и ближайшие rAF.
`scrollHandlerEnterAbs` отделён от чтения позиции; `beforeObservationMs` включает
предшествующую работу scroll-handler. `afterIntentMs` — ожидание после выхода
из intent, не автоматически вина browser: там ещё могут выполняться другие JS
tasks. Scroll означает наблюдение после события, не доказательство его причины;
rAF также не гарантирует, что пиксели уже показаны.

Запись буферизуется в отдельный task; сравнивай исходные enter/exit/event/frame
Abs, а не время попадания строки в файл (`flushAbs/logLagMs` и RendererLogMeta).
Нет дополнительных geometry reads или scroll-writer. Первые3 packets после
quiet-gap250мс — только sampling, не управление жестом. Ещё ожидающий first
wheel не теряется при новом burst; owner/hide/remount не разрешают приписать ему
движение другой поверхности. Pending12, frames8 и очередь48 ограничены;
capacity/cancelled/dropped остаются явными, отсутствие sample не означает PASS.

`SCROLL_PROGRAMMATIC` закрывает другое недостающее звено: DOM scroll сам по
себе не называет писателя. В активном upward gesture обёртки только данного
History scroller наблюдают `scrollTo`, `scrollBy` и setter `scrollTop`; они не
отменяют, не повторяют и не меняют вызовы. Лог содержит вызванный метод/числа,
стек, owner/generation/visit/gid, intent/restore и последнее уже выполненное
измерение строки (включая1px). Дополнительных geometry reads нет. Числа из
options читаются по data descriptor: getters не исполняются диагностикой.
До8записей на gesture/24pending; limitReached запрещает считать охват полным.
Вывод отложен, сравнивать calledAbs с WHEEL/SCROLL, не timestamp flush.
Cleanup восстанавливает только собственные wrappers и не трогает поздние чужие.

`VIRTUOSO_MEASUREMENT_VIEWPORT_SYNC` обозначает раннюю публикацию уже изменённой
позиции после измерения карточки. Это synthetic scroll notification без записи
координат; он не является новым user input или измерением native browser ACK.
Позднейшее обычное scroll event остаётся допустимым. При анализе пустого кадра
сравнивать physical writer и native paint; rAF до RO может видеть промежуточную
геометрию даже в исправленном варианте. Механизм — fact-история-производительность.

Стек абсолютного scrollTo отличает повтор index/tail-команды от относительной
компенсации scrollBy. Если JS-записи нет, это ещё не доказательство browser
anchoring: сначала проверить полноту охвата/лога, затем native trace. Рост
scrollTop с равным ростом высоты и сохранённой видимой строкой может быть
корректной компенсацией. Проба `scripts/history-first-wheel-probe.mjs` снимает
именно writers/frames в private Electron; её MEASURED не является приёмкой
неповторившегося production-рывка.

Существующий incident trace дополнен `input`/`latencyInfo`: очередь и ACK
имеют отдельные события в [Chromium120](https://raw.githubusercontent.com/chromium/chromium/120.0.6099.0/content/browser/renderer_host/input/mouse_wheel_event_queue.cc).
JS-логи сами native ACK не измеряют. Категории сохранены в `.profile.json`;
privacy filter,8MiB buffer,16MiB export и capture quota прежние. Новая строка
WHEEL_PIPELINE не требует тяжёлого capture; профиль после события всё ещё не
восстанавливает прошедший ACK. Headless tests проверяют временную цепочку и
реальные callbacks History, не production pixel-latency.

`[TranscriptService:HistoryPrepare]` отделяет post-projection work от загрузки:
dehydrate, promptPresentation, responseTiming, revision, rowWindow, entryWindow,
digest и суммарные startAbs/endAbs/elapsedMs. Прежний путь без SSD-store также
отдаёт syncMs; worker с порционной записью отмечен yieldedCacheWork, его elapsed
включает уступки другим задачам и не равен CPU. Пишется только
при общей цене от24мс, без содержимого сообщений; refresh/delta/full возвращают
тот же результат. Async rewrite-baseline в эти времена не входит. На19.09
wheel171 ждал439/416мс до tool-capture при handler≤0.3мс; сопоставлять следует
эти main-фазы, а не чинить loader или складывать весь open IPC со временем input.

`[CodexAuditAddressRead]` отдельно пишет file, scanBytes/bodyBytes/
verificationBytes/cacheHit и elapsed ms адресного enrichment. Счётчики локальны
одному вызову, не разница общих totals параллельных readers. В нормальном
неизменном повторе scanBytes=0, bodyBytes — только exact user record; новая
ревизия может считать большой prefix, но не создаёт raw-массив. `outcome=address`
доказывает прочитанный physical locator; финальный audit hash/session/attempt
ещё проверяются общим publisher. После ремонта не должно быть
`CodexJsonlCache full by=resolveCodexAuditAddress`. Источник большого read —
отдельная проверка от его доли в задержке wheel: без совпадающего CPU/input
trace одно время завершения чтения такой доли не доказывает.

### Когда JavaScript-профиль почти пуст, а интерфейс занят

05.10 после пользовательского install Main worker выполнял повторные большие
History/Timeline rebuilds после `disk-quota`; native renderer оставался занят
и после спада Main. Sample14:42:11UTC, Electron28.3.3arm64: exact UUID Breakpad
mapping дал181/266samples в paint lifecycle, а не шрифтовую/Node работу, которую
подсказывали ближайшие stripped exports с огромными offsets. Вложенные51samples
CollectAnnotatedRegions,44compositor artifact и26clear repaint flags не
складываются с parent181. Hit-test1sample, AX-tree hot path не установлен.
Точный component/animation trigger этим не назван. Исходный click14:32 имел
5155ms input wait при продолжающихся rAF/timers и12.6ms handler; поздний sample
не объясняет все эти5секунд. До install renderer уже≈109%CPU, RAM pressure1 и
swapOut0 после install: нельзя объявлять новое изменение причиной всей нагрузки.
Evidence/дальнейший discriminating A/B —
`/private/tmp/noted-system-lag-20261005-ivk8wvsn/RESULT.md` и рабочая performance-карта.

06.10 isolated actual indicators/CSS,62991DOM: serial same-tree controls за1.8s
дали baseline109Paint/lifecycle, all-paused4, один process109, Working108.
SVG HistorySpinner дал лишь2Paint, но109PrePaint/lifecycle: счётчик raster Paint
сам по себе не измеряет этот loop. Hidden running0; full History/runtime не
моделировались, installed initiator не доказан. Process transform prototype
91→2Paint/8lifecycle не принят: контроль90настроек/фаз обнаружил другой рисунок
блика. Повтор — `scripts/renderer-recurring-paint-regression.mjs`; evidence и
границы в рабочей карте06.10. Ремонт обязан сохранить визуал/статусы и проверять
каждый recurring owner; один process-bar не уберёт цикл активного Working.

Поздний06.10 R04 SOURCE завершил эквивалентную замену process/Working/naming/
spinner/rings/glow/hotkey, не перенос отвергнутого prototype.540compiledprocess+
162text/spinner+294ring/glow visual pairs PASS; shared-RO устранил добавленную
первым text prototype цену повторных geometry reads. Source/compiled same-tree
~66kDOM:109Paint→1/2;109PrePaint/lifecycle→48, cost lifecycle~428→8ms вsourcepair.
Оставшиеся28animationiteration вcompiled/source trace и1Hz clock не равны
60Hz full paint. Колонки вложены, не складывать их суммы с ThreadTime.

Actual History/CodeMirror trustedinput pair сохраняет ввод/DOM/draft; final
наблюдаемые медианы finalbaseline24–32ms/product16–32ms, handler≤0.5ms. Ранее
тот же product давал24–32ms медианы; серия не отбиралась по лучшему результату. EventTiming
ниже16ms отсутствует, duration округлён8ms; группировать по interactionId,
а не выдавать несколько DOM events одного нажатия за независимые действия.
Пара не доказывает универсальный input speedup или причину исторического5.1s.
Приёмка: `scripts/renderer-recurring-paint-regression.mjs`, text/ring-glow и
`scripts/history-renderer-input-paint-regression.mjs`; точный RESULT/root —
`/tmp/noted-r04-renderer-evidence-path`. Production не устанавливался.

30.09 warm-switch trace показал другой класс browser работы: CSS pause-rule
с descendant style/class substring selectors заставлял UpdateLayoutTree
перепроверять4392обычных элементов за67–74мс при opacity/class mutation owner.
После exact class targets и37inline markers style median77.5→13.5мс в одной
actual fixture. CPU sample `focus` означал место принудительного flush;
первичная причина была раньше в invalidation selectors. В production flush
может оказаться до focus в соседнем layout effect. Native interval overlap
не выбирает этот writer; точная связь требует trace+одного CSS control.
Доказательства/контракт/пределы — `fix-performance-lags.md::7c`.

19.09 sidecar связал повторный root с `HistoryTerminalActivityIcon`3314,
`cb-terminal-perimeter-travel`;40–46 скрытых HistorySpinner оставались running.
Последующий isolated Electron28 A/B подтвердил цену именно SVG motion-path:
на~60k retained DOM nodes120 Layout/2с и ThreadTime702мс; отдельная HTML transform
точка + пауза невидимых циклических индикаторов дали0 Layout и8.4мс. Один только
pause скрытых не устранял layout от видимой SVG-точки. Сохранялись DOM/draft/scroll,
фоновые updates, visible-unfocused busy и hover→Stop. Замеры из21:13–21:43 не
являются стеком исходного hover21:04; source-ремонт требует отдельной installed
проверки. Полные traces, контроль конечного dismiss и cold Resume A/B — рабочая
карта окон19.09.

CPU renderer включает нативную работу Chromium: style/layout, paint и сборку
графических слоёв. V8 `(program)` при почти непрерывном `ThreadTime` не означает
простой и не называет конкретный React-компонент. В инциденте 13–14.09 профиль
за 10с дал 9.86с потока и лишь 0.09с `ScriptDuration`. Сохранившийся префикс
trace показал 78 кадров, шесть повторных layout roots размером 40×40 и 69 изменяемых
анимацией элементов в каждом кадре. Номер DOM-узла без связи с владельцем не
доказывает, что виновата последняя добавленная фича; время записи после жалобы
также не превращает этот профиль в стек более раннего зависания.

Новый `.ui.json` связывает до 24 backend node IDs из trace с tag/class,
исходным `data-insp-path` и tab/pane/history owner. Отдельный список до 256
анимаций содержит CSS-имя, состояние и тот же безопасный адрес. Inline opacity,
inert и isolation сохраняются как авторские признаки, а не как доказанная
видимость: `getComputedStyle`/геометрия для этого не читаются. Поля input, текст,
title, HTML и URL не попадают в этот файл. Предел sidecar 64KiB, он входит в
общие retention/256MiB; IDs извлекаются и из корректного префикса обрезанного
16MiB trace, незавершённый хвост не выдаётся за полный JSON.

Этот снимок делается **после остановки** CPU-профилей и trace, только пока
сохранено владение своим debugger. Записаны время и zoom: узел мог исчезнуть
или сменить состояние между trace и снимком, ошибка разрешения остаётся явной.
Бюджет ожидания 1.5с и ограничения обхода не являются hard real-time гарантией
при уже заблокированном event loop; `getAnimations()` также может обновить
состояние стилей внутри Chromium. Поэтому диагностический обход не включён в
профиль, которым объясняется нагрузка приложения. Он не меняет selection/CSS,
не поднимает окно, не забирает чужой DevTools; свои object groups освобождает.

При следующем совпадающем лаге сопоставь повторные roots, CSS-имена и скрытых
владельцев. Только затем A/B или ремонт соответствующего индикатора/границы
presentation; отключать все loaders, фоновые сессии или retained History ради
догадки нельзя. `[GlobalRunAfter:Presentation]` отдельно сообщает, была ли карта
закрыта/preview/pinned; без такого сигнала старый лог не устанавливает её участие.
Первый вариант14.09 использовал `console.info`, который renderer не пересылает
в файл. Только последующая source-правка на `console.log` подключает действующий
log bridge; отсутствие строки до этой правки не означает закрытую карту.

## Наблюдатель не должен тормозить жест

В исходном resize наблюдатель курсора читал hit-test/computed style из
MutationObserver после freeze/cursor writes, а rate-limit проверял уже после
чтения. Это принудительная синхронная граница layout на горячем пути. Фоновый
probe теперь пишет доставленную цель события (`targetEvidence=event`),
авторские стили и владельца курсора; `computed=not-sampled` намеренно не является
ни реальным computed cursor, ни системным NSCursor. Он не делает geometry reads
и не сканирует `:hover`. Владелец курсора теперь читается прямо из gesture-manager,
не по наличию временного style-элемента.

13.09 повторная production-жалоба на resize/workflow показала предел прежнего
ремонта: инвалидация от `:root * {cursor:...}` и `body.userSelect` оставалась
даже без probe geometry-read. Browser платил её до paint; release listener
workflow форсировал её чтением размеров и выглядел как `commitMs≈300` при
`committed=0`. Source переведён на cursor малого pointer-capture target;
новые `cleanupMs/storeCommitMs/releaseHookMs` разделяют отпускание и запись.
Изолированный Electron28/50k DOM доказал старую style-цену70–100мс против
0–0.2мс у нового пути, первый кадр~15–20мс. Это proof общего механизма, а не
замер всех History/layout costs production. Точная фикстура и остаток —
[рабочая карта окон](../tmp/окно-вкладок-и-переключатель-фичи.md).

Общий manager не доказывает, что все жесты используют его: sidebar `TabBar`
сохранял отдельный global stylesheet, а popup-resize — записи в body. При
повторении симптома проверяй фактический writer конкретного жеста. После их
ремонта отдельная fixture с actual outline/host hooks и 50k DOM дала снятие
старого правила91–92мс против0.6–0.7мс у локального пути. Это стоимость styles
в контроле, не полная задержка production. `[TabDnd:cursor] setupMs/cleanupMs`
тоже измеряют только JS-границы; общий input/paint delay остаётся в Perf-probe.

14.09 регрессии CPU/PID, единиц, интервалов, rolling quota, retention, ownership
debugger, обрезанного trace и ограничений metadata прошли вместе со связанными
service/позиционирование наборами: 56/56. Это проверка source-контракта;
installed acceptance нового recorder ещё впереди. Отдельная проверка cursor13.09
не доказывает цену профилировщика или устранение всех resize costs.

Изолированный Electron28 проверил настоящий SVG motion-path: оба layout root
сопоставлены с visible/hidden tab и inspector path, CSS/selection не изменились,
private-text CANARY в metadata отсутствует. Снимок 3020 байт занял 4.866мс;
это малая fixture, не оценка стоимости на 56k DOM рабочего приложения.
Повторяемый сценарий — `scripts/perf-incident-ui-regression.mjs`.
