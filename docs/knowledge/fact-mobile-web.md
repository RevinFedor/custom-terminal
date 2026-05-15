# Fact: Mobile Web Access

Параллельный режим работы с SDK-табами через мобильный браузер. Сервер живёт в main process Electron (port 7878), фронт — отдельный мини-Vite SPA в `mobile-web/`, отдаётся как статика. Авторизация — bearer token в `~/.noted-terminal/web-token.txt`. Со смартфона можно создавать SDK-чаты, отправлять промпты, видеть стрим в реальном времени параллельно с десктопом.

## Почему НЕ cloud-хостинг

`query()` из `@anthropic-ai/claude-agent-sdk` запускает Claude Code subprocess **локально** с `cwd: project.path`, читает файлы пользователя, пишет JSONL в `~/.claude/projects/<slug>/`. На удалённой машине этот процесс не имеет доступа к локальной FS пользователя — а это и есть главный value (работа с реальными проектами с телефона). Поэтому сервер обязан быть локально, на том же устройстве где запущено приложение. Trade-off: ПК должен быть включён и в той же Wi-Fi что телефон.

## Bridge pattern: main ↔ renderer

Часть REST-эндпоинтов требует **живого renderer state** (Zustand store с открытыми проектами и табами). Main не имеет доступа к store напрямую. Решение — request/reply IPC bridge:

1. Main: `bridgeRequest(action, payload, timeoutMs=5000)` спавнит `requestId`, шлёт `web:bridge-request` в renderer, ждёт ответа на `web:bridge-reply` с тем же id.
2. Renderer: один listener в `App.tsx` диспатчит по action — `getOpenProjectIds`, `createSDKTab`, `sendSDKMessage`, `loadSDKHistory`, `forkToSDK`, `closeTab`, `renameTab`, `getSDKParams`, `setSDKParams`, `getTabSessionInfo`.
3. На таймауте promise rejected — endpoint возвращает 409.

**Критично:** bridge нужен ТОЛЬКО для actions, требующих store. Чисто-серверные operations (timeline parse через `parseTimelineEntries`, projects list из SQLite через `projectManager.db.getAllProjects()`) идут напрямую без bridge — это и быстрее, и работает даже если renderer mounted с задержкой.

## Synthetic user-message broadcast

Когда mobile шлёт `POST /api/sdk-tabs/:id/send` → main вызывает `sdkStartQuery`. Реальная user-запись в JSONL появляется **позже**, когда Claude Code SDK дойдёт до неё в потоке. Phone не должен ждать — bubble должен появиться мгновенно.

Решение: при старте query main **сам** бродкастит synthetic message всем WS-подписчикам tabId:
```js
_webBroadcast(tabId, {
  type: 'message',
  message: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    __webSynthetic: true,
  },
});
```
Это event летит ТОЛЬКО на WS — десктопный renderer его не видит (не подписан). Десктоп получает свой user-bubble через локальный `onNew` композера.

**Edge case:** когда отправка пришла **с phone**, десктоп `onNew` не вызвался. Renderer-bridge handler перед `claude-sdk:send-message` диспатчит CustomEvent `claude-sdk:external-prompt` — ClaudeSDKTab слушает и пушит свой user-bubble в локальный `setMessages`. Без этого десктоп показывал ответ Claude но не сам запрос.

## History loader: НЕ getSessionMessages

`getSessionMessages` из Anthropic SDK возвращает **другой набор записей** чем `parseTimelineEntries` — uuids не пересекаются. Если history грузить через SDK-helper, GoTo из timeline (использует timeline uuids как anchors) никогда не находит цель. См. [`fix-mobile-history-uuid-mismatch.md`](fix-mobile-history-uuid-mismatch.md).

Решение: новый IPC `claude-sdk:active-branch-messages` читает JSONL напрямую, walks active branch (тот же алгоритм что в `parseTimelineEntries`), возвращает **все типы** в chain order — user, assistant, tool_use, tool_result. Mobile reducer обрабатывает их так же как стрим. Anchors совпадают.

## Endpoint map

