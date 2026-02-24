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
- **Plan Mode:** Позволяет автоматически обновлять ID в UI, когда пользователь делает Clear Context или переходит в Plan Mode внутри того же процесса. При сбросе контекста (Clear Context) система фиксирует связь между старым и новым ID в SQLite для бесшовного восстановления истории. См. `knowledge/fix-claude-plan-mode-chain.md`.

### 2. /status Interception (Отладка)
Приложение перехватывает вывод команды `/status` напрямую из PTY-потока.
- Если пользователь вводит `/status` в терминале, система парсит текст, извлекает UUID и показывает Toast-уведомление с текущим статусом синхронизации.

### 3. Immediate Injection
При восстановлении из History (Project Home) или при выполнении Fork, `claudeSessionId` передается в таб мгновенно, не дожидаясь ответов от Claude.

### 4. Legacy: Sniper Watcher
Старый метод отслеживания файлов через `fs.watch` признан устаревшим и перенесен в базу знаний: `docs/knowledge/fact-legacy-sniper-watcher.md`.

## Handshake (Prompt Injection при запуске)
Упрощённая стейт-машина для автоматической отправки промпта:

```
WAITING_PROMPT → DEBOUNCE_PROMPT → send prompt → done
```

### Шаги
1. **WAITING_PROMPT:** Ждёт появления prompt-символа (`⏵` для Claude v2.1.32+ или `>` для старых версий). Используется `stripVTControlCharacters()` для очистки ANSI.
2. **DEBOUNCE_PROMPT:** Задержка 300мс после обнаружения промпта (Claude может вывести несколько строк).
3. **Send prompt:** Отправляет `pendingPrompt` через Bracketed Paste + delayed `\r`. См. `knowledge/terminal-core.md`.

Thinking mode при запуске обеспечивается `alwaysThinkingEnabled: true` в `~/.claude/settings.json`, Tab (`\t`) больше не отправляется.

## TUI Control (Model + Think)
Программное управление Claude TUI из интерфейса. См. `knowledge/fact-claude-tui-control.md`.

- **Model:** Кнопки sonnet/opus/haiku в InfoPanel → `/model <alias>` через bracketed paste. Текущая модель из bridge-данных.
- **Think:** Реактивный toggle через `meta+t` → парсинг TUI-пикера → auto-navigate → confirm. Обрабатывает второй диалог "Do you want to proceed?" автоматически.

### Ctrl-C Danger Zone Protection
Защита от случайного закрытия Claude при быстром переключении моделей.
- **Problem:** Первое нажатие Ctrl+C переводит Claude в режим подтверждения выхода. Вторая команда от UI (которая шлёт Ctrl+C для очистки инпута) убивает сессию.
- **Logic:** Система ловит маркер `again to exit` в PTY и блокирует выполнение новых команд до возврата промпта (с задержкой 3с).
- **Feedback:** Статус блокировки транслируется в Renderer через IPC `claude:ctrlc-danger-zone`.
- **Подробнее:** См. `knowledge/fix-claude-ctrlc-exit.md`.

## Behavior Specs
- **Claude Process Monitor:** Виджет на Dashboard для отслеживания всех запущенных в системе процессов Claude CLI.
    - **In-App:** Процессы, запущенные из терминалов приложения. Отображаются с указанием "Имя Проекта / Имя Таба".
    - **External:** Процессы, запущенные во внешних терминалах (iTerm, Terminal.app).
    - **Manual Stop:** Каждая карточка процесса имеет кнопку "Stop" (Square icon), которая отправляет сигнал `kill` процессу.
- **Clean Export:** При копировании сессии блоки кода заменяются на компактные метки. См. `knowledge/ai-export-session.md`.
- **Hierarchical Session Tree:** Заголовок экспорта содержит вложенную структуру сессий.
    - **Метки:** `(root)`, `(plan mode)` (новый файл через clear context), `(fork)` (клон файла).
    - **Индикаторы:** `*` помечает активную ветку, `♻️ ×N` показывает количество сжатий контекста в сегменте.
    - **Stats:** Напротив каждой сессии отображается количество сообщений (`messages`).
- **Backtrace Timeline:** История сессии отображается на вертикальном таймлайне с фильтрацией Undo-веток. См. `features/timeline.md`.
- **Interrupted Recovery:** При аварийном закрытии показывается оверлей. Покажется только если `currentView === 'terminal'`, чтобы не перекрывать вкладку Home. Выбор пользователя сохраняется в БД. См. `knowledge/ui-ux-patterns.md`.
- **Session Waiting State:** Промежуточное состояние "Ожидание сессии..." с пульсирующим жёлтым индикатором. См. `knowledge/ai-session-capture.md`.
- **History Restore:** При восстановлении из History `claudeSessionId` передаётся напрямую в `createTab()` (Immediate Injection). См. `features/project-home.md`.
- **History View (HistoryPanel):** Окно просмотра полной истории сессий Claude.
    - **Engine:** Нативный скролл с `content-visibility: auto`. Отказ от тяжелых JS-виртуализаторов для стабильности при динамической высоте сообщений (от 30px до 1000px). См. `knowledge/fix-ui-stability.md`.
    - **Rich File Actions:** Детальное отображение изменений файлов прямо в истории. Edit показывает диффы (`+`/`-`), Write показывает превью контента. Каждый файл — отдельный фиолетовый раскрывающийся блок.
    - **Sync:** Автоматическое обновление каждые 3с при изменении количества сообщений в файле истории.
    - **Auto-scroll:** "Умное" прилипание к низу списка только при первой загрузке или если пользователь уже находится в "зоне прилипания" (150px от дна).

## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/HistoryPanel.tsx` — нативный скролл с CSS-оптимизацией.
- **Renderer (UI):** `src/renderer/components/Workspace/TerminalArea.tsx` — рендеринг `InterruptedOverlay` через `Layering Pattern`.
- **PendingAction:** `src/renderer/components/Workspace/Terminal.tsx` — обработка `pendingAction` при первом PTY output (`executePendingAction`).
- **Logic:** `src/renderer/components/Workspace/TabBar.tsx` — метод `checkProcessStatus` очищает сессию при нормальном выходе.
- **Main (Sniper):** `src/main/main.js` — функция `startSessionSniper()` (dual-method: fs.watch + polling).
- **Main (Runner):** `src/main/main.js` — IPC `claude:run-command` (switch: `claude`, `claude-c`, `claude-fork`).
- **Main (Handshake):** `src/main/main.js` — стейт-машина `claudeState` в обработчике `terminal:create` data.
- **State:** `useWorkspaceStore.ts` — хранение `pendingAction`, `wasInterrupted` и `claudeSessionId`.
- **Optimization:** См. `knowledge/fix-ui-stability.md` для деталей нативной виртуализации.
- **Session Linking:** См. `knowledge/fix-claude-plan-mode-chain.md` для деталей связывания сессий в Plan Mode.
