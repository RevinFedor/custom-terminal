# Feature: AI Prompts & Quick Commands

## Intro
Единый центр управления текстовыми заготовками. Разделен на "Быстрые команды" терминала и "AI Промпты" для работы с агентами.

## Behavior Specs
- **Quick Commands:** Короткие команды (например, `npm run build`), которые можно быстро вставить в терминал.
- **AI Prompts:** Разделены на три типа:
    - **System (Research):** Специальный промпт для функции "Research Selection".
    - **System (Documentation):** Промпт для фичи "Update Docs". Поддерживает чтение из внешнего файла (например, `docs-rules.prompt.md`) или inline-текст.
    - **User:** Кастомные шаблоны для вставки в терминал или AI чаты.
- **Визуальное разделение:** В UI системные промпты выделены голубой или зеленой (для Docs) рамкой и меткой "System".
- **Интеграция:** 
    - Доступны через вкладку "Prompts" в основном Dashboard.
    - Быстрый доступ через контекстное меню терминала (правый клик).
    - Прямое использование в системных экшенах (ActionsPanel).
- **Auto-save:** Любые изменения сохраняются автоматически с задержкой (debounce) 800мс.

## Code Map
- **UI:** `src/renderer/components/Dashboard/SettingsPanel.tsx` (компонент `PromptsPanel`).
- **Data:** Сохраняются глобально через IPC-вызовы `commands:save-global` и `prompts:save`.
- **Backend:** Обрабатываются в `src/main/main.js` через системный стор (JSON).
