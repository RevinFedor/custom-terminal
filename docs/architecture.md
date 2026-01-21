# Architecture (Техника)

## High-Level Overview (Project-Based Design)
Приложение построено на разделении контекстов проектов. Данные хранятся локально в JSON.

### 1. Data Layer (`project-manager.js`)
*   **Хранилище:** `~/Library/Application Support/custom-terminal/projects.json`
*   **Schema:** Ключ — это абсолютный путь к папке. Каждое свойство (notes, quickActions) привязано к пути.

### 2. IPC & Terminal Management
*   **Lifecycle:** `main.js` порождает `node-pty` процессы.
*   **Routing:** Каждый пакет данных содержит `tabId`. Renderer маршрутизирует данные в нужный инстанс `xterm.js`.
*   **Optimization:** `FLUSH_DELAY = 10ms` в `renderer.js` предотвращает "дрожание" интерфейса при интенсивном выводе.

### 3. AI Integration (Gemini)
*   Интеграция реализована на стороне Renderer.
*   Используется прямой `fetch` к Google API.
*   Результаты кешируются в памяти сессии проекта.

### 4. Styling System (Tailwind CSS v4)
*   **Build:** `npx tailwindcss -i ./input.css -o ./output.css --minify`
*   **Config:** `input.css` содержит theme (@theme), base styles (@layer base), components (@layer components)
*   **Custom CSS:** Все кастомные стили определяются в `input.css` через @layer
*   **Variables:** CSS variables определены в @theme для цветов, spacing, fonts
*   **Hot Reload:** В dev режиме изменения в `output.css` триггерят перезагрузку окна

### 5. File Preview System
*   **Location:** Overlay внутри `#main-container` (скрывает terminal + notes panel)
*   **Syntax Highlighting:** Highlight.js с VS2015 темой
*   **Supported:** 25+ языков (JS, TS, Python, Go, Rust, HTML, CSS, JSON, и т.д.)
*   **Features:** Line numbers, hover highlights, syntax colors
*   **Shortcuts:** ESC для закрытия, кнопка × в header

### 6. Tabs Persistence
*   **Storage:** `~/Library/Application Support/noted-terminal/projects.json`
*   **Per-Project:** Каждый проект имеет массив `tabs: [{name, cwd}]`
*   **Auto-save:** При создании/закрытии/переименовании таба
*   **Restore:** При открытии проекта табы восстанавливаются из JSON
*   **Isolation:** Tab IDs содержат projectId: `${projectId}-tab-${counter}`

### 7. Session Persistence (Gemini/Claude)

Система сохранения и восстановления сессий AI CLI (Gemini CLI, Claude Code).

#### Storage
*   **SQLite:** `~/Library/Application Support/noted-terminal/noted-terminal.db`
*   **Tables:**
    - `ai_sessions` — сессии (id, project_id, tool_type, session_key, content_blob, original_cwd, original_hash)
    - `session_deployments` — где сессия развёрнута (session_id, deployed_cwd, deployed_hash)

#### Gemini Export Flow
1. Пользователь в Gemini CLI
2. Нажимает Export → вводит имя
3. Приложение отправляет `/chat save <name>` в терминал
4. Ждёт "checkpoint saved" в выводе (ANSI-stripped)
5. Читает `~/.gemini/tmp/<SHA256(cwd)>/checkpoint-<name>.json`
6. Сохраняет в SQLite

#### Gemini Import Flow (Trojan Horse)
1. Получаем patchData из БД
2. Запускаем `gemini` → ждём "type your message"
3. Отправляем dummy сообщение `hi`
4. Ждём HIDE cursor (`\x1b[?25l`) — Gemini готов к вводу
5. `/chat save <tag>` → Gemini регистрирует тег в своём реестре
6. Ждём "checkpoint saved"
7. **Патчим** созданный файл нашим контентом (замена путей и хешей)
8. `/exit` → выход из dummy сессии
9. `gemini` → `/chat resume <tag>` → загружается наша сессия

#### Path Patching
При переносе сессии в другую директорию:
```javascript
// Замена путей
content = content.replace(/\/old\/path/g, '/new/path');
// Замена хешей
content = content.replace(/OLD_HASH/g, NEW_HASH);
```

#### Global Sessions
*   Сессии видны во **всех проектах** (не только где созданы)
*   UI показывает список папок (locations) где сессия доступна
*   Можно удалить из конкретной папки или из всех сразу

#### Interactive CLI Command Execution
Проблема: Gemini CLI в Raw Mode считает быструю отправку "paste" и не триггерит Enter.

Решение — задержка между текстом и Enter:
```javascript
term.write(command);
await sleep(150);
term.write('\r');
```

Async версия (`terminal:executeCommandAsync`) возвращает Promise, чтобы дождаться отправки перед следующей командой.

#### Key Files
*   `src/main/session-manager.js` — export/import логика
*   `src/main/database.js` — SQLite schema и методы
*   `src/renderer/.../SessionsPanel.tsx` — UI панель