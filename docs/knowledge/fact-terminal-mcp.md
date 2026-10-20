# Feature: Terminal MCP Server

## Intro
MCP-сервер для управления терминальными вкладками из AI-агента (Claude Code, Codex CLI, Gemini CLI). Позволяет агенту видеть запущенные dev-серверы, перезапускать процессы после изменения кода, читать output, выполнять build-цепочки и управлять живыми AI CLI во вкладках — без ручного переключения вкладок пользователем.

## Архитектура

Settings → Системные промпты доступны отдельно от Opt+V библиотеки через
`list_system_prompts`/`get_system_prompt` и `create/update/delete_system_prompt`.
Поля редактора и selectable Rewind assignment меняются по revision через
`/api/system-prompts`; назначение built-in по ID сохраняется. Capability
`systemPrompts.version=1` проверяется до обращения. Контракт и защита открытого
черновика — `fact-settings.md::Системные промпты через Application API и Terminal MCP`.

О завершении run нельзя отвечать по старой реплике «жду». Успешный backend result
не зависит от доставки уведомления; dismiss attention не является чтением ответа.
Source14.09 общий Send передаёт короткий terminal fact со следующим обычным prompt
той же session, не повторяя уведомление/result. Если такого контекста нет (включая
прямой TUI ввод), явный вопрос о стадии требует `get_delegation` точного runId,
а не нового платного запуска или предположения running. Полный ответ читается
один раз при необходимости; механизм — fact-оркестрация-вкладок::Скрытое уведомление.

### Шрамы05.09: отправка, выбор модели и уведомление

`send_prompt` использует cwd discovery только для выбора экземпляра приложения,
не передаёт его как cwd целевой вкладки. Иначе Resume вкладки в поддиректории
уходил в корень проекта. Main передаёт в renderer точные project/tool/tab type;
закрытый project подключается существующим background-open и читается заново
после await. Не найденный/изменивший тип target — явный no-submit, не скрытый
Claude SDK fallback. SDK доступен только для подтверждённой SDK-вкладки.

Inbox owner16.09 отдельно сохраняет exact creation result: observation8s не
отменяет create/Send и не создаёт разрешение повторить его. ONE canonical GET
run содержит `setupOutcome`v1; legacy lost reply остаётся unknown без backfill
по SID/названию/ready. Это внутренний API repair, не новый MCP runner. Wire —
fact-mobile-web::Inbox setupOutcome. Прежний send deadline после Enter отдельно.

`create_tab` и `start_ai` передают явные Claude model/effort в существующее
tab-scoped startup intent до запуска. Отсутствующее поле сохраняет default;
выбор не меняет global Noted defaults. Для нового model-aware caller публичный
контракт типизирован: `list_agent_models` читает живой `/api/agent-models`, а
мутация передаёт либо `{kind:'catalog',id}`, либо явный `{kind:'custom',id}`.
Старое строковое `model` остаётся совместимым, но не используется для нового
автоматического выбора. Это не позволяет принять опечатку `opus-5` за
намеренный custom ID; catalog id `opus` сервер превращает в текущий точный
runtime ID из Settings.

Отказ readiness/settings до provider-paste имеет `submitted:false` и сохраняет
возвращённый draft. Полученный отрицательный renderer receipt не является
bridge timeout. Если ответ потерян после возможного Enter, состояние остаётся
delivery-unknown; отсутствие полей само по себе не доказывает no-submit.

Для cold Codex delegate с явной model/effort парой ready launch ещё может быть
provisional. Settings owner `launch:<id>` и conversation SID — разные оси:
первая удерживает picker CAS, вторая приходит только из exact Resume authorization
или adopted writer. Их смешение давало ложный target_changed до native picker
(4196,17Oct). Обычная отправка без override не проходила этот участок; запрещать
override, ждать первый пользовательский Enter или replay задания не требуется.
Полные guards — `fact-codex.md::Модели и effort`.

`read_draft` возвращает полный объект с текстом, imagePaths и draftTransfer,
а не только непустую текстовую строку. Idle `interrupt_ai` читает current main
turn у write-boundary и не пишет Escape; повтор не превращается в native Rewind.

`create_tab` и последующая отправка/делегация в возвращённый `targetTabId` —
штатный двухшаговый flow, а не ошибка использования API. Прямая делегация с
созданием target остаётся дополнительным удобным вариантом, но не обязательным
обходом. В одном проекте отсутствие `cwd` наследует точную папку source-tab;
явный `projectId` сам по себе больше не сбрасывает её в корень проекта. Другой
проект получает собственный root/context, fork сохраняет папку источника, а
иной cwd передаётся только по явному требованию пользователя.

Инцидент10.09 `tab-4732`: вкладка имела `/tmp/noted-newtab…`, StatusLine Claude
сообщил тот же каталог как `/private/tmp/noted-newtab…`. Raw prefix-check счёл
их разными, не записал live session в main и две existing-target делегации
вернули `agent_send_target_changed` с `pasteWritten:false`. Теперь CwdGuard
сначала сравнивает `realpath`; настоящий чужой каталог по-прежнему не получает
право менять main caches. History session hint может найти transcript для audit,
но без живого bridge/PID не разрешает физическую вставку.

Completion run и доставка уведомления независимы. `status=completed` с
`notificationStatus=failed` означает сохранённый результат и неудачную доставку
родителю. В05.09 причиной был `codex_writer_identity_pending` в старом Resume
source; нельзя повторять весь audit. При явном расследовании/восстановлении
проверяется durable run и один раз читается result, без polling transcript.
`/terminal/tabs` использует один общий runtime batch, не N последовательных
process lookups. Установка из собственной сессии — только
`build_install_noted_terminal`: внешний Voice Record ждёт driver-ready/idle,
возвращает в точные tab/session, не в sibling с похожим именем.

Тесты: `agent-send-target-routing`, `agent-send-preflight-receipt`,
`agent-create-settings`, `terminal-tab-list-runtime`,
`phase2-f4-f5-web-orchestration-receipts-20260802`, Terminal MCP stdio tests.

### Один публичный MCP, несколько внутренних границ
После унификации публичная AI-поверхность одна: `~/.claude/mcp/terminal-server.mjs`. Она не переносит бизнес-логику в MCP, а типизированно вызывает существующие main-process HTTP/API-сценарии:
- live process control и shell output;
- Project API для agent send/interrupt, saved-history Rewind, долговечной оркестрации AI-вкладок и отслеживаемых browser-консультаций SC Desktop;
- `/overseer/*` как внутренний read/edit backend истории;
- renderer bridge для persistent UI-state: план задач, имя вкладки и file-child.

Отдельный `overseer-server.mjs`, его MCP-регистрация и skill удалены. Причина объединения — не смешать blast radius, а дать нейронке одну обнаруживаемую поверхность: раньше правила выбора между двумя MCP жили в длинном skill/prompt и регулярно приводили к чтению ответа через terminal output или polling не того канала. Опасные операции по-прежнему разделены отдельными методами и approval-контрактами. Механика истории описана в [`fact-session-history.md`](fact-session-history.md).

### Определение проекта и своей вкладки

Для небольшого списка известных tabIds есть пассивный `inspect_tabs` (до8,
capability `tabInspection.version:1`), без запуска/ps/полного чтения истории.
Ответ разделяет runtime/turn, собственный background, tracked jobs и pending
доставку; optional verified cached final ограничен2000UTF-16 символами и содержит
ref/truncated. Cold/unknown остаётся явным. Он не создаёт wait/job и не заменяет
`wait_for_tab_response`. Полные границы — fact-session-history::Компактный пассивный
снимок выбранных вкладок. Новый app handler требует обновления bundle, новый MCP
wrapper — штатного refresh terminal-child после обновления его установленной копии.

Для последних Codex user-итераций при busy есть отдельный `read_session_snapshot`
(`sessionSnapshot.version:1` у `/overseer/capabilities`), до8 ходов, default5;
`maxChars` до20000 отдельно для user/assistant. Возвращает cutoff/asOf, реальные
prompt/partial answer, canonical refs, in_progress/responseComplete и coverage.
Сохранный append после cutoff не требует idle/Stop или нового Send. Rewrite,
resolver/view/owner changes отзывают результат. Это read-only snapshot одной
попытки, не completion authority; новые app handler и MCP wrapper обновляются
отдельно. Bounds декодирования и граница cold lineage —
`fact-session-history.md::Снимок последних Codex-итераций во время busy`.

Внутри полноценной Noted Terminal-сессии main передаёт MCP `NOTED_PARENT_PROJECT_ID`, `NOTED_PARENT_TAB_ID` и `NOTED_MAIN_PID`. Они приоритетнее cwd и активной вкладки UI: пользователь может смотреть другой проект, пока агент работает в фоне. `current_context` возвращает доказанную пару project/tab и известный sessionId; self-операции (`rename_tab`, `link_file`, `get_tab_plan`, `apply_tab_plan_changes`) принимают отсутствующий `tabId` как эту родительскую вкладку.

Внешний клиент без parent env использует `list_projects` и передаёт явный `projectId`/`tabId`. `process.cwd()` остаётся fallback для старых callers, но не source of truth для собственной идентичности.

Изолированный dev/E2E задаёт ещё одну часть instance identity — `NOTED_DISCOVERY_DIR`. В этой папке обязаны вместе жить `mcp-port-*`, `web-server-*` и `web-token.txt`: read-команды Terminal MCP и Project API mutations должны выбрать один и тот же Electron main. Шрам 2026-09-03: `current_context` и `list_tabs` находили тестовый dev по `NOTED_MAIN_PID`, а `delegate_to_session` искал web-server только в глобальном `~/.noted-terminal` и уходил в production; результатом был правдивый, но чужой `404 source tab not found`. Прямой stdio использует один process-configured discovery root для обоих каналов; без override это `~/.noted-terminal`. Shared hub использует следующий per-request контракт.

Для shared hub это не общий ENV override: Main передаёт opaque instanceRoute
с root и поколением в служебной identity. Terminal закрепляет одну пару MCP/API
records и token того же root; missing/dead/replaced pin не становится host
fallback. Source/recipient/launch/writer guards остаются у приложения. До ремонта
17.10 именно fallback давал tab=null/exists=false; message POST ещё не вызывался.
Новый route проверен настоящими current_context/inspect, send_message/reply/
get_message двух private Luna и параллельным host lookup. Public root/port/
credential аргументы не добавлены, дополнительных live stdio не требуется.
Прямой stdio/env и прежний четырёхпольный host сохраняются отдельно.

### Tab Data: SQLite + Live State
`/terminal/tabs` объединяет данные из двух источников:
- **SQLite** (renderer → save-tabs): name, color, command_type, cwd, tab_id — снимок на момент последнего save
- **Main process Maps** (live): terminals (PTY alive?), terminalCommandState (isRunning), terminalInitialCommand, pid

С11.10 exact `parentProjectId` разрешается и как legacy Project, и как v2
execution namespace из `workflow_execution_scopes`, до fallback по legacy cwd.
Наличие Project row не является условием существования standalone вкладки.
Known empty namespace возвращает пустой свой список, а не вкладки совпавшего
по cwd Project. Активные rows/цвет/порядок и один passive Codex runtime batch
сохранены; saved SID не превращается в writer/ready. Шрам: в full DEV с0Projects
`current_context` имел правильные work-context/placement, но `tab:null` из-за
раннего Project-only return. Это дефект списка Main, не подтверждение потери
MCP transport и не основание убрать проверку actual tab.

`/overseer/sessions` использует тот же один passive Codex runtime batch для
глобального каталога, с `{tabId,savedSessionId}` и без общего projectId. Он не
вызывает per-row process reconciliation или materialization истории. Прежний
последовательный обход всех сохранённых сессий задерживал `list_open_sessions`
за клиентский срок60с; тот же fan-out скрывался в `historyResultWithLifecycle`
даже при чтении одной Claude-сессии. Это не отказ уже выполненного Create/Send.
Проекция не является свежим физическим proof для Send: unknown/null writer
сохраняются, saved SID не подставляется вместо живого writer, source не становится
alias resumed child. History wrapper объявляет idle только при явном busy=false,
liveLifecycle=true и status active/idle; closed/starting/unknown/missing не дают
ложного completion. Exact сравнение sessionId и сами mutation guards прежние.

### План задач вкладки

Public native cards читают компактную проекцию того же плана в `/api/projects/:id/tabs`
при `cardSignals.version=1`; это не новый MCP editor и не замена full `get_tab_plan`.
Ответ содержит root id/status/order/revision, общий каталог без descriptions,
pending count и exact current Fast. Scope/wake —
`fact-mobile-web.md::Компактные сигналы карточек вкладок`.

Terminal MCP публикует две отдельные команды структурированного плана:

- `get_tab_plan` читает план целевой вкладки и одновременно возвращает актуальные статусы задач с их описаниями;
- `apply_tab_plan_changes` атомарно применяет уже подтверждённый пользователем пакет операций.

Если `tabId` не передан, сервер использует `NOTED_PARENT_TAB_ID`, то есть вкладку, которой принадлежит текущая AI-сессия. Это важнее активной вкладки интерфейса: пользователь может в момент фоновой правки смотреть другой проект.

Команда записи намеренно не принимает свободный Markdown. Контракт ограничен операциями над двумя уровнями структуры и архивом корневых задач (`archive_task` / `restore_task`); один вызов образует одну точку общей истории undo/redo. Инструкция инструмента и `docs/prompts/план-задач-вкладки.prompt.md` требуют до вызова показать точную дельту и дождаться явного подтверждения пользователя. Подробнее: [`fact-tab-task-plan.md`](fact-tab-task-plan.md).

## Уведомление пользователя в Telegram

`notify_user({text,waitSeconds?,requestId?})` отправляет уведомление человеку от
собственной полноценной вкладки. Это отдельный Telegram-only сценарий, а не
`send_message` другой нейронке и не взведение completion bell. Он не меняет
armed/persistent/fired, unread, красный workflow-alert, звук или APNs.
При просьбе «уведоми, когда закончишь» агент вызывает его после нужной работы,
а не после каждого промежуточного ответа.

