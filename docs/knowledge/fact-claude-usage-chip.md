# Feature: Unified AI Usage (Claude + Codex)

Единый контрол в правой части шапки ([`WorkspaceTitleBarTools.tsx`](../../src/renderer/components/Workspace/WorkspaceTitleBarTools.tsx)), реализация — [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx). По умолчанию слева виден Codex, справа Claude; половины соприкасаются без зазора и открывают один общий popover на нужном провайдере. Каждую половину можно отдельно скрыть из шапки через нижнюю строку этого popover'а.

## Компактное лицо и общий popover

Codex использует slash-модель только для реально присутствующих окон: иконка, `weekly left + reset / 5-hour left + reset`. Если OpenAI явно не отдаёт 300-минутное окно, весь пятичасовой сегмент вместе с `/`, reset и accessibility-текстом отсутствует; следующий подтверждённый ответ с 300-минутным окном возвращает его автоматически. У Claude порядок расширен и фиксирован: иконка, `weekly left + reset / 5-hour left + reset / Fable left`. У Fable в компактном лице **нет отдельного времени reset**: это ограничение внутри недельного бюджета, а не самостоятельное третье окно. Процент означает **остаток**, а не расход: `54%` и заполнение на 54% описывают одно и то же. Цвет определяется срочностью по расходу: зелёный при большом остатке, затем жёлтый, оранжевый и красный у исчерпания. В компактном лице отдельной мини-шкалы нет. Оба компактных лица всегда показывают аккаунт, под которым войдёт обычный локальный CLI; выбор исторического/дополнительного аккаунта в popover меняет только его detail. Если текущий login не доказан, лицо не подставляет цифры чужого historical-аккаунта.

Codex-иконка — inline SVG-глиф без белой app-плашки. Claude использует общий `ClaudeSparkle`. Countdown обновляется раз в минуту и остаётся видимым при закрытом popover.

Popover физически один и не размонтируется при смене провайдера. В первой строке слева находится двухпозиционный переключатель Codex/Claude, справа — история аккаунтов выбранного провайдера; у Codex рядом стоит иконка `+` для подключения нового профиля. Во второй строке находятся источник, возраст снимка, `current/stale`, состояние выбранного профиля, вход/выход и `refresh`. Отдельный каталог `Codex accounts` под шапкой запрещён: он дублирует те же аккаунты второй раз. Дублирующие email/reset-заголовок, строки `Plan` и отдельная строка `Source` также удалены. `Activity` принадлежит общему контейнеру, поэтому раскрытие и данные сохраняются при переключении Codex ↔ Claude. Высота ограничена окном, длинное содержимое прокручивается.

Текущий popover показывает лимиты выбранного провайдера и общий `Activity`. У Codex показываются только основные weekly/5-hour окна, затем ненулевой/unlimited Codex credit balance и доступные `Full reset` с точными датами истечения. Model-specific `additional_rate_limits` (сейчас Spark) по-прежнему нормализуются и хранятся в снимке, но desktop Usage их не рендерит. Сбросы информационные: redemption action отсутствует. У Claude строки всегда идут в порядке `Weekly`, `5-hour`, `Fable`; у Fable не показывается отдельная дата сброса. Секции `This tab`, `By day (last 7d)` и Claude `Extra credits` на frontend не рендерятся. Расчёт токенов вкладки, дневные снимки и поле дополнительных кредитов в backend сохранены, чтобы их можно было вернуть без потери данных. Появление Fable не является причиной показывать `Extra credits`.

У Claude зелёная точка означает текущий логин CLI. У Codex она означает подключённый профиль, поэтому зелёными могут быть несколько аккаунтов одновременно; рамка по-прежнему показывает только выбранную строку. Неподключённый исторический аккаунт получает серую точку и `stale`. ПКМ по компактному лицу Codex/Claude не открывает popover: он принудительно обновляет текущий локальный аккаунт, показывает spinner в том же месте и не меняет выбор внутри popover. Смена аккаунта, вкладки или провайдера увеличивает поколение запроса: запоздавший ответ старого контекста не имеет права менять новый экран. Загрузки лимитов и `Activity` имеют renderer deadline и всегда завершают spinner.

## Read-only Usage API для native iOS — source14.09

`GET /api/agent-usage?provider=codex|claude&accountKey=<key>&refresh=1` требует
штатную bearer-авторизацию. Capability `agentUsage:{version:1,readOnly:true,
providers:['codex','claude'],endpoint:'/api/agent-usage'}` публикуется при наличии
main getter. Это один глобальный просмотр аккаунта, не операция над вкладкой.
Выбор key не меняет login, default profile или writer. Profile/login/logout/
redemption endpoints здесь отсутствуют; неизвестный выбранный key возвращает
account_not_found вместо данных другого аккаунта.

HTTP вызывает тот же `claude-usage._api.getUsage` и тот же Codex getter, который
теперь экспортирован из прежнего `codex:get-usage` handler; fetch/auth/history/
anti-flap/cache не копируются. HTTP refresh — обычное чтение с forcefalse:
не обходит cache/throttle/Retry-After и не запускает новый queue runner.
Source nickname «claude:usage» означает именно desktop `claude-usage:get`.

DTO version1: provider, ok/status, accounts `{key,label,current,connected,stale,
source,timestamp,status}`, selectedAccountKey/currentAccountKey, windows,
credits/fullResets, freshness и error `{code,message}`. Window: id/label,
usedPct (nullable, это расход), resetAt ISO|null, windowMinutes, status,
resetPolicy; model-specific Codex имеет modelScope. Отсутствующий Codex5h не
создаёт строку. Claude Fable всегда shared-weekly/sharedWithweekly/resetAtnull;
неизвестный percent остаётсяnull. Full reset различает unavailable/null count
и known/0, передаёт только label/expiration; действий списания нет.

Вывод — строгий allowlist: без auth/home/session IDs, login-кодов/URL,
сырых profiles/billing/reset IDs, credential fingerprints и provider error body.
Подписи маскируют email, исходные ошибки переводятся в короткие безопасные
auth_required/rate_limited/timeout/account_mismatch/usage_unavailable. Подробные
provider diagnostics остаются на компьютере. Quota failure возвращает HTTP200
с okfalse и сохранёнными доступными числами; malformed provider/key —400,
неавторизованный запрос401, методы изменения405, отсутствующий getter503.
Source115 related tests PASS, включая actual HTTP route/privacy и реальный
Claude getter с контролируемым fetch/cache. Frozen7997 и production не обновлялись.

## Почему weekly остаётся первой метрикой

Пятичасовой расход меняется резко, недельный лучше описывает долгосрочный бюджет. Поэтому weekly стоит первым и определяет основной цвет половины. Пятичасовой остаток остаётся вторым постоянным числом, а в popover оба окна получают полноценную шкалу и точную дату сброса.

## Источник Claude: атомарный OAuth-снимок, statusLine как резерв

