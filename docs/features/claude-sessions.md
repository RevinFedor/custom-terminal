# Feature: Claude Session Management

## Intro
Система глубокой интеграции с Claude Code CLI. Позволяет приложению "владеть" сессиями AI-агента, обеспечивая бесшовное продолжение работы и безопасное ветвление (fork) контекста.

## User Flow: Умный запуск
В панели управления командами доступен расширенный UI для Claude:
- **Default Prompt:** Кнопка Claude показывает бейдж "Default" при наличии предустановленного промпта. Наведение на бейдж мгновенно показывает текст промпта в тултипе.
- **Extra Context:** Команду можно раскрыть (▶), чтобы дописать дополнительный текст к промпту перед запуском.
- **Copy Session:** Кнопка в секции Actions позволяет скопировать весь текущий диалог в буфер обмена с автоматической очисткой кода для переноса в другие AI.

## Behavior Specs
- **Clean Export:** При копировании сессии блоки кода заменяются на компактные метки (`📄 Чтение`, `✏️ Редактирование`). См. `knowledge/fix-claude-clean-export.md`.
- **Backtrace Timeline:** История сессии отображается на вертикальном таймлайне с фильтрацией Undo-веток. См. `features/timeline.md`.
- **Interrupted Recovery:** При аварийном закрытии показывается оверлей. Выбор пользователя (закрыть оверлей) сохраняется в БД. См. `knowledge/fix-interrupted-overlay-persistence.md`.


## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/TerminalArea.tsx` — рендеринг `InterruptedOverlay` через `Layering Pattern`.
- **PendingAction:** `src/renderer/components/Workspace/Terminal.tsx` — обработка `pendingAction` при первом PTY output (`executePendingAction`).
- **Logic:** `src/renderer/components/Workspace/TabBar.tsx` — метод `checkProcessStatus` очищает сессию при нормальном выходе.
- **Main (Runner):** `src/main/main.js` — IPC-хендлер `claude:run-command` с логикой глобального поиска файлов `.jsonl`.
- **State:** `useWorkspaceStore.ts` — хранение `pendingAction`, `wasInterrupted` и `claudeSessionId`.
