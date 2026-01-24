# Feature: Claude Session Management

## Intro
Система глубокой интеграции с Claude Code CLI. Позволяет приложению "владеть" сессиями AI-агента, обеспечивая бесшовное продолжение работы и безопасное ветвление (fork) контекста.

## Behavior Specs
Управление осуществляется через **InfoPanel** (правая панель) и автоматический перехват ввода.

### Команды и UI-кнопки (⑂):
- `claude`: Запуск новой сессии. Включает [Sniper Watcher](../../knowledge/fix-claude-id-capture.md).
- `claude-c`: Продолжить сессию.
- `⑂ Fork в новую вкладку`: (Smart Fork) Создает копию текущей сессии Claude. Использует [PendingAction Pattern](../architecture.md#3-pendingaction-pattern) — создаёт новую вкладку с `pendingAction: { type: 'claude-fork', sessionId }`, которое выполняется автоматически после готовности shell.
- `claude-f <UUID>`: (Команда) Находит сессию по указанному UUID во ВСЕХ директориях `~/.claude/projects/` и запускает форк в текущем терминале.

### Interrupted Sessions (⚠️)
Система отслеживает статус завершения работы Claude CLI.
- **Детекция:** Если приложение закрывается (или крэшится) при активном процессе Claude, вкладке присваивается статус `wasInterrupted = true`.
- **Overlay:** При следующем открытии такой вкладки поверх терминала отображается полупрозрачный блюр-оверлей с модальным окном "Сессия была прервана".
- **Действия:**
    - Кнопка **"Продолжить сессию"** запускает `claude --resume <sessionId>` и снимает оверлей.
    - Клик на фон просто снимает оверлей, позволяя работать в терминале.
- **Очистка:** Если процесс завершился нормально (через Ctrl+C или `exit`), статус `wasInterrupted` и `claudeSessionId` автоматически очищаются через поллинг статуса процесса.

### Claude Runner (Main Process):
Команды проходят через IPC-канал `claude:run-command`. Main-процесс при форке теперь сканирует все подпапки в `~/.claude/projects/`, что позволяет форкать сессии, созданные в других проектах или через внешние терминалы.

## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/TerminalArea.tsx` — рендеринг `InterruptedOverlay` через `Layering Pattern`.
- **PendingAction:** `src/renderer/components/Workspace/Terminal.tsx` — обработка `pendingAction` при первом PTY output (`executePendingAction`).
- **Logic:** `src/renderer/components/Workspace/TabBar.tsx` — метод `checkProcessStatus` очищает сессию при нормальном выходе.
- **Main (Runner):** `src/main/main.js` — IPC-хендлер `claude:run-command` с логикой глобального поиска файлов `.jsonl`.
- **State:** `useWorkspaceStore.ts` — хранение `pendingAction`, `wasInterrupted` и `claudeSessionId`.
