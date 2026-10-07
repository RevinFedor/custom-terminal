# Fact: `build:i-obs` — ребилд, ждущий пока приложение освободится

## Задача
`npm run build:install` собирает, подписывает и проверяет кандидат до закрытия приложения. Перед заменой `graceful-quit.sh` запрашивает штатный выход; предыдущий bundle остаётся для отката. Если в момент выхода в проде идёт активная AI-работа или shell-команда, запущенная через `Restart after`, установка прервёт её. Команда **из стороннего терминала** (не внутри Noted Terminal) ждёт, пока такие blocker'ы во всех проектах не станут idle, показывает прогресс и запускает `build:install`. AI-hop через Voice Record дополнительно перепроверяет idle перед Quit уже собранного кандидата: ошибка сборки не должна останавливать работающие сессии.

`graceful-quit.sh` отличает штатный выход от нового macOS crash-report по
снимку **имён** `.ips`, сделанному до запроса Quit. На `mtime` полагаться нельзя:
DiagnosticReports/Spotlight может коснуться старого отчёта спустя дни (живой
случай: incident от 19.08 получил mtime 22.08), и `find -newer` тогда ложно
сообщал об аварии после полностью штатных `before-quit → overlay → app.quit`.

Команда: **`npm run build:i-obs`** (`i` = install, `obs` = observe). Реализация — `scripts/build-when-idle.js` (чистый Node, без зависимостей).

Run After `after app restart` отслеживает identity нового Electron main, а не имя install-команды. `build:install`/alias `build:i`, ожидающий `build:i-obs` и `build:i-cont` удовлетворяют его после замены и открытия приложения; обычный Quit/Open тоже. Package-only build либо отказ сборки до замены не удовлетворяет условие. Возврат `continue`/AI-hop callback и такой queue-item — отдельные явно настроенные сообщения, одно не заменяет другое. Готовность Resume ограничивает физическую отправку карточки, но прошлый assistant outcome не является дополнительным условием запуска; подробности — `fact-prompt-queue.md::Overlay UI`.

## Замок установки: владелец, а не просто каталог (12.09)

`build:install` берёт замок `mkdir /Applications/.noted-terminal-install-lock`:
два инсталлера не должны одновременно подменять приложение, и `mkdir` атомарен,
поэтому гонку закрывает именно он.

Но замок не хранил, **кто** его держит. Любой аварийно убитый инсталлер
(двойной Ctrl+C, SIGKILL, обрыв питания) оставлял пустой каталог, и каждый
следующий запуск падал навсегда — до ручного `rmdir`:

```
[NotedInstall] failed step=lock error=EEXIST: file already exists,
  mkdir '/Applications/.noted-terminal-install-lock'
```

Живой случай 12.09: юзер прервал инсталл на середине, после чего `build:i`
перестал стартовать вообще. Симптом читается как «команда сломалась», хотя
установленное приложение цело (`recovery: installed-app-untouched`) — сборка
даже не начиналась.

Теперь внутрь замка пишется `owner.json` с номером процесса и временем старта,
и решение принимается по доказательству, а не по догадке:

- **владелец жив** (`process.kill(pid, 0)` не даёт ESRCH) → отказ с внятным
  «another install is already running (pid N, started …)»; чужой замок не
  трогается, ни один шаг сборки не запускается;
- **владелец мёртв** → замок перехватывается, установка идёт как обычно. Это и
  есть починка: смерть владельца доказана, блокировать больше нечему;
- **владелец неизвестен** (файла нет — замок от прежней версии скрипта, или
  он битый) → по-прежнему отказ, но в тексте ошибки уже есть готовая команда
  снятия вместо голого `EEXIST … mkdir`.

Переиспользование номеров процессов сдвигает ошибку в безопасную сторону:
чужой живой процесс под тем же номером читается как «занято», то есть хуже
отказа ничего не случается.

## Откаты не копятся бесконечно (12.09)

