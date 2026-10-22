# Fact: `build:i-obs` — ребилд, ждущий пока приложение освободится

## Задача
`npm run build:install` собирает, подписывает и проверяет кандидат до закрытия приложения. Перед заменой `graceful-quit.sh` запрашивает штатный выход; предыдущий bundle остаётся для отката. Если в момент выхода в проде идёт активная AI-работа или shell-команда, запущенная через `Restart after`, установка прервёт её. Команда **из стороннего терминала** (не внутри Noted Terminal) ждёт, пока такие blocker'ы во всех проектах не станут idle, показывает прогресс и запускает подготовку `build:install`. С11.10 wrapper и AI-hop оба отдельно перепроверяют idle перед Quit уже собранного кандидата: исходное idle не разрешает закрыть приложение после длительной сборки, если появились новые занятые сессии. Raw `build:install` без observer/owner-ACK не получил нового режима ожидания.

`graceful-quit.sh` отличает штатный выход от нового macOS crash-report по
снимку **имён** `.ips`, сделанному до запроса Quit. На `mtime` полагаться нельзя:
DiagnosticReports/Spotlight может коснуться старого отчёта спустя дни (живой
случай: incident от 19.08 получил mtime 22.08), и `find -newer` тогда ложно
сообщал об аварии после полностью штатных `before-quit → overlay → app.quit`.

Команда: **`npm run build:i-obs`** (`i` = install, `obs` = observe). Реализация — `scripts/build-when-idle.js` (чистый Node, без зависимостей).

## Плановый install без служебных research-промптов (SOURCE20.10)

Внешний штатный `build-install-noted-terminal.mjs` перед Quit включает durable
operational maintenance через Noted API, после запуска нового Main завершает тот
же operationId и проверяет readback. Это только политика доставки временных
служебных событий ожидающим моделям, не отмена research и не новый idle/Browser
proof. Исходные запросы и FULL-доставка сохраняются; старые suppressed notices
после complete не отправляются. Для обновления соседнего SC оператор использует
`node scripts/research-maintenance.cjs begin <operationId>`, после фактической
проверки связи — `complete <тот-же-operationId>`; `status` только читает policy.

Первое развёртывание на Main без этого API явно отмечается bootstrap: отсутствие
старого quiet ACK не выдается за подтверждение. SOURCE передаёт новому Main
`--research-maintenance-operation=<тот-же-ID>` через launch arguments. RunStore
ждёт прежнего receipt owner и строго сохраняет begin с exact cancellations до
operational restore/FIFO resume. Bootstrap complete требует GET-подтверждение
`startup:{version:1,operationId,durable:true,beforeRestore:true}` и активный тот же ID;
поздний POST begin больше не считается доказательством quiet startup. Ошибка
записи/отзыва не даёт ACK или resume; существующий startup owner повторяет ту же
операцию, не перечитывая старый JSON поверх принятого RAM intent. Подтверждённый
hold переживает обычный restart; completed ID не открывает новую maintenance.
Обычная operational policy default-on: отсутствие её settings-поля не отключает
ночное пробуждение модели; launch descriptor не является глобальным opt-out.
Неоднозначная ошибка POST не допускает bootstrap fallback. Если после успешной замены API ещё не восстановлен, installer сохраняет
проверенный новый bundle и same maintenance operation, возвращает failure/pending,
а не молча откатывает его и не объявляет восстановление завершённым. Это SOURCE
contract/tests, не свидетельство уже выполненной установки. Старые idle/owner-ACK
guards и внешний Voice Record callback остаются отдельными механизмами.

