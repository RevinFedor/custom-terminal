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
Кэш хранит доказательство «сессия уже непустая». Совпавшие path+size+mtime отвечают из памяти; mtime-only touch при том же размере не отменяет уже доказанную непустоту; append тоже остаётся O(stat), а точное число строк пересчитывается не чаще одного раза на 32 MiB роста. Shrink/path change проходит честный parse. LRU поднят с 32 до 512: при 45 открытых вкладках прежний лимит давал круговое вытеснение и три последовательных обхода `45/45/45` полных чтений без единого прогретого hit. Запись кэша стоит сотни байт, поэтому рабочий набор должен помещаться с запасом. Тот же паттерн «unchanged = O(stat)» применён к confirmed-settings, probe полной истории и Timeline (см. `fact-история-производительность.md::Main-процесс`).

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

**Recurrence 2026-06-13: prompt-summary controls верхней полосы** (тогда `ProjectToolbar`, теперь `WorkspaceTitleBarTools`). Симптом в production: при открытии приложения React показывал `Something went wrong / Minified React error #185`. Причина была не в Timeline summary store, а в selector'е к `useWorkspaceStore`: он каждый render возвращал новый объект `{ tabId, toolType, sessionId }` для активной вкладки. Даже без `map/filter` это тот же trap — Zustand сравнивает selector result по `Object.is`, object literal всегда новый, React 19 уходит в loop. Фикс: selector возвращает primitive key `${tabId}|${toolType}|${sessionId}`, а объект собирается рядом через `useMemo`. Правило распространяется и на "маленькие" selectors активного таба; свежий объект опасен не только при больших списках.

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

### Решение: mount wave и progressive disclosure на границе данных

`startTransition` не дробит работу внутри одного гигантского компонента. Он только меняет приоритет update; один render/commit с несколькими тяжёлыми Markdown/diff-карточками остаётся одним неразрывным блоком. Текущая History сначала монтирует лёгкие оболочки точной сохранённой высоты, затем повышает по одной строке и выдаёт следующий шаг только после layout-effect подтверждения предыдущего commit. Без commit-ACK React склеивал несколько transitions обратно в один тяжёлый кадр.

Вторая граница — payload, который вообще попадает в renderer. Tool-output/thinking больше 16 KiB приезжают как preview+детерминированная ссылка и догружаются по раскрытию; полный позиционный список History сохраняется, но строки вне читаемого диапазона становятся identity-stubs. Это не тихое truncation: inspect/copy capability остаётся через detail endpoint, UUID-порядок и scroll-геометрия не меняются.

Старые `tail-window`/`reading-window`, где короткий массив затем подменялся полным, удалены: parse они почти не ускоряли, зато создавали тёмный кадр, прыжок viewport и обход viewport-proof. Их нельзя описывать как действующую оптимизацию. Допустимая оконность сейчас меняет только payload строк внутри полного списка; rewind-префикс остаётся отдельным display-only исключением с exact writer proof. Детали: `fact-transcript-сервис.md::Ресурсная модель большой сессии`, `fact-история-производительность.md::Оконная выдача истории`.

### OOM на гигабайтном Codex compact: parsed presentation не равен raw persistence

Прод 19.08: main вырос примерно с 2.0 до 3.6 GiB и завершился `FatalProcessOutOfMemory`. Rollout 1340 MB состоял главным образом из 64 recursive `compacted` records; 1236 MB занимали повторённые inline base64-картинки, которые UI всё равно заменял на `[image omitted]`. LRU по числу файлов не защищает от одного oversized parse.

Ремонт отбрасывает image data URL внутри `compacted` в сырой строке до `JSON.parse`; обычные user-image остаются. На том же файле дополнительная память разбора снизилась примерно с 1725 до 532 MB при одинаковом числе records. Отдельный disk-size guard отказывает файлу, который остаётся неподъёмным даже после этой границы, и пишет caller в лог.

Контринтуитивный шрам: parsed/UI object нельзя использовать как payload для Fork/Edit/Delete. Первая версия записала `[image omitted]` в child и сделала его не-resumable. Write-path теперь потоково возвращает точный raw data URL по byte range + SHA-256 и fail-closed при source-CAS mismatch. Экономия памяти разрешена presentation-слою, но не переписывает durable source. См. `fact-codex.md::Timeline и History`.

### OOM при подготовке catalog search

Новый17Oct19:16:21UTC (18Oct02:16BKK) — установленный Main57334 завершился
`SIGABRT/FatalProcessOutOfMemory` при создании two-byte string; IPS faulting
native thread176, не UI thread0. Его соответствие логическому History worker1
не доказано. Последний завершённый worker catalog read605/603 имел phase snapshot
heapUsed≈1.92GiB; два последующих Main candidate-start не подтверждают запуск
в worker. Соседний `agent-transcript:get-history` также не доказывает allocator.
Это отдельный incident уже с query-worker кодом в ASAR: прежний SOURCE repair
нельзя повторно объявить отсутствующим. Native abort не ловится обычным JS catch;
команда quit/install не установлена. Новый boot32258 и его cpu_resource report
не относятся к причинности старого падения. Точные pins/IPS и незакрытая причинная
граница сохранены в рабочем `docs/tmp/оптимизация-history.md`; exact allocator OPEN.

