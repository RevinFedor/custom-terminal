# Fix: SDK persistence ломается при bypass'е renderer'а

## Симптомы

- После Ctrl+R / restart приложения SDK-таб открывается пустым, хотя ясно что в нём был диалог; JSONL на диске жив и содержит весь turn.
- В БД `tabs.claude_session_id = NULL` для такого таба, но `~/.claude/projects/<slug>/<uuid>.jsonl` существует и непустой.
- В UI до Ctrl+R виден только ответ Claude — user-prompt отсутствует. После Ctrl+R исчезает и ответ (вместе с пустым `claudeSessionId`).
- Симптом всплывает после e2e-тестов через `mcp__electron__electron_evaluate`, отправки prompt'ов через mobile-web в **только что созданный** или **скрытый** SDK-таб, любого programmatic-spawn без активного UI.

## Root cause: persistence привязана к mount-state компонента

Запись `claude_session_id` в БД идёт **только через renderer**: компонент `ClaudeSDKTab.tsx` слушает `ipcRenderer.on('claude-sdk:message', handleMessage)` и при первом чанке с `data.sessionId` вызывает `updateSDKState(tabId, { claudeSessionId })`, который дальше через стандартный tab-persist пайплайн записывает в SQLite.

Контракт ломается когда **компонент для конкретного `tabId` не смонтирован** в момент стрима:
- Юзер был на другом табе / на Dashboard → `ClaudeSDKTab` для нового tabId не отрендерился.
- E2E-тест создал таб через `createSDKTab` + сразу `ipcRenderer.invoke('claude-sdk:send-message')`, не переключая `activeTabId`. Main стартует query, JSONL пишется, SSE-чанки летят через `webContents.send('claude-sdk:message', { tabId, ... })`. Listener для этого `tabId` отсутствует в renderer → событие никем не подхвачено → `updateSDKState` не вызвался → БД не обновилась.

Параллельно второй симптом — пропавший user-prompt в UI — следствие того же bypass'а. Локальный user-bubble в `setMessages` пушится по `window.dispatchEvent('claude-sdk:external-prompt', ...)` из bridge'а `sendSDKMessage` (см. `fact-claude-sdk-tab.md::External clients`). Прямой `ipcRenderer.invoke('claude-sdk:send-message')` минует этот bridge и event не диспатчится. Ответ Claude всё равно появляется через стриминг (если таб успевает смонтироваться к концу turn'а), но user-bubble уже не восстановить — он живёт только в `setMessages` локально, в JSONL он есть, но `loadHistory` не зовётся пока `claudeSessionId` пуст.

## Workaround при потере связки

Если таб открывается пустым после рестарта, но известно что JSONL есть:

```bash
# Найти свежайший JSONL по mtime в нужном проекте
find ~/.claude/projects/-<slug>/ -name "*.jsonl" -newer <reference> | head -5

# Восстановить связку (заменить uuid и tab_id):
sqlite3 ~/Library/Application\ Support/noted-terminal/noted-terminal-dev.db \
  "UPDATE tabs SET claude_session_id='<uuid>' WHERE tab_id='<tabId>';"
```

После Ctrl+R таб подхватит историю из JSONL через `loadHistory(claudeSessionId)`.

## Правильное решение (TODO)

Persistence должна жить в **main**, не в renderer. Точка `_webBroadcast(tabId, { type: 'message', message, sessionId: session.sessionId })` в `sdkStartQuery` — единственное место где main гарантированно знает sessionId и tabId одновременно. Рядом с broadcast'ом надо вызывать `projectManager.db.setClaudeSessionId(tabId, sessionId)` напрямую, не полагаясь на то, что renderer слушает.

После этого renderer'овский `updateSDKState({ claudeSessionId })` остаётся как UI-sync (Zustand тоже надо обновить, чтобы InfoPanel/Timeline видели), но **БД пишется независимо** от mount-state.

Это закрывает три use case разом: e2e-тесты, mobile-web prompts, background-pre-warm. Все они сейчас рабочие пока юзер не закрыл приложение, но **не переживают рестарт**.

Принцип — `methodology/переносимый-дизайн.md::In-memory ephemeral state ≠ persistent identifier source` (распространяется не только на in-memory Map'ы, но и на mount-state React-компонентов: оба не должны быть единственным write-path'ом для persistent identifier'а).

## Связи

- `fact-claude-sdk-tab.md::External clients (mobile-web)` — про bridge `sendSDKMessage` и `claude-sdk:external-prompt` event для синхронизации desktop user-bubble.
- `fact-claude-sdk-tab.md::Resume contract` — почему renderer-side adoption sessionId через `sessionIdRef` обязателен для resume на следующем turn'е (это **другой** контракт, он не страдает от bypass'а пока ровно тот же tabId продолжает слать prompt'ы — `sdkSessions` Map в main подхватывает sessionId).
- `fix-sdk-session-amnesia.md` — соседняя проблема (сессия пишется но не resume'ится). У нас наоборот — resume бы заработал, если бы было что resume'ить.
