# Fact: Global Dictation (system-wide voice input)

Глобальная диктовка через системный hotkey (default `Alt+\``, не `Cmd+\`` — он зарезервирован macOS под «Move focus to next window», `globalShortcut.register` возвращает true, но callback не fires) и плавающий чип над Dock. Работает поверх любого приложения: STOP активирует target-app через `tell application id "<bundle>" to activate` и шлёт `keystroke "v" using command down` (плюс Return при Auto-Enter) — текст вставляется в то поле, где сейчас курсор. Транскрибация через ту же Soniox-инфраструктуру что и in-tab диктовка ([`fact-dictation.md`](fact-dictation.md)), включая `soniox:mint-token` IPC и `DictationSession` класс — переиспользуются, не копируются.

Source: `src/main/global-dictation/index.js`, `src/global-dictation-renderer/{chip,recording,menu}.tsx`, `src/renderer/components/UI/GlobalDictationSettings.tsx`. Hooks into `main.js` рядом с другими `ipc/*.register()` вызовами.

## Симптомы для роутера

- Alt+\` (или `Cmd+\``) не запускает запись (или не останавливает повторно)
- Hotkey-capture в Settings показывает «Alt+Dead» вместо «Alt+\``» — dead-key macOS
- Hotkey-capture показывает «Alt+å» / «Alt+π» — macOS Opt+letter → typographical character
- Hotkey-capture на не-latin раскладке (Cyrillic, Dvorak) выдаёт «Cmd+ф» или путаницу
- Чип появляется, но клик не делает ничего / выглядит «прозрачным»
- Чип следует за курсором без зажатой кнопки мыши после первого клика
- Меню над чипом не закрывается — нажал X, оно мгновенно открылось обратно
- Текст после STOP вставляется **в наше же приложение**, а не в Claude TUI / Telegram
- Текст после STOP не вставляется в чужое приложение → toast «paste failed: osascript exit 1»
- macOS не показывает prompt про Accessibility, хотя приложение его требует
- Чип не на том дисплее, не в нужной позиции, не запоминает положение после rebuild
- Recording-окно появилось как белый прямоугольник, никакой UI не рендерится, в логах пусто
- `globalShortcut.register returned false` — конфликт с системным хоткеем (Spotlight, IME, Cmd+\`)
- Stopping-плашка незаметна, юзер не понимает что произошло после STOP
- Recording-окно стартует пустым (только header), не растёт когда юзер говорит
- Auto-Enter переключился в чипе во время записи — после следующего старта снова OFF
- В history лежат пустые entries или несостоятельный JSON
- Cancel hotkey (Esc) перехватывается в чужих приложениях, надо вынести на Cmd+Esc

## Архитектура: четыре независимых BrowserWindow

```
                 main process (src/main/global-dictation/index.js)
                  │
                  ├── 3× globalShortcut.register: hotkey / autoEnterHotkey / cancelHotkey
                  │
                  ├── chipWindow   (220×56, always-on-top, transparent, focusable:FALSE +
                  │                 acceptFirstMouse — клик ловится, но фокус остаётся у
                  │                 target app. Показывает либо круглую mic-кнопку
                  │                 (idle), либо row из 3 кнопок (X / Auto-Enter pill /
                  │                 Stop) когда recording).
                  │
                  ├── menuWindow   (200×168, always-on-top, transparent, focusable:TRUE
                  │                 ради receive blur event. Popover из 3 кнопок:
                  │                 Open App / Speak / Copy. Закрывается по blur с
                  │                 300ms cooldown, чтобы клик по чипу не открывал
                  │                 заново сразу же).
                  │
                  └── recWindow    (320×N, always-on-top, transparent, focusable:FALSE.
                                    Стартует со «свёрнутой» высотой ~48px (только
                                    header), растёт сверху по мере появления строк
                                    транскрипта до `transcriptLines × lineHeight`.
                                    Дальше — внутренний скролл, нижний край фиксирован
                                    относительно chip).
```

Recording-window владеет `DictationSession` локально — Soniox WS открывается из renderer'а, не из main. Это позволяет переиспользовать `utils/dictation.ts` 1-в-1 и держать всю аудио-логику в браузерном контексте (`getUserMedia` + `AudioContext` живут в renderer). Main process только:
1. Триггерит `global-dict:rec:stop-request` / `cancel-request` (от любого из трёх хоткеев или от кнопок чипа).
2. Принимает `global-dict:rec:final` с готовым текстом.
3. Делает `pasteToFrontmostApp(text, autoEnter)` — с предварительной активацией captured target app.

## Почему `focusable: false` И на chip, И на recording

`BrowserWindow({ alwaysOnTop: true, focusable: false })` — окно появляется поверх, но не отбирает фокус у текущего приложения. Это **обязательно** и для recWindow, и для chipWindow: иначе frontmost-app становится наш Electron, и `osascript ... keystroke "v"` вставит в нас же. Раньше chip был `focusable: true` («чтобы клик работал»), и юзер репортил *«когда я нажимаю кнопку микрофона, у меня курсор пропадает с основного приложения»* — это ровно та проблема, фокус-краш каждый клик на чип. **Решение** — `focusable: false` + `acceptFirstMouse: true`: клик регистрируется через первичный mouse-event без активации окна. Принцип переносимый, см. [`methodology/design.md::Overlay не должен забирать фокус`](../methodology/design.md).

menuWindow остаётся `focusable: true` сознательно — нам нужен `blur` event для авто-закрытия popover'а. Альтернатива (global-mousedown hit-test) добавляет код без пользы, плюс blur приходит мгновенно при клике вне menu, что для popover-семантики ровно то что нужно. Цена — клик на menu забирает фокус у target app, но это OK: после select main снова реактивирует target через captured bundle id перед keystroke.

Перед `pasteToFrontmostApp` всегда `closeRecWindow()` + **100ms wait** — даём macOS WindowServer'у время переключить frontmost обратно с нашего window stack на target app. Меньше — встречается race где `keystroke` уходит до flip'а. Это поверх activate'а через AppleScript — двойная страховка.

## AppleScript paste flow + target-app capture

```applescript
tell application id "com.target.bundle" to activate    -- если есть targetAppBundleId
delay 0.08
tell application "System Events" to keystroke "v" using command down
delay 0.05                                              -- только если autoEnter
tell application "System Events" to key code 36         -- 36 = Return
```

```js
const prevText = clipboard.readText();
clipboard.writeText(text);                              // наш текст
spawn('osascript', ['-e', script]);
setTimeout(() => clipboard.writeText(prevText), 600);   // restore
```

**Target capture происходит до того как любое наше окно становится frontmost** — иначе мы зафиксируем сами себя. Конкретно `captureFrontmostApp()` (через `tell application "System Events" to get bundle identifier of first application process whose frontmost is true`) вызывается:
- в `openMenuWindow` — fire-and-forget сразу, потому что popover становится frontmost через ~30-50ms (osascript успевает завершиться раньше).
- в hotkey callback — `await`'ом при transition idle→recording (на stop рекапчур не нужен — мы уже знаем target с момента старта).

Без этой капчуры был воспроизведённый bug *«вставка через раз попадает в Noted Terminal вместо Claude TUI»*: юзер открывал чип/меню, наше окно становилось frontmost, потом paste шёл «в активное приложение» (=мы). Принцип переносимый, см. [`methodology/design.md::Capture-then-restore foreground app`](../methodology/design.md).

Save-restore clipboard обязательное — без него мы перетираем юзерский clipboard, что больно для тех кто параллельно копирует код. 600 ms restore-delay — должно быть БОЛЬШЕ чем время прохода Cmd+V через target app (некоторые composers/SDK читают clipboard несколько раз после первой вставки), но НЕ настолько долго чтобы юзер заметил «застряло чужое».

Возврат `osascript exit code` != 0 = почти всегда **нет Accessibility permission**. Показываем toast в main app через `mainWindow.webContents.send('global-dict:paste-failed', { error })`. После rebuild — проверь [`fact-codesign-tcc.md`](fact-codesign-tcc.md), TCC привязывает grant к code-signing requirement.

## Accessibility permission gate

`systemPreferences.isTrustedAccessibilityClient(false)` — `false` означает «not granted yet, but **don't prompt**». В UI settings показываем плашку «требуется разрешение» + две кнопки: «Открыть System Settings» (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`) и «Проверить разрешение» (`isTrustedAccessibilityClient(true)` — last arg `true` триггерит OS prompt **один раз**, если ещё не было решено).