Отдельно18Oct подтверждён и исправлен SOURCE-дефект общего JSON projector:
captured token удерживал один элемент `parts` на каждый мелкий фрагмент/escape.
Теперь каждые1024фрагмента соединяются в блок без повторного склеивания всего
растущего prefix; выбранное значение, Unicode, validation и byte locators полные.
Для незакрытой строки2.36MB локальный Node22 удерживал≈21–23.5MB сверх baseline,
embedded Electron28≈9.4–11.75MB; grouping убрал этот множитель. Это retained heap
контроля, не production peak/RSS.124controls прошли на Node22 и во встроенном
Node18/Electron28; PRE даёт3memory RED/2semantic PASS. Прогресс тяжёлого read
проверяется по тому же operation ID/монотонным bytes и конечному release:
`[1,1,0]` с progress допустим, точное число callbacks зависит от времени read.
Исторический fatal caller, GUI/installed acceptance и остальные transient peaks
этим не закрыты. Raw persistence, full content и source/lineage clocks не менялись.

Отдельный closed-fixture прогон actual catalog selected-value пути через
HistoryReadClient→Worker→canonical query→transfer→Main на том же Electron28/Node18
сохранил полный выбранный Unicode payload и query result. Максимальный
наблюдённый worker heap на write-boundaries составил72.4→25.3MB при одинаковых
2.36MB escaped input; это sampled whole-isolate heap, не peak/RSS и не allocator
старого crash. `client.close()` после начала hydration завершил pending request
ошибкой `history_reader_closed`, без Main raw graph; это отмена reader, не UI Stop.

Отдельные11.10 OOM имели разные стеки:10:57UTC — Main `JSON.parse`,13:39 —
GC worker/ConsString. Конкретные fatal files/callers не установлены. При этом
catalog search доказанно загружал полные Codex records в Main до проверки
внешнего turns-cache; `includeRecords:false` не исключал physical raw branch.
LRU вытеснял старые файлы после разбора нового и не ограничивал transient peak.
Адресный SOURCE-ремонт — query-проекция в worker, не увеличение RAM/SSD лимитов
или остановка вкладок; контракт и пределы — `fact-session-history.md`.
Следующий отдельный SOURCE-ремонт допускает уже готовый physical Main turns
graph до raw read по доказательству его исходного чтения и текущего binding.
В малом контроле eviction только raw LRU больше не вызывал повторный parse или
History/Timeline build; annotations оставались свежими. Простая перестановка
`stat/cache if` неверна: она могла бы удостоверить старый graph свежим stat
или вернуть неизменный A после переназначения SID на B. Virtual/cold пути и
общий лимит transient heap этим не заменены.
Отдельный контрпример дал настоящий resolver: задержанный cold scan записывает
B в memo, пока старый lookup ждёт `access(A)` и затем возвращает захваченный A.
Stat/generation A при этом могут остаться прежними. Поэтому финальный synchronous
guard проверяет и live memo binding; это не изменение алгоритма выбора файлов.
Другие full-preparation consumers и оба production incident этим не объявлены закрытыми.

### Падение main после Fork во время переименования

28.09,16:06BKK: child2941 успела создаться, затем main68878 завершился
`SIGABRT/FatalProcessOutOfMemory` при выделении UTF-8→two-byte string.
Непосредственно перед аварией live watcher обрабатывал диапазон
238991632..548841803 нового child, параллельно full raw readers читали parent
и child примерно по523MiB. Стек без JS-frame не доказывает единственного
allocator-owner, но all-at-once watcher отдельно воспроизвёл OOM на synthetic
325099828bytes с heap512MiB. Ограниченное чтение того же actual callback
сохранило digest/порядок всех585records и завершилось с observed heap≈175MiB.

Это отдельный потребитель данных: прежний ремонт History worker/prepared SSD
не охватывал main watcher. Он теперь использует два ограниченных прохода,
сохраняя exact carrier selection и целую границу compact/lifecycle; контракт —
`fact-codex.md::Большой догоняющий append после Fork/Resume`. Нельзя чинить
отключением Fork/фонового чтения или только увеличением heap. Native acceptance,
суммарный пик остальных full-read callers и предел одиночного большого record
не объявлены закрытыми этим regression. Переименование не переписывает rollout:
имя child после повторной попытки16:09 подтверждено живым Project API.

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
Чтобы убрать `activeTabId` из fingerprint в `TerminalArea` (см. секцию 6) и не пересчитывать список 40+ терминалов при каждом переключении, селектор активности был перенесён **внутрь** `Terminal`/`BrowserTab`/`ClaudeSDKTab` (BrowserTab с тех пор удалён). Первая (сломанная) версия:

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

Финальный контракт после прод-регрессии 2026-06: активность terminal-layer не должна жить только внутри `Terminal`/`ClaudeSDKTab`. `TerminalArea` оставляет структурный fingerprint для mount/unmount, но отдельно подписывается на `activeLayerKey` (`view + activeProjectId + activeTabId + currentView + viewingSubAgentTabId`) и передаёт `active/isActiveProject` вниз props-ами. Это сохраняет xterm-состояние без remount, но не даёт старому проекту оставить в DOM `active=1 opacity=1` после перехода на другой проект.

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
- `tab.id` + `tabType` — для add/remove/retype. Если таб сменил тип (`terminal → claude-sdk`, `terminal → file`), useMemo пересоберёт элементы — это другой компонент.
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

