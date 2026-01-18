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