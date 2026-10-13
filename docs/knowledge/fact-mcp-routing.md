# Факт: MCP routing — parent-project pinning + cwd fallback

## Зачем
Два независимых уровня routing'а:

1. **Между параллельными Electron-инстансами** (dev vs prod) — какому процессу отдать запрос. Решается через `NOTED_MAIN_PID` env priority-1 → cwd longest-prefix → mtime. См. секцию `Discovery в terminal-server.mjs`.
2. **Между проектами внутри одного инстанса** — в какой проект класть таб / по какому проекту фильтровать `list_tabs`. Решается через `NOTED_PARENT_PROJECT_ID` env priority-1 → cwd longest-prefix match → `activeProjectId` fallback.

> **Обновление (MCP-хаб, 2026-09):** terminal-server теперь обычно ОДИН общий процесс за HTTP-хабом (см. [`fact-mcp-hub.md`](fact-mcp-hub.md)), поэтому env-переменные не могут нести per-session identity. Identity приезжает per-request: хаб кладёт `{tabId, projectId, cwd, mainPid}` в `params._meta.noted`, terminal-server читает их через AsyncLocalStorage-геттеры `PARENT_TAB_ID()`/`PARENT_PROJECT_ID()`/`PROJECT_CWD_()`/`MAIN_PID_HINT()`. Приоритеты роутинга ниже не изменились — сменился только транспорт identity (env → meta, env остаётся fallback'ом для прямого stdio-запуска).

После workflow-aware Terminal MCP есть третий, независимый уровень:

3. **Размещение внутри workspace** — в какой workflow/window/strip position
   положить вкладку. Его решает `windowTarget` от source tab либо точного
   revision-bound `windowRef`. `projectId` на этом уровне является только
   владельцем записи/cwd и не может подменять workflow или окно.

Новый acknowledged create path (`/api/terminal-tabs`, `/api/agent-tabs`) не
использует `activeProjectId` как placement fallback. Без явного project/cwd
directory context идёт от target window → workflow default project → source
tab. Bare create без `windowTarget` сохраняет legacy project-pinned поведение,
но не показывается самовольно в окнах.

Раньше существовал только cwd-based routing. Симптомы которые этим лечились:
- Юзер открыл два проекта A и B в одном инстансе. Запустил Claude в табе проекта B. Claude вызывает `create_tab` → таб уходит **в A** потому что A — `activeProjectId`. С точки зрения юзера: «таб исчез».
- Юзер открыл один и тот же путь в двух проектах (например, монорепо), Claude бежит в одном из них — `list_tabs` возвращает табы случайного из двух (cwd-tie).
- Claude `cd /tmp` — теперь его `process.cwd()` не совпадает ни с одним открытым проектом, routing fallback'ит на `activeProjectId`.

Решение: Electron main передаёт в Claude PTY env `NOTED_PARENT_PROJECT_ID=<project.id>` рядом с `NOTED_MAIN_PID`. Каждый дочерний `terminal-server.mjs` читает env и **пришпиливает** все свои HTTP-вызовы к этому projectId. Main игнорирует cwd, ищет project по id напрямую (`SELECT * FROM projects WHERE id = ?`) и:
- `create_tab` — кладёт таб **именно** в этот проект, минуя cwd-heuristic в `handleMcpCreate`.
- `list_tabs` — отдаёт только табы этого проекта.
- `run_command` / `restart_process` / `read_output` / `kill_process` / `run_chain` — **отказываются** работать с `tabId`, который не принадлежит pinned-проекту (HTTP 403). Это защита от сценария где Claude по ошибке передал чужой `tabId` (например, copy-paste из другой сессии) — старый код тихо writeлся бы в чужую вкладку.

## Архитектура (после фикса)

### Port-файл — JSON, не голое число
```js
// ~/.noted-terminal/mcp-port-<PID>
{
  "port": 59812,
  "pid": 91806,
  "openProjectPaths": [
    "/Users/fedor/Desktop/vs-code/agrotech/uav",
    "/Users/fedor/Desktop/custom-terminal"
  ],
  "openProjects": [
    { "id": "L1VzZXJzL2ZlZG9yL0Rl_1774157227577_9jpdgn", "path": "/Users/fedor/Desktop/vs-code/agrotech/uav", "name": "uav" },
    { "id": "L1VzZXJzL2ZlZG9yL0Rl_1781234567890_abc123", "path": "/Users/fedor/Desktop/custom-terminal", "name": "custom-terminal" }
  ],
  "isPackaged": false,
  "updatedAt": 1778889234567
}
```

Оба поля обновляются при каждом `openProject`/`closeProject` в Zustand — renderer шлёт IPC `mcp:open-project-paths` с двумя аргументами `(paths, { projects })`, main перезаписывает файл и app_state-кеш (`mcpOpenProjectPaths` + `mcpOpenProjects`). Подписка установлена через `useWorkspaceStore.subscribe(push)` + `useProjectsStore.subscribe(push)` в `App.tsx`; dedupe по join-ключу чтобы не писать файл на каждый ре-рендер.

`openProjectPaths` оставлено для backward compat — старые tool'ы которые умеют только cwd-routing продолжают работать. `openProjects` — новый source of truth, используется при id-based lookup.

**Hydrate из SQLite на старте main'а** — первая discovery-запись делается в `listen()` callback ДО того как renderer mount'нется и push'нет paths. Без gидрации первое окно (несколько секунд после boot) discovery содержит `openProjectPaths: []` → cwd-routing не работает → fallback на mtime → запросы могут уйти не туда. Поэтому `mcpOpenProjectPaths` персистится в `app_state` под ключом `mcpOpenProjectPaths` на каждом push'е и читается обратно при module-load main'а ДО первого write'а discovery. Юзер открыл прод в первый раз → нет cache → race остаётся, но это не worse-than-before. После первой сессии в каждой следующей discovery начинается с snapshot прошлой.

### Discovery в terminal-server.mjs — priority order

`listLiveInstances()` парсит JSON каждого живого port-файла. `pickInstance(cwd)` выбирает в три приоритета:
1. **`NOTED_MAIN_PID` env** — каждый Claude процесс наследует env от того main'а который его spawn'ил. Эту переменную main инжектит при `pty.spawn` рядом с `EDITOR=noted-code-grab.js`. Если хоть один live-инстанс имеет совпадающий `pid` — return immediately. Это убирает ambiguity когда дев и прод одновременно open'или один cwd (longest-prefix даёт tie длины 38, sort-order arbitrary — без env запрос уходил в случайный из двух). См. `methodology/дизайн-принципы.md::ID-pinned routing > cwd-routing`.
2. **cwd longest-prefix** — entry в `openProjectPaths` префикс `cwd` (включая subdirectories — `/uav/agrofield_back` матчится с `/uav`). Wins на случай вложенных открытых проектов. Fallback когда NOTED_MAIN_PID не выставлен (helper-script запущен из `/tmp`, сторонний tool).
3. **mtime** — самый свежий port-файл. Последний рубеж для свободных cwd.

Hint для разных tool'ов:
- `create_tab` — берёт hint напрямую из `args.cwd`.
- `restart_process` / `run_command` / `read_output` / `kill_process` — у Claude'а только `tabId`. Декодируем base64-префикс tabId (`<base64(projectPath)>-tab-<N>`) обратно в путь, используем как hint. Если префикс не base64 (legacy `new_project_*` tabIds) — фоллбек на `PROJECT_CWD`.

### Routing внутри инстанса — `handleMcpCreate`
Приоритет (после фикса с `NOTED_PARENT_PROJECT_ID`):
1. **`data.parentProjectId`** (приходит из body запроса; main взял из env Claude'а). Если такой projectId есть в `state.openProjects` — кладём таб в него без всяких cwd-проверок. Если projectId есть но проект сейчас закрыт — log warning, fallback на cwd-routing.
2. **cwd longest-prefix** — перебираем все `openProjects`, ищем самый длинный `projectPath` который является prefix'ом `data.cwd`.
3. **`state.activeProjectId`** — последний рубеж для cwd, которые не принадлежат ни одному открытому проекту (помощник из `/tmp`).

### HTTP-уровень — projectId-pinned endpoints
Каждый `/terminal/*` endpoint принимает `parentProjectId` в body (POST) или query (GET):
- `/terminal/tabs?parentProjectId=…&color=…` — exact legacy Project либо v2 execution namespace. С11.10 namespace проверяется по существующему `workflow_execution_scopes` без чтения всех его records; отсутствие Project row не скрывает standalone tabs. Known empty namespace остаётся пустым даже при совпавшем legacy cwd. Fallback по legacy path сохраняется только для отсутствующего/неизвестного адреса; namespace не является workflowId.
- `/terminal/create` — body `{ cwd?, parentProjectId? }`. Когда есть `parentProjectId` без `cwd`, main подтягивает `projects.path` из БД.
- `/terminal/run`, `/terminal/restart`, `/terminal/kill`, `/terminal/output`, `/terminal/chain` — все валидируют, что `tabId` принадлежит `parentProjectId` через `resolveProjectForTab(tabId)` (priority: live `terminalProjectIds` Map → SQLite `tabs.project_id`). Mismatch → HTTP 403 с body `{ owner, requested }`.

Это **не безопасность**, это защита от silent mis-routing. Claude может передать чужой `tabId` если случайно скопировал из другой сессии — раньше тихо писало в чужую вкладку, теперь возвращает explicit ошибку которую Claude видит и не повторяет.

## Backward compatibility
Legacy port-файлы содержали только число. `listLiveInstances()` детектит парс-ошибку и оборачивает как `{ port, openProjectPaths: [] }` — для таких инстансов routing-by-cwd не сработает (пустой массив), и они участвуют только в mtime-fallback'е. Это означает: **после деплоя нужен рестарт обоих инстансов чтобы они переписали port-файлы в новом формате**, иначе routing-by-cwd silently не работает.

То же самое для parent-id pinning: уже **запущенные** Claude-сессии унаследовали env без `NOTED_PARENT_PROJECT_ID` и продолжат работать через cwd-routing до своего рестарта. Новые сессии (после рестарта main и нового `terminal:create`) получат env и переходят на id-pinned routing автоматически. **Эндпоинты обратно совместимы** — если `parentProjectId` отсутствует в запросе, ведут себя как раньше (cwd-only). Это позволило развернуть фикс без массового убийства активных Claude.

## Что пробовали и почему отбросили
- **Брать `CLAUDE_PROJECT_DIR` напрямую как hint**: работает только для tool'ов где cwd явно передаётся (create_tab). Для tabId-based tool'ов всё равно нужен другой механизм. Решение через декодирование base64-префикса tabId покрывает оба случая.
- **Один общий port-файл `~/.noted-terminal/mcp-port`**: проще, но при двух инстансах последний выигрывает, мы туда же и вернулись. PID-specific файлы — единственный способ удерживать N инстансов одновременно.
- **Передавать tabId с явным project hint** (`projectId+tabId`): требует менять сигнатуры всех MCP-tool'ов, которые видит юзер. Декодирование префикса работает без изменения API.
- **Извлекать projectId из tabId-префикса (`tabId.split('-tab-')[0]`) на стороне MCP** вместо явного env: tabId-префикс — base64-снимок path на момент создания таба, **не равен** реальному `project.id` из SQLite, особенно после rename/path-update. Для текущих табов работает, для legacy/forked — ломается. Env-пинн поверх явного `terminalProjectIds` Map даёт точное соответствие.
- **Передавать parentProjectId как третий аргумент `mcp:open-project-paths`** вместо meta-объекта: ломает обратную совместимость со старой подпиской (которая шлёт только `paths`). Второй positional arg `meta` опционален — старый renderer работает, новый расширяется.

## Code map
- `src/main/main.js::writeMcpPortFile()` + `mcp:open-project-paths` IPC (с `meta.projects`).
- `src/main/main.js::ipcMain.handle('terminal:create')` — принимает `projectId`, инжектит `NOTED_PARENT_PROJECT_ID` + `NOTED_PARENT_TAB_ID` в shell env.
- `src/main/main.js::terminalProjectIds` — live-Map `tabId → projectId`, источник истины для `resolveProjectForTab()`.
- `src/main/main.js::resolveProjectForTab(tabId)` — priority: live-Map → SQLite `tabs.project_id`. Используется guard'ом /run/restart/kill/output/chain.
- `src/renderer/App.tsx::useEffect` со store subscribe, шлёт path-list + projects на change.
- `src/renderer/App.tsx::handleMcpCreate` — priority: `parentProjectId` → longest-prefix → activeProjectId.
- `src/renderer/store/useWorkspaceStore.ts::createTab/createTabAfterCurrent` — прокидывает `projectId` в `terminal:create` payload.
- `~/.claude/mcp/terminal-server.mjs::PARENT_PROJECT_ID` — env-pinned, шлётся в каждый tool-call.

## Связанные
- `methodology/дизайн-принципы.md::Routing по контексту запроса, не по глобальному last-active state` — переносимый принцип.
- `methodology/дизайн-принципы.md::ID-pinned routing > cwd-routing когда инстансы делят cwd` — `NOTED_MAIN_PID` env как priority-1 разрешает tie.
- `fix-claude-hook-silent-dropouts.md` — параллельный фикс той же проблемы для Claude hook bridge.