## 7a. Workflow/tab switch: CPU LongTask и cosmetic wait — разные причины

Пользовательский симптом был неоднозначным: при быстром переключении workflow белая рамка, hover и оранжевая рамка composer появлялись отдельными рваными фазами; spinning loader сам замирал. Это выглядело как один медленный animation/timer, хотя production 27.08 показал два независимых слоя.

За 07:19–07:20 UTC было 39 workflow switches и 41 tab switches. Медиана workflow до первого кадра — 82мс, p90 — 136мс, но один точный переход в 07:19:22.495 дал renderer LongTask 454мс и rAF gap 600мс. Main в середине имел `activeOps=0`; tab/pane projections стоили 0–13.5мс, React→layout — 23мс, History lifecycle не запускался. В том же urgent task четыре retained Timeline сменили `isVisible`; значит доказанная граница — renderer presentation/Timeline reconciliation, а не main/SQLite/History load. Полный pixel-owner всех 454мс без CPU profile не доказан, поэтому метка `during=workflow-switch` остаётся пересечением, не приговором одной функции.

Второй слой был настоящим искусственным ожиданием. Workflow click иногда ждал 20мс и два rAF ради feedback; primary input шёл через `rAF → setTimeout(0)`; selectable pane click резервировал 240мс под double-click; белая/hover/оранжевая рамки и workflow background имели transitions 70–120мс. На плохом переходе focus request пришёл в 07:19:22.498, dispatch только в 22.973 (+475мс), result в 23.092 (+594мс): timer не создал CPU freeze, но завис за ним и визуально разделил один commit на три события.

Целевой ремонт не подбирает меньшие задержки:

- workflow commit выполняется прямо из click; pressed/pending — статичный state, не обязательный «кадр перед работой»;
- focus intent ждёт не время, а exact mutation `data-terminal-surface-presented=1`; один `MutationObserver` coalesce'ит rapid navigation и выпускает target в том же presentation commit. Body press ждёт matching pointerup: drag и существующее browser Selection сохраняются, обычный click без выделения возвращает primary input. Chip/keyboard paths сохраняют свой прямой focus intent;
- С11.10 readiness lookup берёт свежий `terminal-pane-wrapper:<tabId>` через
  getElementById вместо глобального перебора wrappers. TerminalArea задаёт ID и
  dataset из одного keyed tabId; connected/dataset/presented/isolation/aria-hidden
  и текущий store-owner проверяются по-прежнему. Node не кэшируется: replacement
  читается заново; pending очищается до dispatch, чтобы синхронный новый intent
  не был стёрт старым. Уникальный ID — invariant producer, не самостоятельное
  разрешение focus. Отдельного registry, таймера или scroll writer не добавлено;
- focus quarantine обрабатывает boundaries по одной background `scheduler.postTask` (`MessageChannel` capability fallback), без rAF/setTimeout в navigation contract;
- С11.10 повторный discovery известных pane/center/workspace boundaries не
  обходит retained descendants в каждом sync/deferred task. Manager хранит DOM
  identities; structural/marker MutationObserver обновляет только изменённые
  поддеревья, а takeRecords перед использованием закрывает окно до доставки
  callback. Flags читаются заново, DOM order/restore-first/version cancellation/
  authored tabindex/capture guards сохраняются. Неизвестные caller selectors
  остаются на свежем query path. Это новый inventory observer, не отсутствие
  работы: цена теперь зависит от boundaries и изменённых поддеревьев.
  Общая фаза `pane-focus-boundaries` отделяет discovery; прежнее deferred `ms`
  остаётся isolate/restore, рядом `discoveryMs/prepareMs/totalMs` покрывают
  остальной callback. Малое старое ms не доказывает дешёвый весь focus handoff.
- Timeline visibility обновляет отдельный host через transition после внешнего opacity commit, чтобы не reconcile'ить History/Virtuoso и не продлевать urgent first paint;
- active/focus/hover truth меняется без CSS transition. Workflow DnD сохраняет тот же X-only resolver, preview и durable commit, но background и positional preview snap'ятся без FLIP; project row может сохранять FLIP;
- workflow busy и tab pending operation используют статичный оранжевый marker. Статика не умеет появиться внутри уже начавшегося LongTask — ничего не умеет, пока renderer не рисует, — но перестаёт изображать frozen animation как второй дефект.

Единственный временной предел в этом пути — error fail-safe, который снимает pending при несостоявшемся switch; он не управляет happy path. Для остаточного tab-switch CPU добавлены подфазы `[Perf:TabSwitchStart] notifyMs/activePointerMs/mruMs/spaceRouteMs/placementMs/finalSetMs`: следующий production-инцидент должен показать, какой store-step владел `syncMs=105`, вместо очередной гипотезы по общей метке. Source-проверка: 130 focused tests, targeted transpile и diff-check; physical production proof новой дельты остаётся отдельным шагом.