Каждый инсталл сохраняет заменённое приложение как `previous.app` в своём
`/Applications/.noted-terminal-install-<random>/` и раньше **не удалял его
никогда** — по принципу «откат дороже места». За неделю это дало 26 каталогов
по 686 МБ: **17 ГБ в `/Applications`** (найдено 12.09 при разборе зависшего
замка).

После успешной установки лишние каталоги убираются (`pruneInstallStaging`,
`STAGING_KEEP_DEFAULT = 2`). Границы намеренные:

- **только после успеха.** Пока установка не доехала, каждый старый откат ещё
  может понадобиться; при сбое/откате не убирается ничего.
- **два последних остаются целиком**, включая только что созданный. На более
  старые откатиться всё равно нельзя осмысленно: настройки и база с тех пор
  прошли миграции, а исходники любой версии держит `git`.
- **шаблон строгий**: только `.noted-terminal-install-<random>`; замок
  (`…-install-lock`) под него не попадает, текущий каталог исключается явно,
  символические ссылки и не-каталоги пропускаются.
- **сбой уборки не влияет на результат установки**: место не важнее уже
  установленного приложения.

Тесты: `scripts/build-install-noted-terminal.test.mjs` (33) — живой/мёртвый/
неизвестный владелец замка, полный цикл захвата и освобождения, уборка старых
откатов при успехе, её отсутствие при сбое, неприкосновенность замка и чужих
приложений, устойчивость установки к сбою уборки.

## Соседний режим: `build:i-cont`

`npm run build:i-cont` намеренно не ждёт idle: он выполняет канонический
`build:install`, затем отправляет ровно слово `continue` каждой Claude/Codex
PTY-вкладке, которую этот shutdown действительно остановил. Команду, как и
`build:i-obs`, запускают из внешнего терминала: процесс внутри Noted Terminal
умрёт вместе с заменяемым приложением и не сможет выполнить post-install часть.

Источник целей — не список открытых вкладок и не сохранённый `commandType`.
Перед graceful shutdown main сохраняет точный набор `{tabId, provider,
sessionId, shutdownPid}` из тех же live-карт, которыми помечает
`was_interrupted`. Новая версия замораживает этот снимок до renderer restore:
обычный AutoResume может уже очистить визуальный interrupted-флаг, но не может
изменить список именно этого shutdown. Для первого install старый билд ещё не
умеет писать точный снимок; разрешён только ограниченный bootstrap по
`was_interrupted` с единственной непротиворечивой Claude- либо Codex-binding.
Две binding, одна подпись без session ID и сменившаяся session остаются
unresolved и не получают текст.

После появления нового production API wrapper:

1. проверяет, что точный snapshot принадлежит PID заменённого приложения и был
   записан во время текущего build;
2. ждёт восстановленного status каждой цели;
3. по одной допускает отправки через `POST /api/terminal-tabs/:tabId/send` с
   постоянным handoff ID операции;
4. не ждёт завершения ответа модели: после принятия `continue` следующая
   вкладка проходит startup admission, поэтому сами agent-turn работают
   параллельно;
5. не повторяет HTTP timeout/`202`: Enter мог уже пересечь PTY, поэтому такой
   результат остаётся `ACCEPTED/VERIFYING`, а не становится blind retry.

Это не новая очередь и не новый terminal transport. Start/Resume, `/model` /
`/effort`, exact draft proof, paste+Enter и transcript audit остаются у общего
Project API scenario. Wrapper только выбирает доказанные shutdown-цели и
последовательно вызывает этот сценарий.

Само приложение после build-install также восстанавливает `wasInterrupted`
вкладки последовательно и без Dashboard-toggle. Здесь граница строже, чем у
post-install `continue`: следующий AI launch начинается лишь после ready/manual
blocker/error предыдущего. Это исключает launch storm общего process-tree
источника; production запуск 11 Resume одновременно дал восемь ошибок и
ложный `shell_not_idle` у вкладки, где AI-потомков уже не было.

