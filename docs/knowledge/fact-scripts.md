# Feature: Terminal Scripts

## 1. Intro + User Flow
Запуск npm-скриптов из `package.json` и `.sh`-файлов из корня CWD через контекстное меню таба (ПКМ → Scripts).

**Flow:**
ПКМ по табу → Подменю "Scripts" (подгружается из `package.json` + `.sh` файлы CWD этого таба) → Клик по скрипту → В терминал отправляется `npm run [name]` или `./script.sh`.

## 2. Behavior Specs
- **Динамическое считывание:** Список скриптов загружается при открытии контекстного меню (запрашивается актуальный CWD через `terminal:getCwd`).
- **Фильтрация приватных команд:** Скрипты с подчёркиванием (`_rebuild`) скрываются из UI.
- **Dev-Server Auto-Detection:** При запуске скрипта, имя которого начинается с `dev`, `start`, `serve` или `watch` (regex: `/^(dev|start|serve|watch)/i`), автоматически вызывается `setTabCommandType(tabId, 'devServer')`. Это делает таб зелёным и активирует кнопку перезагрузки (RestartZone).
- **Shell-скрипты (.sh):** Помимо npm, парсятся `.sh` файлы в корне CWD (скрытые `.`-файлы исключаются). Отображаются как `./script.sh`. Если есть и npm, и sh — между ними разделительная черта. Dev-Server Auto-Detection работает и для sh (например, `watch.sh` → devServer).
- **Подменю с отступом:** Scripts отображаются как подменю контекстного меню (CSS `group-hover/scripts`), открывающееся вправо.

## 3. Stop Running Process
Все script/devServer stop-пути отправляют `\x03` — Ctrl+C в PTY. Не подменять это SIGTERM по PID: shell сам доставляет SIGINT foreground process group, dev-server получает graceful exit, а UI остаётся в той же терминальной модели.

Текущие поверхности остановки:
- **ПКМ по табу → верхний Close+Stop split-pill** — основной путь для running script/devServer в tab context menu. Stop script mirror'ит Stop Claude UX, но зовёт script-stop ветку.
- **Cmd+hover по правой reload-кнопке в vertical sidebar** — только для зелёной `commandType === 'devServer'` вкладки с живым process-status. Та же кнопка превращается из restart в красный square-stop; click шлёт только Ctrl+C. Подробнее — `fact-process-bar.md::Restart button stop-mode для devServer`.
- **Middle-click на RestartZone** — fallback для horizontal layout, где RestartZone всё ещё рендерится отдельно и `onAuxClick` перехватывает middle-click ДО TabItem.
- **ПКМ по терминалу → Scripts (● running) → ● Stop process** — нативное Electron меню в main.js, проверяет `terminalCommandState.get(tabId).isRunning`.
- **External REST `POST /terminal/stop`** — тот же deterministic Ctrl+C stop для sibling-процессов
  вроде Voice Record build-install preflight. Этот route не закрывает вкладку и не SIGTERM'ит PID:
  он сохраняет терминальную модель “остановить foreground process, оставить shell/tab жить”.

**Trap: Два раздельных контекстных меню скриптов.** Tab context menu (ПКМ по вкладке) — React-компонент в `TabBar.tsx`, проверяет `processStatus` Map + `commandType` из store. Terminal context menu (ПКМ по терминалу) — нативное `Menu.buildFromTemplate` в `main.js:show-terminal-context-menu`, проверяет `terminalCommandState` Map напрямую. При изменении логики скриптов нужно обновлять **оба** места.

**Один из шрамов: auto-color симметрия.** Долго работала только в React-меню TabBar — оно само звало `setTabCommandType(tabId, 'devServer')` после detect'а `^(dev|start|serve|watch)/i`. Нативное меню main.js шлёт команду через `event.send('context-menu-command', 'run-script', { tabId, command })` → renderer App.tsx делает `ipcRenderer.send('terminal:input', tabId, command)` **напрямую в PTY**. Этот путь полностью обходит xterm keydown Enter handler в Terminal.tsx, где живёт второй auto-detect — поэтому вкладка не зеленела при run-script через нативное меню. Симптом юзера: *«ввёл npm run dev, цвет вкладки не стал зелёным»* (см. лог prod-Electron'а: `[ContextMenu] Command received: run-script` followed by `terminal:input ... "npm run dev"` — но без `[Store:setTabCommandType] devServer`). Fix — мирроринг regex'а в `App.tsx::run-script` handler перед `terminal:input`.

