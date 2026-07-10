# Feature: AI Usage Chips (Claude + Codex)

Два цветных chip'а в [`ProjectToolbar.tsx`](../../src/renderer/components/Workspace/ProjectToolbar.tsx) слева от `DictationHistoryButton`, реализация — [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx). Claude-чип показывает **недельный % лимита** Anthropic Max-подписки, если текущий Claude Code auth — OAuth Max; если текущий auth — API Platform key, popover переключается в API-account режим с key/org/spend вместо Max quota. Codex-чип показывает weekly/5-hour лимиты выбранного OpenAI Codex аккаунта и отдельный popover без Claude-only token-cost секции; account-log/rollout JSONL остаются bounded fallback'ом только когда для нужного аккаунта ещё нет verified OpenAI snapshot.

## Лицо чипов: иконка + проценты + reset countdown

Claude-чип несёт три элемента в одну строку: provider-иконка, `weekly%` в severity-цвете и compact weekly reset countdown `1d 12h` / `12h 30m` / `45m` через `formatResetShort()`. Codex-чип на компактном лице показывает две пары в slash-модели: `weekly% weekly-reset / 5-hour% 5-hour-reset`, например `45% 6d 1h / 7% 2h 10m`. Reset-текст светлее обычного muted grey (`#bbb`, как idle Docs button), потому что старый `#6b7280` сливался с серым toolbar-фоном.

Mini progress bar/gauge в компактном chip'е **не показывается** — процент уже является точным сигналом, а короткая полоска рядом с ним дублирует ту же семантику и добавляет визуальный шум. ProgressRow остаётся только внутри раскрытого popover'а, где есть место для подписи `Weekly` / `5-hour` и точной reset-даты.

Codex-иконка в chip'е — inline SVG-глиф без белого tile-фона из скачанного ассета. Полный `codex-color.svg` включает белую app-плашку; в toolbar на тёмном фоне она читалась как рамка/broken image. В компактном usage-чипе нужен только внутренний градиентный знак, увеличенный относительно стандартной 12px иконки, чтобы занимать доступную площадь без фоновой коробки.

Тикер countdown'а теперь **always-on** (60s), не только при открытом popover'е — чип показывает обратный отсчёт постоянно. 60s резолюция: грубейшая показанная единица — минуты.

## Два provider-чипа, не общий переключатель

Claude и Codex лимиты независимы по источнику, периоду reset'а и смыслу процента, поэтому показываются двумя sibling-чипами рядом, а не одним общим popover'ом с внутренним переключателем. Пользователь сравнивает бюджеты боковым зрением: `Claude 64% 5d 19h` рядом с `Codex 45% 6d 1h / 7% 2h 10m`. Если спрятать Codex внутрь Claude popover'а, второй бюджет станет discoverability-операцией, а не постоянным статусом.

Каждый provider-чип сам открывает свой popover и сам refresh'ится. Общей остаётся только Activity-секция и shared визуальный язык: provider icon → weekly% → compact reset text. Подробности переносимого принципа — `methodology/переносимый-дизайн.md::Независимые provider quotas`.

## Почему weekly остаётся первой метрикой на chip'е

5-hour utilization прыгает резко (один burst-разговор поднимает с 5% до 60%), `weekly` — медленно интегрированное число, более релевантное для долгосрочного планирования сессий. Поэтому цвет и первый процент compact-chip'а остаются weekly: это число сигналит «пора замедлиться / можно ещё» на горизонте недели.

Codex — исключение на уровне компактного preview: пользователь явно сравнивает weekly и 5-hour до раскрытия popover'а, поэтому chip показывает `weekly / 5-hour` и для utilization, и для reset countdown. Это не отменяет weekly-first модель: цвет chip'а всё равно берётся из weekly, weekly стоит первым, а пятичасовой bucket получает тактическое второе число. В раскрытом popover'е обе строки остаются полноценными `ProgressRow`.