## Что считается «активным» (блокирует ребилд)
Единый ответ `/api/active-loaders` объединяет два авторитетных main-process источника: runtime-снимок `computeActiveLoaders()` и durable store оркестраций. Runtime-часть **переиспользует те же самые live-Map'ы, что питают per-tab loader в UI**; inherited/completion-часть читается прямо из сохранённых run, а не из renderer/Zustand:

| Источник | Map в main | Семантика |
|---|---|---|
| PTY Claude | `bridgeKnownSessions` + `terminals` + (`claudeTurnBusy`\|`claudeSpinnerBusy`\|`claudeLocalCommandWatchers`) + `claudePromptReady` | `busy` только когда реально идёт turn/loader/local slash command; idle-alive Claude (`claudeCliActive`, живой PTY у prompt) **не возвращается из `/api/active-loaders` вообще**. `active/starting` — это presence/status-слой, не blocker-list. Stale bridge без живого PTY (`!terminals.has`) **не** блокирует (= `inactive`) |
| SDK Claude | `sdkSessions` | одна запись = один in-flight `query()` → `busy` |
| Gemini | `geminiSpinnerBusy` | `busy` только при `=== true` |
| Codex | `codexTurnWatchers` | блокирует только rollout `task_started → task_complete/turn_aborted`; живой idle Codex CLI не blocker |
| Restart-after non-AI процесс | `terminalCommandState.isRunning` + `activeCommandSource === 'restart-after'` + (`tabs.restart_after_workflow_ids`, `tabs.restart_after_tab_ids` или legacy `tabs.restart_after_tab_id`) | `running`. Ручные shell-команды (`npm run dev`, `npm run build`, `./deploy.sh`) сами по себе **не блокируют** `build:i-obs`; blocker'ом становится только команда, которую реально запустил `Restart after`, пока у вкладки есть хотя бы одна trigger-подписка. AI CLI tabs исключены из этой ветки, потому что их PTY-процесс может быть живым и idle |
| Git-операции | `ipc/git.js` active operations registry | `kind:"git"` для generate/commit/undo/push/fetch/checkout пока операция in-flight. Это нужно для сценария Git run-after: AI-вкладка завершилась, Git-панель начала generate+commit, и `build:i-obs` не должен закрыть приложение между AI-trigger и фактическим commit/push |
| Взведённая очередь (Run after / Loop) | persisted `promptQueueByTab` + `promptQueueSharedLoopPrompt` через `computePromptQueueInstallBlockers` | Общий endpoint по-прежнему проецирует обещание как `kind:"prompt-queue", status:"queued"`, но ручной `build:i-obs` отбрасывает этот пассивный вид перед подсчётом idle. Вооружённое условие на остановленной вкладке не является текущей работой; когда оно реально запускает `/compact` или следующий prompt, появившийся `claude`/`codex busy` снова блокирует сборку. Другие потребители `/api/active-loaders` сохраняют прежнюю семантику. |
| Оркестрация | `orchestration-runs.json` через `OrchestrationRunStore.listActive()` | `kind:"orchestration"`: активный child блокирует реальный target и inherited source; `waiting_descendants` остаётся работой ветки; `completed + resultComplete=false` проецируется как `result-proof`; после terminal-state source остаётся `completion-handoff`, пока post-Enter audit не подтвердит точный `runId`. `waiting_recovery` и ошибка доставки также блокируют install как нерешённые состояния, но не считаются активной анимацией. Generic `busy:true` ничего из этого не снимает. Все tracked-состояния переживают restart и retention, а auto-stop запрещён до полного result-proof |

Дедупликация по `tabId` (один таб = максимум один loader). Runtime-loader имеет приоритет над orchestration-проекцией того же таба; активный child всё равно сохраняет отдельный target-blocker. Это важно для `returnTo.tabId`: Voice Record исключает только вызывающий source, но не работающую целевую вкладку.

Идемпотентно для idle-определения: `idle === (loaders.length === 0)`.