`build:install` / `build:i` и внешний Voice Record hook всегда заново собирают
текущие исходники. Разовый механизм `release/prepared-install-intent.json` удалён
по поручению Fedor20.10: агент добавил его ради установки пяти Main-исправлений
поверх установленного приложения без остальных текущих правок. Но резерв не был
связан с жизненным циклом Voice Record job: отмена на этапе observing оставляла
`pending`, после чего ручной install запрещался, а новый hook мог подхватить старую
копию. Сохранённый JSON больше не читается, не выбирает приложение и не блокирует
новую сборку; удалять его руками для продолжения не требуется. Единственный install
lock защищает от одновременно работающих установщиков, освобождается после
завершения/обработанной отмены; доказанно мёртвый владелец допускает прежний takeover.

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

## Соседний legacy режим: `build:i-cont`

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

## Немедленный снимок и продолжение: `build:i-c`

`npm run build:i-c` запускают из внешнего терминала. Пользователю нужен набор
работавших вкладок на момент команды, поэтому этот режим сначала сохраняет
операцию и закрывает Main, затем готовит candidate. Это отдельный явный режим;
обычные `build:i` и idle hook сохраняют прежний порядок. Установленный Noted
должен уже поддерживать capture/restore v2 с `proofRevision:2`: старый app,
включая промежуточный v2 без полного recovery-контракта, получает отказ до Quit,
его нельзя обновить этой же ещё не загруженной функцией.

Снимок различает собственный model turn и унаследованное ожидание. Вкладка,
только ожидающая Terminal MCP/SC, сохраняет прежнюю зависимость без `continue`.
Own+external получает одно продолжение собственной работы; исходные run/job,
notification handoff и UNKNOWN не пересоздаются. Входящее поручение продолжает
существующий orchestration owner; второй generic `continue` поверх него запрещён.
Пассивное наблюдение само не отправляет input: exact restart связывает старый
subject с доказанным continuation, сохраняя отдельное evidence/provenance.

Результат или reply может оказаться в FIFO раньше `continue`. Он обрабатывается
первым. Допуск последующего продолжения требует полного verified интервала
сообщений и canonical receipts именно захваченных зависимостей. Callback не
становится финалом прерванного поручения. Новый manual input, Stop, замена owner,
разрыв источника или неизвестный Enter не дают права на автоматический ввод.
Проверка интервала читает уже прогретый структурный индекс, не запускает полный
History ради отрицательного proof. Холодный/неполный индекс остаётся unknown.

Loop ON/autoRun/карточки сохраняются. Новая автоматика до enqueue получает
известный deferred/no-input. Старый Loop cause можно убрать из FIFO только по
exact captured operation и отсутствию native attempt; его receipt остаётся,
живой caller и restore сохраняют ON. Ручная очередь и UNKNOWN не переставляются.

Одна maintenance identity проходит begin до Quit → startup beforeRestore →
complete; SC сохраняет тот же job и future final. Ошибка подготовки открывает
прежнее приложение и восстанавливает ту же операцию. Потеря ACK восстанавливается
по сохранённому operationId, при необходимости `npm run build:i-c -- --resume ID`;
эта команда не начинает вторую сборку. API ACK означает регистрацию восстановления,
не завершение всех задач. Точный отчёт доступен по возвращённому reportUrl.
Подтверждённый отказ continuation отмечается как unresolved и снимает restart hold;
сохранённая отрицательная квитанция не превращается в success или автоматический retry.

## Общая активность и допуск установки
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
| Оркестрация | `orchestration-runs.json` через `OrchestrationRunStore.listActive()` | `kind:"orchestration"`: активный child блокирует реальный target и inherited source; `waiting_descendants` остаётся работой ветки; `completed + resultComplete=false` проецируется как `result-proof`; после terminal-state source остаётся `completion-handoff`, пока post-Enter audit не подтвердит точный `runId`. `waiting_recovery` и ошибка доставки сохраняют completion-блокировку и не считаются активной анимацией. В обычном install-допуске SOURCE20.10 исключение возможно только для строго сохранённого внешнего SC ожидания без неясного локального ввода; реальные target/result/input blockers сохраняются. Generic `busy:true` ничего из этого не снимает. Все tracked-состояния переживают restart и retention, а auto-stop запрещён до полного result-proof |

