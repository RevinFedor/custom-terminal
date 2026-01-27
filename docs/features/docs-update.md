# Feature: Documentation Update (Claude -> Gemini)

## Intro
Автоматизированный процесс синхронизации контекста разработки между Claude Code и Gemini для обновления документации проекта. Фича позволяет "одним кликом" экспортировать текущую сессию Клода и передать её на анализ Gemini в отдельном изолированном терминале.

## Behavior Specs
- **Триггеры в ActionsPanel:**
    - **Основная кнопка (зеленая):** Экспорт всей сессии Claude Code через `/export`.
    - **Кнопка "Ножницы" (✂️):** Использование выделенного текста в терминале.
    - **Кнопка "Планшет" (📋):** Фиолетовая кнопка. Использует содержимое буфера обмена как источник данных.
- **Режим "Буфер" (Clipboard):**
    - Система читает текст из буфера обмена через `navigator.clipboard.readText()`.
    - Текст сохраняется во временный файл, аналогично режиму выделения.
- **Экспорт (Claude):**
    - В текущий терминал отправляется команда `/export docs/tmp/session-export-{timestamp}.md`.
    - Система использует паттерн **Predetermined Path**: генерирует путь заранее и ждет появления файла на диске.
- **Подготовка промпта:**
    - Промпт берется из настроек (`Settings` -> `AI Prompts` -> `Documentation Prompt`).
    - К тексту промпта автоматически добавляется путь к файлу (сессии или выделения).
- **Анализ (Gemini):**
    - Создается новый терминал в **Main** зоне (Зеленый цвет, имя `docs-gemini-XX`).
    - Запускается `gemini`, система ждет готовности и вставляет промпт.
- **Очистка:** Временный файл промпта удаляется, файл данных (session или selection) остается для чтения Gemini.

## Code Map
- **Logic (Renderer):** `src/renderer/components/Workspace/panels/ActionsPanel.tsx` -> `handleUpdateDocs` и `handleUpdateDocsWithSelection`.
- **Logic (Main):** `src/main/main.js` -> хендлеры `docs:export-session`, `docs:save-selection`, `docs:save-prompt-temp`.
- **State:** `src/renderer/store/useUIStore.ts` -> `docPrompt` settings.
- **Fixes:**
    - `knowledge/fix-pty-buffer-overflow.md` — как вставляем большие промпты.
    - `knowledge/fix-ai-sessions.md` — паттерн ожидания файла.
