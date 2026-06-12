# Feature: Semantic Search (Session History)

## Intro
Поиск по истории сессий Claude через embedding-based cosine similarity. Основная подсистема индексирует JSONL-файлы сессий в SQLite и ищет по смыслу внутри Q+A чанков ("проблемы с вставкой" → найдёт "TTYHOG limit 1024 bytes"). Отдельно существует лёгкий title-only поиск для ProjectHome: он индексирует только названия закрытых вкладок и не заменяет transcript search.

## Архитектура

### Пайплайн индексации
1. **Парсинг JSONL** → извлечение user/assistant сообщений (пропускает system, tool_result, progress)
2. **Чанкинг** → группировка в Q+A пары (User + следующий Assistant). Длинные ответы режутся на sub-chunks
3. **Embedding** → Gemini API (`batchEmbedContents`), хранение как BLOB в SQLite
4. **FTS5** → параллельная keyword-индексация для fallback при недоступности API

### Поиск (dual-mode)
- **Semantic**: запрос → embed → cosine similarity по всем чанкам → top-N
- **FTS5 fallback**: если Gemini API недоступен — keyword extraction + BM25 scoring
- Результаты обогащаются именем таба из `tab_history` (join по `claude_session_id`)

### Триггеры индексации
- **Автоматический**: background-задача после `project:archive-tab`, но только для небольших transcript'ов. Close-path сначала быстро архивирует таб в SQLite, а auto-index стартует с задержкой ~5s, чтобы не подвешивать жест закрытия.
- **Большие Claude-сессии (`>5MB`)**: auto-index на close сознательно пропускается (`reason=avoid-close-freeze`). Такие архивы индексируются вручную через кнопку Index в Home.
- **Ручной**: кнопка Index на ProjectHome с настраиваемым лимитом сессий (от последних)

### Title-only поиск на ProjectHome

Home top-search разделён на два режима: instant local filter по `tab_history.name` и RAG по отдельному индексу `tab_history_title_index`. Этот индекс намеренно хранит только названия вкладок (`history_id`, `project_id`, `name_hash`, `embedding`) и использует ту же embedding-модель (`gemini-embedding-001`, 768 dims), но не читает JSONL transcript'ы и не создаёт `session_chunks`.

Причина разделения — latency и mental model. Пользователь печатает в верхнем поиске Home, чтобы найти вкладку по названию; поэтому обычный ввод должен реагировать мгновенно без Gemini/API. `Cmd+Enter`/кнопка `RAG` — отдельный semantic step поверх уже построенного title index. Если title index пустой, semantic search возвращает пусто без запроса к Gemini; сначала нужно нажать `Index`.

Индексация title-only rows маленькая и показывается прямо в кнопке `Index` (`current/total`). Не добавлять отдельный тяжёлый progress panel в Home: это служебное действие на несколько сотен/тысяч коротких строк, а не full transcript rebuild.

### Stats path на ProjectHome

Исторический шрам: раньше ProjectHome монтировал `SemanticSearchSection`, а секция сразу запрашивала `search:stats`, чтобы показать количество чанков/файлов/embeddings. Это latency-sensitive путь: он запускался не при поиске, а при обычном клике Home, поэтому sync SQL ощущался как “Home завис”.

Инвариант БД: `COUNT WHERE embedding IS NOT NULL` должен идти по partial index `idx_chunks_embedding_present`, а не full-scan `session_chunks`. На реальной базе 2026-06-12 запрос без индекса сканировал ~87K строк и блокировал main process на 4.1s; пользователь видел frozen hover/click сразу после Home. После индекса query plan должен быть:
```text
SCAN session_chunks USING INDEX idx_chunks_embedding_present
```