Старая entry `Scripts → Stop: {name}` в React submenu больше не рендерится: stop вынесен в top-level split/edge surfaces, чтобы не прятать прерывание внутри списка launch-команд. В submenu оставлен только запуск `npm run X` / `./script.sh`.

Разница restart vs stop: `handleRestart` = `\x03` → 300ms → `!!\r` (Ctrl+C + повтор последней команды через `!!` bash). `handleStop` = только `\x03`.

## Run last command из пустого tab-slot

В vertical sidebar у plain terminal-вкладки без live process, без AI runtime/session-state и без заметки notes-slot при `Cmd+hover` пустой slot превращается в Play. Active tab показывает Play как раньше; inactive tab показывает его только когда сама строка hovered — target определяется наведённой вкладкой, а не глобальным active tab. Это не scripts-menu и не project-wide history: кнопка запускает последнюю сохранённую shell-команду для **текущего cwd** вкладки. Перед lookup renderer спрашивает live cwd через `terminal:getCwd`; main сравнивает сначала in-memory `terminalCommandState.lastCommandCwd`, потом persisted SQLite app-state keyed by cwd.

Граница важна из-за пользовательского сценария «в одной директории `npm run dev`, в другой `./deploy.sh`»: одна Project Workspace может содержать несколько cwd, поэтому ключ "projectId → last command" был бы неверным. Если команда была сохранена в cwd A, а пользователь потом сделал `cd B`, она не должна переехать вслед за табом — для этого у in-memory записи хранится `lastCommandCwd`.

Capture берёт только реальные shell input lines из plain terminal: когда активен Claude/Gemini/Codex runtime, line-buffer очищается и не обучается на TUI output. ANSI CSI вроде `ArrowUp` (`\x1b[A`) не считается командой, persisted мусор типа `[A` отфильтровывается при чтении, bracketed paste не участвует в этом feature. Kill-port prefix, который добавляется перед restart/run (`lsof -ti:...;`), при сохранении отбрасывается, чтобы Play повторял пользовательскую команду, а не служебный preflight. AI CLI launch-команды (`codex`, `claude`, `gemini`, `npx @openai/codex`) не становятся last-command и отбрасываются при lookup: runtime-запуск агента не должен перетирать последнюю обычную shell-команду cwd. Диагностика пишет `[LastCommand] skip-ai` для отфильтрованных AI-запусков, а обычный capture логирует `project` и `cwd`, чтобы не путать prod/dev/local вкладки.

Важный edge: команда, запущенная через shell history (`↑` + Enter), не проходит через main как текст команды — `terminal:input` видит только escape-код стрелки. Поэтому renderer `CmdDetect` после Enter отправляет в main полный prompt-line, а main уже нормализует его так же как typed input. Если команда была видна в scrollback до появления этой логики и ещё не сохранена в SQLite, Cmd+Play делает одноразовый fallback: сканирует tail текущего xterm-буфера, берёт последнюю строку с shell prompt, нормализует, сохраняет и запускает. Это не замена persisted store, а recovery для живой старой вкладки.

## Command run history

Main хранит короткую историю фактических запусков shell-команд в SQLite `app_state` (`terminal:command-run-history`). Запись добавляется на авторитетный `OSC 133;B` command-start, а не на клик по UI: меню или кнопка могут только попросить запуск, но история должна показывать то, что shell реально начал выполнять. Команда нормализуется тем же фильтром что last-command: kill-port prefix отбрасывается, AI CLI (`codex`/`claude`/`gemini`) не попадает в историю. Для защиты от пустых/служебных `OSC B` last-command fallback берётся только если он свежий; выбранный restart-after script приходит через `activeCommandSource: "restart-after"` и пишется явно.

