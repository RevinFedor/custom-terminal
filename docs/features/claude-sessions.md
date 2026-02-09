# Feature: Claude Session Management

## Intro
Система глубокой интеграции с Claude Code CLI. Позволяет приложению "владеть" сессиями AI-агента, обеспечивая бесшовное продолжение работы и безопасное ветвление (fork) контекста.

## User Flow: Умный запуск
В панели управления командами доступен расширенный UI для Claude:
- **Default Prompt:** Кнопка Claude показывает бейдж "Default" при наличии предустановленного промпта. Наведение на бейдж мгновенно показывает текст промпта в тултипе.
- **Extra Context:** Команду можно раскрыть (▶), чтобы дописать дополнительный текст к промпту перед запуском.
- **Manual Session Input (✎):** Если автоматическая детекция не сработала, пользователь может нажать иконку "Карандаш" в блоке сессии и вставить UUID вручную. Система автоматически извлечет UUID из любого текста (пути или ссылки) через regex.
- **Copy Session:** Кнопка в секции Actions позволяет скопировать весь текущий диалог в буфер обмена с автоматической очиской кода для переноса в другие AI.

## Identification & Monitoring
Система использует несколько уровней для надежного захвата ID сессии:

### 1. StatusLine Bridge (Основной метод)
Приложение настраивает Claude Code через `~/.claude/settings.json` на использование внешнего скрипта `statusLine`.
- **Механизм:** После каждого ответа Claude вызывает наш скрипт-мост.
- **Данные:** Скрипт записывает актуальный `session_id` и `ppid` (PID процесса Claude) в `~/.claude/bridge/`.
- **Синхронизация:** Main процесс следит за папкой и мгновенно сопоставляет PID Клода с конкретной вкладкой терминала. Это гарантирует 100% точность даже при параллельной работе в одной папке.
- **Plan Mode:** Позволяет автоматически обновлять ID в UI, когда пользователь делает Clear Context или переходит в Plan Mode внутри того же процесса.

### 2. /status Interception (Отладка)
Приложение перехватывает вывод команды `/status` напрямую из PTY-потока.
- Если пользователь вводит `/status` в терминале, система парсит текст, извлекает UUID и показывает Toast-уведомление с текущим статусом синхронизации.

### 3. Immediate Injection
При восстановлении из History (Project Home) или при выполнении Fork, `claudeSessionId` передается в таб мгновенно, не дожидаясь ответов от Claude.

### 4. Legacy: Sniper Watcher
Старый метод отслеживания файлов через `fs.watch` признан устаревшим и перенесен в базу знаний: `docs/knowledge/fact-legacy-sniper-watcher.md`.

## Handshake (Thinking Mode + Prompt Injection)
Стейт-машина для автоматического включения thinking mode и отправки промпта:

```
WAITING_PROMPT → DEBOUNCE_PROMPT → TAB_SENT → READY
```

### Шаги
1. **WAITING_PROMPT:** Ждёт появления prompt-символа (`⏵` для Claude v2.1.32+ или `>` для старых версий). Используется `stripVTControlCharacters()` для очистки ANSI.
2. **DEBOUNCE_PROMPT:** Задержка 200мс после обнаружения промпта (Claude может вывести несколько строк).
3. **TAB_SENT:** Отправляет `\t` (Tab) для включения thinking mode. Ждёт второго появления промпта.
4. **READY:** Если есть `pendingPrompt`, отправляет его через Safe Write (chunked bracketed paste). См. `knowledge/terminal-core.md`.

## Behavior Specs
- **Claude Process Monitor:** Виджет на Dashboard для отслеживания всех запущенных в системе процессов Claude CLI.
    - **In-App:** Процессы, запущенные из терминалов приложения. Отображаются с указанием "Имя Проекта / Имя Таба".
    - **External:** Процессы, запущенные во внешних терминалах (iTerm, Terminal.app).
    - **Manual Stop:** Каждая карточка процесса имеет кнопку "Stop" (Square icon), которая отправляет сигнал `kill` процессу.
- **Clean Export:** При копировании сессии блоки кода заменяются на компактные метки. См. `knowledge/ai-automation.md`.
- **Hierarchical Session Tree:** Заголовок экспорта содержит вложенную структуру сессий.
    - **Метки:** `(root)`, `(plan mode)` (новый файл через clear context), `(fork)` (клон файла).
    - **Индикаторы:** `*` помечает активную ветку, `♻️ ×N` показывает количество сжатий контекста в сегменте.
    - **Stats:** Напротив каждой сессии отображается количество сообщений (`messages`).
- **Backtrace Timeline:** История сессии отображается на вертикальном таймлайне с фильтрацией Undo-веток. См. `features/timeline.md`.
- **Interrupted Recovery:** При аварийном закрытии показывается оверлей. Выбор пользователя сохраняется в БД. См. `knowledge/ui-ux-stability.md`.
- **Session Waiting State:** Промежуточное состояние "Ожидание сессии..." с пульсирующим жёлтым индикатором. См. `knowledge/ai-automation.md`.
- **History Restore:** При восстановлении из History `claudeSessionId` передаётся напрямую в `createTab()` (Immediate Injection). См. `features/project-home.md`.

## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/TerminalArea.tsx` — рендеринг `InterruptedOverlay` через `Layering Pattern`.
- **PendingAction:** `src/renderer/components/Workspace/Terminal.tsx` — обработка `pendingAction` при первом PTY output (`executePendingAction`).
- **Logic:** `src/renderer/components/Workspace/TabBar.tsx` — метод `checkProcessStatus` очищает сессию при нормальном выходе.
- **Main (Sniper):** `src/main/main.js` — функция `startSessionSniper()` (dual-method: fs.watch + polling).
- **Main (Runner):** `src/main/main.js` — IPC `claude:run-command` (switch: `claude`, `claude-c`, `claude-fork`).
- **Main (Handshake):** `src/main/main.js` — стейт-машина `claudeState` в обработчике `terminal:create` data.
- **State:** `useWorkspaceStore.ts` — хранение `pendingAction`, `wasInterrupted` и `claudeSessionId`.
