# Feature: Unified AI Usage (Claude + Codex)

Единый контрол в правой части шапки ([`WorkspaceTitleBarTools.tsx`](../../src/renderer/components/Workspace/WorkspaceTitleBarTools.tsx)), реализация — [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx). Слева постоянно виден Codex, справа Claude; половины соприкасаются без зазора и открывают один общий popover на нужном провайдере.

## Компактное лицо и общий popover

Codex использует slash-модель только для реально присутствующих окон: иконка, `weekly left + reset / 5-hour left + reset`. Если OpenAI явно не отдаёт 300-минутное окно, весь пятичасовой сегмент вместе с `/`, reset и accessibility-текстом отсутствует; следующий подтверждённый ответ с 300-минутным окном возвращает его автоматически. У Claude порядок расширен и фиксирован: иконка, `weekly left + reset / 5-hour left + reset / Fable left`. У Fable в компактном лице **нет отдельного времени reset**: это ограничение внутри недельного бюджета, а не самостоятельное третье окно. Процент означает **остаток**, а не расход: `54%` и заполнение на 54% описывают одно и то же. Цвет определяется срочностью по расходу: зелёный при большом остатке, затем жёлтый, оранжевый и красный у исчерпания. В компактном лице отдельной мини-шкалы нет.

Codex-иконка — inline SVG-глиф без белой app-плашки. Claude использует общий `ClaudeSparkle`. Countdown обновляется раз в минуту и остаётся видимым при закрытом popover.

Popover физически один и не размонтируется при смене провайдера. В первой строке слева находится двухпозиционный переключатель Codex/Claude, справа — история аккаунтов выбранного провайдера; у Codex рядом стоит иконка `+` для подключения нового профиля. Во второй строке находятся источник, возраст снимка, `current/stale`, состояние выбранного профиля, вход/выход и `refresh`. Отдельный каталог `Codex accounts` под шапкой запрещён: он дублирует те же аккаунты второй раз. Дублирующие email/reset-заголовок, строки `Plan` и отдельная строка `Source` также удалены. `Activity` принадлежит общему контейнеру, поэтому раскрытие и данные сохраняются при переключении Codex ↔ Claude. Высота ограничена окном, длинное содержимое прокручивается.

Текущий popover показывает лимиты выбранного провайдера и общий `Activity`. У Codex после основных реально присутствующих окон идут отдельные model-specific строки из `additional_rate_limits` (сейчас это Spark), затем ненулевой/unlimited Codex credit balance и доступные `Full reset` с точными датами истечения. Сбросы информационные: redemption action отсутствует. У Claude строки всегда идут в порядке `Weekly`, `5-hour`, `Fable`; у Fable не показывается отдельная дата сброса. Секции `This tab`, `By day (last 7d)` и Claude `Extra credits` на frontend не рендерятся. Расчёт токенов вкладки, дневные снимки и поле дополнительных кредитов в backend сохранены, чтобы их можно было вернуть без потери данных. Появление Fable не является причиной показывать `Extra credits`.

У Claude зелёная точка означает текущий логин CLI. У Codex она означает подключённый профиль, поэтому зелёными могут быть несколько аккаунтов одновременно; рамка по-прежнему показывает только выбранную строку. Неподключённый исторический аккаунт получает серую точку и `stale`. Смена аккаунта, вкладки или провайдера увеличивает поколение запроса: запоздавший ответ старого контекста не имеет права менять новый экран. Загрузки лимитов и `Activity` имеют renderer deadline и всегда завершают spinner.

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

## Источник данных Codex: тот же account API, что у web dashboard