Цветовые пороги выбраны асимметрично — `<50% green` (комфорт), `<75% yellow` (внимание), `<90% orange` (плотно), `≥90% red` (надо тормозить). Не равномерные 25%-сегменты — последние 25% психологически важнее первых 75%, разрешение в верхней зоне нужно выше.

## Источник данных лимитов: macOS Keychain + /oauth/usage

Backend — [`ipc/claude-usage.js`](../../src/main/ipc/claude-usage.js), IPC `claude-usage:get`. Читает OAuth token через `security find-generic-password -s "Claude Code-credentials" -w` (та же запись, которую создаёт `claude` CLI при `claude login`). JSON в keychain → `claudeAiOauth.accessToken`. Не сохраняем token в env-var проекта — был бы дубль, разъезжающийся при `claude logout/login`.

Endpoint — `GET https://api.anthropic.com/api/oauth/usage` с заголовками `Authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`. Тот же, что использует Swift-приложение Blimp-Labs/claude-usage-bar.

Кэш 170s в памяти main-процесса. Polling-интервал в renderer'е 3 минуты — если две вкладки запрашивают подряд, второй запрос вернётся из кэша. Force-refresh кнопка в popover'е игнорирует кэш и cooldown. Подробности — секция «Polling cadence» ниже.

Ответ:
```json
{
  "five_hour":  { "utilization": 7,  "resets_at": "2026-05-20T06:20:00Z" },
  "seven_day":  { "utilization": 2,  "resets_at": "2026-05-27T01:00:00Z" },
  "seven_day_opus":   {...},
  "seven_day_sonnet": {...},
  "extra_usage": { "is_enabled": true, "monthly_limit": 20000, "used_credits": 142, "utilization": 0.71 }
}
```

`extra_usage` — overflow в pay-as-you-go USD-кредитах после исчерпания Max-плана. `used_credits` и `monthly_limit` в **центах**, не в долларах — делим на 100.

Claude Code может быть залогинен не через Max OAuth, а через API Platform key (`security` service `"Claude Code"`). Такой ключ **может запускать Claude Code локально**, но `/api/oauth/usage` для него недоступен: Max quota, weekly reset и extra usage относятся только к OAuth Max token. Поэтому accounts в Claude popover — это не косметика: `api:<hash>` и `oauth:<hash>` разные auth sources, один может быть current, другой cached/secondary. Текущий key source показывается в шапке, чтобы не путать “Claude работает” с “Max quota доступна”. Если текущий auth стал API Platform, но renderer продолжает просить старый `selectedAccountKey` OAuth, backend выберет requested account раньше current account — это осознанная account-persist логика, но UX-риск: можно продолжить смотреть Max quota, пока Claude фактически работает API key'ем. При правке account selection проверяй `selectedAccountKey` vs `currentAccountKey` в логах, а не только вид чипа.

Для API Platform публичная информация ограничена: обычный API key валидируется через `GET /v1/models?limit=1` и даёт `anthropic-organization-id` в headers; spend читается только через Admin API key (`ANTHROPIC_ADMIN_API_KEY` / `ANTHROPIC_ADMIN_KEY`) и `GET /v1/organizations/cost_report` bucket'ами за последние 31 день. Этот endpoint возвращает cost report (month spend, last 7d, latest bucket), но **не возвращает remaining credits / balance**. В UI строка `Credits left` намеренно показывает `not exposed`: баланс остаётся только в Claude Console Billing, не выводить фейковый `$0` и не пытаться выводить остаток из spend. Важно: cost report принадлежит admin key, а строка `Org` рядом с ним берётся из selected API key status. Если ключи из разных Anthropic org, UI может показать spend одного org рядом с id другого — при расследовании API-режима сверяй оба источника, не называй это quota.

## Источник данных Codex: тот же account API, что у web dashboard