```
GET  /api/me                                   → ping, проверка токена
GET  /api/projects                             → SQLite + isOpen/isActive из renderer bridge
GET  /api/projects/:id/tabs                    → tabs + timelineCount + live state
POST /api/projects/:id/sdk-tabs                → createSDKTab (через bridge)
POST /api/sdk-tabs/:tabId/send                 → sendSDKMessage + dispatch external-prompt
POST /api/sdk-tabs/:tabId/stop                 → query.close()
POST /api/sdk-tabs/:tabId/close                → closeTab (через bridge)
POST /api/sdk-tabs/:tabId/rename               → renameTab (через bridge)
POST /api/sdk-tabs/:tabId/fork-to-sdk          → forkToSDK (через bridge → fork-from-session)
POST /api/tabs/:tabId/fork-to-sdk              → ↑ alias для terminal табов
GET  /api/sdk-tabs/:tabId/history[?last=N]     → active-branch-messages; with ?last → tail-only + { total, truncated, dropped }
GET  /api/sdk-tabs/:tabId/timeline             → parseTimelineEntries
GET  /api/sdk-tabs/:tabId/params               → getSDKParams
POST /api/sdk-tabs/:tabId/params               → setSDKParams
GET  /api/prompts[?etag=X]                     → getPrompts + getPromptGroups (no bridge); ?etag match → { etag, unchanged: true }
POST /api/log/client                           → mobile diagnostic logs → console.log → dev.log
WS   /ws?token=&tabId=                         → snapshot, message, busy, done events
```

## WS protocol

Server → client:
```
{ type:'snapshot',  tabId, sessionId, busy }       — на upgrade
{ type:'message',   tabId, message, sessionId }    — каждое SDK-сообщение
{ type:'busy',      tabId, busy }                  — переключение busy
{ type:'done',      tabId, sessionId }             — окончание turn'а
```

Client → server: `{ type: 'subscribe', tabId }` для смены подписки на лету (текущая mobile-сборка не использует — переподключается).

## Token & paths

- Файл токена: `~/.noted-terminal/web-token.txt`, генерируется `crypto.randomBytes(24).toString('hex')` при первом старте, mode 0o600.
- Auth: `Authorization: Bearer <token>` для REST. WS не может отправить custom headers из браузера → токен идёт в query `?token=...`. Сервер проверяет оба.
- Mobile сохраняет токен в localStorage первый раз когда видит `?token=...` в URL, потом чистит через `history.replaceState` (чтобы он не светился в адресной строке). См. `mobile-web/src/api.ts::bootstrapToken`.

## Module loading: srcMainDir, не relative

`web-server.js` лежит в `src/main/`, **не** в `dist/main/`. Electron-vite бандлит только `main.js`, sibling-модули копируются как raw .js. Поэтому загружать через:
```js
const webServer = require(path.join(srcMainDir, 'web-server'));
```
а **не** `require('./web-server')` — relative resolve смотрит относительно `dist/main/main.js`, файла там нет → `Cannot find module './web-server'`.

Тот же паттерн применён для `_webBroadcast` lazy-require в `sdkStartQuery`.

## Mobile diagnostic logs

`POST /api/log/client { tag, msg, data }` → `console.log('[' + tag + '] ' + msg + ...)` → попадает в `logs/dev.log` через стандартный console interceptor. Используется когда поведение надо отлаживать с phone (touch-events, scroll, focus): `Api.log('TimelineGoTo', 'jump', { targetTop, currentScroll })`. Без этого с iPhone Safari отладочную информацию не достать.

## Code map (неочевидные связи)

