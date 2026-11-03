# Fact: MCP-хаб — один общий комплект MCP-серверов на все AI-вкладки

## Проблема, которую решает

MCP по stdio = дочерний процесс клиента: каждая Claude/Codex-сессия поднимала
СВОЮ копию всех шести серверов (knowledge, terminal, browser, electron, ios,
sc-desktop). При ~10 открытых сессиях это 60-70 процессов и ~2 ГБ ОЗУ —
измерено панелью ресурсов (phys_footprint). Замер до миграции: 70 процессов,
2030 МБ; после перезапуска всех вкладок останется один комплект ~200-300 МБ.

## Что можно доказать после принудительного Build Install

SOURCE20.10 installer сохраняет доступные server PID/start/pending counts и
client presence до Quit и после запуска Noted. В самом hub пока нет долговечного
журнала всех RPC с exact tab/provider-turn owner: ChildServer pending — RAM Map,
а clients — TTL presence. Нулевой count и пропавший HTTP-клиент не доказывают Stop
удалённой операции. Detached hub/children могут пережить Quit; external/plugin/
отдельные stdio MCP вообще не покрыты этим источником. Поэтому installer report
различает сохранённый/остановленный процесс и неизвестный исход вызовов, не
называет все MCP прерванными и не даёт права replay. Build Install имеет отдельную
сохранённую typed job в правом per-tab request dock, а не в глобальном health chip.

## Установка обновляет файл сервера, но не процесс (02.11.2026)

Хаб detached (`ppid=1`) и переживает Build Install намеренно: иначе каждая
установка рвала бы MCP всем вкладкам сразу. Новый Main на старте вызывает
`ensure()` и принимает уже живой хаб как есть (`if (existing && !needsUpgrade)
return existing;`), до `launch()` не доходит. Отсюда разрыв: на диске лежит
новый `~/.claude/mcp/terminal-server.mjs`, а в памяти продолжает исполняться
старый.

```text
17:13  хаб 99730 поднят, им запущен terminal-server     (код от 17:13)
20:28  установка заменила app.asar и файл сервера        (на диске новый)
20:29  новый Main принял прежний хаб                     (всё ещё код 17:13)
20:40  сосед вручную POST /mcp/_restart/terminal         ← только здесь
20:42  вкладки ловили stale_transcript_revision
```

Доказательство, что установка детей не трогала: у `terminal` в `/mcp/_status`
стоял `restarts: 1` — ровно тот ручной.

Теперь установщик делает это сам. В цикле `PREPARE_SCRIPTS` шаг
`install:terminal-mcp` запускается с `capture: true`, и его вывод (тот же
единственный JSON, что скрипт уже печатал) читается на предмет
`changed.runtime`. Это поле выставляется только при реальном отличии
содержимого от установленного — свой детектор завёл бы второй источник правды о
том же факте. Захваченный текст сразу печатается в лог установки: парсить вывод
не значит его терять.

Четыре границы, каждая из которых обязательна:

**Только `terminal`.** Не `_restart-all` и не смена поколения хаба: у `electron`
и `ios` в `~/.noted-terminal/mcp-hub.json` стоит `stateful: true`, и рестарт
сбросил бы им живое состояние — CDP-подключение и сессию симулятора. Остальные
пять серверов установщику не принадлежат.

**Только при доказанном изменении.** `changed.runtime === false` — ничего не
делаем, запрос не уходит вовсе: лишний рестарт роняет живой сервер на каждой
установке, которая меняла только приложение.

**Нераспознанный вывод — не «не менялось».** Если JSON шага не разобрался,
перезапуск всё равно выполняется: пропустить его на неизвестном ответе значит
воспроизвести исходный шрам, а лишний рестарт — заметно более дешёвая ошибка.

**Недоступный хаб не роняет установку.** Приложение и файл на диске уже
обновлены; терять готовую установку из-за несработавшего HTTP несоразмерно —
сервер поднимется позже сам, уже с новым файлом. Причины различимы в логе:
`hub_unavailable` (хаба нет), `timeout`, `hub_refused` (ответил отказом),
`fetch_unavailable`.

Клиентов рестарт не рвёт: постоянного сокета к 53133 у вкладок нет, каждый вызов
инструмента — отдельный HTTP-запрос, а `restartServer` поднимает только ребёнка,
оставляя порт и сам хаб живыми. Список инструментов не меняется — сервер тот же,
пересоздавать сессии не нужно. Проверено живьём: один вызов
`POST /mcp/_restart/terminal` дал `restarts 47 → 48`, у остальных серверов
счётчики не изменились.

Код — `scripts/refresh-terminal-mcp-runtime.mjs`, контракт —
`scripts/refresh-terminal-mcp-runtime.test.mjs`. Тесты не ходят в живой хаб:
первый прогон случайно перезапустил рабочий сервер дважды, потому что
`fetchImpl: undefined` не включал значение по умолчанию. Теперь транспорт
подставляется явно, а `url` указывает в заведомо закрытый порт.

## Архитектура

```
Claude/Codex вкладка ──HTTP──▶ mcp-hub (порт 53133) ──stdio──▶ настроенные дети (по одному)
```

- **`src/main/mcp-hub.js`** — standalone-процесс (`node mcp-hub.js --standalone`),
  detached от Electron: переживает ребилды приложения, живые сессии не теряют
  инструменты. Main его **усыновляет или спавнит** через общий controller и
  нянчит probe'ом каждые 60с; при смерти хаба — respawn. Старый хаб без исправленного
  launch environment при 0 готовых серверов и ENOENT/code127 заменяется штатно
  только с known-zero pending/recovery и сохранением зарегистрированных имён,
  а не принимается как здоровый только по отвечающему HTTP. Изолированный E2E-main
  может пользоваться уже запущенным хабом, но не имеет права занимать глобальный
  порт, иначе временная копия из `/private/tmp` становится владельцем production-
  интеграций и поднимает устаревший код после завершения теста.
