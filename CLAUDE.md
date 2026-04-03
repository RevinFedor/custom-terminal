# Noted Terminal

<!-- @deploy-start -->
<instructions>
  <step index="1">
    ПЕРЕД написанием кода — ИССЛЕДУЙ реальное состояние:
    - Запроси реальные данные (SQL/network/curl), не предполагай
    - Если результат пустой/0/unexpected — проверь данные ПЕРВЫМ, не код
    - Используй `docs_search` для поиска шрамов и фактов по подсистеме
  </step>
  <step index="2">
    RED TEAM свой план. Назови минимум 3 constraints:
    - Назови ТОЧНУЮ функцию/переменную которая сломается
    - Опиши влияние на существующие данные (миграции, обратная совместимость)
    - Если не можешь назвать функцию — читай глубже
  </step>
  <step index="3">
    Когда пользователь СОМНЕВАЕТСЯ ("это костыль?", "а если...", "правильно ли"):
    - НЕ защищай текущее решение. Предложи альтернативу.
    - Сравни trade-offs явно.
  </step>
  <step index="4">
    Начни ответ с:
    1. "Я проверил: [что проверил]"
    2. "⚠️ Constraints:" и список из step 2
    3. Затем план реализации.
  </step>
</instructions>
<!-- @deploy-end -->

## Обзор
Noted Terminal — кастомный эмулятор терминала на базе Electron с глубокой интеграцией AI-агентов (Gemini CLI, Claude Code) и управлением проектами.

## Технический Стек
- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer)
- **Styling:** Tailwind CSS v4
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DB:** SQLite (Sessions & Projects)


## State Management
- **ProjectWorkspace:** Хранит состояние вкладок, директорий и активных сессий проекта.
- **viewingSubAgentTabId:** Позволяет переключать вьюпорт на суб-агента, сохраняя основной фокус на родительском табе (Gemini).
- **effectiveTab Pattern:** Абстракция в `Workspace.tsx`, которая резолвит текущий "смысловой" таб (суб-агент или активный). Используется для автоматического переключения Timeline, поиска и заметок.

## Navigation
- **Home Button Toggle:** Кнопка 🏠 (Home) работает как переключатель. При нахождении на Dashboard повторный клик по 🏠 возвращает пользователя в контекст последнего активного проекта вместо перезагрузки Dashboard. Это сокращает время на навигацию при частом переходе между Dashboard и проектами.

## Методологии
- **Дизайн**: `docs/methodology/design.md` — читай при UI-работе
- **Тесты**: `auto/methodology.md` — читай при написании тестов

## Документация
Вся документация в `docs/knowledge/` — единая плоская структура:
- **`fix-*`** — шрамы: баги, фиксы, обходные решения
- **`fact-*`** — факты: как работают подсистемы, платформенные ограничения, поведение фич

Нет иерархии. Семантический роутер (`???` в конце промпта) автоматически выбирает нужные файлы.

### Knowledge Search (MCP)
MCP-инструмент `docs_search` — вызови перед работой с подсистемой, в которой ещё не читал документацию в этой сессии. Проект содержит 70+ knowledge-файлов с пограничными кейсами, race conditions и workarounds — писать код по предположениям без чтения документации приводит к повторению уже решённых багов (5+ итераций вместо одной).

Запрос на английском, описывай что собираешься делать: `"Claude process lifecycle kill restart PTY"`, `"JSONL editing fork parentUuid chain"`, `"paste sync marker TUI automation"`.

