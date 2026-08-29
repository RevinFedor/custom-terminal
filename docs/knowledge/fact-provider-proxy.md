# Feature: LLM Provider Proxy

## Intro
Встроенный HTTP proxy в main process (порт 4001+) через который проходит **весь** трафик Claude Code к Anthropic API. Запускается при старте приложения, Claude Code получает `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` через env PTY.

Отдельный симптом Codex-маршрута: TUI пишет `Falling back from WebSockets to
HTTPS`, но HTTPS тоже висит во всех вкладках Noted Terminal, тогда как Claude и
прямой Codex в iTerm работают. Это не общий outage и не History — проверяй
двусторонний lifecycle shared Codex pool в секции `Connection Pooling`.

## Служебные ключи остаются в main process

`ANTHROPIC_ADMIN_API_KEY` / `ANTHROPIC_ADMIN_KEY` нужны только служебному backend'у статистики расходов. После загрузки `.env` main process сразу переносит их из общего `process.env` в закрытое хранилище модуля (`isolateMainProcessEnv()`); backend читает значение через точечный `getMainProcessEnvValue()`. Поэтому node-enabled renderer и любой будущий OS child не могут унаследовать admin key по умолчанию.

Дополнительная защита на каждой разрешённой границе — `src/main/child-process-env.js::buildChildProcessEnv()`: она копирует пользовательское окружение, применяет нужные конкретному процессу overrides и **после merge** удаляет только два admin-key alias. Поэтому отдельная точка запуска не может случайно вернуть служебный ключ через override. Обычный `ANTHROPIC_API_KEY`, `PATH`, `HOME` и остальные пользовательские переменные сохраняются. PTY shell и Agent SDK получают уже очищенное окружение, поэтому запущенные ими Claude/Codex/Gemini и SDK stdio MCP-процессы также не наследуют admin key.

Загружаемые main process файлы `.env` переводятся в режим `0600` перед чтением. Если файл находится на read-only filesystem и `chmod` недоступен, загрузка не блокируется, но рабочие пользовательские файлы (`~/.noted-terminal/.env` и dev repo `.env`) должны оставаться доступными только владельцу.

## Режимы работы

### Anthropic (default)
Passthrough к `api.anthropic.com`. OAuth-токен подписки пробрасывается as-is через headers.

**Fast path:** Если body не содержит `"thinking"` / `"redacted_thinking"` строк — JSON не парсится, body forwards as-is. Это критично для **prompt cache key**: cache key считается Anthropic по содержимому messages после JSON decode на сервере, но ресериализация (`JSON.parse → JSON.stringify`) может менять порядок escape'ов и ломать `cch=` billing sentinel.

**Thinking strip:** После работы в Zen mode в истории могут остаться thinking/redacted_thinking блоки от MiniMax/Kimi. Anthropic API их отвергает → proxy вырезает. При этом body ресериализуется → первый anthropic-запрос после Zen = cache miss.

### Zen
Перенаправляет на `opencode.ai/zen`. Переписывает model в body, заменяет auth header на Zen API key.

### DeepSeek
Перенаправляет на `api.deepseek.com/anthropic` — это **официальный** Anthropic-совместимый endpoint DeepSeek, не community-хак. Параллельно с OpenAI-форматом DeepSeek сам реализовал `/anthropic/v1/messages` для интеграции с Claude Code. Тот же API-ключ работает для обоих форматов.

**Где живёт ключ:** `DEEPSEEK_API_KEY` в `~/.noted-terminal/.env` (production). Проектный `.env` рядом с .app **не используется** — `build:install` переписывает его на каждой сборке. Тот же home-dir файл, что и `SONIOX_API_KEY` (см. `fact-dictation.md::Production env`). Симптом не настроенного ключа: в табе с выбранным DeepSeek-провайдером Claude роняет `API Error: 401 Authentication Fails, Your api key: is invalid` — пустая строка после `key:` сигнализирует именно про `process.env.DEEPSEEK_API_KEY === ''`. Dev-режим читает проектный `.env` из cwd как раньше.

**Что DeepSeek принимает (Anthropic-формат):** `model`, `max_tokens`, `stop_sequences`, `stream`, `system`, `temperature`, `top_p`, tool definitions, message content (text + tool_use/tool_result), `thinking`, `output_config.effort`.

