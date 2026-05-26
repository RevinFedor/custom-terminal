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

**Mobile-side guard:** phone reducer **игнорирует** `__webSynthetic: true` входящие messages — иначе на phone был бы дубль user-bubble (synthetic + real-record когда дойдёт). Phone получает мгновенный feedback через **локальный optimistic push** в `send()` — `reducer.apply({type:'user', message:..., __pendingLocal: true})` сразу. Когда real-record прилетит из WS, dedupe-функция `adoptOrPush` в reducer находит последний user-bubble без uuid с тем же текстом и **adopt'ит** real uuid в существующую entry, не создаёт новую.

## History loader: НЕ getSessionMessages

`getSessionMessages` из Anthropic SDK возвращает **другой набор записей** чем `parseTimelineEntries` — uuids не пересекаются. Если history грузить через SDK-helper, GoTo из timeline (использует timeline uuids как anchors) никогда не находит цель. См. [`fix-mobile-history-uuid-mismatch.md`](fix-mobile-history-uuid-mismatch.md).

Решение: новый IPC `claude-sdk:active-branch-messages` читает JSONL напрямую, walks active branch (тот же алгоритм что в `parseTimelineEntries`), возвращает **все типы** в chain order — user, assistant, tool_use, tool_result. Mobile reducer обрабатывает их так же как стрим. Anchors совпадают.

## Slash-чип / compact-summary / XML wrappers в mobile reducer

Mobile receiver получает тот же поток raw SDK-сообщений что и десктоп — значит видит **все CLI/SDK-инъекции** которые на десктопе разруливаются в `ClaudeSDKTab` парсере: служебные XML-обёртки, slash-команды как user-bubble, compact-summary records с metrics. Без специальной обработки в mobile reducer'е (`mobile-web/src/messages.ts`) юзер видит сырой `<command-name>/compact</command-name>` как обычное сообщение, `<local-command-stdout>Compacted</local-command-stdout>` как user-реплику, а compact summary без оранжевой карточки и метрик.

Распознавание в `apply()` reducer'а:
- `type:'system' && subtype:'compact_boundary'` — стэшится `pendingCompactMetrics` (preTokens / postTokens / durationMs), сама запись не рендерится. Метрики прицепятся к следующей user-записи с compact-summary флагом.
- `<command-name>X</command-name>` + optional `<command-args>` → `kind:'slash'`, рендерится как фиолетовая (`rgba(129,140,248,*)`) compact-пилюля справа, моноширный шрифт, `userSelect:none`. Точная копия desktop UserMsg isSlashCommand-ветки.
- `<local-command-stdout>` / `<local-command-caveat>` / `<system-reminder>` / `<tool_result>` / `[tool_result]` → drop. CLI-артефакты, не пользовательский текст.
- `isCompactSummary === true` (authoritative SDK-флаг) или text начинается с `'This session is being continued from a previous conversation'` (fallback для старых сессий) → `kind:'compact-summary'`, прицепляются метрики из `pendingCompactMetrics`. Рендерится как orange-card (`#DA7756` border + bg `rgba(218,119,86,0.06)`), заголовок «COMPACT SUMMARY», метрики `preTokens → postTokens · Ns` моноширно, collapsible body с 600-char preview (`COMPACT_PREVIEW_CHARS`).
- `maybeSwapCompactPair()` — после push'а compact-summary или slash-чипа в `state.entries` пробует swap последних двух элементов если они `[compact-summary, slash('/compact')]`. JSONL пишет summary ДО следующей `<command-name>/compact</command-name>` записи, визуально chip должен быть выше — юзер ввёл команду, потом SDK сделал summary.

Dedup для slash/compact работает через `entryUuid` — WS replay после optimistic local apply не плодит дубликаты.

## Mobile composer: caret + permanent ring + selective scrollbar

Три неочевидных решения в `mobile-web/src/App.tsx::Composer`:

