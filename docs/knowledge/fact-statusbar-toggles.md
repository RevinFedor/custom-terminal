# Факт: StatusBar toggles (kill dev-ports, bridges, default effort)

## Зачем
StatusBar по нижнему краю app — место для **глобальных переключателей** (применимы ко всем проектам и табам), которые сложно вписать в правую панель отдельных компонентов. Каждый toggle меняет global behavior, не per-tab.

Текущие переключатели:
- **Effort selector** — default `defaultClaudeEffort` для всех новых Claude сессий (см. `fact-claude-tui-control.md::Auto-inject /effort при запуске Claude`)
- **kill dev-ports** — pre-kill портов перед npm-script start/restart/stop
- **bridges** — подсветка hover-bridges debug overlay

## kill dev-ports — visible shell-line, не background IPC

### Что делает
Когда **ВКЛ** — перед каждым запуском npm-скрипта / handleRestart / handleStop / handleStopScript renderer формирует композитную shell-строку:
```
lsof -ti:5181,3000 2>/dev/null | xargs -r kill -9 2>/dev/null; npm run dev
```
и **инжектит её целиком** через `terminal:input` IPC. Юзер видит строку в scrollback как будто сам её ввёл.

### Почему shell-line, а не background IPC
**Первая реализация:** `ipcRenderer.invoke('system:free-project-ports', cwd)` — main process выполнял `lsof | kill -9` через `execAsync`, ничего в терминале не показывал.

**Симптом:** юзер запускает `npm run dev`, тут же видит `npm` строчку без префикса, не понимает что что-то killилось. Жалоба: *"если она вводится как-то фоном, то в таком случае должно быть уведомление типа «остановлены какие-то порты»"*.

**Решение — visible shell-line:**
- **Видимость в scrollback** — юзер видит что точно убил
- **Shell-семантика `;` гарантирует ordering** — kill завершится **до** старта npm, без setTimeout race
- **History сохраняет** — re-up arrow повторит kill+run
- **Без отдельного toast — терминал сам показывает результат**

Принцип переносимый: для любых destructive side effects около пользовательских команд лучше показывать в общем потоке shell, чем тихий IPC + toast. См. `methodology/design.md::Visible side effect > silent IPC`.

### Port autodetect
`scanProjectPorts(cwd)` — рекурсия глубиной до 1 (immediate subfolders, для monorepo типа `uav/agrofield_back` + `uav/agrofield_front`). Источники в приоритете:
1. **`package.json::notedTerminal.ports`** — manual override `{ "notedTerminal": { "ports": [3000, 5173] } }`
2. **vite-конфиги** (`vite.config.{ts,js,mjs}`, `electron.vite.config.*`) — regex `\bport\s*:\s*(\d+)`
3. **`.env / .env.local / .env.development`** — `^[A-Z_]*PORT\s*=\s*(\d+)`
4. **NestJS `src/main.ts`** — `app.listen(process.env.PORT || NNNN)` fallback literal

Cache `projectPortsCache` per-cwd, TTL 30s — иначе grep на каждый start/stop замедляет повторные циклы.

### SIGKILL без grace, не SIGTERM
Семантика toggle — *"make the port available NOW, не negotiate"*. Никаких 800ms grace period как у `terminal:stop-ai-process` (для Claude процессов). Если кто-то держит порт — он будет killed без объяснений. Acceptable: юзер явно включил toggle = принял этот контракт.

### Покрытые точки запуска
Все 4 пути через единый `buildKillPortsPrefix(tabId)` helper в TabBar:
- TabBar Scripts submenu → `npm run X` click
- TabBar split-button Stop run-dev
- TabBar restart-кнопка ↻
- Terminal native context menu → run-script (через `App.tsx::run-script` handler — отдельная цепочка, та же логика kill-prefix)

### Persistence — SQLite через app:setState
Toggle хранится в SQLite, не в localStorage. Та же причина что у `defaultClaudeEffort` (см. `fix-environment.md::localStorage origin trap`): vite-port в dev меняется → разный origin → разный localStorage. SQLite в main process origin-independent, выдерживает port shifts.

Legacy mirror в localStorage сохраняется (для синхронного init), но **authoritative source — SQLite**.

## Geometry: расположение в StatusBar

Все toggles справа, разделены `gap-2`. Левая часть зарезервирована под status indicators (git/lints/etc — пока пусто).

Между EffortSelector (specialised popover-toggle) и binary toggles — `gap-2` визуально достаточно, не нужен divider.

## Что пробовали и почему отбросили

- **`fs.watch` на занятые порты** — для авто-удержания свободного списка. Слишком сложно, race conditions с реактивацией портов системой. Cache + invalidate on scroll proven simpler.
- **Background `execAsync` без shell-line** — работало технически, но провалилось по UX (юзер не видит что произошло). Заменено на shell-line injection.
- **`pkill` по pattern (node, vite)** — слишком agressive, может убить чужие процессы. `lsof -ti:PORT` точечный — только держатели конкретного порта.

## Связанные подсистемы

- `fix-environment.md::localStorage origin trap` — почему SQLite, не localStorage
- `fact-claude-tui-control.md::Auto-inject /effort` — EffortSelector в той же StatusBar
- `methodology/design.md::Visible side effect > silent IPC` — переносимый принцип