Основной источник toolbar-чипа — `GET https://chatgpt.com/backend-api/wham/usage`. Это тот же JSON, из которого страница `chatgpt.com/codex/cloud/settings/analytics#usage` рисует карточки лимитов; DOM страницы не парсится. Для основного профиля запрос использует `access_token` и `account_id` из `~/.codex/auth.json`; дополнительный профиль использует собственный изолированный Codex home. Email ответа, если он есть, обязан совпасть с email соответствующего Codex auth; несовпадение — конечная ошибка, а не данные второго аккаунта. Ответный `account_id` находится в namespace пользователя и **не равен** request header `ChatGPT-Account-Id`; его можно сверять только с JWT claim `auth.user_id`, иначе каждый корректный ответ будет ложно отклонён.

### Троттлинг context-refresh: смена вкладки — не повод для сети

Identity `refresh` меняется при каждом переходе на вкладку с другой Codex-сессией, и effect с `[refresh]` в deps перезапускался на каждый tab switch — сетевой fetch usage + обход профилей в main (620мс-2с) прямо в окне переключения; ночной случай — остановка main-цикла на 5002мс при нулевом CPU, где usage был единственной активной операцией. Usage account-scoped и трёхминутный интервал его и так освежает; смена вкладки лишь уточняет fallback-идентичность сессии. Троттлинг: context-перезапуск в пределах 30с от последнего fetch пропускает немедленный вызов (`context-refresh throttled` в логе). Ручной refresh, смена аккаунта и интервал — без изменений. Внутри handler'а стоят пробы стадий `CodexUsage:Stages totalMs= remoteAndProfiles= ...` (печатаются при >250мс) — они разделяют сеть/профили, скан локального лога и привязку сессии, чтобы следующий медленный случай был атрибутирован фазой, а не гипотезой.

## Подключённые профили Codex: глобально, не по вкладкам

Основной профиль — обычный `~/.codex`, поэтому запуск `codex` без специального окружения продолжает использовать тот же логин, что и до этой фичи. Дополнительные аккаунты получают отдельные Codex home внутри `~/.noted-terminal/codex-accounts/`. Это глобальный список приложения: переход между проектами, закрытие вкладки и исчезновение сессии не переключают и не удаляют аккаунт. Уже запущенные Codex-вкладки не перепривязываются; выбор аккаунта в usage-popover меняет только просматриваемые лимиты.

Вход запускается через официальный Codex app-server в режиме device OAuth. Только на время входа под строкой источника появляется жёлтая панель с одноразовым кодом, сроком действия, отменой и сегментированной командой `Open browser | Copy link`; копирование кода или ссылки на короткое время заменяет иконку копирования зелёной галочкой. Одноразовый код и ссылка не сохраняются между рестартами; завершённая авторизация остаётся в изолированном Codex home, а обновлением токенов владеет сам Codex. В `app_state` сохраняются лишь идентификатор профиля, маскированная подпись, хеш идентичности, план и состояние подключения — без OAuth/access/refresh token, полного email и одноразового кода. Незавершённый вход после рестарта становится `Sign in required`, завершённый профиль снова проверяется и остаётся доступен.

Повторный вход в существующую строку обязан вернуть тот же аккаунт: другой аккаунт отклоняется и не заменяет идентичность строки. Уже подключённый в другой строке аккаунт также не дублируется. Logout затрагивает только выбранный Codex home; удаление дополнительного профиля удаляет его изолированную авторизацию, но основной профиль удалить нельзя.

Ответ содержит `used_percent`, тогда как chip показывает remaining. Инверсия `100 - used` выполняется только renderer'ом. Окна распознаются по реальной длительности (`limit_window_seconds` / `window_minutes`), а не по позиции `primary/secondary`; тот же duration mapping используется при сравнении reset-generation. Сервер уже возвращал дополнительные daily/monthly/model-specific buckets, поэтому неизвестное окно остаётся неизвестным и не подписывается ложным `5-hour` или `Weekly`.

Успешный `wham/usage`, в котором присутствуют оба позиционных поля, одно содержит распознанное окно, а второе явно равно `null`, является авторитетным полным набором: отсутствующее семантическое окно очищается, а не дополняется старым значением. Если поле действительно пропало из JSON или ответ невалиден, это `unknown`: сохраняется предыдущий verified snapshot и показывается stale/error. Так различаются `absent`, `used_percent: 0`, `used_percent: 100` и network failure. Пустая строка, whitespace и boolean не означают `0% used`.