Main принимает запрос через `POST /api/terminal-tabs/:tabId/notifications`,
сохраняет текст и паузу до отправки и использует прежний outbox-класс в отдельной
FIFO. Имя/адрес источника берутся из каталога вкладок; MCP не принимает source/
target override. Это чтение метаданных, без загрузки History, запуска агента или
зависимости orchestration. Требуется `capabilities.userNotifications.version:1`
у `/api/me` и обновлённый receiver SC Desktop
`/notifications/terminal-user`; у старого Noted нет bell/direct-Telegram fallback.

`requestId` создаётся MCP до сети и возвращается при неизвестном исходе. Один
ID внутри вкладки сохраняет исходные текст/паузу и время отправки; изменённый
payload конфликтует. `get_user_notification({requestId})` — пассивный reader той
же квитанции. Missing/pruned/ошибка чтения не разрешают новый ID или resend.
Квитанции ограничены24часами/2048записями, receiver dedupe —24часами/512записями;
не обещать вечную exactly-once доставку после потери/вытеснения доказательств.

Для уже разрешённого перехвата курсора агент может передать заданные пользователем
20–30секунд в `waitSeconds` (0–60, default0). MCP ждёт этот интервал только после
точного Telegram message ID и `sentAt`; повтор не начинает его заново. Успешное
предупреждение — `deliveryState:sent` вместе с `waitCompleted:true`. Accepted,
pending/unknown/failed или прерванный вызов не завершают предупреждение: агент
не должен начинать перехват. Команда сама не управляет мышью и не выдаёт права
ввода; Telegram ACK также не доказывает прочтение человеком.

Прямой HTTP-вызов этого же POST не требует MCP или перезапуска AI-сессии.
Он возвращает квитанцию после первой попытки, не удерживает HTTP-запрос на время
паузы: direct client сам ждёт до `waitUntil` после `deliveryState:sent` и не
перехватывает курсор при другом исходе. Авторизация — прежний Noted bearer;
`sourceMeta:{server:"terminal",tabId,projectId}` сверяется с адресом и каталогом.
GET той же `/notifications?requestId=...` только читает квитанцию. В старом Main
нового маршрута нет: обход MCP не заменяет обновление desktop-приложений.

## AI live control

Terminal MCP управляет **живым процессом**, а не историей. `start_ai` создаёт или переиспользует вкладку и запускает `claude` / `codex` / `gemini` через те же app-native launch hooks, что UI. `send_prompt` вставляет prompt в целевую вкладку через существующий safe paste path, `stop_ai` останавливает AI process-tree без уничтожения shell. Для `codex-c` / `codex-f` / `claude-c` / `claude-f` create-tab aliases проходят через pendingAction, чтобы renderer применил тот же resume/fork flow, что пользовательская кнопка.

### Готовность целевой вкладки и отправка prompt

`close_tab` использует общий полный Close: вместе с владельцем закрываются
связанные файловые вкладки и их размещения, но не disk files и не самостоятельные
AI-child с их файлами. Возвращённый общим обработчиком отказ (например archive/save
или неподтверждённый PTY Stop) передаётся caller, а не превращается в прежний
безусловный `closed:true`. Внешняя схема метода не менялась;
placement-only «Убрать» остаётся отдельным UI-действием. Подробности —
`fact-tabs.md::Файловые вкладки как visual-child`.

Явный `send_prompt` с `submit=true` является разрешением вернуть адресованную AI-вкладку в рабочее состояние. Остановленный процесс возобновляется общим send-сценарием; закрытая вкладка сначала восстанавливается в фоне из единственной архивной записи с тем же исходным `tabId`, после чего тот же сценарий поднимает прежнюю Claude/Codex-сессию и выполняет отправку. Архивная запись, рабочая папка и восстановленная вкладка проверяются до Enter. Удалённая запись, два архива с одним identity, другой тип вкладки или недоступная папка дают явную ошибку: создавать «похожую» новую сессию запрещено. Пассивный lifecycle/restart reconcile вкладку не открывает — закрытие пользователем сохраняет силу, пока не придёт новый явный send. `submit=false` остаётся операцией над уже живым composer и сам вкладку не восстанавливает.

`start_ai` подтверждает не только запись launch-команды. Для Claude ответ
`ready:true/inputReady:true` возможен после TUI prompt **и** ready startup-gate
для `/model`/`/effort`; для Codex — после доказанной готовности composer и
проверки запрошенной next-launch пары. Первый TUI edge лишь будит проверку.
Ожидание закрепляет identity принятого launch до самого первого runtime read:
готовый replacement не может завершить чужой start_ai. Claude сохраняет
собственный первый OSC-B под launch token, Codex — также lifecycle pin.
Отсутствующий owner в результате запуска не подменяется текущим runtime.
Для Claude он также только открывает транзакцию: первый settings-paste ждёт
устойчивого composer-frame после последней startup-перерисовки. Если запуск сразу
получил пользовательский prompt, тот ждёт доказанных model/effort и не может
обогнать их.
Последующий main-side переход settings `pending → ready/failed` будит тот же
waiter второй раз. И пробуждение, и повторное чтение используют один
main-owned снимок; renderer не обязан успеть принять IPC и вернуть его через
bridge. Поэтому холодный/reloading renderer не оставляет API на однажды
прочитанном `pending`, а startup failure возвращается явно вместо ложного 504.

Распознанный Goal/usage picker, требующий пользователя, даёт typed
`codex_resume_goal_action_required`/`codex_usage_exhaustion_action_required`,
а не общий timeout. Desktop использует ту же классификацию; его ещё не
отправленный prompt возвращается в input и не отправляется сам после выбора.
MCP не выбирает пункт повторным Send; настройка System по-прежнему владеет
разрешённым автоматическим выбором, readiness подтверждается отдельно.

Cold Codex Send использует `startupWait` того же main-owned launch: его
absolute deadline, terminal/run/lifecycle proof, не собственный ранний30s отказ.
Новый wake срок не продлевает; смена launch, Stop, manual picker и startup failure
завершают подготовку без paste. Обычный live-picker без launch сохраняет30s guard.
Late join использует тот же абсолютный Main deadline, даже когда осталось менее
30s; renderer не добавляет новый бюджет. Это граница ожидания, не запрет уже
доказанной готовности: окончательный допуск записи остаётся у physical guards.
Точный Stop до paste даёт cancelled receipt, не generic preflight failure;
уже подтверждённая отправка сильнее поздней отмены. Старые failed receipts не replay.

Первое `ready` может предшествовать следующей незавершённой DEC2026-перерисовке.
Для cold send-preflight Main использует оставшееся время того же
launch deadline и прежний event-driven draft observer, а не отдельный ранний2.5s
отказ, в том числе когда кадр открывается в первом flush await. Возле expiry
остаток срока может быть меньше2500ms; повторные wakes его не продлевают.
Definitive draft возвращается сразу. Обычный probe без текущего launch сохраняет свой срок;
истечение не означает empty и не разрешает новый Send. Шрам/границы —
`fact-codex.md`, cold Resume753/776/73ea14.10.

Не смешивать этот preflight с публичным `draft_state`: установленный14.10
HTTP inspect вызывает renderer `inspectDraft`, возвращает визуальный hint и
frameIdentity, но не Main negative authority. Он полезен для read-only диагностики;
новый разрешённый Send всё равно обязан пройти обычный Main proof. Отдельный
Start перед hint не является исправлением cold-frame отказа и не разрешает
replay прежней unknown/cancelled операции.

### Явный выбор native Goal через MCP

`get_codex_goal({tabId,requestId?})` читает состояние меню/точной попытки без
запуска вкладки. `resolve_codex_goal({tabId,operationId,action,requestId?})`
выбирает `resume` или `leave-paused` по `availableActions`; это штатный native
пункт, не удаление Goal и не Stop процесса. Новый endpoint GET/POST
`/api/terminal-tabs/:tabId/codex/goal`, capability `codexGoal.version=1`.
Main переиспользует parser, current committed frame, owner/input proof и PTY-lock.
HTTP202/pending и actionWritten не подтверждают выбор; confirmed требует
последующего composer-proof. GET с requestId восстанавливает неизвестный ACK.
Same requestId связан с tab/operation/action; другой payload конфликтует.
После unknown новая явная попытка возможна только по recoveryAvailable и новому
committed кадру того же интерактивного меню после завершения прежнего writer.
Старая квитанция остаётся unknown, простой повтор Enter запрещён.
Если3s проверка после Goal Enter не получила нового current committed результата,
unknown не является доказанным manual-action: исходный unwritten Send продолжает
existing event-driven ожидание в своём прежнем preparation scope. Только свежий
same-menu proof разрешает прежний explicit recovery; GET ничего не нажимает.
Отменённый/истёкший/failed Send от поздней готовности не возобновляется.
Квитанции runtime-scoped:1024 без вытеснения, затем явный capacity error;
после restart namespace новый, старый operationId не может нажать новое меню.
Ни выбор, ни GET не пересылают failed prompt и не меняют System preference.

### Статус доставки и получение результата

Короткий вопрос занятому владельцу и делегация самостоятельной задачи сейчас
идут разными путями. `send_message`/`reply_to_message` сохраняют адресную связь
вопроса и ответа, не ожидая final занятого владельца; `get_message` читает одну
пару для диагностики. Контракт — `fact-tab-messages.md`.
`accepted:true` подтверждает сохранение сообщения приложением; о доставке можно
отчитываться только при `deliveryState:sent`. Pending/queued/error сохраняют
свой смысл в финальном отчёте агента. Reply может быть записан и доступен через
`get_message`, хотя обратный ввод в остановленную сессию не произошёл.
Низкоуровневый `send_prompt` пользуется provider queue общего send-сценария
и сам не создаёт отношения «вопрос → адресный ответ». В `delegate_to_session`
`queue:true` означает долговечное ожидание освобождения target в приложении:
независимые runs доставляются отдельными provider-turn, с predecessor-очередью.
Completion-уведомление, напротив, разрешено доставить в уже busy source через
native queue. Поэтому ожидание занятого target штатно и само по себе не ошибка.

Проверенная цепочка02.10: источник257 отправил вопрос4735 через `send_prompt`,
вписав в текст собственный tabId и просьбу ответить через обратный `send_prompt`
во время работы. Ответ7941символ пришёл источнику, пока адресат продолжал
benchmark. Обе exact квитанции confirmed; runId у них отсутствует. Две
последующие ошибки400/409 возникли при попытке читать статус повторной
отправкой пустого/сокращённого текста под старым handoffId. Статус читается
через `GET /api/terminal-tabs/:id/send-receipts?handoffId=...`; новый payload
не является проверкой старой отправки. После этого разбора добавлен
`get_send_receipt({tabId,handoffId})`, который читает тот же endpoint без Send.
Ручной reply-back заменяется адресными message/reply, а не длинной инструкцией
с вручную вписанным return-tab.

`send_prompt` / `Status: sent` — это delivery-only сигнал. Для остановленной или восстановленной вкладки он включает ожидание запуска; завершения ответа не ждёт. Pending/unknown проверяются через get_send_receipt, не новым Send. Для ручной инспекции уже открытой сессии history-tools того же Terminal MCP читают `list_open_sessions` → `busy/status` → targeted turn/text. Для долгой делегации этот цикл запрещён: `delegate_to_session` создаёт persistent run, после чего текущий assistant-turn заканчивается. Новый completion обычно уже содержит полный проверенный ответ: его используют напрямую. `get_delegation_result` нужен при явном omitted/reference, старом техническом уведомлении либо адресном восстановлении. Чтение result/status/transcript циклом до уведомления не доказывает штатный flow. Так 30-минутный turn не держит HTTP/MCP-вызов и переживает restart.

`wait_for_tab_response({tabId,runId?,waitForDescendants?})` наблюдает уже идущую
работу существующей Claude/Codex PTY-вкладки, не отправляя ей prompt и не
запуская её. Source берётся из полной MCP-сессии, не из текста модели. Вызов
типизированно оборачивает `POST /api/terminal-tabs/:tabId/response-observations`
с `sourceTabId/runId`; до ACK приложение сохраняет `runKind=response-observation`.
По умолчанию ждёт подтверждённого idle и окончания связанной работы, затем
выбирает последний ответ. Main `goalWork` от структурированного Codex outcome
удерживает это ожидание между Goal-ходами: проверяется до/после чтения и до
быстрой фиксации результата. Это не child count и не новый provider request.
`waitForDescendants:false` у busy target закрепляет
точный текущий provider-turn, не следующий. Уже idle target читается без нового
запуска. После accepted модель заканчивает ход; ответ приходит обычным completion,
а `get_delegation_result` нужен только для явного reference/восстановления.
`cancel_delegation({runId,interrupt:false})` отменяет только наблюдение;
`interrupt:true` для него отклоняется. Требуются live tool и
`/api/me.capabilities.responseObservations.version=1`; старый app отвечает
update-required без Send/polling fallback. После потери ACK сохраняются тот же
runId и неизменные аргументы. Точное чтение, ошибки и persistence описаны в
fact-оркестрация-вкладок::Наблюдение уже выполняющейся работы.

Для адресного восстановления такого ожидания есть `recheck_tab_response({runId})`:
требует `responseObservations.recheck.version=1` и вызывает прежний `/action`
с отдельным `action:"recheck"`. Сохраняет target, wait policy и получателя; нового
run/input/Resume не создаёт. Ранее сохранённый terminal outcome возвращается без
повторной source notification, новый проверенный результат доставляется обычным
путём. `get_delegation` и replay `wait_for_tab_response` остаются пассивными;
generic Retry/agent-only Continue не являются безопасной заменой recheck.
Обновления одного MCP недостаточно без соответствующего Main; старый capability
отклоняется до POST. Это единичное recovery-действие, не разрешение polling.

