# Fix: Critical Performance Lags (Render Storm & Main Block)

### Симптомы
- **UI Freeze:** Интерфейс замирает на 3-4 секунды каждые 2 секунды (в такт поллинга Timeline).
- **Laggy Tabs:** Заметная задержка (до 1с) при переключении между вкладками терминала.
- **Startup Noise:** При запуске приложения вентиляторы компьютера начинают шуметь, а окно появляется с большой задержкой.
- **Data Loss Warning:** В логах появляются ошибки о блокировке `saveTabs` защитным механизмом (Safety Guard).

---

## 1. Проблема: Блокировка Main Thread (Large JSONL I/O)

### Суть
Алгоритм построения Timeline (`resolveSessionChain`) при каждом тике (2с) заново читал файлы сессий Клода с диска через `fs.readFileSync`. 
- При размере файла >100MB парсинг десятков тысяч строк JSON занимал 3.5+ секунды.
- Поскольку чтение было синхронным и происходило в Main-процессе, событийный цикл Electron полностью блокировался. UI не мог обрабатывать клики и переключения табов.

### Решение: Async Incremental Reader
Система переведена на событийную асинхронную модель с кешированием.
1. **mtime/size Cache:** Перед чтением проверяются метаданные файла. Если `mtime` и `size` не изменились — данные берутся из памяти мгновенно.
2. **Incremental Parsing:** Если файл вырос, система не читает его целиком. Она считывает только новые байты, начиная с последнего известного смещения (`offset`).
3. **`leftover` Buffer:** Для обработки ситуации, когда файл обрывается на середине JSON-строки, используется буфер остатков. Неполная строка склеивается с началом следующего чанка.
4. **Async + chunked I/O:** Async API не блокирует event loop на самом disk-read, но `fs.promises.readFile(file, 'utf8')` всё ещё создаёт одну огромную V8-строку. На live Codex rollout 582+ MB холодный путь падал с `RangeError: Invalid string length`. Первое чтение и rewrite для таких файлов должны идти chunked line-reader'ом; подробнее — [`fact-transcript-сервис.md::Codex incremental cache`](fact-transcript-сервис.md).

## 1b. Freeze при закрытии Claude-вкладки: archive-path читал JSONL целиком

### Симптомы
- Юзер закрывает Claude-вкладку, а приложение "подвисает" на 1-3 секунды, хотя процесс уже вроде бы наоборот должен умирать.
- Эффект сильнее на старых длинных сессиях и особенно заметен на production с несколькими параллельными Claude-вкладками.
- В логах close-path уже начался, но следующий UI-шаг запаздывает; на больших сессиях auto-index после close может тянуться десятки секунд.

### Корневая причина

Проблема оказалась не в renderer-close логике, а в синхронной работе main-процесса **после** `project:archive-tab`.

1. Архивирование tab-history делало не только быстрый `INSERT`, но и тут же:
   - `parseTimelineUuids(sessionPath)` с `fs.readFileSync`;
   - второй полный `fs.readFileSync(sessionPath, 'utf8')` + `JSON.parse` всех строк ради `message_count`.
2. Затем стартовал semantic auto-index "fire-and-forget", но это был ложный комфорт: внутри `indexSessionFile()` до первого `await` синхронно считались `fileHash(filePath)` и полный чанкинг JSONL. Для main thread это всё ещё блокировка close-жеста, даже если promise никто не await'ит.
3. В production попалась закрытая Claude-сессия размером ~165MB. На таком размере даже "один лишний readFileSync на закрытии" превращает жест close в заметный фриз.

Ключевой урок: **fire-and-forget не спасает, если тяжёлая работа начинается синхронно до первого `await`**.

### Исправление

Close-path разделён на быстрый и фоновый слои:

1. `project:archive-tab` теперь делает только быстрый `archiveTab()` в SQLite и сразу возвращает `historyId`.
2. Всё тяжёлое вынесено в отложенные side-effects:
   - `message_count` считается через `readline`-streaming проход по JSONL спустя 1 секунду;
   - для файлов больше 256MB count вообще пропускается, чтобы не создавать новый freeze-class;
   - semantic auto-index стартует только спустя 5 секунд после close;
   - для файлов больше 5MB auto-index на close **сознательно пропускается** (`reason=avoid-close-freeze`), остаётся ручной Index.
3. Добавлены perf-логи close-path'а: `[CloseTab]`, `[Archive:Close]`, `[Archive:Count]`, `[SemanticSearch:AutoIndex]`, `[SaveTabs:Perf]`.

### Почему skip > 5MB лучше, чем "индексировать всё любой ценой"

Закрытие вкладки — это latency-sensitive жест. Юзер ожидает, что UI исчезнет сразу; индекс можно достроить позже или вручную. Поэтому для больших transcript'ов правильнее потерять "мгновенную автоиндексацию" чем повторно втащить тяжёлый синхронный JSONL parse в main thread и подвесить всё приложение. Эта граница относится именно к close-path; ручной Index в Home по-прежнему остаётся полным путём для больших архивов.

---

