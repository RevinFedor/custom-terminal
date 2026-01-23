# Feature: Research Panel (AI Assistant)

## Intro
Встроенный AI-ассистент, работающий в контексте терминала. Оптимизирован для быстрого поиска решений и глубокого анализа кода.

## User Flow: Исследование проблемы
1. **Триггер:** Пользователь видит ошибку в терминале, выделяет её мышью.
2. **Активация:** Правый клик -> "Research Selection". 
   - Правая панель (InfoPanel) автоматически переключается на вкладку **AI**.
   - Используется [State-driven триггер](knowledge/fix-gemini-search.md), чтобы панель открылась и сразу начала поиск.
3. **Ожидание:** В списке чатов слева и в самом чате отображаются анимированные лоадеры вместо статических иконок.
4. **Анализ:** Ответ рендерится с поддержкой Markdown. 
   - Inline-код отображается корректно. См. `knowledge/fix-markdown-inline-code.md`.
   - Блоки кода имеют кнопку Copy.
5. **Итерация:** 
   - Если ответ не помог, пользователь нажимает **Retry** (липкая кнопка в конце сообщения). Хвост истории удаляется, и запрос отправляется снова.
   - Ненужные сообщения можно удалить кнопкой **Delete**.

## Behavior Specs
- **Режимы (Modes):**
    - **🔍 Research:** `gemini-2.0-flash`.
    - **📋 Compact:** `gemini-3-flash` (Thinking: HIGH).
- **Tools:** Автоматическая активация Google Search для моделей серии 3. См. `knowledge/fix-gemini-search.md`.
- **UI Stability:** Ответы рендерятся через `react-virtuoso` для плавной прокрутки. См. `knowledge/fix-markdown-hydration.md`.

## Code Map
- **UI:** `src/renderer/components/Research/ChatArea.tsx` — кнопки Retry/Delete.
- **Rendering:** `src/renderer/components/Research/MarkdownRenderer.tsx` — фикс inline-кода.
- **Store:** `src/renderer/store/useResearchStore.ts` — флаг `pendingResearch`.