# Факт: Управление Claude Code TUI из приложения

## Актуализация05.09: общий settings + send

Явный выбор модели/effort и связанный prompt — одна main-owned операция под
существующим PTY write owner. Независимая настройка ждёт её, а не вклинивается
между proof настройки и пользовательским Enter. Вложенное использование lock
разрешено только точному действующему владельцу; после завершения token
не переиспользуется. Долгий post-Enter audit не удерживает input lock.
Main-owned setting claims переживают renderer reload, но не окончание процесса.

Модель и effort в Claude ControlBar не блокируются состоянием `isPasteBusy`:
их выбор ставит настройку за текущей отправкой в тот же существующий main-owned
PTY lock. Подтверждённый E3-барьер: A уже вставлен и held before Enter, а scoped
effort button был disabled, поэтому B вообще не доходил до этой очереди.
Исправлены wrapper pointer-events, disabled и admission именно model/effort;
provider/Think/session действия сохраняют свои ограничения. Пока настройка
ожидает, кнопка остаётся меню для следующего выбора, не cancel-only кнопкой.
Поздний ответ старой настройки не меняет UI/сентинел последнего выбора;
счётчик ожидающих действий не разблокирует соседние controls преждевременно.
`claudeSettingsQueue.test.mjs` выполняет настоящий ControlBar handler и общий
settings runtime: A Enter→high→max, задержанный ответ high не стирает max.
Backend serializes реальные команды; отдельный renderer PTY mutex не добавлен.

Точный effort/model берётся из подтверждённого native JSONL, включая
`system/local_command/content` и `user/message/content` carriers. Данные старой
ветки/сессии не становятся подтверждением текущей. Старые описания invisible
InfoPanel intent ниже не являются контрактом текущего History ControlBar.

Подтверждение модели сохраняет прежнюю JSONL wrapper→stdout проверку. Thinking
не пропускается из-за renderer-кэша прошлого процесса: main получает желаемое
состояние и подтверждает результат. Ошибка до вызова paste возвращает явный
`submitted:false`; исключение после возможной записи этого не доказывает.
Create/start через Terminal MCP используют тот же per-tab startup intent,
включая частичные overrides и сохранение неприсланных defaults.

Physical Haiku regression: первая операция held before Enter, конкурирующая
вторая ждёт; обе canonical user records и ответы появились один раз и по
порядку. Пробы — `claude-settings-send.test.js`, `agent-create-settings.test.js`.

External JSONL owner при Resume определяется настоящим Claude entrypoint
(native либо Node CLI из известного пакета) и отдельным argv `--resume`/`-r`/
`--session-id`. Нельзя искать просто слово claude и UUID где угодно в command
line: Node MCP Client с JSON запроса принимался за живую сессию и блокировал
Resume. Точный свежий bridge+PID остаётся отдельным доказательством; native SDK
и legacy Node SDK CLI тоже распознаются. Диагностика отказа содержит PID и вид
доказательства, не полный argv с возможными секретами. Проба:
`claude-process-command.test.js`.

## Проблема
Claude Code CLI работает на базе Ink (React TUI) в raw mode с включённым **bracketed paste mode**. Это означает:
- `\r` (CR) и `\n` (LF), отправленные через PTY → **не сабмитят ввод**, а создают новую строку
- Обычный `\t` (Tab) → не переключает thinking mode (нужен `meta+t`)
- Slash-команды (`/model`, `/compact` и т.д.) — обычный текстовый ввод, парсится после Enter

**Поисковые симптомы:** startup default model висит на `❯ 1. Yes, switch to Haiku`; после успешного model switch не вводится `/effort max`; `/effort` уходит в период `Switch model?` confirmation; model/effort dialogs подавляют друг друга cooldown'ом; return из `safePasteAndSubmit` наступил, но Claude TUI ещё не применил настройку.

## Решение: Bracketed Paste + Semantic Enter Boundary

### Отправка команд (IPC `claude:send-command`)
Выполняется через универсальный механизм `safePasteAndSubmit` (см. ниже).

**Почему именно так:**
- Ctrl+C безопаснее Ctrl+U — очищает многострочный ввод, одиночное нажатие не выходит из Claude
- Paste brackets нужны потому что Ink в raw mode иначе обрабатывает каждый символ как keypress
- `\r` внутри paste brackets → новая строка. `\r` **после** paste end → submit
- Enter разрешается только после доказательства конечного composer-состояния;
  первый новый render-frame может быть промежуточным `Pasting…`

### Переключение модели

#### Default vs Opus (Model Detection)
Claude Code поддерживает три модели: `default`, `sonnet`, `haiku`. Однако `default` — это не имя модели, а алиас для текущей рекомендуемой модели Claude (в 2026-03 это Opus).

**Детекция в bridge-данных:**
Bridge-скрипт (`~/.claude/statusline-bridge.sh`) вернет строку `model: "Opus 4.6 (1M context)"` (текстовый маркер), если пользователь явно выбрал режим default.

**Логика UI:**
- **Default:** Подсвечивается (оранжевый), когда bridge-строка содержит маркер `1m context`.
- **Opus:** Подсвечивается, когда строка содержит `opus`, но НЕ содержит `1m context`. Это позволяет различать стандартный Opus (200K) от Default (1M).
- **Sonnet/Haiku:** Прямое соответствие через `includes(model)`.

**Переключение:**
```js
ipcRenderer.invoke('claude:send-command', tabId, '/model sonnet');
// Aliases: default, sonnet, opus, haiku — работают мгновенно, без рестарта
```

Bridge остаётся live-каналом resolved model label для уже связанной сессии: он, например, различает `default`/1M и обычный Opus после stale-session guard. Но это не долговечный источник восстановления и не proof применения `/model`. После restart/Rewind ControlBar восстанавливает выбранные Model/Effort из подтверждённых пар slash-wrapper → stdout в активной JSONL-ветке; bridge может уточнить только live-отображение текущей привязанной сессии.

## Синхронизация с UI: Serialization & Command Guard

### Блокировка кнопок (isControlBusy)
Когда пользователь отправляет команду (смена модели, effort, think toggle), система устанавливает флаг `isControlBusy = true`. Это **блокирует** все кнопки управления в секции «Контроль» до завершения операции.

**Мотивация (Invisible Intent):** Изначально guard защищал от «двойного Ctrl+C exit» (двойной клик → два `\x03` подряд → Claude видит `again to exit` → процесс умирает). После перехода на Stash flow (Ctrl+S вместо Ctrl+C) этот риск исчез, но guard остался важным: предохраняет от ситуации когда второй клик отправляет Ctrl+S **после** первого paste но **до** Enter первого сабмита — второй Ctrl+S попнул бы первую команду (Claude в этом state видит `input=/model X, stash=user_prompt` → Ctrl+S сначала запихнул бы команду в stash поверх user_prompt) → user prompt теряется навсегда.

**Синхронный IPC (`claude:send-command`):**
Команда отправляется через `ipcRenderer.invoke()` (синхронный вызов), что позволяет интерфейсу дождаться завершения `term.write()` и только после этого разблокировать кнопки.

### Двух-уровневая защита: per-term mutex + claude:paste-busy

Локальный `isControlBusy` защищает только от **двойного клика по той же кнопке**. Он не виден другим источникам команд — queue runner, MCP-handlers, /effort auto-inject, кнопки в других панелях. Если параллельно с UI-кликом Compact в InfoPanel запустился queue runner с большим prompt'ом, оба попадали в `safePasteAndSubmit` на одном `ptyProcess` → bytes интерлевились, команды терялись (сессия `bb95e71d`, 16:01 MSK 2026-05-16).

Фикс — двух-уровневый:
1. **Server-side mutex** в `safePasteAndSubmit` (WeakMap `pasteInflight: term → Promise`). Любой второй caller чейнится на хвост первого через `prev.then(...)`. Покрывает все 14 callsites автоматически.
2. **Broadcast `claude:paste-busy { tabId, busy }`** main → renderer на enter/exit `safePasteAndSubmit`. InfoPanel слушает и через derived `isControlBusy = isControlBusyLocal || isPasteBusy` отключает кнопки, пока чужой paste идёт. Кнопка не дойдёт до `ipcRenderer.invoke` если ANY caller активен на active tab.

См. [`fix-claude-paste-race.md`](fix-claude-paste-race.md).

## Stash Flow для slash-команд (Ctrl+S вместо Ctrl+C)

### Симптом (что видел пользователь)
В обновлённом Claude Code (2026-Q2) клик по кнопке Model/Effort в InfoPanel приводил к двум проблемам:
1. Команда (`/model sonnet`) появлялась в инпуте, но **Enter не сабмитил** — нужно нажать пробел или любой символ, чтобы команда «активировалась».
2. Если в инпуте уже был user prompt, он **терялся** при клике (Ctrl+C стирал).

### Решение: Ctrl+S (Claude stash) вместо Ctrl+C
`Ctrl+S` (0x13) в Claude TUI = chat:stash binding (см. `packages/claude-code-src/keybindings/defaultBindings.ts`). Пушит текущий ввод в `stashedPrompt` state, чистит инпут. После сабмита **slash-команды** stash сохраняется (REPL.tsx особый кейс для slash-cmd); на **следующем** обычном сабмите — Claude автоматически восстанавливает stash в инпут.

Flow в `safePasteAndSubmit` опцией `stashFirst: true`:
1. `\x13` (Ctrl+S) → push stash, clear input
2. `drainPtyData(20)` — даём Ink проглотить байт до прихода нашего paste
3. bracketed paste команды (`\x1b[200~` + cmd + `\x1b[201~`)
4. `waitForRender` ловит новый sync marker (типично 8-30ms) как transport-
   границу кадра
5. короткая slash-команда проходит command-specific settlement/proof
6. `\r` — submit; обычный длинный user-prompt до этого отдельно доказывает
   конечную форму composer

**Корнер-кейс:** если инпут пуст И в Claude уже есть stash, Ctrl+S **попнет** stash обратно в инпут (`handleStash` в PromptInput.tsx::1357 двунаправленный). Поэтому startup retry не вызывает Ctrl+S вслепую. Если после exact-empty proof снова появился дословно тот же app-owned `/model`/`/effort`, он повторно проверяется и отправляется одним Enter как продолжение той же транзакции; только отличающийся реальный draft проходит native stash-flow. Иначе служебная команда сама попадёт в stash, восстановится позднее и History ошибочно покажет `Send stopped · draft moved`.