- Каждый ребёнок спавнится ОДИН раз, HTTP-запросы бриджуются в stdio с
  ремапом JSON-RPC id (много клиентов на одну трубу). `initialize` отвечается
  из кэша хендшейка; `server/discover` (проба Claude) отвечается локально.
- Ребёнок упал → pending-запросы фейлятся, respawn с backoff; следующий запрос
  прозрачно попадает в новый процесс, кроме Browser под persistent maintenance hold.
  Ручной рестарт: `POST /mcp/_restart/<name>`;
  общий — `POST /mcp/_restart-all`, listener и identity клиентов остаются живыми.
  Совпавшие ручной/общий/catalog recovery объединяются на конкретном ребёнке;
  новый процесс запускается после exit старого, позднее событие старого не может
  очистить нового. Успех означает initialize всех нужных детей, не только spawn.
- Живой PID не считается достаточным доказательством здоровья. Короткие запросы
  каталога (`tools/list` и соседние list-методы) имеют четырёхсекундный timeout:
  при зависании хаб одним общим recovery перезапускает только этого ребёнка и
  повторяет запрос один раз, если не выполняется другой tool call. Catalog timeout
  не даёт права отменить активную операцию. Обычные `tools/call` не получают общий короткий
  timeout, потому что индексация и другие реальные операции законно идут минуты.
- stdout детей трактуется как NDJSON построчно. Невалидная диагностическая строка
  логируется и отбрасывается отдельно; её нельзя накапливать перед следующими
  JSON-ответами — один такой префикс навсегда делал все последующие ответы
  непарсируемыми при внешне живом процессе.
- После успешного занятия порта хаб **реапит осиротевших детей** прошлого хаба (ppid 1 + путь
  сервера из своего списка; `sc-desktop` матчится по `reapMarker` server.js,
  потому что run.sh экзекается в Electron). SOURCE Browser child/helper исключены
  из marker-only reaper: им нужны собственные journal birth pins. Detached bridge.js
  браузера также НЕ реапится.
  Проигравший одновременный старт не получает права на reaping. Main получает
  одноразовый IPC ready от нового detached-хаба, затем отпускает IPC; shutdown
  старого подтверждается закрытием его HTTP-соединения перед повторным bind.

`configurationMatches` в `/_status` сравнивает ожидаемый fingerprint из заголовка
клиента с fingerprint текущего хаба. Обычный диагностический GET без этого
заголовка получает `false` даже при работающих шести серверах: это не отдельное
доказательство неверного профиля или причина для restart. Отдельно сверяются
`up/initialized/recovering/pendingRequests/lastError`; нулевой pending не означает
drain долговечных владельцев Browser/Research или право повторить UNKNOWN.

### SOURCE19.10: host-owned Browser maintenance

Hub перечитывает SC file fence до всех Browser spawn paths и прямо перед stdin.
Новый cooperative child удостоверяется SOURCE hash contract; host хранит generation,
точные child/helper birth pins и UNKNOWN/no-replay carry, не credentials/prompt text.
`/mcp/_browser-maintenance` — authenticated identity-only control; SC независимо читает
durable host receipts. Неполный profile scope shared child не разрешает его retirement.
После worker-open ACK host отвечает release_ready, но запускается только после
финального Main activation commit. Другие пять bindings/lifecycle не заменяются.
SOURCE20.10 различает этот commit и generation текущего процесса: после обычного
restart того же durable host подтверждённая activation остаётся действующей через
точную lineage enrolled process, прежние config/authority/fence/receipt. Исторический
cohort не переписывается. Один released ingress, новый PID или пустой журнал не
разрешают запуск; incomplete activation, новая maintenance и неизвестный child spawn
остаются закрытыми. До этой правки новый Noted hub снова блокировал Browser, хотя
SC activation-resume честно подтверждал завершённый прежний barrier.
Проверены private host/journals и отрицательные guards, не installed rollout.
Старый живой hub под hold не становится cooperative от изменения файлов: controller
возвращает typed bootstrap blocker, не shutdown/spawn. Это enrolled cohort protocol,
не certification старых VR/bridge/loaded-CS authority и не installed assertion.
Private Mac stdio/HTTP/SQLite/WS tests проверяют этот путь с controlled browser/native/
worker leaves. Darwin Z/<defunct> уже не исполняется; ошибки инспектора не дают absence.
Enrollment связывает child с parent-selected canonical ingress path, dev/ino pin
каталога и digest; explicit path передаётся и detached controller. Другой MCP HOME/
SC_DESKTOP_DIR сохраняется как конфигурация, но не выбирает другую authority.
Первый epoch/fence записывается до ошибки held и восстанавливается из child journal
до нового Browser spawn. Пропавший/заменённый binding, epoch или basis не становится
пустым разрешением. Причина: actual Mac stdio-проба прежде проходила native startup
в отдельном HOME между file-first hold и host ACK; текущие guards блокируют её.
Darwin E/P_WEXIT с потерянным argv — typed pending-exit, не replacement и не absence.
Exact retirement ждёт actual absence/Z; другой birth/inspection failure/timeout
остаются закрытыми. SOURCE Voice Record теперь использует те же byte-identical
host wire/authority protocol как отдельный configured Browser MCP-клиент; это не
новое звено Noted External Research и не смена владельца hub. Его positive/negative
private checks не покрывают старые VR/bridge/loaded-CS или installed handover.
Enrolled receipt по-прежнему не объявляет историческое UNKNOWN известным.

31Oct: удаление только `KNOWLEDGE_CODEX_MODEL` из default knowledge registration
изменило общий configuration fingerprint. Следующий bundled hub сохранил released
ingress, но `hostHeld` отверг старую completed activation по несовпадающему
configurationDigest: Browser не спавнился, остальные пять MCP работали. Это
реальный transport hold, в отличие от false-down UI ниже. Возвращён прежний
compatibility token в resolver; helper по-прежнему исполняет Luna6. Подпись
включает также status/provenance: перенос тех же args/env в profile entry сам
по себе меняет её и не восстанавливает старое доказательство. Guard не ослаблен.