## Anti-Patterns (обязательно к соблюдению)
- **Zustand: Не подписывайся на Map целиком:** Подписка на `openProjects` вызывает ре-рендер всего приложения при любом изменении в любой вкладке (из-за `new Map` ссылки). Используй гранулярные селекторы (Fingerprint Pattern). См. [`fix-performance-lags.md`](docs/knowledge/fix-performance-lags.md).
- **O(n²) Restore Cascade:** При восстановлении сессии (множественное создание табов) обязательно используй флаг `isRestoring`. `createTab` не должен триггерить `set()` и `saveTabs()` внутри цикла восстановления.
- **Async Large File I/O:** Никогда не читай большие файлы (>1MB) синхронно в main process. Для JSONL-логов Claude используй асинхронный Incremental Reader. См. [`fix-performance-lags.md`](docs/knowledge/fix-performance-lags.md).
- **Не используй `activeProjectId` для фоновых задач:** При создании суб-агентов или обновлении данных в фоне (через MCP), всегда ищи целевой проект по `tabId` в `openProjects`. `activeProjectId` отражает только то, что пользователь видит в UI в данный момент, и может не совпадать с проектом, где работает агент.
- **Избегай серверного состояния (Watermark) для истории:** Не пытайся отслеживать в памяти сервера, сколько ходов истории уже "прочитал" агент. Это блокирует повторное чтение с разной детализацией и сбрасывается при рестарте. Используй Stateless API с параметром `last_n`.
- **Async onData race:** Никогда не делай `await` внутри обработчика PTY `onData` без предварительной **синхронной блокировки** (cooldown/флаг). Высокочастотный вывод терминала породит десятки дублирующих асинхронных вызовов.
- **Не используй `execSync`** в main process — фризит весь UI
- **Не используй polling и таймауты для ожидания состояний:** Проект event-driven — для каждого состояния уже есть сигнал (OSC 133, `geminiSpinnerBusy` → `processGeminiQueue`, `geminiResponseQueue`, IPC events). Перед написанием `setTimeout`/`setInterval` для ожидания — найди существующий event-driven механизм в кодовой базе. `setTimeout` допустим только для debounce, не для "подождать пока X будет готов". **Это также относится к ожиданию готовности PTY-интерфейсов (например, Gemini CLI TUI)** — используй детерминированные PTY-события вместо фиксированных таймаутов. Пример: ожидание ANSI-сигнала `HIDE CURSOR` (`\x1b[?25l`) гарантирует, что терминал полностью инициализирован перед вставкой данных.
- **IPC коммуникация:** При добавлении main↔renderer коммуникации проверь существующие хендлеры: `grep 'ipcMain.handle\|ipcMain.on' src/main/main.js`. Конвенция: `модуль:действие` (terminal:paste, claude:spawn-with-watcher). `handle` для request-response, `on` для fire-and-forget.
- **Экранируй `$`** в bash-командах в main.js — Vite трансформирует их при сборке
- **Не используй `navigator.clipboard`** в renderer — используй `window.require('electron').clipboard`
- **TUI Logic Testing:** Для низкоуровневой логики парсинга терминала (маркеры, поиск в буфере) предпочитай **Headless Unit-тесты** (node + @xterm/headless). Playwright-тесты используй только для UI и IPC сценариев.
- **Dynamic List Overlays:** Запрещено использовать процентное позиционирование (`top: %`) для оверлеев в списках, где элементы имеют динамическую высоту (например, через `flex-grow` или условные маркеры). Это приводит к визуальному рассинхрону. Используй только реальные DOM-координаты (`offsetTop`/`offsetHeight`) через `refs`.
- **Mirror Editing:** Паттерн двухколонного редактирования, где форма заменяет соседнюю колонку, сохраняя баланс и контекст. См. [`docs/knowledge/fact-ux-patterns.md`](docs/knowledge/fact-ux-patterns.md).
- **Pointer-based DnD:** Сложные перетаскивания (с live-preview или клонами) реализуются через Pointer Events со статическими координатами (`midY`) для фиксации джиттера. См. [`docs/knowledge/fact-settings.md`](docs/knowledge/fact-settings.md).
- **Не дублируй детекцию событий:** Если UI уже корректно реагирует на событие (например, `terminal:command-finished` показывает кнопку "Продолжить"), main process должен использовать **тот же сигнал** для своей логики. Построение параллельного механизма с отдельными guard'ами приводит к рассинхрону (один путь работает, другой — нет). Пример: `bridgeKnownSessions` не чистился при выходе Claude, потому что guard по `claudeCliActive` блокировал, хотя `command-finished` уже корректно сигнализировал о выходе. См. [`fix-interrupted-session-lifecycle.md`](docs/knowledge/fix-interrupted-session-lifecycle.md).