Основной источник toolbar-чипа — `GET https://chatgpt.com/backend-api/wham/usage`. Это тот же JSON, из которого страница `chatgpt.com/codex/cloud/settings/analytics#usage` рисует карточки лимитов; DOM страницы не парсится. Запрос использует `access_token` и `account_id` текущего `~/.codex/auth.json`, отправляет `Authorization: Bearer ...` и обязательный `ChatGPT-Account-Id`. Email ответа, если он есть, обязан совпасть с email Codex auth; несовпадение — конечная ошибка, а не данные второго аккаунта. Ответный `account_id` находится в namespace пользователя и **не равен** request header `ChatGPT-Account-Id`; его можно сверять только с JWT claim `auth.user_id`, иначе каждый корректный ответ будет ложно отклонён.

Ответ содержит `used_percent`, тогда как chip показывает remaining. Инверсия `100 - used` выполняется только renderer'ом. Окна распознаются по реальной длительности (`limit_window_seconds` / `window_minutes`), а не по позиции `primary/secondary`; тот же duration mapping используется при сравнении reset-generation. Сервер уже возвращал дополнительные daily/monthly/model-specific buckets, поэтому неизвестное окно остаётся неизвестным и не подписывается ложным `5-hour` или `Weekly`. Пустая строка, whitespace и boolean не означают `0% used`: полностью невалидный ответ сохраняет предыдущий snapshot и показывает ошибку, а частичный валидный ответ обновляет присутствующее окно и сохраняет последнее подтверждённое значение отсутствующего.

Network-path имеет физический `AbortController` deadline 8s, renderer-level IPC deadline 12s, один in-flight запрос на auth fingerprint и 55s cache. Force refresh обходит cache, но не account guard и сам по себе не запускает тяжёлый локальный scan. Auth перечитывается перед применением любого результата; если account/token сменился во время запроса, старый успех и старая ошибка не могут записаться в новый аккаунт, а запрос один раз повторяется с уже готовой новой auth snapshot. Сам Noted Terminal не расходует общий refresh token: при `401/403` без внешней rotation сохраняется последнее значение и показывается `Codex login expired`, чтобы не получить cross-process `refresh_token_reused` race с живым Codex CLI.

Прод-шрам 2026-07-10: `/backend-api/wham/usage` может для одного и того же `account_id` вернуть успешный HTTP 200 с нормальным расходом, через несколько секунд — почти `0% used` и сдвинутым reset, а следующим ответом снова вернуть исходную ветку. Это upstream-флап, а не смена аккаунта и не повод показать пользователю `99/100% left`. Подозрительная регрессия расхода или смена будущего reset сначала становится кандидатом; last verified snapshot остаётся на экране. Кандидат принимается только после второго совпавшего ответа той же ветки не раньше чем через 30s либо сразу после того, как предыдущий reset действительно наступил. Возврат прежней ветки снимает кандидата. Manual force refresh обходит только cache и не обходит эту проверку.

До восьми последних verified OpenAI snapshots сохраняются между рестартами приложения через существующий `app_state`. Persisted shape содержит только маскированную подпись аккаунта, нормализованные окна лимита и время снимка/попытки; OAuth token, refresh token, auth fingerprint, полный email и raw account id туда не попадают. После рестарта текущий login всё равно перечитывается из Codex auth и обновляется по сети, а остальные аккаунты сразу доступны как historical stale snapshots. Успешный OpenAI snapshot старого аккаунта не должен провоцировать локальный scan только из-за того, что он stale.

Renderer больше не опрашивает `refreshing=true` каждые 1.5s. Один `invoke` обязан закончиться success/error/timeout; старый результат отбрасывается generation/context guard'ом после смены аккаунта, вкладки или размонтирования. Во время запроса старые проценты остаются на экране. После ошибки рядом показываются `Source`, возраст снимка и `stale`; spinner всегда прекращается.

Мультиаккаунтность сохраняется, но источник явно разделён. Текущий Codex login обновляется через OpenAI API. Другой выбранный аккаунт показывает последний доказанный snapshot своей сессии/локального cache и помечается stale, пока не появится свежий account-bound sample. Активная вкладка может обновить выбранный аккаунт только при совпавшем account key. Совпавший `sourceThreadId` допустим как fallback лишь когда identity активной сессии неизвестна; если identity известна и отличается, общий thread id не является доказательством принадлежности. Неизвестную identity запрещено приписывать глобально текущему `auth.json` только потому, что sample записан после login timestamp: старая вкладка аккаунта A продолжает писать после переключения на B.

