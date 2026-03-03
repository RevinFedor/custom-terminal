# Feature: Documentation Update (Claude -> Gemini)

## Intro
Автоматизированный процесс синхронизации контекста разработки между Claude Code и Gemini для обновления документации проекта. Фича позволяет экспортировать текущую сессию Клода (или данные из буфера/выделения) и передать её на анализ Gemini в отдельном изолированном терминале.

## Behavior Specs
- **Унифицированный экспорт (Unified Pipeline):** Удален нестабильный метод `flash-export` (команда `/export` в Клоде). Теперь данные извлекаются напрямую из файлов сессии с использованием того же пайплайна, что и в Copy Session. Это гарантирует 100% точность экспорта даже в сложных ветвящихся диалогах.
- **Триггеры в ActionsPanel (единый хендлер):**
    - **Основная кнопка (клик по заголовку):** Экспорт сессии активного таба.
    - **Multi-select:** Если выбрано несколько вкладок (Shift/Cmd+Click), данные сессий объединяются в один файл.
    - **Кнопка "Ножницы" (✂️):** Использование выделенного в данный момент текста в терминале.
    - **Кнопка "Планшет" (📋):** Использование содержимого буфера обмена (доступно только при одиночном выборе таба).
    - **Кнопка API ([api]):** Прямая отправка промпта внешнему агенту (Claude API) через прокси-сервер. Ответ автоматически копируется в буфер обмена.
- **Составной Промпт (Temp File + Bracketed Paste):**
    Данные сессии сохраняются в `<projectPath>/tmp/noted-docs-<timestamp>.txt`. Промпт (маленький текст: инструкция + путь к файлу + дополнение) вставляется через `terminal:paste` → `safePasteAndSubmit(fast=true)` с Bracketed Paste Mode, чтобы `\n` не интерпретировались как Enter.
    1.  **Префикс:** `Ниже промпт документации:` — защита от shell mode (если промпт начинается с `$`).
    2.  **Инструкция:** Берется из настроек (`Settings` -> `AI Prompts` -> `Documentation Prompt`).
    3.  **Путь к данным:** `tmp/noted-docs-<ts>.txt` — сырые данные сессии/выделения/буфера. Gemini читает файл сам.
    4.  **Дополнение:** Текст из поля ввода в раскрывающемся блоке (▶/▼).

    *Что вставляется в Gemini (одна атомарная вставка):*
    ```
    Ниже промпт документации:
    {System Prompt}
    @{projectPath}/tmp/noted-docs-<ts>.txt
    {Additional Prompt}
    ```
    **Важно:** Префикс `@` перед полным путем критичен для Gemini CLI — это заставляет его прочитать содержимое файла и включить его в контекст. Без него путь будет воспринят как обычная строка текста.

    **Важно:** Для детекции готовности Gemini CLI (v0.30+) используется паттерн `[INSERT]` в статус-баре. Устаревший паттерн `type your message` сохранен как fallback.

    **Важно:** После Bracketed Paste (`\x1b[201~`) нужна задержка ~500ms перед `\r`, иначе Gemini интерпретирует Enter как перенос строки, а не submit.
- **Интерактивность:**
    - `⌘+Enter` в поле ввода запускает процесс обновления.
    - Состояние выделения вкладок (Multi-select) сохраняется при кликах внутрь панели и вводе текста (см. `knowledge/fact-ux-patterns.md`).
- **Анализ (Gemini):**
    - Система создает prefilled-сессию через `gemini:create-prefilled-session`, затем запускает Gemini-таб через `gemini:spawn-with-watcher` с флагами `resumeSessionId` и `yesMode: true`.
    - Итоговая команда в PTY: `gemini -y -r <sessionId>` — `-y` (auto-approve) + `-r` (resume prefilled session). Это гарантирует, что Gemini начнет обработку без ручного подтверждения.
    - Сессия обновления захватывается "Снайпером" и доступна для последующего Fork/Resume. См. [`knowledge/fix-gemini-capture.md`](fix-gemini-capture.md).

### Claude API Integration (Direct Update)
- **Интеграция:** Кнопка `[api]` inline справа от иконки копирования, фиолетовый badge.
- **Логика отмены:** Использование `apiCancelledRef` вместо `AbortController`. Поскольку IPC-вызов в Electron нельзя прервать "на лету", нажатие на лоадер просто блокирует запись результата в буфер по завершении, сохраняя отзывчивость UI.
- **Invisible Intent (CORS):** Почему fetch в `main.js`? Сервер `api.kiro.cheap` возвращает жесткий заголовок `Access-Control-Allow-Origin: https://kiro.cheap`, что делает невозможным прямые запросы из Renderer-процесса (`localhost`). Main-процесс (Node.js) игнорирует CORS.
- **Токенизация:** Эмпирическая формула `chars / 3.5` для предварительной оценки объема контекста (смесь кода и текста). При получении ответа выводятся точные данные `usage` и стоимость в USD.

### MCP update_docs Tool (Gemini Orchestration)
Gemini-оркестратор может вызвать `update_docs` как MCP tool для анализа сессий своих суб-агентов через API. В отличие от UI-подхода (создание Gemini-таба), это **синхронный** вызов — результат возвращается напрямую в контекст Gemini как tool response.

- **Инструмент:** `update_docs(taskIds, provider?)` в `mcp-server.mjs`
- **Параметры:** `taskIds` — массив ID задач из `list_sub_agents`. `provider` — `'claude'` или `'gemini'` (по умолчанию `'gemini'`).
- **Пайплайн для каждого taskId:**
  1. Resolve `taskId` → `claudeTabId` → `sessionId` (3-level fallback как в `continue_claude`)
  2. Export session через `getClaudeHistory(sessionId, cwd, { detail: 'with_code' })` — полная история с diff-ами
  3. Оборачивание в `<session_log>` + инструкция не отвечать на вопросы внутри лога
  4. Чтение doc prompt из `docsConfig` (synced из renderer)
  5. API call (Claude через `api.kiro.cheap` или Gemini прямой fetch)
  6. Результат возвращается как tool response
- **Обработка нескольких сессий:** Последовательная (чтобы не словить rate limit). Каждая сессия экспортируется и анализируется независимо.
- **Settings Sync:** `docs:sync-settings` IPC — renderer пушит `apiSettings` + `docPrompt` в main process при mount и при изменениях. Main хранит в памяти (`docsConfig` в `ipc/docs.js`).
- **HTTP endpoint:** `POST /update-docs` в MCP HTTP bridge (main.js). Timeout: до 5 минут (зависит от числа сессий и размера).
- **API функции:** `callClaudeApi()` и `callGeminiApi()` вынесены как переиспользуемые exports из `ipc/docs.js`. Используются и IPC хендлером `docs:api-request`, и HTTP endpoint.

## Code Map
- **UI & Logic:** `src/renderer/components/Workspace/panels/ActionsPanel.tsx` -> `handleUpdateDocs`.
- **Main Process:** `docs:save-temp` — сохранение данных сессии в `<projectPath>/tmp/`. Промпт отправляется через `terminal:paste` → `safePasteAndSubmit(fast=true)` (Bracketed Paste Mode, chunked < 900B, 500ms delay before Enter).
- **Styles:** Анимация вращающегося кольца при загрузке.
- **Fixes:**
    - `knowledge/fact-export-session.md` — детали унифицированного экспорта.
    - `knowledge/fact-ux-patterns.md` — механизм удержания выделения табов.
    - `knowledge/fact-claude-tui-mechanics.md` — как работает вставка больших промптов.