**Что игнорирует:** `cache_control` (нет prompt cache у DeepSeek — `[ProviderProxy] Cache: read=0 create=0` для deepseek mode = норма, не баг), `anthropic-beta`/`anthropic-version` headers, `top_k`, `metadata`, `service_tier`, image/document/search_result content types.

**Unknown model fallback:** если model name не в whitelist (`deepseek-v4-pro`, `deepseek-v4-flash`) — DeepSeek **молча** мапит на `deepseek-v4-flash`. Claude Code шлёт свои model names (`claude-haiku-4-5-...`, `claude-opus-4-7`), их proxy **должен** переписать на DeepSeek-имя, иначе все запросы пойдут на flash независимо от выбора в UI.

**API constraint — thinking + effort:** DeepSeek возвращает HTTP 400 `thinking options type cannot be disabled when reasoning_effort is set` если в body есть **одновременно** `thinking:{type:'disabled'}` и `output_config.effort`. Их надо мьютексить:
- Чтобы отключить thinking: только `thinking:{type:'disabled'}`, БЕЗ `output_config`
- Чтобы включить с уровнем: `thinking:{type:'enabled'}` + `output_config.effort:'low'|'medium'|'high'`
- По умолчанию thinking включён (если не передать `thinking` — DeepSeek думает с medium effort)

`budget_tokens` в `thinking` блоке игнорируется DeepSeek — depth контролируется только через `output_config.effort`.

## Per-tab routing

**Проблема:** глобальная переменная `providerState` означала что переключение провайдера в активном табе мгновенно меняет цель **всех** табов окна. Фоновый таб, который ждал ответа от Claude, мог получить ответ от DeepSeek без ведома пользователя. Доверие к фоновой работе ломается.

**Решение:** `Map<tabId, state>` в main process + URL-префикс `/t/<encoded-tabId>/...` в `ANTHROPIC_BASE_URL` каждого Claude. При spawn таба X env содержит `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/t/<urlencode(tabId)>`. Proxy парсит prefix, достаёт tabId, читает state именно этого таба, обрезает prefix перед forward'ом на upstream.

**Что пробовали и почему не сработало:**
- **HTTP header (`X-Noted-Tab-Id`):** Claude Code сам не шлёт кастомные headers. Нет крючка чтобы внедрить.
- **Отдельный port per tab:** N портов = N listener'ов. Каждый Claude занимает ещё одну TCP-сокет-пару. Overhead растёт с числом табов, port collision при большом числе одновременных сессий.

**Fallback:** для запросов без `/t/` prefix (внешний Claude в shell, не из приложения) state читается из bucket `'global'` — это исключает крах если кто-то открыл Claude напрямую с `ANTHROPIC_BASE_URL=http://127.0.0.1:4001/` (без префикса).

Принцип в общем виде см. `methodology/переносимый-дизайн.md::Per-tab tooling state`.

## Per-tab persistence (SQLite)

`providerStates` Map в main process — in-memory only, до этой итерации сбрасывался каждый рестарт Electron'а. Юзер: *«хочу чтоб они сохранилсь меж перезапуском сесий и прилжоения»* — добавлен SQLite-backed persistence per-tab.

Колонка `tabs.provider_state TEXT` хранит сериализованный `{type, model?, effort?, thinking?}` JSON. На startup, **до** того как `app.whenReady().then(...)` шипит spawn первой Claude-сессии (AutoResume / Continue / Restore), `getAllTabProviderStates()` читает все строки и наполняет `providerStates` Map. Хук стоит в `setupShellIntegration()` block — гарантирует что любой Claude-spawn с `ANTHROPIC_BASE_URL=http://.../t/<tabId>` уже видит правильный state на первом request'е.

На каждый `provider:switch` / `provider:set-options` main **прямо** пишет в `db.updateTabProviderState(tabId, state)` без round-trip через renderer-side `saveTabs`. Альтернатива (broadcast `provider:state-changed` → renderer мутирует tab.providerState → `saveTabs` всех табов) дороже на каждом клике и race-prone: между mutate и flush юзер может сменить таб, новый saveTabs запишет stale Map. Direct write избегает обоих сценариев.