11.10,17:23UTC: нажатия при выделении текста4412 девять раз запускали switch
4412→4412; sync46.5–51.4мс внутри pointerdown144.6–162.2мс. SOURCE reuse
согласованной pane activation сокращает публикации store4→1, сохраняя явный
sidebar reveal и отмену прежнего async navigation. Недостаточно одинакового
paneIndex: parked sidebar, selected set, новая notification, MRU/missing visit,
Home, lazy runtime и иной owner требуют прежнего пути. Gesture Selection
guards остаются прежними. Это устранение повторной работы, не объяснение всего
input delay: тот же инцидент содержит native renderer CPU без exact stack;
source controls не являются latency A/B.
Первый pointerdown1576мс в этом интервале — настоящий переход3314→4412
(switch99.6мс), а не один из этих девяти повторов. Reuse его намеренно не
пропускает; ускорение этого первого перехода данным ремонтом не доказано.

Контроль inventory11.10 — `scripts/pane-focus-inventory-regression.mjs`:
actual helper/native DOM/MO,53boundaries+53000synthetic rows, пять warm sync
дают0full-root queries вместо5; late add/marker, same-ID replacement, finalDOM
order/remove+reinsert, restore-first/stale tasks, nested exclusion иdispose
проверены. Scheduler/input контролируемы; offscreen focusin доставляется
явным synthetic event, это не OS-focus/whole-app latency proof. CPU инцидента
Main↔FlowTab00:24 показывал liveBoundaries19–22ms внутри handler, но эта сумма
не обещает такую же экономию latency: React/inclusive callbacks перекрываются.

29.09,17:56–17:57BKK: семь возвратов в warm `main` показали click EventTiming
288–432мс при store sync10.0–20.6мс.53 retained tab hosts и16chrome reused,
rebuilt0; четыре History gen1, geometry stable, loader hidden, без нового load
в границе переключений. Эти факты подтверждают работу retention, но не бесплатный
показ слоёв. Renderer LongTask пересекается с click, а TerminalArea projection
занимает1мс: нельзя объявлять причиной повторный parse или только этот projection.

Прежние `Focus:PrimaryInput phase=dispatch/result` ОБЕ записывались после
синхронного dispatchEvent и callback редактора. Разрыв133мс от presentation
до такого «dispatch» не доказывает ожидание перед фокусом: внутрь мог входить
сам focus/selection. SOURCE добавляет dispatch-start/dispatchMs и отдельный
HistoryComposerFocus focusMs/selectionMs с исходными absolute times, без новых
DOM/geometry reads, timers или IPC. Интервалы вложены, складывать их нельзя.
Это диагностическая граница: длинный inner focus/selection требует профиля
редактора/forced layout; короткий inner при длинном промежутке — соседнего
renderer commit/paint. До такого совпадающего замера producer не назначен,
нового ускорения не заявлено; сохранённый native sample без точных JS/Chromium
символов не заменяет CPU/paint trace.

После install29.09T12:47:22Z новые логи23:35–23:36BKK разделили остаток:
15workflow clicks192–344мс, store7.8–14.5мс. У повторных main-return composer
focus+selection3.5–6.4мс, но между окончанием PaneLayerPresentation и началом
focus88.9–119.1мс. Один переход в116 тратит98мс на focus/selection. Следовательно, перенос
focus в таймер не чинит основную цену тёплого commit и меняет порядок feedback.
Совпадающего CPU/paint trace для этих жестов нет; следующий такой профиль должен
разделить React commit и нативные style/layout в этом конкретном интервале.
В фоне Timeline3314/3894 действительно делали rebuild9.45/10.62с; показ retained
History их не ждал. Это отдельная нагрузка, а не доказательство, что каждый
click ждал JSONL. Точная причина отказа SSD-кэша по этим суммарным логам неизвестна;
RAM eviction, schema/source invalidation и disk eviction нельзя объявлять одним.

Дополнение17.10: реальный production-built renderer на длинных captured History
показал повторную metadata-проекцию в urgent click. Bridge копировал private Tab
поля, повторял project-icon lookup, sidebar повторно кодировал равный свежий
вектор; no-op activeArea и шесть menu queries добавляли работу. Сохраняющий ремонт
уменьшает эту работу, оставляя синхронные publications/revisions/probes прежними.
Для double-click rename второй plain click больше не повторяет activation;
локальные activity maps игнорируют чужие execution namespaces. Workflow и Project
не тождественны: native tabs разных workflow могут разделять один namespace.
Сопоставимый UI A/B улучшился, но continuous input всё ещё имеет задержки>100ms;
source controls или быстрое первое нажатие не заменяют всю latency-серию. Замеры
и ограничения — `docs/tmp/оптимизация-history.md`; shared encoding — `fact-tabs.md`.

## 7b. Пустой поиск чата инвалидировал стили всех окон

29.09 после Build Install открытие «Найти в чате» и закрытие крестиком давали
click424–496мс в уже показанной754. Реальный поиск11 358сообщений занимал11–16мс
в worker. Тяжёлый путь воспроизводился и без запроса: условная панель добавляла
и удаляла `<style>` с `::highlight(owner-name)`. Highlight наследуется через
дерево, поэтому Chromium пересчитывал даже скрытые retained History.