Важно для логов: `idle:true` в `/api/active-loaders` означает только «нет install-блокеров», а не «в Noted Terminal вообще нет живых процессов». Ручной `npm run dev` или idle Codex/Claude PTY могут продолжать существовать. Web-server логирует изменившиеся снимки как `[ActiveLoaders] status=... idle=... count=... kinds=... tabs=...`, поэтому диагностика `build:i-obs` должна читать этот смысл, а не текст старого wrapper'а `already idle`.

**Шрам «дыра между звеньями цепочки» (2026-08-16).** До этой правки список блокеров отвечал на вопрос «идёт ли ход прямо сейчас», а вызывающая сторона спрашивала «осталась ли работа, которую пользователь ждёт». Для цепочки Run after это разные вопросы: между двумя звеньями никто не работает — триггер уже закончил, владелец ещё не стартовал. Замерено в production.log: `tab-2532` завершилась в 07:35:01.6, `tab-2570` стартовала в 07:35:03.3, а опрос idle попал в 07:35:02.0 — **дыра шириной 1.7 секунды**. Ребилд получил `idle=true count=0`, погасил приложение, и Codex записал `turn_aborted` без ошибки; пользователь увидел «кодекс просто остановился». Дальше цепочка встала законно: `tab-2572` ждала штатного завершения `tab-2570`, а прерывание им не является.

Ключевой вывод: `IDLE_CONFIRM` эту дыру не закрывает ни при каком значении — 1.7с шире интервала опроса, и это **реальное состояние системы**, а не артефакт дискретизации. Лечится не более частым опросом, а тем, что само обещание становится видимым. Поэтому источник — durable `promptQueueByTab`: живой копии очередей в main нет, а вторая копия была бы ещё одним источником рассинхрона.

Две границы, важные для общего endpoint:
- **Живость очереди = строка вкладки существует, а НЕ живой PTY.** Это позволяет другим клиентам видеть обещание, даже когда очередь законно ждёт остановленную вкладку и позже сама её поднимет (`inactive → LAUNCH_FOR_QUEUE start-fresh`). Ручной observer затем делает собственную более узкую проекцию и не считает это обещание причиной откладывать сборку.
- **Ошибка чтения очереди не роняет весь снимок.** `try/catch` вокруг сохраняет остальные живые turn-блокеры. `build:i-obs` игнорирует и `prompt-queue-state`, потому что для его нового контракта состояние пассивной очереди вообще не участвует в решении.

Продуктовое уточнение 2026-08-25: `build:i-obs` ждёт фактически выполняемую работу, а не возможную будущую работу. Это осознанно отменяет для ручной команды старое правило «durable Run after promise закрывает любую дыру между звеньями». `IDLE_CONFIRM` остаётся защитой от коротких переходов реальных runtime-сигналов, но не обещает дождаться ещё не запущенной карточки. Scope намеренно локален wrapper-у; Voice Record и другие клиенты общего endpoint не изменены.

Шрам mobile install preflight: если `terminalCommandState.isRunning` применять ко всем вкладкам без фильтра AI, `/api/active-loaders` возвращает десятки `kind:"process", status:"running"` для idle Claude/Codex табов. На iOS это выглядит как ложный alert «Terminal занят, остановите вкладки где идёт streaming/loader», хотя loader нигде не идёт. Разделитель: AI tabs блокируют install только через свои deterministic busy-сигналы выше; обычные shell-команды не блокируют install, кроме случая `kind:"restart-after"` — команда была запущена `Restart after` и её надо дождаться как AI-turn.

## Транспорт: переиспользует mobile web-server
Не отдельный сервер. Эндпоинт добавлен в существующий `src/main/web-server.js` (тот же что обслуживает mobile-web на порту 7878):

```
GET /api/active-loaders   (Bearer-token, тот же ~/.noted-terminal/web-token.txt)
→ { idle:bool, count:int, loaders:[{tabId,kind,status,project,name,cwd,command?,source?,runId?,role?}], ts }
```