Общая проекция дедуплицируется по tabId с приоритетом runtime. SOURCE20.10 install-eligibility отдельно сохраняет все настоящие input/turn blockers той же вкладки; returnTo больше не является исключением из них.

Идемпотентно для idle-определения: `idle === (loaders.length === 0)`.

Важно для логов: `idle:true` в `/api/active-loaders` означает «нет отражённой общей активности», а не «в Noted Terminal вообще нет живых процессов». Ручной `npm run dev` или idle Codex/Claude PTY могут продолжать существовать. Web-server логирует изменившиеся снимки как `[ActiveLoaders] status=... idle=... count=... kinds=... tabs=...`, поэтому диагностика `build:i-obs` должна читать этот смысл, а не текст старого wrapper'а `already idle`.

**Шрам «дыра между звеньями цепочки» (2026-08-16).** До этой правки список блокеров отвечал на вопрос «идёт ли ход прямо сейчас», а вызывающая сторона спрашивала «осталась ли работа, которую пользователь ждёт». Для цепочки Run after это разные вопросы: между двумя звеньями никто не работает — триггер уже закончил, владелец ещё не стартовал. Замерено в production.log: `tab-2532` завершилась в 07:35:01.6, `tab-2570` стартовала в 07:35:03.3, а опрос idle попал в 07:35:02.0 — **дыра шириной 1.7 секунды**. Ребилд получил `idle=true count=0`, погасил приложение, и Codex записал `turn_aborted` без ошибки; пользователь увидел «кодекс просто остановился». Дальше цепочка встала законно: `tab-2572` ждала штатного завершения `tab-2570`, а прерывание им не является.

Ключевой вывод: `IDLE_CONFIRM` эту дыру не закрывает ни при каком значении — 1.7с шире интервала опроса, и это **реальное состояние системы**, а не артефакт дискретизации. Лечится не более частым опросом, а тем, что само обещание становится видимым. Поэтому источник — durable `promptQueueByTab`: живой копии очередей в main нет, а вторая копия была бы ещё одним источником рассинхрона.

Две границы, важные для общего endpoint:
- **Живость очереди = строка вкладки существует, а НЕ живой PTY.** Это позволяет другим клиентам видеть обещание, даже когда очередь законно ждёт остановленную вкладку и позже сама её поднимет (`inactive → LAUNCH_FOR_QUEUE start-fresh`). Ручной observer затем делает собственную более узкую проекцию и не считает это обещание причиной откладывать сборку.
- **Ошибка чтения очереди не роняет весь снимок.** `try/catch` вокруг сохраняет остальные живые turn-блокеры. `build:i-obs` игнорирует и `prompt-queue-state`, потому что для его нового контракта состояние пассивной очереди вообще не участвует в решении.

Продуктовое уточнение 2026-08-25: `build:i-obs` ждёт фактически выполняемую работу, а не возможную будущую работу. Это осознанно отменяет для ручной команды старое правило «durable Run after promise закрывает любую дыру между звеньями». `IDLE_CONFIRM` остаётся защитой от коротких переходов реальных runtime-сигналов, но не обещает дождаться ещё не запущенной карточки. На25.08 scope был локален wrapper-у. SOURCE20.10 Voice Record и wrapper используют отдельную install-eligibility; другие клиенты общего activity endpoint сохраняют свою семантику.

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

