# Fact: Voice Dictation (Soniox real-time)

Real-time диктовка через Soniox `stt-rt-v4` (`wss://stt-rt.soniox.com/transcribe-websocket`). Кнопка mic живёт в `ClaudeControlBar` справа от Copy-prompt split-pill, real-time транскрипт — в floating-окне-портале над кнопкой. На desktop финальный текст по STOP уходит в owner-tab, зафиксированный в момент START (SDK composer / primary History composer обычной Claude/Codex-вкладки / без editor-delivery для обычного shell), а не в «что сейчас активно на экране»; всегда дополнительно сохраняется в localStorage-историю. Живая desktop-сессия лежит в renderer singleton `dictationManager`, `MicButton` — только view/control для вкладки-владельца. На мобиле — та же модель: кнопка mic в composer, такой же floating UX. См. [`fact-claude-control-bar.md`](fact-claude-control-bar.md) для размещения, [`fact-mobile-web.md::Mobile composer`](fact-mobile-web.md) для мобильной стороны. Системный аналог поверх всех приложений (Cmd+`\``, плавающий чип над Dock, paste в frontmost app) — [`fact-global-dictation.md`](fact-global-dictation.md); тот же `DictationSession` + `soniox:mint-token` переиспользуются.

## Симптомы для роутера

- Mic-кнопка нажимается, но floating-окно не появляется, текст копится только в истории
- "Dictation: audio: The user aborted a request" сразу после клика mic
- "Refused to connect to wss://stt-rt.soniox.com" в DevTools console
- "Refused to load script blob:" в DevTools, AudioWorklet не стартует
- `<end>` или `<fin>` маркеры попадают в финальный транскрипт и сохраняются в историю
- macOS показывает system wait-cursor поверх кнопки во время stopping
- В SDK таб транскрипт не подставляется в composer после STOP
- Loader на кнопке mic во время connecting → юзер кликает второй раз, думая что зависло
- Production-копия web-server на 7878 отвечает «mobile-web/dist not built»
- При переключении вкладки/проекта/Home запись продолжается, но floating-окно пропадает и непонятно где её остановить
- На другой live-вкладке mic остаётся активным, хотя запись уже идёт в соседнем табе
- Строка `RECORDING` справа сверху не появляется или клик по имени вкладки не возвращает к owner-tab

## Архитектура: instant-record + buffered flush

Click → state `recording=true` синхронно (UI меняется в том же frame, **без `connecting`-фазы**). Параллельно:
- `getUserMedia` (~50 мс) → `AudioContext` → `ScriptProcessorNode` → handler `onaudioprocess` пишет PCM в `pending: ArrayBuffer[]`
- `fetchToken` (IPC `soniox:mint-token` или REST `/api/soniox-token` на mobile) → `new WebSocket` → handshake (~300-700 мс)

Когда `ws.onopen`: отправляется JSON config (`api_key`, `model: 'stt-rt-v4'`, `sample_rate: 16000`, `audio_format: 's16le'`, `language_hints: ['en','ru']`), потом **flush'аются все буферизованные PCM-чанки**. С этого момента `onaudioprocess` шлёт напрямую в `ws.send`. Это значит **ни одно слово не теряется в первые 300-700 мс пока ws ещё не открыт** — юзер может начать говорить сразу после клика.

Cap буфера — 200 фреймов (~4 с аудио). Если ws висит дольше — старые фреймы дропаются, но юзер давно нажмёт Stop.

## Tab-owned background recording

Desktop-диктовка принадлежит вкладке, где пользователь нажал mic, а не текущему `activeProjectId/activeTabId` в момент STOP. При START фиксируется owner `{projectId, tabId, tabName, mode}`; delivery, Enter stop-and-deliver и disabled-state других mic-кнопок читают именно этот owner. Это защищает главный user-flow: пользователь начал диктовать prompt в табе A, ушёл на другой проект/Home/другую вкладку, запись продолжает идти в фоне, а STOP/Enter позже доставляет текст в composer таба A.

`MicButton` нельзя снова делать владельцем `DictationSession`: нижний control bar keyless-переиспользуется между табами, а сам `MicButton` может размонтироваться при смене проекта, view или live-guard'ов. Локальная сессия в компоненте в таком сценарии либо теряет UI-контроль над живым Soniox stream, либо переинтерпретирует запись как принадлежащую новой активной вкладке. Поэтому `dictationManager` держит session/snapshot/subscribers на уровне renderer-модуля, а `MicButton` только сравнивает `snapshot.owner.tabId` со своим `tabId`.