- **Orange visible caret** (`caretColor: '#FFB382'`). Раньше пробовал `caret-color: transparent` (юзер: «значок мигающий надо убрать»). Потом юзер репортил «не работает печать» — на самом деле работало, но он не видел каретки и не знал что инпут активен. Caret — единственный достоверный сигнал «текст идёт сюда» когда юзер начал печатать в полупустой инпут.
- **Permanent border `#FFB382`** (всегда, не `focus:border-*`). Юзер: *«просто рамка всегда активна»*, *«заново мигать рамкой тоже не надо»*. Раньше переключали `focus:border-[#555]` — каждый re-focus на mobile (touch tap → blur от scroll → re-focus) давал визуальный flicker рамки. Постоянная оранжевая рамка читается как «вот THE инпут».
- **Conditional orange scrollbar**: textarea автоэкспандится до 40vh; пока content не достиг кап, `overflowY: hidden` (никакого скролла в одну строку); как только превысил — `overflowY: auto` + класс `composer-textarea--scroll` который **переписывает глобальное** `::-webkit-scrollbar { width:0 }` на `width:6px` с `thumb: #FFB382` (orange, отделено от history-скролла который остаётся скрытым). Юзер: *«у инпута, если у нас одна строка, не должен отображаться scroll, и также scroll у инпута сделай отдельно, оранжевым»*.
- **Mic-dictation (Soniox)**: 🎤-кнопка в row 2 composer'а, тот же движок что в десктопном `MicButton` (`mobile-web/src/dictation.ts` — копия `src/renderer/utils/dictation.ts`, два независимых Vite-билда не могут шарить через alias). При старте — `prefixRef.current = text` снимает снэпшот того что юзер успел напечатать, потом `onUpdate` пишет `prefix + final + partial` в textarea. Без снэпшота транскрипт затирал бы пользовательский текст. По stop — `prefixRef.current = ''` для следующей сессии. Floating window над кнопкой реализован прямо в composer'е (не делегируется внешнему компоненту). Token mint — `Api.sonioxToken()` → `POST /api/soniox-token` → main process с `SONIOX_API_KEY` из env.

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
GET  /api/sdk-tabs/:tabId/history              → JSON or NDJSON (Accept-driven)
                                               → query params: ?last=N (tail), ?after=<uuid> (delta sync), ?before=<uuid> (prefix backfill)
                                               → Accept: application/x-ndjson → streamed line-by-line, Brotli-4