## 1c. Freeze при открытии Home: `search:stats` сканировал embeddings

### Симптомы
- Пользователь нажимает Home и может даже не кликать обратно: hover на табах/карточках перестаёт реагировать на 2-4 секунды, macOS показывает системный beachball.
- После первого зависания повторные переходы Home → tab иногда становятся быстрее, что создаёт ложное ощущение “прогрелся Home render”.
- Tab switch handler сам по себе быстрый: когда click наконец доставлен, `[Perf:TabSwitch]` и `Frame2` укладываются в десятки миллисекунд. Задержка происходит **до** handler'а или в main-process IPC рядом с Home mount.

### Доказательство из логов

Ключевая сигнатура в production 2026-06-12:
```text
[Watchdog] STALL proc=main silentMs=514
[Watchdog] SAMPLING proc=main silentMs=1019
[Perf:IpcSlow] channel=search:stats durMs=4101.6
[Perf:MainLoopGap] gapMs=4200.0 ... ipcAgg5s=search:stats:n=1:sum=4102:max=4102
```

Рядом с этим `ProjectHome.statusSync` и `project:get-tab-history` уже завершились быстро, а `search:stats` закончил ровно в конце main-loop gap. Это важно: до универсальной IPC-обвязки такой freeze выглядел как `activeOps=0`, и подозрение уходило в Timeline, Home render или системную нагрузку.

### Корневая причина

`SemanticSearchSection` монтируется внутри Project Home и сразу вызывает `search:stats`. В `getIndexStats()` один из запросов был:
```sql
SELECT COUNT(*) FROM session_chunks WHERE embedding IS NOT NULL
```

На реальной dev DB было ~87K `session_chunks`, ~19K embeddings и план:
```text
SCAN session_chunks
```

`better-sqlite3` выполняет этот `COUNT` синхронно в main process. Даже если renderer выглядит “просто ждёт Home”, на самом деле весь Electron main-loop стоит внутри SQLite full-scan по BLOB-heavy таблице.

### Исправление

Добавлен partial index:
```sql
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_present
ON session_chunks(id)
WHERE embedding IS NOT NULL;
```

После создания индекс меняет план на `SCAN session_chunks USING INDEX idx_chunks_embedding_present`, и `search:stats` перестаёт попадать в slow IPC / MainLoopGap при обычном Home mount. Не удалять этот индекс как “избыточный”: он не про search ranking, а про отзывчивость Home.

### Диагностика регрессии

Если снова появляется “Home открылся, но hover/клики умерли”, проверка первая:
```bash
grep -E "search:stats|Perf:MainLoopGap|Watchdog|HomeCommit|HomeStatusSync" \
  ~/Library/Logs/noted-terminal/production.log | tail -80

sqlite3 "$HOME/Library/Application Support/noted-terminal/noted-terminal-dev.db" \
  "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM session_chunks WHERE embedding IS NOT NULL;"
```

Если план снова `SCAN session_chunks`, root cause найден. Если `search:stats` быстрый, не обвинять Semantic Search по инерции — дальше смотреть `ipcAgg5s`, `recentOps5s`, renderer long tasks и watchdog sample.

---

## 1d. Renderer замерзал на 750мс: sendSync в зеркале localStorage

### Симптомы
- При переключении вкладки «блокируется ВСЁ приложение» ~1с: ховер соседней вкладки, состояние курсора (нажат→отпущен), фоновые эффекты — всё с задержкой 200-900мс.
- Freeze-атрибуция бессильна: LongTask идёт `during=none-marked` или приписывается чужой метке — блок сидел ВНУТРИ коммита React, а не в рендере.
- CPU-профиль: сотни мс self-time в `invoke → sendSync → Storage.setItem` под `commitHookEffectListUnmount`.

### Причина
Зеркало localStorage→SQLite (`persistedStorage.ts`, monkey-patch `Storage.prototype.setItem`) делало КАЖДУЮ запись `noted-terminal-*`-ключа синхронным IPC (`sendSync('app:mirrorLocalStorageSync')`). Синхронный IPC паркует **renderer** до ответа main. Cleanup-эффект композера при свапе владельца пишет draft в localStorage → renderer встал на 746мс, потому что main в этот момент занят IPC самого свапа + git:status (792мс). Тот же класс — сохранение ширины/раскрытия панели плана задач на клике. Контринтуитивная часть: виноват не тот, кто долго работает (main делал легитимную работу), а тот, кто синхронно ЖДЁТ — и ждущий был в фазе коммита React, где браузер не обрабатывает ввод вообще.

### Решение
Рантайм-записи зеркала → async `send` (main-обработчик `ipcMain.on` обслуживает оба вида; порядок сохранён — один канал FIFO). Durability при закрытии окна — заменой, не потерей: `pagehide`-replay синхронно пересылает финальное значение каждого затронутого за сессию ключа (набор `dirtyMirrorKeys`). Проверено: burst из 5 записей — в SQLite финальное значение; запись прямо перед reload переживает его; удаление ключа доезжает.