С11.10 destructive wrapper использует отдельный `found/absent/unknown` reader,
один aggregate `ps` snapshot и точный prefix основного installed executable.
`PORT` тоже должен совпасть с подтверждённым installedMain, не разрешает наблюдать
idledev/test вместо закрываемого production. Timeout/пустой или нечитабельный snapshot, read-error discovery, живой прод без
пригодной metadata —unknown, не«прод выключен». Helper/hub и аргумент другого
процесса с упоминанием пути приложения не дают production owner. Только успешный
system snapshot без main-процесса даёт absent/bootstrap. Nullable legacy reader
других недеструктивных callers оставлен отдельно, его null не является новым proof.

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
- **Старый билд без эндпоинта** (404): печатает «predates /api/install-eligibility», просит разовый `build:install` для бутстрапа, exit 2. НЕ строит вслепую.
- **Прод не запущен**: нечего ждать → строит сразу (или exit при `NO_BUILD=1`).

11.10 incident00:06BKK(10.10 17:06UTC): пользователь подтвердил `build:i-obs`.
Main17:04:47 публиковал6Codexbusy+orchestration1(ещё5passivequeues),17:06:04
начал новый turn,17:06:21вошёл вshutdown с10живымиCodex. Среди сохранённых
ActiveLoaders-ответов этого boot не найдено0реальных blockers. AutoResume потом
подтвердилready10/10, не выполнение прерванных задач. Первичный installerstdout
недоступен: точный прежний skip-path не доказан. Найдены две допустимые дыры:
`pidCommand` timeout превращался впустуюстроку→null→немедленныйrunBuild;
после подготовки package wrapper вообще не проверял соседей снова.

SOURCE исправил обе без новых Main/Voice/lifecycle policies: unknown удерживает
стрик, смена prodPID/порта сбрасывает его; после `ready-to-quit` отдельный observer
ждёт заново и через прежний nonce/control-channel даёт canonicaldriver разрешение
`install` только поidle/absent. В процессе ожидания посылает `waiting`, чтобы
owner channel не протух из-за долгого чужогоturn;cancel/EOF/error не даютQuit.
Childexit прекращает ожидающийobserver;дубликатready не запускает второй.
Граница прежняя observational, не атомарная reservation всех будущих Send.

57scopedtestsPASS, включая actualcanonicalstagedinstaller на ownedtempApps с
подменёнными build/sign/quit командами, сценарииbusy-after-prepare/cancel/invalidproof.
Live GET-only observer увидел installedPID32057/7878 и9blockers, затем намеренно
отменён;реальныйinstall/закрытие пользователя не выполнялись. Evidence:
`/private/tmp/noted-build-cache-20261011.eWevI4/HANDOFF.md`.

### Observe-фаза в Voice Record endpoint (SOURCE20.10)

Voice Record — отдельный владелец установки: закрытие Noted не убивает job,
его журнал, control pipe или возврат исходному агенту. Обычный hook и ручной
`build:i-obs` читают **`/api/install-eligibility`**, а `/api/active-loaders`
сохраняет общую проекцию runtime/унаследованной работы, включая ожидание install.
Это разные вопросы: сохранённый внешний SC Research остаётся видимой работой,
но закрытие Noted не должно отменять его или бесконечно задерживать update.

Допуск строится в Main из настоящего runtime, launch/Stop/history/PTY input,
нативного FIFO/receipt и строго записанного RunStore. Для внешнего ожидания нужны
app-owned job/intent/fingerprint и точный source; supplied `preserved:true` не
даёт исключения. Одна вкладка может одновременно иметь переносимое ожидание и
настоящий input/turn blocker — дедупликация не должна скрывать последний.
Неизменившаяся когорта использует только квитанцию последнего успешного writer
с тем же epoch; новый/неуспешный write отзывает её. Наблюдение не переписывает
весь RunStore каждую секунду без новой информации. Физические слоты всех вкладок
сверяются ещё раз после последнего await всей runtime-когорты; равные tab keys/count
не скрывают замену PTY, а paste в уже прочитанном shell не теряется за медленным
соседним reader.

