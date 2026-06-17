# Data Persistence — schema, debounce, project identity

SQLite-схема приложения, философия «проект как сущность», стратегия debounce для записи в БД. Только реальные persistence-факты — без пересечений с другими файлами.

**Связано:**
- `fix-tab-persistence.md` — шрам ID-стабильности табов при restore.
- `fix-tailwind-dynamic-runtime.md` — отдельный шрам про Tailwind (не про БД).
- `fix-save-tabs-data-loss.md` — safety guard и targeted DELETE.
- `fact-tabs.md` — Tab History, Multi-Tab DnD, LRU navigation.

---

## Project — сущность, не путь

Раньше проект определялся **исключительно путём** на диске. Архитектурный тупик: нельзя было открыть одну и ту же папку дважды с разными контекстами (наборами вкладок, чатами). БД схлопывала данные при совпадении путей через `UNIQUE(path)`.

**Что изменилось:**
- Проект — это уникальная личность (instance) с собственным UUID.
- `path` — атрибут (метаданные), как имя или цвет.

**Реализация:**
1. **Миграция БД**: удалён `UNIQUE` индекс с колонки `path` в `projects`. Теперь несколько записей с одинаковым путём, но разными UUID и метаданными.
2. **ID generation**: `base64(path).substring(0, 20) + timestamp + random_suffix` — уникальность даже при одновременном создании двух проектов одной кнопкой.
3. **Метод `createProjectInstance`** в `project-manager.js`: проверяет существующие проекты по пути, генерирует имя с суффиксом (`my-project-1`, `my-project-2`), создаёт новую запись.

**Что юзер получает**: множество независимых рабочих сред из одной папки. Каждая среда имеет свои табы, цвета, AI-сессии, заметки. Они не пересекаются.

---

## Системный проект Inbox

`Inbox` — реальный project record со стабильным id, но не обычный пользовательский проект. Он нужен как default workspace для API-созданных agent-вкладок и вкладок без выбранного проекта: вся обычная инфраструктура tabs/groups/history/status продолжает работать через project identity, а внешнему клиенту не нужно заранее выбирать контейнер. Его path — рабочий cwd по умолчанию (`NOTED_INBOX_CWD` или HOME), имя/описание фиксированы, delete/rename/update как у обычного проекта блокируются или игнорируются. Это намеренный database-level контейнер, а не отдельный transient UI-state.

---

## Placeholder paths для empty projects

В **старых production** БД колонка `path` имела `UNIQUE`. После миграции это снято, но runtime-логика создания «пустого» проекта без выбранной папки всё ещё страдала бы при попытке вставить вторую пустую строку (`''`).

**Решение:**
- Пустые проекты создаются с путём `__unset__new_project_{projectId}` (уникальный с UUID).
- **UI filter**: в `ProjectCard` и `Workspace` пути, начинающиеся с `__unset__`, отображаются как `"No path"`.
- **CWD fallback**: при создании таба `useWorkspaceStore` проверяет путь — если placeholder, `cwd` терминала ставится в `process.env.HOME`.

---

## Debounced Persistence — disk & IPC optimization

Частые IPC-вызовы к БД и LocalStorage при каждом клике/переключении таба вызывали микро-фризы. Стратегия отложенного сохранения:

| Что | Куда | Debounce |
|---|---|---|
| Session state (current view, sessionIds) | SQLite `app_state` | 300мс |
| Tab metadata (color, name, commandType) | SQLite `tabs` через `project:save-tabs` | 500мс |
| `wasInterrupted` flag | JSON-метаданные табов | 500мс |
| Emergency save (beforeunload) | SQLite | синхронный `ipcRenderer.sendSync` |

**Emergency save**: на `beforeunload` используется `sendSync` вместо `invoke` — гарантия записи до закрытия окна, даже при ценой UI-блока на 50мс.

### Safe saveTabs — targeted DELETE + INSERT
Метод `saveTabs` использует **точечный DELETE по `tab_id`** вместо `DELETE ALL + re-INSERT`. Защита от потери данных если in-memory Map неполный (race conditions, параллельные IPC). Для batch-операций (перенос 3+ табов, массовое закрытие) флаг `forceCleanup` обходит safety guard. Детали: [`fix-save-tabs-data-loss.md`](fix-save-tabs-data-loss.md).

### Transaction safety для global commands & prompts
Методы `saveGlobalCommands()` и `savePrompts()` обёрнуты в `db.transaction()` с **empty-array guard**: если передан пустой массив при наличии данных в БД, удаление блокируется и логируется. Защита от потери пользовательских данных из-за багов рендерера (например, racy initial state до hydration).

---

## Xterm serialization при unmount

`<Workspace />` размонтируется при переходе на Dashboard → инстансы `xterm.js` уничтожаются с компонентами. PTY-процесс остаётся жив, но визуальный буфер пропадает.

### Сохранение
В `Terminal.tsx`, в cleanup-функции `useEffect`:
```ts
const serialized = serializeAddon.serialize();
if (serialized) saveTerminalBuffer(tabId, serialized);
```
Данные хранятся в `useWorkspaceStore` в `Map<string, string>` (key = `tabId`).

### Восстановление
При mount компонента, сразу после `xterm.js` init:
1. Если буфер есть → `term.write(savedBuffer)`.
2. После записи — `clearTerminalBuffer` (не занимать память).
3. После восстановления — проигрывается `pendingBuffer` (данные от PTY, пока был unmounted).

### Почему не `display:none`/`visibility:hidden`
1. **xterm.js чувствителен к размерам контейнера**: скрытие через CSS даёт `0×0` → ломаются внутренние индексы строк.
2. **React lifecycle**: глобальная навигация через смену `view` в стейте — это семантически смена страниц (unmount old, mount new), а не «спрятать».

**Открытая проблема**: между unmount и mount данные от PTY теряются (нет listener'а). См. `fix-terminal-jitter.md::Открытая проблема — потеря PTY-данных при unmount`.

---

## SQLite schema — favorites

```sql
CREATE TABLE favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  name TEXT, cwd TEXT, color TEXT, notes TEXT,
  command_type TEXT, tab_type TEXT DEFAULT 'terminal',
  url TEXT, claude_session_id TEXT, gemini_session_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

- **Project-specific**: избранные привязаны к `project_id` через FK (`ON DELETE CASCADE` — удаление проекта чистит favorites).
- **AI Integration**: `claude_session_id` / `gemini_session_id` сохраняются → восстановление чата одним кликом из Home View.
- **Independence**: restore из избранного создаёт **новый** таб. Исходная запись `favorites` не меняется.

## SQLite schema — `timeline_notes`

Пользовательские аннотации к сообщениям Claude/Gemini.

**Columns:** `id`, `entry_uuid`, `session_id`, `tab_id`, `content`, `position`, `created_at`, `updated_at`.

**Position column** (добавлена март 2026, `ALTER TABLE`):
- `before` — над точкой timeline (default)
- `dot` — на самой точке
- `after` — под точкой

**Unique constraint:** `UNIQUE(entry_uuid, session_id)` — одна заметка на сообщение в рамках сессии.

---

## Runtime-only поля таба (НЕ персистятся)

Эти поля живут только в `Tab` interface в памяти, не пишутся в SQLite:
- `claudeActive`, `claudeBusy` — process state.

После рестарта сбрасываются к default. Это намеренно — они отражают **живое состояние процесса**, не его конфигурацию. `claudeBusy` восстановится сам, как только Claude напишет в PTY.
