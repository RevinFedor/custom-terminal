# Feature: Workspace & Tools

## Intro
Инструменты для работы с кодом внутри терминала: навигация по файлам, быстрый просмотр и поиск через AI.

## Behavior Specs
- **File Explorer:** Вызывается по `Cmd + \` . Показывает структуру проекта.
- **File Preview:** Быстрый просмотр контента файла с подсветкой синтаксиса (Highlight.js). Закрывается по `Esc` или повторному `Cmd + \` .
- **Gemini Search:** Позволяет искать выделенный в терминале текст (например, ошибки) через API Gemini.

## Code Map
- **Preview:** `src/renderer/components/Workspace/FilePreview.tsx`.
- **Explorer:** `src/renderer/components/Workspace/FileExplorer.tsx`.
- **Search:** `src/renderer/components/Workspace/panels/GeminiPanel.tsx`.