`additional_rate_limits[]` разбирается независимо и с тем же duration mapping. Каждый валидный model-specific лимит получает собственные weekly/5-hour строки; malformed, unknown-duration и duplicate элементы отбрасываются, не ломая основной snapshot. Список входит в account-bound verified snapshot и anti-flap comparison, поэтому Spark одного аккаунта не может перейти к другому.

Баланс Codex берётся из того же `wham/usage` и показывается только при `has_credits`, положительном balance или unlimited. `code_review_rate_limit` не является core OAuth-источником и сейчас не рендерится. Инвентарь сбросов читается один раз на refresh выбранного подключённого профиля через `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` либо официальный app-server fallback. Строка `Usage resets` остаётся видимой у подключённого профиля: показывает число доступных сбросов, `0 available` для доказанного пустого списка или `unavailable`, если optional источник не дал снимок. Детали содержат только доступные и ещё не истёкшие элементы; сохраняются только title и `expires_at`, без id/profile/description. Ошибка optional источника не ломает проценты. Результат применяется только после повторной проверки account+token; mutable inventory не сохраняется между рестартами.

Network-path имеет физический `AbortController` deadline 8s, renderer-level IPC deadline 12s, один in-flight запрос на auth fingerprint и 55s cache. Force refresh обходит cache, но не account guard и сам по себе не запускает тяжёлый локальный scan. Auth перечитывается перед применением любого результата; если account/token сменился во время запроса, старый успех и старая ошибка не могут записаться в новый аккаунт, а запрос один раз повторяется с уже готовой новой auth snapshot. Сам Noted Terminal не расходует общий refresh token: при `401/403` без внешней rotation сохраняется последнее значение и показывается `Codex login expired`, чтобы не получить cross-process `refresh_token_reused` race с живым Codex CLI.

Прод-шрам 2026-07-10: `/backend-api/wham/usage` может для одного и того же `account_id` вернуть успешный HTTP 200 с нормальным расходом, через несколько секунд — почти `0% used` и сдвинутым reset, а следующим ответом снова вернуть исходную ветку. Это upstream-флап, а не смена аккаунта и не повод показать пользователю `99/100% left`. Подозрительная регрессия расхода или смена будущего reset сначала становится кандидатом; last verified snapshot остаётся на экране. Фоновый кандидат принимается только после второго совпавшего ответа той же ветки не раньше чем через 30s либо сразу после того, как предыдущий reset действительно наступил. Явный `Refresh` не оставляет пользователя с жёлтым промежуточным предупреждением: в рамках одного действия выполняются ещё два коротких запроса, совпавшее большинство принимает новую ветку сразу, а отсутствие большинства возвращает явную ошибку и сохраняет последнее проверенное значение. Возврат прежней ветки снимает кандидата.

До восьми последних verified OpenAI snapshots сохраняются между рестартами приложения через существующий `app_state`. Persisted shape содержит только маскированную подпись аккаунта, нормализованные основные/model-specific окна, безопасный credit balance и время снимка/попытки; reset-credit inventory, OAuth token, refresh token, auth fingerprint, полный email и raw account id туда не попадают. После рестарта каждый подключённый профиль заново проверяется и обновляется независимо, а неподключённые старые аккаунты сразу доступны как historical stale snapshots. Успешный OpenAI snapshot старого аккаунта не должен провоцировать локальный scan только из-за того, что он stale.

Renderer больше не опрашивает `refreshing=true` каждые 1.5s. Один `invoke` обязан закончиться success/error/timeout; старый результат отбрасывается generation/context guard'ом после смены аккаунта, вкладки или размонтирования. Во время запроса старые проценты остаются на экране. После ошибки рядом показываются `Source`, возраст снимка и `stale`; spinner всегда прекращается.

