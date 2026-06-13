# Fix: Multi-instance MCP Isolation (PID-based Ports)

## Проблема
Изначально приложение использовало единый файл `~/.noted-terminal/mcp-port` для передачи номера порта HTTP-сервера MCP-клиентам (terminal / overseer server). Это создавало критические гонки (race conditions) при параллельном запуске нескольких экземпляров приложения (например, dev-версия и prod-версия, или два окна разработки).

### Симптомы
- MCP-вызов из AI-агента в одном окне "приземляется" в main-процессе другого окна (например, `terminal` MCP перезапускает вкладку не в том instance).
- Ошибка "MCP port file not found", если один экземпляр закрылся и удалил общий файл, пока второй ещё работает.
- Непредсказуемое поведение кнопок статуса и вставки результатов.

## Root Cause: Race Condition
1. **`startMcpHttpServer()`** → записывал порт в фиксированный путь. Последний запустившийся инстанс "побеждал", перезаписывая порт предшественника.
2. **`stopMcpHttpServer()`** → вызывал `unlinkSync` на общем файле при выходе. Это лишало связи все остальные работающие инстансы.

## Решение: PID-based Port Files
Система переведена на использование именных файлов портов, привязанных к PID главного процесса Electron.

1. **Запись:** Каждый инстанс пишет в `~/.noted-terminal/mcp-port-<process.pid>`.
2. **Очистка (Cleanup):** При старте приложение сканирует папку портов и удаляет файлы, чьи PID больше не существуют в системе (проверка через `process.kill(pid, 0)`).
3. **Удаление:** При нормальном выходе удаляется только файл, соответствующий текущему PID.

## Алгоритм обнаружения (Process Tree Walking)
Поскольку MCP-сервер (terminal / overseer) запускается самим AI-CLI (Claude / Gemini / Codex, который запущен в шелле, который запущен в `node-pty`), он не знает PID "своего" Electron напрямую. 

Для поиска правильного порта реализован **Process Tree Walking**:
1. **Цепочка:** `MCP-сервер (node)` → `AI-CLI (Claude/Gemini/Codex)` → `zsh/bash` → `Electron (node-pty)`.
2. **Strategy 1 (Exact Match):** Сервер берет свой PPID (AI-CLI) и поднимается вверх по дереву процессов (до 4 уровней). Для каждого родительского PID проверяется наличие файла `mcp-port-<PID>`. Это гарантирует точное попадание в тот инстанс Electron, который породил текущую сессию AI-CLI.
3. **Strategy 2 (Liveness Fallback):** Если дерево процессов недоступно, сканируются все `mcp-port-*` файлы. Выбирается самый свежий по `mtime`, чей процесс еще жив.
4. **Strategy 3 (Backward Compat):** Попытка прочитать старый `mcp-port` (для плавного перехода).

## Dashboard ownership поверх port-файлов
Те же PID-based port files являются source of truth не только для MCP routing, но и для destructive UI в Dashboard. Если dev и production custom-terminal работают параллельно, проверка «процесс не принадлежит текущему renderer tabId» недостаточна: такой процесс может принадлежать соседнему живому instance и должен быть защищён.

Dashboard поэтому строит карту владельцев из живых `mcp-port-<pid>` файлов, валидирует main PID и поднимается по parent chain Claude/Gemini/Codex/MCP процесса. Термин `external` в UI значит «не принадлежит ни одному живому custom-terminal instance». Для batch kill это критично: кнопка `external only` не должна закрывать вкладки dev из production и вкладки production из dev. Симптом старой логики — пользователь нажимает крестик в одном окне, а пропадают AI-процессы, открытые в другом окне.

## Invisible Intent: Почему не `execSync` в Main
Согласно правилам `CLAUDE.md`, Main-процесс не должен блокироваться на системных вызовах. Поэтому тяжелая работа по обходу дерева процессов (`ps -p PID -o ppid=`) вынесена в сам MCP-сервер (terminal / overseer), который является независимым процессом Node.js.

## Связанные файлы
- `src/main/main.js` — реализация записи и очистки портов (mcpHttpServer).
- `.claude/mcp/terminal-server.mjs`, `~/.claude/mcp/overseer-server.mjs` — клиенты, реализующие алгоритм поиска порта.
- [`fact-terminal-mcp.md`](fact-terminal-mcp.md) — архитектура terminal + overseer MCP поверх общего HTTP backend.