`computeActiveLoaders` **инжектится** в `web-server.start({ sdkSessions, computeActiveLoaders })` (не импортируется). Web-server дополняет этот снимок своим main-owned orchestration store и дедуплицирует результат по `tabId`. Поэтому ответ корректен **даже когда renderer перезагружается/расфокушен** (в отличие от bridgeRequest-пути `getClaudeTabStatusBatch`, который ходит в renderer).

**Fail-safe:** если инжекция отсутствует (старый код) — эндпоинт отдаёт `503 {idle:false}`, НЕ `idle:true`. Никогда не green-light'ит ребилд при сломанном состоянии.

## Скрипт `scripts/build-when-idle.js`

### Discovery прод-инстанса (ловушка stale-файлов)
`~/.noted-terminal/web-server-<pid>.json` копятся сотнями — приложение **никогда не удаляет** их при краше (тот же класс бага, что `~/.claude/bridge/*.json`, см. `fix-bridge-stale-takeover.md`). Фильтр прод-инстанса:
1. PID жив (`process.kill(pid,0)`)
2. `ps -p <pid> -o command=` содержит `/Applications/Noted Terminal.app` — отсекает dev-инстансы (electron-vite, порт **7979**) и реюзнутые соседом PID'ы
3. Свежайший `updatedAt` если вдруг >1 прод-копии

Прод = порт **7878**, dev = **7979** (`package.json::dev` ставит `NOTED_WEB_PORT=7979`).

### Append-only feed (НЕ self-clearing dashboard)
Соответствует ментальной модели юзера: «закрыта такая-то вкладка… все вкладки закрыты». Печатает baseline-список один раз, потом по одной строке на каждое появление (`＋ active`) / уход в idle (`✓ idle`), затем `✓ all tabs idle`. Без очистки экрана → переживает scrollback, нет хрупкой cursor-математики.

Если первый poll уже видит `idle:true`, wrapper пишет `✓ no install blockers`. Это специально не формулируется как «nothing running»: эндпоинт отвечает про безопасность install, а не про все процессы в приложении.

04.10.2026: долгий observer12:05–19:30BKK удерживала не Inbox34. Полный scrollback
Terminal и main-log подтвердили её `task_complete`14:40:19 / `✓ idle`14:40:20,
без нового turn до quit. После16:01:14 до19:24 оставался один install blocker:
Inbox2862 «система docs->uav», `orchestration:notification-blocked`, run
`ee43c4fc-f108-479f-b3e6-46d0b9168a99`. Исполнитель4412 завершился15:21,
resultComplete=true, но completion получил agent_send_handoff_conflict / failed,
pasteWritten=false / enterWritten=false. Passive prompt-queue wrapper уже отфильтровал.
Текущий feed сообщает лишь добавление/удаление tabId; смена codex busy на blocked
notification при том же ID не создаёт новую строку, поэтому хвост «все idle» не
доказывает очистку остатка. Проверять надо полный baseline и ActiveLoaders snapshot.
Ремонт stable operationKey до completion FIFO уже присутствовал в вручную
установленном app.asar после19:32, но старая failed-квитанция не стала delivered.
Она также оставалась blocker после update: сначала получить/передать сохранённый
ответ source2862, затем закрыть уведомление об ошибке; не повторять разработку
у4412 и не считать dismiss доказательством AI-reading. В этом аудите состояние run,
условия idle и production не менялись. Артефакт `/private/tmp/noted-build-obs-audit-20261004.vlkw4tba`.

### Гарантии безопасности
- **`IDLE_CONFIRM=2`** (env-настраиваемо): ребилд только после N подряд idle-поллов. Гасит 1-тиковый разрыв между двумя turn'ами из очереди (turn A кончился → 0 на один полл → turn B стартанул).
- **Failed poll ≠ idle**: таймаут/сетевой блип сбрасывает `idleStreak=0`, не считается за idle.
- **Старый билд без эндпоинта** (404): печатает «predates /api/active-loaders», просит разовый `build:install` для бутстрапа, exit 2. НЕ строит вслепую.
- **Прод не запущен**: нечего ждать → строит сразу (или exit при `NO_BUILD=1`).

