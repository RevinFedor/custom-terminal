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
3. **Send prompt:** Отправляет `pendingPrompt` через Bracketed Paste + delayed `\r`. См. `knowledge/fact-fact-terminal-core.md`.

Thinking mode при запуске обеспечивается `alwaysThinkingEnabled: true` в `~/.claude/settings.json`, Tab (`\t`) больше не отправляется.

## Автовосстановление до первого сообщения

UUID живого Claude не доказывает наличие разговора для `--resume`. В инциденте
10.09 tab406 пользователь не отправил ни одного prompt: файл содержал startup
`/model`/`/effort` и служебные записи. Нормальная tail-cleanup удалила восемь
startup-строк, оставив198байт `mode`/`permission-mode`; CLI ответил
`No conversation found` и вышел с кодом1. Это не миграция старой версии.

AutoResume после подготовки истории различает продолжение разговора и
повторное открытие пустого CLI. Только полный, корректный metadata-only файл
разрешает обычный fresh launch в той же вкладке; перед записью проверяются
неизменные file revision и сохранённая session binding. Отсутствующий,
повреждённый, неизвестный или частично прочитанный файл не означает «пусто».
История с user/assistant/compact и режим «записать без ответа» остаются Resume.
Новый UUID пустого runtime не блокируется guard'ом прежней сессии; interrupted
снимается только после готовности именно принятого launch. History draft не
переносится в PTY и не очищается этим выбором.

Отдельная ошибка реакции на exit: managed launch оставлял `WAITING_PROMPT`
после собственного OSC B→D и AutoResume ждал60с уже завершившийся процесс.
Теперь этот D завершает ожидание так же, как manual launch. Предварительный
Ctrl+C до B и graceful shutdown по-прежнему не очищают recovery identity.
Проверять цепочку tail-cleanup → выбор launch → новый UUID → ready, а не
только чтение пустой Timeline. Механика shutdown — `fix-interrupted-session-lifecycle.md`.

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

## Prefilled Sessions (удалено)

> Механизм создания Claude-сессии «извне» с предзаполненными сообщениями
> (`claude:create-prefilled-session`) удалён 2026-08-18 вместе с пайплайном
> обновления документации — см. [`fact-docs-update.md`](fact-docs-update.md).
> Раздел сохранён: структура JSONL описана верно и пригодится, если такой
> механизм понадобится снова.

Это Claude-only свойство, не общий agent transcript API. Claude 2.1.234
принимает обычную root/tip user-запись без `userType: external` и включает её в
контекст следующего хода, не отвечая на неё при Resume. Поэтому режим History
«записать без ответа» использует эту возможность только после доказанного Stop,
проверки отсутствия другого владельца JSONL и неизменной file revision. После
user-записи добавляется непустая app-owned assistant boundary из одного невидимого
разделителя U+2063: Claude считает turn завершённым и не создаёт synthetic `No response requested.`,
а History/Timeline/Copy скрывают только этот exact marker. Модель при этом не
вызывается. Затем сессия открывается через Resume и остаётся idle. Обычная отправка по
Enter по-прежнему идёт через PTY + post-Enter audit; эти контракты не смешиваются.

### JSONL Structure
При создании prefilled сессии в JSONL записываются 2 записи:

```jsonl
{"uuid":"...", "role":"user", "sessionId":"...", "parentUuid":null, "content":"Анализ API:\n...", "metadata":{...}}
{"uuid":"...", "role":"assistant", "sessionId":"...", "parentUuid":"...", "content":"Готово для редактирования.", ...}
```

### Invisible Intent: Why User Message for Analysis?
- **Видимость в TUI:** Когда Claude загружает сессию, пользователь сразу видит анализ в истории. Если анализ был в Assistant, он находился бы "перед" промптом, что запутало бы интерфейс.
- **Завершение turn:** Assistant сообщение (короткое подтверждение) гарантирует, что turn завершился (`end_turn`). Claude вернет промпт `❯`, позволяя пользователю редактировать или отправлять уточнения.
- **Stateless API:** Никакого серверного состояния. JSONL — это полный снимок сессии.

### Resume Handshake (Model Switching)
После открытия prefilled сессии система может отправить `/model haiku` через `claude-c` (continue) для немедленного переключения на Haiku:
- `resumeSessionId` передается в IPC при создании таба
- Prompt `\n/model haiku\r` вставляется после детекции готовности Claude

## Behavior Specs
- **Claude Process Monitor:** Виджет на Dashboard для отслеживания всех запущенных в системе процессов Claude CLI.
    - **In-App:** Процессы, запущенные из терминалов приложения. Отображаются с указанием "Имя Проекта / Имя Таба".
    - **External:** Процессы, запущенные во внешних терминалах (iTerm, Terminal.app).
    - **Manual Stop:** Каждая карточка процесса имеет кнопку "Stop" (Square icon), которая отправляет сигнал `kill` процессу.
