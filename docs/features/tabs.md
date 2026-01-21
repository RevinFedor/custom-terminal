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
- **System Tools (Зеленый):** Специальный статус для вкладок с AI-агентами (Gemini, Claude) или авто-обновляторами документации. Помечаются зеленым цветом автоматически.
- **DND:** Перетаскивание таба между зонами.
- **Persistence:** Цвет, статус `isUtility` и положение таба сохраняются в `projects.json`.

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — рендеринг через inline-styles (см. `knowledge/fix-tailwind-dynamic-runtime.md`).
- **Store:** `src/renderer/store/useWorkspaceStore.ts` — экшены `createTab` и логика `closeTab` с фильтрацией зон.
- **Fixes:**
    - `knowledge/fix-terminal-jitter.md` — как предотвращаем дёргание при создании/переключении.
    - `knowledge/fix-tabs-display-conflict.md` — решение конфликта `display:none` и WebGL.
    - `knowledge/fix-tab-persistence.md` — исправление потери цвета при перезагрузке.