- Mobile-web `prefetch timeline on ChatView mount` (а не on drawer-open) → к моменту тапа на ☰ entries уже в state, drawer открывается instantly. Critical для UX на 200+ entries.
- Drawer mount-pattern: `display: none` вместо `{open && ...}` → scrollTop сохраняется браузером бесплатно, не нужен manual save/restore.
- `webServer.start({ sdkSessions })` принимает Map by reference. Если declaration `sdkSessions` находится **ниже** call-site `webServer.start()`, получишь TDZ ReferenceError. Декларацию держать в верхней секции `main.js` рядом с `srcMainDir`/`projectManager`, а не возле SDK-обработчиков.
- `parseTimelineEntries` фильтрует тот же noise что desktop Timeline: `<command-name>`, `<system-reminder>`, `<task-notification>`, `<local-command-stdout>`, `<local-command-stderr>`, `[Request interrupted]`. Без этого первые 5 timeline-entries — это model-switch slash-команды.

## Routing (HashRouter)

URL-схема: `#/projects/:projectId/chat/:tabId[?ro=1]`. HashRouter а не BrowserRouter — node-static в `web-server.js` не имеет SPA-fallback'а на произвольные pathnames; hash на сервер не уходит, фрагмент читается клиентом. Reload на любой странице → попадаешь обратно туда же. Deep-link (нет `state.tab` в `history.state`) → `Api.listTabs(projectId)` ищет TabInfo по `tabId`, либо показывает «Tab not found» с кнопкой назад. См. `methodology/design-mobile.md::Deep-link routing`.

## Tail-first history flow (две фазы)

Phase 1 (~1 сек): `Api.history(tabId, { last: 200 })` → reducer + paint, `historyLoading=false`. Чат интерактивен.

Phase 2 (~5 сек, в фоне): если server вернул `truncated: true` — fire `Api.history(tabId)` без `last`. State `fullLoading=true`. Когда придёт — `reducer.reset() + apply(full)` через chunked `requestIdleCallback` (CHUNK=500), preserve viewport: если был at-bottom → остаёмся at-bottom; иначе scroll-restore по `scrollHeight delta`.

UI gating пока `fullLoading=true`:
- GoTo на uuid не найденный в reducer → `pendingFullGoToRef.current = uuid`, drawer закрывается, **overlay висит** до прихода full → `goToEntryRef.current?.(uuid)` ретриггерит автоматически.
- «↑ Load older messages» — disabled, рендерит loading-точки с лейблом `Loading older messages…`.

См. `methodology/design-mobile.md::Tail-first loading` и `knowledge/fix-mobile-history-bottleneck.md`.

## Prompt cache (etag-revalidation)

`localStorage['noted-prompts-cache:v1']` = `{ etag: string, data: { groups, prompts } }`. PromptPickerSheet hydrate'ится синхронно из cache на mount → UI рисуется в первый кадр без spinner'а. Параллельно `Api.prompts(cachedEtag)` — server считает sha-1 от canonical JSON, если совпало — `{ etag, unchanged: true }` (~50 байт). Network failure при наличии cache → silent fallback.

Версия ключа `:v1` бампается **только** при backwards-incompatible изменении схемы (новые поля в prompt — нет, переименование — да). Контентные изменения отлавливает etag сам.

## Performance instrumentation

Server: `[WebTiming]` теги — каждый `/timeline`, `/history` пишет `bridge=Xms find=Yms parse=Zms total=Wms`, `[WebGzip] origB → gzipB (N%) in Tms` для крупных payloads (>64KB).

Client: `[History] tailFetch / tailFetched / tailApplied / fullFetch / fullFetched / fullApplied` через `Api.log()` → `POST /api/log/client` → `console.log` → `dev.log`. Каждый шаг с `*Ms` для blame'а. `[TimelineGoTo] click / window / done / queuedForFullLoad / NOT FOUND` для timeline-навигации. Без этих логов причину slow-load'а с phone не диагностировать (см. `fix-mobile-history-bottleneck.md` — 15 секунд оказались network transfer'ом, не reducer'ом).

## gzip threshold

`sendJson` — gzip только для payloads ≥ 4KB **и** только если client прислал `Accept-Encoding: gzip`. Уровень 6 (баланс ratio/CPU). На 20MB JSON history даёт 60-65% сжатие (7-8MB), 250ms server CPU — приемлемо когда альтернатива 4-15 сек transfer на phone. Под threshold'ом overhead не оправдан (gzip header + CPU > saved bytes).