Для подтверждённого Claude OAuth основным источником служит один `GET https://api.anthropic.com/api/oauth/usage`. Один ответ содержит `five_hour`, `seven_day` и `limits[]`/`model_scoped`; приложение принимает или отклоняет этот набор целиком и ставит ему один источник и одно время. Оба общих окна обязательны для принятия сетевого ответа. Исчезнувшие необязательные поля не дополняются значениями из прошлого ответа, а Fable распознаётся только по model scope (`scope.model.display_name`, например `Fable`). Флаг `is_active` не используется как фильтр: реальный отображаемый Fable-лимит может прийти с `is_active: false`.

Официальный JSON Claude Code `statusLine.rate_limits` хранится отдельным резервным снимком. Он содержит только `five_hour` и `seven_day`, поэтому никогда не наследует Fable из OAuth. Отсутствующее в новом statusLine окно остаётся `unknown` и не дополняется старым значением с чужим временем. Для `/login managed key` statusLine остаётся единственным основным источником. Для OAuth-аккаунта свежий полный сетевой снимок не перезаписывается очередным statusLine-событием; если OAuth временно недоступен, интерфейс переключается на цельный statusLine-снимок и показывает Fable как `unknown`, а не смешивает свежие общие окна со старым модельным лимитом. Скрипт [`scripts/statusline-bridge.sh`](../../scripts/statusline-bridge.sh) атомарно пишет только разрешённые поля, main сохраняет резерв до отправки существующего `claude:bridge-update`.

Аккаунт подтверждается через `claude auth status --json`. Связь снимка строится по сочетанию session id и PID процесса Claude, поэтому две продолженные сессии с одинаковым session id после смены логина не смешиваются. При штатной ротации OAuth-токена старый процесс Claude не имеет права вернуть аккаунту прежнюю подпись токена и запустить повторный сетевой refresh на каждом statusLine-событии. Сохраняется только хеш связи процесса с аккаунтом; максимум 512 связей в памяти и 128 между рестартами.

Нет подходящей Fable-записи или поле отсутствует — Fable остаётся `unknown`, а не `0%`. Даже когда endpoint отдаёт `resets_at`, UI не показывает отдельный Fable reset: Fable — сублимит общего weekly budget, не дополнительная квота. `/login managed key` не является OAuth и никогда не отправляется в endpoint как Bearer. `Claude Code-credentials` также содержит OAuth других MCP: извлечение Claude-токена намеренно не рекурсивное, поэтому Figma `accessToken` не может стать Claude credential. Приложение не расходует и не обновляет refresh token Claude Code.

OAuth-запрос имеет физический timeout, singleflight, cooldown и `Retry-After` gate. Ручной refresh обходит обычный кэш, но не server backoff и account guard. StatusLine-событие не сбрасывает сетевой backoff и не создаёт повторный запрос после `429`. Перед применением результата auth читается повторно; смена логина во время запроса отбрасывает старые данные и старую ошибку.

Очевидная регрессия внутри ещё не наступившего окна (`64/61% used → 1/0% used`) сначала хранится как кандидат, а последнее проверенное значение остаётся на экране. OAuth сравнивается только с предыдущим OAuth-снимком, statusLine — только с предыдущим statusLine-снимком. При подтверждении кандидата сравниваются общие и модельные лимиты, поэтому второй ответ с другим Fable не подтверждает первый. Кандидат принимается после второго полностью совпавшего наблюдения не раньше 30 секунд; реально наступивший reset принимается сразу.

До восьми Claude-аккаунтов сохраняются как маскированные, нормализованные снимки. Токены, полный email, raw org id и raw session id не сохраняются. Исторический аккаунт никогда не обновляется credential'ом текущего.

Для API Platform обычный API key валидируется через `GET /v1/models?limit=1`; расход доступен только при отдельном Admin API key через `GET /v1/organizations/cost_report`. Этот API возвращает spend, но не remaining balance, поэтому UI честно показывает `Credits left: not exposed`. Admin key изолирован в main process и удалён из env renderer, PTY, SDK и дочерних утилит.

### Один config namespace у auth status, credentials и Usage

