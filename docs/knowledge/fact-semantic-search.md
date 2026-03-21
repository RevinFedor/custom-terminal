# Feature: Semantic Search (Session History)

## Intro
Поиск по всей истории сессий Claude через embedding-based cosine similarity. Индексирует JSONL-файлы сессий в SQLite, позволяет искать по смыслу ("проблемы с вставкой" → найдёт "TTYHOG limit 1024 bytes"). Интегрирован в ProjectHome как collapsible секция.

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
- **Автоматический**: fire-and-forget при закрытии таба (`project:archive-tab`)
- **Ручной**: кнопка Index на ProjectHome с настраиваемым лимитом сессий (от последних)

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

## Симптомы типичных проблем
- **"Search возвращает 0 результатов"** → чанки без embeddings (проверить `SELECT COUNT(*) FROM session_chunks WHERE embedding IS NOT NULL`). Причина: индексация прошла со сломанной моделью. Решение: нажать Index повторно.
- **"Одинаковые результаты в выдаче"** → форкнутые сессии. См. "Дубликаты из форкнутых сессий".
- **"Indexing зависает"** → rate limit Gemini API. Уменьшить лимит сессий в настройках.
- **"Не скроллится страница Home с результатами"** → контейнер ProjectHome требует `h-full` вместо `flex-1` для работы `overflow-y-auto` внутри `absolute inset-0` обёртки.
