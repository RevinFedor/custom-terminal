# Fix: Race Condition в Incremental JSONL Reader

### Симптомы
- Timeline внезапно показывает 2-3 записи вместо 100+. Количество хаотично скачет (113 → 0 → 20 → 113 → 14 → 29 → 0).
- В логах: `[Timeline:Backtrace] BREAK: uuid=XXXXXXXX not in recordMap`. UUID существует в JSONL файле, но отсутствует в кэше.
- Проблема воспроизводится на длинных сессиях (5000+ записей, 30MB+ файл) с активной работой Claude (частая запись в JSONL).
- Баг интермиттентный — зависит от тайминга конкурентных timeline refresh'ов.

---

## Корневая причина

`loadJsonlRecords` — async функция. Timeline refresh каждые 2 сек может запустить два параллельных вызова для одного файла. Объект кэша `_jsonlCache.get(filePath)` — **мутабельная ссылка**, разделяемая между вызовами.

### Race condition в Case 2 (инкрементальное чтение)

```
Call A: prevSize = cached.size (100)    // snapshot
Call A: await fd.open()                 // ← YIELD
Call B: prevSize = cached.size (100)    // same snapshot
Call B: await fd.open()                 // ← YIELD
Call A: resumes, reads 100→200, updates cached.size = 200
Call B: resumes, BUT cached.size is now 200!
Call B: reads from offset 200 (not 100) for (250 - 100) = 150 bytes
        → reads bytes 200→350, SKIPS bytes 100→200
```

Записи в диапазоне 100→200 **навсегда пропадают** из кэша (Map мутируется in-place, повторное чтение этого диапазона не происходит).

### Почему не UTF-8

Первая гипотеза — коррупция при split мультибайтных символов на границе чтения. Отброшена: `\n` (0x0A) — однобайтный символ, не участвует в UTF-8 последовательностях. JSON structural chars (`"`, `{`, `}`) тоже ASCII. `JSON.parse` успешно парсит строки с `\uFFFD` (replacement char) — UUID остаётся intact.

## Решение

### 1. Snapshot до await (Prevention)

Все поля кэша копируются в локальные переменные **до первого `await`**:
```javascript
const prevSize = cached.size;
const prevLeftover = cached.leftover || '';
const prevBridgeSessionId = cached.bridgeSessionId;
const prevFileIndex = cached.fileIndex;
```

`fd.read()` использует `prevSize` (не `cached.size`), гарантируя что диапазон чтения не сдвинется конкурентным вызовом.

### 2. Guard при обновлении кэша

```javascript
if (stat.size >= cached.size) { _jsonlCache.set(...) }
```
Предотвращает откат кэша если конкурентный вызов уже продвинул `cached.size` дальше.

### 3. Cache Recovery в Backtrace (Safety net)

Если backtrace встречает BREAK (UUID not in recordMap) и это не compact_boundary:
1. `_jsonlCache.clear()` — инвалидация ВСЕХ кэшей
2. `resolveSessionChain()` — полное перечитывание файлов
3. Если UUID найден — рестарт backtrace с начала
4. Если нет — обычный BREAK (UUID реально отсутствует, e.g. dangling reference)

Recovery срабатывает максимум 1 раз за timeline load (флаг `_cacheInvalidated`).

---

## Диагностика

Паттерн в production.log:
```
BREAK: uuid=XXXXXXXX not in recordMap. lastAdded.type=assistant subtype=none
```
После фикса вместо BREAK появляется:
```
BREAK at uuid=XXXXXXXX — invalidating JSONL cache and retrying
Cache recovery SUCCESS — restarting from YYYYYYYY mergedMap.size=NNNN
```

**Связанные факты:**
- [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) — Секция 1.1: Concurrent Access Safety
- [`fix-performance-lags.md`](fix-performance-lags.md) — Секция 1: Async Incremental Reader
