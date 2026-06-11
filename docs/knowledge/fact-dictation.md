# Fact: Voice Dictation (Soniox real-time)

Real-time диктовка через Soniox `stt-rt-v4` (`wss://stt-rt.soniox.com/transcribe-websocket`). Кнопка mic живёт в `ClaudeControlBar` справа от Copy-prompt split-pill, real-time транскрипт — в floating-окне-портале над кнопкой. Финальный текст по STOP уходит в композер активного таба (SDK textarea / Claude TUI input / только история для обычного терминала) + всегда сохраняется в localStorage-историю. На мобиле — та же модель: кнопка mic в composer, такой же floating UX. См. [`fact-claude-control-bar.md`](fact-claude-control-bar.md) для размещения, [`fact-mobile-web.md::Mobile composer`](fact-mobile-web.md) для мобильной стороны. Системный аналог поверх всех приложений (Cmd+`\``, плавающий чип над Dock, paste в frontmost app) — [`fact-global-dictation.md`](fact-global-dictation.md); тот же `DictationSession` + `soniox:mint-token` переиспользуются.

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

## Архитектура: instant-record + buffered flush

Click → state `recording=true` синхронно (UI меняется в том же frame, **без `connecting`-фазы**). Параллельно:
- `getUserMedia` (~50 мс) → `AudioContext` → `ScriptProcessorNode` → handler `onaudioprocess` пишет PCM в `pending: ArrayBuffer[]`
- `fetchToken` (IPC `soniox:mint-token` или REST `/api/soniox-token` на mobile) → `new WebSocket` → handshake (~300-700 мс)

Когда `ws.onopen`: отправляется JSON config (`api_key`, `model: 'stt-rt-v4'`, `sample_rate: 16000`, `audio_format: 's16le'`, `language_hints: ['en','ru']`), потом **flush'аются все буферизованные PCM-чанки**. С этого момента `onaudioprocess` шлёт напрямую в `ws.send`. Это значит **ни одно слово не теряется в первые 300-700 мс пока ws ещё не открыт** — юзер может начать говорить сразу после клика.

Cap буфера — 200 фреймов (~4 с аудио). Если ws висит дольше — старые фреймы дропаются, но юзер давно нажмёт Stop.

## Почему ScriptProcessorNode, а не AudioWorklet

AudioWorklet требует `addModule(blob:URL)`. Electron renderer с CSP `default-src 'self'` режет blob:-скрипты с ошибкой `Refused to load the script 'blob:http://localhost:5182/...'`. Расширение CSP до `script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; child-src 'self' blob:` снимает блок, но ScriptProcessorNode работает без CSP-расширений и без blob-инфры, а латентность 4096-sample буфера (~85 мс @ 48 kHz) для речи **незаметна**. Trade-off в нашу пользу: меньше движущихся частей, не зависит от Vite/CSP-конфига.

## CSP и permission — два обязательных пререквизита

Без них `getUserMedia` reject'ит `AbortError: The user aborted a request` (юзер ничего не делал — это Electron сам режет), а `new WebSocket('wss://stt-rt.soniox.com')` сразу даёт `Refused to connect`. Оба правятся в одном спринте:

1. **CSP в `index.html`** — `connect-src 'self' wss://stt-rt.soniox.com https://api.soniox.com; media-src 'self' blob: data:`. Меняется в `<meta>` — изменения подхватываются после Cmd+R окна (hot-reload renderer не обновляет head meta).
2. **`session.setPermissionRequestHandler`** в main для `media`/`audioCapture`/`microphone` → callback(true). Без него Electron по умолчанию отвечает deny **до** того как macOS успеет показать системный prompt. macOS-уровень разрешения всё равно спросится при первом capture — это нормально.

## Endpoint markers фильтруются

Soniox реально шлёт synthetic-токены `<end>` (endpoint detection — пауза в речи) и `<fin>` (finalization) **внутри** массива `tokens` вперемежку с реальными словами. В docs они не упомянуты. Без фильтра попадали в `finalText` → в композер и в localStorage-историю. Regex `/^<[a-z_]+>$/i` отсекает любые подобные маркеры до аккумуляции.

## Three delivery modes

Решение «куда уходит текст после STOP» зависит от типа активного таба (детектится в `MicButton` через Zustand-селекторы `tabType` и `commandType`):

- **`sdk`** (claude-sdk таб) → `window.dispatchEvent('claude-sdk:dictation-deliver', {tabId, text})`. Handler внутри `SDKComposer` (НЕ в `ClaudeSDKTab` верхнего уровня) использует прямой `composerTextareaRef` + `writeComposerValue()`. Раньше handler сидел в `ClaudeSDKTab` и искал textarea через `querySelector('.absolute.inset-0:not([style*="display: none"])')` — селектор нестабилен в multi-tab layout'е, текст уходил в чужой таб. Внутри SDKComposer есть готовый `writeComposerValue` (тот же путь что Stash-restore и insert-prompt используют — гарантированно работает с assistant-ui ComposerPrimitive).
- **`pty-claude` / `pty-codex`** → `ipcRenderer.invoke('terminal:paste', {tabId, content, submit: false})`. Текст печатается в TUI input без Enter — юзер сам решит когда отправить. Codex использует тот же PTY-path, потому что у него нет отдельного React composer'а внутри приложения.
- **`terminal`** (обычный шелл / нет активного Claude) → только в историю. Floating-окно остаётся **единственным** способом увидеть транскрипт (плюс копировать из dropdown).