После нового прямого поручения выполнен exact-PID normal hub handoff с прежним
ENV/registration fingerprint, после pending0/known native journal/операционной
паузы. Startup заново проверил существующие activation/lineage: journal/fence/epoch
не сбрасывались, release API не вызывался. Первый мгновенный sample ещё видел
инициализацию четырёх children; поздний tools/list + actual calls подтвердили6/6.
Финал: same Noted Main/AI SID+PID, same native bridge/storeEpoch/11 records, Browser
list_browsers/list_tabs/USER_SCRIPT read в том же Яндексе; Chrome offline без действий.
Это не refresh tool catalog каждого старого Codex и не публикация Browser extension.

SOURCE24.10: ошибка чтения maintenance authority не превращает успешный HTTP
status хаба в `null/servers:[]`. Controller сохраняет фактические PID/initialize
всех configured children и возвращает отдельный typed `browserMaintenance.held`.
UI исключает held Browser из ready count, обозначает его янтарным и блокирует
его/global restart; доступность остальных пяти серверов сохраняется. Это важно
при несовместимом wire reader: живой hub не равен доступному Browser, а ошибка
Browser fence не доказывает падение Terminal/knowledge/electron/ios/SC.
Формат нового authority digest, включая optional `profileUpdatePlan`, обязан
совпадать у writer и всех реально загруженных readers. Source SHA и успешная
сборка этого не доказывают; detached hub/native bridge и independent VR parent
обновляются отдельно с прежними ingress epoch/basis и UNKNOWN carry. Не удалять
старый fence ради совместимости. При штатном reconnect сохраняются instanceUUID
и SW runtime, connectionId меняется; offline runtime-cache нового bridge может
быть unknown, без запуска отсутствующего Chrome.

### 19.09.2026: все серверы красные, перезапуск ничего не меняет

Хаб PID1018 был запущен установленным приложением с PATH
`/usr/bin:/bin:/usr/sbin:/sbin`. Node физически имелся в `/usr/local/bin/node`, но
пять `spawn('node')` возвращали ENOENT; SC wrapper с `env node` завершался code127.
После двух переоткрытий main логировал `adopted ... 0/6`; каждый ребёнок накопил
более 320 неудачных повторов. Кнопка действительно отправляла restart, однако
использовала то же окружение и игнорировала `{ok:false}`. Быстрое закрытие/открытие
не доказано причиной; сохранение нездорового detached-хаба доказано статусом/логами.

Хаб теперь дополняет PATH runtime/Homebrew/local bin-путями, выбирает абсолютный
Node для node-серверов и передаёт тот же PATH shell-wrapper'ам. Исправление внутри
хаба необходимо даже при правильно настроенном main: detached-процесс может быть
запущен отдельно или усыновлён после app restart. Привилегированные main credentials
исключаются через общий child-env helper, per-tab identity по-прежнему только в RPC.
Сотни повторов и изменение тайминга respawn не могут исправить неправильный PATH.

Ручное восстановление production шло через существующий `_shutdown` и канонический
repo source, без остановки NT/AI-вкладок или дополнительных stdio-копий. Новый хаб
с намеренно минимальным macOS PATH подтвердил 6/6 initialize и tools/list каждого.
Постоянные main/UI-изменения требуют следующей штатной сборки NT; живой repaired-хаб
переживает закрытие приложения, но установка старого bundle сама код не обновляет.

## Identity: кто звонит

Серверам с per-tab состоянием нужно знать вкладку. Хаб кладёт identity каждого
запроса в `params._meta.noted = {tabId, projectId, cwd, mainPid, instanceRoute?}`:

- **Claude** умеет `${VAR}` в url (`services/mcp/config.ts::expandEnvVars`):
  `~/.claude.json` → URL с tab/project/cwd/mainPid и `instanceRoute=${NOTED_MCP_INSTANCE_ROUTE:-}`.
  Неразвёрнутый плейсхолдер (`${...` literally) хаб трактует как пусто.
- **Codex** НЕ разворачивает env в url. Используется `bearer_token_env_var =
  "NOTED_MCP_IDENTITY"` → заголовок `Authorization: Bearer <tab>|<project>|<cwd>|<mainPid>|<instanceRoute>`; прежние четыре поля поддерживаются.
  Токен без `|` считается чужим auth-токеном и игнорируется (аноним).
  Переменную составляет PTY env (`NOTED_MCP_IDENTITY` в terminal:create) и
  дублирует composition-строка в `~/.zshrc` И `~/.zshenv` из `NOTED_PARENT_*`
  (shell-integration ZDOTDIR приложения обходит ~/.zshenv, поэтому в двух местах).
- **SDK-вкладки**: `mcpServersViaHub()` в main переписывает шесть серверов на
  hub-url с identity; если хаб недоступен — `mcpServersStdioFallback()`
  возвращает старые stdio-спавны (capability сохранена), и main пинает ensure.
- Без identity (обычный терминал) — аноним: cwd-роутинг, как раньше.

Main формирует instanceRoute как base64url JSON версии1 с discoveryDir и
appRuntimeIdentity.instanceId. Credentials и публичного port/root override в
tool schema нет. Hub переносит значение per-request, но удаляет
NOTED_DISCOVERY_DIR и NOTED_MCP_INSTANCE_ROUTE из общего child ENV: один клиент
не становится ambient owner остальных. Terminal закрепляет оба сервиса/токен
своего root, проверяя PID/instance; stale binding не падает в host. Header-проверки
обновлённого Main/API отказывают до dispatch. Шрам17.10 private tab=null/exists=false
был ошибкой маршрута до message POST, не writer guard и не удалением вкладок.
Actual private Luna roundtrip выполнен через общий hub, без альтернативных stdio.
Состояние по-прежнему читается в current_context.tab либо passive inspect_tabs;
новых top-level writer полей нет.

