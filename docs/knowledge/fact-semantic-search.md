# Feature: Semantic Search (Session History)

## Intro
Поиск по истории сессий Claude через embedding-based cosine similarity. Основная подсистема индексирует JSONL-файлы сессий в SQLite и ищет по смыслу внутри Q+A чанков ("проблемы с вставкой" → найдёт "TTYHOG limit 1024 bytes"). Отдельно существуют два лёгких поиска для ProjectHome: title-only индекс по названиям закрытых вкладок и iteration-index по user-итерациям сохранённых Claude/Codex сессий. Они не заменяют full transcript search по `session_chunks`.

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
- **ProjectHome auto Title/Iterations**: отдельные Settings toggles индексируют только новые `tab_history` rows после включения. Title auto-index эмбеддит имя одной history-записи. Iteration auto-index targeted-парсит один `history_id` и фильтрует user prompts по timestamp включения toggle. Это не full transcript `session_chunks` auto-index и не live watcher активной вкладки.

### Title-only поиск на ProjectHome

Home top input сейчас работает как instant local filter по `tab_history.name`. Отдельный индекс `tab_history_title_index` всё ещё существует, но это maintenance/search substrate для названий вкладок, а не текущая семантика видимой кнопки `RAG`. Индекс намеренно хранит только названия вкладок (`history_id`, `project_id`, `name_hash`, `embedding`) и использует ту же embedding-модель (`gemini-embedding-001`, 768 dims), но не читает JSONL transcript'ы и не создаёт `session_chunks`.

Причина разделения — latency и mental model. Пользователь печатает в верхнем поиске Home, чтобы найти вкладку по названию; поэтому обычный ввод должен реагировать мгновенно без Gemini/API. Видимая кнопка `RAG` и `Cmd+Enter` в текущем Home запускают iteration-search по user-сообщениям. Если title semantic path возвращается в UI, он должен иметь отдельный режим/чип и не делить affordance с iteration-search. Если title index пустой, title semantic search возвращает пусто без запроса к Gemini; сначала нужно нажать `Index`.

Индексация title-only rows маленькая и показывается прямо в кнопке `Index` (`current/total`). Не добавлять отдельный тяжёлый progress panel в Home: это служебное действие на несколько сотен/тысяч коротких строк, а не full transcript rebuild.

Auto Title использует targeted path по одному `history_id`, а не `tab-title-index:reindex`: если у проекта уже есть 800 старых `new`, включение toggle не должно внезапно запускать backlog. Backlog остаётся ручным действием через Index.

### Iteration search на ProjectHome

Кнопка `RAG` в Home запускает не title-only RAG, а semantic search по user-итерациям. Индекс хранится в `tab_history_iteration_index`: `history_id`, `project_id`, `tool_type`, `session_id`, `entry_uuid`, `iteration_index`, optional summary/content, hash и embedding. Parser нельзя писать заново: Claude берётся через существующий `parseTimelineEntries`, Codex через существующий Codex timeline builder, чтобы `entry_uuid` совпадал с HistoryPanel/Timeline.

Stats умеют работать по диапазону `dateFrom`: для уже распарсенных histories total = discovered user-iterations, для ещё не распарсенных histories approximate total временно берётся из `tab_history.message_count`. При `dateFrom` все stats/search/reindex фильтруются по `tab_history.closed_at >= dateFrom`.

У iteration index есть отдельная scan-отметка per history. Она нужна не для поиска, а для честного `new/total`: history может не дать ни одной user-итерации, потому что transcript удалён, cwd больше не существует или parser вернул пустой список. Без scan-отметки такая history навсегда остаётся в approximate tail через `message_count`, и пользователь видит один и тот же результат после полного reindex, например `520/1981` → повторный Index → снова `520/1981`. После `Full`-прохода stats должны считать approximate total только для history без index-rows и без scan-row; всё просмотренное схлопывается к реально discovered итерациям.

Progress iteration index состоит из двух фаз: scan histories и embed pending iterations. Renderer получает события после каждой обработанной history и после каждого embedding batch; между sync-парсингом rows main process отдаёт event loop, чтобы кнопка не висела на `0/N` до финального скачка.

Auto Iterations использует тот же parser/upsert path, но с `historyId` и `minEntryTs`. Старые prompts из сессии, начатой до включения toggle, не индексируются автоматом; если пользователь хочет весь архив, это ручной `Full`/date-range Index. Не переносить auto-mode на `fs.watch` JSONL без смены схемы: текущая таблица `tab_history_iteration_index` имеет foreign key на `tab_history(id)`, поэтому активная незакрытая вкладка не имеет корректного ключа для результата Home.

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

### Usage logging в Settings
Embedding-вызовы пишутся в общий Settings → AI → Statistics журнал как модель `gemini-embedding-001`: transcript index/query, title index/query, iteration index/query. Логировать нужно **операцию**, а не каждый `batchEmbedContents`: пользователь хочет видеть "одна цельная индексация = одна строка", иначе history превращается в шум из десятков batch-строк. У embedding API нет такой же `usageMetadata`, как у generateContent, поэтому input/total в статистике — приблизительная оценка по фактически отправленным символам после `MAX_CHUNK_CHARS`-обрезки (`ceil(chars / 4)`); output/thinking остаются нулевыми. Эти строки участвуют в totals/by model/history, но не в by prompt, потому что у embedding нет настраиваемого prompt.

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
- **"Title semantic по Home вкладкам возвращает 0 результатов"** → проверить `tab_history_title_index`, а не `session_chunks`. Title-only поиск не индексирует transcript'ы; для него нужен `tab-title-index:reindex`. Видимый `RAG` в Home сейчас относится к iteration-search, поэтому не диагностировать его через title index.
- **"RAG по Home iteration возвращает 0 результатов"** → проверить `tab_history_iteration_index`, date range в Home и наличие embeddings. Результаты должны содержать `entryUuid`; без него preview не сможет перейти к найденной итерации.
- **"Одинаковые результаты в выдаче"** → форкнутые сессии. См. "Дубликаты из форкнутых сессий".
- **"Indexing зависает"** → rate limit Gemini API. Уменьшить лимит сессий в настройках.
- **"Только что закрытая большая сессия не ищется"** → auto-index на close был пропущен по размеру файла (>5MB). Это ожидаемо; запустить ручной Index.
- **"Не скроллится страница Home с результатами"** → текущий Home должен отдавать scroll виртуализатору внутри `flex-1 min-h-0`; внешний `overflow-y-auto` вокруг всего Home возвращать нельзя.
- **"После клика Home зависают hover и клики"** → проверить, не вернулся ли `SemanticSearchSection` / `search:stats` mount; в нормальном Home-flow title-only stats не должны сканировать `session_chunks`.