- **Clean Export:** При копировании сессии блоки кода заменяются на компактные метки. См. `knowledge/fact-export-session.md`.
- **Hierarchical Session Tree:** Заголовок экспорта содержит вложенную структуру сессий.
    - **Метки:** `(root)`, `(plan mode)` (новый файл через clear context), `(fork)` (клон файла).
    - **Индикаторы:** `*` помечает активную ветку, `♻️ ×N` показывает количество сжатий контекста в сегменте.
    - **Stats:** Напротив каждой сессии отображается количество сообщений (`messages`).
- **Backtrace Timeline:** История сессии отображается на вертикальном таймлайне с фильтрацией Undo-веток. См. `knowledge/fact-timeline.md`.
- **Interrupted Recovery:** Main помечает живую PTY-сессию `wasInterrupted=true` до обрываемых shutdown-шагов. На следующем cold launch renderer не спрашивает opt-in и не показывает blocking Continue-overlay: после восстановления всех tab records запускается одна последовательная очередь Resume. Для каждой Claude-вкладки она ждёт не только запись `claude --resume`, но и main-owned prompt + startup-defaults gate; лишь `ready` очищает interrupted marker. Failure остаётся видимым lifecycle error и не мешает следующей вкладке очереди. Обычная ручная Continue/Resume-кнопка сохранена для остановленной пользователем сессии вне crash-recovery. Lifecycle-race shutdown и точный сигнал live process описаны в `fix-interrupted-session-lifecycle.md`.
- **Session Waiting State:** Промежуточное состояние "Ожидание сессии..." с пульсирующим жёлтым индикатором. См. `knowledge/fact-session-capture.md`.
- **History Restore:** При восстановлении из History `claudeSessionId` передаётся напрямую в `createTab()` (Immediate Injection). См. `knowledge/fact-project-home.md`.
- **History View (HistoryPanel):** Окно просмотра полной истории сессий Claude.
    - **Engine:** Нативный скролл с `content-visibility: auto`. Отказ от тяжелых JS-виртуализаторов для стабильности при динамической высоте сообщений (от 30px до 1000px). См. `knowledge/fix-ui-stability.md`.
    - **Rich File Actions:** Детальное отображение изменений файлов прямо в истории. Edit показывает диффы (`+`/`-`), Write показывает превью контента. Каждый файл — отдельный фиолетовый раскрывающийся блок.
    - **Sync:** Автоматическое обновление каждые 3с при изменении количества сообщений в файле истории.
    - **Auto-scroll:** "Умное" прилипание к низу списка только при первой загрузке или если пользователь уже находится в "зоне прилипания" (150px от дна).
    - **Quick Scroll-down:** Фиолетовая кнопка со стрелкой (`ChevronDown`) появляется в правой нижней части панели, когда пользователь прокручивает историю вверх (порог > 150px от дна). При нажатии выполняется плавный скролл к последнему сообщению. Кнопка мгновенно скрывается при достижении нижней границы.

## Code Map
- **Renderer (UI):** `src/renderer/components/Workspace/HistoryPanel.tsx` — нативный скролл с CSS-оптимизацией.
- **Renderer (UI):** `src/renderer/App.tsx` + `utils/continueInterruptedSession.ts` — sequential interrupted restore; `useAgentLifecycle.ts` — tab-owned pending/error/interrupted projection без blocking overlay.
- **PendingAction:** `src/renderer/components/Workspace/Terminal.tsx` — обработка `pendingAction` при первом PTY output (`executePendingAction`).
- **Logic:** `src/renderer/components/Workspace/TabBar.tsx` — метод `checkProcessStatus` очищает сессию при нормальном выходе.
- **Main (Sniper):** `src/main/main.js` — функция `startSessionSniper()` (dual-method: fs.watch + polling).
- **Main (Runner):** `src/main/main.js` — IPC `claude:run-command` (switch: `claude`, `claude-c`, `claude-fork`).
- **Main (Handshake):** `src/main/main.js` — стейт-машина `claudeState` в обработчике `terminal:create` data.
- **State:** `useWorkspaceStore.ts` — хранение `pendingAction`, `wasInterrupted` и `claudeSessionId`.
- **Optimization:** См. `knowledge/fix-ui-stability.md` для деталей нативной виртуализации.
- **Session Linking:** См. `knowledge/fix-claude-plan-mode-chain.md` для деталей связывания сессий в Plan Mode.
