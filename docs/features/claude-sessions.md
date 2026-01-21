# Feature: Claude Session Management

## Intro
Система глубокой интеграции с Claude Code CLI. Позволяет приложению "владеть" сессиями AI-агента, обеспечивая бесшовное продолжение работы и безопасное ветвление (fork) контекста.

## Behavior Specs
Управление осуществляется через перехват ввода (Input Interception) в терминале.

### Команды:
- `claude`: Запуск новой сессии. Включает [Sniper Watcher](../../knowledge/fix-claude-id-capture.md) для захвата ID. Если в табе уже есть активная сессия, команда блокируется с предупреждением.
- `claude-c`: (Continue) Продолжить последнюю сессию этого таба. Использует сохраненный UUID.
- `claude-f <UUID>`: (Fork) Создает полную копию существующей сессии (копирование `.jsonl` файла) и запускает её в текущем табе под новым ID. Это позволяет безопасно экспериментировать, не ломая оригинальный контекст.

### Info Panel (Правая панель):
Вкладка **Notes** временно заменена на **Info**.
- **Status:** Визуальный индикатор (Active/None) наличия сессии в текущем табе.
- **Session ID:** UUID текущей активной сессии.
- **Commands:** Список доступных команд на русском языке с индикацией их готовности (например, `claude-c` неактивна, если нет ID).

## Code Map
- **Renderer (Logic):** `src/renderer/components/Workspace/Terminal.tsx` — перехват Enter через `attachCustomKeyEventHandler`.
- **Main (Logic):** `src/main/main.js` — реализация `Sniper Watcher` и IPC-хендлера `claude:fork-session-file`.
- **UI:** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — отображение статуса через polling (интервал 500мс) для предотвращения лишних рендеров терминала.
- **State:** `useWorkspaceStore.ts` — хранение и персистентность `claudeSessionId`.