**HMR для такого фикса небезопасен**: старый sendSync-патч остаётся в цепочке `Storage.prototype` — только полный перезапуск dev.

### Правило
`sendSync` в renderer допустим ТОЛЬКО в shutdown-путях (beforeunload/pagehide), где блокировка корректна по смыслу. Любой sendSync в горячем пути (эффекты, обработчики кликов, cleanup) = замороженный UI ровно тогда, когда main занят — то есть в худший момент.

---

## 1e. get-presence синхронно парсил 59MB на каждый tab switch

### Симптомы
- Виснет ТОЛЬКО одна вкладка (с самой большой сессией) при переключении НА неё; остальные летают.
- `[Perf:MainLoopGap] gapMs=1046 activeOps=0` + `[Watchdog] STALL main` точно в момент свапа; по 3 вызова `claude:get-presence durMs=318-335` за одно переключение.

### Причина
`getSessionMaterialization` отвечает на почти булев вопрос («есть ли в timeline хоть одна запись?») через `parseTimelineEntries` = `fs.readFileSync` всего JSONL + построчный `JSON.parse` — синхронно в main. `claude:get-presence` зовёт её на каждый статус-опрос, а опрос стреляет несколько раз за свап. На 59MB это сотни мс × 3 = секунда стоящего main. `activeOps=0` при gap — то же свойство, что в §1c: sync-работа заканчивается в тот тик, когда gap-таймер получает управление.

### Решение
Кэш по свидетелю (identity+mtime+size файла): ответ переиспользуется, пока файл байт-в-байт тот же; живая сессия инвалидирует его собственным ростом. LRU 32 сессии. Тот же паттерн «unchanged = O(stat)» применён к confirmed-settings, probe полной истории и timeline (см. `fact-история-производительность.md::Main-процесс`).

---

## 1f. Опрос состояния всех вкладок при каждом показе проекта

### Симптомы
- Показ проекта/Dashboard → main стоит 0.76-1.8с; в recentOps — десятки `terminal:getCommandState` и `codex:get-runtime-session` подряд.

### Причина и решение
Панель вкладок опрашивала состояние КАЖДОЙ вкладки отдельно при каждом показе проекта (44 вкладки = 44 запроса + запрос хода на каждую Codex-вкладку = 76-90 одновременных операций); то же делали Dashboard и корневой компонент по ВСЕМ открытым проектам (93 вкладки за проход). Это рецидив шрама «опрос статусов»: двухсекундный таймер однажды убрали, но опрос вернулся через другую дверь — не таймером, а «спросить всех при каждом показе». Решение — один пакетный запрос: один снимок процессов, последовательная обработка, смысл ответов не изменён (включая трёхзначный found/absent/unknown). Переведены все три места.

---

## 2. Проблема: Render Storm (Zustand Map Trap)

### Суть
В компонентах `App.tsx` и `TerminalArea.tsx` использовалась прямая подписка на объект `openProjects` (Map).
- В Zustand вызов `set({ openProjects: new Map(old) })` создает **новую ссылку** на Map.
- Даже если изменился цвет одной вкладки в одном проекте, все компоненты, подписанные на `openProjects`, инициировали полный ре-рендер своего дерева.
- В `TerminalArea` это приводило к пересозданию (Re-mount) десятков инстансов терминала при любом мелком событии (busy-статус, смена CWD).

### Решение: Fingerprint Selectors
Вместо подписки на весь объект Map, компоненты теперь используют гранулярные селекторы.
1. **Primitive Keys:** Селектор возвращает строку-отпечаток (например, список ID вкладок через запятую). Ре-рендер происходит только если состав вкладок реально изменился.
2. **Stable Selectors:** Тяжелые операции (например, рендеринг списка `Terminal`) теперь зависят от примитивных значений, а не от ссылок на Map.

### Селектор, возвращающий новый массив/объект каждый вызов → бесконечный ре-рендер

Симптом — `Maximum update depth exceeded`, профайлер показывает один и тот же компонент в петле. Причина: Zustand сравнивает результат селектора через `Object.is`. Любая операция, конструирующая новый массив/объект (`filter`, `map`, `Array.from`, `Object.values`, `Array.from(map.keys())`), возвращает новый instance на каждый вызов → `Object.is` всегда `false` → компонент считает что стейт изменился → ре-рендер → селектор снова создаёт новый массив → бесконечно.

Решений три, по убыванию надёжности. Самое надёжное — **primitive fingerprint**: селектор возвращает строку которая меняется только при реальном изменении состава.
```tsx
const fingerprint = useStore(s => s.items.map(i => `${i.id}:${i.status}`).join(','));
const items = useMemo(() => deriveItems(fingerprint), [fingerprint]);
```
Среднее — `useShallow` из `zustand/react/shallow` (поверхностное сравнение элементов):
```tsx
const ids = useStore(useShallow(s => s.items.filter(i => i.active).map(i => i.id)));
```
Худший вариант — подписаться на Map/Set целиком и потом фильтровать. Не делай так: обновление через `set({ map: new Map(get().map) })` создаёт новую ссылку — подписчики на весь Map ре-рендерятся при любом изменении любого ключа. Подписывайся только на нужные значения (`s => s.map.get(id)`) или на fingerprint состава ключей. См. anti-pattern «Zustand: Не подписывайся на Map целиком» в `CLAUDE.md` — это тот же паттерн под другим углом.