В переключателе аккаунтов зелёная точка означает только текущий Codex login. Historical аккаунты всегда имеют серую точку и stale-status; выбранность показывается рамкой и не меняет точку на зелёную. В строках `Weekly left` и `5-hour left` длина цветного заполнения равна **оставшемуся** проценту, поэтому `81% left` занимает 81% шкалы, а `0% left` оставляет только тёмный track. Цвет текста/заполнения по-прежнему определяется срочностью по использованному проценту: зелёный при большом остатке, красный у исчерпания.

`~/.codex/logs_2.sqlite` остаётся только редким discovery/fallback для аккаунтов без сохранённого OpenAI snapshot. При успешном ответе OpenAI не стартует ни account scan, ни чтение rollout активной вкладки: server result не зависит от размера локальной истории. Fallback активной сессии читает с конца максимум 16MB JSONL вместо полного файла; поиск identity ждётся не больше 1s. Scan нужен только когда для запрошенного account key ещё нет verified server snapshot, не участвует в состоянии `updating`, не запускается force-refresh'ем сам по себе и после success/failure имеет 6h cooldown. Это важно ещё и потому, что новые версии Codex пишут `codex.rate_limits` в другом log shape (`target=log`, часто без `thread_id`), поэтому старый websocket scanner может вернуть `count=0` даже при наличии свежих rate events.

Прод-шрам 2026-07-10: `logs_2.sqlite` вырос до 1.7GB / 661k rows. Каждый scan упирался в `sqlite3` timeout 15s; renderer видел `refreshing=1`, повторял IPC через 1.5s и после каждого failure немедленно запускал новый scan. Параллельно selected `fr***` получал active rollout `ve***`, потому что код считал одинаковый `sourceThreadId` достаточным даже при уже доказанном несовпадающем account key. Симптом: вечный `updating` и флап процентов при смене вкладки. Оба поведения запрещены: local failure terminal до cooldown, known account mismatch всегда выигрывает у thread fallback.

Диагностика: main пишет `[CodexData] remote usage accepted|pending|confirmed|obsolete|failed account=... candidate=... shown=... durMs=...` и итоговый `[CodexData] get-usage source=<openai-usage-api|active-session-rollout|codex-log|latest-rollout-unverified> ... refreshing=0 stale=<0|1>`. Renderer пишет тот же selected source/account. Сначала сверяй account/source/timestamp, а не Timeline: Timeline отвечает «какой snapshot был у хода», toolbar — «какой последний доказанный budget выбранного аккаунта».

Не пересчитывать Codex лимит из `last_token_usage.total_tokens`. Локальные токены не равны провайдерскому quota%, потому что provider применяет собственную формулу и reset-бакеты. Конкретика Codex JSONL — [`fact-codex.md`](fact-codex.md).

## Источник данных per-tab tokens: JSONL агрегирование

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

`Total billed` отображается только если отличается от `Active branch` больше чем на $0.01 — для нерастущих в файле сессий это шум. `Wasted` — оранжевым, как индикатор «есть смысл следить».

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
| ⌘⇧ нажат при открытом popover'е | **Sticky pin** (белая рамка + бейдж `PINNED`) | Только повторный ⌘⇧ или клик по самому чипу |

В sticky-режиме секция «This tab» **реактивно пересчитывается** на новую active session при переключении табов/проектов. Это **отличает popover от классического snapshot-pin'а** (см. `methodology/переносимый-дизайн.md::Sticky pin: snapshot vs reactive content`) — общий ⌘⇧-закреп описывает поведение «окно прибито к источнику», здесь источник = текущий active tab и он подвижен.

Хинт `⌘⇧ to pin across tabs` в нижней части popover'а появляется только пока не sticky, помогает discovery. При активации бейдж `PINNED` заменяет хинт.

