# Fix: Mobile chat history loads 15 секунд (network, не CPU)

## Симптом

С телефона юзер открывает SDK-таб с 5000+ сообщений. Чат показывает loader 10-15 секунд, кнопки UI «нажимаются молча» (события идут, React не отвечает). Жалоба формы *«у меня хз сколько грузится, секунд 10 ждать»*. На desktop тот же чат открывается за 1-2 секунды.

## Что пробовали и почему не сработало

1. **Гипотеза: `reducer.apply()` блокирует main thread.** Сделал chunked apply через `requestIdleCallback` (CHUNK=500 messages). Не помогло — после инструментирования выяснилось что `applyMs=16` для 5628 messages, reducer отрабатывал за 16 миллисекунд, не секунд.

2. **Гипотеза: `JSON.parse()` тормозит на phone CPU.** Замерил отдельно — `parseMs=26`. Тоже невинен.

3. **Гипотеза: chunked render отрабатывает медленно из-за react-markdown ×30 entries.** Заменил `renderedCount` (prefix) на `[renderStart, renderEnd)` window — render ограничен ~30 нодами всегда. Не помогло сравнимо со временем загрузки.

Все эти гипотезы — **угаданы по коду**, не подтверждены логами. Реальная причина была невидима пока не добавили **stage-by-stage timing**.

## Реальный bottleneck (по детерминированным логам)

Server timing-логи (`[WebTiming]` в `web-server.js`) показали: `/history START → DONE total=190ms` для 5628 messages. Server отдал быстро.

Client timing-логи (`[History]` теги через `Api.log()`):
```
[History] startFetch
[History] headers status=200 encoding=null contentLength=20449894 headersMs=740
[History] body bytes=20449894 bodyMs=14323 totalNetMs=15063
[History] parsed msgCount=5628 parseMs=26
[History] applied applyMs=16
```

**14.3 секунды** на скачивание 20MB JSON по WiFi на phone. Server fast, parse/apply невинны, всё остальное — network.

## Решение (две оси одновременно)

### Ось 1: уменьшить размер payload — gzip

`web-server.js::sendJson` — gzip всех JSON-ответов >= 4KB при `Accept-Encoding: gzip`. Уровень 6, sha-1 etag для prompts. На 20MB JSON history: → 7.2MB (60-65% сжатие), 250ms server CPU. Network transfer на phone: 14.3s → 5s.

### Ось 2: не качать всю историю сразу — tail-first

`?last=N` параметр на `/history`. Server slice'ит хвост:
```js
const lastN = parseInt(parsed.query.last, 10) || null;
if (lastN && total > lastN) {
  messages = allMsgs.slice(total - lastN);
  truncated = true;
  dropped = total - lastN;
}
return { messages, total, truncated, dropped };
```

Mobile открывает чат phase 1 = `?last=200` (~250KB gzipped, ~1 сек на phone). Phase 2 (фон, не блокирует UI) = full fetch без `last`, replace reducer state с preserve viewport. Юзер видит чат через 1 секунду, в фоне догружается prefix для «Load older» / GoTo на старые записи.

UI gating пока phase 2 не закончилась:
- GoTo на uuid не найденный в reducer → drawer закрывается, overlay висит, после прихода full → auto-jump.
- «↑ Load older» — disabled с loading-точками. См. `methodology/design-mobile.md::Tail-first loading`.

## Итог по timing

| Этап | Было | Стало |
|---|---|---|
| Payload | 20MB | 250KB (tail) + 7MB фон |
| Network на phone | 15.4 сек | ~1 сек (tail) + 5 сек фон |
| First paint | 16 сек | ~1.5 сек |
| Старая запись доступна | 16 сек | 6 сек (через очередь GoTo если тапнуть рано) |

## Урок

Когда «открывается долго» на сетевом клиенте — **первая гипотеза должна быть network**, а не CPU. Современные phone CPU отрабатывают `JSON.parse(20MB)` за десятки миллисекунд. WiFi с walls между router'ом и phone — за **секунды на мегабайт**. Без stage-by-stage timing'а на каждом шаге pipeline (request-start → response-headers → body-bytes → JSON.parse → apply → paint) — гипотезы об «узком месте» = угадывание.

Подключай `[WebTiming]` (server) и `Api.log('History', ...)` (client) **до** оптимизации, не после. Половина «оптимизаций» обычных людей чинит не то место.

См. `knowledge/fact-mobile-web.md::Performance instrumentation` для тегов и шаблона диагностики.

## Followup: replaced by NDJSON streaming + IDB (mai 2026)

Описанный выше gzip + tail-first JSON two-phase подход был **переходным**. Финальная архитектура (deep-research отчёт + implementation):

- **Wire**: NDJSON (one JSON per `\n`) поверх Brotli-4 stream — first useful paint падает с 4с до **~250ms** (рендер начинается как только первая строка дошла, не ждёт полного download).
- **Render**: `react-virtuoso` вместо ручного window-slice — DOM bounded ~30 нод **независимо от total**, удалили `renderStart/renderEnd`/Load-older/full-screen-overlay/`fullLoading`.
- **Cache**: IndexedDB record-store вместо localStorage 20MB blob (last на iOS вообще capped 2.5MB и тихо вайпается). Per-record key `[sessionId, ord]`. Read = structured-clone, **нет JSON.parse** на хот-пути. Delta sync через `?after=<lastUuid>` — повторный mount чата мгновенный.
- **Two-phase cold**: `?last=200` (paint) → `?before=<firstTailUuid>` (prefix backfill в фоне). Между ними `prefixMergeLockRef` блокирует WS apply, deferred queue drain'ится после merge — иначе live message теряется.

См. `knowledge/fact-mobile-web.md::History pipeline` для актуального flow.
