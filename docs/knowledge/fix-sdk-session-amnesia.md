# Fix: Claude SDK session amnesia (Claude забывает контекст между ходами)

## Симптом

В SDK-табе пользователь отправляет два сообщения подряд: «запомни число 7», «какое число?». Claude отвечает «не было такого, начнём сначала». На любой второй+ prompt Claude отвечает в вакууме — у него **нет памяти** предыдущих ходов в том же чате. UI показывает messages корректно (continuity по виду), но реальная сессия каждый раз новая.

Дополнительный симптом для mobile: тосты *«Claude Code returned an error result: No conversation found with session ID: <uuid>»* при отправке prompt'а в существующий чат.

## Что в логах

```
10:57:43  query started new                       ← turn 1
10:57:46  sessionId captured: 97bd8994
10:57:49  stream ended
10:58:15  send-message resume=97bd8994 source=caller
10:58:15  query started new                       ← должен быть resume=97bd8994!
10:58:17  sessionId captured: a4762f2a            ← новая uuid
10:58:21  stream ended
10:58:30  send-message resume=97bd8994 source=caller  ← caller тащит МЁРТВЫЙ uuid
```

После каждого turn'а — новый sessionId, никогда `resume=`. Бесконечная rotation.

## Пять итераций отладки (что пробовали и почему провалилось)

1. **Гипотеза: `sdkSessions.delete(tabId)` в `finally` ломает resume.** Map очищается между turn'ами → `existingSession.sessionId` undefined в `send-message` → стартует new. **Фикс:** caller передаёт `resumeSessionId` явно из `tab.claudeSessionId`. → Не помогло. Логи: `resume=<uuid> source=caller` идёт, но всё равно `query started new`.

2. **Гипотеза: pre-flight `isResumableSession` проваливается.** Добавил перед `query()` проверку: JSONL exists и содержит хоть одну `user`/`assistant` запись. Если не валиден — стартуем без resume. Логи показали `[ClaudeSDK] stale resumeSessionId XXX — JSONL missing or empty, starting fresh` для **каждого** prompt'а. Файл-то есть и не пустой. Что-то не так с самой проверкой.

3. **Гипотеза: SDK throw'ит «No conversation found» в iterator.** Добавил runtime fallback — если в stream прилетает `type:'result', subtype:'error'` с «No conversation found» → silent retry без resume + send `claude-sdk:stale-resume-cleared` event в renderer чтобы tab чистил `claudeSessionId`. → Не сработало, потому что pre-flight (шаг 2) уже отбрасывал каждую попытку как stale.

4. **Гипотеза: `sessionIdRef.current` не обновляется на rotation.** В renderer был guard `if (data.sessionId && !sessionIdRef.current)` — sessionId захватывался **один раз**, новые ротации игнорировались. Старый uuid жил в store вечно. **Фикс:** `if (data.sessionId !== sessionIdRef.current)` — всегда adoptим свежий. → Помогло частично, store обновляется, но pre-flight всё равно отбрасывает.

5. **Корень — `isResumableSession` использует hand-rolled slug.** Формула была `'-' + cwd.replace(/\//g, '-')`. Для `/Users/fedor/Desktop/custom-terminal` → `--Users-fedor-Desktop-custom-terminal` (двойной leading dash). Реальный Claude Code slug — `-Users-fedor-...` (одинарный). `existsSync` всегда false → каждая resume помечалась stale → fresh start → новый sessionId → ротация. **Фикс:** `findSessionFile(uuid, cwd)` (проектный helper из `claude-data.js`) знает Claude rules и сканирует все project dirs.

## Почему так долго не нашли

Сложение трёх багов давало одинаковый симптом «каждый turn — новый sessionId». На каждый фикс симптом не уходил, потому что **остальные два** продолжали работать. Логи `[ClaudeSDK] query started new` без указания **причины** (была ли валидация, был ли retry, был ли guard) — приходилось гадать. После добавления `[ClaudeSDK] stale resumeSessionId XXX` диагностический сигнал стал детерминированным.

Архитектурный урок: **in-memory Map (`sdkSessions`) не должна быть source of truth для persistent identifier'а** (sessionId — атрибут JSONL на диске, живёт между процессами). См. `methodology/дизайн-принципы.md::In-memory ephemeral state ≠ persistent identifier source`.

## Как проверять что починилось

E2E через MCP (electron-e2e-testing skill):

```
1. mcp__electron__electron_connect({port: 9224})
2. switchTab → new SDK tab
3. invoke claude-sdk:create-session с prompt "запомни 42"
4. wait stream ended
5. invoke claude-sdk:send-message с prompt "какое число?",
   resumeSessionId: <captured>
6. wait stream ended
7. grep logs/dev.log: должно быть "query started ... resume=<uuid>"
   (NOT "new")
8. читай JSONL файл — все 4 messages должны быть в одном файле
9. assistant ответ должен содержать "42"
```

## Затронутые файлы

- `src/main/main.js::sdkStartQuery` — pre-flight `isResumableSession` через `findSessionFile`
- `src/main/main.js::send-message handler` — accept `resumeSessionId` от caller
- `src/main/main.js` — runtime stale-resume detection в stream iterator + retry
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx::handleMessage` — `sessionIdRef` always-adopt latest
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx` — `claude-sdk:stale-resume-cleared` listener
- `src/renderer/App.tsx::sendSDKMessage bridge` — pass `resumeSessionId: tab.claudeSessionId`

См. также `knowledge/fact-claude-sdk-tab.md::Resume contract`.