## Что переделано в самих серверах

- **terminal-server.mjs**: константы `PARENT_TAB_ID`/`PARENT_PROJECT_ID`/
  `PROJECT_CWD` стали функциями поверх `AsyncLocalStorage` — каждый tools/call
  оборачивается в scope со своим `_meta.noted`; stdio-запуск без meta работает
  по env как раньше. `NOTED_MAIN_PID`-хинт роутинга тоже через meta (`mainPid`).
- **knowledge-server.mjs**: `resolveProjectDir(args, meta)` — приоритет
  `args.projectPath → meta.cwd → CLAUDE_PROJECT_DIR → default`. Плюс вложенный
  `codex exec` в `routeViaCodex`/`runCodexIndexFile` получил `-c 'mcp_servers={}'`
  — роутер-промпт запрещает tools, а без этого флага вложенный codex поднимал
  весь MCP-флот (~380 МБ и секунды старта) ради текстового JSON-ответа.
  С30Oct default — `gpt-6-luna`/low; старый environment-default `gpt-5.6-luna`
  нормализуется в helper, explicit per-call модель и остальные ENV-модели сохранены.
  Совместимый ENV-токен прежней регистрации сохраняется в hub config: он входит
  в Browser authority fingerprint, хотя фактическую модель уже выбирает helper.
  Live helper обновляется отдельным idle restart knowledge, без App build/
  глобального hub restart/перезапуска AI.
  С01.11.2026 у роутера есть автоматический запасной провайдер. Codex остаётся
  основным, но его отказ (исчерпанный usage limit, auth, снятая модель) —
  это ОТВЕТ провайдера за секунды, а не зависание, поэтому таймер не нужен и
  вреден: порог в1с резал бы обычные успешные запросы (замер: отказ Codex
  приходит за5.7с, успешный Haiku-роутинг —4.5с). Вместо таймера ловится сам
  отказ, и запрос один раз повторяется через `claude -p --model haiku`
  (локальная подписка Claude Code, без Gemini API и без кредитов Codex).
  `KNOWLEDGE_DISABLE_CLAUDE_P` теперь по умолчанию `false`; `true` выключает
  запасной путь обратно. Ответ «нет подходящих файлов» — настоящий результат и
  НЕ повторяется, иначе роутер ходил бы дважды на каждый пустой поиск. Gemini
  остаётся выключенным: он бьёт по платному API. В результате появляется
  `fallbackFrom` с исходной ошибкой Codex — видно, что ответ дал запасной путь.
  То же касается `docs_reindex`: он был Codex-only (`runReindexAttempt` явно
  отвечал «reindex is Codex-only»), поэтому при исчерпанном Codex индекс нельзя
  было обновить вообще. Теперь `runCodexReindexAttempt` принимает provider и
  гоняет файлы либо через `codex exec`, либо через `claude -p` (`runClaudeIndexFile`,
  тот же промпт и тот же разбор ответа). Запасной путь включается, только если
  ВСЕ файлы упали с одной провайдерской причиной — это отказ батча, а не плохие
  документы; разные ошибки по файлам означают настоящие проблемы разбора и НЕ
  повторяются. «Провайдерская причина» — не только лимиты: 03.11.2026 Codex
  ответил `The 'gpt-6-luna' model is not supported when using Codex with a
  ChatGPT account`, что не совпало ни с одним из прежних шаблонов (usage limit/
  quota/auth), standby не включился, и один изменённый файл молча остался
  непроиндексированным при бодром `success: false` на весь прогон. Теперь
  условие покрывает и недоступную аккаунту модель (`model is not supported`,
  `unknown model`, `model_not_found`, `does not have access`, `not available to
  your account`). Проверено на обоих классах: настоящие ошибки файлов
  (битый JSON, ENOENT, таймаут) по-прежнему НЕ считаются отказом батча.
  ВАЖНО про флаг: hub config (`mcp-hub-config.js`) принудительно передаёт детям
  `KNOWLEDGE_DISABLE_CLAUDE_P=true`, и этот env входит в активированный Browser
  cohort digest — менять его нельзя, иначе Browser снова отвалится (ровно шрам
  30.10). Поэтому два смысла разведены в самом сервере: прежний флаг по-прежнему
  запрещает ВЫБРАТЬ Claude явно (Codex остаётся роутером по умолчанию), а
  запасной путь управляется отдельным `KNOWLEDGE_DISABLE_CLAUDE_STANDBY`
  (по умолчанию выключен, т.е. standby включён). Если бы standby зависел от
  старого флага, исчерпанный Codex оставлял бы docs_search мёртвым до сброса
  квоты, что и наблюдалось.
- **electron-mcp** (connection.mjs): синглтон state → `Map clientId → {state,
  lastConnect}` за Proxy; каждый клиент держит СВОЁ CDP-подключение (два клиента
  одновременно на 9236 и 9237 проверены). Колбэки (`disconnected`, `close`,
  `window`, `page`) биндятся к контексту момента подписки, не к Proxy.
  Native OS input при этом имеет отдельного общего process-level owner в
  `tools.mjs`; потерянная квитанция может удерживать там UNKNOWN. Swift lease
  не заменяет это состояние: helper может очистить lease до потери своей
  квитанции, а её путь зависит от temporary directory. Отдельный process с
  импортом тех же functions создаёт другого JS owner и не доказывает состояние
  hub. До31Oct `electron_native_input_status` при отказе source helper скрывал
  даже JS owner. Исправленный error receipt сохраняет исходный отказ и добавляет
  свежий `nativeOwner` после await; `nativeAdmission.available` остаётся false,
  а непрочитанная lease — unknown. Idle JS owner не означает свободную OS lease
  и не разрешает restart. Проверки охватывают idle/running/UNKNOWN и сохранение
  исходного blocker через MCP serialization; helper readiness не сбрасывает owner.
  Успешный preflight после отдельного restart child не доказывает причину прежнего
  перемежающегося EPERM. Не подменять owner пустой local lease,
  нулём общих pending RPC или неподдержанным zero-delta вызовом как reservation.
