# Feature: Reopen Last Closed Tab (Shift+Cmd+T)

## Intro
VS Code-стиль: `Shift+Cmd+T` возвращает последнее закрытое размещение или вкладку. В split-mode первым источником служит pane-local `detachedTabs`: middle-click/Cmd+W убирает chip из окна, но не закрывает живую вкладку. Если локального undo нет, источник — та же таблица `tab_history`, что и History-секция в `ProjectHome`; Home и архивная половина хоткея идут через один store-flow с общими CWD-проверками, созданием вкладки, durable save и commit истории. Повторные нажатия продолжают идти назад по соответствующей истории.

Source: `src/renderer/App.tsx::handleReopenLastClosedCapture`, `src/renderer/store/useWorkspaceStore.ts::restoreTabHistoryEntry/reopenLastClosedTab`, `src/main/main.js::project:begin-tab-history-restore/project:finish-tab-history-restore`, `src/main/database.js::getLatestTabHistory/getTabHistoryEntry/deleteTabHistoryEntry`.

## Behavior

### Сфокусированное окно владеет жестом

В split-режиме `Shift+Cmd+T` фиксирует `splitFocusedIndex` в момент keydown и восстанавливает вкладку именно в это окно. Проект берётся у заполненной панели; пустая панель наследует проект бокового списка. Restore создаёт вкладку с `background:true`, проходит прежнюю транзакцию reserve → create → durable save → commit и только затем вставляет tab id в зафиксированный слот через `addTabToSplitPaneStrip`. Поэтому новая строка не может стать «активной в проекте», оставив окно пустым.

Локальное удаление не проходит archive/create: tab уже живёт в проекте. Снятый chip записывается в `detachedTabs` той pane, последний chip оставляет фокус на пустом slot, а hotkey сначала вызывает `restoreLastDetachedTabToSplitPane`. Запись reproject'ится при смене project owner и очищается при полном Close. Только отсутствие возвращаемой локальной записи разрешает обращаться к `tab_history`; иначе случайный старый архив занял бы соседнее окно вместо только что убранного chip.

Если пользователь успел удалить целевую панель, операция не пропадает: восстановленная вкладка активируется обычным центром. В одиночном режиме поведение остаётся прежним. Быстрые повторы всё так же сериализованы per-project; выбор окна не ослабляет lease истории.

### Восстановление с позицией
Вкладка возвращается **примерно на то же место в TabBar**, где была до закрытия. В момент `closeTab` индекс вкладки в main-зоне (без sub-agent / utility) пишется в новое поле `tab_history.position`. При reopen этот индекс используется как подсказка — clamp'ится в `[0, mainZone.length]`, если соседние вкладки за это время сдвинулись или закрылись.

Позиция — именно **hint**, а не контракт. Если юзер успел закрыть три вкладки слева и открыть две новые, точную «прежнюю позицию» восстановить невозможно — клемп гарантирует, что новая вкладка хотя бы не вылезет за пределы main-зоны (utility всегда после main).

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

Lease не даёт Home и хоткею одновременно восстановить одну строку, а per-project очередь Shift+Cmd+T превращает быстрые повторные нажатия в последовательный проход назад по истории. Если предыдущая queued-операция не consumed row из-за cancel/create/save/cleanup failure, следующий уже поставленный keypress останавливается: иначе он немедленно создал бы второй live-tab из той же latest-row. Lease ограничена по времени: renderer reload/crash без `finish` не делает строку навсегда занятой. Это исправляет старую ошибочную модель, где начало операции принималось за её успех и запись удалялась до `createTab`.

### Layout-agnostic hotkey через `event.code`
App-level capture listener: `e.metaKey && e.shiftKey && e.code === 'KeyT'` (см. `methodology/переносимый-дизайн.md::Layout-agnostic shortcuts`). На QWERTY/Cyrillic/Dvorak — одна и та же физическая клавиша T. `e.preventDefault + stopPropagation + stopImmediatePropagation` глушит событие до того, как его подхватит xterm `attachCustomKeyEventHandler` или composer textarea в SDK-табах. Double-safety guard в обоих `attachCustomKeyEventHandler` в `Terminal.tsx` — на случай, если capture-flow пропустит событие, xterm всё равно вернёт `false` и литерал `T` не попадёт в Claude TUI.

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

Принцип переносимый — мгновенный визуальный ack на действия с задержкой выполнения. См. `methodology/переносимый-дизайн.md::Synchronous feedback для async-операций`.

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
| `src/renderer/store/useWorkspaceStore.ts::reopenLastClosedTab` | Сериализует Shift+Cmd+T по проекту и выбирает консервативную политику Continue. |
| `src/renderer/utils/splitPanesModel.mjs::remember/restorePaneDetachedTab` | Хранит и возвращает локально снятые chips конкретного окна до обращения к архиву. |
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
- **Single shared «last-closed» memory slot в store** (без БД) — терялся при перезапуске приложения, плюс не учитывал per-project scope. Перешли на `tab_history` ровно потому, что юзер уже ожидает «закрытое не теряется» от существующей History-секции в ProjectHome.
- **Подсветка позиции через `afterTabId`** в `createTabAfterCurrent` — не подходит для index=0 (нет «таба перед которым» вставлять). Сделали через Map-rebuild после createTab, без вмешательства в общий createTab-pipeline.
- **Авто-Continue безусловно по наличию `claude_session_id`** — старое поведение `ProjectHome::restoreTab`. Для Shift+Cmd+T отказались: юзер часто закрывает вкладку *именно потому что Claude уже остановлен и работа закончена*, авто-resume в этом случае был бы шумным.