Actual HistoryPanel +60 047DOM nodes в private Electron28: три open/close,
RecalcStyle255–389мс; trace UpdateLayoutTree обошёл60 093элемента. Контроль,
убирающий только динамический stylesheet из той же фикстуры, дал1–7мс.
Это доказательство механизма на контролируемой нагрузке, не production trace.

Правила вынесены в постоянный CSS, Range принадлежат отдельным History leases
и объединяются в два статических Highlight. Закрытие/смена owner не очищает
соседнюю подсветку. Тексты, типы, пустой image-filter, Timeline rings, пагинация
и exact seek сохранены. Actual UI проверяет два одновременно ищущих чата и
закрывает каждый; cost regression ловит сам факт динамической вставки правил
на пустом поиске. Малый прежний функциональный тест правильно проверял поиск,
но не стоимость глобальной CSS-инвалидации при большом persistent DOM.

13.10 private replay работающей модели обнаружил похожую границу у Run After:
workflow click256мс добавлял два одинаковых overlay stylesheet. Вызов `fontProfile`
совпал с UpdateLayoutTree13.327мс, поэтому его sampled self13.541мс нельзя целиком
называть стоимостью canvas. Источник поля `styles.source` — ближайший размеченный
DOM-предок: SplitPaneSurface здесь обозначал portal-host, а правила принадлежали
PromptQueueOverlay. Их неизменный template перенесён в один Document-owned sheet,
без изменения фокуса, layout-формул и queue actions. Chromium-контроль сравнил
CSSOM/геометрию/фазы анимаций; это не измеренный выигрыш самого workflow click.

17.10 тот же механизм мешал ПКМ Fork → выбор настоящего pending child → rename
при четырёх работающих Luna в двух workflow. Перед доступом к карточке появлялись
стили плана задач и двух MicButton; style-mod4.1.3 дополнительно переписывал уже
установленный CSS CodeMirror теми же байтами. Само переиспользование StyleModule
не предотвращает эту запись. Статические правила контролов загружаются один раз,
а точное равенство CSS пропускает только повторную запись: новые правила, порядок,
nonce и восстановление удалённого style остаются прежними. Нужны обе границы;
один guard при оставшихся inline stylesheet не ускорил весь путь.

Профили и возврат старого renderer подтвердили снятие части commit/style работы;
реальная короткая серия улучшила доступ к child и rename без переноса mount,
durable ACK, публикаций или подготовки Fork. Объединение scalar-подписок карточки,
detached EditorView и перенос чтения fonts.ready сами по себе весь путь не ускорили.
Вложенный дорогой стек не следует объявлять причиной всего ожидания. Подробные
интервалы и оставшиеся задержки ввода — в `docs/tmp/оптимизация-history.md`;
CDP callback/hit-test не доказывает момент native foreground presentation.

Отдельная Main-стоимость — canonical encoding полного organization snapshot перед
ACK. Повторные string keys/values кодируются один раз внутри одного вызова;
все поля читаются свежо, canonical bytes и transaction/CAS прежние. Это чистая
экономия кодирования, не кэш row/Tab identity и не самостоятельная UI-приёмка.

---

## 7c. Правило фоновых анимаций тормозило показ прогретых окон

30.09 после Build Install возвраты на Main224–392мс при reuse50tab nodes и16chrome
не требовали повторного mount. Native intervals подтверждали style57–108мс,
но были шире клика и сами не назначали конкретный writer. Private Electron28
с actual TerminalArea/SpaceStrip/History/Timeline и~58k DOM воспроизвёл механизм.

`presentationAnimations.css` искал hidden indicators через descendant
`[style*="animation:"][style*="infinite"]` и `[class*="animate-glow-"]`.
Изменение inline CSS/класса владельца давало invalidation set по ЛЮБОМУ style/class:
обычные сообщения, кнопки и иконки тоже попадали в обход. Trace UpdateLayoutTree
4392elements/67–74мс; style median77.5. Guard одинаковых style writes не помог
(79.7мс); только убрать inline selector недостаточно (60.2мс), class substring
сохранял обход3239elements/49мс. Это CSS invalidation, не цена чтения истории.

Цели теперь индексируются по точным классам.37inline indicators помечены
`noted-infinite-animation`, включая условные infinite/none; семь glow-классов
перечислены явно. Скрытые анимации по-прежнему paused, visible-unfocused running,
новые индикаторы в скрытом owner сразу paused, finite/mixed dismiss завершён.
AST coverage проверяет существующие inline JSX styles, включая ternary objects;
новый цикл требует marker на том же элементе. Не возвращать substring fallback.

Same-harness CSS baseline RED77.5мс; final GREEN13.5мс. EventTiming click median
112→40мс, processing79.7→15.2мс; driver elapsed включает управление тестом и2rAF
и не является этими величинами.33focused checks и private actual UI проходят:
8switches сохраняют DOM/row/scroll/draft/focus, reads6→6; background transcript
delivery показывается после reveal и не сдвигает соседнюю читаемую строку.
Отдельный animation UI проверяет4owners, clocks/identity, late inline indicator,
finite/mixed dismiss и реальное движение пикселей. Repeatable:
`scripts/workflow-switch-cost-regression.mjs` (`NOTED_WORKFLOW_EXPECT_FAST=1`),
`scripts/renderer-animation-regression.mjs --skip-perf`.