- **ios-mcp** (tools.mjs): 7 модульных `let` → `S()` поверх AsyncLocalStorage
  (свой симулятор/appium/WDA у каждого клиента).
- **browser** и **sc-desktop** — без изменений (SDK-серверы, `_meta` проходит
  прозрачно; browser уже был multi-client через общий bridge.js).
- Закрытие вкладки: `terminal:kill` → `notifyMcpHubTabClosed(tabId)` → хаб шлёт
  stateful-детям (electron, ios) `notifications/noted/client-closed` → dispose
  контекста (закрыть CDP, убить WDA-сессию). Плюс TTL-свип 6ч в хабе.

## UI

### Docs Search: индекс выбирает директория вкладки

Workflow организует вкладки, но не имеет отдельного MCP-процесса или модели.
Общий knowledge использует `projectPath`, затем caller cwd; одна вкладка main
может искать в custom-terminal, соседняя — в sc-desktop. В home `/Users/fedor`,
`/` и пустом workflow отсутствие проектной `docs/`/индекса не означает падение
MCP: передать точный `projectPath` с нужной базой. Общие `docs-global/` patterns
добавляются к проектному индексу, а не заменяют отсутствующий проектный индекс.

Успех initialize проверяет транспорт, а не Codex-доступ или актуальность индекса.
Freshness проверяется hashes индексируемых Markdown, не возрастом `.json`.
Полностью cached reindex не вызывает модель. Проверка реального поиска требует
model result и выбранных существующих sections; `found:0/raw:[]` — отсутствие
совпадений данного запроса, не transport failure. No-index/read/JSON ошибки helper
различает как `index_missing/index_unreadable/index_invalid`; не объяснять все
три отсутствующим файлом.

429 при reindex — сохранённый отказ provider; из одной строки нельзя установить,
какой лимит/аккаунтная квота/нагрузка его вызвали, или считать модель недоступной.
Неудачный файл сохраняет предыдущий полный индекс. Повтор через MCP с
`parallel:1` и целевой Luna6 обрабатывает только changed/missing entries; это
снижение конкуренции, не обход лимита.30Oct main188/188, FlowTab61/61 иportfolio11/11
реально обновлены без ошибок после исходного429; проверен живой default Luna6.

### Панель хаба и нативный каталог Codex

`McpHubButton.tsx` в шапке рядом с ResourceUsageButton: точка-статус
(зелёная 6/6 / янтарная часть или неизвестный статус / красная 0 готовых в прочитанном списке), панель со списком серверов
(pid, аптайм, счётчик рестартов), кнопка рестарта per-server, кнопка
«Перезапустить MCP хаба» при открытом maintenance; при недоступном хабе — «Восстановить хаб».
Во время запроса виден процесс, повторные клики заблокированы. Ошибка IPC/HTTP или
`ok:false` показывается целиком, частичный успех не выдаётся за полный; длинный
lastError в строке доступен по hover. При недоступном хабе UI не обещает stdio-
fallback всем клиентам: такой запасной путь есть только у SDK.
IPC: `mcp-hub:status`, `mcp-hub:restart-server`, `mcp-hub:restart-all`,
`mcp-hub:ensure`. Опрос статуса — только при открытой панели (3с) или редкий
для точки (30с). Панель ресурсов: `mcp-hub.js` добавлен в
`SHARED_SERVICE_PATTERNS` (process-metrics-grouping.js) — не «брошенный», из
панели не убивается. Зелёный учитывает не только PID, но и завершённый initialize
и отсутствие активного recovery; во время автоматической замены ребёнок янтарный.

С 04.10.2026 source-панель также содержит `Codex · конфигурация`: внешние MCP и
MCP установленных плагинов появляются/исчезают по нативному каталогу, без отдельной
правки под название сервера. «Настроен»/«отключён» относятся к конфигурации, а не
к соединению уже запущенной вкладки; для него остаётся `/mcp`. У внешних строк нет
выдуманного PID, uptime, зелёного connected или кнопки рестарта хаба. Счётчик и
зелёная точка по-прежнему подтверждают initialize только детей хаба. Popup скроллится,
поэтому большой каталог не выдавливает строки за viewport.

Старый installed Main при `research_ingress_storage_invalid` мог вернуть в UI
fallback `{servers:[],down:true}` после успешного HTTP ответа хаба. Нижний список
тогда ошибочно подписывал все configured hub URLs «нет в хабе». Это один разрыв
чтения служебного статуса, не независимое отсутствие шести registrations; проверка
actual `_status` с expected header отделяет его от настоящего missing binding.
Сырая ошибка под Restore берётся из `restartError` предыдущего действия, не из
native config. Иконка только раскрывает popup; Restore/Restart вызывает общий
MCP restart/ensure, не app build/install и не reload native MCP у всех AI-клиентов.

SOURCE25.10: renderer отдельно проверяет наличие прочитанного списка через
`hasHubInventory`: `down:true`, отсутствующий/неправильный `servers` и первый
непрочитанный статус не доказывают missing routes. В этих состояниях шапка и
hub registrations показывают «статус неизвестен», точка янтарная; предупреждения
«все отсутствуют» и заявления о недоступности инструментов не выводятся.
Успешно прочитанный пустой/частичный список по-прежнему позволяет показать
настоящие «нет в хабе». Disabled и external/plugin configuration не получают
выдуманный connected. Сохранённая ошибка restart подписана «Последняя попытка».
Проверены7 конечных presentation controls,4 actual-JSX SSR snapshots и1 controller
storage-error control без spawn/POST. Эффекты/IPC в SSR управляемые; это не
production Electron E2E и не доказательство загрузки исправления старым Main.