Текущий Home не должен монтировать `SemanticSearchSection` вообще; он использует title-only IPC (`tab-title-index:*`, `tab-title-search:semantic`). Если `search:stats` снова попадает в `[Perf:IpcSlow]` или `ipcAgg5s=search:stats` при простом открытии Home, сначала ищи случайно возвращённый old mount. Если `search:stats` нужен на отдельной странице full transcript search — проверяй `EXPLAIN QUERY PLAN`, а не React render Home. Детальный шрам — [`fix-performance-lags.md::Freeze при открытии Home`](fix-performance-lags.md).

## Embedding: Выбор модели и итерации

### Отброшенные подходы
- **`text-embedding-004`** — первоначальный выбор. API возвращает 404: модель удалена из `v1beta` endpoint (март 2026). Потрачено 15+ ошибок в логах до обнаружения.
- **`gemini-embedding-001` с дефолтной размерностью** — возвращает 3072 dims. При 74K чанков = ~900MB в SQLite BLOB. Неприемлемо.

### Текущее решение
`gemini-embedding-001` с `outputDimensionality: 768` — truncated Matryoshka embedding. Качество поиска сохраняется, размер базы ~230MB на 74K чанков. Модель бесплатная (free tier: 1500 RPM, 1M tok/min).

### Hash + Embedding Guard
При первой индексации модель была сломана → 74K чанков сохранились без embeddings (только FTS). При повторном Index `isFileIndexed()` проверял только file hash и пропускал файлы. **Решение**: проверять `hash match AND embedding IS NOT NULL`. Без этого re-index после смены модели не работает.

## Известные ограничения

### Дубликаты из форкнутых сессий
Форкнутые сессии содержат скопированный текст родителя. Один и тот же Q+A pair индексируется N раз (по числу форков). Результат: одинаковые snippet'ы в выдаче. **Не решено.** Возможные подходы: MMR re-ranking (код в OpenClaw `packages/openclaw/src/memory/mmr.ts`), дедупликация по text hash при поиске.

### Только Claude сессии
Gemini сессии хранятся в другом формате и не индексируются. Расширение потребует адаптации парсера.

### Rate Limits при bulk индексации
74K чанков / 100 per batch = 745 API calls. При free tier 1M tok/min: ~37 минут на полную переиндексацию. Настраиваемый лимит (5/10/25/50/100 последних сессий) позволяет тестировать без ожидания.

### Auto-index на close не гарантирован для тяжёлых архивов
Это не bug, а trade-off. Если transcript большой, приложение предпочитает мгновенно закрыть вкладку и не тащить синхронный parse/embedding-setup в main thread. Симптом выглядит как "закрыл Claude, а сессия сразу не ищется" — в таком случае нужно запускать ручной Index.

## Симптомы типичных проблем
- **"Search возвращает 0 результатов"** → чанки без embeddings (проверить `SELECT COUNT(*) FROM session_chunks WHERE embedding IS NOT NULL`). Причина: индексация прошла со сломанной моделью. Решение: нажать Index повторно.
- **"RAG по Home вкладкам возвращает 0 результатов"** → проверить `tab_history_title_index`, а не `session_chunks`. Title-only поиск не индексирует transcript'ы; для него нужен `tab-title-index:reindex`.
- **"Одинаковые результаты в выдаче"** → форкнутые сессии. См. "Дубликаты из форкнутых сессий".
- **"Indexing зависает"** → rate limit Gemini API. Уменьшить лимит сессий в настройках.
- **"Только что закрытая большая сессия не ищется"** → auto-index на close был пропущен по размеру файла (>5MB). Это ожидаемо; запустить ручной Index.
- **"Не скроллится страница Home с результатами"** → текущий Home должен отдавать scroll виртуализатору внутри `flex-1 min-h-0`; внешний `overflow-y-auto` вокруг всего Home возвращать нельзя.
- **"После клика Home зависают hover и клики"** → проверить, не вернулся ли `SemanticSearchSection` / `search:stats` mount; в нормальном Home-flow title-only stats не должны сканировать `session_chunks`.