`Tab.providerState` в zustand-сторе — **read-only кэш** для UI; renderer никогда не вызывает `saveTabs` с дельтой по `providerState`. Source of truth — `providerStates` Map в main + `tabs.provider_state` row в SQLite. См. `methodology/переносимый-дизайн.md::Per-tab tooling state` для общего принципа изоляции state между табами.

**Что НЕ персистится в `providerState`:** anthropic-side `/model` выбор (default/opus/sonnet/haiku) — это команда внутри Claude TUI, не часть proxy target. Persistence для Claude TUI model теперь живёт в app-wide `defaultClaudeModel` (`app_state` / StatusBar) и применяется при старте PTY через `/model <X>` перед `/effort`. Это сознательно не смешивается с `providerState`: providerState отвечает за маршрутизацию request body через proxy, а `/model` — за локальное состояние Anthropic TUI.

## Bridge врёт про active provider

`bridge.sh` (`~/.claude/statusline-bridge.sh`) показывает `model: "Opus 4.7"` — но это **выбор внутри Claude TUI** (через `/model`), а не реальная цель запроса после proxy. Если в Provider row выбран DeepSeek, запросы идут на `api.deepseek.com`, но Model row в InfoPanel всё равно покажет Opus (из bridge).

**Правда post-factum:** `message.model` в JSONL после ответа. DeepSeek в SSE `message_start` пишет свой `model: 'deepseek-v4-flash'`, и Claude Code это записывает как есть. Timeline собирает этот model look-ahead'ом по assistant-entries одного turn'а и показывает badge под футером tooltip'а. См. `fact-timeline.md::Provider badge`.

**Правда live (in-flight):** UI Provider row (одна из 3 кнопок Claude/DeepSeek/Zen, подсвечена). Per-tab state в main process.

Принцип «индикация что реально произошло — из server response, не из локального state» — см. `methodology/переносимый-дизайн.md::Truth from server response`.

## Effort/Think injection (deepseek mode)

Только для DeepSeek режима proxy **дописывает** в body запроса (от Claude Code) поля `thinking.type` и `output_config.effort` из per-tab state. Из чего складывается state:
- UI кнопки Effort row для DeepSeek = `[off][low][medium][high]` (4 значения, см. constraint выше)
- IPC `provider:set-options { tabId, effort }` обновляет per-tab state
- Proxy при следующем запросе **прозрачно** инжектит соответствующие поля. Claude Code сам ничего об этом не знает — он шлёт свой обычный Anthropic body, proxy перехватывает и модифицирует

**Почему не PTY-командами как для Anthropic:** Claude TUI команда `/effort high` управляет **Claude'овским** effort'ом. Если запросы летят в DeepSeek, эта команда бессмысленна — её эффект не доходит до DeepSeek API. Поэтому для non-anthropic режимов effort/think — **только** через proxy body inject.

## Connection Pooling (keepAlive)
Каждый режим имеет свой `https.Agent` с `keepAlive: true`. Без keepAlive каждый запрос = новый TCP + TLS handshake (~200-500ms). С keepAlive повторные запросы переиспользуют существующее TLS-соединение.

Codex делит один pool на все вкладки, но локальный request и внешний request —
две независимые половины. Прод-шрам 22.08.2026: краткий сбой OpenAI оставил
ровно десять outbound descriptors (`maxSockets=10`), после последнего ответа
proxy принял ещё 215 запросов (210 `/models`, 5 `/responses`), но не получил ни
одного response/error. Codex закрывал локальную половину по timeout, а proxy не
уничтожал queued/active upstream; HTTPS fallback вставал в тот же заполненный
pool. Claude не пострадал из-за отдельного agent, прямой Codex в iTerm обходил
proxy.

