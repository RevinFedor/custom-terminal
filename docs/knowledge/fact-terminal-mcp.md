# Feature: Terminal MCP Server

## Intro
MCP-сервер для управления терминальными вкладками из AI-агента (Claude Code, Gemini CLI). Позволяет агенту видеть запущенные dev-серверы, перезапускать процессы после изменения кода, читать output и выполнять build-цепочки — без ручного переключения вкладок пользователем.

## Архитектура

### Два MCP-сервера, один HTTP backend
Проект использует два отдельных MCP-сервера:
- `src/main/mcp-server.mjs` — Gemini→Claude delegation (sub-agents, history, status). Подробнее: [`fact-mcp-delegation.md`](fact-mcp-delegation.md).
- `.claude/mcp/terminal-server.mjs` — Terminal Management (tabs, restart, run, output).

Оба общаются с main process через один и тот же HTTP-сервер (`mcpHttpServer` на localhost). Порт обнаруживается через `~/.noted-terminal/mcp-port-<PID>`.

### Определение проекта
MCP-сервер определяет проект через `process.cwd()` (как knowledge-server). Это позволяет одному серверу обслуживать любой проект без конфигурации. Main process находит проект в SQLite по path и отдаёт только его вкладки.

### Tab Data: SQLite + Live State
`/terminal/tabs` объединяет данные из двух источников:
- **SQLite** (renderer → save-tabs): name, color, command_type, cwd, tab_id — снимок на момент последнего save
- **Main process Maps** (live): terminals (PTY alive?), terminalCommandState (isRunning), terminalInitialCommand, pid

## Soft Restart (Ctrl+C → re-run)

### Отброшенный подход: Hard Kill (pty.kill + recreate)
Первая реализация убивала PTY через `pty.kill()` и пересоздавала новый через IPC `terminal:mcp-restart` → renderer → `terminal:create`.

**Почему не работает:**
- `onExit` удаляет все Maps (terminals, terminalOutputBuffer, terminalCommandState) → `read_output` возвращает 404
- xterm показывает `[Process completed]` — ввод невозможен до пересоздания PTY
- Race condition: kill + IPC round-trip через renderer + create — 3 async шага с непредсказуемым timing
- Ctrl+C в shell запущенном через `-c "cmd; exec shell"` убивает весь PTY, не только cmd

### Текущий подход: Soft Restart
Тот же механизм что UI кнопка restart в TabBar.tsx:
1. **Ctrl+C** (`\x03`) → останавливает текущий процесс
2. **Ждёт OSC 133;D** (command-finished) — детерминированно через `terminalCommandState.isRunning`
3. **300ms пауза** для полного рендера prompt
4. **Re-run**: `term.write(restartCmd + '\r')`

Shell остаётся живым. Output buffer не теряется. PTY pid не меняется.

### Edge Cases
- **Process уже мёртв** (`isRunning = false`): Ctrl+C безвредно идёт в prompt, ожидание пропускается, команда отправляется сразу
- **Electron graceful shutdown**: electron-vite может завершаться 2-5 секунд. Timeout увеличен до 30s
- **initialCommand не сохранён** (пользователь набрал вручную): возвращается ошибка с требованием передать `command` параметром. Fallback `!!` убран — ненадёжен (пустая history, неправильная команда)
- **Ctrl+C trap**: Некоторые процессы ловят SIGINT. 30s safety timeout покрывает, но в теории возможны две копии процесса если timeout сработает до реального завершения

## Output Ring Buffer
`terminalOutputBuffer` — Map<tabId, {lines: string[], maxLines: 500}>. Заполняется синхронно в `ptyProcess.onData`. Не использует await (anti-pattern: async onData race). Удаляется в `onExit`.

## Развёртывание
Сервер копируется в каждый проект как `.claude/mcp/terminal-server.mjs`. Регистрация: `.mcp.json` (Claude) + `.claude/settings.json` (auto-approval) + `~/.gemini/settings.json` (глобальный для Gemini).