При явном восстановлении после Build Install проверяется весь обмен, а не только
запуск CLI или доставка нового «продолжай» родителю. Shutdown snapshot перечисляет
живые процессы, не все незавершённые поручения. `GET /api/orchestrations` даёт только
tracked runs; терминальные отказы нужно брать также через `?tabId=...` для источников
и связанных targets, включая не запущенный до shutdown target. Exact send receipts
и логи различают отказ до input, неизвестную доставку, уже принятый последующий
повтор и готовый ответ с неудавшимся возвратом. Совпавший текст поздней confirmed
квитанции доказывает доставку повторного сообщения, но не выполнение всей задачи.
Отменённое ожидание busy-target тоже не доказывает, что его поручение доставлялось.
Новая установка не оживляет старую failed квитанцию: новое восстановление допускается
по явному поручению после проверки прежнего исхода и отсутствия успешной замены.
Снятие attention допустимо после обработки/возврата результата, но само его не
доставляет; старую ошибку нельзя переписать в sent ради исчезновения карточки.

Для делегации в уже существующую вкладку провайдер определяет сама target-вкладка: Terminal MCP не передаёт default `toolType=claude`. Этот default относится только к созданию новой сессии; явный конфликт провайдера Project API отклоняет до создания run. Успешный `delegate_to_session` всегда возвращает верхнеуровневый durable `runId` и тот же объект в `structuredContent`; HTTP/MCP-ошибка остаётся `isError=true` и также содержит структурированное `{ ok:false, error }`. `null`, пустой результат или ответ без `runId` не являются отправкой и запрещают отчёт «запрос отправлен».

Browser-консультация использует тот же lifecycle, но не изображается фиктивной
Claude/Codex-вкладкой. `start_external_research` вызывает
`POST /api/external-research/orchestrations`: Noted Terminal сначала сохраняет
`runId`, точный source-turn, параметры и детерминированный
`jobId=noted_<runId>`, затем main в фоне обращается к SC Desktop
`/research-start` и ждёт `/research-status`. MCP-вызов возвращает после durable
reservation; вызывающая модель завершает ход. При `done|error` тот же
source-handoff доставляет полный проверенный ответ вместе с run/job/conversation
identity; отдельный GET в обычном пути не требуется. `get_delegation_result`
остаётся для явного reference/legacy notification, structured SC result или
адресного восстановления. Ошибка доставки уведомления не переписывает
успешный browser-result: он остаётся доступен по runId.

Для обычного ChatGPT URL без предыдущего tracked run доступны две разные операции.
`start_external_research({conversationUrl,prompt,...})` отправляет новый вопрос в этот
разговор. `import_external_conversation({url,...})` создаёт тот же durable browser-run,
но передаёт SC режим read-only: модель, вложения, composer и Send не используются,
результатом становится уже существующий current final. Pending commentary/tool не
подменяется старым ответом; optional `waitForFinal` только наблюдает тот же conversation.
Метод принимает доступный текущему browser-account `chatgpt.com/c/<id>`, а другой origin
или share URL отклоняет до Project API mutation. Повтор одного runId восстанавливает тот
же импорт, новый final требует нового ID и отдельного результата этого импорта.
Тяжёлый provider activity не входит в обычный импорт: живой Astra E2E показал, что
дублированный tool/file trace раздувает один result до сотен тысяч токенов. Wrapper
передаёт `includeActivity:false` по умолчанию; явный forensic-вызов может включить его.

`continue_external_research({previousRunId,...})` берёт у завершённого ChatGPT-run
сохранённый `conversationUrl`, exact SC job browser owner и прежние provider options; явный частичный
options override накладывается поверх них, а не стирает модель/режим. Новое сообщение
в том же разговоре всегда получает новый `runId` и новый `jobId`; старый ответ
не может удовлетворить новый review. Локальные файлы передаются SC как
`files:[{path,startLine?,endLine?|lines?,name?}]`: Terminal MCP делает путь
абсолютным, но не читает тело в source-контекст. Для сохраняемого review-чата
caller явно задаёт `mode:chat`, `temporaryChat:false`, `autoClose:true`: conversation
остаётся в истории, а закрывается лишь disposable browser-вкладка после локального
save. `autoClose:false` нужен только по явному желанию оставить её открытой; оба варианта
не меняют глобальный default SC Desktop.

SOURCE browserSelection v1 добавляет top-level `browserId:"chrome"|"yandex"|UUID`
к start/continue/import. Explicit требует поддерживающие App и SC до dispatch;
options.browserId не fallback. Omitted NEW start остаётся default, continue всегда
наследует доказанный previous-job UUID, legacy — только через capability-gated
metadataOnly reader без restore/native calls. Proven offline нового выбранного
профиля сохраняет тот же run в ожидании и один human-only Telegram outbox request,
без model callback/auto-launch/смены account. Unknown/admitted не становятся no-submit.
Подробности и границы account proof — `fact-оркестрация-вкладок.md::Browser-консультация
как второй тип target`. Поддержка SOURCE не заменяет live schema/capability после
обновления App, SC и долгоживущего Terminal MCP child.

Повтор одного browser-запуска разрешён только с тем же `runId` и полностью тем
же нормализованным запросом. После потери ACK или restart main сначала читает
тот же `jobId`; SC восстанавливает его из live state, terminal history или
browser-tab registry. Только доказанное отсутствие разрешает открытие, поэтому
автоматический recovery не создаёт второй платный prompt. Изменение текста,
файлового диапазона, options или conversation требует нового runId.

Вложенная делегация сохраняет ту же модель. Terminal MCP передаёт Project API точный контекст текущего source-turn; только его совпадение с конкретным исполняемым входящим run разрешает автоматический `parentRunId`. Само наличие A→B не делает независимый ручной B→C его ребёнком. `waitForDescendants` по умолчанию не даёт target отчитаться наверх, пока его дочерняя ветка не закончена и её completion не принят по точному source-handoff. Новый provider-turn не обязателен: текущий store поддерживает exact `same-active-turn` и recovery `same-settled-turn`; отдельное app-owned user-message остаётся обязательным. Это доказательство доставки, не семантического использования текста. Зависимость принадлежит durable run, а не visual-child вкладки и не встроенному Claude/Codex subagent. Ранний отчёт разрешается только явным `waitForDescendants:false`; progress/status polling не заменяет этот параметр.

Если ответ уже вошёл в source, а Noted завершился до сохранения run-проекции,
startup сначала проверяет точную durable квитанцию общего History/FIFO owner.
Canonical audit хранит context именно этой row/session/attempt и явный queue flag;
его соединение с run не запускает target, новый research или повтор input.
Недостаточная legacy-квитанция использует прежний targeted transcript proof,
не latest turn вкладки. Pin квитанции снимается после strict run confirmation;
отменённый handoff от позднего proof не оживает. Подробнее —
`fact-оркестрация-вкладок.md::Persistence и восстановление`.

Входящий run получает этот контекст не от generic `busy` по `tabId`, а вместе с exact post-Enter proof собственного prompt. Это закрывает порядок, где `UserPromptSubmit` уже создал новый ход, а Project API ещё не успел отметить transport acceptance. Совпадение provider/session обязательно; повтор одного proof идемпотентно дополняет отсутствующий контекст и никогда не заменяет уже доказанный соседним turn. У Codex audit и `task_started` допустимы в обоих порядках: ранний audit дожидается start-события, а ранний start прикрепляется к следующей exact `user_message` записи того же хода. Polling и угадывание по `tabId` не используются; неоднозначность остаётся root с diagnostic.

Явное восстановление прежнего interrupted agent-run — `continue_delegation({runId})`
или фиолетовый Play `Продолжить запрос` в жёлтой MCP-карточке. Это thin POST
`/api/orchestrations/:runId/action {action:"continue"}`, capability
`orchestrationContinuation.version:1`. App сохраняет отдельный durable continuation,
проверяет обе истории, использует общий Resume/Send, и лишь точный новый prompt/turn
становится источником result. Sender/caller не заменяет прежнего получателя.
Pending/unknown не разрешают ещё один Continue; GET прежнего run показывает фазу.
Ready/already-active work не получает новый input; cancelled/terminal/changed branch
требует явно нового поручения, не воскресшего старого ID. Новая отправка исходного
snapshot — отдельное user action `new-request`, с новым run и обычной очередью.
Старый Main отвергается до POST; вручную имитировать этот flow несколькими tool
Send/Resume/read-latest нельзя. Browser jobs и read-only observations не перезапускаются.

Диагностический шрам14.10: после Codex Resume процесс и writer могут быть
подтверждены, input-ready уже true, но response reader сохраняет busy=null до
current-generation outcome. Это корректная неопределённость завершения ответа;
использование её как обязательного условия первого Continue создаёт блокировку
`continuation_runtime_unknown`. Проверять также preparation и latest-request read:
снятие одного раннего guard не исправляет всю цепочку. Готовность ввода нельзя
объявлять доказательством результата. Continue отдельно соединяет coherent Main
input-ready с exact writer/launch и стабильной response revision; generic busy=null
сохраняется. Проверка последнего задания читает только verified execution identity,
включая interrupted/no-final, без выдачи этого чтения за готовый ответ. Обе границы
повторяются в FIFO preparation. Уже готовый exact исходный результат не требует
input-ready; его доставка сохраняет прежние ownership/Goal/background guards.
Повтор durable intent использует сохранённый target, иначе stopped→ready незаметно
меняет fingerprint уже принятого Send. Исторический run не принимается по двум
пустым UUID. Проверка SOURCE и граница установленной версии — в рабочем tmp темы.

Request и PTY transport могут иметь разные hashes после доказанного codec.
Target и source-followup conduits сохраняют основание преобразования
(`canonicalReason`), а не только `canonicalized`. Шрам Fable13.09: пропавшая
связь оставляла run running после уже принятого StopFailure. Явный отказ теперь
закрывает вызов с понятной ошибкой; Terminal MCP не парсит надпись в xterm и не
повторяет prompt. Детали — `fact-оркестрация-вкладок.md::Fable limit`.

У Codex один физический provider-turn может пройти через несколько compaction,
внутренние `subagent_notification` и обычные пользовательские уточнения без нового
`task_started`. Поэтому пользовательское сообщение само по себе не разрывает
результат orchestration-run. Точный UUID/hash сначала доказывает исходный prompt,
после чего сохранённые provider, session, process generation и `turnId` ограничивают
одну физическую задачу: результат собирается от её `task_started` до
`task_complete` либо `turn_aborted` с тем же `turnId`. Новый `task_started` —
жёсткая граница; конфликт или несколько подходящих prompt остаются неподтверждёнными.
Для старых run без точного `turnId` сохраняется прежний bounded UUID/hash fallback.

У Claude встроенный async `Agent`/`Task` не является дочерним Terminal MCP-run,
но тоже не разрешает исходной делегации завершиться раньше времени. После
структурно подтверждённого запуска внутреннего исполнителя первый `Stop` Claude
считает только концом промежуточного среза: durable run остаётся активным,
унаследованный loader не исчезает, completion-уведомление и auto-stop не
запускаются. Когда Claude доставляет точный служебный carrier
`<task-notification>` или `<agent-message>`, он продолжает результат исходного
prompt, а не создаёт новый пользовательский ход; итоговый result включает текст
до и после такого carrier.

Связь не выводится из обычного текста или одного `tabId`. Живую внутреннюю работу
доказывают структурные tool-use/result записи той же Claude session, а следующий
служебный ход принимается только для единственного ожидающего run с тем же
provider/session/process owner. Обычный пользовательский prompt и похожий
незакрытый XML-текст не усыновляют ожидание. После restart сохранённый run может
завершиться по transcript только если после его промежуточного `Stop` появился
новый служебный carrier и последний продолженный сегмент имеет конечный
`stop_reason`; старый `end_turn` до carrier недостаточен.

Наличие хотя бы одного assistant-блока не является готовым результатом. Для
Codex нужен `task_complete` или `turn_aborted` того же точного provider-turn, для Claude — конечный `stop_reason`;
до этого `/result` остаётся `ready:false`, run остаётся видимым как проверка
результата и блокирует completion/install. Read-back сначала пинится к точному
UUID target-prompt; текстовый hash используется только для legacy run без UUID,
внутри нижней и верхней временных границ и только при одном совпадении. Финальная
проверка обходит обычный JSONL-кэш: task-complete может дописаться, пока другой
читатель ещё заканчивает старый снимок с тем же размером/mtime. Это сохраняет
контракт «одно уведомление → один fetch» и не требует polling или таймаута.

`get_session_progress` решает другой сценарий: по явному запросу посмотреть, какие структурные операции появились в уже существующей сессии после прошлого просмотра. Клиент возвращает opaque cursor из предыдущего ответа; сервер не хранит watermark и не решает за агента, что уже прочитано. Если Rewind/fork заменил ветку и cursor больше не принадлежит текущей истории, ответ явно помечает reset вместо молчаливого пропуска. Этот метод не является completion-gate: готовность по-прежнему определяется `busy/status`, а progress не возвращает полные аргументы и результаты инструментов.

`complete_task` — self-only сигнал остановки Prompt Queue Loop, а не общая церемония завершения, команда остановки процесса или результат оркестрации. Метод не принимает target: parent берётся из `NOTED_PARENT_TAB_ID`. `status` по умолчанию completed; `status:"blocked"` с обязательной конкретной `reason` означает невозможность продолжить без внешнего действия и не объявляет задачу готовой. До blocked POST MCP проверяет `/api/me` → `loopTaskCompletion` version2/statuses: старый backend, который мог бы проигнорировать новое поле, не получает мутацию. Main по-прежнему требует exact текущий Claude/Codex turn, app-owned source=`prompt-loop` и принятый user-prompt с `terminal_task_completion_protocol`; обычный turn и один лишь включённый toggle получают `completion_protocol_not_active`. ACK сохраняет intent, не выключает Loop до natural final того же turn. Тогда публикуется completed либо отдельный blocked outcome с причиной. Идентичный duplicate-call идемпотентен, изменение принятого исхода конфликтует; новый turn/error/interrupt/manual stop/PTY exit инвалидируют intent. Blocked требует объяснить пользователю остаток и нужное действие, не просто назвать задачу выполненной.