Контракт исправления причинный, не таймерная чистка pool. Downstream
`aborted/close` уничтожает точный upstream request. Metadata-запросы имеют
15-секундный абсолютный deadline до response headers, но модельный
`/responses` не имеет собственного proxy-deadline: очередь ChatGPT законно
может не отдавать заголовки несколько минут, и proxy не должен завершать запрос
раньше самого Codex. После headers длинный SSE также не ограничивается.
Upstream abort/error/ранний close закрывает обе половины.
Native WebSocket имеет собственный upstream ping/pong heartbeat: локальная
половина больше не может выглядеть живой при молча умершей внешней. Если
локальный Codex socket уже закрылся, его exact upstream не проходит graceful
close, а сразу `terminate`: потребителя больше нет, а ожидание close-handshake
на полумёртвом TCP как раз оставляет `CLOSE_WAIT`.
Node не вынимает уже уничтоженный queued request из `Agent.requests`, пока не
освободится активный socket; поэтому metadata deadline и downstream-cancel
проверяются на совместное очищение active+queued, а не только по флагу
`request.destroyed` одной записи. Для `/responses` владельцем времени ожидания
остаётся downstream Codex: его cancel/close освобождает тот же exact request.

Шрам 28.08.2026: большая сессия шесть раз получила WebSocket close `1009`,
после чего HTTPS fallback дошёл до нашего прежнего 60-секундного deadline.
Один идентичный retry получил `200` только через 55 секунд и завершился через
89 секунд; соседние `/models` отвечали меньше чем за две секунды. Значит,
абсолютные 60 секунд путали перегруженный, но живой model endpoint с мёртвым
соединением и создавали локальный `504`. Увеличение числа секунд только двигало
бы границу той же ошибки; правильная модель — отсутствие proxy-owned deadline
для model response при сохранённом exact downstream cancellation.

Трасса `[ProviderProxy:HTTP]` обязана проходить `accepted → socket-assigned →
response-headers → completed` либо заканчиваться `terminated` с request id,
tab/path и `active/free/queued`. Увеличение `maxSockets`, отключение keepAlive и
полный `codexAgent.destroy()` не являются ремонтом: первые два только меняют
момент исчерпания, третье роняет здоровые вкладки вместе с больной.

## Cache Stats Logging
Proxy перехватывает первый SSE `message_start` event в streaming response и логирует cache метрики, плюс шлёт `claude:cache-update` IPC в renderer для cooldown-чипа в ControlBar (см. `fact-claude-control-bar.md`):
```
[ProviderProxy] Cache: read=187000 create=1500 input=3 HIT
```
Поля: `cache_read_input_tokens` (из кэша, 0.1x стоимости), `cache_creation_input_tokens` (записано в кэш, 1.25x).

Эта же декомпрессированная SSE-копия — детерминированный источник live token counter для PTY Claude. JSONL пишет assistant message атомарно по завершении ответа и не даёт token-by-token прогресса; xterm показывает уже отрендеренный UI и мерцает при partial redraw. `message_start.usage` даёт input/cache baseline, последующие `message_delta.usage.output_tokens` на том же stream'е дают растущий output-counter. Поэтому live счётчик надо строить в proxy tap'е, который уже читает SSE, а не парсить терминальный экран.

**Эмпирическая проверка (апрель 2026):** 96% cache hit rate на 904 turns через proxy. Кэш работает — cache key вычисляется сервером по содержимому messages после JSON decode, а не по бинарному HTTP body.

**TTL кэша = 1 час, продлевается при каждом обращении (не 5 минут).** Claude Code для подписчиков ставит в запрос `ttl: '1h'` (декомпил: `should1hCacheTTL()` → `cache_control: {ttl:'1h'}`, поле `ephemeral_1h_input_tokens` в usage). Час считается **от последнего обращения**, не от создания: каждый ход с cache hit сбрасывает таймер обратно на 60 мин. Поэтому при работе с паузами < часа кэш живёт бесконечно; реально холодный пересчёт — только пауза > 60 мин без единого обращения. Проверено по JSONL за 29 мая: hit'ы после пауз 30-50 мин на цепочке ходов, miss — только на изолированных паузах > часа. **Ловушка измерения:** «пауза внутри одного JSONL» врёт — `--resume` копирует родительские записи со старыми timestamp'ами, и реальная пауза между ходами рвётся между слоями; мерить надо по всем сессиям проекта, отсортированным по реальному времени. Этот `ts` (момент `message_start`) — anchor для cooldown-чипа в ControlBar: остаток = 60мин − (now − ts).

