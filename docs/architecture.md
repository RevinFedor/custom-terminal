# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных и файловой системой.
- **Renderer Process:** React UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).
- **Terminal Routing:** Данные от PTY содержат `tabId`. Renderer направляет их в соответствующий инстанс `xterm.js`.

## 2. Data Layer
- **SQLite (`noted-terminal.db`):** Хранит сессии AI (`ai_sessions`) и историю развертываний.
- **JSON (`projects.json`):** Хранит метаданные проектов, заметки, табы и Quick Actions. Путь: `~/Library/Application Support/noted-terminal/`.

## 3. Terminal Integration
- **Backend:** `node-pty` для создания псевдотерминалов.
- **Frontend:** `xterm.js` с аддоном WebGL для высокой производительности рендеринга.
- **Buffer Optimization:** `FLUSH_DELAY = 10ms` для предотвращения дрожания UI при интенсивном выводе.

## 4. Styling System
- Tailwind CSS v4 с JIT-компиляцией.
- Темы и переменные определены в `src/renderer/styles/globals.css`.