Поведение поверхностей:
- owner-tab показывает обычный recording mic + floating transcript, anchored к своей кнопке;
- чужие live Claude/Codex вкладки показывают mic disabled, чтобы не стартовать вторую запись и не менять owner;
- когда owner-tab не является видимой terminal-поверхностью (другая вкладка/проект/Home/Dashboard), floating transcript скрыт, а в `ToastContainer` появляется постоянная status-row `RECORDING` с owner tab name (trim 15 chars) и кликом назад в проект/вкладку owner'а.

## Почему ScriptProcessorNode, а не AudioWorklet

AudioWorklet требует `addModule(blob:URL)`. Electron renderer с CSP `default-src 'self'` режет blob:-скрипты с ошибкой `Refused to load the script 'blob:http://localhost:5182/...'`. Расширение CSP до `script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; child-src 'self' blob:` снимает блок, но ScriptProcessorNode работает без CSP-расширений и без blob-инфры, а латентность 4096-sample буфера (~85 мс @ 48 kHz) для речи **незаметна**. Trade-off в нашу пользу: меньше движущихся частей, не зависит от Vite/CSP-конфига.

## CSP и permission — два обязательных пререквизита

Без них `getUserMedia` reject'ит `AbortError: The user aborted a request` (юзер ничего не делал — это Electron сам режет), а `new WebSocket('wss://stt-rt.soniox.com')` сразу даёт `Refused to connect`. Оба правятся в одном спринте:

1. **CSP в `index.html`** — `connect-src 'self' wss://stt-rt.soniox.com https://api.soniox.com; media-src 'self' blob: data:`. Меняется в `<meta>` — изменения подхватываются после Cmd+R окна (hot-reload renderer не обновляет head meta).
2. **`session.setPermissionRequestHandler`** в main для `media`/`audioCapture`/`microphone` → callback(true). Без него Electron по умолчанию отвечает deny **до** того как macOS успеет показать системный prompt. macOS-уровень разрешения всё равно спросится при первом capture — это нормально.

## Endpoint markers фильтруются

Soniox реально шлёт synthetic-токены `<end>` (endpoint detection — пауза в речи) и `<fin>` (finalization) **внутри** массива `tokens` вперемежку с реальными словами. В docs они не упомянуты. Без фильтра попадали в `finalText` → в композер и в localStorage-историю. Regex `/^<[a-z_]+>$/i` отсекает любые подобные маркеры до аккумуляции.

## Режимы доставки

Решение «куда уходит текст после STOP» зависит от `mode` owner-tab'а, зафиксированного при START. Не пересчитывать mode по активной вкладке во время STOP: к этому моменту пользователь мог уйти на другой проект, Home или соседний tab, но сказанный текст всё ещё принадлежит исходному prompt'у.

- **`sdk`** (claude-sdk таб) → `window.dispatchEvent('claude-sdk:dictation-deliver', {tabId, text})`. Handler внутри `SDKComposer` (НЕ в `ClaudeSDKTab` верхнего уровня) использует прямой `composerTextareaRef` + `writeComposerValue()`. Раньше handler сидел в `ClaudeSDKTab` и искал textarea через `querySelector('.absolute.inset-0:not([style*="display: none"])')` — селектор нестабилен в multi-tab layout'е, текст уходил в чужой таб. Внутри SDKComposer есть готовый `writeComposerValue` (тот же путь что Stash-restore и insert-prompt используют — гарантированно работает с assistant-ui ComposerPrimitive).
- **`history`** (обычная Claude/Codex PTY-вкладка, где History является primary surface) → текст дописывается в tab-scoped History draft с сохранением прикреплённых изображений и фокусом видимого composer. Нельзя доставлять его в скрытый xterm: пользователь должен видеть и редактировать ровно тот текст, который будет отправлен.
- **`pty-claude` / `pty-codex`** → legacy/явный TUI-owner path через `ipcRenderer.invoke('terminal:paste', {tabId, content, submit: false})`. Он остаётся для поверхностей, где видимым владельцем действительно является PTY, но normal History-primary табы выбирают `history`.
- **`terminal`** (обычный шелл / нет активного Claude) → только в историю. Floating-окно остаётся **единственным** способом увидеть транскрипт (плюс копировать из dropdown).