POST /api/sdk-tabs/:tabId/truncate              → drop everything ≥ targetUuid (Edit/Repeat)
GET  /api/sdk-tabs/:tabId/timeline             → parseTimelineEntries
GET  /api/sdk-tabs/:tabId/params               → getSDKParams
POST /api/sdk-tabs/:tabId/params               → setSDKParams
GET  /api/prompts[?etag=X]                     → getPrompts + getPromptGroups (no bridge); ?etag match → { etag, unchanged: true }
POST /api/log/client                           → mobile diagnostic logs → console.log → dev.log
WS   /ws?token=&tabId=                         → snapshot, message, busy, done events
```

Все pathname-параметры (`:id`, `:tabId`) ОБЯЗАТЕЛЬНО прогоняются через `decId()` (`decodeURIComponent`) перед использованием — см. секцию «URL-encoded path параметры» ниже.

Публичный URL вместо LAN-IP — см. [`fact-remote-access.md`](fact-remote-access.md). С phone'а через интернет endpoint-map тот же, отличается только хост в URL.

## URL-encoded path параметры (`=` в base64-id)

ProjectId формируется как `base64(path)`. Короткие пути (`/Users/fedor/Desktop/vs-code/agrotech/uav` → `L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvdnMtY29kZS9hZ3JvdGVjaC91YXY=`) оканчиваются на `=`, который в URL сериализуется как `%3D`. Tab-id наследует base64-префикс от projectId, тот же эффект.

**Симптом:** `HTTP 404: {"error":"project not found","projectId":"…%3D"}` только на проектах с коротким именем; длинные имена (`custom-terminal`) с padding `0` или `==` без `=` работают сразу.

**Причина:** regex-захват `parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tabs$/)` возвращает **URL-encoded** строку. `projectManager.db.getProjectById('…%3D')` ищет в SQLite по дословному ключу, а в БД — декодированный `=`. Не находит → 404.

**Решение:** helper `decId(s) { try { return decodeURIComponent(s); } catch { return s; } }` обязательно применяется к каждому `m[1]` / `m[2]` в `web-server.js::handleApi`. Это покрывает не только `=`, но и кириллицу, пробелы, любой символ который mobile-web кодирует в URL. Когда добавляешь новый route с pathname-параметром — `decId(m[1])`, не голый `m[1]`.

## Live-fallback для `/api/projects/:id/tabs` через Zustand-bridge

`getProjectById` в `database.js` ходит **только в SQLite**. Проблема: проекты бывают **dashboard-only / draft** — открытые в Zustand `openProjects` Map, но ещё не записанные через `saveTabs` в БД. До этой правки таких проектов с phone'а нельзя было открыть — 404.

**Логика endpoint'а теперь двухступенчатая:**
1. `projectManager.db.getProjectById(projectId)` — основной путь (persisted проекты).
2. Если `null` → `bridgeRequest('getProjectTabsLive', { projectId })` — renderer проверяет `state.openProjects.get(projectId)` в Zustand и отдаёт live-snapshot табов.
3. Если и там нет → 404 с диагностическим логом `[WebServer] 404 project not found: <id> (not in DB, not in live Zustand)`.

Bridge-action `getProjectTabsLive` в `App.tsx::handleWebBridge` возвращает табы в том же shape что SQLite-путь, чтобы phone не отличал. Один из крайних случаев: если проект **открыт в UI и одновременно есть в БД с другим набором табов** — live из Zustand берёт верх (первый ступень нашла, ко второй не пошли). Это правильно — Zustand authoritative для активного состояния.

## Stale prod-app → silent bridge timeout (5s)

**Самый дорогой класс багов с phone-доступом.** Если в `App.tsx::handleWebBridge` или `web-server.js::bridgeRequest` сделана правка, но **не запущен `build:install`** — prod-app продолжает работать со старой сборкой в asar. С позиции web-server'а bridge-вызов уходит в `webContents.send('web:bridge-request', …)`, renderer его получает, но **handler с нужным action'ом не зарегистрирован** в старой версии → reply не приходит → ровно через `timeoutMs` (5000 по умолчанию) web-server отдаёт 500 `Bridge timeout: <action>`.

**Симптомы:**
- `[WebTiming] /history ERROR Bridge timeout: loadSDKHistory total=5000ms` (или другой action ровно по таймауту).
- Phone показывает бесконечный loader, через ~15с — пустой чат с composer'ом «Send something below».
- `/timeline` тоже валится в `bridge=1500ms` (там короче timeout на `getOpenProjectIds`), но **продолжает работать** через fallback на пустой openIds + чтение JSONL напрямую → юзер видит таймлайн при пустом чате, что особенно сбивает.

**Диагностика — мгновенные парные логи в трёх точках:**
- `web-server.js::bridgeRequest` пишет `[BridgeDiag] SEND action=… rid=… wins=…` на отправке, `[BridgeDiag] REPLY action=… elapsedMs=…` на приёме, `[BridgeDiag] TIMEOUT action=…` при истечении, `[BridgeDiag] REPLY_DROPPED rid=…` если ответ пришёл уже после timeout.
- `App.tsx::handleWebBridge` пишет `[BridgeDiag:R] RECV rid=…` на входе и `[BridgeDiag:R] REPLY rid=… ok=… elapsedMs=…` перед `ipcRenderer.send('web:bridge-reply', …)`.

Сценарии чтения:
- `SEND` без последующего `RECV` (через ~50ms gap) → renderer не получает IPC. Window-mismatch, dead webContents, или handler не зарегистрирован.
- `SEND + RECV + REPLY:R + REPLY (main)` все есть → всё ок, замерь `elapsedMs`.
- `SEND + RECV + REPLY:R` но `REPLY_DROPPED` в main → ответ опоздал, поднять `timeoutMs` для этого action'а в `bridgeRequest`.
- `SEND + RECV` но **нет** `REPLY:R` → handler упал silent внутри `await` (например `ipcRenderer.invoke('claude-sdk:active-branch-messages', …)` на огромном JSONL).

**Правило:** любая правка `App.tsx::handleWebBridge` или `web-server.js::bridgeRequest` требует `npm run build:install` перед тестом с phone'а — иначе симптом всегда будет «Bridge timeout» вне зависимости от качества правки. Это занудно, но иначе час уйдёт на отладку не того процесса. Mobile-web Vite dev (`cd mobile-web && npm run dev`) НЕ решает — фронт можно итерировать без билда, но `web-server.js` живёт в Electron main, его правки требуют `build:install` всё равно.

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

## Production packaging: `mobile-web/dist/**/*` обязателен в `build.files`

Production `web-server.js` раздаёт SPA по `path.resolve(__dirname, '../../mobile-web/dist')`. Из `app.asar/src/main` это резолвится в `app.asar/mobile-web/dist` — но если в `package.json::build.files` нет `mobile-web/dist/**/*`, директории внутри asar нет, и phone получает text-ответ «mobile-web/dist not built. Run: cd mobile-web && npm run build» (этот fallback в `serveStatic` при ENOENT). Electron-овский патченный fs прозрачно читает файлы из asar — никакого `asarUnpack`/`extraResources` не нужно, достаточно include. Билд порядок: сначала `cd mobile-web && npm run build`, потом electron-builder.

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

URL-схема: `#/projects/:projectId/chat/:tabId[?ro=1]`. HashRouter а не BrowserRouter — node-static в `web-server.js` не имеет SPA-fallback'а на произвольные pathnames; hash на сервер не уходит, фрагмент читается клиентом. Reload на любой странице → попадаешь обратно туда же. Deep-link (нет `state.tab` в `history.state`) → `Api.listTabs(projectId)` ищет TabInfo по `tabId`, либо показывает «Tab not found» с кнопкой назад. См. `methodology/мобильный-дизайн.md::Deep-link routing`.