Исходящий orchestration-run той же вкладки блокирует допустимый Loop-вызов `complete_task`, пока идёт работа исполнителя, доказательство полного результата или completion-handoff в source; recovery и ошибка доставки также остаются блокерами решения, хотя не изображаются активным shimmer. После доказанного начала отдельного follow-up хода смысловая обработка уже полученного результата принадлежит агенту и Loop-инструкции, а не выводится сервером из текста. Эта граница не обходится `waitForDescendants:false`, потому что тот параметр управляет отчётом конкретного durable run, а не готовностью всей текущей задачи. Точный успешный outcome выключает Loop до reconciliation, не удаляя обычные queued prompts.

`/terminal/ai-prompt` с `submit=true` для Claude **и Codex** не пишет в PTY напрямую: main пересылает запрос в renderer scenario layer (`sendAgentPromptScenario`) — тот же путь, что History Enter / Project API / Inbox. Это даёт MCP-отправке готовность/queue/audit-проверки и статус-паритет: `submitted_unverified` возвращается как HTTP 202 (доставлено в TUI, durable-подтверждение ещё не пришло), а не теряется. Прямой `safePasteAndSubmit` остался только для paste-без-submit (`submit=false`) и Gemini, у которого нет scenario runtime. Следствие: если renderer недоступен (окно перезагружается), Claude/Codex submit вернёт ошибку bridge, а не молча вставит байты в PTY.

### Одна квитанция для Project API, Inbox, Terminal MCP и orchestration

Если нижний слой вернул `submitted:false`, Enter не пересечён: HTTP 409 разрешает
осмысленный retry. Если `submitted:true`, но exact JSONL/rollout audit ещё не
пришёл, ответ — HTTP 202 `audit-pending` с исходным `handoffId`; Terminal MCP
объясняет, что повторять prompt нельзя. Только exact audit того же handoff даёт
HTTP 200 `sent`. Target-run и completion notification сохраняют этот handoff до
поздней сверки; транспортный callback не может откатить уже найденный exact
proof, а Retry в `audit-pending` не выполняет второй physical send. Inbox
привязывает поздний audit ещё и к provider/session/prompt hash, поэтому
одинаковый текст соседней операции не является подтверждением.

Явный `submitted:false` из подготовки, которая ещё не вызвала beginAttempt и
renderer bridge, также сохраняется на той же durable receipt как not-submitted
с paste/Enter=false и attemptId=null. Иначе ответ HTTP409 расходился с поздним
GET preparing/delivery-unknown (warm local compact4875,04.10). Это attestation
исполняющей ветки, не вывод из null attemptId: старые unresolved записи не
backfill. Local Codex slash с unpublished writer проходит только к прежнему
Main proof при exact physical launch pin, не получает writer из read/saved SID.

Диагностический пакет фиксирует состояние на момент таймаута; асинхронное
сохранение файла может закончиться уже после exact audit. Перед отправкой
уведомления main перечитывает квитанцию по тем же operation/attempt/tab/handoff
и provider. Если она уже confirmed, уведомление показывает «Отправка
подтверждена. Диагностика задержки сохранена» в информационном цвете. Сам
пакет и Copy остаются доступны; его прежний delivery-unknown не выдаётся за
текущее состояние. В reference отдельно пишутся статус и время проверки перед
уведомлением. При ещё неизвестной доставке заголовок описывает произошедшую
задержку. Это не меняет сроки audit, статус доставки и разрешение повторного Enter.

Codex caller deadline остаётся8s после физического Enter. После него та же
живая попытка теперь возвращает `success:null, submitted:true, auditPending:true`
и HTTP202, сохраняя `CONFIRMING` в History и ожидание оркестрации. Само истечение
времени не переводит receipt в `delivery-unknown`. Информационный пакет задержки
сохраняется отдельно от настоящего incident потери доказательств; его заголовок
описывает прошлую задержку и не притворяется текущим статусом карточки. Late
exact/native-queue proof, пришедший во время Copy-проверки, выигрывает у старого
timeout-result. Смена terminal/run/lifecycle или выход процесса даёт unknown
с `codex_confirmation_scope_lost`; отсутствие ответа renderer-моста и ошибки
чтения по-прежнему не считаются успехом. Replay pending-operation не пишет
новые paste/Enter. Пустой input не заменяет exact JSONL для финального `sent`.

Есть отдельный конечный исход после физического Enter: Claude уже получил
paste и Enter, но не создал provider-turn, а точная повторная проверка после
остановки loader нашла в composer исходный текст без изменений и не нашла новой
user-записи после сохранённой transcript-границы. Такая квитанция называется
`provider-not-accepted`: она сохраняет `submitted:true`, потому что Enter уже
пересёк транспорт, но возвращается как явная HTTP 409 / Terminal MCP error и
сразу завершает orchestration ошибкой без recovery grace. Исходный draft не
очищается, тот же handoff не отправляется повторно, а поздний generic audit не
может повысить эту конечную квитанцию до success. Claude может сам заменить
отдельные строки с существующими абсолютными путями изображений на `[Image #N]`
ещё внутри composer. Это тоже является точным отрицательным proof только когда
после удаления этих известных строк и созданных Claude-маркеров весь остальной
текст совпадает побайтно, количества совпадают и каждый image ref успешно
материализован. Лишнее/потерянное изображение, изменённый или смешанный draft,
несинхронный снимок и любая неоднозначность остаются `audit-pending`, а не
превращаются в этот исход.

Для разбора неподтверждённого Claude Enter main удерживает ограниченную
причинную трассу только в памяти: изменения composer, PTY-байты между
зафиксированными кадрами и точные границы paste/Enter/Ctrl+G. Обычная успешная
отправка не создаёт файл. Если после остановки авторитетного хода повторная
проверка всё ещё даёт `provider-not-accepted` или неоднозначный post-Enter
исход, в каталоге логов атомарно сохраняется приватный (`0600`) файл
`terminal-send-forensics-claude-<tab>-<timestamp>-<attempt>.json`. Он привязан
к конкретной физической попытке и поколению процесса, поэтому одновременные
handoff не перезаписывают друг друга. Если точный user-turn материализуется
позже, файл этой попытки удаляется; трасса не является доказательством доставки
и не разрешает повторный Enter. Теги журнала: `[ClaudePostEnterForensics]`.

#### Main FIFO принятых Send

Обычные программные Send Claude/Codex принимаются без фиксированного лимита
количества сообщений в backlog приложения. Main `AgentSendQueue` сохраняет
snapshot запроса в SQLite `agent_send_queue`, связывая его с прежней
`agent_send_receipts` по operationKey/handoffId. Текст, authoring chips и image
refs фиксируются при приёме; дальнейший input их не меняет. Очередь не зависит
от смонтированной History. Ошибка сохранения не является ACK.

Подготовка принятого Codex Send имеет один Main-issued срок 60s: начало — вход
в ACTIVE HEAD executor до `prepareSend`, не enqueue/FIFO wait. Чтения/wakes,
settings и возврат PTY lock срок не обновляют; cold использует минимум этого
срока и original startup deadline. Незавершённый кадр сохраняет тот же H/O/A,
frozen assets и reservation; continuation ждёт вне PTY/global settings queues,
после возврата lock повторяет current proof. Готовый кадр отправляет сразу,
streaming сам не запрещает steering. Stop/manual/owner/settings/expiry отзывают
будущий ввод; possible Enter сохраняет прежние audit/unknown barriers.
Если внутри этого Send нужен `/model`, тот же срок проходит через picker до
exact owned echo; ни его прежние2500ms, ни reader меню не создают ранний lifetime.
Наблюдение освобождает обе очереди, затем продолжаются оставшиеся стадии той же
операции под свежими owners, без повторной вставки или нового H/O/A. Settings
publication и сам prompt требуют окончательного proof, не deferred descriptor.
В публичном draft IPC отказ подготовки передаётся отдельно от неизвестного
кадра: final owner re-decoration не должна стирать точную отмену/expiry.
Новый warm HEAD не заимствует сохранённый startup clock предыдущего запуска,
даже если тот ещё не истёк или payload оставлен для late-MCP recovery. Ранее
начатый cold caller несёт точный Main-issued launch ID/receipt и сохраняет свой
минимальный срок после ready; наличие прежней receipt само не делает новый Send cold.
Публичные event/snapshot projections тоже снимают `startupWait` у initialized
текущего lifecycle, даже если input позже закрыт picker-ом. Старый ID не должен
вновь попадать в новый warm Send через renderer; фактический readiness независим.
Успешная служебная `/fast` будит тот же ожидающий Send, чтобы поздний blocked
presence reply не оставил его до expiry. Это только recheck, без нового срока,
права вставки или replay; механизм — `fact-codex.md`.

Bridge привязан к исходным WebContents/frame. Автоматический renderer loss
отзывает future input, но сам не освобождает possible-Enter slot как явная
пользовательская отмена: нужны прежние fresh absent/new-ready-owner proofs.
Узкий SQLite BUSY/LOCKED ДО executor и ДО attempt паркует уже committed item с
тем же executor до существующего runtime wake; не пишет failed под тем же lock,
не теряет request и не раскручивает self-pump. Начатые/unknown attempts не retry.

Pre-beginAttempt проверка адресата не должна смешивать раннюю event projection
с поздним process proof: нормальная adoption первого cold Send иначе превращала
следующий item в runtime_snapshot_unstable. Public Codex reader обновляет projection
после process await под прежним owner/input/Stop fence. Сам FIFO и exact target
не меняются; эта коррекция не разрешает повторить уже failed/unknown сообщение.

Saved JSONL Rewind/Delete временно удерживает новые Send в этом же FIFO, включая
ordinary/tab-message: процесс останавливается, а затем меняется сохранённая ветка.
Один renderer activity-флаг или mutex только вокруг binding оставляли окно для
чужого Resume источника между Stop и принятием копии. Main reservation берётся
до первого await; тот же waiting item остаётся без attempt до завершения mutation
и свежего input-ready proof. Launch-written не открывает очередь. Busy-ready
разрешает steering; proven absent/inactive сохраняет обычный auto-start. После
освобождения проверяется исходный адрес Send, без переноса в child. После restart
сохраняется только пассивное удержание, не старый токен/право писать или replay
unknown Send. Это SOURCE-контракт; физическая установленная приёмка15.10 открыта.

Run After входит в этот же FIFO с отдельным automatic admission: согласие Root
сверяется с coherent Main runtime и для Codex с текущим завершённым headless
кадром. Resume может быть input-ready во время перерисовки старой переписки:
такой кадр паркует исходный item до attempt, а flush только будит повторный
допуск. Это не новый executor и не право повторить неизвестный Send; обычная
ручная отправка во время streaming этим idle/frame gate не ограничивается.
Подробнее — `fact-prompt-queue.md`, тонкости Resume input-ready.

Desktop History может явно объединить две соседние ручные `IN APP QUEUE`
карточки через ↑ у нижней, только пока обе `waiting`, без physical attempt,
с одинаковыми destination/settings. Main повторно проверяет эти условия после
подготовки и внутри SQLite transaction. Новый snapshot имеет новый operationKey
и текст `первое + "\n\n" + второе`, прежнюю FIFO-позицию/время первой карточки;
original JSON/fingerprints не переписываются. Их no-input receipts становятся
`not-submitted/merged`, а durable supersession markers запрещают оживить старые
IDs даже после receipt-prune. Owned assets/occurrences и deferred-context IDs
переходят новому handoff через прежних владельцев в том же commit; chips/images
не flatten'ятся и одинаковые тексты сохраняются дважды. Исполняет прежний Send.
Dispatch/cancel/смена owner/settings во время подготовки дают no-write отказ,
обе исходные отправки сохраняются. Потерянный ACK проверяется exact requestId
через read-only getter; новый merge/Enter не создаётся. Native `QUEUED`, unknown,
Run After/MCP/orchestration/service messages не являются кандидатами. Контрол
появляется только с Main-produced `applicationQueue.mergePrevious.version=1`;
это additive desktop IPC, не новая публичная Send/RunAfter capability.
SOURCE07.10 проверен real SQLite/actual IPC и private Electron UI, не installed
или provider acceptance. Checked evidence: `/private/tmp/noted-queued-merge-20261007.cRlqbz/RESULT.md`.

В каждый момент только head входит в прежний общий readiness/settings/draft/
PTY scenario. Native acceptance (`QUEUED`) остаётся промежуточной границей:
следующий item получает ход после exact canonical audit предыдущего, даже
если ответ ещё streaming. Generic success, очередь TUI, timeout, чужой audit и
потеря ответа сами не освобождают slot того же физического input. Доказанный отказ завершает свою попытку без
повторного Enter, но не отменяет проверки чужого composer у следующей.
Повтор handoff читает прежнюю операцию; другой payload с тем же ID — конфликт,
одинаковый текст с разными ID — разные items.

`ENTER_ARMED` монотонен и внутри `settleAttempt`, не только в `markAttemptState`:
same-attempt поздний `submitted:false` от readiness/cancellation не переписывает
durable arm в `NOT_SUBMITTED` и не освобождает FIFO. Остаётся тот же auditable
attempt; exact canonical audit может завершить его позже. Отдельный доказанный
`PROVIDER_NOT_ACCEPTED` после физического Enter сохраняет прежний контракт, как и
реальный pre-arm no-input отказ. Контроли15.10 исполняют actual registry/store/
SQLite/FIFO; ошибки или отсутствие native-provider проверки не заменяют receipt.

Delivery evidence, отмена намерения и право держать input — разные оси. Main
сохраняет exact physical lease при durable Enter-arm. После окончания текущего
executor отменённое пользователем намерение, успешный process lookup `absent`
либо доказанный новый ready owner снимают только старый slot. Перед commit
сверяются тот же head/attempt, generation/run/input revision и current owner.
Ошибка lookup — unknown; idle/пустой composer того же живого owner не достаточны.
Старый payload/attempt/submitted/audit не переписывается, старый Enter не повторяется;
следующий исходный snapshot проходит прежний общий Send. Runtime-события будят
один coalesced read, не polling; same-live-owner fast path не читает History.
SDK не получает выдуманный PTY-proof. Cancel и canonical receipt действуют через
общих владельцев, а автоматический physical-owner retirement ограничен PTY.

