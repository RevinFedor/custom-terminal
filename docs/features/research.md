# Feature: Research Panel (AI Assistant)

## Intro
Встроенный AI-ассистент, работающий непосредственно в контексте терминала. Позволяет исследовать ошибки, искать решения на Reddit и вести диалог с современными моделями Gemini без переключения окон.

## Behavior Specs
- **Вызов:** `Cmd + Shift + R` открывает панель. 
- **Режимы (Modes):**
    - **🔍 Research:** Использует `gemini-2.0-flash`. Оптимизирован для быстрого поиска ответов и анализа кода.
    - **📋 Compact:** Использует `gemini-3-flash` с настройкой `Thinking: HIGH`. Предназначен для глубокого анализа сложных проблем. Вызывается через контекстное меню терминала.
- **Инструменты (Tools):** Google Search доступен для моделей серии `3` и `2.5`.
- **Markdown и код (gt-editor style):**
    - Блоки кода теперь имеют серый полупрозрачный фон `rgba(80, 80, 80, 0.25)`.
    - Поддержка `remark-gfm` и `syntax-highlighter` с темой `oneDark`.
    - Кнопка **Copy** в хедере чата позволяет мгновенно скопировать последний ответ ассистента.
- **Авто-переключение:** При активации поиска через контекстное меню терминала, правая панель автоматически переключается на вкладку **AI**.
- **Система чатов (Conversations):**
    - Данные сохраняются в `localStorage`. Каждому чату присваивается тип (`research` или `compact`).

## Code Map
- **UI:** `src/renderer/components/Research/ResearchSheet.tsx` — логика переключения вкладок и кнопка копирования.
- **Logic:** `src/renderer/components/Workspace/panels/NotesPanel.tsx` — слушает `pendingResearch` для авто-переключения вкладок.
- **Rendering:** `src/renderer/components/Research/MarkdownRenderer.tsx` — обновленные стили для `code` и `pre`.
- **Store:** `src/renderer/store/useResearchStore.ts` — хранение типа чата.
