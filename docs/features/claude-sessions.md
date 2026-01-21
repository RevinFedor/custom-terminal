# Feature: Claude Session Management

## Intro
Система глубокой интеграции с Claude Code CLI. Позволяет приложению "владеть" сессиями AI-агента, обеспечивая бесшовное продолжение работы и безопасное ветвление (fork) контекста.

## Behavior Specs
Управление осуществляется через **InfoPanel** (правая панель) и автоматический перехват ввода.

### Команды и UI-кнопки (⑂):
- `claude`: Запуск новой сессии. Включает [Sniper Watcher](../../knowledge/fix-claude-id-capture.md). Кнопка в InfoPanel всегда активна.
- `claude-c`: Продолжить сессию. Кнопка активна только при наличии захваченного UUID.
- `claude-f <UUID>`: (Smart Fork) Создает полную копию сессии. Кнопка **⑂ Fork** в InfoPanel берет UUID из буфера обмена, валидирует его (Regex) и автоматически инициирует форк.

### Claude Runner (Main Process):
Команды, запущенные через кнопки UI, проходят через выделенный IPC-канал `claude:run-command`. Это гарантирует корректное выполнение (исключает `command not found`) и позволяет Main-процессу предварительно подготовить окружение (например, скопировать файлы для форка).

### Session Watcher:
Main-процесс активно следит за директорией `~/.claude/projects/` на предмет появления новых файлов `.jsonl`. При обнаружении — автоматически отправляет событие `claude:session-detected` в Renderer для обновления UI.

## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — интерактивные кнопки управления сессиями.
- **Renderer (Logic):** `src/renderer/components/Workspace/TerminalArea.tsx` — обработка события `claude:fork-complete` и создание новых табов.
- **Main (Runner):** `src/main/main.js` — IPC-хендлер `claude:run-command`, логика файлового копирования и вочер сессий.
- **State:** `useWorkspaceStore.ts` — хранение и персистентность `claudeSessionId`.
