# Fact: MCP-хаб — один общий комплект MCP-серверов на все AI-вкладки

## Проблема, которую решает

MCP по stdio = дочерний процесс клиента: каждая Claude/Codex-сессия поднимала
СВОЮ копию всех шести серверов (knowledge, terminal, browser, electron, ios,
sc-desktop). При ~10 открытых сессиях это 60-70 процессов и ~2 ГБ ОЗУ —
измерено панелью ресурсов (phys_footprint). Замер до миграции: 70 процессов,
2030 МБ; после перезапуска всех вкладок останется один комплект ~200-300 МБ.

## Архитектура

```
Claude/Codex вкладка ──HTTP──▶ mcp-hub (порт 53133) ──stdio──▶ 6 детей (по одному)
```

- **`src/main/mcp-hub.js`** — standalone-процесс (`node mcp-hub.js --standalone`),
  detached от Electron: переживает ребилды приложения, живые сессии не теряют
  инструменты. Main его **усыновляет или спавнит** через общий controller и
  нянчит probe'ом каждые 60с; при смерти хаба — respawn. Старый хаб без исправленного
  launch environment при 0 готовых серверов и ENOENT/code127 заменяется штатно,
  а не принимается как здоровый только по отвечающему HTTP. Изолированный E2E-main
  может пользоваться уже запущенным хабом, но не имеет права занимать глобальный
  порт, иначе временная копия из `/private/tmp` становится владельцем production-
  интеграций и поднимает устаревший код после завершения теста.
- Каждый ребёнок спавнится ОДИН раз, HTTP-запросы бриджуются в stdio с
  ремапом JSON-RPC id (много клиентов на одну трубу). `initialize` отвечается
  из кэша хендшейка; `server/discover` (проба Claude) отвечается локально.
- Ребёнок упал → pending-запросы фейлятся, respawn с backoff; следующий запрос
  прозрачно попадает в новый процесс. Ручной рестарт: `POST /mcp/_restart/<name>`;
  общий — `POST /mcp/_restart-all`, listener и identity клиентов остаются живыми.
  Совпавшие ручной/общий/catalog recovery объединяются на конкретном ребёнке;
  новый процесс запускается после exit старого, позднее событие старого не может
  очистить нового. Успех означает initialize всех нужных детей, не только spawn.
- Живой PID не считается достаточным доказательством здоровья. Короткие запросы
  каталога (`tools/list` и соседние list-методы) имеют четырёхсекундный timeout:
  при зависании хаб одним общим recovery перезапускает только этого ребёнка и
  повторяет запрос один раз. Обычные `tools/call` не получают общий короткий
  timeout, потому что индексация и другие реальные операции законно идут минуты.
- stdout детей трактуется как NDJSON построчно. Невалидная диагностическая строка
  логируется и отбрасывается отдельно; её нельзя накапливать перед следующими
  JSON-ответами — один такой префикс навсегда делал все последующие ответы
  непарсируемыми при внешне живом процессе.
- После успешного занятия порта хаб **реапит осиротевших детей** прошлого хаба (ppid 1 + путь
  сервера из своего списка; `sc-desktop` матчится по `reapMarker` server.js,
  потому что run.sh экзекается в Electron). bridge.js браузера НЕ реапится.
  Проигравший одновременный старт не получает права на reaping. Main получает
  одноразовый IPC ready от нового detached-хаба, затем отпускает IPC; shutdown
  старого подтверждается закрытием его HTTP-соединения перед повторным bind.

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
запроса в `params._meta.noted = {tabId, projectId, cwd, mainPid}`:

- **Claude** умеет `${VAR}` в url (`services/mcp/config.ts::expandEnvVars`):
  `~/.claude.json` → `url: "...?tab=${NOTED_PARENT_TAB_ID:-}&project=...&cwd=${CLAUDE_PROJECT_DIR:-}&mainPid=${NOTED_MAIN_PID:-}"`.
  Неразвёрнутый плейсхолдер (`${...` literally) хаб трактует как пусто.
