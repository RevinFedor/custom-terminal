# Fix: Gemini Timeline & History Sync (Stable UUIDs)

## Проблема
Timeline (точки справа) и HistoryPanel (текст истории) для Gemini отображали рассинхронизированные данные. При скролле панели истории точки в Timeline не подсвечивались (не превращались в «черточки»).

### Причина: Нестабильные UUID
Gemini-сообщения часто не имеют встроенного `id` в файлах сессий. В коде использовался fallback: `msg.id || crypto.randomUUID()`.
Поскольку Timeline и HistoryPanel запрашивают данные через **разные** IPC-вызовы, каждый вызов генерировал свой набор случайных UUID. 
- Timeline: `user-msg -> uuid-abc`
- History: `user-msg -> uuid-xyz`
- **Результат:** `historyVisibleUuids` никогда не находили соответствия в Timeline.

## Решение: Deterministic Fallback
UUID теперь генерируется на основе позиции сообщения в файле, что гарантирует стабильность между разными вызовами.

```javascript
const stableUuid = msg.id || `${sessionId}-msg-${i}`;
// i — индекс в оригинальном массиве data.messages
```

### Критическое условие (Invisible Intent)
Индекс `i` должен считаться по **полному** массиву сообщений из JSON-файла, а не по отфильтрованному списку. Это необходимо, потому что:
- Timeline видит только сообщения типа `user`.
- HistoryPanel видит `user` + `gemini` (assistant).
Если считать индекс по отфильтрованным спискам, позиции одного и того же сообщения разойдутся, и UUID снова перестанут совпадать.

## Связанные файлы
- `src/main/main.js` — хендлеры `gemini:get-timeline` и `gemini:get-full-history`.
- `knowledge/fact-timeline.md` — логика подсветки точек.