Это source/isolated proof механизма. В рабочем12:13renderer style мог быть
принудительно выполнен до focus, в малой fixture — внутри focus. Совпадающий
production JS trace утрачен quota; цена всего оставшегося commit и новые
installed задержки не приписаны одному правилу. Истории/lifecycle/production
не менялись; source-правка требует обычного следующего Build Install.

## 7d. Home обходил retained DOM через наследуемую visibility

03.10 Home открывался и закрывался медленнее переключения workflow. В installed
01.10 наблюдались EventTiming280–520мс: input7–32, processing83–161,
presentation151–335. Native style43.8–66.7мс относится к более широким
пересекающимся интервалам, не к эксклюзивному CPU каждого клика. Тот же30с
срез: app201.5%, external159.4%,10cores/systempeak65.8%, swapdelta0; внешняя
нагрузка не объясняет весь лаг и не отменяет собственную лишнюю работу.

Workspace уже был смонтирован, но его общий предок переключал наследуемую
`visibility`. В controlled Electron28 с теми же~58kDOM это инвалидировало
~22.6kпотомков. Парный source-map diff меняет только эту boundary: медиана
RecalcStyle184.4→16.3мс. Это самостоятельный дефект от прежнего Home SQL-scan
в разделе1c и от CSS-selector дефекта7c; повторное чтение History не требуется
ни до, ни после этого ремонта.

Boundary сохраняет скрытие через opacity/stacking и прежнюю изоляцию input,
не перемонтирует Workspace и не ставит native inert на общий предок.14focused
и9private UI checks сохраняют DOM,scroll27872,draft,reads6→6,тот же xterm,
background output и отказ скрытого Home принимать surface shortcut.
`scripts/home-floating-cost-regression.mjs` с `NOTED_HOME_EXPECT_FAST=1`
отличает baselineRED от sourceGREEN. Ни16мс, ни время полного test interval
не являются обещанием total installed latency; оставшиеся JS/layout/paint
и рабочая нагрузка измеряются прежней диагностикой после обычной установки.

## 7b. Первый wheel зависал из-за Git fan-out скрытых окон

Пользовательский симптом: переключение выглядело мгновенным, но первый scroll в соседней видимой History замирал как системный ввод, хотя память и усреднённый CPU в панели казались нормальными. Production 08.09 21:31:03 МСК дал точное разделение: wheel `tab-4553` дошёл до renderer с `inputDelayMs=233.4`, одновременно Electron main/browser thread имел `MainLoopGap=528.7мс` и `cpuUserMs=524.4`. History не владела паузой: `seek/restore/hydration/wave=0`, `scrollHeight 52793→52794`; следующие жесты пришли за 26–43мс и дали `input≈deltaTop` до субпикселя.

Корень — сохранённый window chrome продолжал Git-жизнь после потери presentation. Каждый `GitStatusButton` подписывался на общий `git:status-changed`, а broadcast будил все скрытые копии того же repo. Main coalesce'ил только уже пересёкшиеся запросы и для каждого нового status запускал bundle из `status + remote + user + email + credential + merge`. В проблемном окне было 25 IPC/1964мс за 5с, позже 64/6078мс; browser thread, который доставляет native input renderer'у, периодически не отвечал 0.5с. Средний CPU скрывал короткий burst.

Ремонт сохраняет persistent chrome и размеры. Отдельный лёгкий host подписан на exact pane-presentation и передаёт Git boolean `foreground`; только `presented && focused && workspace-keyboard-owner` держит watcher и автоматический refresh. Закрытый chip запрашивает summary: одна Git-команда, без списка файлов и panel metadata. Полный снимок, diff/history и repository credentials начинаются только после клика. Summary и full имеют разную in-flight identity, поэтому поздний краткий ответ не может подменить открытую панель. Production-проверка после install: в idle скрытые repo не дают `[GitStatusCoordinator]`; изменение focus-repo даёт один `detail=summary`, открытие панели — один `detail=full`; рядом не должно быть `ipcAgg5s=git:status:n≫1` и `MainLoopGap`.

---

### Повторный status из-за собственного index.lock

13.10 отдельно подтверждён цикл даже у одного foreground chip: `git status`
обновляет индекс, recursive watcher видит index/index.lock, renderer снова запрашивает
status. В private repo три чтения дали файловые события при неизменном porcelain;
без optional locks — тот же ответ без этих событий. Новый actual контроль подменяет
inode рабочего файла при сохранённых bytes: обычный status переписывает index,
исправленный summary/full сохраняет его bytes и всё равно видит следующие изменения
и untracked-файлы. Явный staging и merge не затронуты. RED2FAIL/1PASS, GREEN19PASS
вместе с coordinator и actual Git merge controls; Electron/UI в этом контроле нет.
Это source-ремонт лишнего фонового цикла, не доказанное устранение production Main
SQL-пауз28–32s. Installed-приёмка отдельно; пользователь пока запретил Build Install.

## 7e. Закрытый raw terminal продолжал обновлять DOM scrollbar