`mcp-hub:codex-catalog` читает native `config/read`, `plugin/installed` и
`plugin/read` через отдельный metadata app-server без threads/tool calls.
Scope — cwd реально показанной вкладки окна в фокусе; Home/chooser используют
корень своего проекта, Inbox не исключается. Native API сам разрешает global/
trusted-project layers. Managed hub URL определяется по endpoint и реестру хаба,
поэтому aliases не дублируются, а внешний сервер с таким же именем не скрывается.
Авторизация и запуск внешних MCP остаются у Codex.

При открытой панели чтение идёт раз в 3с, main объединяет совпавшие запросы,
кэширует snapshot на 2.5с и ограничивает один read 12с с закрытием своего процесса.
Metadata helper закрывается через 15с простоя/shutdown; новая вкладка и inference
не создаются. Plugin names кешируются на 30с с ключом scope/id/version/localVersion/
installedAt; новые/удалённые plugins меняют список по `plugin/installed`, правка
существующего пакета без новой версии может быть видна после этого TTL.
Первый plugin read выполняется максимум четырьмя параллельными запросами.
Изменение plugin settings обновляет только свой metadata client, без трогания агентов.
Ошибка сохраняет последнюю полезную конфигурацию своего scope и видимый статус;
поздний ответ другого cwd не заполняет новую панель. Headers/env/args/instructions,
credentials и секреты URL не передаются renderer; HTTP display показывает origin.

Наблюдение25Oct на Codex0.164: `plugin/installed` успешно вернул4marketplaces,
а9remote `plugin/read` получили HTTP404 `Plugin not found`. Reader оставил полезные
config/builtin rows и `plugins_unavailable/stale`. Такое предупреждение означает
неполный metadata refresh, не failure живых MCP. Из одного404 нельзя определить,
удалён plugin или недоступен этому аккаунту, и нельзя автоматически удалять записи.

Приёмка: 47 профильных checks, actual React/Electron+IPC/private hub (add/remove,
partial failure/retry, late cwd, прежний all/single restart), native Codex0.159.2
с приватным config и установленным local plugin. Чтение видит plugin MCP/изменение
enabled, stdio-marker не создан и HTTP-запросов к MCP0. Отдельный readonly UI показал
реальный figma_console/yandex-wiki и production status, без restart или Figma calls.
Paired main/renderer build PASS; source ещё не установлен. Артефакты:
`/private/tmp/noted-mcp-catalog-20261004.fouy8eg6`.

## Конфиги (источник правды)

- `~/.noted-terminal/mcp-hub.json` — machine-local launch bindings. Main и standalone
  hub читают bounded stable snapshot; source install его не создаёт и не применяет
  к уже живому Map. Профиль владеет перечисленными entries; omission сохраняет
  прежний ENV соседей, `enabled:false` явно отключает. Command/args/env/stateful/
  reapMarker не извлекаются из клиентского HTTP URL. [Форма и применение](../setup/mcp-hub.md).
- `~/.claude.json::mcpServers` — клиентские `type: "http"` на hub-url с `${VAR}`;
  исторический maintainer-профиль содержал все шесть.
- `~/.codex/config.toml::[mcp_servers.*]` — клиентские `url = ...` +
  `bearer_token_env_var = "NOTED_MCP_IDENTITY"`. Верхнеуровневый
  `mcp_optional_startup_grace_ms = 0` заставляет Codex ждать штатный
  `startup_timeout_sec`, а не молча выбрасывать один сервер через дефолтную
  секунду; это окно вмещает четырёхсекундное recovery каталога.
- Бэкапы: `~/.claude.json.bak-hub-*`, `~/.codex/config.toml.bak-hub-*`,
  код серверов до правок — `~/mcp-backups-<ts>/`.

### Внешний MCP в Codex не становится ребёнком хаба

10.10 по прямому запросу Fedor удалена общая таблица `MCP processes` со всеми
systemPID/owner/Stop/Stop-orphans, не сама панель хаба или native config.
Не возвращать её как диагностику обычной вкладки: shared6servers и их health/
restart обслуживают все сессии; дополнительныеstdio подключения имеют другого
владельца/транспорт. Отдельные Appium и browserbridge не завершаются по закрытию
произвольной AI-вкладки. Списки владельцев/OS-liveness не смешивать; proof и
границы false-orphan — `fact-resource-usage-panel.md::Брошенное против служебного`.

Список хаба задаёт profile/ENV resolver, не произвольные записи Codex/Claude.
Исторический maintainer-срез содержал шесть stdio-серверов. Первая portable-дельта
14.10 сохранила только terminal/knowledge defaults, а четыре остальных требовала
через explicit `NOTED_*` пути без переноса прежних code bindings. Текущий SOURCE
читает постоянный профиль и совместимый ENV; новые Mac не обязаны иметь эти
пакеты. `6/6`/`2/2 активных` относится только к зарегистрированному комплекту.
Missing enabled hub route остаётся видимым в native catalog, а не исчезает как
успешно merged alias. Например, прямой remote Figma HTTP/OAuth остаётся отдельным
подключением Codex; локальный процесс Figma не нужен, OAuth не переносится в хаб.

`cua_repl`/`node_repl` — внешние клиенты, не два новых ребёнка shared6. Их enabled
metadata не проверяет наличие executable/runtime. В macOS-срезе25Oct удалённый
desktop bundle оставил enabled entries с отсутствующими `cua_node` paths. Штатный
`codex app` восстановил signed ChatGPT26.1021 в `/Applications/Codex.app` и сам
обновил эти paths; legacy `computer-use` остался отдельной disabled записью.
DisplayName ChatGPT и имя папки Codex.app здесь не являются разными runtime.

