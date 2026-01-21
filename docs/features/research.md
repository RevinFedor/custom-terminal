# Feature: Research Panel (AI Assistant)

## Intro
Встроенный AI-ассистент, работающий непосредственно в контексте терминала. Позволяет исследовать ошибки, искать решения на Reddit и вести диалог с современными моделями Gemini без переключения окон.

## Behavior Specs
- **Вызов:** `Cmd + Shift + R` открывает панель. Основной способ активации — правый клик в терминале → **"Искать в AI"**.
    - **Надежный запуск:** Используется система `pendingResearch` (флаг в Store), что гарантирует старт поиска даже если панель была закрыта в момент вызова. См. `knowledge/fix-gemini-search.md`.
- **Контекстное управление:**
    - Панель открывается **мгновенно** сразу после инициации запроса.
- **Инструменты (Tools):**
    - **Google Search:** Доступен для моделей серии `gemini-3-*` и `gemini-2.5-*`. Позволяет модели искать актуальную информацию в интернете.
- **Thinking Level (Gemini 3):**
- **Markdown и код:**
    - Полная поддержка Markdown через `react-markdown`.
    - Подсветка синтаксиса кода с темой `oneDark`.
    - Решен конфликт гидратации (вложенность `<pre>` в `<p>`). См. `knowledge/fix-markdown-hydration.md`.
- **Система чатов (Conversations):**
    - Каждый запуск создает новую сессию. Заголовок чата формируется из выделенного текста (промпт уходит в конец сообщения).
    - Чаты отображаются в правой панели (вкладка AI) для быстрого переключения.

## Code Map
- **UI:** `src/renderer/components/Research/ResearchSheet.tsx` — хедер с выбором модели, Thinking Level и настройками.
- **Rendering:** `src/renderer/components/Research/MarkdownRenderer.tsx` — компонент для отрисовки ответов с подсветкой.
- **Chat:** `src/renderer/components/Research/ChatArea.tsx` — виртуализированный список.
- **Input:** `src/renderer/components/Research/ResearchInput.tsx` — управление AbortController, авто-высота инпута и логика отмены.
- **SDK:** Используется `@google/genai` для поддержки расширенных конфигураций (Thinking, Tools).
- **Persistence:** Данные сохраняются в `localStorage` под ключом `noted-terminal-research-v2`.