Обычный observer ждёт **также исходный ход**. MCP быстро принимает долговечный
job, агент заканчивает текущий ход; ждать работу всего поручения не требуется.
Старое exclude-caller правило вычитало целую вкладку, включая подготовку/ввод,
а `inherited-busy` чужого SC ожидания оставалось вечным blocker. Теперь эти оси
разделены. Две свежие проверки нужны до compiler и ещё раз после package-build,
непосредственно перед единственным owner ACK на Quit. Таймаут, 404 старого Main,
ошибка/неясность process discovery и persistence не превращаются в idle.
Положительно наблюдаемое отсутствие production допускает прежний bootstrap.

После обеих проверок пути сходятся в каноническом CURRENT `npm run build:install`:
проверка release/stage, синхронизация Terminal MCP и turn hook, maintenance,
штатный Quit, rollback-копия, замена, запуск и проверка связи. Отмена control pipe
не означает завершения compiler до его close/result; при неясном прежнем исходе
новый hook, в том числе Force, не создаётся. `phase` и nonce-bound `stage`
приходят от настоящего владельца, не от локального spinner.

### Явный Force и отчёт восстановления (SOURCE20.10)

`force:true` относится к одной операции и входит в неизменную request identity.
Он пропускает ожидание activity/loaders/MCP перед сборкой и перед Quit. Force не
является fallback обычного режима и не отменяет проверку candidate, исходного
адреса/журнала, control-pipe cancellation и persistent Browser/maintenance contracts.
Перед Quit Voice Record сохраняет доступные снимки Main; каждый недоступный
участник помечается unknown с bounded deadline, не ждётся бесконечно.

После успешного install один отчёт идёт **только согласованному returnTo**.
Он различает активность до Quit, подтверждённую остановку локального процесса
по exact shutdown receipt, восстановленный процесс и реально идущую работу.
Input сохраняет operation/handoff/attempt IDs; SC сохраняет run/job и не получает
фиктивный remote Stop. Shared MCP hub может пережить Noted: server PID/counts —
не журнал исходов RPC. Отчёт честно оставляет эти исходы и внешние/plugin/stdio
MCP неизвестными; исчезновение loader/pending не разрешает replay. Большой отчёт
сохраняется полностью и читается по исходному requestId вместо молчаливой обрезки.

SOURCE20.10 post-live: callback теперь короткая служебная квитанция со счётчиками
и exact `GET /api/terminal/build-install?requestId=…`, поле `job.interruptionReport`.
Длина сообщения не растёт с inventory и не повторяет custom многоабзацный план;
он сохраняется как `callbackInstructions` полного отчёта. Historical pending input
receipt не доказывает живой процесс/активный turn и не попадает в `wasActive`:
это отдельный сохранённый ledger, не список вкладок для массового Resume.
Report v2 разделяет pre-Quit process/work, exact shutdown interruption и unknown.
Read-only API projection исправляет legacy классификацию по сохранённым snapshots,
не переписывая original job/report/callback bytes или native receipt. Если исходного
snapshot нет, legacy active остаётся unknown. Уже frozen callback не переформатируется.

### Индикатор установки (SOURCE20.10)

Build Install — отдельный typed `install` в правом dock вкладки рядом с MCP
запросами, через тот же layout/row/history owner. Это не fake Research run и не
глобальная кнопка здоровья MCP-хаба. Noted Main читает singleton Voice Record
HTTP/SSE, сохраняет bounded status cache и публикует исходной вкладке SAME job,
revision, mode, phase/stage, callback/error/report. После restart сначала виден
честный stale cache, затем состояние живого владельца. Cancel адресует точные
requestId/jobId/source своему installer API; orchestration detach не вызывается.

### AI-hop изнутри Noted Terminal
Когда rebuild инициирует агент внутри самого Noted Terminal, он не должен запускать
`npm run build:install` в своей PTY-вкладке: управляющий процесс умрёт вместе с приложением.
Terminal MCP tool `build_install_noted_terminal` передаёт задачу в Voice Record
`POST /api/terminal/build-install` с `returnTo` (`tabId`, `sessionId`, `projectId`,
`projectPath`) и requestId. До Voice POST Main сохраняет source continuation, поэтому ACK/end текущего хода не открывает Loop. MCP tool возвращает job id; ожидание соседей (observe-фаза выше) и
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