### Observe-фаза в Voice Record endpoint (НЕ wrapper-скрипт)
`build:i-obs` (wrapper `scripts/build-when-idle.js`) — команда для внешнего ручного запуска
в отдельном терминале. Voice Record endpoint `/api/terminal/build-install` этот **wrapper не
запускает** (он foreground-поллер, а Voice Record — sibling-сервис), но с июня 2026 делает
**собственную observe-фазу** против того же `/api/active-loaders` перед спавном `build:install`.

Оба пути после observe сходятся в каноническом `npm run build:install`. После успешного
Electron package-build этот workflow вызывает `npm run install:terminal-mcp`, затем
`npm run install:claude-hook`, и только после обеих синхронизаций заменяет и открывает новую
app-копию. Поэтому Voice Record не копирует runtime-интеграции самостоятельно, а новый backend
не запускается со старым Terminal MCP client или turn-hook без causal prompt identity. Обычный
`npm run build` остаётся package-only и реальный HOME не меняет.

Синхронизация MCP-файла не перезапускает уже живой stdio MCP. Новую версию получает только
новый или переподключённый Claude/Codex-процесс; проверка nested orchestration после install
обязана создать/перезапустить MCP-клиента, а не продолжать процесс, который загрузил старый
server. Turn-hook, напротив, запускается новым процессом на каждое событие и читает обновлённый
файл уже на следующем submit, если его registration в Claude settings не менялась.

Раньше (graveyard) endpoint строил **мгновенно** без idle-проверки, полагаясь на то, что iOS
сделал preflight перед confirm. Это ломалось при AI-hop: агент в одной вкладке дёргал rebuild,
а `build:install` через `pkill` гасит **весь** прод — включая соседние проекты, где в этот
момент шёл turn. Теперь endpoint ждёт, пока все сессии **кроме вызвавшей** не уйдут в idle.

Механика observe (`observeTerminalIdle` в voice-record `web-server.js`):
- **Exclude-caller**: `returnTo.tabId` вычитается из списка блокеров. Вкладка-инициатор busy
  именно потому, что запустила rebuild — ждать её = вечный дедлок. iOS-путь без `returnTo`
  больше не делает собственный blocking preflight: телефон показывает confirm/status, а
  решение “что можно остановить, а что надо ждать” живёт здесь, в Mac-side Voice Record.
- **Auto-stop только для обычных процессов**: исторически endpoint пробовал остановить blockers
  `kind:"process"` / devServer через `POST /terminal/stop`. Новый `/api/active-loaders` не
  возвращает ручные shell-команды как blockers, а restart-after-owned процессы отдаёт отдельным
  `kind:"restart-after"` — их нужно ждать, а не auto-stop'ить. AI/Claude/Codex/Gemini blockers
  и `kind:"orchestration"` также никогда не auto-stop'ятся, чтобы не убить turn или completion-handoff посередине.
  Результат пишется в `wait.autoStopped`/`job.autoStopped` для desktop и iOS status UI.
  Если установленный прод ещё не знает `/terminal/stop`, Voice Record использует fallback
  Ctrl+C через старый `/terminal/run` route.
- **Discovery прода**: `web-server-<pid>.json` (живой PID) + авторитетный `isPackaged` из
  соседнего `mcp-port-<pid>` (тот же main PID пишет оба файла); фоллбэк — `ps`-маркер
  `/Applications/Noted Terminal.app`. Тот же stale-файл фильтр, что в wrapper'е.