- **Codex** НЕ разворачивает env в url. Используется `bearer_token_env_var =
  "NOTED_MCP_IDENTITY"` → заголовок `Authorization: Bearer <tab>|<project>|<cwd>|<mainPid>`.
  Токен без `|` считается чужим auth-токеном и игнорируется (аноним).
  Переменную составляет PTY env (`NOTED_MCP_IDENTITY` в terminal:create) и
  дублирует composition-строка в `~/.zshrc` И `~/.zshenv` из `NOTED_PARENT_*`
  (shell-integration ZDOTDIR приложения обходит ~/.zshenv, поэтому в двух местах).
- **SDK-вкладки**: `mcpServersViaHub()` в main переписывает шесть серверов на
  hub-url с identity; если хаб недоступен — `mcpServersStdioFallback()`
  возвращает старые stdio-спавны (capability сохранена), и main пинает ensure.
- Без identity (обычный терминал) — аноним: cwd-роутинг, как раньше.

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
- **electron-mcp** (connection.mjs): синглтон state → `Map clientId → {state,
  lastConnect}` за Proxy; каждый клиент держит СВОЁ CDP-подключение (два клиента
  одновременно на 9236 и 9237 проверены). Колбэки (`disconnected`, `close`,
  `window`, `page`) биндятся к контексту момента подписки, не к Proxy.
- **ios-mcp** (tools.mjs): 7 модульных `let` → `S()` поверх AsyncLocalStorage
  (свой симулятор/appium/WDA у каждого клиента).
- **browser** и **sc-desktop** — без изменений (SDK-серверы, `_meta` проходит
  прозрачно; browser уже был multi-client через общий bridge.js).
- Закрытие вкладки: `terminal:kill` → `notifyMcpHubTabClosed(tabId)` → хаб шлёт
  stateful-детям (electron, ios) `notifications/noted/client-closed` → dispose
  контекста (закрыть CDP, убить WDA-сессию). Плюс TTL-свип 6ч в хабе.

## UI

`McpHubButton.tsx` в шапке рядом с ResourceUsageButton: точка-статус
(зелёная 6/6 / янтарная часть / красная 0 готовых или хаб недоступен), панель со списком серверов
(pid, аптайм, счётчик рестартов), кнопка рестарта per-server, кнопка
«Перезапустить MCP хаба» всегда; при недоступном хабе — «Восстановить хаб».
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

Приёмка: 47 профильных checks, actual React/Electron+IPC/private hub (add/remove,
partial failure/retry, late cwd, прежний all/single restart), native Codex0.159.2
с приватным config и установленным local plugin. Чтение видит plugin MCP/изменение
enabled, stdio-marker не создан и HTTP-запросов к MCP0. Отдельный readonly UI показал
реальный figma_console/yandex-wiki и production status, без restart или Figma calls.
Paired main/renderer build PASS; source ещё не установлен. Артефакты:
`/private/tmp/noted-mcp-catalog-20261004.fouy8eg6`.

## Конфиги (источник правды)

- `~/.claude.json::mcpServers` — все шесть `type: "http"` на hub-url с `${VAR}`.
- `~/.codex/config.toml::[mcp_servers.*]` — все шесть `url = ...` +
  `bearer_token_env_var = "NOTED_MCP_IDENTITY"`. Верхнеуровневый
  `mcp_optional_startup_grace_ms = 0` заставляет Codex ждать штатный
  `startup_timeout_sec`, а не молча выбрасывать один сервер через дефолтную
  секунду; это окно вмещает четырёхсекундное recovery каталога.
- Бэкапы: `~/.claude.json.bak-hub-*`, `~/.codex/config.toml.bak-hub-*`,
  код серверов до правок — `~/mcp-backups-<ts>/`.

### Внешний MCP в Codex не становится ребёнком хаба

Список хаба задан `defaultServerDefs()` и содержит шесть наших stdio-серверов; он не импортирует произвольные записи из Codex/Claude config. `6/6` подтверждает здоровье этого хаба, а внешние регистрации source-панель показывает отдельно из Codex (раздел UI выше). Например, `codex mcp add figma --url https://mcp.figma.com/mcp` добавляет прямое HTTP/OAuth-подключение в глобальный конфиг Codex. Отдельный локальный процесс Figma не нужен, а её native OAuth остаётся у Codex.

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
