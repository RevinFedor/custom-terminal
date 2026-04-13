# Feature: LLM Provider Proxy

## Intro
Встроенный HTTP proxy в main process (порт 4001+) через который проходит **весь** трафик Claude Code к Anthropic API. Запускается при старте приложения, Claude Code получает `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` через env PTY.

## Режимы работы

### Anthropic (default)
Passthrough к `api.anthropic.com`. OAuth-токен подписки пробрасывается as-is через headers.

**Fast path:** Если body не содержит `"thinking"` / `"redacted_thinking"` строк — JSON не парсится, body forwards as-is. Это критично для **prompt cache key**: cache key считается Anthropic по содержимому messages после JSON decode на сервере, но ресериализация (`JSON.parse → JSON.stringify`) может менять порядок escape'ов и ломать `cch=` billing sentinel.

**Thinking strip:** После работы в Zen mode в истории могут остаться thinking/redacted_thinking блоки от MiniMax/Kimi. Anthropic API их отвергает → proxy вырезает. При этом body ресериализуется → первый anthropic-запрос после Zen = cache miss.

### Zen
Перенаправляет на `opencode.ai/zen`. Переписывает model в body, заменяет auth header на Zen API key.

## Connection Pooling (keepAlive)
Каждый режим имеет свой `https.Agent` с `keepAlive: true`. Без keepAlive каждый запрос = новый TCP + TLS handshake (~200-500ms). С keepAlive повторные запросы переиспользуют существующее TLS-соединение.

## Cache Stats Logging
Proxy перехватывает первый SSE `message_start` event в streaming response и логирует cache метрики:
```
[ProviderProxy] Cache: read=187000 create=1500 input=3 HIT
```
Поля: `cache_read_input_tokens` (из кэша, 0.1x стоимости), `cache_creation_input_tokens` (записано в кэш, 1.25x).

**Эмпирическая проверка (апрель 2026):** 96% cache hit rate на 904 turns через proxy. Кэш работает — cache key вычисляется сервером по содержимому messages после JSON decode, а не по бинарному HTTP body.

## Graceful Shutdown
При `before-quit` proxy drain'ит активные соединения (до 15s). Без этого crash mid-stream → assistant response не записывается в JSONL → chain break в backtrace. См. [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) секция 2.2 (Generic Chain Break Recovery).

## Ловушки

### cch= Billing Sentinel
Claude Code вставляет `x-anthropic-billing-header` с xxHash64 от body в system block. Если proxy ресериализует JSON (thinking strip после Zen), hash ломается. Не блокирует запрос, но может влиять на billing attribution. Опаснее: если в tool_result когда-либо появился текст `cch=XXXXX` (из логов), Claude Code мутирует его при каждом запросе, перманентно ломая prompt cache на оставшуюся сессию.

### Proxy Crash = Chain Break
Если proxy/Electron падает mid-stream, Claude Code пишет `api_error` с parentUuid на assistant-ответ, который был в памяти но не на диске. Backtrace прерывается. Решение: generic chain break recovery + graceful shutdown.

### content-length
Ранее proxy удалял `content-length` (→ chunked TE). Сейчас пересчитывает через `Buffer.byteLength(body)` для корректного fixed-length request.
