# Feature: Reopen Last Closed Tab (Shift+Cmd+T)

## Intro
VS Code-стиль: `Shift+Cmd+T` возвращает последнюю закрытую вкладку текущего проекта обратно в TabBar. Повторное нажатие восстанавливает предпоследнюю, и так далее, пока история не опустеет. Источник — та же таблица `tab_history`, что и History-секция в `ProjectHome`; реализация переиспользует существующий `restoreTab`-flow (pendingAction → createTab), а не дублирует его.

Source: `src/renderer/App.tsx::handleReopenLastClosedCapture`, `src/renderer/store/useWorkspaceStore.ts::reopenLastClosedTab`, `src/main/main.js::project:reopen-last-closed-tab`, `src/main/database.js::popLatestTabHistory`.

## Behavior

### Восстановление с позицией
Вкладка возвращается **примерно на то же место в TabBar**, где была до закрытия. В момент `closeTab` индекс вкладки в main-зоне (без sub-agent / utility) пишется в новое поле `tab_history.position`. При reopen этот индекс используется как подсказка — clamp'ится в `[0, mainZone.length]`, если соседние вкладки за это время сдвинулись или закрылись.

Позиция — именно **hint**, а не контракт. Если юзер успел закрыть три вкладки слева и открыть две новые, точную «прежнюю позицию» восстановить невозможно — клемп гарантирует, что новая вкладка хотя бы не вылезет за пределы main-зоны (utility всегда после main).

### Continue Session — авто-decision по live-state
Для Claude/Gemini-вкладок ключевой вопрос: запускать ли `claude-c --resume <sessionId>` при reopen, или просто открыть таб без процесса. Решение зависит от того, **был ли CLI жив на момент закрытия**:

- Был жив (OSC 133 говорил «processing») → новая вкладка получает `pendingAction: { type: 'claude-continue', sessionId }`. Это тот же путь, что у `SessionActionChip → Continue` (см. `fact-ai-sessions.md::SessionActionChip`).
- Был уже остановлен (юзер сам нажал Ctrl+C перед закрытием) → `pendingAction = undefined`. Таб открывается в idle-состоянии, юзер при желании жмёт Continue из InfoPanel.

Признак сохраняется в `tab_history.process_was_running` (0/1) на закрытии. Источник — `terminal:getCommandState` IPC (OSC 133-based, не PID-scan). Для `claude-sdk` табов аналогом служит `tab.claudeBusy` — тот же флаг, который читает `SessionActionChip` для tri-state Continue/Stop.

Без этой логики reopen приводил бы к одному из двух плохих сценариев: либо всегда auto-resume → Claude запускается даже когда юзер хотел просто заархивировать историю → переплата токенов; либо никогда не resume → юзер закрыл живой Claude нечаянно и теряет процесс. Бинарный сигнал `processWasRunning` снимает оба этих случая.

### Атомарный pop из истории
Main-side handler `project:reopen-last-closed-tab` делает `SELECT ... ORDER BY closed_at DESC LIMIT 1` + `DELETE WHERE id = ?` в одной транзакции SQLite (метод `popLatestTabHistory`). Не два отдельных IPC, как при restore из ProjectHome. Иначе при двойном нажатии Shift+Cmd+T в течение 100мс оба бы прочитали одну и ту же top-row и попытались её восстановить.

После delete запись пропадает и из History в ProjectHome — это сознательно, тот же контракт, что у Restore-клика по карточке.

### Layout-agnostic hotkey через `event.code`
App-level capture listener: `e.metaKey && e.shiftKey && e.code === 'KeyT'` (см. `methodology/design.md::Layout-agnostic shortcuts`). На QWERTY/Cyrillic/Dvorak — одна и та же физическая клавиша T. `e.preventDefault + stopPropagation + stopImmediatePropagation` глушит событие до того, как его подхватит xterm `attachCustomKeyEventHandler` или composer textarea в SDK-табах. Double-safety guard в обоих `attachCustomKeyEventHandler` в `Terminal.tsx` — на случай, если capture-flow пропустит событие, xterm всё равно вернёт `false` и литерал `T` не попадёт в Claude TUI.

Принцип — тот же, что у Opt+V picker'а: см. `fact-prompt-picker.md::Capture-phase listener`.

### Поведение при пустой истории
Если `tab_history` пуста для активного проекта, IPC возвращает `{ entry: null }`, store-action возвращает `{ tabId: null, reason: 'empty' }`, App.tsx показывает toast *«Нет закрытых вкладок»*. Без toast хоткей выглядел бы немым (наживаешь — ничего не происходит — непонятно, услышан ли).

### Synchronous pulse feedback на TabBar
Между нажатием Shift+Cmd+T и появлением восстановленной вкладки проходит 300–800мс — это IPC round-trip к main + `terminal:create` + (если был жив процесс) Claude resume handshake через bracketed paste. На быстром железе незаметно, на свежем Claude-старте — хорошо видно. Без обратной связи хоткей кажется глухим: юзер успевает повторно нажать, думая что первое нажатие не дошло.

Решение — мгновенный subtle pulse на фоне `TabBar`. Цепочка: App.tsx capture listener синхронно (в том же frame, что и keydown) вызывает `useUIStore.triggerReopenPulse()` → флаг `reopenPulseActive: true` → TabBar render'ит абсолютный overlay с классом `animate-reopen-pulse` → setTimeout 600мс сбрасывает флаг. Pulse — два цикла по 300мс ease-in-out, изменяет `background-color` от `rgba(255,255,255,0)` до `rgba(255,255,255,0.05)` (приглушённое осветление, не цветовая вспышка).