Наличие runtime-файлов и постоянно открытый desktop GUI — разные требования.
В этом же срезе после normal Quit и подтверждённого исчезновения GUI/process tree
НОВЫЙ MCP-клиент успешно прочитал native inventory19apps и дошёл до стандартной
MCP form elicitation на доступ к Finder. Разрешение не выдавалось: оконные input/
capture этим не объявлены проверенными. Диагностический клиент без form capability
получал `nodeRepl.createElicitation is unavailable` — это не доказательство, что
нужен запущенный desktop GUI. Runtime-helper может работать отдельно; удаление
bundle снова ломает clients, которые ссылаются на его файлы. Этот операционный
proof не обещает live reload старых каталогов CLI и не заменяет per-app approvals.

Шрам14.10 после Build Install: live `_status` hub21424 содержал только два
initialized child; installed defaultServerDefs совпал с тогдашним CURRENT. Отсутствие
Browser/SC в таком случае — не просто stale tools/list одной вкладки. Children
фиксируются при создании hub; hot-add/reconfigure API нет, `_restart/<name>`
не регистрирует отсутствующее имя. Нельзя обещать восстановление через restart
ребёнка, создавать параллельный stdio или самовольно обходить запрет hub restart.
Причина разрыва — убранные code-default bindings без machine-local миграции;
почему конкретный ENV не был задан, отдельно не доказано. Новый SOURCE profile
reader не угадывает утраченную команду и не переписывает личные конфиги. Для этой
машины подготовлен отдельный неприменённый кандидат четырёх исторических bindings;
terminal/knowledge он не переопределяет. Старые6/6 proofs остаются историей.

Живой и желаемый profile snapshots сравниваются private fingerprint; наружу
возвращается только `configurationApplied`, без argv/ENV/digest. Оно не означает
актуальность executable bytes, ambient ENV или client catalog.

Прямой `GET /mcp/_status` без private `x-noted-mcp-configuration` header возвращает
`configurationMatches:false`: ожидаемая конфигурация не была передана. Это само
по себе не доказательство расхождения. Для проверки совпадения controller
передаёт fingerprint текущего resolver; в лог/ответ выводится только boolean.

При смене файла
между Main read и spawn исходный fingerprint проверяется до listener/children;
нельзя сначала исполнить замену, а затем лишь сообщить mismatch. Изменение
профиля живого hub не вызывает автоматический restart: нужен owner-drain,
штатная смена поколения, потом initialize/tools/list и actual client access.
В порученном восстановлении MCP эти действия входят в обслуживание без отдельного
продуктового согласования; это не разрешение прерывать неизвестную мутацию или AI.
App Build Install и restart children сами не являются применением профиля.

Pro предложила whole-profile omission как removal; actual local контроль показал,
что частичная миграция теряет прежний explicit ENV соседа. Поэтому omission не
disable; отключение выражается отдельно. Реапинг требует существующий точный файл,
не directory/последний argv и не prefix совпадение с `entry.js.old`. Конкретные
контроли — mcp-hub-preservation.test.js; real source/private stub процессы не
подменяют принятие Browser/SC/Electron/iOS или старых AI-клиентов.

Это объяснение относится к remote Figma HTTP/OAuth, не к Figma Console.
В срезе05.10 native config/read показал enabled stdio `figma_console`
(`node …/figma-console-mcp/dist/local.js`) и `yandex-wiki`. Реальные процессы
под Codex: отдельные node/Figma и uv→Python/Yandex экземпляры в разных
сессиях. Повторение в «Ресурсах» является реальным расходом внешних MCP,
не размножением шести детей хаба. В панели теперь они подписаны именами MCP
и не входят в расход пользовательских команд. Исправление отображения не
меняет stdio-транспорт, config или активные подключения.

04.10.2026 на Codex 0.159.2: глобальная Figma enabled/OAuth, новый native app-server получил 43 инструмента через `mcpServerStatus/list`; чтение/изменение design-файлов не выполнялось. Старая сессия может держать прежний каталог. Для использования нового MCP достаточно нового запуска Codex (либо перезапуска процесса с Resume сохранённой сессии), затем `/mcp` проверяет активный список. Build Install Noted Terminal для этого не требуется; «Перезапустить все MCP» обновляет только шесть детей хаба и не перечитывает native MCP config в живом Codex. App-server имеет отдельный `config/mcpServer/reload`, но текущий Noted PTY-клиент не предоставляет такого действия. Число 43 — результат этого среза, не постоянный контракт Figma.

Вторая проверка того же дня закрыла отличие внешнего shell от штатного запуска Noted: через Terminal MCP создана background child-вкладка4933 командой `codex`, затем Project API отправил только `/mcp verbose`. Реальный TUI0.159.2 внутри установленного Noted ответил `figma: connected (43 tools)` / `Auth: OAuth`, также `figma_console: connected (121 tools)` и готовые штатные MCP. Вкладка закрыта обычным `close_tab`, model prompt/design reads/writes не запускались. У текущей4875 фактическое окружение CLI использует стандартный `~/.codex`, без отдельного CODEX_HOME/profile, project `.codex/config.toml` отсутствует. Для нового штатного запуска недоступность Figma из-за Noted опровергнута; более старый каталог конкретной уже открытой сессии не проверялся этой пробой. Установленная панель этой диагностической проверки читала только IPC `mcp-hub:status`; последующий source-ремонт каталога описан в UI выше. Источник проверки — `/private/tmp/noted-figma-native-launch-20261004.3bt6p062/HANDOFF.md`.

