# Feature: Tab Management

## Intro
Система вкладок в стиле VSCode с разделением на зоны (Main/Utils), поддержкой цветовой маркировки и сохранением состояния. Особое внимание уделено разделению на пользовательские и системные вкладки.

## Behavior Specs
- **Main/Utils Zones:** Горизонтальные табы сверху и вертикальный список сбоку.
- **Цветовая Маркировка:** 
    - 6 предустановленных цветов для визуальной группировки.
    - Доступ через контекстное меню (правый клик на таб).
- **Smart Focus on Close:** 
    - При закрытии активного таба система ищет последний доступный **Main** таб для переключения фокуса.
    - Автоматического переключения на Utils табы не происходит, чтобы не прерывать рабочий процесс.
    - Если Main табов не осталось, показывается "Empty State" воркспейса.
- **System Tools (Зеленый):** Специальный статус для вкладок с AI-агентами (Gemini, Claude) или авто-обновляторами документации.
    - Вкладки для "Update Docs" именуются автоматически: `docs-gemini-01`, `docs-gemini-02`.
    - Помечаются зеленым цветом автоматически.
    - Могут создаваться в Main зоне (для анализа) или Utils зоне (для фоновых задач).
- **DND:** Перетаскивание таба между зонами.
- **Persistence:** Цвет, статус `isUtility` и положение таба сохраняются в `projects.json`.
- **Lazy Initialization (Performance):** 
    - При загрузке воркспейса UI терминала (`xterm.js`) создается только для активной вкладки.
    - Фоновые вкладки инициализируются только при первом клике ("протыкивании").
    - Это позволяет избежать GPU-фризов и Event Loop starvation при старте приложения с множеством табов.
- **Smooth Switching:** Используется React 19 `startTransition` для переключения табов, что позволяет интерфейсу оставаться отзывчивым, пока "тяжелый" терминал рендерится в фоне.
- **Сохранение истории (Serialization):** Визуальный буфер терминала сохраняется при переходе на Dashboard и восстанавливается при возврате в Workspace. Это предотвращает потерю вывода при размонтировании компонентов. См. `knowledge/fix-terminal-serialization.md`.

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — рендеринг через inline-styles (см. `knowledge/fix-tailwind-dynamic-runtime.md`).
- **Logic:** `src/renderer/components/Workspace/Terminal.tsx` — реализация Lazy Init и логика сериализации (`SerializeAddon`).
- **Store:** `src/renderer/store/useWorkspaceStore.ts` — экшены `createTab`, `switchTab`, `closeTab` и хранилище `terminalBuffers`.
- **Fixes:**
    - `knowledge/fix-terminal-jitter.md` — как предотвращаем дёргание при создании/переключении.
    - `knowledge/fix-terminal-serialization.md` — детальное описание механизма сохранения истории.
    - `knowledge/fix-tabs-display-conflict.md` — решение конфликта `display:none` и WebGL.
    - `knowledge/fix-tab-persistence.md` — исправление потери цвета при перезагрузке.
