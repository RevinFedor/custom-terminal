# Факт: StatusBar toggles (kill dev-ports, bridges, default effort)

## Зачем
StatusBar по нижнему краю app — место для **глобальных переключателей** (применимы ко всем проектам и табам), которые сложно вписать в правую панель отдельных компонентов. Каждый toggle меняет global behavior, не per-tab.

Текущие переключатели:
- **Effort selector** — default `defaultClaudeEffort` для всех новых Claude сессий (см. `fact-claude-tui-control.md::Auto-inject /effort при запуске Claude`)
- **kill dev-ports** — pre-kill портов перед npm-script start/restart/stop
- **bridges** — подсветка hover-bridges debug overlay
- **streamer mode** — visual redaction для remote-control URL в toolbar/mobile companion, чтобы public endpoint не попадал в screen-share

## streamer mode — visual redaction remote URL

Streamer mode — глобальный app-level toggle, не per-project и не per-tab. Он скрывает `WebServerChip` с `remote-control.f9922.tech:8443` / `local:<port>` из нижнего toolbar, но **не** останавливает web-server, autossh tunnel, SSE или bearer-token auth. Смысл — privacy для стрима/скриншота: пользователь продолжает управлять Terminal с телефона, просто endpoint не светится на экране.

Toggle живёт слева рядом с remote chip, а не в Settings: это режим видимости текущей публичной поверхности, его надо включать одним жестом прямо перед демонстрацией. Persistence такая же origin-safe app-state модель, как у остальных global settings: synchronous local mirror для мгновенного init + authoritative `app:setState` в SQLite/main, чтобы dev vite-port shifts не сбрасывали режим. Mobile-web меняет тот же флаг через `/api/app-settings`; нативные клиенты, которые сами рисуют host, должны иметь эквивалентный redaction state. Переносимый принцип — `methodology/переносимый-дизайн.md::Privacy-toggle скрывает sensitive surface`.

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

Принцип переносимый: для любых destructive side effects около пользовательских команд лучше показывать в общем потоке shell, чем тихий IPC + toast. См. `methodology/переносимый-дизайн.md::Visible side effect > silent IPC`.

### Port autodetect
`scanProjectPorts(cwd)` — рекурсия глубиной до 1 (immediate subfolders, для monorepo типа `uav/agrofield_back` + `uav/agrofield_front`). Источники в приоритете:
1. **`package.json::scripts` ignore env** — `NOTED_TERMINAL_IGNORE_PORTS=6379,9000,9001 npm run dev` / `NOTED_TERMINAL_IGNORE_PORTS=6379,9000,9001 ./scripts/dev.sh`. Preferred способ для сложных monorepo: проект не перечисляет какие app-порты надо убивать, а только объявляет инфраструктуру, которую трогать нельзя.
2. **`package.json::scripts` explicit override** — `NOTED_TERMINAL_PORTS=3005,5175 npm run dev`. Использовать только когда автодетект принципиально невозможен; это не preferred путь, потому что заставляет сопровождать kill-list вручную.
3. **`package.json::notedTerminal.ports`** — legacy/manual override `{ "notedTerminal": { "ports": [3000, 5173] } }`.
4. **vite-конфиги** (`vite.config.{ts,js,mjs}`, `electron.vite.config.*`) — regex `\bport\s*:\s*(\d+)`.
5. **`.env / .env.local / .env.development`** — app-порты `PORT=`, `BACKEND_PORT=`, `FRONTEND_PORT=`. Infra-порты (`REDIS_PORT`, `POSTGRES_PORT`, `MINIO_PORT`, `S3_PORT` и аналоги) дополнительно исключены, иначе `kill dev-ports` может убить Docker/OrbStack port-forward вместо старого dev-server.
6. **NestJS `src/main.ts`** — `app.listen(process.env.PORT || NNNN)` fallback literal, только если более явный app-порт не найден.

Cache `projectPortsCache` per-cwd, TTL 30s — иначе grep на каждый start/stop замедляет повторные циклы.

Шрам 17.06.2026: в `uav/agrofield_back/.env` был `REDIS_PORT=6379`, scanner считал его dev-портом и visible shell-line превращалась в `lsof -ti:3001,5175,6379 | xargs kill -9; npm run dev`. На macOS `6379` держит OrbStack forwarder для Redis, поэтому kill ломал Docker/Redis перед стартом backend → `ECONNREFUSED 127.0.0.1:6379`. Fix: для `uav` root script объявляет только ignore-list `NOTED_TERMINAL_IGNORE_PORTS=6379,9000,9001 ./scripts/dev.sh`; scanner продолжает сам находить app-порты и после вычитания ignore-list отдаёт `[3005,5175]`.

### SIGKILL без grace, не SIGTERM
Семантика toggle — *"make the port available NOW, не negotiate"*. Никаких 800ms grace period как у `terminal:stop-ai-process` (для Claude процессов). Если кто-то держит порт — он будет killed без объяснений. Acceptable: юзер явно включил toggle = принял этот контракт.

### Покрытые точки запуска
Все 4 пути через единый `buildKillPortsPrefix(tabId)` helper в TabBar:
- TabBar Scripts submenu → `npm run X` click
- TabBar split-button Stop run-dev
- TabBar restart-кнопка ↻
- Terminal native context menu → run-script (через `App.tsx::run-script` handler — отдельная цепочка, та же логика kill-prefix)

### Persistence — SQLite через app:setState
Toggle хранится в SQLite, не в localStorage. Та же причина что у `defaultClaudeEffort` (см. `fix-localstorage-origin.md`): vite-port в dev меняется → разный origin → разный localStorage. SQLite в main process origin-independent, выдерживает port shifts.

Legacy mirror в localStorage сохраняется (для синхронного init), но **authoritative source — SQLite**.

## Geometry: расположение в StatusBar

Большинство глобальных toggles справа, разделены `gap-2`. Исключение — streamer mode: он стоит слева рядом с `WebServerChip`, потому что меняет видимость именно соседнего remote URL и должен читаться как быстрый privacy switch перед stream/share.

Между EffortSelector (specialised popover-toggle) и binary toggles — `gap-2` визуально достаточно, не нужен divider.

## Что пробовали и почему отбросили

- **`fs.watch` на занятые порты** — для авто-удержания свободного списка. Слишком сложно, race conditions с реактивацией портов системой. Cache + invalidate on scroll proven simpler.
- **Background `execAsync` без shell-line** — работало технически, но провалилось по UX (юзер не видит что произошло). Заменено на shell-line injection.
- **`pkill` по pattern (node, vite)** — слишком agressive, может убить чужие процессы. `lsof -ti:PORT` точечный — только держатели конкретного порта.

## Связанные подсистемы

- `fix-localstorage-origin.md` — почему SQLite, не localStorage
- `fact-remote-access.md::Streamer mode` — что именно скрывается у public URL и что не выключается
- `fact-claude-tui-control.md::Auto-inject /effort` — EffortSelector в той же StatusBar
- `methodology/переносимый-дизайн.md::Visible side effect > silent IPC` — переносимый принцип