- **Fail-safe сохраняет «строить даже когда прод недоступен»** (старый rationale): нет живого
  прод-инстанса → строить сразу; 404 (старый прод без эндпоинта, этот же build его и завезёт)
  → строить; 503/timeout/401 **никогда** не считается idle (сбрасывает streak); `IDLE_CONFIRM=2`
  подряд гасит 1-тиковый разрыв между turn'ами. Любая ошибка наблюдения → строить (явно
  запрошенный rebuild не должен застрять из-за бага в idle-watching).
- Прогресс виден в `GET /api/terminal/build-install`: `job.phase` (pending→observing→building→
  finished), `job.wait.blockers` (какая соседняя сессия держит).

### AI-hop изнутри Noted Terminal
Когда rebuild инициирует агент внутри самого Noted Terminal, он не должен запускать
`npm run build:install` в своей PTY-вкладке: управляющий процесс умрёт вместе с приложением.
Terminal MCP tool `build_install_noted_terminal` передаёт задачу в Voice Record
`POST /api/terminal/build-install` с `returnTo` (`tabId`, `sessionId`, `projectId`,
`projectPath`). MCP tool сразу возвращает job id; ожидание соседей (observe-фаза выше) и
ожидание рестарта (callback ниже) живут в Voice Record — вызвавший агент не блокируется.

После exit build-команды Voice Record читает live `~/.noted-terminal/mcp-port-*`:
только живой **packaged** PID нужного проекта, никогда dev-клон. По `/terminal/tabs`
проверяется точная исходная вкладка и текущий provider/session; для ещё не отправлявшего
Codex Resume допустима только подтверждённая backend read-identity из `/status`, а не
произвольный сохранённый session ID. Явный `tabId` никогда не подменяется соседней вкладкой.

Возврат идёт через общий `POST /api/terminal-tabs/:tabId/send`, а не через старый
live-only `/terminal/ai-prompt`. Project API найден по `web-server-<pid>.json` **того же PID**
и вызывается с auth token. Поэтому остановленная сессия проходит обычный Resume и readiness,
а уже работающая — обычную отправку/очередь, без отдельной реализации запуска в Voice Record.
Модель и effort callback не переопределяет. Статус виден в Voice Record
`GET /api/terminal/build-install` (`returnTo`, `callback`, `logTail`).

У операции постоянный `handoffId = build-install-return:<jobId>`. `sent`/`queued` принимаются
только с подтверждением общей отправки. После `202`, потерянного POST-ответа или признака
уже записанного paste/Enter callback читает **тот же** сохранённый receipt. Ошибка чтения
не разрешает новую отправку. Если успешное чтение не нашло записи либо запись доказала
отказ до ввода, допускается повторный POST с тем же ID: дедупликацией владеет Project API.
Пока исходный delivery PID жив, callback не переносит возможную отправку в другой процесс.
Неопределённая доставка после deadline остаётся `sent_unverified`, не ложным `sent`.

Callback передаёт `expectedSessionId`/`expectedToolType`. Общий сценарий включает их в
fingerprint и сохраняет `expectedTarget` на том же durable attempt; перед bridge и
перед самой вставкой проверяет адресата. Поэтому внешний GET не оставляет окно для
отправки в другую беседу, занявшую ту же вкладку. Обычные запросы без этих optional
preconditions не меняют поведения. Штатное Resume-source→writer допускается по текущему
causal proof: Codex переносит полный принятой launch stamp на writer при retirement
startup payload/read lease; Claude сохраняет первый принятый bridge writer на launch
generation. Поздний native `/resume` в том же Claude PID не заменяет этот первый proof.
Чтение уже существующего receipt не требует прежней live-сессии: native A→B или
остановленный терминал не могут спрятать итог уже совершённой отправки.

**Шрам 05.09.2026:** job `timtnqoq2c5cfdd3fa` установил и открыл app в 05:04:43 MSK,
но root `tab-3314` не попала в shutdown snapshot: процесс Codex был найден, writer не был
подтверждён. Старый callback сделал 14 ожиданий готового CLI и завершился в 05:20:05;
всё это время PTY оставалась shell. Исправление требует обеих частей: точного Codex proof
при shutdown (см. `fix-interrupted-session-lifecycle.md`) и Resume-capable общего send.
Успешная подпись/установка/открытие окна **не доказывают** возвращение агента.