Voice Record строго сохраняет requestId/immutable source, compiler/result и frozen
callback target/prompt/attempt в своём журнале. Same-ID retry не создаёт другой hook
и не меняет адрес. Restore до compiler продолжает тот же intent; уже начатый
compiler без terminal receipt остаётся unknown и не respawn'ится. Сохранённый
primary result переживает потерю close ACK. Поздний canonical callback receipt
можно принять пассивным чтением после deadline, без нового Send.

SOURCE20.10 post-live: app-added working context меняет transport, поэтому hash
логического callback нельзя сравнивать с transport audit token как одну identity.
Continuation сохраняет immutable logical SHA256, связывает его с exact app-owned
preparation (`base_hash`/actual prepared bytes), проверяет неизменный FIFO request,
canonical attempt/provider/session/audit и source до/после natural-result read.
Audit token остаётся SHA1/16; result reader получает полный normalized SHA256
точного transport. Main при exact UUID/source использует эти physical identities;
hash-only поиск отдельно требует именно полного normalized digest. Тот же SID или
совпавший suffix не заменяют этот chain. Восстановленная binding сохраняется до
ожидания final; stale ACK не может заменить её другим attempt. Старый v1 logical
hash восстанавливается только из reversible exact preparation с проверкой её
сохранённого full base hash и frozen audit token; недоказуемый legacy остаётся
unknown, без нового Send. Проверка с refreshed embedded wrapper проходит по
сохранённому logical hash, даже когда исходного suffix больше нет.

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

### Применение к живому владельцу

Новый hook требует обновлённого **работающего Voice Record** с journal/report
helpers и capability version2, а также нового Noted Main/renderer для eligibility,
source continuation и dock. Публикация Terminal MCP wrapper/metadata через штатную
синхронизацию не обновляет загруженный код sibling Voice Record. В shared hub новый
Terminal child подхватывает wrapper после согласованного restart только этого child;
legacy stdio-клиенту требуется перечитать свой каталог. Browser/hub целиком ради этого
не перезапускаются. Ручная первая установка сама не регистрирует completion prompt:
возврат оркестратора требует заранее явно настроенного действительного Run After
`after app restart` либо отдельного пользовательского продолжения после restore.

### Env-кнобы

`POLL_MS=1000`, `IDLE_CONFIRM=2`, `NO_BUILD=1` (только наблюдать), `PORT=7878`
(выбрать подтверждённый productionport; не обход discovery для dev/test).

## Тестирование без ребилда
`web-server.js` требует electron (`ipcMain`/`app`/`BrowserWindow`). Для headless-харнесса замокать через `Module._load` shim (`require('electron')` → fake), `start({sdkSessions:new Map(), computeActiveLoaders: ()=>mockState})`. Observer тестируется через экспортированный`waitForIdle` с контролируемымиinspect/read, не запуском destructiveCLI против`PORT=<mockport>`: с11.10порт должен принадлежать реальному installedMain. Runtime-логика тестируется с mock-Map'ами; orchestration merge покрыт отдельно: source+target активного run, recovery без shimmer, `result-proof`, completion-handoff до exact proof, исчезновение после proof и дедуп с runtime-loader. Отдельная регрессия проверяет, что incomplete локальный target-result переживает restart/retention, блокирует обычную установку и не запускает auto-stop; сохранённый внешний SC wait проверяется отдельно через strict eligibility. В DEV live endpoint вернул stale `tab-2142` как `kind:"orchestration", status:"completion-handoff"`, тогда как run с уже подтверждённым exact follow-up в список не попал. Реальная установка/пользовательскийQuit в E2E не выполняются;canonicaldriver gate проверяетсянаownedtempFS сmockbuild/sign/quit.

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