17.10 первый реальный UP в History при чужих streams выявил отдельную стоимость
retention: opacity сохраняет Canvas, но не останавливает xterm 5.5 Viewport.
У четырёх готовых raw-hidden Luna точный receiver→instance→tabId контроль нашёл
280 `_innerRefresh` за конечный нагрузочный прогон. Это около1.8s накопленной
работы, не задержка одного wheel. В коротких input windows стек занимал115–119ms
sampled; после presentation-гейта в этих окнах он исчез, parsing продолжился.

Откладываются только новые DOM refresh requests после начальной калибровки.
Write pump/parser/buffer/OSC и Main/headless generation/sequence остаются живыми;
visible-unfocused raw terminal не считается скрытым. При показе применяется
текущее состояние. Dirty DOM scroll согласуется до прежнего native listener,
а программный scroll ACK потребляется до первого настоящего raw wheel, иначе
Chromium coalescing может поглотить именно это пользовательское движение.
Adapter привязан к exact xterm instance и проверенной5.5 dependency; при upgrade
нужны actual controls, unsupported shape сохраняет прежнее поведение.

Удаление этого стека не доказывает устранение production-паузы: в native серии
первый observed scroll busy70–71ms сменился20/76.5ms, устойчивый whole-path выигрыш
на малом N не установлен. В оставшемся случае до capture были React/publication,
GC и native style/hit-test; затем paint/layer work. Вложенные интервалы не складывать.
Compositor FRAME_SWAP не равен физическим пикселям. Рост scrollTop вместе с
уточнением scrollHeight не доказывает обратный жест: проверять реальную row identity
и её координату. Точные cuts, отказавшие probes и installed-граница — в рабочем
`docs/tmp/оптимизация-history.md`, не в обещании нулевой фоновой стоимости.

## 7f. Cmd публиковал React-state без доступной подсказки

Удерживаемый ControlBar запоминал Meta/strict-Ctrl через два React-state на
каждом физическом переходе. Даже без hover, keyboard ownership или draft это
будило крупный компонент. Равные значения уже отсекались для обычной буквы,
но настоящий Meta edge оставался общей публикацией.

Физические flags сохраняются в прежнем listener через стабильные scalar refs;
React получает только видимый по прежним predicates feedback. Layout-проекция
сохраняет Cmd→hover и изменения owner/draft/picker при удержании. Enter hover
не требует keyboard focus. Отправка/Record/Run After используют прежние handlers
и event flags; нового input authority или глобального registry нет.

В18.10 private A/B/A/B с built renderer и2actual bars mean bare-Meta EventDispatch
снизился5.046→3.592ms на16edges/variant. Это небольшой локальный выигрыш,
не объяснение прежних49ms или production-очереди713ms. Первый и warm Cmd+B
меняли знак выигрыша между парами; whole latency/installed/p95 этим не закрыты.
11actual-code controls и парная live React-проверка Enter/Ctrl feedback прошли;
ошибочный observer DOM-title исправлен после проверки реального ControlHint.
Подробные cuts, исходные отказы и оставшиеся сценарии — в рабочем tmp темы.

## 8. Observability Toolkit (для будущих регрессий)

12.10 installed-репорт после restore показал одновременно renderer input waits
и Main CPU. Сохранённый профиль указал `findCodexLinkedLiveBoundary` (декодирование
посторонних тел), bulk organization reads (повторная подготовка SQL), а в renderer
`tabLinkedFilesSnapshot` у retained владельцев. Адресные source-ремонты: bytes
predicate до UTF8; prepared statements только на один SQLite snapshot; общий
file index по опубликованному Zustand state, а не mutable openProjects. Контракты
в `fact-codex`, `fact-workspace`, `fact-tabs`. Локальные RED→GREEN и уменьшение
счётчиков не объявляют весь lag исправленным: captured trace был обрезан, а
прежний18History E2E не соответствовал production topology/restore wave.

Следующий private replay с текущей topology и тремя точными History воспроизвёл
click296ms уже после prewarm. Полный trace и CPU покрывают сам переход: повторные
canvas allocation, sidebar projections/ancestor traversals в renderer, doc-body
hashing и SQL PREPARE в Main. Source-ремонт переиспользует только эти вычисления
в пределах Document, опубликованного STATE, структуры строк, watch или batch.
Живые ink/данные/guards остаются свежими; счётчики RED→GREEN не заменяют retake.

Поздний post-install профиль12.10 обнаружил оставшуюся повторную работу у HTTP
`project-prompt-usage`: root-registry готовил одинаковые SELECT для каждого live
и archive-only binding, а watcher-pass повторял stat общих папок. Это запрос
внешнего файлового дерева, поэтому активная History сама не локализует Main работу.
Ремонт разделяет prepared statements и свежие результаты, сохраняя оба прохода;
файловая memo каждого прохода отдельная. На24 bindings PREPARE192→4 при прежних
192 executions, stat54→6. Этот профиль снят после trigger, а не на wheel17:18:
счётчики доказывают устранение лишних операций, не ускорение того жеста.
Границы свежести и retirement debounce — [каталог промптов](fact-project-prompts.md).