Во всех режимах `appendDictationEntry(text)` в localStorage — список прошлых транскриптов доступен независимо от того куда они улетели.

## История диктовки — ⌘-click по mic, не отдельный toolbar-чип

Раньше история жила отдельной кнопкой-чипом `history` в верхней полосе кнопок (`DictationHistoryButton`). Убрана: история — **вторичное** действие над тем же микрофоном, не самостоятельная кнопка верхней полосы. Теперь обычный клик по mic = запись (старт/стоп), **⌘-click** (Ctrl на не-Mac) = открыть/закрыть popover истории. `DictationHistoryButton` стал именованным `DictationHistoryPopover` — только панель (без своего триггера), рендерится через Portal **над** mic-кнопкой (тот же rAF-anchoring через `getBoundingClientRect`, что у live floating-окна — control bar внизу окна, popover открывается вверх). Click-outside/Esc закрывают; geometric hit-test против панели **и** якоря, чтобы повторный ⌘-click по mic корректно тоглил, а не дабл-фарил (mic onClick проверяет `e.metaKey || e.ctrlKey` → `preventDefault` + toggle, обычный клик в эту ветку не заходит).

## Floating window: Portal + rAF anchoring

Окно рендерится через `createPortal(<div>, document.body)`. Причина: control-bar внутри `overflow:hidden`-ancestors, обычный child был бы клипнут. Позиция вычисляется через `getBoundingClientRect()` на mic-кнопке в каждом `requestAnimationFrame` — окно тогда **следует** за кнопкой при resize / layout shift без явного listener'а. Левый край clamp'ится так чтобы окно не вылезало за viewport (`width: 320`, защита `right > window.innerWidth - 8`).

Фиксированная высота 110px (~6 строк @ 13px/1.42 line-height) — **не растёт с контентом**. Переполнение → внутренний скролл. Юзер: *«начальная высота должна оставаться, по мере того как печатается должен скролл, не высота»*.