**Recurrence 2026-05-28: Run-after picker.** Селектор `useWorkspaceStore((state) => { /* walk projects, build tabs array */ return { projectId, activeTabId, tabs }; })` возвращал свежий объект на каждый рендер. `set({ openProjects: new Map(...) })` срабатывает на любое busy-событие в любом табе любого проекта → новая ссылка → re-render picker'а → селектор снова создаёт свежий `{projectId, activeTabId, tabs}` → loop → `Maximum update depth exceeded`. Фикс — fingerprint string из id+name AI-табов (только нашего проекта) + `useMemo([fingerprint, tabId])` для деривации shape через `useWorkspaceStore.getState()` внутри useMemo. См. `knowledge/fact-prompt-queue.md::Fingerprint Pattern в селекторе`. Урок: при подписке на nested Map (`openProjects.<projectId>.tabs`) **всегда** возвращай примитив, никогда — объект-результат итерации.

**Recurrence 2026-06-13: ProjectToolbar prompt-summary controls.** Симптом в production: при открытии приложения React показывал `Something went wrong / Minified React error #185`. Причина была не в Timeline summary store, а в `ProjectToolbar` selector'е к `useWorkspaceStore`: он каждый render возвращал новый объект `{ tabId, toolType, sessionId }` для активной вкладки. Даже без `map/filter` это тот же trap — Zustand сравнивает selector result по `Object.is`, object literal всегда новый, React 19 уходит в loop. Фикс: selector возвращает primitive key `${tabId}|${toolType}|${sessionId}`, а объект собирается рядом через `useMemo`. Правило распространяется и на "маленькие" selectors активного таба; свежий объект опасен не только при больших списках.

---

## 3. Проблема: O(n²) Startup Cascade

### Суть
Метод `restoreSession` восстанавливал вкладки по одной, вызывая `openProject` -> `createTab`.
- Каждый вызов `createTab` триггерил `set()` в сторе и `saveTabs()` в SQLite.
- При наличии 30 вкладок приложение выполняло 30 полных ре-рендеров всего дерева и 30 тяжелых транзакций к БД одновременно.

### Решение: `isRestoring` Flag
Введен флаг режима восстановления.
- В режиме восстановления `createTab` работает "тихо" (не вызывает `set` и не пишет в БД).
- Стейт обновляется один раз в конце процесса восстановления через `set({ isRestoring: false })`, что гарантирует ровно один ре-рендер для всей структуры вкладок.

---

## 4. Проблема: UI Freeze при загрузке тяжелых списков истории

### Суть
Эта секция фиксирует **исторический renderer-слой**: до виртуализации History Panel рендер 200+ entries мог блокировать renderer Main Thread на 1–2+ секунды. Сейчас History использует Virtuoso, поэтому для длинной Codex-сессии симптом «пустая Timeline, Electron вырос до гигабайтов» нельзя снова объяснять количеством DOM-rows. Текущая граница — eager parser/projection, IPC structured clone и retained snapshots; см. [`fact-transcript-сервис.md::Ресурсная модель большой сессии`](fact-transcript-сервис.md).

### Решение: React 19 `startTransition`
Использование встроенной функции `startTransition` из React 19 для разбиения (квантования) рендера:

```typescript
const [entries, setEntries] = useState([]);

// При загрузке истории:
startTransition(() => {
  setEntries(largeHistoryArray); // 200+ элементов
});
```

- **Поведение:** React теперь разбивает рендер на **несколько кадров** вместо одного. После каждого кадра браузер получает контроль обратно, позволяя обработать события и выполнить анимации.
- **GPU Layer:** При использовании `will-change: transform` и `transform`-анимаций спиннеры продолжают вращаться на **уровне композитора** (GPU layer), даже когда Main Thread занят reconciliation тяжелого DOM-дерева.
- **UX:** Пользователь видит **плавные анимации** вместо застывшего спиннера, что создает ощущение плавности и отзывчивости даже при загрузке сотен элементов.

`startTransition`, Virtuoso и GPU-layer оптимизируют presentation budget, но не уменьшают уже разобранный JSONL, full History payload и его копии. Тихое truncation тяжёлых tool-results не является допустимым memory-fix: оно отнимает inspect/copy capability.

**Progressive disclosure на data boundary — реализован (2026-07-25).** Пользовательский симптом «переключаюсь между большими сессиями — фриз; правый клик по вкладке открывается через 1-2с когда вкладка отвиснет» закрыт тремя слоями: (1) дегидрация — tool-output/thinking >16KB уходят из main превью+ссылкой, полный текст по раскрытию карточки (`history:get-tool-payload`), IPC clone и retained renderer state перестали расти с размером сессии; (2) tail-window холодного открытия — первый кадр гиганта это последние ~120 записей, полное — фоном; (3) якорь чтения + window-mini-cache — возврат в вытесненную сессию мгновенно показывает последний виденный фрагмент, а не loader. Все окна display-only (контракт rewind-префикса). Детали: `fact-transcript-сервис.md::Дегидрация тяжёлых payload`, `fact-история-как-основная-поверхность.md::Быстрый возврат`.