`deliveryControl` хранится отдельно от изменяемой квитанции; компактный marker
отменённого operation ID переживает receipt-prune, без повторного prompt body.
Pre-write guard читает durable отмену даже после потери process-local callback.
Старый attempt ID проверяется ДО waiting-cancel, иначе поздний Stop отменяет
уже новую ожидающую попытку. `inputSlot:{version:1,state:'retired'}`/legacy
`applicationQueue.state:'released-unknown'` — disposition, не delivery result.
Историческое `providerQueueAccepted` не проецируется в текущий `QUEUED` после
retirement/cancel; эти поля проходят и live packet, и list/remount/HTTP.
Поздний exact audit всё ещё может подтвердить старую доставку и закрыть её asset
ownership, но не возобновляет отменённое намерение. Unknown bytes удерживаются.
Шрам507: старый скрытый MCP head пережил restart, держал новые sends, а после
ручного release снова появился как QUEUED без нового Enter. Одного скрытия
или фикса busy недостаточно; источник ошибки — смешение этих осей.

Completion caller резервирует stable `history:<sourceTabId>:orchestration-complete:<runId>`
до первого входа в FIFO/renderer. Вход без operationKey регистрировался в memory,
затем новый renderer повторно enqueue-ил того же caller и конфликтовал по fingerprint;
просто уравнять хэш означало бы риск self-join. Guard сохранён, callback audit
переносит точные operationKey/attemptId. Явно скрытые старые completions не оживляются.
Completion больше не сравнивает pinned SID с ранним null snapshot до общего
Send. Исходный pin сохраняется до прежнего provisional/final proof; другой
запуск или подтверждённый чужой SID по-прежнему запрещают физическую отправку.

Это не Run After: его future conditions и natural-turn completion прежние.
Независимая orchestration по-прежнему требует idle/new turn; после ожидания
Main повторно использует её существующий admission policy и lifecycle wake,
не превращая делегацию в steering. Raw TUI-ввод не перехватывается/не лимитируется.
Standalone slash и record-without-reply остаются в своих доказательных flows.

Waiting item можно отменить до начала attempt; race с dispatch не объявляется
доказательством отсутствия прошлой отправки. Desktop History ↩ имеет более точную
pre-input границу: отдельный Main fence упорядочивает возврат с первым payload
write, не с запуском CLI или назначением attempt. Он отзывает только выбранный H;
уже начатый launch продолжает работать, будущий payload отозванного H запрещён.
Непереданный waiting item убирается прежним queue owner; активный executor сам
заканчивает no-input путь. После possible-write возврат disabled, unknown barriers
и native очередь не отменяются. Frozen authoring передаётся в composer до release
старых asset pins, по durable adoption exact return token. Это не публичный Stop,
не hide и не разрешение replay; см. `fact-история-как-основная-поверхность.md`.
Явный process Stop/закрытие вкладки снимает принятый backlog и
отзывает текущую подготовку через прежний cancellation registry. Interrupt
по-прежнему относится к текущему turn и не превращается в process Stop.
Непереданные failed/cancelled snapshots не пропадают по15s UI-таймеру или общей
receipt-retention: остаются pinned до явного скрытия либо durable composer adoption
при возврате, image asset IDs входят в
прежний GC inventory. Зависимые cold items удерживают exact proof начального
provider writer, а не подставляют текущий SID в момент исполнения.

SOURCE11.10: ранний native process Stop расширяет прежний `/stop` через
`sendIntentCancellation` v1. `pendingSends` содержит immutable project
operationKey/handoffId/provider; отсутствующий attempt выбирает Main из того же
handoff, явно переданный attempt обязан совпасть. Весь список проверяется ДО
tab-wide cancellation; ошибочный tuple не отменяет соседей. Marker создаётся
даже до первой HTTP admission и переживает потерю receipt, но тогда прошлый
Enter остаётся unknown. Это не remote process-owner CAS: process Stop по-прежнему
tab-scoped. Пустой legacy запрос сохраняет прежний контракт.

Ответ разделяет `processStop.stopped` и `sendCancellation.complete/results`;
сбой сохранения cancellation после остановки процесса возвращает non-2xx с
обоими фактами. Native обязан прочитать тело и не повторять POST автоматически.
Late ACK, memory replay и canonical audit не снимают durable отмену; positive
audit может уточнить прошлую доставку, но не оживить этот handoff. Проверка у
launch и непосредственно перед PTY write читает прежний receipt owner; один
ошибочный launch invocation не может выдумать отрицательную Send-квитанцию.

SOURCE15.10: новая физическая попытка до bridge получает Main-issued
`preflightScope` в прежнем receipt JSON. Если тот же common Send завершился
в `ensuring-ready` с exact `no-launch/launchWritten:false`, renderer передаёт
отдельное свидетельство, не меняя исторический unknown самостоятельно. Store
сверяет scope/operation/attempt/tab/handoff/provider и отсутствие provider-boundary,
только затем сохраняет `not-submitted`. Нет scope, потерян launch ACK, другой
attempt, уже начатый provider input или старый settled unknown сохраняют прежнюю
неопределённость. Cancel не снимается; canonical audit имеет приоритет. Исключение
после beginAttempt, но до вызова bridge, также завершается на той же попытке;
ошибка вычисления payload не является таймаутом уже отправленного IPC.

Standalone Start/Resume использует существующую terminal-instance/Stop revision,
захваченную до async подготовки/очереди. Native `/start` и `/resume` передают её
через bridge; это launch fence, не новый Send. Записанная shell-команда — уже
иная граница: отсутствие AI-child не равно её отмене. Shell owner хранит witness
до парных command start/finish либо подтверждённого process Stop; текущий Stop
ждёт структурные события через bounded observation. Deadline сообщает unknown,
не success и не разрешение повторить ввод. Полностью задержанный первый HTTP
Start, ещё не виденный Main до Stop, не имеет immutable launch ID и этим fence
не покрыт. Source review не является compile/runtime acceptance; поставка и
проверки остаются отдельным этапом в рабочем плане AI-состояний.

Очередь сама не читает/копирует bytes: inventory содержит только materialized
managed assets. SOURCE05.10 добавляет импорт подтверждённых mobile image/document
uploads прежним asset owner ДО freeze/enqueue; snapshot хранит original sourcePath,
ordered occurrences и scoped transport proof. Waiting/unknown/failed bytes и exact
source→asset mapping переживают restart/DELETE original; metadata-only legacy записи
не мигрируются. Нужны отдельные `sendQueue.attachmentOwnership` capability и
`attachmentOwnership.durable:true` exact receipt, не один общий durable ACK.
Произвольный authored path/GT ссылка не импортируются. Same-ID replay читает старый
snapshot до temp/context read; original body не меняется, unknown не replay'ит Enter.
Контракт и source/installed граница — `fact-mobile-web.md::Mobile upload attachments`.

После restart сначала reconcile прежних receipts, затем подключение App bridge
разрешает dispatch. Waiting без physical attempt продолжает прежний snapshot;
entered/unknown не повторяет отправку; его slot переоценивается отдельно по
описанному Main physical-owner proof, не по отрицательному audit. Закрытие одной
renderer-поверхности не отзывает готовность другого живого App renderer.
Уже существовавшие legacy unknown receipts не переписываются этой миграцией.

Conservative restart conversion коммитится синхронно до async transcript refinement.
Ошибка последнего (например SQLite BUSY) оставляет точные possible-Enter/unknown
heads и их followers под прежними barriers, но не закрывает независимые FIFO
всех вкладок навсегда. Main завершает этот refinement как degraded-ready, не как
неограниченное ожидание; failed storage admission по-прежнему не получает ACK.
Шрам17Oct19:51UTC: `ready:false` в catch удержал History/Terminal MCP доставки
глобально; actual Main/Web+две SQLite connections/FIFO regression RED→GREEN.

#### Адресный Повтор Audit Квитанции

После restart старый provider-owned receipt может остаться delivery-unknown даже
после освобождения slot для нового процесса. GET send-receipts лишь читает сохранённое
startup-решение; он не запускает новый scan. Ожидающий follower нельзя оживлять
новым Send, скрытием head или fake not-submitted. Поздний точный transcript-proof
можно отдельно сверить существующим аудитором через Application API:
`POST /api/terminal-tabs/:tabId/send-receipts/reconcile`, тело
`{operationKey,attemptId}`. Требуется app capability
`sendQueue.receiptReconciliation.version=1`; первичный endpoint поддерживает Codex.
MCP `get_send_receipt` остаётся read-only, без нового implicit reconcile/retry.
Адресный POST доступен также как `reconcile_send_receipt({tabId,operationKey,attemptId})`.

SOURCE15.10: explicit read допускает также active `in-flight`/`enter-armed`.
Первый немедленно возвращает `unknown/enter-not-recorded` без scanner/claim/release;
одной pre-Enter boundary недостаточно даже при matching ручной записи. Для
`enter-armed` прежний bounded Codex scanner может подтвердить уже записанный Enter
до renderer ACK. Перед публикацией повторно сверяются transport/attachment
projection и source boundary. Default startup и Claude eligibility не расширены.

API не принимает текст, SID, файл или готовый audit от caller. Main берёт exact
receipt, участвует в прежнем tab-wide audit single-flight, передаёт scanner все
конкурирующие physical boundaries и после await повторно проверяет attempt и
immutable source identity. Глобальные audit references берутся из того же store
без prompt/attachment bodies: подтверждение другого tab того же source не может
стать подтверждением выбранного head. Only found proof проходит прежний
publishAgentPromptAuditResult/promoteFromAudit CAS. Тот же canonical row не
присваивается второй Codex операции. Already confirmed читается идемпотентно.
SOURCE06.10 переносит запрет в общую transactional promotion-границу, включая
startup и live, а не только этот POST. Claim содержит UUID/source aliases
парных response/event carriers; metadata сохраняется и после receipt-prune.
Ранний адрес может уточниться до canonical, но поздний дубликат не понижает его.
Исторические competing owners не назначаются произвольно одному отправителю.

Live audit переносит всю canonical identity event carrier, включая его физический
offset/timestamp, даже при event→response порядке. Causal admission сравнивает
boundary с первым carrier пары, в том числе не принадлежащим app receipt; поздний
companion ручного сообщения не становится новым Send proof. Scanner отдельно восстанавливает
структурный pairing context перед нижней границей attempt; late companion с
первым carrier до неё не становится новым user proof. Context читается на том же
FD, до terminal reset/предыдущего task_started, с повторной проверкой файла;
assistant/tool bodies и image data URLs не сохраняются в metadata-кандидатах.
Первый task_started допускает ранний response→event, повторный start разделяет
turns; event до start не связывается с новым response после start. Presentation
сохраняется только после принятой common promotion, до публикации её проекции.

Ответ содержит `reconciliation` отдельно от прежнего `receipt`. `ok:true` здесь
означает успешное proof-read, не успех доставки. Absent/unknown не записываются
как not-submitted/provider-not-accepted и не освобождают FIFO. Ошибка публикации
после durable promotion не отменяет уже принятую квитанцию. Этот POST сам не
пишет в терминал, но exact promotion естественно будит прежний FIFO: только
исходный waiting snapshot проходит прежние idle/readiness/target guards.
Следующий run считается запущенным лишь после его собственного delivery proof.

Новый HTTP ingress требует установленной app-сборки; одно обновление MCP его
не добавляет. Повторный отрицательный proof сам не разрешает abandon.

#### Явное Продолжение После Unknown Head

По разрешению пользователя продолжить очередь несмотря на неизвестный исход
одной старой записи существует отдельный `POST .../send-receipts/release`:
`{operationKey,attemptId,requestId,acknowledgeDeliveryUnknown:true}`.
MCP — `release_send_queue_head`; capability `sendQueue.explicitUnknownRelease.version=1`.
Сначала прежний exact audit. Положительный proof завершает head обычным образом;
иначе только exact текущий awaiting-receipt head получает `released-unknown`
и durable release-marker. Delivery/submitted/frozen payload и доказательства
остаются прежними; новый Enter этой записи запрещён. Это не no-write settlement.
Нет глобального автоматического skip. Running executor, foreign attempt/owner
и другой requestId отказывают; same-ID replay после restart не повторяет audit/input.
Следующий сохранённый item проходит прежний idle/target/readiness допуск.
Cancelled follower не оживляется. GET старого handoff показывает release отдельно
от доставки; позднее настоящее подтверждение старой записи остаётся возможным.

Ранний ACK — opt-in `POST /api/terminal-tabs/:tabId/send` с
`applicationQueue:true`. Capability `sendQueue.version=1`, `durable:true`,
`providerPendingLimit:1`, `optIn:'applicationQueue'`. HTTP202 возвращает
`status:'application-queued', applicationQueued:true, accepted:true,
submitted:false, pasteWritten:false, enterWritten:false,
providerQueueAccepted:false, exactAuditConfirmed:false`, прежние tab/handoff/
operationKey, `attemptId:null` и `applicationQueue:{version:1,id,state,queuedAt}`.
`state` здесь waiting/dispatching до начала physical attempt; это подтверждение
сохранения на Mac, не чтения провайдером. Same-ID send-receipts GET сохраняет это
различие. Без opt-in POST ждёт прежний результат provider-сценария. Native/MCP
могут подключать раннюю галочку только по этому typed contract, не по одному
`accepted:true`. Desktop использует тот же Main adapter через `agent:enqueue-prompt`.

#### Принятие в очередь Codex и сохранение user_message

