# Fix: Зелёный индикатор активного процесса не появляется в MCP-табах с command

### Симптомы
- Создаёшь таб через MCP (`mcp__terminal__create_tab` с `command: "npm run dev"`), процесс реально запущен в Dock'е и в `ps`, но на самом табе **нет зелёного кружочка активного процесса**.
- В UI выглядит как «пустой» зелёный таб без bake'a активности, хотя dev-сервер раздаёт страницу и реально работает.
- В прод-логе для этого таба полностью отсутствуют события `[OSC 133]` — ни `Command STARTED (B)`, ни `Command FINISHED (D)`, ни `Prompt ready (A)`. Соседние табы (созданные через UI) такие события исправно генерируют.
- `isCommandRunning` в renderer'е остаётся `false` навсегда, потому что слушает события `terminal:command-started`/`terminal:command-finished` из main, а главный не получает OSC 133 из PTY.
- Симптом одинаков и для UI-индикатора, и для PromptQueueOverlay-гейта `claudeProcessAlive` (та же event-цепочка).

## Корневая причина

Старая реализация `terminal:create` при наличии `initialCommand` спавнила PTY так:
```js
shellArgs = ['-l', '-c', `${initialCommand}; exec ${shell}`];
```
Два слоя проблем складывались:

1. **`zsh -c "..."` стартует non-interactive shell.** В non-interactive mode zsh **не вызывает** `precmd`/`preexec` хуки. Наша shell-integration (`~/Library/Application Support/noted-terminal/shell-integration/.zshrc`) шлёт OSC 133 ровно из этих хуков:
   ```bash
   __ct_precmd() { printf "\033]133;D;%s\007" "$?"; printf "\033]133;A\007" }
   __ct_preexec() { printf "\033]133;B\007"; printf "\033]133;C\007" }
   ```
   То есть для команды `npm run dev` запущенной через `-c` **ни одного OSC 133 не отправлено** — preexec не запускается потому что shell не interactive, не было «нажатия Enter» от юзера.

2. **`exec /bin/zsh` после команды** запускает чистый shell в том же PID'е. ZDOTDIR унаследуется, но `.zshrc` в exec'нутом shell **не источится** потому что это не login (`-l` ушёл с исходным процессом) и не interactive (`-i` мы тоже не передавали). Даже после возврата к prompt'у OSC 133 хуки не зарегистрированы.

Конкретный лог-снапшот, который это подтвердил (tab-445 в проде, создан через MCP `/terminal/create`):
- `PTY:CREATED ... args=["-l","-c","NODE_ENV=development npm run dev; exec /bin/zsh"]` — спавн произошёл.
- Файл `pendingAction` в Zustand сразу же выполнился как `shell-command` → ушёл в `initialCommand`.
- В течение всего окна 23:52:47 → 23:53:30 — **ноль** строк `[OSC 133] Tab ...-tab-445`.
- В то же время для соседнего tab-314 (UI-созданный) — десятки `[OSC 133] Command STARTED (B)` / `FINISHED (D)`.

## Решение: event-driven dispatch вместо shell-flag-обёртки

Спавним всегда **пустыми** `shellArgs=[]` (наш ZDOTDIR + interactive zsh → precmd/preexec загружаются как обычно). При наличии `initialCommand` — одноразовый internal listener на `terminal:prompt-ready-internal`, который fires когда мы парсим первый `OSC 133 A` из PTY-вывода. На этом event'е `ptyProcess.write(initialCommand + '\r')`:

```js
const ptyProcess = pty.spawn(shell, [], { env: shellEnv, ... });

if (initialCommand) {
  let dispatched = false;
  const tryDispatch = (_, evtTabId) => {
    if (evtTabId !== tabId || dispatched) return;
    dispatched = true;
    ipcMain.removeListener('terminal:prompt-ready-internal', tryDispatch);
    ptyProcess.write(initialCommand + '\r');
  };
  ipcMain.on('terminal:prompt-ready-internal', tryDispatch);
  setTimeout(() => { /* 5s safety */ }, 5000);
}
```
И в OSC 133 parser добавлен `ipcMain.emit('terminal:prompt-ready-internal', null, tabId)` рядом с существующим renderer-facing `terminal:prompt-ready` send.

Этот path идентичен тому что делает `mcp__terminal__run_command` (или `/terminal/restart`) — `term.write(cmd + '\r')` в живой interactive shell. preexec срабатывает → OSC 133 B → renderer узнаёт → зелёный кружок зажигается. Никаких ручных тайм-аутов — детерминированно ждём именно того сигнала, который доказывает что shell-integration загрузился.

## Что пробовали и почему отбросили

- **`zsh -i -c "<cmd>; exec zsh"`** (interactive + command) — preexec **всё равно** не fires в combined-mode по дизайну zsh, плюс `exec zsh` без login/interactive флага запустит plain shell без `.zshrc`. Не решает.
- **Инжекция OSC 133 хуков прямо в `-c "<cmd>"` строку** — `printf '\033]133;B\007'; <cmd>; printf '\033]133;D;%s\007' $?`. Технически работает для одной команды, но `exec shell` после неё всё равно не зарегистрирует хуки на будущие команды юзера — таб станет «полу-рабочим», первая команда видна, следующие — нет. Не консистентно.
- **Дополнительная пауза перед `term.write`** (синхронный setTimeout 500-1000ms) — попадание зависит от того насколько быстро прогрузился user-`.zshrc`. На медленных машинах (oh-my-zsh + plugins) тайм-аут не хватал, на быстрых — лишняя задержка. Заменено на event-driven wait.

## Связанные

- `fact-terminal-core.md::Fix: Process Status Polling → OSC 133 Event-Driven` — общий контракт «индикатор активного процесса = OSC 133 events, не polling».
- `methodology/переносимый-дизайн.md::Программные команды по тому же каналу что юзерские, не через shell-flag-обёртку` — переносимый принцип, выведенный из этого фикса.
