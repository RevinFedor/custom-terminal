# Feature: Claude Usage Chip

Цветной chip в [`ProjectToolbar.tsx`](../../src/renderer/components/Workspace/ProjectToolbar.tsx) слева от `DictationHistoryButton`, реализация — [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx). Показывает **недельный % лимита** Anthropic Max-подписки и раскрывает popover с детальной разбивкой плюс per-tab cost'ом из JSONL на диске.

## Лицо чипа: gauge + % + reset countdown

Чип несёт три элемента в одну строку (слева направо):
1. **Вертикальный fill-gauge** — тонкая колонка (4×14px) заполняется снизу вверх по `weekly%` в том же severity-цвете что и текст. Читается как мини-батарейка: чип несёт ФОРМУ, не только цифру, виден боковым зрением без чтения числа.
2. **`weekly%`** — в severity-цвете (пороги ниже).
3. **Compact reset countdown** `1d 12h` / `12h 30m` / `45m` — `formatResetShort()`, всегда ≤2 единиц (header popover'а использует 3-юнитный `formatResetCountdown`). **Намеренно muted neutral** (`#6b7280`), НЕ severity-цвет: % уже владеет цветовым сигналом, второй цветной токен в крошечном чипе дрался бы с ним за внимание. Юзер спросил «каким цветом грамотно пометить» — ответ: никаким ярким, нейтральным.

Тикер countdown'а теперь **always-on** (60s), не только при открытом popover'е — чип показывает обратный отсчёт постоянно. 60s резолюция: грубейшая показанная единица — минуты.

## Зачем именно weekly%, а не 5h, на самом chip'е

5-hour utilization прыгает резко (один burst-разговор поднимает с 5% до 60%), `weekly` — медленно интегрированное число, более релевантное для долгосрочного планирования сессий. Юзер хочет видеть «сколько от своего недельного бюджета я уже потратил» — это число которое сигналит «пора замедлиться / можно ещё». 5h доступен в popover'е для тактического взгляда.

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

**Trap** — при имплементации легко завязать click-outside handler на оба state'а (`clicked` и `sticky`) и mousedown по TabBar сбросит sticky тоже. Зафиксировано в `methodology/сценарии-багов.md::4.7 Sticky pin не должен сбрасываться общим click-outside handler'ом`.

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

**Polling cadence 180s, cooldown 180s.** Anthropic `/oauth/usage` отдаёт 429 даже при 1 запросе/мин — endpoint предназначен для редкого опроса, не для мониторинга. Renderer тикает раз в **3 минуты**, backend `CACHE_TTL_MS=170s` (чуть меньше polling-а, чтобы плановый тик гарантированно дёргал сеть). `ERROR_COOLDOWN_MS=180s` — фоновый poll **не делает live fetch 3 мин после failed live fetch**, возвращает закешированный error + последние данные. Force-refresh кнопка cooldown игнорирует. Cache-hit branch явно возвращает `error: null`, без этого renderer получал stale error из cached payload и оставлял баннер видимым после успешного polling'а.

**`lastAttemptAt` + flash при force-refresh.** Backend на каждом вызове `getUsage` (включая cooldown/cache-hit ветви) возвращает `lastAttemptAt` — timestamp последней попытки live fetch. Renderer показывает в банере ошибки `Last attempt 12s ago: HTTP 429…` и подсвечивает короткой `flash-fail` анимацией (450ms красноватый фон), когда `now - lastAttemptAt < 2000ms`. Это нужно, чтобы юзер видел: повторный клик refresh **реально** триггернул запрос, который вернулся той же ошибкой — без этого статичный текст «Last fetch failed» выглядел как «кнопка не работает». На force-refresh ещё держим spinner минимум 400ms, чтобы клик ощутимо мигнул даже на синхронном cache-hit. См. ClaudeUsageButton.tsx::refresh, ClaudeUsageButton.tsx::error-banner.

## Header countdown в popover'е

В шапке popover'а вместо статичного заголовка «Claude usage» отображается обратный отсчёт до недельного reset'а в формате `weekly resets in 6d 4h 12m`. Берётся `data.seven_day.resets_at`, тикер обновляет раз в 30 секунд **только** пока popover открыт. Юзер на чип смотрит «успею ли я допилить фичу до конца недели» — `Xd Yh Zm` отвечает на вопрос мгновенно, не требует mental math из ISO-timestamp'а в углу.

## Baseline дня = последний snapshot предыдущего дня

`delta` за день = `dayMax - baseline`, **не** `max - min within day`. Причина — между днями есть «разрыв» в записях (ночью polling может быть выключен — устройство спит, chip скрыт), и `min внутри дня` может попасть на 09:00 после ночного сна, когда уже накопилось 3% утренней работы. Тогда delta потеряла бы эти 3%.

Baseline = последний snapshot **предыдущего** local-дня (не UTC) — что юзер видел как «накопилось к моменту когда лёг спать». Если день первый в истории (нет prev-дня) — baseline = первый snapshot этого дня. Если день был reset'нут — baseline = post-reset value (см. секцию выше).

Local-date, не UTC: юзер думает о расходе «вчера vs сегодня» в своей таймзоне (MSK сейчас, может смениться при переезде). UTC-bucket дал бы баг типа «MSK 02:00 пишется как новый день, юзер ещё за ноутом» (UTC уже сменилась в 03:00 предыдущего вечера). Bucketing — через `new Date(ts*1000).getDate()` локального процесса.

## Связанные документы

- [`fact-agent-activity.md`](fact-agent-activity.md) — «Activity» секция в этом же popover'е: сколько времени агенты реально работали (loader-on интервалы), агрегировано by day/project/tab. Хостится здесь, но capture-логика и таблица — отдельная подсистема.
- [`fact-status-bar.md`](fact-status-bar.md) — где живут другие toggle'ы. Лимитный chip намеренно вынесен оттуда: status bar = глобальные toggle'ы, не привязанные к табу; usage chip session-aware (читает `getEffectiveTabId`).
- [`fact-claude-sdk-tab.md`](fact-claude-sdk-tab.md) — отдельный context-%-meter для SDK табов читает usage из live SSE stream'а, не из JSONL на диске. Это два разных потока: SDK-meter — мгновенный отклик на конкретное message_start, chip — устаканенное число для всех табов проекта.
- [`methodology/сценарии-багов.md`](../methodology/сценарии-багов.md) секция 4 — click-outside ловушки.
- [`methodology/переносимый-дизайн.md`](../methodology/переносимый-дизайн.md) секция «Историю провайдерского ресурса храним как снимки источника» — переносимый принцип, обосновывает почему не пересчитываем из JSONL.
- Global `~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/tooltip-resize-modal.md::Закреп` — базовая механика ⌘⇧-pin'а.