У занятого Codex точная новая карточка `Messages to be submitted after next tool call`
подтверждает принятие конкретной попытки в очередь (`queued`), но ещё не сохранение
сообщения в History. Проверяются та же попытка/процесс, кадр после Enter, выросшее
число matching prompt и точный текст с допустимой канонизацией изображений:
похожая старая карточка или один tool-result доказательством не являются.
Только соответствующий этой попытке rollout `event_msg.user_message` подтверждает
durable `sent`. Таймаут не понижает уже доказанный `queued` и сам по себе не
разрешает повторную отправку. Потеря ответа API также не доказывает отказ:
клиент сохраняет исходную квитанцию и выясняет её результат, а не создаёт второй Send.
Полный контракт проверки очереди — в [fact-codex.md](./fact-codex.md);
пользовательская проверка — «Edge: отправка во время streaming и JSONL появляется позже»
в [сценариях использования](../methodology/сценарии-использования.md).

#### Квитанция после перезапуска и её показ в History

Обычный `send_prompt` имеет происхождение `terminal-mcp` даже без run/message.
History и Timeline используют его фиолетовый канал через presentation metadata,
а не строку в тексте. Старое подтверждённое сообщение без этой пометки может
получить её при startup из exact receipt/source/attempt/provider/session/hash,
включая canonical carrier aliases; delivery-unknown и чужие proofs не backfill.
Оформление не меняет receipt state, payload или право на следующий Enter.

Обычная отправка из desktop History является ещё одним caller-ом той же
квитанции, а не отдельным renderer-only исключением. Когда операция достигает
головы общей PTY-очереди, main сначала сохраняет в SQLite точные `handoffId`,
номер физической попытки и ключ операции, и только затем может пересечь Enter.
Строка `SENDING/CONFIRMING` в History — лишь быстрая проекция этой квитанции.
Поздний audit может завершить только ту же попытку; audit попытки A не закрывает
повтор B даже при одинаковом тексте и `handoffId`. При закрытии и повторном
открытии History renderer сверяет только ограниченный локальный список строк с
актуальным снимком квитанций: отсутствие строки в UI не считается удалением, а
подтверждённая/отменённая операция не может воскреснуть как `SENDING`.

При restart main сначала ограниченно читает только точный transcript-диапазон
после сохранённой pre-Enter границы и лишь затем разрешает History, Project API
и Inbox восстановить квитанции. Один exact post-boundary turn переводит запись
в `confirmed`; отсутствие записи и неоднозначность не дают права на второй
Enter. Тот же контракт используют обычные Prompt Queue и Loop: Queue связывает
операцию с долговечным item ID, Loop — с item ID и конкретным причинным outcome,
поэтому renderer restart не повторяет уже возможную отправку. Slash-команды
очереди пока намеренно исключены: обычный `user_message` не доказывает
завершение локальной команды, для них нужен отдельный command-specific receipt.

При renderer remount сохранённая квитанция публикуется одной конечной записью:
`audit-pending` становится `CONFIRMING`, а `confirmed` становится `SENT` только
пока точная каноническая user-строка ещё не показана History. Hydration не
создаёт промежуточный `SENDING`, который успел бы попасть в локальный cache и
пережить уже подтверждённую отправку.

Для addressed message с доказанным отказом до ввода Main может вновь опубликовать
ту же запись как application waiting по своему message-owner wake. History принимает
это только при exact lastNoWriteAttemptId и общем isTabMessageNoInputReceipt,
не по цвету/ошибке/idle. Старый negative attempt остаётся прежним; только executor
begin вводит следующую физическую попытку. Hydration A не откатывает B, а sent,
cancelled и provider-queue proof не превращаются в waiting. Подробности recovery —
`fact-tab-messages.md::Доставка и восстановление`.

Image refs той же local карточки также восстанавливаются после exact attempt
binding, включая live FIFO receipt, не только mount-list. Read-only proof не
меняет receipt/status и не заимствует пути из похожей canonical строки;
canonical image preview сам по себе не проверяет local queued/SENT путь.

Подтверждение доставки и завершение временного показа — разные долговечные
факты. Exact audit сохраняет Claude `entryUuid` либо Codex `sourceIdentity` и
каноническое ISO-время. Когда History находит именно эту строку, main принимает
presentation ACK только для той же operation/attempt/surface/tab/handoff,
provider, audit-session и exact row identity; совпадение текста или времени не
достаточно. ACK записывается в ту же SQLite-строку квитанции и сбрасывается при
новой физической попытке. После ACK remount не создаёт локальный `SENT`, но всё
ещё может очистить его старую renderer-копию. На холодном owner подтверждённая
квитанция ждёт первого чтения канонической History, чтобы не появиться в хвосте
на один кадр перед уже сохранённым ответом. ACK failure не скрывает
каноническую строку; следующий remount повторяет exact reconciliation.

Ручное скрытие локальной карточки — не этот canonical ACK и не текущая ↩.
Durable admission
может завершиться `not-submitted` ещё до создания physical attempt (например,
ранний requestFingerprint conflict). Поэтому hide принимает явный `attemptId:null`
как точную отсутствующую попытку вместе с operation/tab/handoff, но не как wildcard:
смена на настоящий attempt отклоняет старую identity; пустое/пропущенное поле остаётся
ошибкой. Меняется presentation marker, не delivery, settledAt или исходный prompt.
Ожидать появления attempt у окончательно failed/cancelled карточки бессмысленно;
Main читает существующую квитанцию сразу. Waiting FIFO cancellation остаётся отдельной.
`UNCONFIRMED` имеет отдельный X presentation-only с exact unknown/attempt guard:
сохраняются submitted/UNKNOWN, immutable snapshot, FIFO slot и удержание bytes.
Hide не запускает audit/Send/Stop/release; поздний прежний exact audit остаётся
действительным. Для receiptless локальной карточки положительное Main absence
read разрешает только сохраняющий recovery marker, не новую отрицательную
квитанцию. Не путать это действие с отменой MCP question/reply.

Для native краткая галочка «принято Mac» читает ту же durable квитанцию, не
создаёт второй executor/ACK. Exact audit-pending+submitted, typed provider queue
acceptance и confirmed имеют разные силы доказательства; accepted:true/unknown
сам по себе не разрешает галочку или Retry. Ранний pre-submission ACK теперь
есть только у typed Main FIFO opt-in выше; это не provider ACK. Phone close
отличается от Mac restart; полный read-only
контракт и second-click Stop предел —
`fact-mobile-web.md::Durable Mac acceptance и единый header Stop`.

#### Когда повтор разрешён, а когда нужно ждать

`submitted:false` обязателен не только у физического paste, но и у каждого
раннего отказа scenario layer, случившегося до вызова prompt-runtime: неизвестный
composer, конфликт/неудачный grab и незавершённая настройка Claude. Одних
`success:false`/`ok:false` недостаточно: без явной границы сервер обязан считать,
что Enter мог пересечься, сохраняет `delivery-unknown` и блокирует следующего
predecessor. Точный no-Enter receipt сразу завершает run ошибкой, убирает его из
target/inherited loader и позволяет новому явно созданному run занять ту же
serialization-lane. То же освобождение выполняет точный `provider-not-accepted`,
но он не даёт retry-authority старому handoff: Enter уже был, поэтому продолжение
возможно только новым явным действием после решения сохранённого draft. Ни один
из этих путей не является автоматическим повтором.

Если renderer получил сценарий, но его ответ не вернулся, это отдельное HTTP
202 `delivery-unknown`: Enter мог как пересечься, так и не пересечься. Сервер
сохраняет handoff для позднего exact audit, не делает автоматический replay и не
выдаёт неизвестный исход ни за `submitted:false`, ни за `sent`. Это состояние
одинаково проходит через прямую отправку, Inbox, target-run и completion.

Дедлайн HTTP/renderer-моста не уничтожает точную попытку отправки. Если ответ
сценария пришёл сразу после дедлайна и доказывает `submitted:false`, именно этот
run немедленно получает исходную ошибку вместо вечного `sending` и общей
recovery-паузы. Если ответ не пришёл вообще, после restart попытка остаётся
`delivery-unknown`: повторный Enter не разрешён, а исход может уточнить только
точный audit. Это различие нужно потому, что транспортный envelope может быть
успешным, хотя вложенный сценарий семантически отказал ещё до submit.

Выбранный агент и модель проверяются как одна пара до резервирования run,
создания/восстановления target и запуска сценария. Известная Codex-модель не
может уйти в Claude и наоборот; сервер не меняет провайдера и не подставляет
другую модель молча. При этом проверка не является закрытым каталогом shipping
моделей: неизвестный custom id остаётся у явно выбранного провайдера и
проверяется его runtime. Один контракт действует для новой и существующей
вкладки, прямого Project API/Inbox, orchestration и Terminal MCP start/send.

Legacy `model` сохраняет прежний контракт для существующих клиентов. Новый
`modelSelection` отделяет два разных намерения: `catalog` принимает только
точный selection id из текущего `/api/agent-models`, `custom` — только явно
названный literal runtime id. Одновременные `model` и `modelSelection`
отклоняются. `/api/me.capabilities.agentModelSelection.version=1` позволяет MCP
остановиться до мутации на старой сборке, а `/api/agent-models/resolve` даёт тот
же server-owned resolver старому start-path.

Для Claude orchestration и Project API сначала разрешают значение по сохранённым
строкам Settings: точный `id` имеет приоритет, а уникальный стабильный `key` или
отображаемый `label` превращается в точный `id`. Если имя подходит нескольким
вариантам, например 200K и 1M одной модели, запрос отклоняется до создания run;
неизвестный custom id по-прежнему передаётся выбранному runtime без закрытого
allowlist. Канонический id входит в fingerprint и delivery intent, поэтому
закрытие вкладки, очередь и restart не возвращают исходный alias. Это важно для
Claude: app-default может успешно установить `claude-opus-5[1m]`, но поздняя
команда `/model opus` переключает уже готовую вкладку на 200K. Поэтому raw alias
нельзя сохранять как per-send override после точного startup-default.

Критическая wiring-граница этого контракта находится до HTTP-классификации.
Общий Claude runtime обязан передать требование дождаться `UserPromptSubmit`
через `terminal:paste` до физического владельца Enter; иначе успешная запись
байта выглядит как точный `200`, хотя audit ещё только поставлен в очередь.
Codex History может смягчить post-Enter timeout для локального интерфейса, но
обязан сохранить `audit-pending` в результате: `success:true` без этой пометки
так же ошибочно превращается во внешний `200`. Серверный тест, который
подменяет renderer готовым receipt, не доказывает эти два живых caller-path.

Per-send Think является таким же writer-ом поля ввода, как prompt. Открытие и
закрытие picker происходит внутри общей PTY-очереди, меняет identity ввода и
считает переход завершённым только после полного синхронизированного кадра из
main-owned headless snapshot. Differential PTY-кусок с первым маркером конца
перерисовки является только wake-up и не доказывает, что в кадре одновременно
есть `Enabled`, `Disabled` и выбранный пункт. После изменения состояние один раз
перечитывается повторным открытием picker и окно доказанно закрывается; только
тогда разрешается свежий composer proof. Поэтому proof, снятый до picker, не
может разрешить последующую отправку, а таймер, часть перерисовки или порядок
нажатых клавиш сами по себе не считаются успехом.

Copy/Grab/Restore через Ctrl+G — также полноценные PTY writer-операции. Весь
external-editor roundtrip занимает общую write-очередь и повышает identity ввода
ровно перед Ctrl+G: capture, вставка prompt и Enter больше не могут физически
пересечься. Main сначала подписывается на возврат TUI и только затем отвечает
helper-у: для Claude завершение доказывает полный synchronized frame, для Codex
— первый PTY-output после выхода helper. Timeout означает unknown/failure, а не
готовность к следующей записи. Exact setting retry/clear и старый clear-input не
имеют отдельного fire-and-forget пути. Если native Rewind уже владеет очередью,
он вызывает внутреннюю границу capture без повторного lock. Перенос задач из
TaskPlan использует main-side compare-and-swap: замена происходит только если
input после точного чтения всё ещё побайтно равен ожидаемому; более новый текст
пользователя остаётся нетронутым. Generic `terminal:paste` сохраняет raw
paste (`submit=false`) и быстрые non-Claude пути, но автоматический Enter в
живой Claude разрешает только полный semantic-send профиль с draft proof,
handoff и ожиданием audit; неоднозначный legacy caller отклоняется до байтов.
Stop, пришедший во время per-send `/model`/`/effort`/Think, проверяется внутри
каждого шага: уже доказанная команда не откатывается, но оставшиеся настройки и
пользовательский prompt больше не выполняются.

Portable image marker является намерением вложить файл только когда внутри указан абсолютный filesystem path. Относительный путь или prose-пример проходит в prompt дословно, не занимает image-slot и не запускает staging; документация с буквальным `[imagePath: example only]` не должна приводить к `codex_image_path_unavailable`. Доступный абсолютный путь сохраняет обычный attachment-flow. Если абсолютный файл исчез между подготовкой и отправкой, это не отменяет весь prompt: marker становится позиционным `imageError`, а окружающий текст и остальные вложения отправляются. В UI известная недоступность показывается постоянным предупреждением до Send; после явного Send повторный отказ всего сообщения уже не является допустимым способом сообщить о ней. Direct plan и preflight replacement обязаны проверять одну и ту же границу абсолютности.

### Таймауты и неизвестный исход отправки

Для tracked SC research deadline/abort охватывает также HTTP body: заголовки200
не завершают запрос. При cancel/detach пока SC status ещё отвечает404 coordinator
проверяет terminal после store initialize и после persistence до первого start.
Это отдельный research transport/admission путь, не terminal PTY timeout и не
объяснение медленного ps. После сетевого start сохраняются same-job reconciliation
и unknown-правила, не новый runId. Подробности — fact-оркестрация-вкладок::Browser-консультация.

Два fail-closed edge этого маршрута. (1) Bridge-timeout (60с) ≠ ошибка доставки: renderer-сценарий может законно жить дольше (launch-if-needed + readiness + paste) и всё ещё доставить prompt — ответ в этом случае HTTP 202 `delivery-unknown` с предупреждением не повторять тот же prompt вслепую; повтор в живую AI-сессию хуже неизвестного статуса (тот же принцип, что completion prompt после rebuild выше). (2) Если renderer ещё не гидрировал workspace store (запрос сразу после старта приложения), сценарий не сваливается в Claude SDK fallback — для MCP-источников это была бы отправка НЕ тем агентом в Codex-вкладку; возвращается явная ошибка «tab not resolved yet, retry after load».

