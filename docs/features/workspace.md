# Feature: Workspace & Tools

## Intro
Инструменты для работы с кодом внутри терминала: навигация по файлам, быстрый просмотр и поиск через AI.

## Behavior Specs
- **File Explorer:** Вызывается по `Cmd + \` . Показывает структуру проекта.
- **File Preview:** Быстрый просмотр контента файла с подсветкой синтаксиса (Highlight.js). Закрывается по `Esc` или повторному `Cmd + \` .
- **Right Panel (Info):** Содержит вкладки для работы с активным табом.
    - **Info:** (Заменила Notes) Отображает статус и ID сессии Claude Code, а также справочник доступных команд.
    - **AI:** Панель Gemini для работы с контекстом.
    - **Actions:** Системные действия (экспорт сессий, Update Docs).
    - **Sessions:** Управление сохраненными AI-чекпоинтами.
- **Notes (Temporary):** Панель заметок временно скрыта из правой части и подготавливается к переносу в нижнюю панель воркспейса.
- **Empty State:** Если в проекте не открыто ни одного терминала в Main зоне, отображается информационный экран:
    - Название текущего проекта.
    - Кнопка быстрого создания терминала.
    - Подсказка по горячим клавишам (`Cmd + T`).
- **Gemini Search:** Позволяет искать выделенный в терминале текст через API Gemini. Вызывается через контекстное меню (ПКМ) в терминале → "Искать в AI". Результаты открываются в Research Panel.

## Code Map
- **Preview:** `src/renderer/components/Workspace/FilePreview.tsx`.
- **Explorer:** `src/renderer/components/Workspace/FileExplorer.tsx`.
- **Right Panel:** `src/renderer/components/Workspace/NotesPanel.tsx` (контейнер для вкладок Info, AI и др.).
- **Info Panel:** `src/renderer/components/Workspace/panels/InfoPanel.tsx`.
- **Placeholder:** `src/renderer/components/Workspace/EmptyTerminalPlaceholder.tsx`.
- **Research Overlay:** `src/renderer/components/Research/ResearchSheet.tsx` — открывается внутри области терминала.
- **Logic:** `src/renderer/components/Workspace/TerminalArea.tsx` управляет переключением между терминалами и заглушкой.