Источники: [native MCP/config](https://learn.chatgpt.com/docs/extend/mcp), [active `/mcp`](https://learn.chatgpt.com/docs/developer-commands), [Figma manual setup](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), [обновление каталога после restart клиента](https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/). Общий popup использует независимые источники здоровья хаба и native конфигурации; metadata не является proof live connection конкретной сессии или её profile overrides.

## Ловушки

- **Хаб из удалённого бандла: теперь Main заменяет его сам** (02.11.2026).
  Инцидент повторился и оказался шире, чем «только Browser». Хаб 18670 стартовал
  1 нояб 13:11, приложение переустановили 2 нояб 13:30, и сутки хаб исполнял
  `/Applications/.noted-terminal-install-af50CP/previous.app` — папки уже не было
  на диске. macOS выдаёт доступ к файлам по отпечатку исполняемого файла, поэтому
  **хаб и все шесть его детей потеряли доступ к `~/Desktop`**. Три симптома из
  одной причины: `docs_search` → `EPERM` на `.semantic-index.json`,
  `docs_reindex` → лживое `No docs/**/*.md files found to index` (обход каталога
  возвращал пусто, а не ошибку), `sc-desktop` не мог стартовать Python-воркер.
  Browser дополнительно падал своим `research_host_binding_invalid`.
  Диагностическая ловушка: в `ps` хаб неотличим от Main — он запускается тем же
  бинарником приложения. Единственный Main был один (42705); 18670 с `ppid=1` —
  это сам хаб, осиротевший от прежнего Main. Detached-запуск намеренный: иначе
  каждая сборка убивала бы MCP у всех сессий.
  Почему не чинилось само: `needsUpgrade` в `mcp-hub-controller.js` заменял хаб
  только при `brokenLaunch` (все дети не ready И ошибки ENOENT/code=127) или при
  отсутствии `launchEnvironment`. У этого хаба `launchEnvironment:1`, все шесть
  детей `initialized:true`, `lastError:null` — Main принимал его за исправный.
  Ремонт: `/mcp/_status` сообщает `executable: process.execPath` и capability
  `executableIdentity:1`; контроллер считает хаб устаревшим, когда его executable
  отличается от нашего И отсутствует на диске. Другой СУЩЕСТВУЮЩИЙ бандл (dev-копия)
  устаревшим не считается — это вопрос конфигурации, а не мёртвый файл; иначе Main
  воевал бы за порт с другим живым приложением. Старый хаб без поля `executable`
  сохраняет прежнее поведение: отсутствие идентичности — это неизвестность, а не
  доказательство устаревания. Тест — `mcp-hub-stale-executable.test.js` (4/4,
  проверено, что без правки падает 3/4).
  Ручное лечение прежнее и остаётся актуальным для уже запущенного хаба:
  `POST /mcp/_shutdown?pid=<old>`, затем Main поднимает новый сам (проверка раз
  в 60с). Перезапуск приложения НЕ требуется, если Main уже от актуального бандла.
  Системная галка в «Конфиденциальность → Файлы и папки» при этом не слетает:
  новый процесс читает те же файлы нормально — проверяется чтением того же файла
  из сессии нового Main.

- **Хаб, переживший переустановку приложения, роняет ТОЛЬКО Browser** (01.11.2026).
  Build Install подменяет `/Applications/Noted Terminal.app`, а прежний
  detached-хаб продолжает жить и исполнять уже УДАЛЁННЫЙ бинарник из
  `/Applications/.noted-terminal-install-<rand>/previous.app` (виден в
  `lsof -p <hubPid> | grep txt`). Пять серверов это переживают, а Browser —
  нет: только у него есть host-binding слой, и его `assertEntry` сверяет
  журнал `research-hosts/<hostId>/host.json` с текущей установкой. Симптом —
  `/mcp/_status` отвечает `up:true, initialized:true` для всех шести, но
  `initialize` именно к `/mcp/browser` возвращает `research_host_binding_invalid`,
  а `/mcp/_browser-maintenance` — `research_host_auth_required`. В клиенте это
  выглядит как «MCP работает глобально, но в сессии browser отвалился».
  Проверка — сравнить время старта хаба с `mtime` установленного `.app`.
  Диагностируется read-only; лечится штатной сменой поколения хаба
  (`POST /mcp/_shutdown?pid=<old>` + обычный `ensure` от нового Main), не
  удалением журналов и не kill'ом `mcp-hub.js`. Контракт
  `sc-desktop/mcp/browser/host-contract.json` при этом ЦЕЛ — 12/12 хешей
  совпадают, поэтому чинить нужно поколение хаба, а не контракт.
- **Codex + bearer_token_env_var при ОТСУТСТВУЮЩЕЙ переменной**: Codex молча
  не шлёт запросы к серверу (сервер выглядит недоступным). Поэтому composition
  в zshrc/zshenv даёт всегда-непустое значение (`|||` для чужих терминалов).
- **ZDOTDIR**: PTY приложения стартует zsh с
  `ZDOTDIR=~/Library/Application Support/noted-terminal/shell-integration`,
  его `.zshrc` сорсит только `~/.zshrc` — `~/.zshenv` юзера НЕ выполняется.
  Что должно попасть в env вкладок — в `~/.zshrc`.
- **Порт 53133** фиксирован (рядом с 53127 sc-desktop). Живые старые сессии
  продолжают держать свои stdio-копии до перезапуска вкладки — двойной расход
  уходит постепенно, это ожидаемо.
- Штатный shutdown принудительно закрывает idle/active HTTP connections после
  остановки детей. Иначе keep-alive клиента удерживал порт после ответа
  `_shutdown`, а параллельный main успевал поднять другой хаб.
- Тесты хаба: `src/main/mcp-hub.test.js` (identity parsing, id remap, stdout
  contamination, зависший catalog recovery, E2E ownership, crash respawn,
  404/_status) — `node --test`, стаб-сервер вместо реальных детей. Живой smoke
  дополнительно останавливает реальный `sc-desktop`: восстановление занимает
  около 5 секунд, меняет PID, возвращает 123 инструмента / 60 YouGile и оставляет
  `pendingRequests=0`.
- `mcp-hub-controller.test.js` дополнительно проверяет минимальный Finder PATH
  под Electron run-as-node, quick reopen/adoption и замену старого ENOENT-хаба.
  `mcp-hub-ui.e2e.cjs` в скрытом Electron соединяет настоящий компонент и IPC с
  приватным хабом: видимая ошибка, общий restart, отдельный restart без смены
  PID соседа и работающий tools/list после действия. Глобальный порт не используется.