`build_install_noted_terminal` — исключение из обычных terminal-actions: это fire-and-forget
handoff в Voice Record, а не команда в текущей PTY. Использовать его, когда агент внутри
Noted Terminal должен инициировать `npm run build:install` самого Noted Terminal. Tool
передаёт `returnTo` исходного tab/session в Voice Record и сразу возвращает job id. Перед
самой сборкой Voice Record ждёт, пока все соседние сессии (вкладки/проекты с живым turn'ом
или running-процессом) уйдут в idle — **вызвавшую вкладку исключает**, иначе дедлок; прогресс
в `job.phase`/`job.wait` (см. `fact-build-when-idle.md::Observe-фаза`). После рестарта callback
в Voice Record ждёт восстановления именно этой вкладки/сессии и сам
отправляет completion prompt через `/terminal/ai-prompt`. Нельзя заменять это на
`run_command("npm run build:install")` или чтение terminal output: управляющая вкладка будет
убита install-процессом, а readiness после рестарта определяется через MCP `/terminal/tabs`,
не через таймаут.

SOURCE20.10 штатный внешний installer отдельно включает/завершает same-ID
operational maintenance (`orchestrationMaintenance.version:1`). Это не prompt
соседним вкладкам и не обход idle: временные research incidents остаются в UI,
FULL results продолжают доставляться. Для планового обновления SC есть операторская
команда `scripts/research-maintenance.cjs begin|complete <operationId>` через live
Noted API; без capability нельзя выдавать Source/CLI наличие за действующий режим.
Подробности — fact-build-when-idle::Плановый install без служебных research-промптов.

#### Completion prompt после rebuild — одноразовая доставка.

Если Voice Record уже нашёл
исходную tab/session и `/terminal/ai-prompt` начал handoff, дальнейший `submitted_unverified`
или timeout не является разрешением повторить тот же prompt: целевая Codex/Claude TUI могла
уже получить ввод, а доказательство могло сорваться на audit/readiness edge. Повтор здесь хуже
ошибки статуса — пользователь получает несколько одинаковых команд в живой AI-сессии.

### Граница live-действий и истории

Единый namespace не отменяет внутреннюю границу: live-действия идут через scenario
layer, чтение/редактирование прошлого — через history backend. Нельзя реализовать
обычную отправку/orchestration записью prompt в Codex JSONL вместо CLI.
`search_user_messages/get_user_messages` дают фильтрованные сообщения и пакетное
чтение их exact refs; даты означают время сообщений. Saved-prompt wrapper,
context update и plain text не взаимозаменяемы; metadata-only диагноз включается
через session_stats.diagnosticsOnly. Контракт страниц/покрытия и примеры границ —
fact-session-history.md::Фильтрованные пользовательские сообщения.
Явный saved-history Rewind/Delete — другой контракт: Stop → copy-on-write →
adopt → Resume; его tab HTTP-вход описан в fact-mobile-web.md. Terminal MCP
предоставляет только saved-history `rewind_history`, не native Esc/menu и не
AI-summary Rewind. Пользовательский native UI и прежний `/rewind` HTTP-вход
сохраняются отдельно. MCP не становится универсальным редактором provider-файлов.

#### Saved-history Rewind через MCP

`rewind_history` отправляет ровно один existing
`POST /api/terminal-tabs/:tabId/history-operations` с `kind:rewind`.
Обязательны `tabId`, `operationId`, `expectedSessionId`, `targetUuid`;
`toolType` по умолчанию Codex, также поддерживается Claude. `operationId`
выбирает вызывающая модель до MCP-вызова: потеря всего MCP ACK/process не должна
стирать единственный ключ восстановления. ID допускает1..160символов
`[A-Za-z0-9_.:-]`. Same ID+same request идемпотентны на existing app receipt;
изменённый запрос с этим ID отвергается. Неизвестный исход читается, не replay.

Передавать `targetSourceIdentity`, когда она есть. Composite требует exact
`targetEntryRef`/`expectedContentRevision` из публичной Timeline, не сырые offsets
или номер MCP turn. Claude всегда требует revision. Для standalone Codex token
optional, но переданный stale token не удаляется ради обхода guard. Nullable
metadata публичной entryRef сохраняется; SID/UUID и обязательная composite revision
не становятся optional. Nested `entryRef.contentRevision` допускается unchanged
только при равенстве внешней expectedContentRevision; это проверяет также общий
Main normalizer прямого HTTP POST, не только MCP whitelist. Capability проверяется через `/api/me`: savedHistory v1,
rewind/providers/receipts/structuredDraft; неподдерживаемое приложение получает
app-update-required до POST, без native/raw-file fallback.
Новый Codex Rewind дополнительно требует `savedHistory.codexPhysicalSuffix:true`:
последняя Timeline UUID не является EOF, после compact возможен неадресуемый
assistant/tool хвост. Executor удаляет весь physical suffix выбранной итерации;
generic Delete/Edit середины сохраняет прежнюю семантику. Старые receipts
читаются и без этого флага, но не получают выдуманный clean-prefix proof.

`repairOfOperationId` адресует только старый completed Codex COW Rewind с
historyMutated/bindingCommitted и exact текущим child. Новый operationId хранит
отдельную квитанцию; targetUuid берётся из прежней, а не ищется в child по тексту.
App сверяет current child с exact прежним COW output и неизменный original target,
повторяет proof после Stop/перед записью, затем использует тот же executor.
Новая пользовательская работа в child запрещает repair; исходник, старый child
и receipt не перезаписываются. Нужна `savedHistory.repairOfOperationId:true`.
Служебный `thread_settings_applied` после Resume не становится новой работой
только по своему type. Допуск основан на exact child/COW-префиксе и записанном
owned Resume, полном settings-пакете той же пары model/effort и отсутствии
чужого SID/cwd/authoring source. Timestamp — дополнительный guard, не proof
позднего AutoResume после restart. Физический suffix проверяется тем же reader
до EOF: повреждённая строка или незаконченный user не могут исчезнуть из parsed
array и разрешить repair. Новые user/task/tool/rollback/compact, неполная,
противоречивая или изменённая пара остаются запрещены, а не заменяются старой.
Источник нового COW и текущий stopped child — разные роли. При отказе repair
до принятой binding тот же executor восстанавливает incumbent child с его
settings proof, не parent-источник. Resume guard по-прежнему требует исходный
expectedSessionId; ошибка recovery не разрешает ослабить его или отправить prompt.
Prepare отдаёт внутренний exact child settings proof для того же failure-Resume;
он сильнее stale same-SID renderer proof и глобальной пары после reopen. Новый
HTTP аргумент, writer scenario или proof по тексту не нужны.

Старое `rewind_ai` отсутствует в tools/list, direct/cached calls получают
`rewind_ai_removed`. Legacy `mode:native|ai`, text/index/menu/duplicate-count/range
arguments и неизвестные поля нового метода дают явный отказ до HTTP. Старый
AI-summary режим также не является saved-history и не сохранён как alias.

`get_history_operation({tabId,operationId,includeStatus:true})` читает GET exact
receipt и отдельно GET current `/status`; без includeStatus читает только receipt.
`operation` сохраняет full draft, historyMutated, bindingCommitted/binding,
newSessionId и resume. Неуспешная операция также читается успешно:
`ok:true, operation.success:false`, не потеря квитанции. Transport/404/malformed
или foreign identity — typed error с SAME operationId; status failure возвращает
currentStatus:null/currentStatusError, не стирая receipt. Pending/outcome-unknown
и отсутствие receipt не доказывают отсутствие мутации. `202`/completed не дают
inputReady или доказательство чистого prefix. После проверки текущей History/
Timeline и runtime отдельный authorized `send_prompt` отправляет оригинал один
раз со stable handoffId; executor Rewind сам его не отправляет.

```js
rewind_history({tabId, operationId: "rewind-selected-v1",
  expectedSessionId, targetUuid, toolType: "codex", targetSourceIdentity});
get_history_operation({tabId, operationId: "rewind-selected-v1", includeStatus: true});
```

Проверка: actual stdio dispatcher → isolated HTTP → existing SavedHistoryOperations
accept/read. Подтверждены idempotency, invalid/legacy pre-mutation refusal,
lost HTTP/whole-MCP ACK и receipt-only recovery после MCP/app restart. Это не
физическая приёмка provider prefix: executor/range и native writer проверяет
профильный владелец отдельно.

Для late saved-history receipt external consumer отдельно читает main
applicability: следующий ввод того же SID/process снимает право применить старый
draft. Это additive HTTP owner contract (fact-mobile-web), не новый MCP runner
или основание повторять отправку. Immutable GET результата остаётся прежним.
Benign cleanup/Stop не снимает checkpoint при сохранённом exact archive:
logical binding может быть known/applicable без live writer. GET-only восстановление
observation-unknown не открывает вкладку и не запускает CLI; отсутствие/неоднозначность
архива остаётся unknown. Project API process Stop также напрямую вызывает тот же
main scenario что desktop IPC, не превращает renderer reply deadline в stop-failure.

## Рабочая область: окна, форк вкладки и раскладка (2026-08-18)

До этого рабочей области в API не было вовсе: вкладку создать могли, а сказать, ГДЕ она должна появиться, — нет. Просьба вида «сделай форк этой вкладки для Claude и для Codex и открой обе справа, разделив окно на два» была невыразима.

Три инструмента, потому что это три разных вопроса:

- **`list_windows`** — inventory окон всех workflow. Видимые окна идут в экранном порядке; окна, скрытые профилем монитора, остаются отдельными записями с `hidden:true` и `column/row=-1`. У каждого `tabs` — полоса, `shownTabId` — выбранный чип внутри окна; выбор чипа сохраняется и в скрытом окне. `index` относится к текущей раскладке, `windowRef` связан с её revision, а `windowId` — постоянная identity содержимого. Background source выбирает своё скрытое окно независимо от текущего UI-фокуса.
- **`fork_tab`** — форк ЖИВОЙ вкладки: рядом появляется новая, продолжающая КОПИЮ разговора. Отличается от `fork_session`, который копирует только файл истории и ничего не запускает. Провайдер читается у самой вкладки, если не назвали: спрашивать «чей это форк» у вызывающего значило бы дать ему ошибиться там, где ответ уже записан. Форк открывается в фоне — ГДЕ его показать, отвечает раскладка.
- **`arrange_windows`** — раскладка целиком, одним вызовом.

### Вложенность вместо флага

```
windows: [["tab-A"], ["tab-B"]]   → два окна рядом
windows: [["tab-A", "tab-B"]]     → ОДНО окно с двумя чипами, показан первый
```

Отдельный флаг «в одном окне» был бы вторым способом сказать то же самое, и два способа разошлись бы. Голый id читается как окно из одной вкладки, поэтому частый случай пишется как `["a", "b"]`.

### Два разных вопроса: куда и как

`side` — ГДЕ новая область относительно окна-якоря. `divide` — как несколько окон делят ЭТУ область: `columns` (рядом, по умолчанию) или `rows` (друг под другом, то есть одна новая колонка, поделённая горизонтально).

Сначала это был один флаг, и он ошибался ровно на просьбе пользователя: «справа, и раздели это окно на два по горизонтали» превращалось в две строки в колонке САМОГО якоря вместо новой колонки справа. `side: 'above'|'below'` — отдельный случай: там новые окна и правда встают в колонку якоря, потому что «сверху» только это и значит.

### Почему это отдельный путь, а не последовательность жестов

Все остальные операции сплита — ЖЕСТЫ: изменение на один клик, со своими защитами (одна пустая панель за раз — человек обязан её заполнить, прежде чем открывать вторую). Вызывающий по API жестов не делает, он называет раскладку. Собирать её из жестов — это четыре обращения, каждое из которых может наполовину не удаться, а защита пустой панели вторую и вовсе отклонит.

Поэтому `arrangePanes` применяет раскладку **целиком или никак**, одной записью в состояние.

### Названная вкладка ПЕРЕЕЗЖАЕТ

Вкладка живёт ровно в одном окне (живой терминал нельзя нарисовать в двух местах), поэтому поместить её куда-то — это и забрать её оттуда, где она была. Окно, потерявшее так последний чип, исчезает: оно показывало ровно ту вкладку, которую переставляли, и пустая коробка была бы мусором от этой же перестановки. Окно, которое пользователь оставил пустым САМ, не трогается.

Типичный поток: `list_windows` → `fork_tab` (по одному на агента) → `arrange_windows` с обоими новыми id.

### Workflow-aware target: проект не является окном (2026-08-25)

После появления workflow старый адрес `projectId + tabId` перестал отвечать на
вопрос «где показать созданное». Проект владеет durable tab record и directory
context; workflow владеет раскладкой; окно владеет полосой; source tab полного
MCP-сеанса задаёт смысл слова «текущее». Последний клик пользователя не является
контекстом фонового агента.

`current_context` теперь дополняется `workspace.sourceContext`: все размещения
source tab и preferred placement. `list_windows` возвращает нормализованные
окна ВСЕХ workflow, включая dormant snapshots. У окна есть opaque `windowRef`,
связанный с fingerprint всего workspace: после любой перестройки старый ref
даёт `stale_layout`, а не начинает означать соседнее окно.

Один `windowTarget` используется в `create_tab`, `delegate_to_session`,
`fork_tab`, `arrange_windows`, `create_window` и `open_tabs_in_window`:

- `anchor:source + mode:same-window` — вставить сразу после source chip;
- `side:below|above` — новая строка в колонке anchor;
- `side:right|left` — новая колонка рядом;
- точный `spaceId` без окна — saved focused window workflow;
- source без размещения — active workflow focused window.

Placement и показ — разные действия. Background create меняет strip/layout, но
не переключает пользователю workflow и не забирает focus; `reveal:true` делает
это явно. Bare `create_tab` без `windowTarget` сохраняет старое unplaced/background
поведение для dev-server/service tabs.

