# Feature: Claude Session Management

## Intro
Система глубокой интеграции с Claude Code CLI. Позволяет приложению "владеть" сессиями AI-агента, обеспечивая бесшовное продолжение работы и безопасное ветвление (fork) контекста.

## User Flow: Умный запуск
В панели управления командами доступен расширенный UI для Claude:
- **Default Prompt:** Кнопка Claude показывает бейдж "Default" при наличии предустановленного промпта. Наведение на бейдж мгновенно показывает текст промпта в тултипе.
- **Extra Context:** Команду можно раскрыть (▶), чтобы дописать дополнительный текст к промпту перед запуском.
- **Copy Session:** Кнопка в секции Actions позволяет скопировать весь текущий диалог в буфер обмена с автоматической очисткой кода для переноса в другие AI.

## Sniper Watcher (Session ID Capture)
Механизм захвата UUID сессии при запуске Claude. Реализован как функция `startSessionSniper()` в `main.js`. См. `knowledge/fix-sniper-dual-method.md`.

### Алгоритм
1. **Snapshot:** Перед запуском Claude фиксируется список существующих `.jsonl` файлов в директории `~/.claude/projects/<slug>/`. Это позволяет отличить новый файл от старого.
2. **Двойная детекция:**
   - **fs.watch:** Слушает изменения в директории (может быть ненадёжным на macOS из-за задержки FSEvents init).
   - **Polling (1с):** Фоновый опрос `readdirSync` каждую секунду как надёжный fallback.
3. **Валидация:** Файл должен соответствовать UUID-паттерну (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.jsonl`), отсутствовать в snapshot, и иметь `birthtime >= startTime - 1000ms`.
4. **Результат:** При обнаружении отправляется IPC `claude:session-detected` → renderer устанавливает `claudeSessionId` в store.
5. **Таймаут:** 30 секунд. После этого sniper закрывается.

### Когда Sniper НЕ используется
- **Resume (`claude-c`):** ID сессии уже известен — передаётся как параметр.
- **History Restore:** ID берётся из SQLite (Immediate Injection). См. `features/project-home.md`.
- **Fork:** ID новой сессии будет пойман Sniper'ом, но ID родительской передаётся напрямую.

### Ограничение Claude CLI
Claude CLI создаёт `.jsonl` файл **только после первого обмена сообщениями**. При запуске без Default Prompt Sniper не срабатывает до тех пор, пока пользователь не введёт первый промпт. В этот период InfoPanel показывает "Ожидание сессии..." (см. `knowledge/fix-session-waiting-state.md`).

## Handshake (Thinking Mode + Prompt Injection)
Стейт-машина для автоматического включения thinking mode и отправки промпта:

```
WAITING_PROMPT → DEBOUNCE_PROMPT → TAB_SENT → READY
```

### Шаги
1. **WAITING_PROMPT:** Ждёт появления prompt-символа (`⏵` для Claude v2.1.32+ или `>` для старых версий). Используется `stripVTControlCharacters()` для очистки ANSI.
2. **DEBOUNCE_PROMPT:** Задержка 200мс после обнаружения промпта (Claude может вывести несколько строк).
3. **TAB_SENT:** Отправляет `\t` (Tab) для включения thinking mode. Ждёт второго появления промпта.
4. **READY:** Если есть `pendingPrompt`, отправляет его через Safe Write (chunked bracketed paste). См. `knowledge/fix-pty-buffer-overflow.md`.

## Behavior Specs
- **Clean Export:** При копировании сессии блоки кода заменяются на компактные метки. См. `knowledge/fix-claude-clean-export.md`.
- **Backtrace Timeline:** История сессии отображается на вертикальном таймлайне с фильтрацией Undo-веток. См. `features/timeline.md`.
- **Interrupted Recovery:** При аварийном закрытии показывается оверлей. Выбор пользователя сохраняется в БД. См. `knowledge/fix-interrupted-overlay-persistence.md`.
- **Session Waiting State:** Промежуточное состояние "Ожидание сессии..." с пульсирующим жёлтым индикатором. См. `knowledge/fix-session-waiting-state.md`.
- **History Restore:** При восстановлении из History `claudeSessionId` передаётся напрямую в `createTab()` (Immediate Injection). См. `features/project-home.md`.

## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/TerminalArea.tsx` — рендеринг `InterruptedOverlay` через `Layering Pattern`.
- **PendingAction:** `src/renderer/components/Workspace/Terminal.tsx` — обработка `pendingAction` при первом PTY output (`executePendingAction`).
- **Logic:** `src/renderer/components/Workspace/TabBar.tsx` — метод `checkProcessStatus` очищает сессию при нормальном выходе.
- **Main (Sniper):** `src/main/main.js` — функция `startSessionSniper()` (dual-method: fs.watch + polling).
- **Main (Runner):** `src/main/main.js` — IPC `claude:run-command` (switch: `claude`, `claude-c`, `claude-fork`).
- **Main (Handshake):** `src/main/main.js` — стейт-машина `claudeState` в обработчике `terminal:create` data.
- **State:** `useWorkspaceStore.ts` — хранение `pendingAction`, `wasInterrupted` и `claudeSessionId`.
