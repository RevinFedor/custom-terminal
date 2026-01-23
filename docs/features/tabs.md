# Feature: Tab Management

## Intro
Система вкладок в стиле VSCode с разделением на зоны (Main/Utils), поддержкой цветовой маркировки и сохранением состояния. Особое внимание уделено разделению на пользовательские и системные вкладки.

## Behavior Specs
- **Main/Utils Zones:** Горизонтальные табы сверху и вертикальный список сбоку.
- **Utils Hover Logic:** 
    - Зона Utils (dropdown) раскрывается автоматически при наведении мыши.
    - Введены задержки (timeouts) для открытия (150ms) и закрытия (200ms), что предотвращает случайные срабатывания при движении курсора.
    - Если зона была открыта кликом, автоматическое сворачивание отключается до ручного закрытия.
- **Цветовая Маркировка:** 
    - 6 предустановленных цветов для визуальной группировки.
    - Доступ через контекстное меню (правый клик на таб).
- **Smart Focus on Close:** 
    - При закрытии активного таба система ищет последний доступный **Main** таб для переключения фокуса.
    - Автоматического переключения на Utils табы не происходит.
- **System Tools (Зеленый):** Специальный статус для вкладок с AI-агентами.
    - Вкладки для "Update Docs" именуются автоматически: `docs-gemini-01`.
    - Помечаются зеленым цветом автоматически.
- **Smart New Tab:** 
    - При создании новой вкладки (Cmd+T, кнопка "+", двойной клик на пустой области), она вставляется **справа от текущей активной вкладки**.
    - Новая вкладка автоматически наследует `cwd` (рабочую директорию) текущей вкладки.
- **DND:** Перетаскивание таба между зонами.
- **Quick Actions:**
    - **Smart Restart (↻):** Левая часть таба (32px) является **Restart Zone**. При наведении на индикатор процесса он заменяется на иконку ↻. Клик выполняет цепочку: `SIGINT` -> задержка 300мс -> `!! + Enter`.
    - **Middle Click Close:** Закрытие вкладки нажатием на колесико мыши.
- **Utils Zone Status:** На кнопке "Utils" появляется индикатор (белая точка), если в скрытом системном табе запущен процесс.
- **Persistence:** Цвет, статус `isUtility`, положение таба, `wasInterrupted` и `claudeSessionId` сохраняются в SQLite через `projects.json`.
- **Lazy Initialization (Performance):** 
    - UI терминала (`xterm.js`) создается только при первом показе. 
    - Добавлен замок `isCreatingRef` для предотвращения двойной инициализации при быстрых переключениях.
- **Smooth Switching:** Используется React 19 `startTransition`.
- **Сохранение истории (Serialization):** Буфер сохраняется при переходе на Dashboard. См. `knowledge/fix-terminal-serialization.md`.

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — содержит логику `utilityExpanded` (hover/click) и компоненты `RestartZone`.
- **Logic:** `src/renderer/components/Workspace/Terminal.tsx` — реализация `Layering Pattern` и `isCreatingRef`.
- **Store:** `src/renderer/store/useWorkspaceStore.ts` — метод `createTabAfterCurrent` для умного позиционирования.
- **Fixes:**
    - `knowledge/fix-terminal-jitter.md` — как предотвращаем дёргание при создании/переключении.
    - `knowledge/fix-terminal-serialization.md` — детальное описание механизма сохранения истории.
    - `knowledge/fix-tabs-display-conflict.md` — решение конфликта `display:none` и WebGL.
    - `knowledge/fix-tab-persistence.md` — исправление потери цвета при перезагрузке.