**Rewind/откат НЕ инвалидирует prefix-кэш — он укорачивает префикс, а укороченный префикс уже закэширован.** Сервер кэширует по префиксу токенов на нескольких контрольных точках, окно которых скользит к хвосту диалога. Откат на 1-2 хода ставит точку рядом с хвостом, ближайшая живая контрольная точка прямо там → первый ход после отката читает почти весь префикс из кэша. Эмпирика этой сессии (откат на 1 ход): `read=339058 create=1518` — 100% reuse, заново создан только сам новый ход. Глубокий откат уходит за часть живых контрольных точек → частичный hit: `read=69689` из `502108` контекста (≈14%), остальное пересоздаётся. Полный `read=0` после отката случается **не из-за самого отката**, а когда префикс уже остыл по TTL (> 1h без обращения) — в сессии это был ночной откат в 00:58 с `read=0`. Вывод: при работе с короткими откатами кэш переиспользуется целиком; дорогой пересчёт даёт либо очень глубокий откат, либо остывший по времени префикс. **Метод проверки (на будущее):** rewind оставляет в JSONL развилку — `parentUuid` с ≥2 user-детьми; берёшь `message.usage` первого assistant-ответа в каждой ветке и смотришь `cache_read_input_tokens` против `cache_creation_input_tokens`. Это единственный способ измерить — в нашем коде поведения сервера нет.

**Ответ сжат — парсить надо на декомпрессированной копии, не на сыром потоке.** Anthropic шлёт SSE с `content-encoding: gzip` (иногда `br`). Первая версия искала regex `event: message_start` прямо в `chunk.toString()` сырого потока — в gzip-байтах текста `message_start` нет, match никогда не срабатывал, `claude:cache-update` не отправлялся, и чип на PTY-терминале оставался пустым **при тысячах успешных запросов**. Лечение: ответ зеркалится в `PassThrough` tap, tap прогоняется через `zlib.createGunzip()` / `createBrotliDecompress()` / `createInflate()` по `content-encoding`, и `message_start` ищется уже в распакованном тексте. **Реальный ответ клиенту (`res`) форвардится байт-в-байт, всё ещё сжатый** — декомпрессится только наблюдательная копия, чтобы не сломать клиента и не пересчитывать `content-length`. Декомпрессор глушит `error` (truncated stream), tap независим от forward-пути. Общий принцип — `methodology/переносимый-дизайн.md::Forward байт-в-байт, интроспекция на декодированной копии`.

**Что пробовали и почему диагностировалось долго:** симптом — «чип не показывается на терминале» — сначала увели в renderer (persist, busy-флаг), потому что старые логи (до смены поведения upstream на сжатие) содержали валидные `[ProviderProxy] Cache:` строки и казалось что данные есть. Решающий шаг — лог `firstChunkHead` первого чанка: показал байты `1f 8b` (сигнатура gzip), что мгновенно объяснило молчание regex'а. Урок: когда «событие не рождается» при живом трафике — логируй **сырой head источника**, не доверяй тому что апстрим отдаёт тот же формат что раньше.

## Semantic shadow для Claude и Codex

Та же независимая декодированная копия теперь питает общий read-only
наблюдатель живого ответа. Claude приходит как Anthropic SSE, Codex — как
Responses WebSocket либо HTTP/SSE. Это не новый History writer: видимый Claude
preview пока остаётся headless-проекцией, Codex — точным локальным semantic
socket, а proxy только сравнивает identity/type/hash/sequence с ними и с
каноническим JSONL. Ошибка наблюдателя не может задержать или изменить ответ
CLI.

Одного Claude session id недостаточно для ownership: prompt suggestion и
другие structured side requests могут идти с тем же id и обычными
`text_delta`. Первый main request допускается только после точного
`UserPromptSubmit`, продолжение после tool — только по выданному этой цепочкой
`tool_use_id` в следующем `tool_result`. Agent headers, structured
`output_config.format` и запрос без причинного владельца остаются
subagent/side/unknown.

App-controlled Codex получает per-tab `openai_base_url` только после
фактического старта proxy. Подписочный upstream выбирается по штатному
`ChatGPT-Account-Id`, API-key сохраняет `api.openai.com/v1`. WebSocket relay
обязан сохранить text/binary тип кадров, selected response headers, close code
и reason; перевод на HTTP ради упрощения наблюдения запрещён. Незавершённый
stream помечается gap и не засчитывается как parity, даже если успел прислать
внешне полный финальный event.