### Cmd+] History send preflight: draft переносится, отправка останавливается

HistoryPanel send для обычного user prompt не должен вести себя как slash-command stash-flow. Если в живом Claude composer уже есть ручной draft, новый prompt из правой панели нельзя «аккуратно склеить и отправить»: пользователь писал текст в терминале с другим намерением, и auto-send превратит два независимых ввода в один неожиданный запрос. Preflight делает `grab-input`, атомарно забирает и очищает TUI composer, добавляет найденный текст в начало History textarea, показывает compact warning `Send stopped · draft moved` рядом со статусом и **не** вызывает `sendClaudePtyPrompt`.

Порядок важен: terminal composer — первичная поверхность, где draft уже был набран до открытия/использования History input. Поэтому найденный draft становится causal-prefix, а не хвостом; append меняет смысл запроса так же сильно, как silent auto-send. Это намеренно отличается от `⎘ prompt | + clear`: там пользователь явно просит забрать текст из TUI. В History send `grab-input` — guard перед отправкой, а не основное действие. Симптом нарушения: пользователь набрал текст в терминале, нажал Send в `Cmd+]`, и старый terminal draft оказался дописан к новому prompt'у и ушёл в Claude.

Ручная стрелка «Pull terminal draft» в той же панели — отдельное явное действие. Если Claude composer пуст, она не должна показывать warning `Send stopped`: ничего не переносилось и отправка не останавливалась. Правильный feedback — короткий нейтральный `Terminal input empty` рядом с `READY`, без жёлтого треугольника.

History textarea draft привязан к tabId, а не к mount-cycle панели. Закрыть и снова открыть `Cmd+]` — это смена видимости, не пользовательский clear: введённый prompt обязан остаться до успешной отправки или явной очистки. Иначе пользователь теряет текст при обычном «посмотреть историю → вернуться к терминалу → снова открыть историю» без destructive-жеста.

От момента клика Send/Enter до появления durable JSONL-записи HistoryPanel обязан держать локальный handoff-маркер, а не ждать секунду молча. Состояния `queued → sent` означают только что bytes/IPC ушли в runtime; они ещё не делают сообщение частью истории. Когда matching user entry появляется в активной ветке JSONL, локальная строка заменяется серверной entry. Если пользователь нажал Stop/Interrupt до durable materialization, локальный prompt не превращается во второй user bubble: он становится `cancelled`/нейтральным маркером отмены, а совпадающая JSONL-строка из abandoned tail, если Claude всё же успел её дописать, suppression-фильтром скрывается из History. Пользовательский симптом, который этот контракт ловит: prompt исчез из History сразу после Enter или наоборот появился как user-сообщение, хотя терминал его уже не выполняет.

`handoffId` связывает renderer click, `terminal:paste`, `safePasteAndSubmit`, `PasteAudit` и interrupt recovery в логах. Без общего id быстрый сценарий «отправил и сразу Stop» выглядит как рассинхрон двух независимых подсистем: History видит optimistic row, main видит paste/interrupt, JSONL watcher позже видит хвостовую user entry. Handoff-id нужен не для бизнес-логики, а чтобы в логах доказать, какая именно попытка отправки была доставлена, отменена или подавлена.

### Кладбище идей: Esc после paste
**Попытка №1** — в flow добавили `\x1b` (Esc) перед Enter, чтобы закрыть slash-autocomplete dropdown. Логика: при пасте `/model haiku` сначала появляется autocomplete, и `PromptInput.onSubmit` имеет early-return guard на `suggestionsState.suggestions.length > 0` (PromptInput.tsx::1074). Без закрытия dropdown — `\r` молча игнорируется.

**Почему не нужно:** в живой проверке (PTY-trace через `terminal:data` IPC) обнаружено, что для команд **с аргументом** (`/model haiku`, `/effort low`) autocomplete закрывается **сам** в момент paste — после пробела+аргумента нет префиксного матча со списком команд (PromptInput.tsx::980-1075). К моменту нашего `\r` `suggestions.length === 0`. Симптом «нужно нажать пробел» был не от dropdown'а, а от **stale sync marker** (см. ниже).

Побочка Esc: Claude рендерил под инпутом текст «Esc again to clear» и съедал ~130ms на drain после Esc. Удалено.

### Stale sync marker — главная причина задержки (фикс)
В первой реализации `safePasteAndSubmit` ждал sync marker до 8 секунд (`safetyTimeoutMs`), потому что **наш же** marker от paste прилетал за 8-12ms и попадал в 15ms stale-окно `waitForRender` → отбрасывался → ждали timeout. Подробности — `fix-stale-sync-markers.md::markWriteTime`.

После фикса (`markWriteTime()` сбрасывает baseline ПОСЛЕ `term.write()`, threshold снижен до 3ms) sync marker от paste проходит cleanly за 8-30ms.

Это устраняет **старый** marker, но не повышает новый marker до semantic ACK.
Инцидент с длинным prompt и четырьмя изображениями показал цепочку
`Pasting… → временно пустой composer → image chips + collapsed text`: первый
честный marker закрыл `Pasting…`, Enter ушёл примерно за полсекунды до
конечной формы, и Claude начал turn только после ручного Enter.

Для обычного автоматического prompt общий submit теперь ждёт committed
headless-кадр той же terminal/run/lifecycle/input generation и одну конечную
форму: inline text, полный collapsed-paste chip, images + text/chip либо
image-only. `Pasting…`, временно пустой composer, incomplete chip, external
editor и неизвестная форма — fail-closed без Enter. Порог collapse угадывать
не нужно: проверяется форма, которую реально выбрал Claude.

### Измеренные тайминги (через electron-mcp + dev.log)
- `/effort low`, `/model sonnet`, `/model haiku`, `/model opus`, `/model default` — стабильно **400-450ms** total на коротких командах (11-14 байт).
- Внутри: ~20ms drain после Ctrl+S, ~250ms ожидание sync marker от paste, ~50ms tail drain, ~5ms Enter.
- До фиксов: 8-9 секунд (timeout race).

См. также `methodology/дизайн-принципы.md::Воспринимаемая задержка UI-команд` — пустой инпут ощущается «лагающим» на тех же 80ms, на которых заполненный инпут визуально «мгновенный»; именно поэтому drain'ы свели до минимума event-driven путём.

## Управление Effort Level

### Введение
Effort Level (уровень интенсивности размышлений) контролирует глубину анализа Claude. Поддерживаются уровни: `auto`, `low`, `medium`, `high`, `max`.

### Индикация подтверждённого Effort

Bridge не передаёт Effort, но JSONL сохраняет подтверждение native slash-команды. Поэтому активная pill отражает последнее подтверждённое значение активной ветки текущей сессии, а не renderer-догадку; ручной терминальный ввод и app restart проходят тот же источник. Подробный proof-контракт — в одноимённой секции ниже.

## Шрамы формата данных (Claude CLI)

В ходе разработки были выявлены неочевидные ограничения форматов данных Claude Code:

1. **`ANTHROPIC_MODEL="default"` в env:** Установка этого значения в переменных окружения (`.zshrc`) приводит к повреждению отображения в TUI (показывается `[default] 0%`). Для использования модели по умолчанию с 1M контекстом через env-переменные необходимо использовать формат `opus[1m]`.
2. **`effortLevel: "max"` в settings.json:** Попытка прописать уровень `max` напрямую в файл настроек приводит к его **тихому сбросу** (null) при следующем запуске Claude. Уровень `max` не является персистентным; максимальное значение, которое сохраняет CLI между сессиями — `high`.
3. **`1m context` маркер:** Единственный надежный способ отличить модель `default` от явно выбранной `opus` в потоке данных — наличие подстроки `(1M context)` в имени модели.
4. **Список effort-уровней меняется между релизами Claude.** В мае 2026 `auto` был удалён, добавлен `xhigh` между `high` и `max`. Хардкод массивов `['auto','low','medium','high','max']` рассыпан по 4 файлам не пережил апдейт — UI показывал несуществующий `auto`, новый `xhigh` отсутствовал. Решение: **один canonical-файл** `src/renderer/constants/claudeLevels.ts` экспортирует `CLAUDE_EFFORT_LEVELS`, `CLAUDE_EFFORT_TOGGLE_OFF`, `CLAUDE_MODELS`. Все use sites импортируют оттуда. Legacy migration `'auto' → 'low'` для persisted values. Принцип переносимый — см. `methodology/дизайн-принципы.md::Single source of truth для third-party shipping values`.

## Реактивное управление TUI через синхронизацию