Toggle «Включить глобальную диктовку» **disabled** пока permission не дан — иначе хоткей зарегистрируется, но первый же STOP кончится paste failure'ом и юзер не поймёт почему. Лучше явный gate.

Production-сборка должна быть **подписана** Apple Developer ID и нотаризована, иначе macOS отказывается давать Accessibility приложению (system pane показывает галочку, но симуляция Cmd+V всё равно падает). Локально в dev — `electron .` с unsigned'ом работает после первой ручной выдачи разрешения, потому что система запоминает по path-у бинаря.

## Hotkey capture в settings: `e.code`, не `e.key`

`globalShortcut.register` принимает строку в формате Electron Accelerator (`CommandOrControl+Shift+T`). Утилита `eventToAccelerator(KeyboardEvent)` в `GlobalDictationSettings.tsx` собирает строку из модификаторов + физической клавиши через **`e.code`** (`KeyA`, `Backquote`, `Digit1`), а не `e.key`. Три причины:
- **macOS dead-keys**: `Opt+\`` — это grave/umlaut dead-key combiner, `e.key === 'Dead'`. Захват по `e.key` сохранит accelerator `Alt+Dead`, которого `globalShortcut` не знает → registration возвращает false без подсказки почему. `e.code === 'Backquote'` стабильно.
- **Opt+letter на mac → typographical**: `Opt+A → å`, `Opt+P → π`, `Opt+L → ¬`. `e.key` вернёт символ — не «A». Юзер увидит `Alt+å` в Settings, не сможет повторить хоткей с клавиатуры.
- **Non-latin раскладки**: на Cyrillic `e.key === 'ф'` для физической `KeyA`. `e.code === 'KeyA'` одинаков на QWERTY/Cyrillic/Dvorak.