Несколько важных деталей:
- **Pulse вызывается ДО IPC**, не в `.then()`. Если ждать ответа от main — теряется весь смысл индикатора.
- **`background-color`, не `opacity`** (см. CLAUDE.md anti-pattern «AI-Optimized UI & Video Forensics» — opacity-анимации съедаются H.264-кодеком на скринкастах).
- **`pointer-events-none` + `aria-hidden`** на overlay — клики по табам не должны блокироваться индикатором.
- **600мс совпадает с типичной верхней границей задержки** — когда вкладка появляется, pulse как раз заканчивается; перекрытие читается как «вспышка → вкладка», без визуального разрыва.

Принцип переносимый — мгновенный визуальный ack на действия с задержкой выполнения. См. `methodology/design.md::Synchronous feedback для async-операций`.

## Schema migration
```sql
ALTER TABLE tab_history ADD COLUMN position INTEGER DEFAULT NULL;
ALTER TABLE tab_history ADD COLUMN process_was_running INTEGER DEFAULT 0;
```

Старые записи (созданные до миграции) попадают с `position=NULL`, `process_was_running=0`. Поведение для них: вкладка восстанавливается в конец TabBar, без auto-continue. Это совместимо со старым `ProjectHome::restoreTab`, который и сейчас даёт `pendingAction = 'claude-continue'` если есть `claude_session_id` — просто Shift+Cmd+T здесь чуть консервативнее по умолчанию (только живой процесс).

## Path-зависимости

| Файл | Что делает |
|---|---|
| `src/main/database.js` | Колонки `position`, `process_was_running` в `tab_history`. `archiveTab` принимает их. Новый метод `popLatestTabHistory(projectId)`. |
| `src/main/main.js` | IPC `project:reopen-last-closed-tab` (pop + return). |
| `src/renderer/store/useWorkspaceStore.ts::closeTab` | Перед archive снимает `commandState.isRunning` (OSC 133) и position в main-зоне. |
| `src/renderer/store/useWorkspaceStore.ts::reopenLastClosedTab` | Pop через IPC → createTab с pendingAction (по condition `wasRunning`) → re-order в Map по `position` → switchTab. |
| `src/renderer/App.tsx::handleReopenLastClosedCapture` | Capture-phase keydown listener (`Shift+Cmd+T`). |
| `src/renderer/components/Workspace/Terminal.tsx` (оба `attachCustomKeyEventHandler`) | Swallow Shift+Cmd+T чтобы `T` не утёк в PTY. |

## Связанные системы
- **History в ProjectHome** (`fact-project-home.md`) — тот же `tab_history`. Restore-клик через карточку и Shift+Cmd+T теперь конкурируют за одни и те же записи: что бы ни сделал юзер первым, запись удаляется атомарно. Конкретно: `restoreTab` в ProjectHome.tsx использует пары `get-tab-history` + `delete-tab-history-entry`, наш hotkey — атомарный pop. Сосуществуют без коллизий, но если делать обе операции одновременно (что нереально для человека), state'ы могут разъехаться на одну запись — это acceptable.
- **SessionActionChip Continue** (`fact-ai-sessions.md`) — тот же `pendingAction: claude-continue`, тот же путь IPC. Shift+Cmd+T здесь — фактически «закрыл живой Claude и сразу хочу его обратно».
- **InterruptedOverlay** (`fix-interrupted-session-lifecycle.md`) — отдельный механизм для restore Claude-сессий **после краша приложения**. Не путать: Interrupted работает по `wasInterrupted` флагу таба, Shift+Cmd+T — по `tab_history` записи. Юзер закрыл вкладку в живом приложении → tab_history. Приложение упало → wasInterrupted.

## Что НЕ делаем
- **Не сохраняем serialized terminal buffer** для воcстановления визуального содержимого PTY. Buffer уже теряется на close (`clearTerminalBuffer(tabId)`), переписывать pipeline ради hotkey-фичи слишком дорого — для Claude/Gemini полный контекст всё равно восстанавливается через `--resume` + JSONL, а для bash/devServer визуальный буфер и так каждый раз пересоздаётся при следующем запуске.
- **Не пытаемся переподнять убитый PID**. `terminal:kill` сразу при close уничтожает PTY; reopen создаёт новый PTY через `terminal:create`. Для AI это нормально (resume идёт по sessionId), для script-табов юзер просто получит чистый shell в правильной CWD.

## Что пробовали и не сработало (graveyard)
- **Single shared «last-closed» memory slot в store** (без БД) — терялся при перезапуске приложения, плюс не учитывал per-project scope. Перешли на `tab_history` ровно потому, что юзер уже ожидает «закрытое не теряется» от существующей History-секции в ProjectHome.
- **Подсветка позиции через `afterTabId`** в `createTabAfterCurrent` — не подходит для index=0 (нет «таба перед которым» вставлять). Сделали через Map-rebuild после createTab, без вмешательства в общий createTab-pipeline.
- **Авто-Continue безусловно по наличию `claude_session_id`** — старое поведение `ProjectHome::restoreTab`. Для Shift+Cmd+T отказались: юзер часто закрывает вкладку *именно потому что Claude уже остановлен и работа закончена*, авто-resume в этом случае был бы шумным.