### GPU-ускорение для лоадеров
Лоадеры (спиннеры) используют трансформацию вместо анимации CSS:

```css
.spinner {
  will-change: transform;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

- **`will-change: transform`**: Информирует браузер, что элемент будет часто трансформироваться, и он должен создать отдельный compositing layer для этого элемента.
- **Результат:** Вращение спиннера обрабатывается на GPU и не зависит от Main Thread JavaScript. Даже если JS занят парсингом и рендером 200+ DOM-элементов, спиннер продолжает крутиться.

## Startup Black Screen: Batch Restore

**Симптом:** После `build:install` приложение запускается с чёрным экраном на 2-5 секунд, модалка "Сессия прервана" мелькает.

**Причина:** `restoreSession` вызывал `openProject()` в цикле (по одному на проект). Каждый `openProject` → `set({ openProjects: new Map() })` → Workspace ремаунтится. 5 проектов = 5 ремаунтов за 150ms. Между ремаунтами `activeTabId=undefined` → `EARLY_RETURN: Empty workspace` → чёрный экран.

**Решение:** `restoreSession` загружает ВСЕ проекты inline (мутация Map напрямую без `set()`), `createTab` пропускает `set()` при `isRestoring=true` (уже было). Один финальный `set()` со всеми проектами, табами, `activeProjectId` и `view`.

## Auto-Resume: React Batching Trap

**Симптом:** Auto-resume не срабатывает после restore — прерванные сессии показывают модалку вместо автозапуска.

**Отброшенные подходы:**
1. `setTimeout(3000)` — костыль, не детерминированно, PTY может не быть готов за 3с.
2. `useEffect([isRestoring])` — React batch'ит `set({isRestoring:true})` и `set({isRestoring:false})` из одного async `restoreSession()` → компонент **никогда не видит** промежуточное `true`. useEffect получает только `false → false`.
3. `useEffect` + `sawRestoringTrue` ref — тот же batching, ref никогда не ставится в `true`.

**Решение:** `useWorkspaceStore.subscribe()` — синхронный callback, вызывается на КАЖДОМ `set()`, не зависит от React render cycle. Ловит оба перехода: `isRestoring: false→true` (запомнить) и `true→false` (запустить auto-resume).

**Правило:** Для детекции state transitions в Zustand из async code, где промежуточные состояния могут быть batch'ены React'ом — использовать `subscribe()`, не `useEffect`.

## 5. Frozen Terminal: Z-index Race у "локальных" селекторов активности

### Симптом
- При переключении табов между проектами **Timeline обновляется корректно**, но содержимое xterm в правой части не меняется.
- Команды отправляются в правильный таб (PTY работает), но визуально пользователь видит **первый из табов, открытых при старте приложения** — он "заморожен" поверх.
- При прокрутке мышью скроллится именно он, не активный.

### Root Cause: каждый проект "claim" один таб
Чтобы убрать `activeTabId` из fingerprint в `TerminalArea` (см. секцию 6) и не пересчитывать список 40+ терминалов при каждом переключении, селектор активности был перенесён **внутрь** `Terminal`/`BrowserTab`/`ClaudeSDKTab`. Первая (сломанная) версия:

```tsx
const activeFromStore = useWorkspaceStore((state) => {
  for (const [, workspace] of state.openProjects) {
    if (workspace.tabs.has(tabId)) {
      return workspace.activeTabId === tabId;  // ❌ нет проверки активного проекта
    }
  }
  return false;
});
```

При 7 открытых проектах **каждый** проект имеет свой `activeTabId` (последний посещённый таб). Селектор возвращал `true` для всех 7 терминалов одновременно. Все 7 получали `zIndex: 1`, `visibility: visible` — и **первый в порядке DOM** перекрывал остальных.

### Решение
```tsx
return state.activeProjectId === projId && workspace.activeTabId === tabId;
```

Селектор обязан проверять **И** projectId, **И** tabId. Невидимый контекст: AI без этого комментария может в рефакторинге убрать `state.activeProjectId === projId &&` как "избыточный" — оба компонента и так подписаны на свой `tabId`.

Финальный контракт после прод-регрессии 2026-06: активность terminal-layer не должна жить только внутри `Terminal`/`BrowserTab`/`ClaudeSDKTab`. `TerminalArea` оставляет структурный fingerprint для mount/unmount, но отдельно подписывается на `activeLayerKey` (`view + activeProjectId + activeTabId + currentView + viewingSubAgentTabId`) и передаёт `active/isActiveProject` вниз props-ами. Это сохраняет xterm-состояние без remount, но не даёт старому проекту оставить в DOM `active=1 opacity=1` после перехода на другой проект.

### Регрессия-сигнал
В каждом Terminal в useEffect ведётся регистрация в модульный `_visibleTerminals: Set<string>`. После каждого изменения rAF-debounce проверяет инвариант "ровно 1 терминал visible":
```
[Terminal:VisibleSetInvariant] count=N expectedTab=... paintedTabs=[...]
```
- `count=1` — норма (логи не пишутся).
- `count=0` briefly допустим только во время transition; устойчиво или на active tab — регрессия, пользователь видит пустой/необновлённый центр.
- `count>=2` или expected-tab mismatch устойчиво ≥1 rAF — регрессия: виден лишний/не тот terminal layer, часто как старый `Process completed` поверх новой вкладки.

---

## 6. TerminalArea Fingerprint: Structural Only

### Проблема
До рефакторинга 2026-04-21 fingerprint содержал `${projId}:${workspace.activeTabId}` для **каждого** проекта. Любая смена `activeTabId` в **любом** проекте триггерила пересчёт `useMemo`, который создавал React-элементы для всех 40+ табов всех проектов. На каждый таб шёл `useEffect([effectiveActive])` → `[Terminal:deactivate]` × 13. Переключение проектов лагало.

### Решение
Fingerprint в `TerminalArea` остаётся **структурным**, но активная пара проект/таб теперь вынесена в отдельный `activeLayerKey` (см. секцию 5). Структурная часть:
```tsx
parts.push(projId === projectId ? `${projId}${hostActivePart}` : projId);
parts.push(`${tab.id}:${tab.tabType || 'terminal'}:${tab.activeView || ''}:${tab.terminalId || ''}`);
```
- `projId` других проектов — без `activeTabId`. Переключение там не задевает host.
- `tab.id` + `tabType` — для add/remove/retype. Если таб сменил тип `terminal → browser`, useMemo пересоберёт элементы (другой компонент).
- `activeView`/`terminalId` для browser-таба — это не project/tab switch, а смена собственной поверхности browser ↔ embedded terminal; её надо прокидывать в props, иначе внутренний терминал browser-таба получает stale `activeView`.

### Исключение: Sub-agent Override
`activeTabId` host-проекта попадает в fingerprint **только** когда `viewingSubAgentTabId` armed. Тогда useMemo вынужден пересчитать `activeOverride` для двух tab IDs (sub-agent → активен, parent Gemini → неактивен). В норме это редкий случай.

### Регрессия-сигнал
```
[TerminalArea:useMemo] RECALCULATING count=N projectId=... durMs=... (structural: add/remove/type/sub-agent)
```
- На переключение **между проектами** или **между табами одного проекта** может появляться из-за `activeLayerKey`, но без remount xterm: это нормально если `durMs` малый и `[Terminal:VisibleSetInvariant]` не показывает mismatch.
- Структурная часть fingerprint по-прежнему должна меняться только при создании/закрытии таба, смене tabType/activeView/terminalId, restore-error или sub-agent override. Не возвращать `activeTabId` всех проектов в structural fingerprint: это снова смешает «пересобрать список слоёв» и «поменять видимый слой».
- Если появляется на каждом TabBar:click — кто-то вернул `activeTabId` других проектов в fingerprint.

---

## 7. Reconciliation Trap: условный child уничтожает поддерево соседа

Симптом — открытие overlay'а или sidebar'а ломает соседний компонент: терминал перерисовывается с нуля, canvas мигает, теряются listener'ы. Поведение зависит от того, есть ли над компонентом условный child (`{flag && <Foo />}`) — если есть, при флипе флага сосед получает unmount+remount, не просто ре-рендер.

Причина — React сравнивает детей по позиции, если у них нет стабильных ключей. Условный child при включении/выключении сдвигает индексы соседей. React видит «на месте [N] теперь другой component type» и **уничтожает поддерево** (unmount + remount), не пытаясь сохранить state. Для тяжёлых компонентов (xterm, WebGL canvas, video) это означает потерянное состояние и заново инициализированный canvas.

Решение — stable indexing: условные children рендерятся **последними** среди соседей, их появление/исчезновение не сдвигает индексы остальных. Альтернатива — absolute positioning (`absolute inset-0` + z-index) для overlay'я: он физически в конце списка детей, но визуально перекрывает их (см. Layering Pattern в `methodology/сценарии-багов-design.md`). Стабильные `key` пропы для всех children тоже работают, но требуют дисциплины на каждом уровне иерархии.

---

## 8. Observability Toolkit (для будущих регрессий)

После рефакторинга 2026-04-21 в коде расставлены лог-теги, которые **не должны** появляться часто в нормальной работе. Каждый из них — сигнал конкретной регрессии.

Для freeze-разборов логи разных процессов должны сравниваться по абсолютным timestamp'ам, а не по локальному `performance.now()`: renderer пишет `performance.timeOrigin + now`, main — `nodePerformance.timeOrigin + now`. Если пользователь говорит «кликнул и 5 секунд ничего», сначала выровняй `[Perf:InputDelayContext]`, `[Perf:ProjectView/HomeAction]`, `[Perf:TabSwitchFrame2]`, `[Perf:MainLoopGap]` и `[RestoreSession]` по `*Abs` полям. Без этой корреляции легко перепутать позднюю доставку input event, React render freeze, main-process блокировку и обычный долгий IPC.

Для beachball/freeze недостаточно только in-process probe'ов: `[Perf:MainLoopGap]` и renderer EventTiming логируются **после** того как loop разморозился. Поэтому внешний `perf-watchdog.js` работает отдельным plain-node процессом: main шлёт heartbeat по fork IPC, renderer — напрямую в unix socket, чтобы замёрзший main не мог имитировать renderer-stall. При пропаже heartbeat watchdog пишет `[Watchdog] STALL`, а на macOS запускает `/usr/bin/sample <pid>` во время зависания. Это единственный слой, который ловит stack “в момент beachball”, а не реконструирует его постфактум.

`activeOps=0` в `[Perf:MainLoopGap]` больше не означает “ничего не работало”. Смотри рядом `recentOps5s=` и `ipcAgg5s=`: sync IPC может закончиться в тот же тик, когда gap-таймер наконец получил управление, поэтому активных операций уже нет, но агрегат показывает виновный канал (`search:stats:n=1:sum=4102:max=4102`). Для per-keystroke каналов (`terminal:input`, `log:renderer`, `terminal:resize`) подробный recent-ring намеренно не заполняется, иначе они вытесняют редкие тяжёлые операции; их видно через aggregate.

Тестовые логи из CDP/harness проверяй на `document.visibilityState`. Если окно hidden, Chromium может throttle'ить renderer так, что synthetic hover/input выглядит как многосекундная задержка без реального foreground freeze. Для пользовательского Home-lag доказательны только срезы где visibility `visible` или есть внешний watchdog stall main/renderer. CPU-профиль скрытого окна ещё обманчивее: rAF на паузе, отложенные свапы вообще не запускаются, профиль показывает чистый idle — «всё быстро» при неисполнившейся работе. Перед CDP-профилированием: `Page.bringToFront` + при необходимости `Page.setWebLifecycleState(active)` + проверка `visibilityState === 'visible'`.

Платформенная атрибуция long tasks бесполезна для своего кода: за двое суток все 898 длинных блокировок пришли `attribution=unknown` (включая одну на 14.2с) — same-origin работа схлопывается в «self». Поэтому приложение ведёт собственный короткий журнал активности (`rendererActivityTrail.ts`, `markRendererActivity('имя:'+tag)` → закрыть на следующем кадре), и freeze probe стампует каждый LongTask списком работ, шедших одновременно (`during=`). Незакрытая метка помечается `(open)` — это самый сильный подозреваемый, не то, что прятать. Это диагностический след, не сигнал управления: на него ничто не завязано. Метки стоят на горячих путях: `tab-switch:`, `history-owner-mount:`, `history-load:`, `history-mount-wave:`, `timeline-swap:`, `timeline-expand:`, `controlbar-rebind:`, `terminal-hydrate:`, `tab-status-sync:`. Ограничение читателя: `during=` означает «пересекается по времени», не «является причиной» — метка закрывается на следующем кадре, и чужая работа в том же кадре получает ту же пометку; при сомнении — CPU-профиль (см. `диагностика-логами.flow.md`).

| Тег | Норма | Регрессия |
|---|---|---|
| `[Perf:ProjectSwitch] durMs=N` | <50ms | >200ms = что-то синхронно блокирует main thread |
| `[Perf:TabSwitch] durMs=N` | <50ms | >150ms = TerminalArea пересчитывает useMemo |
| `[Terminal:VisibleSetInvariant] count=N` | не появляется (count=1 silent) | `count!=1` или expected-tab mismatch = виден лишний/не тот terminal layer; см. `fact-terminal-rendering.md::Персистентные слои` |
| `[TerminalArea:useMemo RECALCULATING]` | add/remove/type/activeLayerKey, durMs малый | высокий durMs или xterm remount на switch = fingerprint снова смешал структуру и видимость |
| `[Timeline:PollPaused] reason=...` / `[Timeline:PollResumed]` | 1:1 пары при visibility-changes | rогда poll не паузится при свёрнутом окне → 99% IPC впустую |
| `[DB:ForkCache] stats hit=X miss=Y` | hit:miss ≥ 100:1 | низкий ratio = cache invalidation слишком агрессивная или вызовы с разными sessionId |
| `[Spinner:DIAG]` | 0 в prod | если появилось в `~/Library/Logs/...` — gate за `isDev` сломан |
| `[Terminal:StateTransition]` | один на реальное изменение состояния | rate-limit ref-diff; если каждый рендер — диф сломан |
| `[Perf:MainLoop] maxMs=N elu=X` | не появляется или короткие spikes | main process event-loop заблокирован (sync IO, тяжёлый ps/JSONL parse, IPC handler) |
| `[Perf:EventLoopLag] source=raf/timer` | не появляется в обычном клике | renderer event-loop freeze; если есть без `[Perf:MainLoop]`, ищи React/render/layout, не main IPC |
| `[Perf:Input]` / `[Perf:EventTiming]` | inputDelay <50ms, handler <50ms | клик доходит поздно или handler/presentation задержан; полезно для «кликаю Home и ничего» |
| `[Perf:HomeStatusSync]` | item <50ms, done быстро | `terminal:getCommandState` / Codex ps fallback тормозит Active-card status |
| `[Perf:GetCommandState]` + `[Perf:ProcessTreeLookup]` | редко >50ms | shell OSC state missing → fallback `ps -eo pid,ppid,command` дорогой или часто вызывается |
| `[Perf:TimelineLoad]` + `[Perf:TimelineIPC]` | poll не мешает interaction | Timeline reload/backtrace/filter/latest ест кадры; сравни renderer durMs и main breakdown |
| `[Perf:MainLoopGap] expectedAbs=... firedAbs=... recentOps5s=... ipcAgg5s=...` | не появляется | main event-loop реально не получил tick; `recentOps5s` и `ipcAgg5s` показывают IPC/DB/restore операции перед дырой |
| `[Watchdog] STALL/SAMPLING/SAMPLE-DONE` | не появляется при foreground idle | внешний процесс не получил heartbeat; если есть `SAMPLE-DONE`, открывай sample file и сверяй с `MainLoopGap` |
| `[Perf:InputDelayContext] inputDelayMs=N eventTimeAbs=...` | не появляется или <120ms | браузер получил пользовательский input поздно; сравни соседние RAF/timer samples — если там нет gap, ищи delivery/focus/OS-слой, а не React handler |
| `[RestoreSession] ... restoreId=...` | один связный набор на cold restore | пропали/задержались табы при restore; `liveMapPatched=true` означает что captured `openProjects` Map устарел и был заменён live-state перед commit |
| `[DB] saveTabs: WARNING ... incoming=[...] dbOnly=[...]` | не появляется | in-memory workspace меньше SQLite; `dbOnly` строки нельзя чистить без intentional `forceCleanup`, сначала расследуй restore/store race |

### Команды для быстрой диагностики
```bash
# "Замороженный" терминал?
grep "Terminal:VisibleSetInvariant" ~/Library/Logs/noted-terminal/production.log | tail -10

