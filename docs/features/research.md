# Feature: Research Panel (AI Assistant)

## Intro
Встроенный AI-ассистент, работающий непосредственно в контексте терминала. Позволяет исследовать ошибки, искать решения на Reddit и вести диалог с современными моделями Gemini без переключения окон.

## Behavior Specs
- **Вызов:** `Cmd + Shift + R` открывает панель поверх активного терминала.
- **Research Selection:**
    - Кнопка в AI-панели (справа) или пункт в контекстном меню терминала.
    - Берет выделенный текст, добавляет к нему **System Research Prompt** и отправляет в AI.
    - Автоматически создает новый чат и открывает панель с ответом.
- **Система чатов (Conversations):**
    - Каждый запуск через "Research Selection" создает новую вкладку-чат.
    - Чаты отображаются в правой панели (вкладка AI).
    - Для каждого чата виден заголовок, количество сообщений и общий объем символов.
- **Управление моделями:**
    - Выбор модели происходит непосредственно в хедере панели Research.
    - Доступные модели: `Gemini 2.0 Flash`, `Gemini 3 Flash Preview`, `Gemini 3 Pro Preview`.
    - Выбор глобален и сохраняется в настройках.
- **Интеграция с API:** Прямые запросы к Google Generative AI API с использованием ключа из окружения.

## Code Map
- **UI:** `src/renderer/components/Research/ResearchSheet.tsx` — основной контейнер с анимацией `framer-motion`.
- **Chat:** `src/renderer/components/Research/ChatArea.tsx` — виртуализированный список сообщений (`react-virtuoso`).
- **Input:** `src/renderer/components/Research/ResearchInput.tsx` — логика отправки запросов и управления состоянием загрузки.
- **Store:** `src/renderer/store/useResearchStore.ts` — хранилище чатов, активных сессий и логика создания "Conversations".
- **Persistence:** Данные сохраняются в `localStorage` под ключом `noted-terminal-research-v2`.