## History pipeline (NDJSON streaming + IDB delta sync + virtuoso)

**Архитектура (заменила window-render + JSON two-phase в мае 2026):**

```
Mount ChatView
  ↓
[Phase 0] readCachedHistory(sid) → IDB hit?
   yes → reducer.reset + apply ALL cached → paint immediately, historyLoading=false
   no  → continue
  ↓
[Phase 1] streamHistory(?last=200) — NDJSON over Brotli-4
   meta {total, returned, firstUuid, lastUuid, etag}
   message...message...message  (one JSON per \n)
   done {written}
   ↓ each message: reducer.apply, scheduleFlush per rAF
  ↓
[Phase 2 — only if cold and total > returned] streamHistory(?before=<firstTailUuid>)
   ↓ collect into prefixBuffer
   ↓ on done: prefixMergeLockRef = true
   ↓        reducer.reset → apply(prefix + tail) → drain wsDeferredQueue
   ↓        prefixMergeLockRef = false
   ↓        flush
  ↓
[Persist] writeFullHistory(sid, rawHistoryBufferRef, etag, total, lastUuid)
```

Warm-cache путь: только одна фаза `?after=<cachedLastUuid>` — сервер вернёт пустой стрим (silent revalidation) или дельту с момента последнего mount'а.

**NDJSON wire format:**
- `Accept: application/x-ndjson` → server отвечает `Content-Type: application/x-ndjson`, `Content-Encoding: br` (если accepted)
- Line 1: `{"type":"meta", total, returned, truncated, dropped, sessionId, etag, firstUuid, lastUuid}`
- Lines 2..N+1: один SDK-message JSON на строку
- Last line: `{"type":"done", written}` — sentinel для clean stream end vs cut-off

Клиент-парсер: ручной `response.body.getReader()` (Safari нет async-iterable bodies до 26.x), `TextDecoder({stream: true})` для multi-byte chars across chunks, split по `\n` с carry-over remainder.

**Virtuoso вместо window-slice:** DOM bounded ~15-30 items независимо от total. **Удалили:** `renderStart/renderEnd`, "Load older" кнопку, full-screen GoTo overlay, `fullLoading` state, "N new below" marker, ручной scroll-restore. GoTo через `virtuosoRef.scrollToIndex({index, align:'center'})` — instant, без force-render.

**IDB record store** (idb 8.x):
- `meta` store keyed by `sessionId`: `{lastUuid, etag, total, updatedAt}`
- `messages` store keyed by `[sessionId, ord]`: одна запись на сообщение, secondary index `by-uuid`
- Read returns structured-cloned live objects — **нет JSON.parse на хот-пути** (vs 30ms parse 20MB blob каждый mount)
- Delta sync: meta.lastUuid → server `?after=<lastUuid>` → дописываем appendDelta. Полный rewrite только когда нет cache.

**Race protection (prefix-merge lock):** между `reducer.reset()` и `apply(merged)` в phase-2 могут прийти WS messages. Раньше они применялись в `reset → empty → WS apply (без context) → merge replace` → live message терялся. Теперь:
- `prefixMergeLockRef.current = true` перед reset
- WS handler: `if (prefixMergeLockRef.current) wsDeferredQueueRef.push(msg); return`
- После apply(merged): drain wsDeferredQueue → reducer.apply каждый → flush → release lock

**WS auto-reconnect с backoff:** Safari закрывает WS в фоновых табах через ~30 сек. `connect()` цикл с backoff 1s → 2s → 5s → 10s → 30s (cap), reset на onopen. Без этого юзер возвращается в чат через час и видит молчаливо мёртвый WS.

**Stream idle watchdog:** 30s без bytes → abort + onError. Без этого Electron-crash mid-stream → phone forever pending без сигнала.

**Synthetic broadcast skip on mobile:** main.js шлёт `__webSynthetic: true` user message через WS чтобы desktop рендер показал bubble на mobile-prompt'ах. Phone reducer **игнорирует** synthetic — иначе phone получит дубль (synthetic + real-record). Mobile получает мгновенный feedback через **локальный optimistic push** в `send()`, real-record adopt'ит свой uuid в существующую entry (dedupe by text).