# Тормозит переключение?
grep -E "Perf:(Project|Tab)Switch" ~/Library/Logs/noted-terminal/production.log | \
  awk -F'durMs=' '{print $2}' | awk '{print $1}' | sort -rn | head -10

# Cache не работает?
grep "DB:ForkCache" ~/Library/Logs/noted-terminal/production.log | tail -3

# Home/Timeline freeze: где стоит время?
grep -E "Perf:(Home|ProjectView|TabSwitch|GetCommandState|ProcessTreeLookup|Timeline|EventLoopLag|Input|MainLoop)" \
  ~/Library/Logs/noted-terminal/production.log | tail -80

# Home + Semantic Search freeze: stats full-scan?
grep -E "search:stats|Watchdog|Perf:MainLoopGap|HomeCommit|HomeStatusSync" \
  ~/Library/Logs/noted-terminal/production.log | tail -80
```

---

## 9. Кумулятивная CPU-нагрузка при 6+ Claude-сессиях (апрель 2026)

### Симптомы
- `kernel_task` 200%+ CPU, `mDNSResponder` под 65%, несколько `node` процессов по 60% каждый.
- Нагрузка не спадает даже после остановки всех Claude-процессов (thermal throttling уже включился, нужно остыть).
- Проблема появилась после добавления Terminal MCP (output buffer в onData).

### Корневая причина: соломинка, сломавшая верблюда
6 сессий × backtrace каждые 2с × ~1700 records с `unshift()` = O(n²) на каждый poll. Плюс новый `terminalOutputBuffer` добавил `data.split('\n') + Array.splice(0, excess)` в onData для всех 15+ табов (~750 операций/сек). Кумулятивная нагрузка перевела CPU в thermal throttling — `kernel_task` забирает себе фантомные циклы чтобы замедлить остальных.

### Решения

**Timeline Backtrace Cache (`_timelineCache`):** Если `lastRecord.uuid` и `recordMap.size` не изменились — возвращается кешированный результат. При idle (Claude не пишет) — 0 пересчётов вместо 30/мин на сессию. Инвалидируется при cache recovery (`_jsonlCache.clear()`).

**O(n) сборка backtrace:** `activeBranch.unshift()` (O(n) на каждую вставку × n элементов = O(n²)) заменён на `push()` + финальный `reverse()` (O(n) суммарно). Применено только в `claude:get-timeline` (горячий путь). Остальные 4 handler'а (fork, export, edit-range, full-history) вызываются по действию пользователя — O(n²) для них некритичен.

**Circular buffer для Terminal MCP:** `push() + splice(0, excess)` заменён на ring buffer с O(1) записью на строку. Подробнее: [`fact-terminal-mcp.md`](fact-terminal-mcp.md).

---

## См. также
- [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) — детали инкрементального чтения.
- [`fact-timeline.md`](fact-timeline.md) — оптимизация поллинга.
