# Feature: Workspace & Tools

## Intro
Инструменты для работы с кодом внутри терминала: навигация по файлам, быстрый просмотр и поиск через AI.

## Behavior Specs
- **File Explorer:** Вызывается по `Cmd + \` . Показывает структуру проекта.
- **File Preview:** Быстрый просмотр контента файла с подсветкой синтаксиса (Highlight.js). Закрывается по `Esc` или повторному `Cmd + \` .
- **Empty State:** Если в проекте не открыто ни одного терминала в Main зоне, отображается информационный экран:
    - Название текущего проекта.
    - Кнопка быстрого создания терминала.
    - Подсказка по горячим клавишам (`Cmd + T`).
- **Gemini Search:** Позволяет искать выделенный в терминале текст (например, ошибки) через API Gemini.

## Code Map
- **Preview:** `src/renderer/components/Workspace/FilePreview.tsx`.
- **Explorer:** `src/renderer/components/Workspace/FileExplorer.tsx`.
- **Placeholder:** `src/renderer/components/Workspace/EmptyTerminalPlaceholder.tsx`.
- **Research Overlay:** `src/renderer/components/Research/ResearchSheet.tsx` — открывается внутри области терминала.
- **Logic:** `src/renderer/components/Workspace/TerminalArea.tsx` управляет переключением между терминалами и заглушкой.