**Повторная production-проверка05.09,18:40MSK:** job `timtojtyj6372e0f13`
установлен,17 source/compiled файлов ASAR совпали с freeze, подпись проверена.
Root вернулся в ту же session40c93948…5f63 без Play; native Goal resume Enter
15:40:57UTC, один callback Enter15:41:05 и один confirmed receipt15:41:16.
Одновременно проявился отдельный false AutoResume error: callback и startup
requested same Resume, второй получил agent_lifecycle_claimed. Общая lifecycle
очередь теперь присоединяет точный дубль к первому запуску, а ready-wait связан
с его generation. Подробности и регрессии — `fact-codex.md`. Не исправлять это
слепым повтором callback, ожиданием произвольной задержки или снятием shell guard.

### Env-кнобы

`POLL_MS=1000`, `IDLE_CONFIRM=2`, `NO_BUILD=1` (только наблюдать), `PORT=7878` (форсить порт, минуя discovery — для теста).

## Тестирование без ребилда
`web-server.js` требует electron (`ipcMain`/`app`/`BrowserWindow`). Для headless-харнесса замокать через `Module._load` shim (`require('electron')` → fake), `start({sdkSessions:new Map(), computeActiveLoaders: ()=>mockState})`, дёргать скрипт с `PORT=<mockport>`. Runtime-логика тестируется с mock-Map'ами; orchestration merge покрыт отдельно: source+target активного run, recovery без shimmer, `result-proof`, completion-handoff до exact proof, исчезновение после proof и дедуп с runtime-loader. Отдельная регрессия обязана проверять, что incomplete result переживает restart/retention, блокирует install и не запускает auto-stop. В DEV live endpoint вернул stale `tab-2142` как `kind:"orchestration", status:"completion-handoff"`, тогда как run с уже подтверждённым exact follow-up в список не попал. Сам build/install в E2E не запускается.

## Целостность пакета до закрытия приложения

Шрам07.09.2026: во время electron-builder тестовый source-файл вырос с13369
до15969байт. ASAR записал новые байты, но таблица offsets осталась рассчитана
по старому размеру;229последующих source-файлов читались со сдвигом2600байт.
Подпись всего bundle успешно проходила и не обнаруживала этого. Это не stale
renderer и не несовпадение source/build: даже собственные SHA256 в ASAR не
соответствовали байтам по записанным адресам. `asar-packaging-race-proof.json`
в checkpoint фиксирует время изменения и exact hash после исправления offset
только для диагностики; сам архив никогда не правится вручную.

`scripts/validate-app-asar.mjs` потоково проверяет размер/диапазон/полный SHA256
каждого packed и unpacked файла. `npm run build` делает это до подписи;
`validateAppBundle` повторяет проверку staged bundle до quit/swap. Повреждённый
пакет означает явный отказ и новый build на стабильном source, а не запуск
старого/битого кода. Подпись остаётся отдельной обязательной проверкой.

`internal error in Code Signing subsystem` сам по себе не доказывает поломку
сертификата: в этом же прогоне system log показал запись `.cstemp` с errno28
(диск заполнен). После удаления только собственных временных generated packages
и копий Rust target-кэша та же identity подписала bundle. Не сбрасывать TCC,
сертификат или ACL по одной общей формулировке codesign.

## Связанное
- `fact-claude-stop-hook.md` — откуда `claudeTurnBusy` (authoritative busy)
- `fix-claude-busy-detection.md` — cleanup busy-Map'ов на exit/stop (почему stale-bridge без PTY = не busy)
- `fact-mobile-web.md` — host web-server, токен, discovery-файлы
- `fact-terminal-mcp.md` — `terminalCommandState` (OSC 133 B/D → isRunning)