UI читает историю через `terminal:get-command-run-history` по `tabId` + live cwd. Формат строки намеренно короткий: название команды (`npm run build:install` показывается как `build:install`) и локальное время `DD-Mon-YY HH:mm`. История доступна из ПКМ вкладки → `Info` submenu даже когда `Restart after` выключен; когда на vertical tab есть фиолетовый restart-after command label (`build:install [3]`), сам label кликабелен и открывает тот же список.

## Restart after AI completion

Обычная terminal/devServer вкладка может быть привязана к завершению одной или нескольких AI-вкладок через ПКМ → `Restart after`. Это не Prompt Queue и не отправка prompt'а: owner — обычная вкладка с процессом или script'ом, triggers — Claude/Gemini/Codex/SDK вкладки, у которых ждём штатный busy→idle edge. Любой выбранный trigger может запустить side effect в owner-вкладке.

Контракт side effect:
- выбран один или несколько trigger-tab → после natural completion любого выбранного trigger'а target делает deterministic stop/cleanup и запускает эффективную команду target-вкладки;
- выбран trigger-tab list + `Script` → target сначала controlled-stop'ит текущий процесс, потом отправляет выбранный `npm run <name>` или `./script.sh`;
- выбран trigger-tab list + `paused` → target сохраняет выбранные AI-вкладки и script в UI/SQLite, но natural completion ничего не запускает и `/api/active-loaders` не считает такой restart-after blocker'ом;
- если выбран конечный `Script` уже запущен этой фичей и ещё не завершился, следующий natural completion trigger-tab'а не stop'ит его и не запускает второй экземпляр: ставится один pending rerun, который стартует после `terminal:command-finished` целевой вкладки; несколько trigger'ов пока скрипт идёт схлопываются в один повтор с последней выбранной командой;
- если target поставили на pause пока такой pending rerun ждёт `terminal:command-finished`, pending сбрасывается и не запускается; после resume нужен новый natural completion trigger-tab'а;
- `dev`/`start`/`serve`/`watch`-команды остаются restart-командами: они обычно не завершаются сами, поэтому для них сохраняется прежний controlled stop/restart path вместо ожидания `command-finished`;
- если процесса в target сейчас нет, но выбран `Script`, restart-after просто стартует этот script с нуля; если `Script` не выбран, renderer берёт последнюю сохранённую **non-AI** shell-команду для текущего CWD target-вкладки и отправляет её явно. Эта fallback-команда показывается в vertical tab title и Script-row без записи в `restartAfterCommand`, но теперь это уже не декоративный preview: именно она будет запущена при trigger'е. `Restart after` больше не использует shell history/`!!` для пустой команды: `!!` может повторить случайный `codex/claude/gemini` из истории вкладки. Если сохранённой команды нет или последняя команда — AI CLI, автозапуск пропускается с `[TabBar:RestartAfter] skip-empty-command`;
- `manual-stop`, `interrupt`, `error`, `watchdog`, Codex `turn_aborted`, Claude `spinner` и обычный `local-command` не запускают restart. Это те же смысловые границы что у Run after: side effect разрешён только после результата, а не после отмены/ошибки/визуального флапа.

Команда, реально запущенная `Restart after`, помечается в main как `activeCommandSource: "restart-after"` на следующий OSC `command-started`: это касается и выбранного `Script`, и fallback last-command без явного script. `build:i-obs` / `/api/active-loaders` ждёт только такой non-AI процесс, и только пока у вкладки всё ещё есть хотя бы один restart-after trigger (`restartAfterTabIds` или legacy `restartAfterTabId`). Ручной `npm run dev`, ручной `npm run build`, ручной `./deploy.sh`, цвет вкладки и пользовательский `sessionStatus` не являются blocker'ами install сами по себе.