Во ВСЕХ трёх режимах `appendDictationEntry(text)` в localStorage — список прошлых транскриптов доступен независимо от того куда они улетели.

## История диктовки — ⌘-click по mic, не отдельный toolbar-чип

Раньше история жила отдельной кнопкой-чипом `history` в ProjectToolbar (`DictationHistoryButton`). Убрана: история — **вторичное** действие над тем же микрофоном, не самостоятельная сущность тулбара. Теперь обычный клик по mic = запись (старт/стоп), **⌘-click** (Ctrl на не-Mac) = открыть/закрыть popover истории. `DictationHistoryButton` стал именованным `DictationHistoryPopover` — только панель (без своего триггера), рендерится через Portal **над** mic-кнопкой (тот же rAF-anchoring через `getBoundingClientRect`, что у live floating-окна — control bar внизу окна, popover открывается вверх). Click-outside/Esc закрывают; geometric hit-test против панели **и** якоря, чтобы повторный ⌘-click по mic корректно тоглил, а не дабл-фарил (mic onClick проверяет `e.metaKey || e.ctrlKey` → `preventDefault` + toggle, обычный клик в эту ветку не заходит).

## Floating window: Portal + rAF anchoring

Окно рендерится через `createPortal(<div>, document.body)`. Причина: control-bar внутри `overflow:hidden`-ancestors, обычный child был бы клипнут. Позиция вычисляется через `getBoundingClientRect()` на mic-кнопке в каждом `requestAnimationFrame` — окно тогда **следует** за кнопкой при resize / layout shift без явного listener'а. Левый край clamp'ится так чтобы окно не вылезало за viewport (`width: 320`, защита `right > window.innerWidth - 8`).

Фиксированная высота 110px (~6 строк @ 13px/1.42 line-height) — **не растёт с контентом**. Переполнение → внутренний скролл. Юзер: *«начальная высота должна оставаться, по мере того как печатается должен скролл, не высота»*.

Header — высота 22px, padding=0 по вертикали (только padding'и кнопок), горизонтальный padding 8px. STOP-кнопка справа с маленьким спиннером во время `stopping`.

Final tokens — белый `#e0e0e0`, partial — серый italic `#aaa`. Auto-scroll к bottom на каждом update.

## State machine MicButton

`idle → recording → stopping → idle` (плюс короткий transient `recording`-while-connecting который для UI неотличим от полноценного recording — иконка оранжевая, floating-окно открыто, юзер уже говорит, фоном идёт ws-handshake).

## Enter во время диктовки

В живом Claude/Codex PTY пользователь может нажать `Enter` в ControlBar пока микрофон ещё пишет. Семантика этого жеста: «заверши диктовку, вставь распознанный текст в composer, потом отправь». Нельзя сразу слать raw `\r`: это отправило бы старый TUI input без только что сказанного текста. Нельзя и просто остановить микрофон без submit: пользователь нажал Enter именно как send-action.

`MicButton` публикует window-события состояния (`dictation:state`) и принимает `dictation:stop-and-deliver` с `requestId`. Если состояние `recording`, Enter сначала просит stop; если уже `stopping`, новый stop не запускается, Enter просто ждёт delivery. После финализации `deliverFinal()` делает обычный delivery (`terminal:paste submit:false` для PTY, SDK event для SDK, history-only для обычного terminal) и только после успешной доставки шлёт `dictation:delivered`. ControlBar держит `enterPending` loader всё это время и после matching `requestId` отправляет raw `\r` в PTY.

Для PTY `terminal:paste submit:false` остаётся обязательной промежуточной фазой даже когда следующий шаг — Enter. Paste path сам отвечает за bracketed paste и render-commit; raw `\r` идёт только после delivery signal. Это тот же принцип что у TUI-команд: submit должен идти после подтверждения, что текст уже стал состоянием input'а, а не по фиксированной задержке.

`stop()` идемпотентен и имеет fallback-таймаут:
- Если `ws.readyState === OPEN` — шлёт пустой ArrayBuffer (Soniox flush'ит финалы и закрывает) + safety 3-секундный таймер на случай зависшего WebSocket.
- Если `ws` в CONNECTING / null — отсоединяет handlers ПЕРЕД `close()` (иначе async `onerror`/`onclose` triggered `close()`-ом на half-opened сокете показал бы юзеру toast «socket error» после его же STOP-клика).
- `MicButton.stop()` дополнительно ставит 4-секундный fallback на случай если `onStopped` не пришёл вовсе.

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