Официальный [Claude credential contract](https://code.claude.com/docs/en/authentication#credential-management)
привязывает macOS Keychain entry и fallback credentials file к `CLAUDE_CONFIG_DIR`.
Проверенный14.09 старый handler нарушал это правило: private CLI status
соединялся с глобальными `Claude Code*`. Source теперь захватывает одно окружение
и применяет тот же контракт Claude2.1.270: service суффикс `-sha256(NFC(dir))[0:8]`
после `-credentials`, точный Keychain account через `-a USER`. Путь для hash не
обрезается и не realpath'ится; даже явный обычный `.claude` — отдельная запись.
Без env сохраняются прежние production service names и account key.

Reader не ищет global credential при отсутствующем private. Только отсутствующий
Keychain container разрешает его собственный `.credentials.json`; присутствующий
MCP-only container не merge'ится с fallback. Файл ограничен по размеру и не выходит
через symlink из выбранного каталога. Private account/cache/statusLine binding
включают namespace, поэтому совпавшие email, SID и PID не объединяют два профиля.
Повтор status + credential/source проверяет смену входа и явный identity conflict;
общий5s deadline отменяет только служебные auth children, без нового login/refresh
token. Ошибка оставляет saved quota stale, не назначает аккаунт current.

Служебный secure-storage override допускается лишь для того же каталога;
custom OAuth/external token не подменяется stored subscription credential ради
запроса к production quota endpoint. API-key из env используется лишь когда сам
CLI назвал именно этот источник. Managed login сохраняет statusLine-only путь.
HTTP Usage остаётся тем же v1 DTO/cache/throttle: paths, tokens и namespace keys
наружу не выходят. Runtime установка и private login/provider acceptance отдельно
у владельца frozen target; source-проверка не является новым входом.

Ошибка наблюдения Keychain не равна отсутствующему документу. Только доказанный
item-not-found разрешает собственный `.credentials.json`; denied/timeout/killed
child/unknown exit возвращают typed `auth_source_unavailable` или timeout и не
читают fallback. Ошибка повторного auth-read не превращается в «вы не вошли»:
старый verified snapshot остаётся stale, а public DTO говорит «источник недоступен».
`auth_required` оставлен для реального logged-out/401/отсутствующего credential.

## Источник данных Codex: тот же account API, что у web dashboard

Основной источник toolbar-чипа — `GET https://chatgpt.com/backend-api/wham/usage`. Это тот же JSON, из которого страница `chatgpt.com/codex/cloud/settings/analytics#usage` рисует карточки лимитов; DOM страницы не парсится. Для основного профиля запрос использует `access_token` и `account_id` из `~/.codex/auth.json`; дополнительный профиль использует собственный изолированный Codex home. Email ответа, если он есть, обязан совпасть с email соответствующего Codex auth; несовпадение — конечная ошибка, а не данные второго аккаунта. Ответный `account_id` находится в namespace пользователя и **не равен** request header `ChatGPT-Account-Id`; его можно сверять только с JWT claim `auth.user_id`, иначе каждый корректный ответ будет ложно отклонён.

### Троттлинг context-refresh: смена вкладки — не повод для сети

Identity `refresh` меняется при каждом переходе на вкладку с другой Codex-сессией, и effect с `[refresh]` в deps перезапускался на каждый tab switch — сетевой fetch usage + обход профилей в main (620мс-2с) прямо в окне переключения; ночной случай — остановка main-цикла на 5002мс при нулевом CPU, где usage был единственной активной операцией. Usage account-scoped; смена вкладки лишь уточняет fallback-идентичность сессии. Троттлинг: context-перезапуск в пределах 30с от последнего fetch пропускает немедленный вызов (`context-refresh throttled` в логе). Ручной refresh, смена аккаунта и интервальная проверка сохранены. Передний refresh теперь account-scoped: текущий default не ждёт проверку всех managed-профилей, а выбранный managed обновляет только свой profile. Обход всех остаётся только fallback'ом, когда нет текущего default и не задан точный account. `CodexUsage:Stages` печатает `target`, отдельные `remoteMs`/`profilesMs` и `reason`, чтобы отличать сеть от обхода профилей.

27.09 пользователь уточнил: **все подключённые Codex-аккаунты** должны обновляться
без предварительного выбора в меню. Поэтому сетевой clock перенесён в main:
при старте и каждые30с он независимо проверяет default auth и managed-профили с
подтверждённой identity/status connected (error-профиль с identity получает retry).
Dashboard, закрытый/скрытый popover, скрытое окно и выбранный detail не останавливают
этот clock. Исторический signed-out аккаунт без доступа остаётся stale; его
цифры нельзя обновить credential'ом другого профиля. Медленный запрос одного
аккаунта не задерживает соседний; на аккаунт допускается одна фоновая попытка,
а передний refresh разделяет с ней usage/probe in-flight.

Обычная проверка остаётся `force:false`:25с success-cache переиспользуется
соседними читателями, ошибка держит прежний снимок и отдельный60с cooldown.
HTTP429 `Retry-After` в секундах или дате ограничивает также ручной refresh для
того же auth fingerprint; новый токен отзывает старую паузу. Этот clock не
обходит ограничения OpenAI и не гарантирует изменение процентов на каждый тик.
Прямой HTTP `/backend-api/wham/usage` остаётся основным источником. Claude
по-прежнему получает bridge-события и редкую10-минутную fallback-проверку.

Main публикует `codex:usage-updated`; видимый renderer читает готовый снимок
через `snapshotOnly`, без сети и локального log scan. Его прежний30с таймер
теперь только проецирует кэш; без exact account сохраняется180с UI-check.
В скрытом документе UI-read остановлен, при возврате снимок читается сразу.
Контекстный/ручной передний refresh по-прежнему account-scoped и не ждёт все
managed accounts. Смена вкладок не управляет main-clock.

## Подключённые профили Codex: глобально, не по вкладкам

Основной профиль — обычный `~/.codex`, поэтому запуск `codex` без специального окружения продолжает использовать тот же логин, что и до этой фичи. Дополнительные аккаунты получают отдельные Codex home внутри `~/.noted-terminal/codex-accounts/`. Это глобальный список приложения: переход между проектами, закрытие вкладки и исчезновение сессии не переключают и не удаляют аккаунт. Уже запущенные Codex-вкладки не перепривязываются; выбор аккаунта в usage-popover меняет только просматриваемые лимиты.

Для отдельного test instance `default` берётся из его `CODEX_HOME`, если он задан.
Это не переносит автоматически каталог новых managed profiles: без явного
`profilesRoot` он остаётся в глобальном `~/.noted-terminal/codex-accounts`.
Private default login и «добавить ещё профиль» требуют разных isolation proofs.
`connected`/CLI `Logged in` при сохранённом login-expired error не подтверждают
доступ: после отдельного пользовательского входа нужен свежий account-bound
ответ, а не старый cached snapshot. Рабочий профиль повторно логинить не требуется.

Вход запускается через официальный Codex app-server в режиме device OAuth. Только на время входа под строкой источника появляется жёлтая панель с одноразовым кодом, сроком действия, отменой и сегментированной командой `Open browser | Copy link`; копирование кода или ссылки на короткое время заменяет иконку копирования зелёной галочкой. Одноразовый код и ссылка не сохраняются между рестартами; завершённая авторизация остаётся в изолированном Codex home, а обновлением токенов владеет сам Codex. В `app_state` сохраняются лишь идентификатор профиля, маскированная подпись, хеш идентичности, план и состояние подключения — без OAuth/access/refresh token, полного email и одноразового кода. Незавершённый вход после рестарта становится `Sign in required`, завершённый профиль снова проверяется и остаётся доступен.

Повторный вход в существующую строку обязан вернуть тот же аккаунт: другой аккаунт отклоняется и не заменяет идентичность строки. Уже подключённый в другой строке аккаунт также не дублируется. Logout затрагивает только выбранный Codex home; удаление дополнительного профиля удаляет его изолированную авторизацию, но основной профиль удалить нельзя.

Ответ содержит `used_percent`, тогда как chip показывает remaining. Инверсия `100 - used` выполняется только renderer'ом. Окна распознаются по реальной длительности (`limit_window_seconds` / `window_minutes`), а не по позиции `primary/secondary`; тот же duration mapping используется при сравнении reset-generation. Сервер уже возвращал дополнительные daily/monthly/model-specific buckets, поэтому неизвестное окно остаётся неизвестным и не подписывается ложным `5-hour` или `Weekly`.

Успешный `wham/usage`, в котором присутствуют оба позиционных поля, одно содержит распознанное окно, а второе явно равно `null`, является авторитетным полным набором: отсутствующее семантическое окно очищается, а не дополняется старым значением. Если поле действительно пропало из JSON или ответ невалиден, это `unknown`: сохраняется предыдущий verified snapshot и показывается stale/error. Так различаются `absent`, `used_percent: 0`, `used_percent: 100` и network failure. Пустая строка, whitespace и boolean не означают `0% used`.

`additional_rate_limits[]` разбирается независимо и с тем же duration mapping; malformed, unknown-duration и duplicate элементы отбрасываются, не ломая основной snapshot. Список остаётся в account-bound snapshot и anti-flap comparison, но desktop-popover не строит из него Spark weekly/5-hour строки.

После исчерпания обычного лимита Codex CLI может переключиться на Luna Reserve
fallback ([OpenAI changelog](https://learn.chatgpt.com/docs/changelog)); `max` в
подписи — уровень усилия модели, не размер квоты. Основные weekly/5-hour строки
toolbar не являются доказанной квотой Reserve. Если источник отдаёт для него
отдельное окно, текущий desktop-popover его всё равно не рисует; если не отдаёт,
процент Reserve нельзя восстанавливать из обычного лимита или факта доступности
модели. `plan_type`/`Connected` дают маркировку плана и состояния входа, но не статус оплаты,
срок повторного списания или гарантированную дату прекращения подписки.

Web-кабинет читает оплату отдельно: `subscriptions` отдаёт `is_delinquent`, а
`payments/transaction-history` — invoice `status:due|paid|void` и дату создания
счёта. Эта дата **не** является временем первой отклонённой попытки банка;
nullable `grace_period_end_timestamp` не даёт права обещать срок отключения.
Codex app-server `account/read` содержит лишь `type,email,planType`, а в OAuth
JWT нет billing status. Live-проверка24.09: ChatGPT web bearer прочитал данные,
но тот же subscription GET с Codex OAuth получил403; transaction-history с
Codex OAuth сначала вернул200, затем HTML403. Проверка30.09 различила транспорт
и права: Node fetch к `/accounts/{id}/remaining_balance` получил HTML403 с
`cf-mitigated: challenge`, а браузер MCP и Electron `net.fetch` с тем же Codex
OAuth получили JSON200. Через `net.fetch` подтверждён также `subscriptions`
для текущего Codex-профиля. Это не требует отдельного web-login и не позволяет
выводить конец подписки из отказа оплаты: `has_active_subscription` и
`is_delinquent` могут одновременно быть true; nullable billing timestamps
сохраняют неизвестность даты первой неуспешной попытки и grace-period.

Баланс Codex берётся из того же `wham/usage` и показывается только при `has_credits`, положительном balance или unlimited. `credits.balance` — **количество usage credits**, не USD: desktop форматирует число без валютного знака. Прод-шрам30.09: OpenAI вернул `balance: "62500"` обоим подключённым аккаунтам, а прежний `Intl.NumberFormat(currency: USD)` ложно показал `62 500 $`. Отдельный DTO уже отдавал kind `codex` без валюты. `code_review_rate_limit` не является core OAuth-источником и сейчас не рендерится. Инвентарь сбросов читается один раз на refresh соответствующего подключённого профиля через `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` либо официальный app-server fallback. Строка `Usage resets` остаётся видимой у подключённого профиля: показывает число доступных сбросов, `0 available` для доказанного пустого списка или `unavailable`, если optional источник не дал снимок. Детали содержат только доступные и ещё не истёкшие элементы; сохраняются только title и `expires_at`, без id/profile/description. Ошибка optional источника не ломает проценты. Результат применяется только после повторной проверки account+token; mutable inventory не сохраняется между рестартами.

### Применение сброса через официальный Codex app-server

Информационная строка `Usage resets` и read-only HTTP не означают, что сам Codex не умеет применить сброс. [Официальный app-server](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt) имеет `account/rateLimitResetCredit/consume`: операция относится к авторизации выбранного Codex home, не к терминальной вкладке. Отдельной обёртки Terminal MCP и desktop redemption action сейчас нет.

Перед списанием проверь аккаунт через `account/read` и доступность через `account/rateLimits/read`. Обязательный `idempotencyKey` сохраняется для одной логической попытки, включая восстановление неизвестного исхода; необязательный `creditId` выбирает конкретный сброс, иначе выбирает сервер. `reset`/`alreadyRedeemed` требуют повторного чтения лимитов; `nothingToReset`/`noCredit` не подтверждают сброс. Проверка06.10: после явного поручения пользователя consume выбранного `creditId` через официальный app-server вернул `reset`; повторное чтение показало weekly used100%→0%, availableCount2→1 и отсутствие списанного элемента среди available. Terminal MCP и терминальные вкладки не использовались.

Дата выбора сброса — локальная дата `expiresAt`, а не UTC-день: в этой проверке «23 октября» в Bangkok соответствовало `2026-10-22T20:53:09Z` (23.10 03:53). App-server отдаёт epoch seconds, HTTP inventory — ISO с миллисекундами; совпадение одного сброса сверяй с учётом точности секунд. Не путай expiration сброса с новой датой reset окна или сроком usage credits.

### Единица кредитов и промо-баланс Pro200 — проверка30.09

[Правила OpenAI для personal credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans): сначала included usage, затем credits для доступных Codex/Work и других поддерживаемых agentic features. Это не API credits, не наличные и не переносимый между аккаунтами баланс. Автопополнение отдельно покупает новые credits; оно не определяет расход уже имеющихся. `approx_local_messages`/`approx_cloud_messages` в `wham/usage` — оценки числа сообщений, не отдельные квоты и не фиксированная стоимость одного prompt.

[Опубликованное письмо OpenAI29–30.09](https://www.reddit.com/r/OpenAI/comments/1wtlpx7/its_been_a_good_run/) описывает разовую выдачу существующим Pro200:62 500 credits с номинальной стоимостью$2 500, истекающие31.12.2026, в связи с переходом20×→10× Plus для Work/Codex с30.10. Старый allowance до29.10 подтверждён также [официальной страницей Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers). Совпадение суммы/плана/даты с live-балансами — основание связать их с этой выдачей, но `wham/usage` не отдаёт происхождение или expiry credit grant. Не переносить дату этой акции на любые credits: купленные credits имеют собственный12-месячный срок. Даты в `Usage resets` принадлежат другим сущностям и не являются сроком `credits.balance`.

### Понижение подписки и уже выданные промо-кредиты — research08.10

Разделяй сохранение баланса, право расходовать его и доступ к моделям.
Gift62 500 не является переносом Pro entitlements. По [официальной доступности
моделей](https://learn.chatgpt.com/docs/models) GPT-6.1 Sol включён
вPlus/Pro rollout, Free/Go не включены; [pricing](https://learn.chatgpt.com/docs/pricing)
даётPlus Codex/credit overflow иAstra usage estimates, Free —Luna desktop.

Raw Reddit08.10 даёт подтверждения сохранения именно этого grant:
[автор процитировал письменный ответ Support02.10](https://www.reddit.com/r/ChatGPTPro/comments/1wvdhuu/has_anyone_kept_the_62500_promo_credits_after/pdg4w0i/): unused credits неотзываются приdowngrade, expiry31.12.2026 не продлевается привозврате.
Это опубликованный пересказ поддержки, не независимо проверенное публичное
условие акции. [Другой автор тоже сообщил ответ Support](https://www.reddit.com/r/codex/comments/1wu6j56/if_i_downgrade_from_pro_200_to_plus_do_i_keep_the/).
[Реальный Plus case05.10](https://www.reddit.com/r/ChatGPTPro/comments/1wygfu0/sitting_on_62k_credits_downgrade_to_plus_or_jump/pe2hc8b/): автор сообщил списание$20 иAstra; просмотренный screenshot показываетPlus$20 и62 435 credits.
[После отмены/возврата наPlus](https://www.reddit.com/r/codex/comments/1wy98fy/how_to_use_credits_after_cancelled_sub/pe11j93/) другой пользователь сообщил, чторасходование работает.

[Free case07.10](https://www.reddit.com/r/codex/comments/1wzr38a/how_to_use_61_with_credit_on_free_planjust_cancel/) имеет screenshots62 500 balance иpicker6Luna/5.6Terra/5.6Luna без6.1Sol.
Наличие денег наэкране само по себе не доказывает расходование наFree:
рассказы расходятся постарым моделям/eligibility, полноценный Pro model set
кредитами не открывается. ДляSol6.1/Astra практический путь —Plus иостаток
gift послеincluded usage. Не выдавай единичное заявление обоставшемся Pro200
allowance наPlus заправило: screenshot93%left не доказывает коэффициент20×.

### Точная дата кредитов: account-scoped remaining_balance

Desktop читает `GET /backend-api/accounts/{account_id}/remaining_balance` через
Electron `net.fetch` с тем же Codex OAuth и без cookies. Ответ содержит `balance`
и `expiring_balance_details[]` с `amount_remaining`, `expiry_date`, `grant_type`.
Live30.09: оба исследованных аккаунта дали62500 promotional credits и
`expiry_date: 2027-01-01T00:00:00Z`. UI использует точный timestamp в локальном
часовом поясе: в Bangkok это01.01.2027 07:00;31.12 в письме — последний день
до UTC-границы, не причина жёстко прописывать такую дату всем балансам.
Строка срока Codex credits заканчивается `— пт`: двухбуквенный русский день
недели вычисляется по той же локальной дате. Формат дат Full reset сохранён.

Запрос optional и параллелен основному usage: physical abort4с, success-cache25с,
ошибка/cooldown60с и server Retry-After, coalescing по account+token. Результат
проходит прежний post-request auth guard. Без свежего снимка с тем же balance
строка показывает `expiry unavailable`; неизвестность срока не меняет проценты
или количество credits. Если разные пакеты имеют разные даты, показывается
количество credits ближайшего истекающего пакета; весь balance подписывается
одной датой только при совпадении суммы. `credit_expiration` — runtime-only
account field desktop IPC; в persisted usage и публичный HTTP DTO не добавлен.

Старое20× определяется eligibility старого Pro200 при активной подписке, а не
месяцем очередного списания. Официальная справка явно описывает восстановление
после lapse в7 дней до cutoff; разрыв5→10 октября после cutoff отдельно не
гарантирован. Не объявлять ни автоматическую потерю20×, ни сохранение20× в таком
будущем сценарии по одному `plan_type:pro` или наличию промо-кредитов.

Network-path имеет физический `AbortController` deadline15s, Codex renderer-level IPC deadline25s (SOURCE08.10), один in-flight запрос на auth fingerprint и25s success-cache. Внешний предел оставляет время на15s сеть, profile auth и3s branch verification; Claude/Activity сохраняют12s. Force refresh обходит success-cache, но не account guard или серверный Retry-After и сам по себе не запускает тяжёлый локальный scan. Он также не ждёт другие профили: scope определяется requested/current account до сетевого шага. Auth перечитывается перед применением любого результата; если account/token сменился во время запроса, старый успех и старая ошибка не могут записаться в новый аккаунт, а запрос один раз повторяется с уже готовой новой auth snapshot. Сам Noted Terminal не расходует общий refresh token: при `401/403` без внешней rotation сохраняется последнее значение и показывается `Codex login expired`, чтобы не получить cross-process `refresh_token_reused` race с живым Codex CLI.

Причина расширения08.10: за10минут incident-window вproduction один аккаунт
имел4timeout/8success с median успешного ответа4,1s и max7,1s; соседний —20success,
median0,6s и без отказов. Полный обрыв интернета этим не подтверждается, но
прежний8s предел мог обрывать медленные запросы.15s — терпимость к задержке,
не доказанное устранение её первопричины;30s clock/60s cooldown не изменены.
Вfailure-log добавлены phase/durationMs/headersMs/timeoutMs/HTTP status без
секретов: waiting-headers не различает DNS/TLS/ожидание серверной обработки;
reading-body соstatus200 доказывает, что HTTP-ответ уже начался. Abort во время
response.json больше не подменяется invalid_response. Контролируемый реальный
Node HTTP/Abort proof подтвердил оба этапа;9s success/default15s и внешний25s
проверены actual-reader тестами. Production этой правкой не устанавливался.

Прод-шрам 2026-07-10: `/backend-api/wham/usage` может для одного и того же `account_id` вернуть успешный HTTP 200 с нормальным расходом, через несколько секунд — почти `0% used` и сдвинутым reset, а следующим ответом снова вернуть исходную ветку. Это upstream-флап, а не смена аккаунта и не повод показать пользователю `99/100% left`. Кандидатом становится именно возвращение заметной части бюджета до наступления прежнего reset; движение будущего reset вперёд при неуменьшающемся used — нормальное свойство rolling-window и принимается сразу. Раньше reset-drift сам по себе считался сменой ветки: production держал shown `used=9%` при последовательных candidate `15/16%`, а затем прыгнул на `17%`. Фоновый по-настоящему подозрительный кандидат принимается только после второго совпавшего ответа той же ветки не раньше чем через 30s либо сразу после того, как предыдущий reset действительно наступил. Явный `Refresh` только для такого кандидата делает ещё два коротких запроса и принимает совпавшее большинство; обычный рост used остаётся одним запросом. Возврат прежней ветки снимает кандидата.

До восьми последних verified OpenAI snapshots сохраняются между рестартами приложения через существующий `app_state`. Persisted shape содержит только маскированную подпись аккаунта, нормализованные основные/model-specific окна, безопасный credit balance и время снимка/попытки; reset-credit inventory, OAuth token, refresh token, auth fingerprint, полный email и raw account id туда не попадают. После рестарта current default и подключённые managed-профили запускают независимые фоновые проверки без ожидания выбора в меню. Снимок managed-аккаунта не становится stale только потому, что CLI сейчас использует другой login: stale определяется ошибкой/warning, возрастом и подтверждением после рестарта. Отключённый historical аккаунт остаётся stale. Неподключённые старые аккаунты сразу доступны как historical stale snapshots. Успешный OpenAI snapshot старого аккаунта не должен провоцировать локальный scan только из-за того, что он stale.

Renderer больше не опрашивает `refreshing=true` каждые 1.5s. Один `invoke` обязан закончиться success/error/timeout; старый результат отбрасывается generation/context guard'ом после смены аккаунта, вкладки или размонтирования. Во время запроса старые проценты остаются на экране, а иконка того же compact-face вращается без изменения ширины. После ошибки рядом показываются `Source`, возраст снимка и `stale`; spinner всегда прекращается.

08.10 пользователь уточнил: ошибка последнего чтения должна быть состоянием
самой `refresh`, а не отдельной строкой, растягивающей меню. Для обоих
провайдеров кнопка в detail остаётся красной до успешного снимка выбранного
аккаунта; полная причина доступна в title/aria. Повторная попытка вращает те же
стрелки и показывает `updating`, сохраняя цвет прошлого отказа. Переключение
на здоровый аккаунт показывает его обычную кнопку, а фоновый успех другого
аккаунта не снимает ошибку выбранного. Последние проверенные числа остаются
видимыми; Source, возраст и `stale` описывают их свежесть. `Connected · pro`
означает подтверждённую авторизацию/план, не успешное чтение лимитов.

В compact-face прежний короткий красный сигнал примерно на1с сохранён:
он относится только к текущему CLI login, повтор той же ошибки/attempt из
cooldown-кэша не мигает снова. `success:true` IPC может вернуть сохранённые
проценты вместе с `lastError`: это успешно прочитанное состояние, а не
успешное обновление; renderer log больше не пишет `refresh ok` для такого
ответа. Успешное чтение с теми же процентами снимает красный detail; anti-flap
warning не считается ошибкой запроса. Старый ответ прежнего account context
не меняет новый экран. Причина задержки сети не устанавливается по одному
сообщению timeout: оно доказывает превышение deadline (8s втомproduction
инциденте), не потерю подписки.

Мультиаккаунтность разделяет подключённые профили и исторические снимки. Каждый подключённый профиль обновляется через собственную доказанную авторизацию; неподключённый аккаунт показывает последний snapshot и помечается stale. Активная вкладка может обновить выбранный аккаунт только при совпавшем account key. Совпавший `sourceThreadId` допустим как fallback лишь когда identity активной сессии неизвестна; если identity известна и отличается, общий thread id не является доказательством принадлежности. Неизвестную identity запрещено приписывать основному `auth.json` только потому, что sample записан после login timestamp: старая вкладка аккаунта A продолжает писать после переключения на B.

В переключателе аккаунтов зелёная точка означает подключённую живую авторизацию Codex; у нескольких подключённых профилей она может быть одновременно. Historical аккаунты имеют серую точку и stale-status; выбранность показывается рамкой и не меняет состояние подключения. В строках `Weekly left` и `5-hour left` длина цветного заполнения равна **оставшемуся** проценту, поэтому `81% left` занимает 81% шкалы, а `0% left` оставляет только тёмный track. Цвет текста/заполнения по-прежнему определяется срочностью по использованному проценту: зелёный при большом остатке, красный у исчерпания.

`~/.codex/logs_2.sqlite` остаётся только редким discovery/fallback для аккаунтов без сохранённого OpenAI snapshot. При успешном ответе OpenAI не стартует ни account scan, ни чтение rollout активной вкладки: server result не зависит от размера локальной истории. Fallback активной сессии читает с конца максимум 16MB JSONL вместо полного файла; поиск identity ждётся не больше 1s. Scan нужен только когда для запрошенного account key ещё нет verified server snapshot, не участвует в состоянии `updating`, не запускается force-refresh'ем сам по себе и после success/failure имеет 6h cooldown. Это важно ещё и потому, что новые версии Codex пишут `codex.rate_limits` в другом log shape (`target=log`, часто без `thread_id`), поэтому старый websocket scanner может вернуть `count=0` даже при наличии свежих rate events.

Прод-шрам 2026-07-10: `logs_2.sqlite` вырос до 1.7GB / 661k rows. Каждый scan упирался в `sqlite3` timeout 15s; renderer видел `refreshing=1`, повторял IPC через 1.5s и после каждого failure немедленно запускал новый scan. Параллельно selected `fr***` получал active rollout `ve***`, потому что код считал одинаковый `sourceThreadId` достаточным даже при уже доказанном несовпадающем account key. Симптом: вечный `updating` и флап процентов при смене вкладки. Оба поведения запрещены: local failure terminal до cooldown, known account mismatch всегда выигрывает у thread fallback.

Диагностика: main пишет `[CodexData] remote usage accepted|pending|confirmed|obsolete|failed account=... candidate=... shown=... durMs=...`; `candidate/shown` включают used и reset каждого окна. Итоговый `[CodexData] get-usage ...` показывает selected account/source, а `[CodexUsage:Stages]` — request reason, target scope и раздельные network/profile времена. Renderer пишет и отображаемый, и фактически обновлённый account. Сначала сверяй account/source/timestamp, а не Timeline: Timeline отвечает «какой snapshot был у хода», toolbar — «какой последний доказанный budget выбранного аккаунта».

Не пересчитывать Codex лимит из `last_token_usage.total_tokens`. Локальные токены не равны провайдерскому quota%, потому что provider применяет собственную формулу и reset-бакеты. Конкретика Codex JSONL — [`fact-codex.md`](fact-codex.md).

### Расход отдельной Codex-сессии — protocol proof09.10

УстановленныйCLI0.159.2 имеет `account/usage/read({threadId})` иnullable
`threadUsage` уже вобычной generated schema, не толькос--experimental.
Это расширение [account token activity](https://learn.chatgpt.com/docs/app-server):
estimatedUsageCreditsMicros (делитьна1e6), nullableUSD иgroups помодели,
reasoningEffort/speed, input/cached/netNewInput/output/total tokens. Это оценка
расхода сессии, не квитанция списания credits. Schema не отдаёт еёweekly quota
percent ине имеет параметров временного диапазона; окно такойоценки отдельно
нужно подтверждать. [/usage weekly](https://learn.chatgpt.com/docs/developer-commands)
документирован какaccount token activity, не процент недельного лимита вкладки.

Live read подfr***Pro: account-wide activity работает (summary+102daily buckets),
ноcurrent canonicalSID и3fresh native IDs вернулиthreadUsage:null. Повтор
послеmetadata-only thread/read подтвердилid==sessionId иоставилnull; никаких
Resume/turn/input/login actions не было, собственныеhelpers закрыты. Причина
отсутствия thread estimate не установлена; schema допускаетnull при отсутствии
billing route. Не объявлять общий отказ API, rollout илинулевой расход.
ВNotedэтотновыйметод пока не подключён. Если показыватьfuture per-tab cost,
сохранятьestimate/null иexactaccount/session binding; не распределять общий
quota% пропорциональноtokens/credits. Протокольный proof:
`/private/tmp/noted-per-session-usage-20261009.qmutdrr2/`.

## Источник данных per-tab tokens: JSONL агрегирование (backend сохранён, UI скрыт)

Backend — [`ipc/claude-tokens.js`](../../src/main/ipc/claude-tokens.js), IPC `claude-tokens:summary { sessionId, cwd }`. Не переизобретаем — используем `resolveSessionChain` из [`claude-data.js`](../../src/main/ipc/claude-data.js), который и так умеет ходить по resume-цепи через bridge entries + SQLite session_links. Это критично: после `claude --resume` транскрипт расползается по 2-5 JSONL-файлам, считать токены по одному файлу = пропустить большую часть истории. См. CLAUDE.md anti-pattern «Разница sessionId в одном JSONL ≠ bridge».

В каждом assistant-record'е есть `message.usage`:
- `input_tokens` — свежий ввод (не из кэша)
- `cache_creation_input_tokens` — записано в кэш (≈1.25× от input rate)
- `cache_read_input_tokens` — прочитано из кэша (≈0.1× от input rate)
- `output_tokens` — ответ
- `message.model` — какая модель листала

Edit-range / fork ломают cache — следующий после правки turn автоматически имеет высокий `cache_creation` и низкий `cache_read`. Это **уже отражено в записях**, нам ничего считать не нужно — просто суммируем фактический биллинг.

## Active branch vs Total billed — почему две цифры

Это принципиально разные ответы на разные вопросы пользователя. Когда юзер редактировал историю через edit-range/fork, эти две цифры расходятся.

| Метрика | Считается по | Отвечает на вопрос |
|---|---|---|
| **Active branch** | backtrace по `parentUuid` от последнего record'а | «Сколько стоит проиграть текущую историю с нуля?» — показывает эффективность работы с cache, отражает то что юзер видит в Timeline |
| **Total billed** | все записи в файлах chain'а | «Сколько я фактически списал?» — Anthropic не возвращает деньги за удалённые turn'ы |
| **Wasted** | Total − Active | «Сколько ушло на эксперименты, которые потом откатил» |

При возможном возврате секции `Total billed` должен отображаться только если отличается от `Active branch` больше чем на $0.01 — для нерастущих в файле сессий это шум. `Wasted` — оранжевым, как индикатор «есть смысл следить».

## Pricing-таблица (Anthropic, состояние май 2026)

В минор-rate'ах (за миллион токенов, USD):

| Модель | input | output | cache_write | cache_read |
|---|---|---|---|---|
| Opus | 15.00 | 75.00 | 18.75 | 1.50 |
| Opus 1M (>200k input) | 30.00 | 150.00 | 37.50 | 3.00 |
| Sonnet | 3.00 | 15.00 | 3.75 | 0.30 |
| Haiku | 0.80 | 4.00 | 1.00 | 0.08 |

`opus[1m]` family при `input_tokens > 200_000` биллится в 2× по сравнению с обычным Opus — model string смотрим целиком, не семейство. Реализация — `classifyModel(modelStr, inputTokens)` в `claude-tokens.js`.

Для Max-подписки прямого $-смысла нет (трата покрыта планом), но **относительная** цифра между вкладками полезна — даёт сравнить «эта вкладка съела 3× больше Opus-токенов чем та». Так что показываем $ всегда, не прячем под `is_enabled extra_usage`.

## Три уровня pin popover'а

Юзер: *«при смене вкладок и при смене проектов у меня она не должна пропадать»* — про sticky-pin режим.

| Активация | Тип | Закрытие |
|---|---|---|
| Click по чипу | **Light pin** — закреп к **текущему табу** | Click-outside / Esc / смена активной вкладки |
| ⌘ зажат + наведён на чип | **Transient peek** | Курсор увели с чипа и popover'а; ⌘ отпущен |
| ⌘⇧ нажат при открытом popover'е | **Sticky pin** (белая рамка) | Только повторный ⌘⇧ или клик по самому чипу |

В текущем UI sticky-режим не содержит tab-зависимой секции: закреплённое окно показывает выбранного провайдера, его аккаунт и общий `Activity`.

Нижняя строка popover'а остаётся на месте в обоих режимах pin. Справа она показывает `⌘⇧ to pin across tabs` или `Pinned across tabs · ⌘⇧`, поэтому подсказка меняется, а строка не исчезает. Слева две серые SVG-иконки включают/выключают компактные чипы в шапке **и соответствующие default model/effort кнопки StatusBar**. Обе поверхности подписаны на общий `useUsageVisibilityStore`; это видимость, сохранённые defaults и текущая модель не меняются. Выбранный провайдер, его аккаунты, лимиты, обновление и общий `Activity` остаются в popover'е. Скрытый чип не размонтирует источник данных. Если скрыты оба, в шапке остаётся нейтральная кнопка для открытия того же popover'а и возврата чипов. Выбор не привязан к вкладке и переживает перезапуск через прежний `noted-terminal-usage-visible-providers` в SQLite-mirrored UI storage; по умолчанию оба чипа видны.

**Trap:** общий click-outside handler не должен закрывать sticky. Иначе клик по TabBar закрывает окно в тот момент, когда пользователь пытается проверить другую вкладку, и режим теряет смысл. Click-outside и Esc закрывают light pin; sticky снимается только явным жестом.

## Исторический контракт «This tab» (frontend сейчас скрыт)

Юзер: *«состояние раскрыто/свернуто не должно сохраняться если я закрыл бар»*. Раскрытое состояние секции сохраняется только пока popover открыт (можно пересекать вкладки в sticky-pin режиме — раскрытое остаётся). При полном закрытии popover'а (click-outside, Esc, повторное снятие sticky) — сбрасывается. Нет localStorage / SQLite persistence. Аналогично — `methodology/дизайн-принципы.md::Expanded-state дочерней секции — ephemeral`.

Применимо потому что «This tab» — лёгкая опт-ин информация, не core-фича. Юзер открывает popover каждый раз для актуальной % картинки, разворачивание токенов — отдельный жест. Persistance заставила бы раскрытую секцию мозолить глаз тем кто заглядывает на 2 секунды посмотреть %.

## Color thresholds и мягкость рамок

Чип в idle-состоянии — прозрачный border, текст в цвет порога. При любом open (включая transient peek) — мягкий фон `${color}0A` (4% opacity) и border `${color}33` (20%). Раньше было `0x1F`/`0x66` — юзер попросил «менее яркой сделай»: чип в правом конце toolbar'а не должен крепко конкурировать с активным табом в TabBar за визуальное внимание.

Sticky-pin — единственное состояние с **заметной** рамкой: `rgba(255,255,255,0.4)` на чипе и `0.45` на popover'е. Это не путается с обычным open — sticky редкий жест, должен быть отличим с одного взгляда.

## Daily history: SQLite snapshots, не реконструкция (frontend сейчас скрыт)

Расход по дням хранится как append-only снимки того же источника, который был принят для чипа: официальный statusLine или подтверждённый OAuth usage. Локальные JSONL-токены не реконструируют провайдерскую квоту, потому что формула Anthropic непублична.

Каждая строка обязана иметь `account_key`. Запрос истории всегда передаёт выбранный Claude account key; старые строки с `NULL` остаются в базе как legacy evidence, но не показываются ни одному аккаунту. Снимок записывается только после принятия значения: cache-hit, отклонённый ответ и ожидающий подтверждения скачок историю не загрязняют. Prune отсутствует.

## Reset detection: смена дня в `resets_at`

Anthropic ротирует weekly-бакет раз в неделю. После reset `weekly_pct` падает с большого числа к маленькому (например 80% → 5%), а `resets_at` в ответе указывает на **новый** следующий момент ротации — на 7 дней вперёд. Без specific детекта `delta` за день перехода взяла бы negative число и `Math.max(0, …)` обнулила бы «расход» в самый активный день недели.

Сравнивается **только дата** (`YYYY-MM-DD` через `String(s).slice(0, 10)`) в `weekly_resets_at`. Если она поменялась между двумя соседними snapshot'ами — бакет ротейтнулся, `wasReset=true`, новый baseline = `postResetStart` = первый weekly после ротации. Реальные ротации всегда пересекают календарный день, jitter в нижних разрядах строки не пересекает никогда.

Стратегия №2 — **drop > 10 п.п.** между соседними snapshot'ами — fallback на случай отсутствия `resets_at` (NULL в seed-точках) или если Anthropic ratejitter'ил сам день. Срабатывает редко, но дёшево держать как safety-net. 10 п.п. — компромисс: 5 даст false-positive на естественной флуктуации между cache-tier'ами, 20 пропустит low-utilization недели. На графике день с reset'ом получает белый risk-маркер 2px на правом крае бара.

**Graveyard.** Раньше сравнивались **сырые строки** `weekly_resets_at !== prev`. Это ловушка: Anthropic возвращает строки с **микросекундным jitter'ом** (`…59.742063+00:00`, `…59.752255+00:00`, `…59.771822+00:00`) даже когда бакет один и тот же. Каждый snapshot выглядел как новый reset, `postResetStart` переписывался последним значением, `baseline = последний weekly`, `delta = dayMax - lastWeekly` — почти всегда 0-2% вместо реальных 10-15%. Попытка фикса через bucketing до минуты (`Math.floor(t/60000)`) ломалась на границе секунды: Anthropic иногда отдавал `T00:59:59.x`, иногда `T01:00:00.x` — два разных бакета внутри одной минуты. Bucketing до часа тоже отвергнут — это уже не нормализация jitter'а, а домыслы про шаг реальных ротаций, юзер прямо сформулировал *«никаких часов нахуй... ты опять костыли пишешь»*. Срез до дня — это **доменная единица** ротации (реальные resets раз в неделю, никогда не суб-дневные), а не произвольная гранулярность.

## Cold-start fallback + error cooldown

До восьми нормализованных account snapshots живут в `app_state`, поэтому после рестарта исторические аккаунты появляются сразу как `stale`. Текущий login всё равно заново подтверждается через CLI; сохранённый токен или Keychain сам по себе не назначает аккаунт текущим. SQLite fallback допускается только по совпавшему account key.

Обычный Claude-путь event-driven: новый statusLine снимок приходит после ответа Claude и через существующее событие инициирует чтение актуального account-state. Для OAuth-аккаунта сетевой снимок обновляется целиком после истечения cache; более частые statusLine-события лишь поддерживают отдельный резерв и не меняют время OAuth-снимка. Visibility refresh и редкий десятиминутный fallback обнаруживают внешний login/logout, но не превращают managed login в сетевой polling `/oauth/usage`. Для настоящего OAuth действуют cache, error cooldown и `Retry-After`; manual refresh не может пробить server backoff.

Старые числа остаются на экране во время запроса. `Source`, возраст и `stale` показывают их качество; отказ usage обозначается красной `refresh` с причиной при наведении, без отдельной строки. Codex usage имеет25s IPC deadline, Claude usage/Activity —12s; каждый новый контекст отменяет право старого ответа обновлять экран.

## Baseline дня = последний snapshot предыдущего дня

`delta` за день = `dayMax - baseline`, **не** `max - min within day`. Причина — между днями есть «разрыв» в записях (ночью polling может быть выключен — устройство спит, chip скрыт), и `min внутри дня` может попасть на 09:00 после ночного сна, когда уже накопилось 3% утренней работы. Тогда delta потеряла бы эти 3%.

Baseline = последний snapshot **предыдущего** local-дня (не UTC) — что юзер видел как «накопилось к моменту когда лёг спать». Если день первый в истории (нет prev-дня) — baseline = первый snapshot этого дня. Если день был reset'нут — baseline = post-reset value (см. секцию выше).

Local-date, не UTC: юзер думает о расходе «вчера vs сегодня» в своей таймзоне (MSK сейчас, может смениться при переезде). UTC-bucket дал бы баг типа «MSK 02:00 пишется как новый день, юзер ещё за ноутом» (UTC уже сменилась в 03:00 предыдущего вечера). Bucketing — через `new Date(ts*1000).getDate()` локального процесса.

## Проверенные внешние источники (2026-07-24)

- [Claude Code status line](https://code.claude.com/docs/en/statusline) — официальный контракт `rate_limits`, момент появления и nullable windows.
- [Claude Fable 5 on your plan](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan) — Fable на подходящих Max/premium планах расходует общий weekly limit и ограничен до 50% этого лимита, а не добавляет новую weekly quota.
- [Claude Code authentication](https://code.claude.com/docs/en/authentication) — поддерживаемые виды login; subscription quota и API Platform limits не одно и то же.
- [CodexBar provider docs](https://github.com/steipete/CodexBar/blob/main/docs/providers.md) и [Claude OAuth fetcher](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift) — сравнение OAuth/web/CLI/local fallback, обработка `Retry-After` и пример `limits[]` с model-scoped окнами.
- [Claude Code #24317](https://github.com/anthropics/claude-code/issues/24317) — гонка rotating refresh token между параллельными Claude-процессами; причина не обновлять CLI-owned credential.
- [Claude Code #29579](https://github.com/anthropics/claude-code/issues/29579) и [#54750](https://github.com/anthropics/claude-code/issues/54750) — реальные расхождения/скачки usage meter; причина хранить source/timestamp и подтверждать резкую регрессию.

## Связанные документы

- [`fact-agent-activity.md`](fact-agent-activity.md) — «Activity» секция в этом же popover'е: сколько времени агенты реально работали (loader-on интервалы), агрегировано by day/project/tab. Хостится здесь для Claude и Codex popover'ов, но capture-логика и таблица — отдельная подсистема.
- [`fact-status-bar.md`](fact-status-bar.md) — где живут другие toggle'ы. Лимитный chip намеренно вынесен оттуда: status bar = глобальные toggle'ы, не привязанные к табу; usage chip session-aware (читает `getEffectiveTabId`).
- [`fact-claude-sdk-tab.md`](fact-claude-sdk-tab.md) — отдельный context-%-meter для SDK табов читает usage из live SSE stream'а, не из JSONL на диске. Это два разных потока: SDK-meter — мгновенный отклик на конкретное message_start, chip — устаканенное число для всех табов проекта.
- [`methodology/сценарии-багов-design.md`](../methodology/сценарии-багов-design.md) секция 4 — click-outside ловушки.
- [`methodology/дизайн-принципы.md`](../methodology/дизайн-принципы.md) секция «Историю провайдерского ресурса храним как снимки источника» — переносимый принцип, обосновывает почему не пересчитываем из JSONL.
- Global `~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/всплывающие-окна.md::Закреп` — базовая механика ⌘⇧-pin'а.