После пользовательской установки Diagnostic25 в13Oct18:24UTC именованные production
summaries показали оставшуюся работу этого caller: один `catalog.usageForRoot` занял
1378ms/1077ms Main-threadCPU, прошёл1754bindings и11857каталогов; собственные SQL
counts/times участка составили около23ms. Это наблюдение после установки prepare reuse,
не ретроспективный JS-стек прежних30s пауз. Даже пустой результат usage был дорогим:
фильтрация requested root происходила после полного scan чужих `docs`. Адресная
дельта пропускает только proven-disjoint каталоги и не прогревает полный cache
частичным ответом. Сравнение before/after на настоящем tempFS/symlinks проверяет
равенство всего usage и следующего полного picker, fresh SQL/CAS/watchers отдельно.
Installed ускорение этой дельты должно подтверждаться на новом artifact; меньшее
число directory reads в контроле не является замером прежнего клика.

Название кнопки не локализует зависание. В сохранённом installed Copy сначала
pointerdown занял236.3ms и содержал работу переключения панели; поздний click
ждал218.2ms, его собственный handler занял13.4ms. Это разные перекрывающиеся
интервалы одного жеста, их нельзя складывать. Текст там855символов/0chips:
данный пример не доказывает стоимость большого сообщения со вставками. Для Copy
сверяй focus/publication до click, сборку полного payload, native clipboard и
последующий UI; проверка одного codec без OS/React не закрывает общий сценарий.

После рефакторинга 2026-04-21 в коде расставлены лог-теги, которые **не должны** появляться часто в нормальной работе. Каждый из них — сигнал конкретной регрессии.

Для freeze-разборов логи разных процессов должны сравниваться по абсолютным timestamp'ам, а не по локальному `performance.now()`: renderer пишет `performance.timeOrigin + now`, main — `nodePerformance.timeOrigin + now`. Если пользователь говорит «кликнул и 5 секунд ничего», сначала выровняй `[Perf:InputDelayContext]`, `[Perf:ProjectView/HomeAction]`, `[Perf:TabSwitchFrame2]`, `[Perf:MainLoopGap]` и `[RestoreSession]` по `*Abs` полям. Без этой корреляции легко перепутать позднюю доставку input event, React render freeze, main-process блокировку и обычный долгий IPC.

Для beachball/freeze недостаточно только in-process probe'ов: `[Perf:MainLoopGap]` и renderer EventTiming логируются **после** того как loop разморозился. Поэтому внешний `perf-watchdog.js` работает отдельным plain-node процессом: main шлёт heartbeat по fork IPC, renderer — напрямую в unix socket, чтобы замёрзший main не мог имитировать renderer-stall. Watchdog может начать native sample ещё во время зависания; с 11.09 source сохраняет также CPU-предысторию и ограниченный incident-profile для разбора через несколько дней. Фактическое начало sample/profile, budget/ошибки и coverage проверяются отдельно: наличие STALL не гарантирует захвата стека. Контракт и чтение артефактов — [отложенная диагностика](логирование-оптимизации.md).

`activeOps=0` в `[Perf:MainLoopGap]` больше не означает “ничего не работало”. Смотри рядом `recentOps5s=` и `ipcAgg5s=`: sync IPC может закончиться в тот же тик, когда gap-таймер наконец получил управление, поэтому активных операций уже нет, но агрегат показывает виновный канал (`search:stats:n=1:sum=4102:max=4102`). Для per-keystroke каналов (`terminal:input`, `log:renderer`, `terminal:resize`) подробный recent-ring намеренно не заполняется, иначе они вытесняют редкие тяжёлые операции; их видно через aggregate.

Тестовые логи из CDP/harness проверяй на `document.visibilityState`. Если окно hidden, Chromium может throttle'ить renderer так, что synthetic hover/input выглядит как многосекундная задержка без реального foreground freeze. CPU-профиль скрытого окна может показывать idle при неисполнившихся rAF/свапах. Показ окна через CDP допустим в отдельно разрешённом foreground-эксперименте. Автоматический incident-recorder никогда не поднимает production-окно: сохраняет фактическую видимость и не выдаёт скрытый idle за доказательство быстрого foreground.

Платформенная атрибуция long tasks бесполезна для своего кода: за двое суток все 898 длинных блокировок пришли `attribution=unknown` (включая одну на 14.2с) — same-origin работа схлопывается в «self». Поэтому приложение ведёт собственный короткий журнал активности (`rendererActivityTrail.ts`, `markRendererActivity('имя:'+tag)`), и freeze probe стампует каждый LongTask списком работ, шедших одновременно (`during=`). Незакрытая метка помечается `(open)`, но не получает повышенной причинной силы: например, `history-load` может ждать apply-очередь минутами и накрывать чужие задачи. Это диагностический след, не сигнал управления. `during=` означает только пересечение по времени; CPU-вклад требует профиля (см. [логирование оптимизации](логирование-оптимизации.md#как-читать-доказательства)).

| Тег | Норма | Регрессия |
|---|---|---|
| `[Perf:ProjectSwitch] durMs=N` | <50ms | >200ms = что-то синхронно блокирует main thread |
| `[Perf:TabSwitch] durMs=N` + `[Perf:TabSwitchStart] ...Ms=` | <50ms | >150ms: сначала найди дорогую store-подфазу; если sync дешёвый — смотри TerminalArea/Timeline renderer task, не обвиняй useMemo автоматически |
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
