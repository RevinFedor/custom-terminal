# Feature: AI Usage Chips (Claude + Codex)

Два цветных chip'а в [`ProjectToolbar.tsx`](../../src/renderer/components/Workspace/ProjectToolbar.tsx) слева от `DictationHistoryButton`, реализация — [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx). Claude-чип показывает **недельный % лимита** Anthropic Max-подписки, если текущий Claude Code auth — OAuth Max; если текущий auth — API Platform key, popover переключается в API-account режим с key/org/spend вместо Max quota. Codex-чип показывает weekly/5-hour лимиты выбранного OpenAI Codex аккаунта и отдельный popover без Claude-only token-cost секции; rollout JSONL остаётся fallback'ом, когда account-log ещё пуст.

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

## Источник данных Codex: rollout `token_count.rate_limits`

Codex-чип не ходит в OpenAI usage endpoint. Для текущего toolbar-числа backend `codex:get-usage` сначала читает `~/.codex/logs_2.sqlite`: строки `codex.rate_limits` из websocket-логов связываются с `thread_id`, `user.account_id` и `user.email`, затем берётся самый свежий snapshot на identity за последние 10 дней. Это нужно для мультиаккаунтинга: активная вкладка может принадлежать одному Codex аккаунту, а пользователь хочет смотреть бюджет другого, поэтому «последний rollout активной сессии» больше не является достаточным source-of-truth.

Свежесть account-log snapshot'а определяется не только временем строки лога. После provider reset в локальном `logs_2.sqlite` могут сосуществовать два поколения одного аккаунта: новый snapshot уже показывает `weekly=0/1`, а старая сессия позже дописывает старое поколение (`weekly=77`, `five_hour=81`) с большим `ts`. Пользовательский симптом: чип показал reset, через несколько минут вернул старое значение, потом снова показал новое. Фикс: сравнивать сначала поколение reset (`secondary.reset_at`/weekly, затем `primary.reset_at`/5-hour), и только при равном поколении fallback'ать на `ts`/`ts_nanos`. Диагностика должна видеть в логе не только `%`, но и `wReset/5hReset/thread`, иначе невозможно доказать какой snapshot победил.

SQL вытаскивает только короткие `substr()`-окна вокруг `codex.rate_limits` / `user.account_id` / `user.email`, а не полный `feedback_log_body`: в этих логах могут лежать prompts и tool-output. Email маскируется (`ab***@domain`), account key хранится как короткий sha256-хеш, selected account persist'ится только в `localStorage('noted.codexUsage.accountKey')`. Верхний segmented switcher рендерится только когда найдено больше одного аккаунта; если аккаунт один — лишняя оболочка не показывается. Важно: scan нельзя делать одним SQL по `codex.rate_limits OR user.email` с общим `ORDER BY ts LIMIT`: активный аккаунт может породить десятки тысяч свежих identity-строк и вытолкнуть тихий второй аккаунт из окна, хотя его последние rate/identity sample ещё в 10-дневном диапазоне. Поэтому rate rows сначала выбираются отдельно, затем identity добирается по найденным `thread_id`. UX-принцип: `methodology/переносимый-дизайн.md::Аккаунт как область данных`.

Scan `logs_2.sqlite` не является безопасным foreground-путём для toolbar. Реальный продовый симптом 2026-06-21: `codex:get-usage` висел 9-15 секунд на чтении account-log, пользователь видел лаги всего приложения и мог принять общий usage refresh за «живая вкладка что-то делает». Поэтому `codex:get-usage` отвечает из памяти быстро: свежий cache возвращается сразу, stale cache возвращается с `refreshing=true`, а тяжёлый scan идёт одним singleton background refresh'ем. При полном cold-start без cache foreground ждёт только короткий budget; если account scan не успел, ответ получает `source=account-refreshing`, renderer показывает `updating`/ретраит, но не держит бесконечный loader и не запускает fallback на latest rollout пока account refresh ещё in-flight.

Force-refresh в popover'е тоже не должен превращаться в 15-секундный foreground wait. Он стартует background refresh и при наличии старого snapshot'а оставляет его на экране как stale truth до прихода свежих данных. Это важно именно потому, что Codex quota — account-level ресурс: вкладка может помочь fallback'ом через `sessionId/cwd`, но не становится владельцем лимита и не должна получать `active/resuming` только из-за usage refresh'а.