### Особенности парсинга Claude Code TUI
1. **Sync Markers (\x1b[?2026h/l):** Современные TUI (включая Claude) используют эти маркеры для обозначения границ кадра отрисовки. 
    - **Правило:** Любой парсинг буфера (меню истории, пикер модели) должен начинаться только ПОСЛЕ детекции `\x1b[?2026l` (конец кадра).
2. **Проблема исчезновения пробелов:** Claude TUI не всегда использует `0x20` (пробел). Вместо этого часто шлется `\x1b[NC` (cursor forward). 
    - **Правило:** Перед очисткой VT-символов необходимо заменять `\x1b[(\d*)C` на соответствующее количество пробелов. Иначе текст склеится (`каксейчасработает`).
3. **Детекция готовности инпута:** После выполнения команд (например, `/model` или откат), нужно ждать отрисовки промпт-бокса. Признак готовности — появление в кадре символов `╰` (низ бокса), `⏵` или `>`. Marker'ы picker/menu (`›`, `❯`, `●`) не являются composer-ready: в `/rewind` они могут означать выбранную строку меню, и если принять их за prompt, автоматика начнёт вводить текст в открытый picker.

## Rewind Automation (Откат истории)

### Симптомы (при сбоях)
При восстановлении истории слова могут слипаться в одну строку без пробелов (`каксейчасработает`), либо курсор навигации в TUI-меню "промахивается" мимо нужной записи, из-за чего сессия откатывается не в ту точку или закрывается с ошибкой.

Для программного отката используется IPC `claude:open-history-menu`, но основной путь больше не открывает legacy history menu через Ctrl+C/Esc. Timeline запускает **нативную Claude slash-команду** `/rewind` через тот же Stash Flow, что `/model` и `/compact`: перед командой классифицируется текущий composer, видимый draft защищается от потери, slash-команда отправляется как служебное действие, а не как пользовательский prompt.

**Алгоритм native Rewind:**
1. **Preflight input:** `captureClaudeInput(tabId, 'copy')` проверяет, что можно безопасно временно забрать управление composer'ом. Неизвестное состояние лучше отказать, чем молча перетереть draft.
2. **Открытие:** `safePasteAndSubmit('/rewind', { stashFirst:true, submit:true })` открывает родной Claude history picker. Это важно: source of truth для rewind — сам Claude TUI, не редактирование JSONL и не наша реконструкция меню.
3. **Навигация:** Timeline передаёт `targetFullText` выбранной entry и `rewindableCount`. После sync marker меню навигация идёт к нужной записи по позиции в текущем rewindable диапазоне; если позиционный путь не сходится, остаётся visual/text fallback из старого фикса.
4. **Подтверждение:** `\r` выбирает историю в Claude. Это ещё не пользовательский submit нового turn'а.
5. **Transfer target input:** после возврата prompt-box'а (`╰`/`⏵` + sync marker) Claude уже восстановил выбранный prompt в terminal composer. Приложение сразу забирает его через `grab-input`, кладёт в History textarea и очищает terminal composer. Пользователь видит выбранный prompt в правом input и сам решает, жать ли Send/Enter; левый терминал остаётся пустым, потому что у текста должен быть один текущий владелец.

Открытие `/rewind` считается успешным только после proof видимого picker-frame, не после первого `Enter` на slash-команде. Шрам 2026-06-19 показал состояние `slashHelpOpen=true` и `menuLooksOpen=false`: строка `/rewind Restore the code...` осталась в slash-help, хотя startup defaults уже прошли. В таком кадре допустим ровно один confirm Enter, затем всё равно требуется доказанный menu frame; если меню не доказано, операция падает, а не продолжает навигацию по предположению.

В Claude picker есть два observed layout'а выбора. Старый layout коммитит строку над active marker, поэтому нужен `targetBeforeSelected=true`, но только если active row сама не slash-command/control row. Новый layout может показывать target как саму выбранную строку `› сообщение 2` с цветовой подсветкой, поэтому второй допустимый proof — `selectedMatchesTarget=true` по raw marker/style-selected row. В обоих случаях короткий prefix в TUI используется только как визуальный якорь; сравнение `skipDuplicates` и post-grab verification идут по полному normalized `targetFullText`/hash. Ошибка после commit (`claude_rewind_restored_input_mismatch` / `empty`) не превращается в зелёный успех: rollback мог уже затронуть preview, но transfer target prompt в History textarea не доказан.

Background/stopped Rewind не должен зависеть от mounted renderer. Видимый picker-frame читается main-side headless xterm snapshot first: он видит текст и cell-style того же PTY stream даже когда вкладка скрыта, закрыта в UI или renderer stale после view switch. Renderer visible snapshot остаётся fallback/диагностикой. Пользовательский симптом регресса — Rewind работает только пока вкладка открыта, а в закрытой/фоновой сессии “запустил Claude и дальше ничего”.

**Два режима после выбора:**
- **Обычный «Откатиться»:** только native `/rewind` + перенос target prompt в History input. Никакого `/compact`, AI-пересказа или auto-submit. History заканчивается строго перед выбранным user-row, скрывает его вместе со старым будущим хвостом и держит этот prompt только в textarea до нового Send.
- **AI compact / prompt-варианты:** используют тот же selection handler, но после выбора запускают дополнительный AI-путь (`pasteAfter`/compact instruction). Поэтому кнопки в Timeline context menu разделены: default action не делает AI-work, AI-иконка и prompt-стрелка делают.

Rewind preview не является сохранённым состоянием JSONL. Старый target record физически остаётся в исходном transcript, но рабочая History-проекция его не показывает, пока тот же текст принадлежит input. Если закрыть Claude/терминал до отправки нового prompt'а и открыть сессию заново, полная исходная история возвращается. Только настоящий subsequent send создаёт новую durable ветку/хвост; очистка/изменение textarea само по себе историю не переписывает.

После subsequent send preview очищается не по таймеру и не просто по появлению любой новой строки: History требует, чтобы target исчез из активной `parentUuid`-ветки и появился новый durable user-turn. Иначе stale `I REWOUND` может пережить уже созданную ветку или, наоборот, исчезнуть от служебной JSONL-записи.

Legacy Visual Search Strategy в [`fix-rewind-navigation.md`](fix-rewind-navigation.md) остаётся safety/fallback для случаев, когда TUI-меню не удаётся позиционно сопоставить. Не возвращать старую модель «открыть меню Ctrl+C/Esc → найти lavender RGB → Enter → всегда вставить compact»: она смешивала два разных действия (выбор истории и AI-компактацию) и могла перетереть ожидаемый current input.

## Решение: safePasteAndSubmit (Programmatic Paste)

Programmatic paste отличается от ручного тем, что код сам немедленно пишет
Enter. Современный node-pty доставляет большой Claude payload одним
`term.write()` через retry на backpressure; искусственное деление slow-path на
900-байтные bracket-pair устарело и создавало десятки отдельных paste chips.
Основная оставшаяся гонка находится выше PTY: React Ink может закрыть
промежуточный кадр раньше, чем финальный input materialized.

### ⚠️ ВАЖНО: safePasteAndSubmit ≠ user paste (Ctrl+V)

`safePasteAndSubmit` — это функция **только для программных операций**, где наш код отправляет текст напрямую в PTY (минуя xterm.js) и сразу шлёт Enter. Она **НЕ используется** в обработчике `terminal:input` (user paste).

**Два разных пути:**

| | User Paste (Ctrl+V) | Programmatic Paste |
|---|---|---|
| **Путь** | xterm.js (добавляет brackets) → `terminal:input` → simple chunking | Наш код → `safePasteAndSubmit` → `term.write()` напрямую |
| **xterm.js** | В цепи (сам добавляет brackets) | Не участвует |
| **Enter** | Человек жмёт (секунды спустя) | Код шлёт (миллисекунды) |
| **Sync markers** | Не нужны | Transport frame; для Claude user-prompt недостаточны без semantic proof |

**Почему в `terminal:input` нельзя было использовать `safePasteAndSubmit`:**
1. Обычные терминалы (bash/zsh) не шлют sync markers → 5-сек таймаут на каждый чанк.
2. xterm.js уже добавил brackets → `safePasteAndSubmit` создавала второй слой → двойное обрамление.

Подробнее: `knowledge/fact-fact-terminal-core.md` (секция "Двухуровневая система вставки").

### Алгоритм `safePasteAndSubmit`:
1. **Single logical paste:** Claude получает одну пару
   `\x1b[200~...\x1b[201~`; fast-path других терминалов может физически писать
   payload чанками, но не создаёт новую bracket-pair на каждый чанк.
2. **Transport frame:** новый sync marker закрывает один Ink render-frame и
   отсекается по write-baseline от старых marker'ов.
3. **Semantic composer proof:** для обычного Claude user-prompt current
   committed headless-frame должен содержать одну полную допустимую форму и
   соответствовать фактическому способу вставки. Native-only image paste ждёт
   свои image chips; текст с `[imagePath: …]` и полный Pasted text/content не
   обязаны создавать отдельную графическую карточку. Число исходных image
   references и наблюдённых native chips хранится раздельно, в том числе для
   post-Enter recovery. Иначе path transport вставлялся успешно, но приложение
   восемь секунд ждало несуществующий chip и отказывало до Enter. Активный
   `Pasting…`, незакрытый carrier, чужой owner и partial native-only image set
   сохраняют draft и запрещают Enter.
   Граница prompt учитывает xterm `isWrapped`: перенесённый из пользовательского
   текста символ `❯` не начинает новый input. Слова Pasting/editor внутри
   обычного предложения не являются статусом; отдельная текущая status-строка
   по-прежнему блокирует. Это покрывается replay через настоящий headless xterm
   на разных ширинах, а не только искусственным массивом строк.
4. **Submit + audit:** после `\r` exact `UserPromptSubmit`/JSONL carrier
   подтверждает user-turn. Claude может заменить локальные image paths на
   image blocks и markers; различие hash разрешается только exact input-
   generation/hook-route proof и не меняет identity исходной операции.
5. **Один recovery Enter:** если post-Enter audit не появился, повтор разрешён
   ровно один раз только после точного чтения того же app-owned draft, при
   нуле causal user-records и неизменных PTY/run/lifecycle/input coordinates.

### Где используется
- **Handshake:** Автоотправка default prompt при запуске Claude.
- **send-command:** `/model sonnet`, `/compact` и др. из UI.
- **Rewind:** Вставка compact-резюме после отката.

## Think row — две кнопки: Think + Compact

В ряду «Think» (InfoPanel секция КОНТРОЛЬ) сидят две равных по ширине кнопки вместо одной `toggle`.

| Кнопка | Что делает | Стиль |
|---|---|---|
| **Think** | Локальный тогл `thinkActive[tabId]`. Дефолт `undefined ⇒ true` (orange-tinted активный вид), потому что Claude стартует с `alwaysThinkingEnabled: true` в `~/.claude/settings.json`. Параллельно вызывает `claude:toggle-thinking` (meta+t picker в PTY) — при успехе reconcile из его `result.thinking`. | Активный = `bg-[#DA7756]/20 text-white font-medium` (та же приглушённая индикация что и Effort — local invisible intent, не подтверждённый bridge'ом). Неактивный = `bg-[#2d2d2d] text-[#888]`. |
| **Compact** | Отправляет `/compact` через `claude:send-command` (тот же Stash flow что Model/Effort: Ctrl+S → bracketed paste → Enter, ~400ms), затем main открывает local-command watcher. `/compact` не является model-turn'ом: Stop hook может не прийти, поэтому loader bracket'ится отдельным `claude:busy-state reason:'local-command'`. | Всегда нейтральный (нет «активного» состояния, разовое действие). |

**Дефолт «Think всегда ON при перезапуске» (важная invariant):**
- `thinkActive` хранится в `useState<Record<string, boolean>>({})` в InfoPanel.
- Когда `thinkActive[tabId]` === `undefined` → UI рендерит как активный.
- Хендлер `terminal:command-finished` (OSC 133 D, на любой shell-exit) **удаляет ключ** `tabId` из map → следующий запуск Claude снова покажет Think tinted. Это совпадает с реальным поведением `alwaysThinkingEnabled` — он применяется при каждом старте.
- Корнер-кейс: если юзер выключил Think через TUI вручную (`meta+t` напрямую в терминале) — наш UI этого не узнает (bridge не транслирует). При перезапуске опять покажем ON, и это совпадёт с реальностью. Рассинхрон mid-session — invisible intent, см. секцию про Effort.

**Почему Compact не использует `claude:toggle-thinking`-style picker:** `/compact` не открывает выбор — он просто сжимает контекст и продолжает разговор. Поэтому для ввода достаточно `safePasteAndSubmit` со стандартным `stashFirst: true` (защищает user prompt в инпуте). Для окончания команды этого уже недостаточно: визуальный loader должен пережить локальную работу Claude по сжатию, но не должен выглядеть как обычный assistant turn.

### `/compact` local-command watcher

`startClaudeLocalCommandWatcher(tabId, '/compact')` взводится после успешного `claude:send-command` и сразу эмитит `claude:busy-state {busy:true, reason:'local-command'}`. Completion ловится по нескольким независимым признакам:
- JSONL compact boundary (`type:'compact'` / compact summary markers);
- wrapper stdout в transcript (`<local-command-stdout>...Compacted...`);
- PTY-текст Claude (`Compacting conversation`, `Conversation compacted`);
- guard-timeout как error cleanup, а не как источник истины.

Pure `Escape` или `Ctrl+C` во время local-command отменяет watcher через `cancelClaudeLocalCommandFromInput` и гасит loader тем же `reason:'local-command'`. Это сознательно **не** `reason:'interrupt'`: отменённая slash-команда не равна прерванному assistant turn'у, поэтому PromptQueueRunner должен игнорировать edge, а не disarm'ить RunAfter как после настоящего `InterruptStop`. Multi-byte ESC sequences (стрелки, F-keys) не считаются отменой — они остаются обычной навигацией TUI.

Teardown обязан быть симметричным: manual Stop, bridge clear, PTY exit/kill тоже закрывают watcher и эмитят busy false, если local-command был активен. Иначе пользовательский симптом — `/compact` отменён, Claude idle, но vertical loader на вкладке/проекте продолжает крутиться.

**Почему обе кнопки блокируются `isControlBusy`:** Та же мотивация что у Model/Effort — пока `safePasteAndSubmit` или `toggle-thinking` идёт, второй клик может попасть между `Ctrl+S` и `\r`, что **попнет stash** и затрёт сохранённый prompt. См. секцию «Stash Flow» выше.

**Почему не Text Echo:** Ink коллапсирует большие вставки в строку вида
`[Pasted text #N +M lines]` и отдельно материализует image chips. Полный текст
не обязан появиться на экране, но и sync marker не гарантирует конечную форму.
Pre-Enter проверяется ограниченная semantic-грамматика composer, post-Enter —
точный provider audit.

## Управление Effort Level

### Введение
Effort Level (уровень интенсивности размышлений) контролирует глубину анализа Claude при решении задач. В 2026-03 добавлена UI-панель для переключения между тремя уровнями: Low (5K токенов думания), Medium (16K), High (50K max).

### Команда `/effort`
```js
ipcRenderer.send('claude:send-command', tabId, '/effort medium');
// Aliases: low, medium, high
```

### Подтверждённое состояние Model/Effort

Bridge действительно не передаёт Effort, но это больше не делает значение неподтверждённым renderer-флагом. Claude пишет local-command wrapper и его stdout в JSONL; только прямая пара `/<setting> value` → `Set ...` в активной `parentUuid`-ветке считается применённой. Незавершённый/отменённый picker не меняет UI, ручная команда из терминала видна ControlBar после transcript-события, а после Rewind записи отброшенного будущего не участвуют. Model и Effort восстанавливаются независимо: более новая модель не стирает ранее подтверждённый effort.

### Защита от двойного срабатывания (Command Guard)
Model/Effort идут через одну сериализованную транзакцию на PTY: отправка команды, current-frame подтверждение возможного native picker'а и JSONL proof. ControlBar меняет выбранное значение только после успеха; временные sentinels предотвращают дубль startup/manual путей, но сами не подтверждают настройку.

### Auto-confirm settings dialogs: effort и model
В **новой директории** (нет сохранённого разрешения) после `/effort N` Claude TUI показывает 2-pos меню:
```
Change effort level?
Your next response will be slower and use more tokens

This conversation is cached for the current effort level. Switching to <X> means
the full history gets re-read on your next message.

❯ 1. Yes, switch to <X>
  2. No, go back
```
Дефолт стоит на «Yes» — Enter подтверждает. Симптом: юзер нажимает «Effort → max» в UI, ничего не происходит, в терминале висит этот диалог; следующий ввод Enter в инпуте уходит в TUI и интерпретируется как подтверждение/отказ непредсказуемо.

`/model <X>` показывает тот же класс confirmation menu с заголовком `Switch model?` и highlighted option `❯ 1. Yes, switch to <X>`. Симптом: startup default model доходит до меню, курсор стоит на `Yes`, но процесс визуально «зависает» на подтверждении; при повторном запуске model может пройти, а следующий `/effort max` уже не вводится.

PTY chunk/renderer-текст теперь только будит проверку. Перед `Enter` main flush'ит headless mirror и заново доказывает, что **текущий** кадр того же PTY всё ещё содержит ожидаемый `EffortDialog`/`ModelDialog`, а generation терминала и ревизия пользовательского ввода не изменились. Только после этого отправляется один `\r`. Cooldown 2с защищает от повторного Enter на Ink re-render и ключуется `${tabId}:${dialogType}`: model-dialog и effort-dialog могут легально идти подряд.

**Шрам: текст в Ink-меню рендерится без литеральных пробелов и не всегда приходит заголовком.** Первая версия effort-матча была `'Change effort level' && 'Yes, switch'`. Падала: Ink TUI заменяет пробелы внутри строки меню на `\x1b[1C` (cursor-forward) — после `stripVTControlCharacters` получается `Yes,switchtolow`. Плюс диалог приходит в **3-5 отдельных PTY-чанках** (заголовок жёлтый, описание серое, опции синие — каждый блок отдельным write), поэтому матч из двух подстрок в пределах одного chunk вообще не имеет шансов. Для effort финальный матч — уникальный `Change effort level`; для model дополнительно нужен strict fallback по highlighted `❯ 1. Yes, switch to`, потому что в одном реальном запуске в логах был виден только option chunk. Не матчить generic `Yes, switch` без `❯`: такой текст может появиться в assistant output.

**Шрам 2026-07-04: chunk-detector недостаточен, когда меню уже собрано в видимом кадре.** В production resume iOS получил 504, хотя Mac-side терминальный экран уже содержал `Switch model? ... ❯1.Yes,switchtoHaiku4.5`; `[ModelDialog] detected, sending Enter` пришёл только позже. Причина была не в «маленьком таймере», а в точке наблюдения: нужные слова не совпали в одном текущем PTY chunk, но уже существовали в assembled visible buffer. Пока транзакция ждёт JSONL proof, renderer-buffer может разбудить проверку, но перед Enter main всё равно заново читает свой headless current frame и сверяет поколение PTY/input.

**Задержка 120мс после output-hint:** это settle перед повторным чтением assembled кадра, не разрешение на Enter. Исторический chunk, старый visible tail или timer closure сами по себе больше не могут подтвердить диалог.

**Принцип:** см. `methodology/дизайн-принципы.md::Ink TUI: пробелы как ANSI-команды, текст разорван по чанкам`. Любой будущий парсер TUI-вывода для Claude должен матчить **минимальные уникальные подстроки** (одно слово или короткая фраза), не комбинацию из двух — Ink почти гарантированно разнесёт их по чанкам.

### Onboarding `Quick safety check: Is this a project you created or one you trust?`

На первом запуске Claude в новой директории этот экран появляется раньше
обычного composer. Пользователь явно подтвердил10.09: для запускаемых из
Noted Terminal вкладок приложение само выбирает `Yes, I trust this folder`,
даже если CLI по умолчанию выделил `No, exit`. Это не универсальное согласие
на любые диалоги: например, auto-mode ниже по-прежнему сохраняет bypass.

Символ `❯` у варианта меню не является prompt-ready. Уникальный заголовок
`Quick safety check…` сразу блокирует raw glyph readiness, а действие разрешает
только полный закрытый main/headless кадр с описанием безопасности, `Security
guide` и обеими целыми опциями. Выбор определяется по смыслу текста, не по
номеру или позиции: старый порядок `Yes / No` требует Up от No, новый
ненумерованный `No / Yes` — Down. Затем новый committed кадр должен доказать
выделенный Yes; прямо перед Enter текущий кадр перечитывается, чтобы более
ранний Yes не подтвердил уже изменившееся меню. Unknown/неполное меню и
терминал без управляемого launch не получают клавиш. Перед Enter повторно
сверяются terminal, launch, run, lifecycle, mirror и input revision; после
Enter следующий committed frame обязан показать исчезновение меню. One-shot
привязан к launch/lifecycle generation, поэтому Ink re-render не создаёт второй
Enter. Лишь затем startup `/model`/`/effort` получает stable composer lease.

Причина инцидента10.09 tab209: старый автопроход умел лишь подтвердить уже
выделенный Yes. При новом default No он корректно запрещал paste в меню, но
не выполнял ожидаемое автоматическое действие. В production запуск03:21:12MSK
продолжился только после ручного Down03:22:52; отправки сообщения и send receipt
в этом промежутке не было. Поэтому это не timeout JSONL/CONFIRMING после Send,
а недоработанное управление startup-экраном. Увеличение timeout не устраняет её.

### Onboarding `Make auto mode your default permission mode?`

Claude может показать это меню до первого обычного composer. Для Noted
Terminal правильный выбор — `No, keep bypass permissions`: приложение не
меняет выбранный пользователем режим разрешений и продолжает тот же запуск.

Строка выбора `❯ 1. Yes…` не является готовностью ввода. Текст из PTY может
только разбудить проверку; действие разрешает полный закрытый main/headless
кадр того же процесса с заголовком и обеими целыми опциями. Если выбран `Yes`,
сначала отправляется `Down`, следующий кадр обязан доказать выбор `No`, затем
отправляется один `Enter`, и ещё один кадр обязан доказать исчезновение меню.
Только после этого разрешены startup `/model`/`/effort` и исходный prompt.
Частичный кадр, старое меню в scrollback и смена поколения ничего не нажимают.

### Startup defaults `/model` + `/effort` при запуске Claude

В StatusBar справа — app-level defaults для будущей сессии. Для fresh Claude
они заполняют стартовые Model/Effort; старый `claudeSessionId`, оставшийся в
SQLite строки переиспользованной вкладки, не превращает Start в Continue. Для
Resume/Fork launch generation несёт явный session intent: сначала читаются
последние подтверждённые значения активной ветки именно этой сессии, а defaults
заполняют только отсутствующие поля. Ошибка чтения существующей сессии означает
`unknown`: startup не инжектит defaults поверх неизвестного состояния Claude.
Историческое значение выбирает, **что восстановить**, но не доказывает, что
новый процесс уже это загрузил. Даже тот же session ID может стартовать на
Claude default; поэтому model history никогда не создаёт current-generation
claim и физический `/model` выполняется заново. Display label интерактивного
picker (`Fable 5`, `Opus 5 (1M context)`) перед отправкой переводится обратно в
настроенный command ID/alias. Пропустить шаг можно только после proof команды
или ручного выбора внутри этой же launch generation.
Полная пара, которую пользователь выбрал в ControlBar на остановленной вкладке,
является явным next-launch intent и имеет приоритет над обоими источниками.
Она остаётся durable после failed/superseded launch и удаляется только после
`ready` того же поколения, доказавшего и `/model`, и `/effort`.

```
Claude сначала закрывает actionable onboarding/trust screen текущей generation
→ рисует prompt-символ ⏵ в PTY → main эмитит claude:tui-ready (~0.8с после старта)
→ main открывает/присоединяет одну транзакцию по launch generation
→ main получает session settings из активной JSONL-ветки или SQLite defaults для fresh/пустых полей
→ транзакция ждёт устойчивый composer-frame того же generation: после последнего startup redraw наступила output-silence граница
→ если model ≠ 'none': main шлёт /model <value>, при необходимости подтверждает текущий picker
→ ждёт прямую JSONL-пару wrapper → local-command stdout
→ затем так же применяет /effort <value>
→ main публикует durable gate; renderer только отображает его
→ Project API/Terminal MCP получают отдельный readiness-change и завершают start wait
```

`claude:tui-ready` эмитится из того же места `main.js`, где Handshake впервые
детектит prompt-символ (`⏵` или `>`). Это ранний readiness-input: он доказывает,
что startup TUI дошёл до composer-фазы, но ещё не разрешает первый paste. Claude
может продолжать перерисовывать autocomplete/footer, и Enter, отправленный в это
окно, останется текстом в composer. Поэтому первый `/model` ждёт отдельный
generation-scoped stable-frame: существующий output-silence debounce сбрасывается
каждым новым PTY chunk и закрывается только после последней перерисовки. Это не
фиксированное ожидание готовности — разрешение приходит от фактического окончания
потока redraw. Шрам 2026-07-27: Project API C2 увидел `⏵`, сразу вставил
`/model haiku`, а финальный startup redraw пришёл ещё примерно через 0,9с;
команда осталась в поле и транзакция корректно завершилась `unresolved`.

**Владелец транзакции — Electron main, не Terminal renderer.** И
`tui-ready`, и `process-started` напрямую входят в один
`claudeStartupMainRuntime`; первый сигнал регистрирует транзакцию до первого
`await`, второй с тем же generation только join'ится. Renderer не содержит
send/prove/retry-кода. Это принципиально: скрытие History/Terminal, remount или
переключение вкладки не может потерять либо создать второго владельца.

Start/resume и последовательное применение `/model`/`/effort` показываются той же компактной lifecycle-плашкой, что запуск Codex: без backdrop и без захвата focus у терминала. Видимое TUI-подтверждение остаётся доступным для ручного управления, но сама плашка держится до authoritative ready или явной ошибки — наличие меню под ней не завершает startup gate.

**Bridge:Fresh (`claude:process-started`) — второй readiness-input, не второй initiator и не proof настройки.** Раньше инжект и завершение `/model` зависели от bridge, но свежий Claude TUI показывает первый prompt раньше появления bridge-файла, а Effort bridge вообще не содержит. Если `⏵` не распарсился, новый PID может открыть ту же main-транзакцию; если `tui-ready` уже открыл её, process-started только join'ится. Ни один из этих двух сигналов не обходит stable-frame перед первым вводом. Применённость обоих settings доказывает только JSONL stdout своей команды.

Если launch одновременно несёт первый пользовательский prompt, он остаётся в
очереди того же поколения до `startup gate = ready`. Stable-frame разрешает
служебную последовательность `/model` → `/effort`, но не пользовательский текст;
текст отправляется только после доказательства обеих настроек. При actionable
startup failure prompt сохраняется и уходит после успешного ручного Retry, а при
смене поколения старый dispatcher теряет ownership.

**Raw TUI ready не равен внешней готовности ввода.** До gate-ready main
публикует `starting/inputReady=false`. Project API и Terminal MCP подписаны не
только на первый TUI edge, но и на последующее main-side изменение readiness;
повторная проверка также читает main-owned gate, а не его возможную запоздалую
проекцию в renderer. Поэтому они не застревают на однажды прочитанном `pending`
и не возвращают успех до завершения startup settings. Failure той же
транзакции будит waiter сразу и возвращает явную ошибку вместо ожидания
watchdog timeout.

**`/model` completion barrier — JSONL local-command stdout, не return из paste и не bridge-update.** Return из отправки доказывает только доставку Enter. Следующий `/effort` разрешён после прямого stdout-ребёнка wrapper'а `/model`; поэтому поздний `Switch model?` не проглатывает effort, а изменение модели через терминал и UI получает один и тот же proof.

**`/effort` completion barrier — та же JSONL-пара.** Native stdout `Set effort level to ...` подтверждает выбор; prompt boundary остаётся отдельным readiness-сигналом для следующего TUI-действия, но не источником значения effort.

После шрама 2026-06-21 boundary proof разделён на два слоя: main-side detector по-прежнему инжектит OSC 7777 marker в PTY для terminal/Timeline, но одновременно отправляет direct `claude:prompt-boundary` event в renderer. `waitForPromptBoundaryAfter` должен просыпаться от direct seq, а не зависеть только от того, что xterm parser успел зарегистрировать marker. См. `fix-boundary-bridge-race.md::Дополнение 2026-06-21`.

Proof имеет три исхода: `found`, `absent`, `unresolved`. Только доказанное
`absent` разрешает **один** автоматический повтор. Доказательство здесь
составное: владелец отправки явно знает, что ещё не писал `Enter`, а main через
current-composer copy одновременно видит в поле ровно эту slash-команду.
Повторяется только `Enter`, а не весь paste. Exact-команда без первого факта
тоже не считается достаточной: это мог быть восстановленный пользовательский
черновик с тем же текстом. Одного отсутствия строки в JSONL недостаточно; при
неизвестном submit, пустом, изменившемся или нечитаемом composer результат
`unresolved`, потому что настройка могла уже примениться. Автоматического
повтора тогда нет, gate остаётся failed с точной командой и кнопкой Retry —
пользователь сам решает, принимать ли риск повторного применения.
Lifecycle-плашка не исчезает как при успехе, не закрывает терминал backdrop'ом
и не забирает focus.

Прямой stdout-ребёнок с ошибкой — отдельный детерминированный исход: команда
дошла до Claude, но провайдер её отклонил. Для истёкшего OAuth (`Unable to
validate model: OAuth refresh token is no longer valid`) gate хранит код
`claude_auth_expired`, показывает `Claude login expired` и просит сначала
выполнить `/login`, затем нажать `RETRY SETTINGS`. Успешный `/login` сам по себе
не доказывает и не повторяет `/model`: скрытая автоматическая смена модели после
ручного входа могла бы перетереть более поздний выбор пользователя. JSONL-теги
`<local-command-stdout>` остаются транспортной оболочкой и не выводятся в
toast/копируемый отчёт; такой отчёт относится к startup settings, а не к send
handoff.

Completion chain для Rewind из остановленной сессии:
1. Timeline поднимает `claude --resume` той же session id.
2. Читаются подтверждённые model/effort этой сессии; app defaults используются только для отсутствующих значений.
3. `/model <value>` и затем `/effort <value>` подтверждаются своими JSONL stdout.
4. Startup gate ждёт готовый prompt; timeout = startup settings failed, а не разрешение продолжать.
5. Только после gate-ready Timeline вызывает native `/rewind`.

**Graveyard — Bridge:Fresh как единственный сигнал → двойной `/effort`.** Пока инжект висел только на `Bridge:Fresh`, юзер видел нарисованный prompt без эффекта (3-6с лага), решал что «эффект не выставился», кликал `/effort` руками в ControlBar → улетал **первый** `/effort`, потом запоздавший Bridge:Fresh догонял **вторым**. В JSONL/scrollback копилось два `/effort max` подряд. Детерминированно подтверждено счётчиками `[EffortDiag][HANDLER-ENTRY] callN` / `[INVOKE-FIRE] invokeN` — handler входил один раз, но первая команда уходила за 391мс **до** него (это был ручной клик). Чинится связкой ранний-сигнал + sentinel ниже.

**Main launch-scoped claims — только дедупликация/ownership, не proof значения.**
Подтверждённый startup-step и явный ручной выбор ControlBar/mobile записываются
в main для текущего launch generation. Если пользователь выбрал effort, пока
startup ещё доказывает model, следующий default-effort ждёт результат
существующего JSONL-proof ручной команды. При успехе явный выбор выигрывает и
default пропускается; при ошибке claim откатывается и startup применяет default
сам. Поэтому gate не может стать ready на одном лишь факте отправки ручной
команды. Renderer navigation/crash явно освобождает оставшиеся proof-waiters,
чтобы main не завис навсегда. Отображаемое и восстанавливаемое значение
по-прежнему берётся из подтверждённой JSONL-ветки. Renderer-карты
`_modelSentForTab` / `_effortSentForTab` остались только зеркалом
presentation/cross-client UI и не управляют startup.

**PID hook-route ≠ Bridge readiness.** `safePasteAndSubmit` может заранее
связать PID Claude с вкладкой, чтобы `UserPromptSubmit` hook не потерял первый
prompt. Эта route-привязка не означает, что `claude:process-started` уже
публиковался. Fresh-once состояние Bridge хранится отдельно: первая statusLine
запись процесса всё равно join'ится к уже открытой startup-транзакции, а
повторные записи того же процесса ничего не инициируют.

**Сброс sentinel'а — на смерти Claude (`command-finished`), не только на смерти shell (`terminal:exit`).** Первая версия чистила `_effortSentForTab` **только** в `handleExit` (PTY exit = shell умер). Но `claude-c` (Continue/restart) **переиспользует тот же shell PTY** — shell не выходит, `terminal:exit` не fires, sentinel от **первого** запуска в жизни таба живёт вечно. Каждый последующий рестарт Claude: `tui-ready` fires → `_effortSentForTab.has(tabId)` → `true` → early-return → `/effort` **молча не отправляется**. Эффект: `/effort` инжектится ровно один раз за всю жизнь вкладки, при рестартах — никогда. Юзер: *«сессию я перезапускал, при перезапуске почему-то автоматически /effort не срабатывал, хотя он установлен системой»*.

Прод-подтверждение (tab-283, `ea2ae02c`, 2026-06-03): на 4 рестартах подряд лог `[Terminal:EffortInject] … SKIP — already sent via tui-ready` (callN=2,3,4,5), и **ни одной** строки `[Terminal:TuiReady] … /effort max` после первой. Сигнал смерти Claude при живом shell — **OSC 133 D** (`terminal:command-finished`, тот же что гасит `claudeProcessAlive`). Теперь он очищает launch generation, main-транзакцию и main claims; renderer очищает лишь свои UI-зеркала. Принцип: **once-per-process состояние должно сбрасываться на смерти ТОГО процесса, к которому привязано (Claude), а не на смерти контейнера (shell)** — иначе reuse контейнера навсегда залипит метку.

**Почему без setTimeout:** `safePasteAndSubmit` сам ждёт sync-marker `\x1b[?2026l` от Ink. Если инпут ещё не готов — ждёт **внутри** функции (event-driven). Возвращается за 8-30ms на happy path. Раньше был paranoid `setTimeout(800ms)` обёртка — это "timeout как safety net вместо причины", антипаттерн (см. `methodology/дизайн-принципы.md::Воспринимаемая задержка UI-команд`).

**`max` нельзя задать в settings.json:** Claude CLI silently downgrades `effortLevel: "max"` до null при первом запуске. Максимум что settings.json держит — `high`. Из-за этого инжекция через `/effort max` — **единственный** способ стартовать сессию в max effort.

**Persistence — SQLite, не localStorage.** `defaultClaudeEffort` сохраняется через `app:setState` IPC. Раньше был localStorage — но vite-dev меняет порт (5181 → 5182 → 5183) когда есть orphan Electron'ы, и каждый порт это **отдельный origin** → отдельное localStorage хранилище. Юзер видел "max сбрасывается после рестарта", думал что не сохраняется — на самом деле сохранялось, но на другом origin'е. См. `fix-localstorage-origin.md`.

**Post-inject поведение: wrapper остаётся в JSONL, Timeline его скрывает фильтром.** Каждый спавн Claude в табе → `process-started` → инжект `/effort <level>`. Claude TUI синхронно пишет в JSONL пару записей:

```
{type:'user', content:'<command-name>/effort</command-name>...<command-args>max</command-args>', uuid, parentUuid, ...}
{type:'user', content:'<local-command-stdout>Set effort level to max ...</local-command-stdout>', parentUuid: <предыдущая>}
```

**Мы их НЕ стираем.** Timeline render (`claude-data.js::parseTimelineEntries`) пропускает любые записи с тегами `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-stderr>`, `<bash-notification>` — это существующий tag-filter, который и так покрывает `/compact`, `/clear`, `/status`, любые slash-команды. `/effort` попадает под тот же фильтр автоматически. В Timeline у юзера wrapper-карточки **не появляются**. parentUuid цепочка через wrapper проходит насквозь — `recordMap` его держит, render просто пропускает.

**Graveyard №1 — busy-state trigger.** До artifact-side `fs.watch` пробовали слушать `claude:busy-state` edge true→false как сигнал окончания /effort turn'а. **Не сработало**: `/effort` это slash-команда, обрабатывается inline в Claude TUI **без вызова model API** → Stop hook никогда не fires (`query.ts:1062::handleStopHooks` срабатывает только после `model.complete()`, для slash-команд этого пути нет) → `claude:busy-state` остаётся false весь pendulum → safety timeout 5s срабатывал на каждом инжекте, cleanup пропускался. В логах юзера было видно три подряд `/effort max` в JSONL и три `busy-state timeout — Claude turn never finished, skip cleanup`.

**Graveyard №2 — full-file rewrite после artifact-side fs.watch.** Перешли на `fs.watch` JSONL + tail-read дельты + match wrapper → batch-delete + relink parentUuid детей. Первая реализация делала `fs.readFile(filePath)` целиком → `JSON.parse` каждой строки → batch-relink всех parentUuid в targets set → `JSON.stringify` обратно → atomic tmp+rename. Корректно работало, но на сессии с 115 MB JSONL занимало **3 секунды CPU-блока main process** — за это время `provider:switch` / `provider:set-options` IPC handlers стояли в очереди, ClaudeControlBar показывал залипший shimmer-overlay, юзер не мог переключить модель. Юзер: *«вертикальная черта идёт очень долго»*, *«мы всё равно не можем редактировать историю до последнего юзер-сообщения, можем только с конца»*.

**Graveyard №3 — tail-mode rewrite.** Свели полный rewrite к **только последним 16 KB** файла: `fs.open` + `read(buf, 0, 16K, fileSize - 16K)` → split на строки → найти самый правый `<command-name>/effort` wrapper в хвосте → `truncate(filePath, wrapper.startOffset)` + `appendFile(остатки)`. На тех же 115 MB занимало 4 ms вместо 3 секунд. Релинк parentUuid не делался — расчёт был на то что запись только что инжектнута, у неё ещё нет детей.

**Graveyard №4 (final) — tail-mode создавал phantom parentUuid race.** Расчёт «у wrapper'а ещё нет детей» был неверен. Cleanup отрабатывал через 0.5-1с после inject'а (как только `fs.watch` ловил появление wrapper'а), но **первый user prompt в новой сессии** Claude TUI писал через 5-60 секунд (юзер шёл за кофе, читал предыдущий контекст, формулировал вопрос). К моменту prompt'а wrapper уже стёрт → Claude TUI пишет prompt с `parentUuid: <deleted-wrapper>` → orphan → красная зона в Timeline. Конкретный repro 2026-05-23: на 4 сессиях подряд (`8f0a0b48`, `cb2e4c26`, `09351b71`, `e4be2fe0`) phantom создавался ровно этим путём, лог `[DeleteEffortEntries] removed=2 relinked=0` — relink-pass всегда проходил вхолостую, потому что дети ещё не существовали. Юзер на 5-й сессии получил предупреждение «Обрыв UUID в JSONL», стал замечать паттерн: *«при смене effort у меня осталось предупреждение что сессия потеряна UUID»*.

**Live cleanup удалён полностью (2026-05-23).** `startEffortCleanupWatcher` / `stopEffortCleanupWatcher` / Map `claudeEffortCleanupWatchers` / IPC `claude:arm-effort-cleanup` / вызов из `Terminal.tsx::handleProcessStarted` — всё удалено. Wrapper остаётся в JSONL, Timeline и так его не рендерит через tag-filter. Принцип переносимый — см. [`methodology/дизайн-принципы.md::Не модифицируй чужой shared append-only файл во время работы владельца`](../methodology/дизайн-принципы.md).

### On-restart trailing `/model` + `/effort` trim (безопасный наследник cleanup'а)

После удаления live cleanup'а startup slash-команды стали копиться: каждый перезапуск Claude может инжектить `/model <default>` и `/effort <default>`, а в Claude TUI scrollback и rewind-меню появляется стопка служебных строк (`/model haiku`, `/effort low/max`) подряд. В нашем Timeline их не видно из-за tag-filter'а, но native `/rewind` видит родной picker Claude и эти строки становятся реальными target-ловушками. Пользовательский симптом: после нескольких рестартов в истории сверху/снизу видны десятки `/model haiku` / `/effort low`, а Rewind может восстановить slash-команду вместо выбранного сообщения.

Решение — `_trimTrailingStartupSlashEntriesFromFile()` через публичный helper `_trimTrailingEffortEntries(sessionId, cwd)` в `claude-data.js`, вызывается **синхронно** из pre-resume путей (`claude-c`, direct `terminal:input` resume и `claude:repair-jsonl-before-resume`) **до** `term.write('claude --resume')`. Ключевое отличие от удалённого live-cleanup'а: чистка идёт когда **предыдущий Claude процесс уже мёртв** → никто не допишет ребёнка к удаляемой записи → phantom-parentUuid race **физически невозможен**. Это тот же инвариант что в [`methodology/дизайн-принципы.md::Не модифицируй чужой shared append-only файл`](../methodology/дизайн-принципы.md): мутируем чужой файл только когда owner не активен.

**Строгий suffix-match (цикл по блокам), plain truncate, без relink.** Алгоритм читает последние 512 KB, идёт от конца **в цикле**, отслаивая startup slash-блоки один за другим. Один блок (от конца): `[trailing meta / No response requested]* → stdout(command=X) → wrapper(command=X) → [один caveat]?`, где `X ∈ {model, effort}`. После блока снова может идти meta и ещё блок: юзер перезапустил сессию N раз подряд **без сообщений между**, каждый рестарт инжектит свежие `/model` и `/effort`, в хвосте копится `/model, /model, /model` или `/effort, /effort, /effort` вплотную. Цикл съедает **все** подряд идущие блоки за один проход и **останавливается на первой реальной записи** (user/assistant). Если после `/model` или `/effort` есть реальное сообщение — эту команду не трогать: у неё появился потомок, резать = порвать parentUuid chain → phantom.

Граничный случай (реальная сессия `dfa77496`): `/effort #1 → ответ Claude → /effort #2`. Срезается **только** #2 (хвост), #1 остаётся навсегда — у него потомок (ответ). То же правило для `/model`: если после `/model haiku` было реальное сообщение, этот wrapper уже часть parentUuid-chain и не удаляется. Юзер может видеть в Claude TUI scrollback две служебные команды и думать что trim не дорезал; на деле первая неприкосновенна by design. Только **подряд** идущие startup-команды без ответа между схлопываются полностью.

Поскольку режем строго непрерывный хвост и после него ничего не остаётся — релинк не нужен, никакая оставшаяся запись не ссылается на удалённые (parentUuid всегда указывает назад). Чистый `truncateSync(filePath, byteStart)`, без re-append.

**Шрам — байты vs символы (поймано в тестах до прода).** Первая версия делала split через `tailText.indexOf('\n')` (строковый индекс) и truncate на `startOffset + charIndex`. На сессии с кириллицей (`5fbdb1d9`) это резало **в середине записи** — `trimmed:6` рапортовалось, реально удалялось 13 строк, последняя оставшаяся = битый JSON. Корень: UTF-8 кириллица многобайтовая, character-index ≠ byte-offset, а `fs.truncateSync` работает в байтах. Фикс: split через `buf.indexOf(0x0A)` в Buffer, все offset'ы байтовые (`startOffset + p`), не строковые. Тот же класс ловушки что [`methodology/дизайн-принципы.md::Ink TUI`](../methodology/дизайн-принципы.md) (bytes ≠ chars при работе с PTY/файлами). Verified: на 455 сессиях срабатывает на 3, `corruptBefore == corruptAfter` (не вносит новой порчи), `trimmed == actualLineDiff`.

Лог: `[TrimStartupSlash] session=<sid> trimmed trailing startup slash blocks (N lines, model=X, effort=Y) at offset <byteOffset>`. `_deleteEffortEntries` (старая re-append версия) оставлена мёртвым кодом — НЕ переиспользована, потому что она re-append'ит хвост после удаляемого без relink (создала бы phantom если бы после slash-команды была реальная запись). Новая функция избегает этого через строгий suffix-match.

### EffortInject kill-switch (`effort=none`) + resume-guard

В StatusBar `Effort=none` означает «не задавать effort по умолчанию для fresh/неопределённой сессии». Это больше не глобальный запрет восстановить уже подтверждённый session-scoped effort: Resume обязан вернуть effort своей сессии даже если app default сейчас `none`. Если чтение session settings упало, состояние `unknown` также не вызывает paste — приложение не угадывает.

**Resume-guard — только на process-started/Bridge:Fresh пути, НЕ на tui-ready.**

**Граветярд ложной предпосылки (горело tab-3234 `6f26c93d`, 2026-06-07).** Первая версия guard'а полностью skip'ала инжект на `--resume` под предлогом «Claude восстановит effort сам». Это неверно: Resume — свежий процесс, и session-scoped `max`/другой уровень может не пережить запуск через Claude settings. Поэтому безопасный `tui-ready` путь повторно применяет не текущий app default, а последнее подтверждённое значение активной ветки возобновляемой сессии.

**Что guard РЕАЛЬНО защищал.** Incident 2026-05-21 15:09:34 был **paste-race**, не «resume preserves effort»: Bridge:Fresh event и `Terminal:EffortInject` сработали в одну и ту же миллисекунду на `--resume`, `safePasteAndSubmit`'s Ctrl+S stash race'нулся с paste — `[PasteAudit:MISMATCH]` поймал что вместо 11 байт `/effort max` в композер влетели 303 байта старого user prompt'а из buffer. Гонка была на **Bridge:Fresh / process-started** пути — он fires **во время** resume-handshake (bridge.json только появился, PTY ещё может дописывать).

**Фикс — guard остаётся ТОЛЬКО на process-started, снят с tui-ready.** `tui-ready` fires когда Claude **нарисовал `⏵` prompt** = resume-handshake завершён, инпут idle/ready. Это не racer (он позже handshake'а по определению). Поэтому re-inject на resume идёт через tui-ready безопасно. Sentinel `_effortSentForTab` гарантирует **один** инжект: tui-ready ставит метку за 2-6с до Bridge:Fresh, тот видит метку → no-op. Если `⏵` не распарсился (новая версия TUI) — fallback Bridge:Fresh, но он по-прежнему skip'ается на resume (там paste-race), так что в этом редком случае max на resume не применится — приемлемо, лучше потеря max чем порча prompt'а.

Детекция resume: через renderer-side `getPendingResume(tabId)` из `utils/pendingResume.ts`. `markPendingResume` ставится при `claude --resume <sid>` (в AutoResume и любом другом code path запускающем resume), `clearPendingResume` в `handleSessionDetected` после bridge confirmation.

Полная таблица поведения:

| Условие | `/effort` paste | Путь | Лог |
|---|---|---|---|
| fresh/поле отсутствует + app default `none` | NO | — | `SKIP — effort=none` |
| Resume + подтверждённый session effort + tui-ready | **YES** | tui-ready | `/effort <session value> (early path)` |
| Resume + только Bridge:Fresh | NO | process-started | `SKIP — resume in flight` |
| Чтение session settings = `unknown` | NO | — | `fallback=claude-session-state` |
| fresh Claude + app default `max/.../low` | YES | tui-ready | (обычный flow) |

### Click-toggle-off на effort кнопке

Повторный клик на уже-активный effort → выбор сбрасывается на `auto` (DeepSeek: `off`). Это **переносимый UX-принцип** (см. `methodology/дизайн-принципы.md::Click-toggle-off на single-select`) — для filter pills, tag selectors, любых toggle-эквивалентных кнопок.

Реализация: `const targetLevel = isActive ? (isDeepSeek ? 'off' : 'auto') : level;` — один тернарник в onClick, остальная логика без изменений. Tooltip меняется на `Click again to deselect (→ auto)` когда `isActive`.

## Stop button — SIGTERM по PID, не keystroke в TUI

InfoPanel `SessionActionChip` hover → "Stop" → клик. Реализация **должна** вызывать `terminal:stop-ai-process` (SIGTERM по PID Claude process), **не** слать `\x03` (Ctrl+C) в PTY.

**Почему Ctrl+C не работает:** Claude TUI обрабатывает одиночный Ctrl+C как **"clear input"** (если в input есть текст) или **"взвести danger zone"** (Press Ctrl-C again to exit). Юзер кликает Stop → Claude не умирает, никаких ошибок → недоумение.

**SIGTERM по PID детерминированный:** `terminal:stop-ai-process` находит дочерний PID через `ps -eo pid,ppid,command | grep claude` где `ppid === ptyProcess.pid`, шлёт `SIGTERM` через `process.kill`. Через 800ms escalate в `SIGKILL` если процесс не умер. Тот же IPC использует split-button "Stop Claude" в TabBar — если split-button работает, InfoPanel Stop должна работать так же.

С момента клика Stop до реального exit есть отдельное runtime-состояние `stopping`. Оно публикуется через общий agent status сразу после stop intent, а не выводится задним числом из `inactive`: desktop status, History, Project API и iOS должны видеть `STOPPING CLAUDE...` и блокировать send/resume/rewind, пока kill-ladder не завершился. Desktop использует ту же компактную lifecycle-плашку слева сверху, что Claude/Codex start: без backdrop и без захвата focus, с янтарным акцентом. Это не снимает logical lock: main отбрасывает raw `terminal:input` и отклоняет `terminal:paste` до финального exit, поэтому просмотр/scroll/selection доступны, а клавиши не могут попасть в shell после смерти процесса. Пользовательский симптом нарушения — Stop уже нажат, но через долю секунды снова виден composer/Resume и можно запустить новый action поверх умирающего Claude.

### Mobile preserve-shell Stop (SIGTERM по PID, тот же `terminal:stop-ai-process`)

Mobile-web `stopClaudeTab` bridge action в `src/renderer/App.tsx::handleWebBridge` зовёт `ipcRenderer.invoke('terminal:stop-ai-process', tabId)` — тот же handler что и desktop Stop-кнопка. Найдёт claude child-PID через `ps -eo pid,ppid` под shell-PID, шлёт SIGTERM, через 800ms эскалирует в SIGKILL если жив. Shell PTY не трогается — Resume в этом же табе пишет `claude --resume <id>\r` в живой shell.

**Graveyard: Ctrl+C × 2 через `terminal:input` с задержкой 250ms.** Жил до 2026-05-28, отброшен после детерминированной диагностики: `CtrlC-DangerZone` в `main.js:6711` сработал **дважды** в логах (на каждый Ctrl+C), значит Ink TUI **перерисовал prompt** между ними и второй Ctrl+C трактовался как **новый первый** ("Press Ctrl-C again to exit" опять) — Claude не выходил, через 42 сек desktop ещё видел `isCommandRunning=true`. Это явно отмечено в `fix-claude-busy-detection.md::4` как rejected approach (0ms = Ink merges, 500ms = Ink redraws). 250ms попало ровно в зону redraws. Любая фиксированная задержка ненадёжна — Ink реагирует за разное время в зависимости от content density текущего экрана.

Дополнительный side-effect Ctrl+C×2-подхода: если Claude не умирал — не срабатывал PTY-exit cleanup в `main.js:7029-7031` (`_webBroadcast 'busy=false, sessionStatus=inactive'`), и mobile composer **залипал в busy навсегда** — нет ни turn-end, ни exit-event'а. SIGTERM-путь чинит это попутно: kill → PTY exit handler → broadcast inactive → mobile сбрасывает busy.

Ctrl+D (`\x04`) **категорически нельзя** на mobile — после убийства Claude EOF закрыл бы shell → PTY exits → таб умрёт целиком. SIGTERM по PID этой проблемы не создаёт: kernel доставляет сигнал ровно child-процессу claude, shell не получает ничего. См. `fact-mobile-claude-pty.md::Resume guard rails`, `fix-claude-busy-detection.md::4`.

## Реактивное управление Think Mode

### Почему не просто отправить команду
Think mode переключается через `meta+t` (`\x1bt` = ESC + t), но это открывает **TUI пикер** с двумя опциями:
1. Enabled ✔ / Disabled
2. "Enter to confirm · Esc to exit"

При переключении mid-conversation Claude показывает **второй диалог** подтверждения: "Do you want to proceed?"

### Реактивный алгоритм (IPC `claude:toggle-thinking`)
```
1. Отправить \x1bt (meta+t)                  — открыть пикер
2. Дождаться следующего \x1b[?2026l             — TUI закончил новый кадр
3. Дождаться flush main-owned headless mirror   — исключить differential chunk
4. Прочитать полный текущий visible snapshot
5. Найти строки "Enabled", "Disabled", "✔"    — определить текущее состояние
6. Отправить стрелку (\x1b[B вниз или \x1b[A вверх) — перейти на другую опцию
7. Прочитать следующий полный кадр и доказать выбранную опцию
8. Отправить \r                               — подтвердить выбор
9. По полному кадру проверить "proceed"         — второй диалог подтверждения
10. Отправить \r                              — подтвердить proceed
11. Повторно открыть picker, перечитать сохранённую галочку и закрыть picker
```

**Ключевые маркеры PTY:**
- `\x1b[?2026h` — начало synchronized output (Ink рисует)
- `\x1b[?2026l` — конец synchronized output (Ink закончил, можно парсить)
- `✔` (U+2714) — галочка активной опции
- `❯` — курсор выбора в пикере
- "proceed" — маркер второго диалога подтверждения

**Определение текущего состояния:**
```
enabledIdx  = clean.indexOf('Enabled')
disabledIdx = clean.indexOf('Disabled')
checkIdx    = clean.indexOf('✔')
wasEnabled  = |checkIdx - enabledIdx| < |checkIdx - disabledIdx|
```

### UI отображение
Кнопка "toggle" в InfoPanel. После переключения показывает "think on" / "think off" фиолетовым цветом (#b4b9f9) на 3 секунды.

**Per-send настройки предшествуют proof пользовательского prompt.** Если один
send запросил model, effort или Think, scenario сначала полностью заканчивает
эти действия и лишь затем заново проверяет composer. Финальный prompt получает
свежий exact-empty proof после последней мутации; proof, снятый до slash-команды
или picker-а, использовать нельзя. Think считается завершённым только когда
runtime вернул успешное и совпадающее с запросом конечное состояние.
Незавершённый picker, отсутствие boolean-результата или mismatch остаются
`unknown`: пользовательский prompt не пишется и состояние не угадывается. Если
per-send caller ещё не знает состояние вкладки, он передаёт желаемое значение в
main: тот читает галочку настоящего picker-а и либо меняет выбор, либо закрывает
уже совпавший picker. Отсутствующие `Enabled`/`Disabled`/`✔` — ошибка
`think_picker_state_unknown`, а не прежний default `enabled`. Если текущий
полный кадр уже содержит открытый Think picker, операция продолжает именно его,
не нажимая `meta+t` второй раз. Неполный differential output не используется
для выбора; доказанно открытый, но неоднозначный picker закрывается через Escape
и возвращает точный pre-submit failure.

### Точный proof пустого composer и транспорт prompt

Если спорный экран уже был перепроверен через exact same-generation capture и
Claude вернул пустой composer, эта квитанция принадлежит конкретной операции
отправки. Финальная граница перед paste проверяет её terminal/input/run/
lifecycle/frame identity и **потребляет** её; она не запускает заново исходную
экранную эвристику и не объявляет собственный PTY-writer конфликтом. Любое
несовпадение оставляет состояние `unknown`, но точное доказательство не может
само себя отменить на следующем слое.

Есть одна доказанная форма, где screen сам уже достаточно точно показывает
пустой composer: курсор стоит сразу после `❯`, а весь непустой хвост отмечен
Claude семантическим ANSI-атрибутом `dim`, без инверсии, отдельного фона и
продолжения на следующей строке. Это provider-owned ghost-подсказка, а не draft;
её нельзя определять по RGB темы. Обычный или смешанный текст, сдвинутый внутрь
хвоста курсор и любая control-surface по-прежнему дают `unknown` и сохраняют
exact Ctrl+G fallback. Внешнее поведение Claude и причина ограничения описаны в
[`fact-claude-tui-mechanics.md`](fact-claude-tui-mechanics.md#тусклая-ghost-подсказка-в-composer).

Текст намерения и байты для Claude transport хранятся раздельно. Перед paste
табуляция детерминированно превращается в четыре пробела, `CRLF`/`CR` — в `LF`,
Unicode сохраняется, а некорректная UTF-16 строка отклоняется до paste. Audit
связывает исходный пользовательский текст и нормализованный транспорт, поэтому
нормализация не создаёт ложный mismatch и не ослабляет identity соседних
операций.

Ctrl+G не является пассивным чтением экрана: он открывает внешний editor и
может скопировать, забрать или вернуть composer. Поэтому Copy/Grab/Restore
занимают ту же main-owned PTY write-очередь, что paste, Enter, Think и Rewind,
и получают новую input identity непосредственно перед Ctrl+G. Capture,
поставленный после prompt paste, ждёт завершения его Enter; prompt, поставленный
после capture, обязан получить уже новое доказательство composer. Native Rewind
использует внутреннюю already-owned границу, чтобы не создать nested-lock.

Событие `GrabInput` ещё не означает, что Claude вернулся в composer: helper в
этот момент ждёт ACK и сам остаётся жив. Main вооружает ожидание следующего
полного synchronized frame до ACK, держит PTY-очередь до этого frame и только
после него возвращает результат Copy/Grab/Restore. Поэтому два Ctrl+G подряд,
Enter сразу после copy и clear «на удачу» больше не являются отдельными путями.
Если frame не подтверждён, операция завершается неизвестным исходом без
следующей записи в input.

Низкоуровневый raw paste остаётся доступным, но generic IPC не может
автоматически нажать Enter в живой Claude без handoff, точной draft-проверки и
ожидания `UserPromptSubmit`. Это не ограничивает ручную вставку, dictation,
Prompt Picker или Gemini; оно не даёт новому caller-у случайно обойти общий
scenario/receipt контракт.

## Per-provider behavior: Model, Effort, Think

InfoPanel содержит **две зависимые строки** — Provider row и Model row — плюс Effort и Think. Принцип двухуровневого селектора (Provider → Model) описан в `methodology/дизайн-принципы.md::Two-tier hierarchical selectors`. Здесь — конкретика поведения и **разные backend'ы для одинаковых UI-контролов** в зависимости от выбранного провайдера.

### Model row vs реальный target запроса

Model row для **Anthropic** показывает Claude TUI выбор модели (default/sonnet/opus/haiku), который читается из `bridge.sh`. При смене провайдера на Zen/DeepSeek **bridge продолжает показывать Claude-модель** — это не правда о реальной цели запроса. Реальный target — в Provider row + бейдж в Timeline footer (см. `fact-provider-proxy.md::Bridge врёт про active provider` и `fact-timeline.md::Provider badge`).

Соответственно клик по модели имеет разный эффект:
- **Anthropic:** отправляет `/model haiku` через `claude:send-command` в PTY — Claude TUI переключает модель внутри своей сессии
- **Zen / DeepSeek:** обновляет `providerState.model` через `provider:switch` IPC. Claude TUI про это ничего не знает, его собственная модель остаётся прежней (но в реальных запросах model переписывается в proxy)

### Effort: три пути за одним UI

Одна и та же Effort row рассылает команды в **разные backend'ы** в зависимости от Provider'а текущего таба:

| Provider | Backend | Механизм | Уровни |
|---|---|---|---|
| Anthropic | Claude TUI | `/effort high` через `claude:send-command` (PTY) | `auto/low/medium/high/max` |
| DeepSeek | Proxy body inject | IPC `provider:set-options { effort }` → proxy дописывает `output_config.effort` | `off/low/medium/high` |
| Zen | (не поддерживается) | UI dim, кнопки `disabled` | — |

**Почему такой mapping:** Anthropic effort — это поведение **внутри** Claude (как долго думать), управляется через TUI команду. DeepSeek effort — это поле в **request body** к их API. PTY-команда `/effort high` для DeepSeek-режима бессмысленна, потому что её эффект не доходит до DeepSeek API (proxy перехватит body раньше). Zen в текущей версии API не описывает аналога.

### DeepSeek: Think folded into Effort

Думаешь, что Think и Effort — независимые контролы? Для DeepSeek это **не так**. API DeepSeek возвращает HTTP 400 если в body одновременно `thinking:{type:'disabled'}` и `output_config.effort`. См. constraint в `fact-provider-proxy.md::DeepSeek режим`.

**Решение в UI:** для DeepSeek Effort row становится 4-значным селектором `[off][low][medium][high]`:
- `off` — proxy шлёт `thinking:{type:'disabled'}` БЕЗ `output_config`
- low/medium/high — `thinking:{type:'enabled'}` + соответствующий `output_config.effort`

**Think row для DeepSeek скрыта целиком** — её включает/выключает значение `off` в Effort. Дублирующий toggle = source of conflicts.

### Per-tab state vs локальный effortLevel

Для **Anthropic** effort хранится в `effortLevel: Record<tabId, string>` в InfoPanel local state — потому что bridge не транслирует обратно (Claude не подтверждает что принял `/effort high`). Это локальный «invisible intent».

Для **DeepSeek** effort живёт в `providerStates: Map<tabId, state>` в main process (`fact-provider-proxy.md::Per-tab routing`) и каждый запрос proxy читает оттуда. Backend подтверждает применение фактом успешного ответа.

## Handshake (Prompt Injection при запуске)

### Текущая версия (упрощённая)
```
WAITING_PROMPT → DEBOUNCE_PROMPT → send prompt → done
```

Thinking mode при запуске **не отправляется** через Handshake — это делает `alwaysThinkingEnabled: true` in `~/.claude/settings.json` глобально.

### Шаги
1. **WAITING_PROMPT:** Ждёт prompt-символа (`⏵` или `>`) в PTY output через `stripVTControlCharacters()`
2. **DEBOUNCE_PROMPT:** 300ms тишины (Ink рисует UI, может быть несколько чанков)
3. **Send prompt:** Bracketed paste + delayed `\r` (тот же паттерн что и `claude:send-command`)

### Что убрано (v2 → v3)
- **TAB_SENT / DEBOUNCE_TAB** — отправка `\t` для thinking mode. Стало ненужным с `alwaysThinkingEnabled: true`
- Было 4 состояния, стало 2