Принцип переносимый, см. [`methodology/design.md::Hotkey capture`](../methodology/design.md).

Маппинг: `Backquote → \``, `Minus → -`, `KeyA..KeyZ → A..Z`, `Digit1..9 → 1..9`, `F1..F24` напрямую, специальные (`Escape → Esc`, `ArrowUp → Up`, `Enter → Return`). Modifier-only сочетания запрещены — Esc во время capture = abort. Backspace в режиме capture опциональных хоткеев (`autoEnterHotkey`, `cancelHotkey`) очищает значение — «отключить».

Default основного hotkey — `Alt+\``, не `Cmd+\``: macOS использует `Cmd+\`` для системного «Move focus to next window in application». `globalShortcut.register('CommandOrControl+\`')` возвращает true (мы получаем подтверждение), но callback **никогда не fires** — macOS перехватывает на уровне Window Server раньше. Симптом в логах: `[GlobalDict] hotkey registered: CommandOrControl+\`` есть, `HOTKEY FIRED` после нажатия — нет.

## Три типа hotkey

`registerHotkey()` регистрирует до трёх отдельных accelerators (любой можно оставить пустым → не регистрируется):
- **`hotkey`** (default `Alt+\``) — главный toggle. Idle → start recording, recording → stop+paste. Re-press во время stopping игнорируется.
- **`autoEnterHotkey`** (default пустой) — переключатель Auto-Enter pill. Во время recording flip'ает `sessionAutoEnter` (живой стейт текущей сессии). Вне recording flip'ает `autoEnterDefault` в settings (с persist'ом). Обе ветки broadcast'ят state → pill в чипе и toggle в Settings перерендериваются.
- **`cancelHotkey`** (default `Esc`) — drop текущей записи без вставки. Срабатывает только если `state === 'recording'`. `Esc` выбран по умолчанию как «универсальный отмена», но можно очистить (Backspace в capture) или заменить на `Cmd+Esc` если Esc нужен другим приложениям.

При изменении любого из них через `settings:set` — `registerHotkey()` зовётся целиком (unregister всех трёх + re-register с новыми значениями). Никаких partial-update'ов: globalShortcut Electron'а простой, дешевле перерегистрировать все три, чем диффать.

## sessionAutoEnter vs autoEnterDefault

`autoEnter` имеет **два** независимых значения:
- `settings.autoEnterDefault` (persistent в JSON) — что мы хотим **по умолчанию** на старте каждой новой записи.
- `sessionAutoEnter` (runtime в main) — **живое** значение для текущей recording-сессии, может быть переключено pill'ом в чипе или Auto-Enter hotkey'ем.

`startRecording()` всегда делает `sessionAutoEnter = settings.autoEnterDefault` — перезаписывает live-state дефолтом. То есть переключение pill'а во время текущей записи **не остаётся** для следующей. Это сознательно: юзер описал *«при начале диктовки автоматически он [Auto-Enter] активируется. Если в настройках выключен, по умолчанию он выключен»*. Если бы persisting'или session-flip — каждое случайное нажатие на pill меняло бы persistent setting, путаница в Settings UI на следующий день.

`handleFinalTranscript` использует `sessionAutoEnter` (НЕ default), потому что юзер мог flip'нуть в чипе непосредственно перед STOP — это финальное решение для этой записи.

## chipPos persistence: % от workArea + display id, не пиксели

`chipWindow` `movable: false` (OS-уровневый drag swallow'ит клики при overlap'е с button-element'ами), поэтому drag реализован через renderer-side pointer events. На `chip:drag-end` main вычисляет позицию **центра чипа** относительно `workArea` дисплея на котором чип оказался, сохраняет:

```json
{ "cxPct": 0.512, "cyPct": 0.937, "displayId": 69734272, "x": 660, "y": 980 }
```

`x/y` — fallback для совместимости со старыми сохранёнными координатами. При load в `computeChipPosition()`:
1. `cxPct/cyPct + displayId` → найти display с этим id среди `screen.getAllDisplays()`, посчитать `cx = workArea.x + cxPct * workArea.width` и сдвинуть на полу-ширину чипа. Если display не найден (монитор отключили) → fallback на primary.
2. Старые `xPct/yPct` (corner-based, без display id) → primary display, простой apply.
3. Старые абсолютные `x/y` → as-is.
4. Default → bottom-center primary, 24px от низа workArea.

Принцип «храним %, не px» переносимый, см. [`methodology/design.md::Window pos в %`](../methodology/design.md). Юзер прямо сформулировал: *«относительно процентов, потому что я работаю на разных мониторах»*.

**Sync drag — критично без async**. Раньше `startDrag` делал `await ipcRenderer.invoke('chip:get-pos')` чтобы получить координаты окна, потом ставил `dragRef.active = true`. Между mousedown и async resolve мог пройти mouseup → `onUp` видел `dragRef === null` → early return. Затем `startDrag` resolve'ил → `active = true` → следующий innocent mousemove начинал двигать чип без зажатой кнопки. Фикс — синхронный read через `window.screenX/screenY` (Electron exposes на renderer), без IPC. Принцип переносимый, см. [`methodology/design.md::Sync state capture в gesture-handler`](../methodology/design.md). Доп. safety — в `onMove` проверка `e.buttons === 0` и принудительный drag-end (вторая страховка на случай missed mouseup).

`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` — чип виден во всех Spaces И поверх fullscreen-приложений (Final Cut, Xcode, dock'нутый Chrome). Без `visibleOnFullScreen:true` чип пропадал при fullscreen browser.

## Menu blur-cooldown

`menuWindow` `focusable: true` + закрытие по `menuWindow.on('blur')`. Когда юзер кликает на чип в открытом меню:
1. Клик на chip → menu теряет фокус → `blur` event → menu closes
2. Тот же click event → `onIdleClick` → `ipcRenderer.invoke('global-dict:menu:open')`
3. Main видит «menu закрыт» → открывает заново

Юзер видит «нажал X, ничего не закрылось». Фикс — `menuClosedAt` timestamp + `MENU_REOPEN_COOLDOWN_MS = 300`: `openMenuWindow` early-return'ит если open пришёл < 300 мс после close. 300 мс достаточно чтобы swallow'ить click-flow того же gesture, но не настолько долго что юзер заметил бы «нажал, ничего не происходит».

## Adaptive recording-window height

Окно стартует **только с header'ом** (~48px высоты, transcript-area не рендерится пока `text === ''`). По мере появления строк renderer считает `approxLineCount(text, fontSize, contentWidth)` и шлёт `global-dict:rec:resize { height }` в main. Main делает `setBounds` **anchor'ом нижнего края** — `y = oldBottom - newHeight` — чтобы окно росло вверх, а нижний край оставался прижат к чипу. По достижении `transcriptLines × lineHeight` (default 5 строк, range 2-10 из settings) — рост останавливается, внутренний скролл.

Юзер: *«по умолчанию оно нулевое, потом когда я только начал вводить текст у меня отображается первая строка [...] строка за строкой растёт всё выше»*. Принцип переносимый, см. [`methodology/design.md::Adaptive window height`](../methodology/design.md). Бывшая фиксированная высота 240px давала пустую тёмную плашку при коротких записях — некрасиво и сбивающе («что-то ждёт?»).

## Stopping plate — двойной сигнал

При `phase === 'stopping'` в recording-окне меняются **одновременно**:
- цвет статусного текста: green (`#3ecf6e`) → amber (`#f5a623`)
- иконка: animated 3-bar wave → круглый amber spinner

Только смена текста («Streaming» → «Stopping») незаметна — юзер не понимает, что что-то началось после нажатия. Принцип переносимый, см. [`methodology/design.md::Transient state двойной сигнал`](../methodology/design.md). Юзер сформулировал прямо: *«если только текст меняется, то как-то это слабо заметно»*.

## State machine

```
   idle ──hotkey/chip-click──→ recording ──STOP/hotkey──→ delivering ──paste-done──→ idle
                                  │
                                  └──X / cancel──→ idle    (no paste, drop transcript)
```

`delivering` — короткая стадия ~150 ms (100ms wait + osascript spawn). Во время неё новый старт игнорируется (`startRecording` early-return'ит если `state !== 'idle'`).

Edge case: юзер жмёт STOP в recWindow, но Soniox завис → renderer'ом установлен 3-секундный fallback `setTimeout(() => ipcRenderer.send('global-dict:rec:final', { text: finalRef.current + partialRef.current }), 3000)`. Если Soniox всё-таки вернёт onclose раньше, мы пошлём финал дважды — main side это ОК, `handleFinalTranscript` идемпотентен относительно состояния `idle` (early-return при пустом тексте + второй вызов на пустом тексте просто завершит state).

## Settings shape (`~/.noted-terminal/global-dictation/settings.json`)

```json
{
  "enabled": false,
  "hotkey": "Alt+`",
  "autoEnterHotkey": "",
  "cancelHotkey": "Esc",
  "showChip": true,
  "autoEnterDefault": false,
  "transcriptFontSize": 12,
  "transcriptLines": 5,
  "menuGap": 6,
  "recWindowGap": 6,
  "chipPos": { "cxPct": 0.5, "cyPct": 0.93, "displayId": 69734272, "x": 660, "y": 980 }
}
```

Миграции в `loadSettings`:
- `Cmd+\`` → `Alt+\`` (`globalShortcut.register` для Cmd+\` возвращает true но callback не fires — macOS перехватывает первым).
- `Alt+Dead` → `Alt+\`` (ранний UI captured macOS dead-key combination через `e.key === 'Dead'`).
- `autoEnter` → `autoEnterDefault` (переименование — раньше один flag смешивал semantics persisted-defaults и runtime-state).

История (`history.json`) — массив `[{ ts, text }]`, cap 200, новые в начало. Хранится отдельно от tab-specific dictation history (которая в `localStorage`, см. `dictationHistory.ts`). Per-entry IPC operations (`history:copy/delete/open-folder`) — для UI в Settings, где история разворачивается раскрывающимся блоком с inline search + highlight совпадений + copy/delete/Finder-reveal на каждой записи.

## Debug overlay-окон без DevTools

Frameless transparent always-on-top окна без menu bar — DevTools открыть нельзя комфортно, juyер ничего не видит если что-то падает в renderer. **Решение** — bridge всех renderer-консоль-логов в main:

```js
win.webContents.on('console-message', (_e, level, message, line, source) => {
  console.log('[GlobalDict][' + name + '][renderer-console L' + level + '] ' + message + ' (' + source + ':' + line + ')');
});
```

Плюс `did-fail-load`, `render-process-gone`, `preload-error`, `loadFile().catch()` — все silent failures становятся видимы в `production.log`. Без этого первый «белый прямоугольник» bug (см. ниже про asar path) мы бы искали часами через trial-and-error: ZERO log entries из overlay → невозможно понять происходит ли вообще что-нибудь в renderer'е.

Аналогично в renderer-side: вместо `console.log` использовать `ipcRenderer.send('log:renderer', '[GD:chip] ...')` — main `log:renderer` IPC интерсептор пишет в файл (см. CLAUDE.md «Логирование»). Все три renderer'а overlay (`chip.tsx`, `recording.tsx`, `menu.tsx`) логируют через `dlog()` helper-обёртку.

## Что НЕ делаем (graveyard)

- **Recording-окно с `focusable: true`** — Cmd+V уходит в наше же textarea, а не в target app. Фикс: `focusable: false` + close window перед paste (вместо `hide` — иначе остаётся в стеке окон Spaces).
- **chipWindow с `focusable: true`** — было сначала «чтобы клик работал». На каждый клик чип крал фокус у target app — юзер репортил *«курсор пропадает с основного приложения»*. Фикс: `focusable: false` + `acceptFirstMouse: true` — click ловится без активации окна.
- **Async `startDrag` через `await ipcRenderer.invoke('chip:get-pos')`** — между mousedown и resolve мог прийти mouseup, race ставил `active:true` после того как onUp уже early-return'нул. Следующий innocent mousemove начинал «двигать» чип без зажатой кнопки. Фикс: sync через `window.screenX/Y`.
- **`loadFile(__dirname + '/../../renderer/...')`** — модуль живёт в `app.asar/src/main/global-dictation/index.js`, `__dirname` это та папка, `../../renderer/` указывает на `app.asar/src/renderer` — ПУТИ НЕ СУЩЕСТВУЕТ в production asar. Окно создавалось, `loadFile` тихо фейлился (без did-fail-load listener'а — silent), renderer JS не выполнялся, белый прямоугольник. Фикс: `path.join(__dirname, '..', '..', '..', 'dist', 'renderer', ...)` — три уровня вверх (subdir → main → src → asar root → dist/renderer). Принцип переносимый в CLAUDE.md anti-pattern.
- **Без save/restore clipboard** — стирает юзерский clipboard. Telegram/Slack/IDE юзеры жаловались.
- **`globalShortcut.register('CommandOrControl+\`')`** — register возвращает true, **callback never fires**. Cmd+\` зарезервирован macOS под «Move focus to next window». Сменили default на `Alt+\``, добавили миграцию.
- **Hotkey capture через `e.key`** — `Alt+\`` ловился как `Alt+Dead`, `Opt+A` как `Alt+å`. Фикс: `e.code` (физическая клавиша), маппинг в Accelerator-формат.
- **`globalShortcut.register` без `app.whenReady()`** — `register returned false`, ошибка молчаливая. Init делает `if (app.isReady()) proceed(); else app.whenReady().then(proceed)`.
- **Без target-app capture перед `keystroke`** — paste «через раз» попадал в Noted Terminal вместо Claude TUI: между моментом recording-start и моментом stop+paste юзер успевал кликнуть нашу chip/menu, frontmost становился Noted Terminal, osascript вставлял в нас. Фикс: snapshot bundle id до открытия наших окон, `tell application id "<bid>" to activate` + 80ms delay перед keystroke.
- **AudioWorklet в overlay-window** — blob:-CSP ад, ScriptProcessorNode даёт ~85 ms latency (в речи незаметно). Не переписывать.
- **Triggering paste через `nut.js` / native module** — `osascript` встроен в macOS, нулевая зависимость. Trade-off: macOS-only.
- **Один общий BrowserWindow для chip+recording** — `setBounds`+`setIgnoreMouseEvents` race-условия на дальних рабочих столах ловить дороже чем держать независимые окна.
- **`movable: true` на chip** — macOS drag-region перехватывает клики у overlap'ающих button-element'ов. Renderer-side pointer drag через mousedown→mousemove→mouseup со страховкой `e.buttons===0`.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `src/main/global-dictation/index.js` | State machine, 3× globalShortcut, 3 BrowserWindow + main, AppleScript paste + target-app capture/activate, settings/history persistence. |
| `src/global-dictation-renderer/chip.tsx` | Chip overlay React app — idle mic / recording 3-button row, sync pointer-drag, mic↔X morph при menuOpen. |
| `src/global-dictation-renderer/recording.tsx` | Recording overlay — owns `DictationSession`, adaptive height по числу строк, Stopping plate (spinner+amber). |
| `src/global-dictation-renderer/menu.tsx` | Popover Open App / Speak / Copy. Slide-up stagger animation, press-flash для tactile feedback. |
| `src/renderer/components/UI/GlobalDictationSettings.tsx` | Settings 2-column layout: hotkeys/toggles слева, размеры/gaps справа. Hotkey capture через `e.code`. History inline с search+highlight+copy/delete/Finder. |
| `src/main/main.js` | Регистрирует модуль рядом с другими `ipc/*.register()`. |
| `electron.vite.config.js` | Дополнительные `rollupOptions.input` — `global-dictation-{chip,rec,menu}`. |
| `index.html`, `global-dictation-{chip,rec,menu}.html` | Четыре HTML entry-point'а. |
| `src/renderer/App.tsx` | IPC `open-settings` listener — bridge для menu кнопки «Open App» → существующий `settings:open` flow с tab='dictation'. |

## Связанные системы

- **In-tab dictation** ([`fact-dictation.md`](fact-dictation.md)) — переиспользует `DictationSession`, `soniox:mint-token`, marker filtering. Если правишь Soniox-протокол, проверь оба места.
- **Microphone permission** ([`main.js::5360..5383`](../src/main/main.js)) — handler установлен один раз на `defaultSession`, обслуживает и in-tab, и overlay-окна.
- **Stop hook / claude:turn-state** — НЕ связано: global dictation абсолютно про OS-уровень, не знает ничего про активные Claude/Gemini-табы. Текст уходит туда где курсор у юзера, нам всё равно что это.
