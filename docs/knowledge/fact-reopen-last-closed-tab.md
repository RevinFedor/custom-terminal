# Feature: Reopen Last Closed Tab (Shift+Cmd+T)

## Intro
VS Code-стиль: `Shift+Cmd+T` возвращает последнее закрытое размещение или вкладку. С29.09 локальное «Убрать» и полный `Full` сравниваются по порядку действий в одном окне: способ закрытия не даёт приоритета. Источники остаются прежними — pane-local `detachedTabs` для ещё живых вкладок и `tab_history` для полного закрытия. Home и архивная половина хоткея идут через один store-flow с общими CWD-проверками, созданием вкладки, durable save и commit истории. Повторные нажатия идут назад по обоим источникам; после исчерпания окна остаётся прежний project-wide архивный fallback.

Source: `src/renderer/App.tsx::handleReopenLastClosedCapture`, `src/renderer/store/useWorkspaceStore.ts::restoreTabHistoryEntry/reopenLastClosedTab`, `src/main/main.js::project:peek-window-tab-history/project:begin-tab-history-restore/project:finish-tab-history-restore`, `src/main/database.js::getLatestWindowTabHistory/getTabHistoryEntry/deleteTabHistoryEntry`.

## Behavior

### Сфокусированное окно владеет жестом

В split-режиме `Shift+Cmd+T` фиксирует `spaceId/windowId` сфокусированного окна. Из архива читается только метадата последнего Full этого окна среди открытых проектов, затем она сравнивается с последним доступным локальным снятием. Поэтому старое «Убрать834» не перекрывает новое «Full919», а более новый Full соседнего окна не перехватывает свой локальный undo. Проект sidebar не ограничивает смешанную полосу: восстанавливается проект выбранной архивной записи. Если в окне нет доступной записи обоих видов, project-wide fallback берёт проект заполненной панели либо sidebar для пустой. С24.09 архив возвращает чип в исходное существующее окно и между сохранёнными соседями; удалённые workflow/окна не воскрешаются.

Локальное удаление не проходит archive/create: tab уже живёт в проекте. Снятый chip записывается в `detachedTabs` той pane, последний chip оставляет фокус на пустом slot. Запись reproject'ится при смене project owner и очищается при полном Close. Членство в полосе определяется по её chips, а не по показанному body или наличию второго chip: единственный parked chip в vacant pane тоже можно убрать средней кнопкой.

Новые записи обоих источников получают общий монотонный `closedOrder`, у Full — внутри `restore_placement`. Порядок не зависит от времени завершения async archive. Keypress ограничивает выбор уже начатыми действиями; более позднее закрытие не подменяет его ни при чтении окна, ни через project fallback. Для старых Full используется `closed_at`; у старых локальных записей время не сохранялось, поэтому датированный Full выигрывает у неизвестной даты. Точную смешанную хронологию таких legacy-записей восстановить нельзя; их собственный локальный порядок сохраняется. Ошибка чтения архива явно возвращается пользователю и ничего не потребляет.

Если пользователь успел удалить и целевую fallback-панель, восстановленная вкладка активируется обычным центром; локальный undo сохраняет доступ к конкретной выбранной вкладке без создания нового runtime. Одиночная полоса при локальном удалении получает явную pane с теми же оставшимися чипами и собственным undo. Быстрые повторы сериализованы по захваченному окну (без pane — по проекту); смена фокуса или перестановка окон во время чтения не перенаправляет запрос. Home использует то же сохранённое расположение; фоновый Restore добавляет чип, но не меняет показанную вкладку и фокус.

### Восстановление с позицией
С24.09 `tab_history.restore_placement` сохраняет соседей в sidebar и оконной полосе, включая chooser-места. Восстановление вставляет перед первым сохранившимся правым соседом, иначе после ближайшего левого; только если ни одного не осталось, использует ограниченный индекс. Поэтому закрытие другой вкладки слева не отправляет восстановленную строку в конец. Локальный `detachedTabs` использует тот же порядок, не прежний append.