Port fallback имеет собственную гонку: неуспешный listen на занятом production
порту раньше оставлял `listening` callback и после успешного retry мог объявить
оба порта, отдав новой вкладке адрес чужого процесса. Каждая попытка теперь
владеет парой `listening/error` и снимает проигравшие listeners до retry.
Полный ownership и migration-gate описаны в
[`fact-живой-ответ-в-history.md`](fact-живой-ответ-в-history.md).

## Graceful Shutdown
При `before-quit` proxy drain'ит активные соединения (до 15s). Без этого crash mid-stream → assistant response не записывается в JSONL → chain break в backtrace. См. [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) секция 2.2 (Generic Chain Break Recovery).

## Ловушки

### cch= Billing Sentinel
Claude Code вставляет `x-anthropic-billing-header` с xxHash64 от body в system block. Если proxy ресериализует JSON (thinking strip после Zen), hash ломается. Не блокирует запрос, но может влиять на billing attribution. Опаснее: если в tool_result когда-либо появился текст `cch=XXXXX` (из логов), Claude Code мутирует его при каждом запросе, перманентно ломая prompt cache на оставшуюся сессию.

### Attribution header kill — стабилизация cache prefix
Мы спавним Claude (PTY shellEnv + SDK через `process.env`) с `CLAUDE_CODE_ATTRIBUTION_HEADER='0'`. Этот заголовок (`cc_version=<v>.<fingerprint>; cc_entrypoint=cli; cch=00000;`) Claude вставляет **первой строкой системного промпта**; `fingerprint` считается от первого user-сообщения, а `cch=00000` placeholder перезаписывается native HTTP-стеком на хэш **тела всего запроса** перед отправкой. Тело меняется каждый ход → хэш дрейфует → первые байты промпта дрейфуют → серверный prefix-кэш ищется по началу и не находит → `cache_read` коллапсирует, всё уходит в `cache_creation` на полном тарифе. Бьёт по длинным сессиям (≈20K системного промпта re-billed каждый ход) и особенно по fork/`--resume`, где родитель и форк имеют идентичный prefix и **должны** делить кэш. Декомпил: гейт `isAttributionHeaderEnabled()` в `constants/system.ts` — `isEnvDefinedFalsy(env) → header=''`. Это документированный killswitch Anthropic (для OAuth-юзеров заголовок и так skip'ается), не хак; теряется только их телеметрия версий. **Не возвращать заголовок «для атрибуции»** — это и есть причина cache-miss. Связь с `cch=` Billing Sentinel выше: там ресериализация ломала hash в нашем proxy, здесь — сам Claude дрейфит prefix даже без нашего вмешательства.

### Proxy Crash = Chain Break
Если proxy/Electron падает mid-stream, Claude Code пишет `api_error` с parentUuid на assistant-ответ, который был в памяти но не на диске. Backtrace прерывается. Решение: generic chain break recovery + graceful shutdown.

### content-length
Ранее proxy удалял `content-length` (→ chunked TE). Сейчас пересчитывает через `Buffer.byteLength(body)` для корректного fixed-length request.

### Socket close listener leak (keep-alive aware)
В обработчике каждого запроса проксика регистрирует socket в Set активных соединений и вешает `socket.once('close', ...)` для cleanup. С `keepAlive: true` **один TCP-сокет обслуживает много HTTP-запросов** — без guard каждый запрос вешал бы свой close listener на тот же сокет. После 11 запросов на одном keep-alive сокете Node начинал писать `MaxListenersExceededWarning: 11 close listeners added to [Socket]`. Обёртка:

```js
if (!proxyActiveConnections.has(socket)) {
  proxyActiveConnections.add(socket);
  socket.once('close', () => proxyActiveConnections.delete(socket));
}
```

Set membership используется как **двойной guard**: и для tracking активных соединений (нужно для graceful shutdown), и для предотвращения двойной подписки на close. AI без этого контекста легко уберёт `if (!has)` как избыточный — оба поведения слиты намеренно.