Выбор trigger-tab сам является активной подпиской, если `restartAfterPaused !== true`. В ПКМ picker для Restart after работает как multi-select: клик по строке toggl'ит конкретный trigger, меню не закрывается, можно выбрать несколько AI-вкладок; повторный клик снимает только эту строку. Отдельных restart-after bell-кнопок больше нет: старые `restartAfterArmed` / `restartAfterPersistent` — legacy-поля, которые очищаются при перевыборе/срабатывании. Это важная граница: наличие trigger'а без bell-флага всё равно обязано fire'ить; выключение делается только явным `restartAfterPaused`. Реальный пользовательский симптом старой модели: target и `npm run dev` были сохранены, Codex loader завершился штатным `task_complete`, но ничего не произошло, потому что старый consume-path дополнительно требовал `armed/persistent`.

`restartAfterTabIds`, legacy mirror `restartAfterTabId`, `restartAfterCommand` и `restartAfterPaused` сохраняются в SQLite вместе с вкладкой. Старое одиночное поле остаётся первым выбранным trigger'ом для совместимости старых строк и main-side fallback'ов; авторитетная модель для нового UI — массив. Сброс всех trigger'ов удаляет и command: script без AI-триггера не имеет смысла, потому что неизвестно после какого события его запускать. В контекстном меню сброс — крестик справа от выбранного trigger-row; клик по самой строке `Restart after` только toggl'ит paused и серит строку trigger/script без потери выбора. В vertical sidebar — `Cmd+hover` по restart-after кнопке показывает X, а `Cmd+click` по ней полностью очищает подписку без Stop side effect; отдельная pause-кнопка слева toggl'ит paused и в paused-state рисует crossed-pause. Красный square-stop на Cmd-hover остаётся только для обычного зелёного devServer без restart-after. Диагностика UI-save пишет `[RestartAfter:Store] action=... project=... target=... triggers=... paused=... command=...`, а fallback lookup пишет `[TabBar:RestartAfter] resolved-last-command ... project=... cwd=... sourceTab=...`, чтобы отличать ошибку состояния от ошибочной команды в shell history. Last-command lookup обязан передавать `tabId` target-вкладки: main вычисляет project owner по вкладке и логирует `[LastCommand] project-mismatch`, если renderer передал project текущего UI вместо владельца target. Это важно для автособытий, которые могут приходить из другого mounted `TabBar`.

Restart-after UI использует общий `RunAfterTabPicker`, но в purple-режиме показывает все AI-вкладки сразу (`showAllTabsOnOpen`) и открывает список вправо от tab context menu. Список берёт проекты, группы, порядок вкладок, статус-маркеры и loader из той же модели что TabSidebar; drag/drop в picker'е не работает, это read-only inventory для выбора trigger-source.

Self-target (`triggerTabId === targetTabId`) всегда сбрасывается в `null`, даже если UI уже фильтрует текущую вкладку из picker'а. Это защитный слой против старого persisted state и программных вызовов store: вкладка не может дождаться собственного внешнего busy→idle edge для restart, поэтому такой target выглядел бы настроенным, но никогда не стрелял.

## 4. Code Map
- **UI Компонент:** `src/renderer/components/Workspace/TabBar.tsx`
    - Контекстное меню → секция `{/* Scripts - submenu */}`
    - `contextScripts` state: загружается при ПКМ через async IIFE в `handleContextMenu`.
    - `RestartZone`: компонент с `onRestart` (left-click) и `onStop` (middle-click).
- **Terminal Context Menu:** `src/main/main.js` → `ipcMain.on('show-terminal-context-menu')` — нативное Electron Menu.
- **IPC Handlers:**
    - `file:read`: Чтение `package.json` с диска (Main process).
    - `terminal:getCwd`: Запрос текущего пути процесса `node-pty`.

## 5. Trap: OSC 133 и dev-серверы
Dev-серверы — долгоживущие процессы. Шелл отправляет `OSC 133;B` (command started), но **никогда не отправит `133;D`** (command finished), пока сервер работает. Это by design. Статус `isRunning: true` сохраняется в `terminalCommandState` (main.js) до остановки сервера (Ctrl+C).

Но `commandType: 'devServer'` на табе устанавливается через `setTabCommandType` в renderer — это **независимый** от OSC 133 механизм. RestartZone требует **оба**: `hasProcess === true` (из OSC) И `commandType === 'devServer'` (из store).