См. `methodology/мобильный-дизайн.md::Tail-first loading`, `knowledge/fix-mobile-history-bottleneck.md` (история отладки до streaming), `knowledge/fix-mobile-scroll-jitter-virtuoso.md` (CV+virtuoso антипаттерн).

## Expanded state map (across virtuoso re-mount)

`_entryExpanded: Map<entryId, boolean>` в module scope `mobile-web/src/App.tsx`. Hook `useEntryExpanded(id, defaultOpen)` подписывается на per-id version counter. Используется в ThinkingCard и ToolCard. Cleanup в `clearEntryExpandedForIds` срабатывает на ChatView unmount — иначе Map течёт по entry.id'ам всех когда-либо открытых чатов.

См. `methodology/мобильный-дизайн.md::Persistent expanded state across virtual list re-mount`.

## Dev-port isolation (parallel production)

Production app (installed `/Applications/Noted Terminal.app`) слушает 7878. `npm run dev` устанавливает `NOTED_WEB_PORT=7979` через npm script — поднимает свой web-server на 7979, оба работают параллельно. Phone подключается на нужный порт (production URL стабильный, dev URL = тестовая копия).

**Port-walk fallback при EADDRINUSE.** Если preferred port (7878 или явный `NOTED_WEB_PORT`) занят — server инкрементирует и пробует следующий, до `PREFERRED + 20`. Раньше второй инстанс просто молча умирал с `EADDRINUSE` через `console.error`, mobile-web был доступен ровно у первого запустившегося. Теперь оба живые на разных портах. Реальный bound порт пишется в `~/.noted-terminal/web-server-<pid>.json` (`{port, pid, lanIp, updatedAt}`) — discovery для StatusBar mobile-chip'а и любого внешнего инспектора. `getInfo()` отдаёт `resolvedPort`, не const — без этого QR-код и copy-URL показывали 7878 на инстансе который реально на 7879.

Mobile-web Vite dev (`cd mobile-web && npm run dev`) — `host: '0.0.0.0'`, port 5180. Proxy `/api` и `/ws` на :7878. Используется когда нужен HMR на phone при правках `mobile-web/src/*.tsx`.

Token общий — `~/.noted-terminal/web-token.txt` читается обоими инстансами.

## Prompt cache (etag-revalidation)

`localStorage['noted-prompts-cache:v1']` = `{ etag: string, data: { groups, prompts } }`. PromptPickerSheet hydrate'ится синхронно из cache на mount → UI рисуется в первый кадр без spinner'а. Параллельно `Api.prompts(cachedEtag)` — server считает sha-1 от canonical JSON, если совпало — `{ etag, unchanged: true }` (~50 байт). Network failure при наличии cache → silent fallback.

Версия ключа `:v1` бампается **только** при backwards-incompatible изменении схемы (новые поля в prompt — нет, переименование — да). Контентные изменения отлавливает etag сам.

## Performance instrumentation

Server: `[WebTiming]` теги — каждый `/timeline`, `/history` пишет `bridge=Xms find=Yms parse=Zms total=Wms`, `[WebGzip] origB → gzipB (N%) in Tms` для крупных payloads (>64KB).

Client: `[History] streamFetch / streamMeta / streamDone / prefixMerged / idbWrote / cacheHit` через `Api.log()` → `POST /api/log/client` → `console.log` → `dev.log`. Каждый шаг с `*Ms` для blame'а. `[TimelineGoTo] click / done / NOT FOUND` для timeline-навигации. `[WS] open / close` с code/reason/backoffMs для reconnect диагностики. `[ScrollDiag] flushReducer / followOutput / atBottomStateChange / isScrolling / scroll {delta:N}` — для отладки scroll-jitter (см. `fix-mobile-scroll-jitter-virtuoso.md`).

**Архивные теги (устарели):** `tailFetch / tailFetched / fullFetch / fullFetched / fullApplied` использовались в JSON two-phase архитектуре, удалены вместе с ней.

## gzip threshold

`sendJson` — gzip только для payloads ≥ 4KB **и** только если client прислал `Accept-Encoding: gzip`. Уровень 6 (баланс ratio/CPU). На 20MB JSON history даёт 60-65% сжатие (7-8MB), 250ms server CPU — приемлемо когда альтернатива 4-15 сек transfer на phone. Под threshold'ом overhead не оправдан (gzip header + CPU > saved bytes).
