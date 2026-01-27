# Feature: Gemini Session Management

## Intro
Глубокая интеграция с Gemini CLI (0.25+). Обеспечивает захват сессий, их сохранение в базе данных и возможность полноценного ветвления (True Fork).

## Behavior Specs

### 1. Захват сессии (Gemini Sniper)
В отличие от Claude, Gemini создает файл сессии только после первого сообщения.
- **Watcher:** При вводе `gemini` активируется `fs.watch` на папку `~/.gemini/tmp/<hash>/chats/`.
- **Lifecycle:** Вочер не имеет короткого таймаута и живет до закрытия вкладки (или до обнаружения файла).
- **Detection:** При появлении файла `session-*.json` из него извлекается полный UUID (`sessionId`).

### 2. True Fork (Ветвление)
Обычный `gemini -r <id>` в новой вкладке приводит к тому, что оба терминала пишут в один файл. Для разделения контекста реализован True Fork:
1. Main-процесс находит оригинальный JSON-файл сессии.
2. Создает копию с новым UUID и текущим временем.
3. Патчит внутреннее поле `sessionId` в JSON.
4. Запускает Gemini с новым UUID.

### 3. Ограничения
- **Exclusive Session:** В одной вкладке может быть активна только одна AI-сессия (либо Claude, либо Gemini). Запуск второй блокируется с выводом предупреждения в терминал.

## Code Map
- **Main Logic:** `src/main/main.js` — хендлеры `gemini:spawn-with-watcher` и `gemini:run-command`.
- **Renderer UI:** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — переключатель режимов и кнопки управления.
- **Interception:** `src/renderer/components/Workspace/Terminal.tsx` — перехват ввода команд `gemini`, `gemini-c`.
- **State:** `src/renderer/store/useWorkspaceStore.ts` — хранение `geminiSessionId`.