Header — высота 22px, padding=0 по вертикали (только padding'и кнопок), горизонтальный padding 8px. Справа две кнопки с зазором 1px: `X` отменяет диктовку полностью (закрывает stream/window, не пишет историю и не доставляет текст), `STOP` финализирует и доставляет текст в owner-tab; во время `stopping` у STOP маленький спиннер.

Final tokens — белый `#e0e0e0`, partial — серый italic `#aaa`. Auto-scroll к bottom на каждом update.

## State machine

`dictationManager`: `idle → recording → stopping → idle` (плюс короткий transient `recording`-while-connecting который для UI неотличим от полноценного recording — иконка оранжевая, floating-окно открыто, юзер уже говорит, фоном идёт ws-handshake). `MicButton` не владеет этой machine: owner-tab получает активные controls, non-owner live tabs получают disabled mic, а скрытый owner получает top-right status-row.

## Enter во время диктовки

В живой Claude/Codex-вкладке пользователь может нажать `Enter` в ControlBar пока микрофон ещё пишет. Семантика этого жеста: «заверши диктовку, вставь распознанный текст в видимый composer, потом отправь». Нельзя сразу слать raw `\r`: в History-primary режиме это отправило бы скрытый TUI input вместо только что сказанного текста. Нельзя и просто остановить микрофон без submit: пользователь нажал Enter именно как send-action.

`dictationManager` публикует window-события состояния (`dictation:state`) и принимает `dictation:stop-and-deliver` с `requestId`. Если состояние `recording`, Enter сначала просит stop; если уже `stopping`, новый stop не запускается, Enter просто ждёт delivery. После финализации manager доставляет текст по mode owner-tab'а и только после успеха шлёт `dictation:delivered` вместе с этим mode. ControlBar держит `enterPending` loader только когда `snapshot.owner.tabId === tabId`; чужие вкладки не должны ждать чужую диктовку и не должны наследовать pending-state keyless-компонента.

Для `history` после delivery signal ControlBar вызывает `history-panel:submit-composer`: canonical History action заново читает актуальный tab-scoped draft и владеет readiness, attachments, rollback и отправкой. Для legacy PTY mode сохраняется `terminal:paste submit:false` → delivery signal → raw `\r`; paste path сам отвечает за bracketed paste и render-commit. В обоих случаях submit идёт после подтверждения, что текст уже стал состоянием правильного input'а, а не по фиксированной задержке.

Если пока `enterPending=true` пользователь жмёт `^C` в ControlBar, pending Enter отменяется (`cancelPendingEnterRef`), а в PTY уходит одиночный raw Ctrl+C. `dictation:delivered` всё ещё может прийти и вставить финальный текст в правильный composer, но автоматический History Send/raw `\r` после него уже не выполняется. Это разделяет два намерения: «доставь текст» и «отправь текст». `^C` отменяет второе, не пытаясь откатывать уже запущенный Soniox stop/delivery pipeline.

`stop()` идемпотентен и имеет fallback-таймаут:
- Если `ws.readyState === OPEN` — шлёт пустой ArrayBuffer (Soniox flush'ит финалы и закрывает) + safety 3-секундный таймер на случай зависшего WebSocket.
- Если `ws` в CONNECTING / null — отсоединяет handlers ПЕРЕД `close()` (иначе async `onerror`/`onclose` triggered `close()`-ом на half-opened сокете показал бы юзеру toast «socket error» после его же STOP-клика).
- `MicButton.stop()` дополнительно ставит 4-секундный fallback на случай если `onStopped` не пришёл вовсе.

`cancel()` — отдельный от STOP путь: UI сразу публикует owner idle и сбрасывает snapshot, pending Enter получает `delivered=false`, а `DictationSession.cancel()` закрывает WebSocket/mic с отсоединёнными handlers и suppress'ит `onStopped`. Это нужно, чтобы крестик в floating-окне был именно «полная отмена», а не короткая форма STOP.

## ID вкладки в живую запись Voice Record

RMB-вставка ID идёт в обратном направлении: терминал выбирает идентификаторы,
Voice Record владеет текущим transcript и решает, может ли принять их сейчас.
HTTP выполняется только из main, CSP renderer не расширяется. Discovery проверяется
живым authenticated `/api/me`, мутация привязана к его PID и подтверждается exact
recording renderer. С26.09 отсутствие записи начинает новую в уже запущенном VR;
дожимающийся дубль продолжает завершаться отдельно. Текущая ручная пауза
сохраняется. Это отличается от phone `share-text`, который может намеренно
поставить микрофон на паузу. Вариант `+ часы` передаёт время самого клика:
в VR оно отображается с датой, в UTC до минуты, рядом с выбранными ID.
Это ориентир поиска логов после замеченного сбоя, не точная секунда инцидента.
Закрытый VR даёт error-toast; новая кнопка требует capability version2, чтобы
старый сервер не мог молча отбросить время. Повтор после timeout не автоматический,
поскольку ответ мог потеряться после вставки. Вид ID в VR определяется грамматикой
текста, поэтому clipboard-paste подсвечивается так же.

## Вставка из Voice Record через буфер обмена

В clipboard-пути внешнего Voice Record голосовая вставка остаётся обычным
редактируемым текстом независимо от порога `Pasted Content`. Это правило действует
для History, SDK и Run After; поддержка clipboard в SDK не означает поддержку
незавершённых dictation-чипов, описанных ниже. Обычные Copy/Insert сохраняют порог.

Native-признак речи — `com.noted.voice-record.dictation`, резервный HTML содержит
`data-voice-record-dictation="1"`; старый MIME `application/x-voice-record-dictation`
также распознаётся. macOS/Electron могут скрыть native UTI из `availableFormats()`
и DOM paste, поэтому отсутствие в списке не доказывает отсутствие метки:
общий reader проверяет `readBuffer()`. Чтение метки из системного буфера разрешено
только при совпадении его текста с текущим paste event, с нормализацией лишь CR/LF —
более позднее содержимое буфера не должно менять классификацию старой вставки.
Изображения проходят свой разбор перед text-only исключением диктовки.

Проверка приёмника — `composerChips.test.mjs` (скрытый native-формат, HTML fallback,
замена буфера, пробелы и CR/LF); запись item и совместимость со старым helper —
voice-record `fact-native-helpers.md::Пометка речи и совместимость со старым cgpaste`.

## Диктовка Voice Record как чип в композере (dictation chips)

Frontmost-proof принадлежит Voice Record и должен быть живым: совпадение PID с
`web-server-<pid>.json` недостаточно после повторного использования PID системой.
22.09 старый файл от19.06 сPID528 направил две записи из Яндекса на7878/NT PID23136;
History помнил DOM-focus в фоне и принял их. VR теперь проверяет `/api/me.service`
(`name`, `pid`) до begin; старые NT проходят через доказательство владельца
LISTEN-порта. Проверка PID только в ответе begin уже опаздывает, поскольку чип
вставлен. Это ремонт отправителя: установленный NT с текущим health API поддержан
без переустановки; ослаблять ожидание позднего History focus не требуется.

Глобальная диктовка Voice Record (Alt+`), завершённая пока наш History-композер
в фокусе, приходит НЕ через Cmd+V. Voice Record в момент финиш-жеста зовёт
`POST /api/dictation-chip/begin` (web-server → bridge `dictationChipBegin`):
renderer определяет владельца по реально сфокусированному History-композеру и в том же вызове
ставит инлайн-маркер `[Dictating vr-<ts>]` в каретку. Дальше Voice Record
дожимает хвост речи у себя и присылает `dictationChipResolve` — текст заменяет
маркер там, где тот стоит. Не accepted (не тот таб, композер не в фокусе, API
недоступен) → Voice Record молча падает обратно в старый Cmd+V; отказ всегда
безопасен.

Stop может чуть опередить постановку каретки. Если в выбранном по PID инстансе
ещё не выбрано поле ввода, bridge до 6 секунд ждёт `focusin`. History-composer
получает чип сразу в появившуюся каретку; xterm/SDK/другое редактируемое поле
сразу возвращает `other-input-focused` для обычной вставки. Уже сфокусированное
поле вне History вообще не запускает ожидание. Другой app не становится новой
целью, а timeout при отсутствии выбора сохраняет обычный fallback.

Первичная проверка и подписка выполняются синхронно, чтобы не пропустить focus edge.
Владелец определяется по DOM-композеру раньше сохранённого selected-tab pointer;
указатель может отстать в split-раскладке. Insert-listener по-прежнему обязан
синхронно подтвердить вставку; один settle снимает подписку и таймер.

Шрам 15.09: готовый текст Voice Record лишние 4,67с ждал `composer-focus-timeout`.
Перед Stop focus-диагностика NT показывала `textarea.xterm-helper-textarea`, но гейт
считал любой фокус вне History отсутствием выбранного поля. Новый лог
`[DictationChip] bypass ... reason=other-input-focused tag=... xterm=...` доказывает
быстрый выбор обычной вставки; timeout теперь отдельно записывает текущий DOM target.
Проверка `dictationFocus.runtime.test.mjs` выполняет настоящий App bridge: текущий
и поздний xterm/SDK, поздний History, устаревший selected-tab, отсутствие поля до
timeout. Изолированный Electron с настоящим DOM подтвердил те же focus-переходы.

Устройство — ровно та же грамматика, что у `[Pasted Content …]`/`[Image #N]`:

- **Маркер в тексте черновика = durable-половина.** Переживает рестарты, undo,
  переключение табов, background-драфты. Грамматика: `dictationChips.mjs`
  (marker/resolve/reconcile/labels), volatile-реестр (label, status, armed) —
  `dictationChipRegistry.mjs`, модульный синглтон. Сирота после рестарта
  реконсилится в `stale` — «⏸ … — повторить», не сырые скобки.
- **Токен-слой:** kind `pending` / `error`, оба `replace:true` — маркер
  удаляется Backspace'ом как один объект; word-motion включает его диапазоны.
  Цвет: оранжевый — цвет записи самого Voice Record, поэтому pending несёт
  его как акцент (пульс-точка #f5a623 + тихая оранжевая рамка), но ТЕКСТ
  остаётся серым — лейбл стримит живой хвост распознавания, целиком оранжевая
  строка утомляла бы. Error — та же семья на полную громкость: янтарный текст,
  рамка сильнее, точка застыла; клик = ретрай через IPC `dictation-chip:retry`
  в main → VR `/api/dictation-chip/retry` (из renderer'а нельзя — CSP
  `connect-src 'self'`). Точка пульсирует background-color'ом — не opacity.
  Shared ComposerEditor сначала отдаёт клик по pending/error-токену host-обработчику:
  иначе его source-reveal раньше ретрая раскрывал сырой `[Dictating …]`. Обработанный
  mouseup не должен повторно доставляться тем же native click.
- **Живой хвост в лейбле:** пока дубль дожимается, VR шлёт
  `POST /api/dictation-chip/progress` (bridge `dictationChipProgress` →
  `updateDictationChipLabel`) — лейбл чипа показывает ПОСЛЕДНИЕ слова
  распознанного («… хвост фразы»), обновляясь в реальном времени. Registry-only:
  маркер в тексте не меняется, поэтому тик не гоняется с правкой пользователя
  и работает в фоновой вкладке. Обновляется только pending-чип — error/stale
  лейбл заморожен как улика.
- **Каретка принадлежит пользователю.** Resolve заменяет маркер там, где тот
  стоит, а выделение пересчитывает через
  `remapPromptImageSelectionAfterReplacement` от ЖИВОЙ каретки (фокусный
  редактор → его selection, иначе сохранённая): пользователь, продолживший
  печатать в другом месте, остаётся где был; каретка, не тронутая с момента
  вставки (стоит сразу за маркером), по той же арифметике оказывается в конце
  раскрытого текста. Прежний force `selectionStart: resolved.caret` — баг:
  уводил каретку в конец диктовки, хотя её уже переставили.
  Если после чипа вставлено изображение, каретка после изображения остаётся после
  него. Прежний ошибочный fallback в `background-draft` обходил также передачу
  пересчитанного selection: поэтому в старом приложении каретка могла оставаться
  внутри длинного раскрытого текста. Ремонт listener восстанавливает этот путь;
  дополнительный принудительный перенос в конец не нужен.
- **Чипы невидимой вкладки видны в углу приложения.** Пока вкладка на экране,
  о дубле говорит сам чип в композере; когда вкладка скрылась (другая вкладка
  её окна, другой workflow, Home) — в правом верху появляется строка
  «ДИКТОВКА → имя вкладки» с лоадером (или «ДИКТОВКА: ОШИБКА»), клик ведёт к
  вкладке (`DictationChipBackgroundStatus` в Toast.tsx). Ответ «видна ли
  вкладка» — оконный, тот же, что у фоновых операций History
  (`historyOperationOwnerView`: pane-раскладка учитывается, фокус — нет).
  Клик по имени в угловой строке сначала находит размещение вкладки, затем
  активирует её существующее окно и workflow (`openHistoryOperationOwner` →
  `placeTab`). Старый путь вызывал `switchTab` напрямую: тот до поиска места
  записывал вкладку как активную в текущем workflow, из-за чего поиск принимал
  текущий экран за её владельца и заменял вкладку в текущем окне. Тот же
  переход используют угловые статусы RECORDING и фоновых операций History.
  RECORDING-лоадер живой диктовки MicButton переведён на тот же ответ: раньше
  он требовал `effectiveTabId === ownerTabId` и выскакивал, когда вкладка
  просто потеряла фокус, оставаясь видимой соседним окном. После успешной
  замены последний loader на 700мс становится зелёным `✓ ГОТОВО`, затем
  исчезает: переход виден, но постоянный done-status не занимает угол.
- **Send-гейт:** любой dictation-маркер в черновике блокирует отправку
  (pending отправил бы плейсхолдер вместо речи, error — мусор в скобках).
  Enter и Option+1 — одно намерение отправки: при pending они ВЗВОДЯТ
  авто-отправку (фиолетовый ⏎ в ярлыке чипа; «отправь, как долетит»), а при
  готовом тексте Option+1 идёт в тот же canonical submit, что обычный Enter.
  У pending-чипа ⏎ виден и в выключенном состоянии серым: клик по чипу
  переключает взвод только этой записи, фиолетовый ↔ серый. Error/stale-клик
  по-прежнему запускает повтор распознавания, а не меняет Auto-Enter.
  Повтор неизменного флага от Voice Record в финальном ответе не отменяет
  локальный клик; текст маркера и позиция каретки при переключении не меняются.
  Распознавание Option+1 идёт по `Digit1`, а для первого macOS dead-key event
  без `code` — по однозначному `keyCode=49`; символ `¡` в текст не попадает.
  Ручная печать СНИМАЕТ взвод (`isProgrammaticDictationEdit` отличает замену
  маркера от печати).
  Событие `history-panel:submit-composer` держит ту же логику, поэтому
  ControlBar-Enter и авто-отправка проходят одну дверь. Авто-отправка стреляет
  только когда в черновике не осталось ни одного pending-чипа.
- **Auto-Enter может прийти после Stop.** Voice Record обновляет уже видимый
  чип через `POST /api/dictation-chip/auto-send` → `dictationChipAutoSend`; последний
  `resolve` повторяет тот же `autoSend` вместе с текстом. Это повтор последнего
  выбора Voice Record, а не новая команда пользователя: реестр отдельно помнит
  последний remote-флаг и применяет только его изменение. Иначе финальный false
  отменял поздний Option+1 в History, а финальный true вновь взводил отправку после
  ручной печати. Изменившийся remote-флаг может догнать пропущенный промежуточный
  запрос; неизменившийся сохраняет локальный выбор. После переноса в Run After эти
  обновления игнорируются: временем отправки уже владеет очередь, а не диктовка.
- **Переход из Voice Record:** в карточке дораспознавания клик по чипу имени
  вкладки вызывает `POST /api/dictation-chip/open` у того экземпляра NT,
  который принял дубль. Запрос несёт точный tabId и PID принятого экземпляра;
  сервер сверяет PID до перехода и применяет то же правило существующего
  размещения, затем поднимает окно NT. Старый терминал без этого endpoint'а
  отвечает 404: Voice Record показывает ошибку в карточке, а саму диктовку,
  чип и повтор распознавания это не отменяет.
- **Удалённый маркер = отмена вставки.** Поздний resolve по нему — no-op
  (`resolved:false, reason:marker-deleted`), текст НЕ воскресает; речь остаётся
  в истории Voice Record.
- **Resolve в фоновый таб** (юзер ушёл, панель не смонтирована): текст
  подставляется прямо в store-драфт (`setHistoryPromptDraft`), взведённая
  авто-отправка откладывается (`deferDictationSubmit`) и стреляет один раз при
  маунте панели, только если черновик ровно тот же.
  Открытый composer обязан завершить resolve и отправку без remount. Нативный
  `dispatchEvent` не передаёт исключение слушателя вызывающему App: поэтому
  отсутствие settle само по себе раньше ложно превращало сбой обработчика в
  `background-draft` с вечным ожиданием mount. Теперь listener сообщает
  `panel-error` и пишет `[DictationChip] resolve-handler-error` с chip/tab;
  bridge возвращает ошибку доставки, а не успешную фоновую вставку.
  Перед запланированным auto-submit заново сравнивается полный текст черновика:
  ручная правка между resolve и следующим кадром также отменяет отправку.
- **Перенос в Run After передаёт владение, а не копирует сырые скобки.** `+grab`
  сначала синхронно создаёт queue-item и переводит все его незавершённые маркеры
  на эту карточку; поиск/генерация title запускается отдельно и не задерживает
  возврат transfer. History
  очищается прежней CAS-проверкой, а поздний resolve меняет точную очередь. Пока
  маркер есть, Replay и runner заблокированы; если условие Run After уже наступило,
  сохраняется именно эта попытка и продолжается после исчезновения последнего
  маркера. Прямой `autoSend` диктовки при переносе снимается — временем теперь
  владеет очередь. Удаление маркера/карточки отменяет позднюю вставку.
- **Изображения входят в тот же результат.** Voice Record присылает переносимые
  image-path'ы, main терминала до публикации делает собственные durable sidecar'ы,
  а History или Run After получает текст с `[Image #N]` и соответствующими refs.
  Progress-тик по-прежнему меняет только label и не имеет права трогать вложения.
- **После Send происхождение диктовки не теряется.** Resolve сначала даёт
  History обычный редактируемый текст. Если Claude занят, этот текст может
  пройти через provider queue, а при материализации user-row Claude обернёт
  длинную bracketed paste в `<pasted_content id=…>`. Exact confirmed receipt
  сохраняет исходный plain request и queue source identity; presentation-sidecar
  привязывается к появившемуся UUID по этой identity и снимает только внешнюю
  provider-оболочку. Настоящий paste-чип внутри исходного текста остаётся чипом.
  Совпадение текста/времени, чужой source или другой body ничего не разворачивают.
  Шрам tab171: dictation chip успешно resolved1494/auto-send, composer имел
  `chips=0`, но queue settlement раньше не создавал authoring-sidecar и History
  показывала весь prompt как `Pasted Content 1 494 chars`.

Гейт «наш ли инстанс» на стороне VR — по pid из discovery
`~/.noted-terminal/web-server-<pid>.json` (dev под `com.github.Electron`, по
bundle не отличить). Ретрай идемпотентен: `vr-<ts>` = timestamp записи в
истории VR, повтор пере-распознаёт сохранённый wav после любого рестарта.
Сторона VR (отвязка окна записи в бейдж, гонка gate/final, батч-фоллбек) —
voice-record `docs/knowledge/fact-терминальный-чип-диктовки.md`. Тесты:
`dictationChips.test.mjs`, `dictationChipPanel.wiring.test.mjs`,
`dictationCompletion.runtime.test.mjs`. Последний исполняет bridge → фактический
listener → submit с реальными импортами потребителя: подстановка всех экспортов
helper-модуля в sandbox скрывала отсутствующий импорт и давала ложный PASS.
Первоначальная E2E-проверка поймала send-event и смену ярлыка, но не доказала
автоотправку после resolve; `background-draft` открытой панели нельзя списывать
на тестовый канал. Приёмка этого пути требует фактической отправки и ответа
агента без переключения вкладки, а каретки — позиции следующего введённого символа.

## Production env: `~/.noted-terminal/.env`

`SONIOX_API_KEY` в production читается из `~/.noted-terminal/.env` (а не из `.env` рядом с execPath — последний переписывается при каждом `build:install`). Изменение в `main.js::loadEnvFile()`: в packaged-режиме сначала пробуем home-dir, потом fallback на execPath-папку. Dev-режим — `process.cwd()` как раньше.

## Mobile-web/dist должен быть в asar

Production-сервер на 7878 раздаёт `mobile-web/dist/index.html` по `path.resolve(__dirname, '../../mobile-web/dist')`. Из `app.asar/src/main` это резолвится в `app.asar/mobile-web/dist` — но если `mobile-web/dist/**/*` **не указан** в `build.files` в `package.json`, его в архиве нет, и phone получает «not built». Electron'ский fs прозрачно читает файлы из asar — никаких extraResources/unpack не нужно, достаточно include'а.

## Graveyard

- **`ScriptProcessorNode → gain(0) → ac.destination`** (пул через хардварный выход) — интермиттентно SIGSEGV'ил **весь рендерер** (exitCode 11, «Render frame was disposed», белый экран). Падало сразу после `audio ok`. Фикс — пул через off-device `MediaStreamAudioDestinationNode` (`processor.connect(createMediaStreamDestination())`): SPN пулится так же, но звук не доходит до CoreAudio output, крэш-путь исчезает. Захват не страдает (PCM снимаем внутри `onaudioprocess`). Применено в обоих движках (desktop + mobile-web). См. [`fix-mic-renderer-sigsegv.md`](fix-mic-renderer-sigsegv.md).
- **`navigator.mediaDevices` на mobile поверх plain http** — `undefined` (secure-context-only API). Phone грузит mobile-web по `http://<lan-ip>:7878` в dev → `.getUserMedia` бросает «Cannot read properties of undefined», юзер видел загадочное «Mic undefined». Фикс: явный guard `if (!navigator.mediaDevices?.getUserMedia)` → понятная ошибка «needs HTTPS (use Prod address)». Prod (HTTPS-туннель через VPS) работает. См. [`fact-mobile-web.md`](fact-mobile-web.md).
- **`AudioContext({sampleRate: 16000})`** — macOS игнорирует hint и AudioContext later throws на operations с device rate 44100/48000. Решение: создавать `new AudioContext()` без hint'а, читать `this.ac.sampleRate` и downsample'ить в processor.
- **Floating window только в `mode==='terminal'`** — первая версия показывала floating только когда нет активного Claude, в SDK/PTY текст лился real-time в композер через native value setter. Real-time запись в controlled-input assistant-ui отъедалась трекером, юзер видел текст «только после STOP». Решение: floating window во ВСЕХ mode'ах, real-time только там, доставка в композер — один раз по STOP.
- **`navigator.clipboard.writeText`** в истории диктовки (`DictationHistoryPopover`, бывш. `DictationHistoryButton`) — `permission denied` без active document focus в renderer. Заменено на `window.require('electron').clipboard.writeText` (см. CLAUDE.md anti-pattern).
- **`cursor: wait`** на mic-кнопке во время `stopping` — macOS поднимает system wait-cursor (волчок) поверх UI, читается как «всё приложение зависло». Заменено на `cursor: default` — спиннер внутри STOP-кнопки внутри floating-окна остаётся единственной индикацией.
- **`setState('connecting')` отдельный** — добавляет 300-700 мс «лоадера» между кликом и началом записи. Юзер: *«Loader в начале быть не должно. Запись начинается на диск локально, потом отправляется на сервак»*. Заменено на синхронный `recording=true` + локальный буфер до ws.onopen.
