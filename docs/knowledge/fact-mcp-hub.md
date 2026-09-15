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
  инструменты. Main его **усыновляет или спавнит** (`ensureMcpHub`, main.js) и
  нянчит probe'ом каждые 60с; при смерти хаба — respawn. Изолированный E2E-main
  может пользоваться уже запущенным хабом, но не имеет права занимать глобальный
  порт, иначе временная копия из `/private/tmp` становится владельцем production-
  интеграций и поднимает устаревший код после завершения теста.
- Каждый ребёнок спавнится ОДИН раз, HTTP-запросы бриджуются в stdio с
  ремапом JSON-RPC id (много клиентов на одну трубу). `initialize` отвечается
  из кэша хендшейка; `server/discover` (проба Claude) отвечается локально.
- Ребёнок упал → pending-запросы фейлятся, respawn с backoff; следующий запрос
  прозрачно попадает в новый процесс. Ручной рестарт: `POST /mcp/_restart/<name>`.
- Живой PID не считается достаточным доказательством здоровья. Короткие запросы
  каталога (`tools/list` и соседние list-методы) имеют четырёхсекундный timeout:
  при зависании хаб одним общим recovery перезапускает только этого ребёнка и
  повторяет запрос один раз. Обычные `tools/call` не получают общий короткий
  timeout, потому что индексация и другие реальные операции законно идут минуты.
- stdout детей трактуется как NDJSON построчно. Невалидная диагностическая строка
  логируется и отбрасывается отдельно; её нельзя накапливать перед следующими
  JSON-ответами — один такой префикс навсегда делал все последующие ответы
  непарсируемыми при внешне живом процессе.
- При старте хаб **реапит осиротевших детей** прошлого хаба (ppid 1 + путь
  сервера из своего списка; `sc-desktop` матчится по `reapMarker` server.js,
  потому что run.sh экзекается в Electron). bridge.js браузера НЕ реапится.

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
(зелёная 6/6 / янтарная / красная-хаб-мёртв), панель со списком серверов
(pid, аптайм, счётчик рестартов), кнопка рестарта per-server, кнопка
«Запустить хаб» при мёртвом хабе. IPC: `mcp-hub:status`, `mcp-hub:restart-server`,
`mcp-hub:ensure`. Опрос статуса — только при открытой панели (3с) или редкий
для точки (30с). Панель ресурсов: `mcp-hub.js` добавлен в
`SHARED_SERVICE_PATTERNS` (process-metrics-grouping.js) — не «брошенный», из
панели не убивается. Зелёный учитывает не только PID, но и завершённый initialize
и отсутствие активного recovery; во время автоматической замены ребёнок янтарный.

## Конфиги (источник правды)

- `~/.claude.json::mcpServers` — все шесть `type: "http"` на hub-url с `${VAR}`.
- `~/.codex/config.toml::[mcp_servers.*]` — все шесть `url = ...` +
  `bearer_token_env_var = "NOTED_MCP_IDENTITY"`. Верхнеуровневый
  `mcp_optional_startup_grace_ms = 0` заставляет Codex ждать штатный
  `startup_timeout_sec`, а не молча выбрасывать один сервер через дефолтную
  секунду; это окно вмещает четырёхсекундное recovery каталога.
- Бэкапы: `~/.claude.json.bak-hub-*`, `~/.codex/config.toml.bak-hub-*`,
  код серверов до правок — `~/mcp-backups-<ts>/`.

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