Для старых архивов остаётся `tab_history.position`: недостающие прежние связи не выдумываются. При изменённом порядке соседей возврат детерминированный, но не откатывает всю раскладку к старому снимку.

### Восстановление visual-parent и детей

Закрытие сохраняет visual-parent, отдельно от `parentTabId` служебных subagent.
Прямые самостоятельные AI/terminal-дети закрываемого родителя остаются доступными на верхнем уровне и
помнят undo-связь в `closedVisualParentTabId`. При восстановлении она снова
становится живым parent; дети и родитель могут закрываться/возвращаться в любом
порядке, включая restart. Новое ручное переподчинение или перенос в другую
группу/проект снимает прежнюю undo-связь. Циклы и чужие группы не создаются.

Файловые вкладки закрываются вместе со своим владельцем и не становятся отдельными
сессионными строками `tab_history`; файлы сохранившегося AI-child остаются с ним.
С workflow archive integration owner сохраняет typed file-only manifest,
привязанный к exact historyId до удаления active catalog. Restore возвращает
owner и его file links и проверяет их до consume архива. Native v2 сохраняет
прежние PK/opaque ID/subject; legacy replacement получает зарезервированный id.
AI-child и его файлы в этот manifest не входят. До этой интеграции узкий close
касался только active rows и возвращал owner без file chips; это был предел
close-only ремонта, а не продуктовый запрет на восстановление файлов.

Сохранность disk files и атомарный save ACK не являются архивом их привязок.
`tabSnapshots` не хранит close-batch ID/список прежних links; `sidebar.before/after`
содержит соседей, а не attachment membership. Восстановление связей требует exact
owner archive и сохранённых typed file relations, а не вывода из пути/времени или
Markdown baselines. Независимые AI-child в такой набор не входят.

`restorePlacementId` — только долговечная identity расположения. Legacy reopen
создаёт НОВЫЙ runtime tabId/PTY: переиспользование закрывающегося id
могло бы попасть в старый `terminal:create` reuse до завершения kill. Родство и
соседи разрешаются через layout identity к текущему id. Явный external
`expectedTabId` сохраняет свой прежний контракт; layout не доказывает lifecycle
или доставку. Снимок Close клонирует изменяемых детей до durable ACK, поэтому
ошибка сохранения больше не стирает родство в ещё живом исходном Map.

Single Close/Unlink всегда передаёт intentional cleanup и захваченные IDs;
обычная metadata omission остаётся недеструктивной. Иначе одиночный native file
или последний v1 в mixed namespace возвращался в каталог после положительного ACK.
Групповой Close фиксирует typed families. Следующие families могут принять только
точный revision receipt своего предыдущего SQL шага; full retained snapshot
не считается чужой правкой, а foreign revision/reparent/type/SID по-прежнему отказ.
Для v1 сохраняется также exact own переход SQL PK: legacy snapshot пересоздаёт
survivor без изменения opaque tabId, поэтому неизменный frozen PK блокировал
вторую file family. Только receipt того же intent/transaction объясняет old→new
PK; чужая замена с тем же именем/ID/подписью не становится разрешённым close.

### Восстановление в tab-группу
Если вкладка закрывалась внутри group-row, `archiveTab` сохраняет её `group_id`. При Shift+Cmd+T и restore из Home это поле применяется только после проверки, что группа с таким id всё ещё существует в текущем `workspace.tabGroups`.

Мы намеренно сохраняем только id контейнера, не snapshot группы. Если пользователь к моменту restore удалил папку через Delete Group или Close Group, вкладка восстанавливается плоско: история отвечает за рабочую сессию, а не за воскресение удалённой структуры сайдбара. Иначе закрытая вкладка могла бы незаметно вернуть папку, которую пользователь уже убрал.

### Continue Session — политика зависит от точки входа
Для Claude/Gemini/Codex-вкладок ключевой вопрос: запускать ли сохранённую AI-сессию при restore, или просто открыть таб без процесса. У двух явных жестов разные ожидания, но они используют один механизм:

- **Shift+Cmd+T** восстанавливает процесс только когда `process_was_running=1`: это жест «верни только что случайно закрытое», но он не должен запускать завершённую работу заново.
- **Resume в Home** всегда продолжает сохранённую AI-сессию, если её id есть: пользователь явно выбрал действие Resume после preview.

Признак сохраняется в `tab_history.process_was_running` (0/1) на закрытии. Источник — `terminal:getCommandState` IPC (OSC 133-based, не PID-scan). Для `claude-sdk` табов аналогом служит `tab.claudeBusy` — тот же флаг, который читает `SessionActionChip` для tri-state Continue/Stop.

Для Codex generic OSC-состояние не является единственным доказательством: закрытие получает `processWasRunning`, текущий writer и durable session одним main-owned snapshot одного runtime-поколения. Иначе shell-edge во время handoff/Stop архивировал бы правильный ID, но помечал его как idle, либо автоматически перезапускал уже завершённую сессию. Отсутствующая/ошибочная DB-строка отличается от авторитетного `NULL`: ни один из этих исходов не разрешает воскресить старый renderer session id как fallback.

Без этой логики reopen приводил бы к одному из двух плохих сценариев: либо всегда auto-resume → Claude запускается даже когда юзер хотел просто заархивировать историю → переплата токенов; либо никогда не resume → юзер закрыл живой Claude нечаянно и теряет процесс. Бинарный сигнал `processWasRunning` снимает оба этих случая.

### Reserve → create → durable save → commit
Выбор записи ещё не означает успешное восстановление. Main сначала выдаёт краткоживущую lease на конкретную history-row без удаления; Renderer проверяет CWD, создаёт вкладку, применяет позицию/группу и явно дожидается сохранения финального workspace в SQLite. Только после этого `finish(..., commit=true)` удаляет исходную запись. Ошибка создания или отмена освобождает lease и сохраняет историю; ошибка durable save оставляет уже открытую вкладку и history-row с видимым предупреждением, потому что удалять единственную надёжную копию нельзя.

Тот же инвариант действует на закрытии: архив создаётся до Stop/kill/remove. Если durable archive не прошёл, Close останавливается и сохраняет живую вкладку вместе с процессом; Restore удаляет history-row только после строгого save ACK. Поэтому ошибка persistence оставляет хотя бы одну исходную копию и явный результат пользователю, а не превращает начало операции в успех.

Если для закрытия живой AI-вкладки нужен Stop, hard kill разрешён только после
структурированного `success:true`. Ошибка, timeout или `lookupUnknown` не равны
отсутствию процесса: вкладка и PTY остаются на месте, `aiClosing` снимается, а
только что созданный архив откатывается, чтобы повторный Close не породил
дубликат. Иначе кнопка визуально «закрывает» вкладку именно в тот момент, когда
main признал, что не знает состояние процесса.

Lease не даёт Home и хоткею одновременно восстановить одну строку, а очередь Shift+Cmd+T по окну (без pane — по проекту) превращает быстрые повторные нажатия в последовательный проход назад по истории. Если предыдущая queued-операция не consumed row из-за cancel/create/save/cleanup failure, следующий уже поставленный keypress останавливается: иначе он немедленно создал бы второй live-tab из той же latest-row. Lease ограничена по времени: renderer reload/crash без `finish` не делает строку навсегда занятой. Это исправляет старую ошибочную модель, где начало операции принималось за её успех и запись удалялась до `createTab`.

### Layout-agnostic hotkey через `event.code`
App-level capture listener: `e.metaKey && e.shiftKey && e.code === 'KeyT'` (см. `methodology/дизайн-принципы.md::Layout-agnostic shortcuts`). На QWERTY/Cyrillic/Dvorak — одна и та же физическая клавиша T. `e.preventDefault + stopPropagation + stopImmediatePropagation` глушит событие до того, как его подхватит xterm `attachCustomKeyEventHandler` или composer textarea в SDK-табах. Double-safety guard в обоих `attachCustomKeyEventHandler` в `Terminal.tsx` — на случай, если capture-flow пропустит событие, xterm всё равно вернёт `false` и литерал `T` не попадёт в Claude TUI.