## Окружение и Конфигурация (Infrastructure)
- **Claude Models:** Для использования модели по умолчанию с расширенным контекстом (1M) через переменную окружения `ANTHROPIC_MODEL` необходимо использовать значение `opus[1m]`. Использование строки `default` ломает отображение в TUI.
- **Effort Persistence:** Уровень `max` для Claude не является персистентным и сбрасывается CLI при перезапуске. Максимально допустимое значение для сохранения в `settings.json` — `high`.

## Логирование (обязательно к соблюдению)
- **Глобальный интерсептор:** В main process `console.log/error/warn` перехватываются автоматически. Никаких специальных импортов или функций не нужно.
  - **Dev:** `logs/dev.log` (в корне проекта)
  - **Production (packaged):** `~/Library/Logs/noted-terminal/production.log` (через `app.getPath('logs')`). См. [`fix-packaged-app-logs.md`](docs/knowledge/fix-packaged-app-logs.md).
- **Контракт:** Все логи в main process ДОЛЖНЫ начинаться с `[Tag]` — например `console.log('[MyFeature] something happened')`. Только такие сообщения попадают в файл. Логи без `[` остаются только в stdout.
- **`console.error`** — ВСЕГДА пишется в файл с префиксом `[ERROR]`, даже без тега.
- **Дедупликация:** Повторяющиеся строки схлопываются в `×N`. Не бойся частых логов в горячих путях — спама не будет.
- **НЕ создавай** отдельные логгеры, файлы логов или `fs.appendFile` для логирования. Всё идёт через единый `console.log('[Tag]')` перехватчик.

## Тестирование
- **Полная документация:** [`auto/context.md`](auto/context.md) — entry point, шаблоны, troubleshooting, event-driven паттерны.
- **Философия:** [`fact-test-infrastructure.md`](docs/knowledge/fact-test-infrastructure.md) — два уровня (Headless + E2E), структура папок.
- **Playwright-тесты:** `auto/` — запуск: `node auto/stable/test-name.js`
- **Observability:** В Main-процессе реализовано логирование `[GeminiSpinner] THINKING/IDLE` и `[Spinner] BUSY/IDLE` для E2E тестов.

## AI Features
- **Update API (Haiku pipeline):** Двухэтапный пайплайн для обновления документации. Анализ через Claude/Gemini API (или headless `gemini -p`), затем открытие Claude в табе `docs-XX` с моделью Haiku для применения правок.
- **Auto-apply Toggle:** Мини-тогл рядом с ⚙ в секции System. Когда ON — Haiku автоматически начинает применение изменений (handshake добавляет `Ответь на промпт выше.`). По умолчанию OFF.
- **Claude Extended Thinking:** Поддержка режима размышления для API Claude (версия 2025-04-15) с уровнями Low/Med/High (бюджет до 50к токенов).

## Claude TUI Management
- **Model Switching:** `/model default|sonnet|opus|haiku` — переключение модели из UI. Поддерживается `default` (Opus) и явный выбор `opus`.
- **Effort Level:** `/effort low|medium|high` — контроль интенсивности размышлений (5K/16K/50K токенов). Локальный трекинг (не подтверждается bridge).
- **Think Mode:** `meta+t` (Esc+t) или UI-кнопка — переключение режима размышления. При запуске управляется `alwaysThinkingEnabled` в `~/.claude/settings.json`.
- **Rewind:** `/rewind` или UI-контекстное меню — откат к выбранному сообщению с сжатием контекста.
- **Command Guard:** Во время отправки команд кнопки управления (Model/Effort/Think) блокируются через `isCommandRunning` для предотвращения двойных операций.
- **Синхронизация:** Все команды отправляются через синхронный IPC `invoke('claude:send-command')` для гарантии порядка выполнения. Используется `safePasteAndSubmit` с чанками < 1024 байт и sync marker verification.

