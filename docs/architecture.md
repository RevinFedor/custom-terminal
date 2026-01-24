# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных и файловой системой.
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`), чтобы не блокировать Event Loop главного процесса и IPC. См. `knowledge/fix-ui-stability.md` (раздел 8).
    - **Vite & Escaping:** При написании Bash-команд в `main.js` необходимо экранировать `$`, чтобы избежать ошибок трансформации Vite. См. `knowledge/fix-main-process-escaping.md`.
    - **Stability:** Используется `disable-http-cache` для предотвращения загрузки устаревшего кода в продакшн-билдах. См. `knowledge/fix-terminal-colors.md`.
- **Renderer Process:** React 19 UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).

## 2. Data & Metadata Layer
- **SQLite (`noted-terminal.db`):** Хранит сессии AI (`ai_sessions`) и глобальное состояние приложения (`app_state`).
- **JSON (`projects.json`):** Хранит метаданные проектов, заметки и расширенные данные табов.
- **Tab Metadata:**
    - `commandType`: Тип процесса (`devServer`, `claude`, `gemini`, `generic`). Влияет на видимость кнопки Restart.
    - `colorSetManually`: Флаг, блокирующий автоматическую смену цвета таба при запуске команд.
    - `claudeSessionId`: UUID активной сессии Claude Code. См. `knowledge/fix-claude-id-capture.md`.
    - `wasInterrupted`: Статус некорректного завершения сессии.
- **Persistence Strategy:**
    - Дебаунс сохранение (300-500мс) для предотвращения фризов интерфейса. См. `knowledge/fix-data-persistence.md`.
    - При закрытии приложения (`beforeunload`) используется синхронный вызов для гарантии записи.

## 3. PendingAction Pattern
Механизм отложенного выполнения команд после создания нового терминала. Решает проблему: как выполнить internal-команду (например, `claude-f`) в новой вкладке, когда shell ещё не готов?

### Типы действий:
```ts
interface PendingAction {
  type: 'claude-fork' | 'claude-continue' | 'shell-command';
  sessionId?: string;  // Для claude-fork, claude-continue
  command?: string;    // Для shell-command
}
```

### Архитектура:
1. **Store (`useWorkspaceStore`):** Tab содержит поле `pendingAction?: PendingAction`.
2. **createTab / createTabAfterCurrent:** Принимает `options.pendingAction`. Для `shell-command` передаёт команду в PTY через `initialCommand`. Для internal-команд (`claude-fork`, etc.) — не передаёт.
3. **Terminal.tsx (`handleData`):** При первом выводе PTY (= shell готов) проверяет `pendingAction` и вызывает `executePendingAction()`.
4. **executePendingAction:** Отправляет IPC `claude:run-command` с нужными параметрами, затем очищает `pendingAction`.

### Почему не setTimeout:
- **Ненадёжно:** Произвольная задержка может не совпадать с реальной готовностью shell.
- **Event-driven:** Первый вывод от PTY — надёжный сигнал готовности. Shell уже прочитал `.zshrc` и готов к вводу.

### Пример использования (Fork в новую вкладку):
```ts
await createTabAfterCurrent(projectId, undefined, cwd, {
  pendingAction: { type: 'claude-fork', sessionId: '...' }
});
// Terminal.tsx при первом PTY output вызовет:
// ipcRenderer.send('claude:run-command', { command: 'claude-f', forkSessionId: '...' })
```

## 4. Terminal Integration
- **Backend:** `node-pty` + **Shell Integration (OSC 7)**. См. `knowledge/fact-osc7-cwd.md`.
- **Truecolor (24-bit):** Принудительная установка `COLORTERM`. См. `knowledge/fix-terminal-colors.md`.
- **Frontend:** `xterm.js` с **Canvas рендерером**. См. `knowledge/fix-ui-stability.md` (почему не WebGL).
- **Layering Pattern:** Использование слоев и Portals для отрисовки UI поверх Canvas. См. `knowledge/fix-layering-pattern.md`.
- **Large Input:** Разбиение на чанки (Chunking) для вставки промптов > 4KB. См. `knowledge/fix-pty-buffer-overflow.md`.

## 5. Debug Logger
Централизованная система логирования на базе библиотеки `debug`.
- **Файл:** `src/renderer/utils/logger.ts`.
- **Категории:** `app:claude`, `app:tabs`, `app:commands`, `app:perf`, `app:terminal`, `app:store`, `app:ui`.
- **Управление:** Включается через консоль DevTools: `localStorage.debug = 'app:*'`.
- **Хелперы:** Доступны через глобальный объект `window.debug`.

## 6. Styling & Rendering
- **Tailwind v4:** Использует JIT-компиляцию и директиву `@source` для сканирования `.tsx` файлов. См. `knowledge/fix-tailwind-v4-source.md`.
- **Dynamic Styles:** Для рантайм-цветов используются Inline Styles. См. `knowledge/fix-data-persistence.md`.
- **Markdown:** Специальный рендерер для исправления гидратации и inline-кода. См. `knowledge/fix-markdown-hydration.md` и `knowledge/fix-markdown-inline-code.md`.
- **Hotkeys:** Перехват `Cmd+Plus/Minus` для изменения шрифта терминала вместо системного зума. См. `knowledge/fix-ui-stability.md` (раздел 6).

## 7. UI Patterns & Modals
- **Context Modals (Notes, Research):** Должны рендериться внутри контейнера `Workspace` с использованием `absolute positioning` (inset-0) и `z-index: 50`. Контейнер Workspace должен иметь `relative`.
    - **Why:** Это обеспечивает правильное наложение поверх терминала, но сохранение контекста рабочей области, а также позволяет использовать "floating sheet" дизайн с отступами.
    - **Avoid:** Не использовать `createPortal(..., document.body)` для контекстных инструментов, так как это нарушает иерархию стилей и усложняет позиционирование относительно UI терминала.
- **Global Modals (Settings, Toasts):** Могут использовать Top-Level рендеринг в `App.tsx` или Portals, так как они должны перекрывать весь интерфейс независимо от контекста.