**Trap** — при имплементации легко завязать click-outside handler на оба state'а (`clicked` и `sticky`) и mousedown по TabBar сбросит sticky тоже. Зафиксировано в `methodology/сценарии-багов-design.md::4.7 Sticky pin не должен сбрасываться общим click-outside handler'ом`.

## Состояние «expanded» секции «This tab» — ephemeral

Юзер: *«состояние раскрыто/свернуто не должно сохраняться если я закрыл бар»*. Раскрытое состояние секции сохраняется только пока popover открыт (можно пересекать вкладки в sticky-pin режиме — раскрытое остаётся). При полном закрытии popover'а (click-outside, Esc, повторное снятие sticky) — сбрасывается. Нет localStorage / SQLite persistence. Аналогично — `methodology/переносимый-дизайн.md::Expanded-state дочерней секции — ephemeral`.

Применимо потому что «This tab» — лёгкая опт-ин информация, не core-фича. Юзер открывает popover каждый раз для актуальной % картинки, разворачивание токенов — отдельный жест. Persistance заставила бы раскрытую секцию мозолить глаз тем кто заглядывает на 2 секунды посмотреть %.

## Color thresholds и мягкость рамок

Чип в idle-состоянии — прозрачный border, текст в цвет порога. При любом open (включая transient peek) — мягкий фон `${color}0A` (4% opacity) и border `${color}33` (20%). Раньше было `0x1F`/`0x66` — юзер попросил «менее яркой сделай»: чип в правом конце toolbar'а не должен крепко конкурировать с активным табом в TabBar за визуальное внимание.

Sticky-pin — единственное состояние с **заметной** рамкой: `rgba(255,255,255,0.4)` на чипе и `0.45` на popover'е. Это не путается с обычным open — sticky редкий жест, должен быть отличим с одного взгляда.

## Daily history: SQLite snapshots, не реконструкция

Расход недельного лимита по дням храним как сырые snapshot'ы `/oauth/usage` — таблица `claude_usage_snapshots` в `database.js`, append на каждый успешный network fetch (раз в минуту пока chip живой). Альтернатива — пересчитать `weekly%` ретроактивно из JSONL-токенов × pricing — отвергнута: Anthropic взвешивает модели и `extra_credits` overflow по непубличной формуле, наш USD-эквивалент коррелирует но регулярно расходится на 5-15 п.п. с цифрой на чипе. Юзер бы увидел два разных числа за один день и потерял бы доверие к графику. Принцип уровня методологии — `methodology/переносимый-дизайн.md::Историю провайдерского ресурса храним как снимки источника`.

Размер таблицы: 1440 строк/день × ~50 байт ≈ 26 MB/год. **Prune убран** (май-2026) по запросу юзера — история хранится вечно, чтобы «By day» график мог смотреть назад на произвольный диапазон, не только последнюю неделю. Append-only, никаких updates — snapshot = факт того что API вернуло в момент `ts`, не подлежит правке. (Раньше был auto-prune `WHERE ts < now - 60d` в каждом insert — удалён из `saveClaudeUsageSnapshot`.)

Snapshot пишется **только на live network fetch**, не на cache-hit — иначе одну и ту же точку получишь как 5 разных записей за 5 минут. Кэш в памяти 5 минут (см. секцию выше) → 1 snapshot/min эффективно, не 1/cache-hit/sec.

**Backfill ретроактивный.** Фича запущена 21-мая после того как неделя уже была частично потрачена. Чтобы график не показал «0% за вчера» (false-empty), прод-БД получила seed 3 точек по памяти юзера: 20-мая 04:00 MSK=5%, 20-мая 22:00 MSK=22%, 21-мая 10:00=29%. Это разовая операция под конкретный момент жизни проекта, **не** миграция и не fixtures — следующие запуски накопят полноценную историю polling'ом, seed-блок никогда не выполнится повторно.

## Reset detection: смена дня в `resets_at`

Anthropic ротирует weekly-бакет раз в неделю. После reset `weekly_pct` падает с большого числа к маленькому (например 80% → 5%), а `resets_at` в ответе указывает на **новый** следующий момент ротации — на 7 дней вперёд. Без specific детекта `delta` за день перехода взяла бы negative число и `Math.max(0, …)` обнулила бы «расход» в самый активный день недели.

Сравнивается **только дата** (`YYYY-MM-DD` через `String(s).slice(0, 10)`) в `weekly_resets_at`. Если она поменялась между двумя соседними snapshot'ами — бакет ротейтнулся, `wasReset=true`, новый baseline = `postResetStart` = первый weekly после ротации. Реальные ротации всегда пересекают календарный день, jitter в нижних разрядах строки не пересекает никогда.

Стратегия №2 — **drop > 10 п.п.** между соседними snapshot'ами — fallback на случай отсутствия `resets_at` (NULL в seed-точках) или если Anthropic ratejitter'ил сам день. Срабатывает редко, но дёшево держать как safety-net. 10 п.п. — компромисс: 5 даст false-positive на естественной флуктуации между cache-tier'ами, 20 пропустит low-utilization недели. На графике день с reset'ом получает белый risk-маркер 2px на правом крае бара.

**Graveyard.** Раньше сравнивались **сырые строки** `weekly_resets_at !== prev`. Это ловушка: Anthropic возвращает строки с **микросекундным jitter'ом** (`…59.742063+00:00`, `…59.752255+00:00`, `…59.771822+00:00`) даже когда бакет один и тот же. Каждый snapshot выглядел как новый reset, `postResetStart` переписывался последним значением, `baseline = последний weekly`, `delta = dayMax - lastWeekly` — почти всегда 0-2% вместо реальных 10-15%. Попытка фикса через bucketing до минуты (`Math.floor(t/60000)`) ломалась на границе секунды: Anthropic иногда отдавал `T00:59:59.x`, иногда `T01:00:00.x` — два разных бакета внутри одной минуты. Bucketing до часа тоже отвергнут — это уже не нормализация jitter'а, а домыслы про шаг реальных ротаций, юзер прямо сформулировал *«никаких часов нахуй... ты опять костыли пишешь»*. Срез до дня — это **доменная единица** ротации (реальные resets раз в неделю, никогда не суб-дневные), а не произвольная гранулярность.

## Cold-start fallback + error cooldown

Cold start с 429 даёт прочерк в чипе вместо реальных %. Чтобы этого не было, при пустом in-memory кэше + failed live fetch main reconstruct'ит минимальный `/oauth/usage`-shape объект из **последнего persisted snapshot** в SQLite (`getLatestClaudeUsageSnapshot`) и отдаёт его как `data` рядом с `error`. Renderer видит `data≠null` → рисует %, баннер ошибки остаётся снизу popover'а. Поля `extra_usage`/Opus/Sonnet могут отсутствовать (в snapshot'е персистится только weekly + 5h), но основной weekly чипа всегда есть.

Ограничение fallback'а: `claude_usage_snapshots` не account-scoped и не проверяет что `weekly_resets_at/five_hour_resets_at` ещё в будущем. Это нормально как «последнее известное число с error banner», но не текущее состояние. Если app cold-start'ит после reset, live `/oauth/usage` падает 429/network error, а последний SQLite snapshot был до reset'а, renderer покажет старые проценты с ошибкой. В прод-БД 2026-06-18 последний Claude snapshot был от 2026-06-15 с `weekly_resets_at=2026-06-17`, то есть уже устаревший. Не путать это с Codex flapping: Claude не выбирает между поколениями логов на успешном live fetch, stale возникает только на cache/fallback error path.

**Polling cadence 180s, cooldown 180s.** Anthropic `/oauth/usage` отдаёт 429 даже при 1 запросе/мин — endpoint предназначен для редкого опроса, не для мониторинга. Renderer тикает раз в **3 минуты**, backend `CACHE_TTL_MS=170s` (чуть меньше polling-а, чтобы плановый тик гарантированно дёргал сеть). `ERROR_COOLDOWN_MS=180s` — фоновый poll **не делает live fetch 3 мин после failed live fetch**, возвращает закешированный error + последние данные. Force-refresh кнопка cooldown игнорирует. Cache-hit branch явно возвращает `error: null`, без этого renderer получал stale error из cached payload и оставлял баннер видимым после успешного polling'а.

**`lastAttemptAt` + flash при force-refresh.** Backend на каждом вызове `getUsage` (включая cooldown/cache-hit ветви) возвращает `lastAttemptAt` — timestamp последней попытки live fetch. Renderer показывает в банере ошибки `Last attempt 12s ago: HTTP 429…` и подсвечивает короткой `flash-fail` анимацией (450ms красноватый фон), когда `now - lastAttemptAt < 2000ms`. Это нужно, чтобы юзер видел: повторный клик refresh **реально** триггернул запрос, который вернулся той же ошибкой — без этого статичный текст «Last fetch failed» выглядел как «кнопка не работает». На force-refresh ещё держим spinner минимум 400ms, чтобы клик ощутимо мигнул даже на синхронном cache-hit. См. ClaudeUsageButton.tsx::refresh, ClaudeUsageButton.tsx::error-banner.

## Header reset в popover'е

В шапке popover'а вместо статичного заголовка «Claude usage» / «Codex usage» отображается точная локальная дата и время недельного reset'а: `weekly reset 17 июн., 09:34`. Относительное `in 5d 19h 59m` уже есть в компактном chip'е, поэтому в раскрытом popover'е оно дублировало бы то же число. Popover отвечает на другой вопрос: «когда именно обновится бакет», без mental math и без пересчёта countdown'а.

## Baseline дня = последний snapshot предыдущего дня

`delta` за день = `dayMax - baseline`, **не** `max - min within day`. Причина — между днями есть «разрыв» в записях (ночью polling может быть выключен — устройство спит, chip скрыт), и `min внутри дня` может попасть на 09:00 после ночного сна, когда уже накопилось 3% утренней работы. Тогда delta потеряла бы эти 3%.

Baseline = последний snapshot **предыдущего** local-дня (не UTC) — что юзер видел как «накопилось к моменту когда лёг спать». Если день первый в истории (нет prev-дня) — baseline = первый snapshot этого дня. Если день был reset'нут — baseline = post-reset value (см. секцию выше).

Local-date, не UTC: юзер думает о расходе «вчера vs сегодня» в своей таймзоне (MSK сейчас, может смениться при переезде). UTC-bucket дал бы баг типа «MSK 02:00 пишется как новый день, юзер ещё за ноутом» (UTC уже сменилась в 03:00 предыдущего вечера). Bucketing — через `new Date(ts*1000).getDate()` локального процесса.

## Связанные документы

- [`fact-agent-activity.md`](fact-agent-activity.md) — «Activity» секция в этом же popover'е: сколько времени агенты реально работали (loader-on интервалы), агрегировано by day/project/tab. Хостится здесь для Claude и Codex popover'ов, но capture-логика и таблица — отдельная подсистема.
- [`fact-status-bar.md`](fact-status-bar.md) — где живут другие toggle'ы. Лимитный chip намеренно вынесен оттуда: status bar = глобальные toggle'ы, не привязанные к табу; usage chip session-aware (читает `getEffectiveTabId`).
- [`fact-claude-sdk-tab.md`](fact-claude-sdk-tab.md) — отдельный context-%-meter для SDK табов читает usage из live SSE stream'а, не из JSONL на диске. Это два разных потока: SDK-meter — мгновенный отклик на конкретное message_start, chip — устаканенное число для всех табов проекта.
- [`methodology/сценарии-багов-design.md`](../methodology/сценарии-багов-design.md) секция 4 — click-outside ловушки.
- [`methodology/переносимый-дизайн.md`](../methodology/переносимый-дизайн.md) секция «Историю провайдерского ресурса храним как снимки источника» — переносимый принцип, обосновывает почему не пересчитываем из JSONL.
- Global `~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/tooltip-resize-modal.md::Закреп` — базовая механика ⌘⇧-pin'а.