Fallback/merge order в `codex:get-usage`: `account-log` остаётся базовым источником для multi-account selector, затем active session rollout (`opts.sessionId` + `cwd`) может заменить snapshot выбранного аккаунта, если identity активного `thread_id` (`user.account_id`/`user.email` из `logs_2.sqlite`) совпала с выбранным account key и rollout свежее по тому же freshness comparator'у (`reset_at` generation → `ts`). Когда Codex уже не пишет identity в текущий `thread_id`, active rollout можно привязать к текущему `~/.codex/auth.json`, но только если rollout свежее auth snapshot'а; старые resurrected sessions до перелогина обязаны оставаться на log identity. Если active identity неизвестна и текущий auth не доказывает аккаунт, её нельзя использовать для перетирания даже единственного найденного account row: «один аккаунт в scan» может быть багом scan-window, а не доказательством single-account. Последний fallback — latest rollout в `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. В rollout авторитетная запись та же: `event_msg` с `payload.type === "token_count"` и `payload.rate_limits`; `primary` маппится в `five_hour`, `secondary` — в `seven_day`; `resets_at` приходит epoch seconds и приводится к ISO для общего renderer-форматтера. Пока нет ни account-log, ни rollout record'а, состояние «No Codex limit sample yet» корректно: лимит ещё не материализован в durable локальных артефактах.

Шрам 2026-06-26: toolbar Codex chip вызывал `codex:get-usage` только с `accountKey/force`, поэтому backend логировал `session=none` и не мог сверить активную вкладку. В проде после force-refresh в 04:50 MSK UI честно показывал stale account-log (`ve***: weekly=0, fiveHour=1`, left `100/99`), пока оригинальный Codex уже имел свежий rollout (`weekly≈16`, `fiveHour≈3`) в активной сессии `019f016d…`. Фикс: renderer обязан передавать текущий `codexSessionId/cwd`, а main обязан обновлять не только `data`, но и соответствующий элемент `accounts[]`; иначе renderer снова возьмёт stale `selectedAccount.usage` поверх свежего `data`. Второй слой того же шрама: response-level merge недостаточен — singleton background scan может через секунду записать старый `account-log` обратно в `usageAccountsCache`, поэтому verified active rollout держится как account-key override и применяется при каждом cache-hit/cache-write, пока scan не принесёт более свежий snapshot.

Шрам 2026-07-01: после релогина Codex usage popover показывал только `ve***`, хотя в `logs_2.sqlite` был второй `fr***` аккаунт за последние 10 дней; при переключении проектов проценты менялись, потому что stale one-account cache перетирался active rollout'ом текущей вкладки. Корень был не в UI selector'е: scanner смешивал rate rows и identity rows под одним global LIMIT, и шумный текущий аккаунт вытеснял quiet account. Фикс не должен превращать quota в tab-level состояние: account list строится из account-log scan двухфазно, active rollout только освежает доказанный account key, а отсутствие thread identity не даёт права перетирать выбранный аккаунт.

Диагностика для рассинхрона «в разных вкладках разные значения» или «usage refresh лагает всё приложение»: main пишет `[CodexData] get-usage source=<account-log|account-refreshing|active-session-rollout|latest-rollout> accounts=N selected=<label> weekly=X fiveHour=Y refreshing=<0|1> stale=<0|1> cacheAgeMs=<ms|none> session=<sid> error=<...>`, renderer пишет `[CodexUsage] refresh ok source=... refreshing=... stale=...` и `[CodexUsage] account selected ...`. Сначала сравни эти логи, а не Timeline: Timeline показывает per-session snapshots, toolbar — selected-account текущий budget.

Не пересчитывать Codex лимит из `last_token_usage.total_tokens`. Это тот же anti-pattern что для Anthropic usage history: локальные токены не равны провайдерскому quota%, потому что provider применяет свою формулу и reset-бакеты. Конкретика Codex JSONL — [`fact-codex.md`](fact-codex.md).

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
