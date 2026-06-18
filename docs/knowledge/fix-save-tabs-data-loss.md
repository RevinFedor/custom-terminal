# Fix: saveTabs() Destructive DELETE-ALL Pattern

## Проблема

`saveTabs()` в `database.js` использовал деструктивный паттерн:
```sql
DELETE FROM tabs WHERE project_id = ?   -- убивает ВСЕ табы проекта
INSERT INTO tabs (...)                  -- вставляет только то, что в workspace.tabs Map
```

Если в момент вызова `saveTabs()` in-memory Map (`workspace.tabs`) не содержал часть табов — они **навсегда стирались из БД**. Функция вызывается из множества мест: `createTab`, `closeTab`, `reorderTabs`, `setClaudeSessionId`, `markAllSessionsInterrupted`, `closeProject`.

### Инцидент (Production, 2026-03-03)
В проекте hh-tool за сессию было создано 11 субагент-табов (tab-42..tab-54) через MCP-делегацию. После инцидента в БД осталось только 2 (tab-53, tab-54). Остальные 9 + 3 восстановленных при старте — стёрты.

**Причина:** Race condition или неполный Map на момент одного из вызовов `saveTabs` привёл к тому, что DELETE ALL снёс табы, которых не было в текущем снимке Map.

## Решение: Safe 4-Step Pattern

```
Step 1: DELETE FROM tabs WHERE tab_id = ?        -- удаляем ТОЛЬКО те, что перезаписываем
Step 2: DELETE FROM tabs WHERE tab_id IS NULL     -- чистим legacy-строки без tab_id
Step 3: INSERT INTO tabs (...)                    -- вставляем все табы из Map
Step 4: DELETE WHERE tab_id NOT IN (new_set)      -- ТОЛЬКО если count стабилен (diff <= 2)
```

### Safety Guard (Step 4)
Если количество табов в новом сохранении значительно меньше, чем в БД (разница > 2):
- **Удаление пропускается** — "осиротевшие" табы сохраняются в БД
- Логируется `[ERROR]` с подробностями для диагностики
- Warning log при любом подозрительном уменьшении количества табов

Диагностика guard'а должна показывать не только counts, но и идентичность строк: incoming tab ids, краткий summary входящих табов и `dbOnly` строки, которые есть в SQLite, но отсутствуют в in-memory Map. Если warning появился во время restore/startup, сначала расследуй почему Map неполный; не добавляй `forceCleanup`, пока не доказано что `dbOnly` — intentional удаление, а не потерянные вкладки.

### Почему порог = 2
Нормальные операции (закрытие 1-2 табов) не должны блокироваться. Потеря 3+ табов за один вызов — аномалия, требующая расследования.

### forceCleanup Flag
Для intentional batch-операций (перенос 3+ табов между проектами, массовое закрытие) Safety Guard можно обойти через параметр `forceCleanup: true`:
- `saveTabs(projectId, tabs, true)` — принудительно выполняет Step 4 cleanup
- Используется в `moveTabsToProject` и batch close (`closeTab` с `{ forceCleanup: true }`)
- Исключение из старого правила: намеренное закрытие **последней** вкладки проекта тоже должно идти с `forceCleanup`, потому что новый set пустой и SQL `NOT IN (new_set)` физически не из чего собрать. Без этого in-memory проект выглядит пустым, но старая строка остаётся в SQLite и после fresh start вкладка возвращается. Проверочный симптом: после `POST /api/terminal-tabs/:tabId/close` endpoint `/api/projects/:id/tabs` показывает `0`, а прямой `select count(*) from tabs where project_id=?` остаётся `1`.
- **Не** передавай `forceCleanup` из restore/startup/частичных background snapshots. Single-tab close с оставшимися вкладками остаётся обычной операцией; force нужен только когда после намеренного удаления `workspace.tabs.size === 0` или это явный batch.

## Файлы
- `src/main/database.js` — метод `saveTabs()` (~line 470)
- `src/main/project-manager.js` — прокси `saveProjectTabs()` с `forceCleanup`
- `src/renderer/store/useWorkspaceStore.ts` — все места вызова `saveTabs()`

## Правило
> **Никогда не используй `DELETE ALL + re-INSERT` для данных, которые могут быть неполными в памяти.**
> In-memory Map может не содержать все записи из-за race conditions, багов восстановления или параллельных IPC.
> Всегда удаляй только то, что точно знаешь — через targeted DELETE по конкретным ID.