Создание вкладки проходит acknowledged Project API scenario: resolve target и
cwd → создать background tab → commit placement → только затем стартовать AI.
Если ref устарел, окно исчезло или commit отклонён, новая вкладка удаляется до
launch. Orchestration сохраняет `cwd + windowTarget` внутри durable request
identity и materializes reserved target через тот же сценарий; retry не может
переиграть тот же run в другом окне.

Directory resolver: explicit `cwd` → source-tab cwd, если target остаётся в том
же project → target-window/workflow context → root действительно другого
project. Явный same-project `projectId` служит routing hint и не стирает cwd
источника. Неоднозначный cwd и отсутствующий project дают явную ошибку;
глобальный `activeProjectId` и автоматическое создание постоянного проекта
запрещены как silent side effect.

`placement:child|root` по-прежнему означает visual hierarchy в sidebar.
`windowTarget` означает геометрию workspace. Эти оси независимы.

В workflow-режиме отсутствие `windowTarget` оставляет нового исполнителя в
резерве workflow источника; execution namespace не задаёт эту принадлежность.
`reservedTabId` — заранее выбранный ID НОВОЙ вкладки, а не основание для restore:
до provider launch он проходит обычное создание subject и membership. Шрам09.10:
подстановка reservation в `restoreId` пропускала эту запись; сессия запускалась,
но workflow-sidebar её не видел. Настоящий cold/archive restore сохраняет свой
прежний durable subject и не создаёт ещё один. Ремонт новых созданий сам по себе
не регистрирует ранее возникшие legacy-вкладки без membership.

При жалобе «появилась в sidebar лишь после открытия/закрытия» проверять отдельно
создание, renderer-публикацию и выбранный workflow. `WorkflowCreation` пишет
подтверждённую allocation через `console.log`: renderer `console.info` не
пересылался в файл. `WorkflowCreation:visibility` связывает тот же tabId с
отсутствующим renderer record, фильтром/размещением, другим workflow, outline,
строкой и DOM. Наблюдение ограничено32 новыми вкладками, без таймеров/подписок/
layout reads; вытеснение явно отмечается. `dom-mounted` подтверждает наличие
строки, но не её попадание в прокрученный viewport. Текущий API membership и
успешное создание не доказывают историческую видимость строки.

## Контекстные файлы без чтения вызывающим агентом

`send_prompt` и `delegate_to_session` принимают `files:[{path,role,label?}]`.
Это descriptor-контракт: вызывающая нейронка передаёт путь, но не читает и не
пересказывает содержимое. Terminal MCP сначала превращает относительный путь в
абсолютный относительно cwd source-сессии, а Project API до создания run и до
Enter асинхронно проверяет regular file, размер и UTF-8, читает его один раз,
вычисляет SHA-256 и вставляет snapshot в self-contained `<context_file>`.

`role:source` сохраняет текст дословно. `role:instructions` дополнительно
раскрывает `@include` и вырезает `@ai`/transclude metadata тем же смыслом, что
файлы сохранённых prompt. Include читаются асинхронно, имеют depth/cycle guard и
участвуют в общем byte budget. Missing, binary, invalid UTF-8, cycle и превышение
per-file/total limit дают явную ошибку до отправки; fallback на голые пути
запрещён. Поддержка PDF/DOCX/изображений требует отдельного parser/provider
adapter и не имитируется декодированием binary как текста.

Перед file-bearing POST Terminal MCP читает `/api/me` и требует capability
`contextFiles.version=1`. Это deployment gate: новый MCP рядом с ещё работающим
старым main не имеет права отправить неизвестное поле, получить обычный success
и фактически доставить prompt без файлов. Отсутствующая capability останавливает
операцию до POST/Enter с требованием перезапустить или обновить Noted Terminal.

History восстанавливает file-chip прямо из `<context_file>` после restart,
поэтому большая копия body не нужна в presentation-sidecar. Обычная строка
показывает имя с file-иконкой, содержимое раскрывается по клику. Durable
orchestration identity хранит только path/role/label/hash/bytes, а exact delivery
proof считается по реально отправленному expanded prompt. Контекст source-agent
не расходуется, но target-agent закономерно платит токенами за полный файл.

Это не `link_file`: тот создаёт визуальную дочернюю file-вкладку и не передаёт
содержимое модели. Это также не iOS `attachments`, которые являются upload в
temp-root и пока отправляют агенту path-контракт. `files` требует `submit:true`:
editable draft не должен неявно материализовать мегабайты скрытого текста.

## План задач и дочерний файл

Область ответственности и отложенные изменения теперь имеют отдельный
контракт: `list_tab_contexts`, `get_tab_context`, `set_tab_responsibility`,
`publish_context_update`. Последний сохраняет чип к следующему сообщению
ДРУГОЙ вкладки и не запускает target; совпадение с собственной вкладкой
вызывает `context_update_self_target` до публикации. Отсутствие своего Markdown
не означает необходимость уведомить себя. Открытие вкладки только показывает обновление. Подробности
хранения, file-watching, отправки и UI: [fact-tab-work-context.md](fact-tab-work-context.md).

Блок в левом верхнем углу вкладки — структурированный план задач: `get_tab_plan` читает его, а `apply_tab_plan_changes` атомарно применяет только заранее показанный и подтверждённый пользователем пакет операций. Старое поле `tab.notes` остаётся совместимостью удалённой Markdown-поверхности и не выставляется как новый публичный метод. `list_notes` — третья, независимая сущность: пользовательские якоря Timeline.

`link_file` не создаёт новую иерархию. Он вызывает тот же renderer-сценарий, что desktop Link File/DnD: `tabType='file'`, `visualParentTabId=<AI tab>`, inherited `groupId`, background creation. Путь сначала canonicalize/проверяется сервером; повтор той же пары canonical file + parent возвращает существующий file-tab. Без `tabId` файл прикрепляется к родительской полноценной сессии, с явным `tabId` — к другой открытой AI-вкладке, в том числе другого проекта.

Сохранённый на диске документ ещё не подтверждает прикрепление: связь проверяется
через `get_tab_context`. Шрам13.10: `link_file` у507 получал409
`execution_storage_revision_changed` из-за чужой строки в полном snapshot,
а не из-за отсутствия файла или ошибки Codex. Новая native file-вкладка проходит
общий scoped creation commit только своей строкой; CAS самого ребёнка и отмена
до публикации остаются строгими. Legacy/restore и сохранение самой конфликтующей
вкладки не получают исключения. Детали — `fact-data-persistence.md::Создание
native-вкладки не сохраняет соседей`. Обновление MCP не устанавливает этот
renderer-ремонт, ранее отказавшиеся связи автоматически не создаются.

Полноценные AI-сессии используют ту же визуальную связь, но остаются самостоятельными процессами. `create_tab` и `delegate_to_session` по умолчанию создают связанную новую сессию как visual-child вызывающей вкладки, когда обе находятся в одном проекте; `placement='root'` оставляет независимую работу на верхнем уровне. Новая фоновая сессия добавляется последней в уже заданном порядке: связь с родителем не даёт API права вставить её перед вручную расставленными вкладками или сделать первым ребёнком. Для другого проекта без явно переданного `parentTabId` безопасный default — root, а делегация в уже существующий target никогда не меняет его место в иерархии.

Одноразовый исполнитель не закрывается автоматически до чтения результата. После `get_delegation_result` вызывающий агент завершает disposable-flow через `close_tab`; метод по умолчанию отказывается закрывать busy-вкладку, а `force` допустим только как явное destructive-решение. Долгоживущую сессию, предназначенную для продолжения работы, этот cleanup не затрагивает.

## MCP activity events

Mutating HTTP routes (`run_command`, `restart_process`, `run_chain`, `create_tab`, `kill_process`, `send_prompt`, `start_ai`, `stop_ai`) эмитят `terminal:mcp-activity` в renderer. Событие несёт `sourceMeta` (кто вызвал MCP), target project/tab, action и status (`running`/`sent`/`completed`/`error` и т.п.). StatusBar показывает это как глобальный `MCP` chip, потому что запрос может прийти из внешней локальной нейронки или соседней вкладки, не из текущего UI-контекста.

Passive reads (`list_tabs`, `read_output`) намеренно молчат. Иначе каждый inspection-loop агента превращает StatusBar в шум, хотя пользовательского действия над вкладкой не было.

Это журнал результата конкретного вызова, не live-status target и не полный аудит всех новых Project API routes. Старый Goal-required/error не доказывает, что уже восстановленный агент всё ещё остановлен. Переход existing-placement/append и human-name projection описаны в `fact-status-bar.md::MCP Activity chip`; authoritative delivery/result через журнал не подменяются.

## Soft Restart (Ctrl+C → re-run)

### Отброшенный подход: Hard Kill (pty.kill + recreate)
Первая реализация убивала PTY через `pty.kill()` и пересоздавала новый через IPC `terminal:mcp-restart` → renderer → `terminal:create`.

**Почему не работает:**
- `onExit` удаляет все Maps (terminals, terminalOutputBuffer, terminalCommandState) → `read_output` возвращает 404
- xterm показывает `[Process completed]` — ввод невозможен до пересоздания PTY
- Race condition: kill + IPC round-trip через renderer + create — 3 async шага с непредсказуемым timing
- Ctrl+C в shell запущенном через `-c "cmd; exec shell"` убивает весь PTY, не только cmd

### Текущий подход: Soft Restart
Тот же механизм что UI кнопка restart в TabBar.tsx:
1. **Ctrl+C** (`\x03`) → останавливает текущий процесс
2. **Ждёт OSC 133;D** (command-finished) — детерминированно через `terminalCommandState.isRunning`
3. **300ms пауза** для полного рендера prompt
4. **Re-run**: `term.write(restartCmd + '\r')`

Shell остаётся живым. Output buffer не теряется. PTY pid не меняется.

### Edge Cases
- **Process уже мёртв** (`isRunning = false`): Ctrl+C безвредно идёт в prompt, ожидание пропускается, команда отправляется сразу
- **Electron graceful shutdown**: electron-vite может завершаться 2-5 секунд. Timeout увеличен до 30s
- **initialCommand не сохранён** (пользователь набрал вручную): возвращается ошибка с требованием передать `command` параметром. Fallback `!!` убран — ненадёжен (пустая history, неправильная команда)
- **Ctrl+C trap**: Некоторые процессы ловят SIGINT. 30s safety timeout покрывает, но в теории возможны две копии процесса если timeout сработает до реального завершения

## Output Ring Buffer
`terminalOutputBuffer` — Map<tabId, {ring: Array(500), head, count, maxLines}>. Circular buffer с O(1) записью на строку. Заполняется синхронно в `ptyProcess.onData` (без await — anti-pattern: async onData race). Удаляется в `onExit`.

**Ловушка (апрель 2026):** Первая реализация была `{lines: string[]}` с `push() + splice(0, excess)` — O(n) splice на каждом onData чанке. При 15+ табах с активными Claude это давало ~750 splice/сек в main event loop, что вместе с Timeline backtrace polling вызывало thermal throttling (kernel_task до 200%). Симптом: macOS становится медленным даже после остановки всех Claude-процессов — память под давлением, page-out, kernel жонглирует страницами.

## Развёртывание
Repo source — `mcp/terminal-server.mjs`, установленная копия — `~/.claude/mcp/terminal-server.mjs`. Claude и Codex регистрируют только имя `terminal`; отдельной регистрации `overseer` нет. Skill-source живёт в `~/.claude/skills/terminal/` и автоматически зеркалится в `~/.codex/skills/terminal/`.

Каноническая установка выполняется `npm run install:terminal-mcp`. Runtime-файлы сравниваются побайтно и заменяются через temporary+rename; конфиги — с backup и сохранением permissions, без перезаписи других entries или вывода секретов. Прямой stdio наследует NOTED_MAIN_PID, NOTED_PARENT_PROJECT_ID, NOTED_PARENT_TAB_ID, NOTED_DISCOVERY_DIR, NOTED_MCP_INSTANCE_ROUTE. Для узнаваемого Claude terminal hub URL добавляется только route-placeholder; Codex HTTP config остаётся побайтно прежним. Dry-run и повторный запуск идемпотентны.

`npm run build:install` после успешной упаковки, но до замены и запуска `/Applications/Noted Terminal.app`, обязательно вызывает этот же `install:terminal-mcp`, а затем отдельный `install:claude-hook` для turn-event bridge. Ручной build-install, `build:i-obs` и Voice Record сходятся в одном `npm run build:install`, поэтому copy-логика не дублируется в shell/соседнем приложении. Если синхронизация runtime-интеграций падает, цепочка `&&` не устанавливает и не запускает новый backend; безопаснее временно иметь новый клиент со старым backend, чем поднять новый backend со stale-клиентом без обязательной identity metadata.

Каноническое направление развёртывания — только из repo source в установленную копию. Обратное копирование опасно: установленный сервер может отставать и стереть новые методы из актуального source. Перед заменой нужно сравнить обе копии, после неё — проверить `tools/list` именно у установленного сервера.

Claude и Codex получают схему Terminal MCP от общего HTTP-хаба. Замена repo-файла
сама по себе не является hot reload: сначала installer обновляет установленный
`terminal-server.mjs`, затем `POST /mcp/_restart/terminal` перезапускает только
этот child общего хаба. Все подключённые AI-сессии увидят новый schema/backend без
собственного restart; сам hub и соседние MCP не останавливаются. Исторический
симптом stale deployment остаётся тем же: новый app ожидает causal `sourceMeta`,
а старая установленная MCP-копия его не передаёт, поэтому nested child законно
остаётся root. Компенсировать это угадыванием parent по `tabId` запрещено.

Claude turn-hook имеет другую загрузочную границу: CLI запускает `node ~/.claude/hooks/noted-turn-event.js` заново для каждого `UserPromptSubmit`/`Stop`, поэтому новая runtime-копия применяется на следующем hook-событии, если регистрация уже существовала. Для causal lineage hook передаёт точный prompt только на `UserPromptSubmit`; отсутствие поля или несколько одинаковых pending audit оставляют target context непривязанным, а не разрешают backend угадать parent по вкладке.