Принцип — тот же, что у Opt+V picker'а: см. `fact-prompt-picker.md::Capture-phase listener`.

### Пустая история и ошибки видимы
Если `tab_history` пуста для активного проекта, App показывает toast *«Нет закрытых вкладок»*. Состояние `busy`, отсутствующая директория, ошибка создания, сохранения или удаления истории тоже возвращаются из общего restore-flow как явный результат: хоткей и Home не должны молча исчезать вместе с записью.

### Synchronous pulse feedback на TabBar
Между нажатием Shift+Cmd+T и появлением восстановленной вкладки проходит 300–800мс — это IPC round-trip к main + `terminal:create` + (если был жив процесс) Claude resume handshake через bracketed paste. На быстром железе незаметно, на свежем Claude-старте — хорошо видно. Без обратной связи хоткей кажется глухим: юзер успевает повторно нажать, думая что первое нажатие не дошло.

Решение — мгновенный subtle pulse на фоне `TabBar`. Цепочка: App.tsx capture listener синхронно (в том же frame, что и keydown) вызывает `useUIStore.triggerReopenPulse()` → флаг `reopenPulseActive: true` → TabBar render'ит абсолютный overlay с классом `animate-reopen-pulse` → setTimeout 600мс сбрасывает флаг. Pulse — два цикла по 300мс ease-in-out, изменяет `background-color` от `rgba(255,255,255,0)` до `rgba(255,255,255,0.05)` (приглушённое осветление, не цветовая вспышка).

Несколько важных деталей:
- **Pulse вызывается ДО IPC**, не в `.then()`. Если ждать ответа от main — теряется весь смысл индикатора.
- **`background-color`, не `opacity`** (см. CLAUDE.md anti-pattern «AI-Optimized UI & Video Forensics» — opacity-анимации съедаются H.264-кодеком на скринкастах).
- **`pointer-events-none` + `aria-hidden`** на overlay — клики по табам не должны блокироваться индикатором.
- **600мс совпадает с типичной верхней границей задержки** — когда вкладка появляется, pulse как раз заканчивается; перекрытие читается как «вспышка → вкладка», без визуального разрыва.

Принцип переносимый — мгновенный визуальный ack на действия с задержкой выполнения. См. `methodology/дизайн-принципы.md::Synchronous feedback для async-операций`.

## Schema migration
```sql
ALTER TABLE tabs ADD COLUMN name_set_manually INTEGER DEFAULT 0;
ALTER TABLE tab_history ADD COLUMN name_set_manually INTEGER DEFAULT 0;
ALTER TABLE tab_history ADD COLUMN position INTEGER DEFAULT NULL;
ALTER TABLE tab_history ADD COLUMN process_was_running INTEGER DEFAULT 0;
ALTER TABLE tab_history ADD COLUMN group_id TEXT DEFAULT NULL;
```

Старые записи (созданные до миграции) попадают с `position=NULL`, `process_was_running=0`, `group_id=NULL`, `name_set_manually=0`. Они восстанавливаются в конец TabBar и без group assignment. Home по явному Resume продолжает AI-сессию при наличии id; Shift+Cmd+T для такой старой записи открывает её idle, потому что доказательства живого процесса на момент закрытия нет.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `src/main/database.js` | Колонки `name_set_manually`, `position`, `process_was_running`, `group_id` в `tab_history`; `archiveTab` принимает их. Read-by-id/latest отделён от удаления. |
| `src/main/main.js` + `tab-history-restore-leases.js` | IPC begin/finish резервирует project-scoped row и удаляет её только при commit после успешного сохранения replacement. |
| `src/renderer/store/useWorkspaceStore.ts::closeTab` | Для Codex получает атомарный archive snapshot из main и архивирует до kill; для остальных runtime сохраняет position, `nameSetManually`, `groupId` и их process-state. Ошибка archive отменяет закрытие. |
| `src/renderer/store/useWorkspaceStore.ts::restoreTabHistoryEntry` | Общая транзакция Home/hotkey: begin lease → CWD preflight → create/reorder → awaited save → commit. Для Codex auto-fallback в project root разрешён только когда исходный путь равен проекту или был вложен в него. Похожий обрезанный basename и любой generic nearest parent — лишь предположение: UI показывает оба пути и требует подтверждения; fallback в `/` заменяется явным folder picker. |
| `src/renderer/store/useWorkspaceStore.ts::reopenLastClosedTab` | Сравнивает оба вида закрытия, сериализует Shift+Cmd+T по окну и сохраняет консервативную политику Continue. |
| `src/renderer/utils/splitPanesModel.mjs::remember/restorePaneDetachedTab` | Хранит порядок/позицию локально снятых chips и возвращает конкретную выбранную запись без нового runtime. |
| `src/renderer/components/Workspace/ProjectHome.tsx::restoreTab` | Вызывает тот же общий restore-flow с явной Home-политикой Resume; при ошибке карточка остаётся в истории. |
| `src/renderer/App.tsx::handleReopenLastClosedCapture` | Capture-phase keydown listener (`Shift+Cmd+T`). |
| `src/renderer/components/Workspace/Terminal.tsx` (оба `attachCustomKeyEventHandler`) | Swallow Shift+Cmd+T чтобы `T` не утёк в PTY. |