Мультиаккаунтность разделяет подключённые профили и исторические снимки. Каждый подключённый профиль обновляется через собственную доказанную авторизацию; неподключённый аккаунт показывает последний snapshot и помечается stale. Активная вкладка может обновить выбранный аккаунт только при совпавшем account key. Совпавший `sourceThreadId` допустим как fallback лишь когда identity активной сессии неизвестна; если identity известна и отличается, общий thread id не является доказательством принадлежности. Неизвестную identity запрещено приписывать основному `auth.json` только потому, что sample записан после login timestamp: старая вкладка аккаунта A продолжает писать после переключения на B.

В переключателе аккаунтов зелёная точка означает подключённую живую авторизацию Codex; у нескольких подключённых профилей она может быть одновременно. Historical аккаунты имеют серую точку и stale-status; выбранность показывается рамкой и не меняет состояние подключения. В строках `Weekly left` и `5-hour left` длина цветного заполнения равна **оставшемуся** проценту, поэтому `81% left` занимает 81% шкалы, а `0% left` оставляет только тёмный track. Цвет текста/заполнения по-прежнему определяется срочностью по использованному проценту: зелёный при большом остатке, красный у исчерпания.

`~/.codex/logs_2.sqlite` остаётся только редким discovery/fallback для аккаунтов без сохранённого OpenAI snapshot. При успешном ответе OpenAI не стартует ни account scan, ни чтение rollout активной вкладки: server result не зависит от размера локальной истории. Fallback активной сессии читает с конца максимум 16MB JSONL вместо полного файла; поиск identity ждётся не больше 1s. Scan нужен только когда для запрошенного account key ещё нет verified server snapshot, не участвует в состоянии `updating`, не запускается force-refresh'ем сам по себе и после success/failure имеет 6h cooldown. Это важно ещё и потому, что новые версии Codex пишут `codex.rate_limits` в другом log shape (`target=log`, часто без `thread_id`), поэтому старый websocket scanner может вернуть `count=0` даже при наличии свежих rate events.

Прод-шрам 2026-07-10: `logs_2.sqlite` вырос до 1.7GB / 661k rows. Каждый scan упирался в `sqlite3` timeout 15s; renderer видел `refreshing=1`, повторял IPC через 1.5s и после каждого failure немедленно запускал новый scan. Параллельно selected `fr***` получал active rollout `ve***`, потому что код считал одинаковый `sourceThreadId` достаточным даже при уже доказанном несовпадающем account key. Симптом: вечный `updating` и флап процентов при смене вкладки. Оба поведения запрещены: local failure terminal до cooldown, known account mismatch всегда выигрывает у thread fallback.

Диагностика: main пишет `[CodexData] remote usage accepted|pending|confirmed|obsolete|failed account=... candidate=... shown=... durMs=...` и итоговый `[CodexData] get-usage source=<openai-usage-api|active-session-rollout|codex-log|latest-rollout-unverified> ... refreshing=0 stale=<0|1>`. Renderer пишет тот же selected source/account. Сначала сверяй account/source/timestamp, а не Timeline: Timeline отвечает «какой snapshot был у хода», toolbar — «какой последний доказанный budget выбранного аккаунта».

Не пересчитывать Codex лимит из `last_token_usage.total_tokens`. Локальные токены не равны провайдерскому quota%, потому что provider применяет собственную формулу и reset-бакеты. Конкретика Codex JSONL — [`fact-codex.md`](fact-codex.md).

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

Хинт `⌘⇧ to pin across tabs` в нижней части popover'а появляется только пока не sticky.

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

Старые числа остаются на экране во время запроса. `Source`, возраст и `stale` показывают их качество, ошибка отображается отдельно. Загрузки лимитов и `Activity` имеют 12-секундный deadline; каждый новый контекст отменяет право старого ответа обновлять экран.

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
- Global `~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/tooltip-resize-modal.md::Закреп` — базовая механика ⌘⇧-pin'а.