## Связанные системы
- **History в ProjectHome** (`fact-project-home.md`) — тот же `tab_history` и тот же reserve/create/save/commit flow. Home и Shift+Cmd+T могут конкурировать за запись, но lease разрешает только одного владельца; проигравшая точка входа получает `busy`, а не дубликат или потерю строки.
- **SessionActionChip Continue** (`fact-ai-sessions.md`) — тот же `pendingAction: claude-continue`, тот же путь IPC. Shift+Cmd+T здесь — фактически «закрыл живой Claude и сразу хочу его обратно».
- **Automatic interrupted recovery** (`fix-interrupted-session-lifecycle.md`) — отдельный механизм для восстановления живых AI-сессий **после краша приложения**. Он использует frozen shutdown-набор и `wasInterrupted`, но не blocking overlay; Shift+Cmd+T работает по `tab_history`. Юзер закрыл вкладку в живом приложении → tab_history. Приложение упало → последовательный AutoResume.

## Что НЕ делаем
- **Не сохраняем serialized terminal buffer** для воcстановления визуального содержимого PTY. Buffer уже теряется на close (`clearTerminalBuffer(tabId)`), переписывать pipeline ради hotkey-фичи слишком дорого — для Claude/Gemini полный контекст всё равно восстанавливается через `--resume` + JSONL, а для bash/devServer визуальный буфер и так каждый раз пересоздаётся при следующем запуске.
- **Не пытаемся переподнять убитый PID**. `terminal:kill` сразу при close уничтожает PTY; reopen создаёт новый PTY через `terminal:create`. Для AI это нормально (resume идёт по sessionId), для script-табов юзер просто получит чистый shell в правильной CWD.

## Что пробовали и не сработало (graveyard)
- **Безусловный приоритет локального undo над Full** —29.09 вернул834 вместо последней закрытой «передача ios-skill»919. Раздельные источники хранения не означают раздельный смысл «последняя»: сравниваются действия одного окна. Этот класс воспроизводится actual hotkey/store и private Electron с реальной SQLite; installed-приёмка отдельно от source.
- **Single shared «last-closed» memory slot в store** (без БД) — терялся при перезапуске приложения, плюс не учитывал per-project scope. Перешли на `tab_history` ровно потому, что юзер уже ожидает «закрытое не теряется» от существующей History-секции в ProjectHome.
- **Подсветка позиции через `afterTabId`** в `createTabAfterCurrent` — не подходит для index=0 (нет «таба перед которым» вставлять). Сделали через Map-rebuild после createTab, без вмешательства в общий createTab-pipeline.
- **Авто-Continue безусловно по наличию `claude_session_id`** — старое поведение `ProjectHome::restoreTab`. Для Shift+Cmd+T отказались: юзер часто закрывает вкладку *именно потому что Claude уже остановлен и работа закончена*, авто-resume в этом случае был бы шумным.
