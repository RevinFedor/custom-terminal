# Claude Session Detection: Research & Findings (2026-02-09)

## Проблема
Как связать PID запущенного Claude Code CLI с конкретным `.jsonl` session файлом **ретроактивно** (когда момент старта пропущен)?

## Текущее решение: Sniper Watcher
`startSessionSniper()` — dual-method (fs.watch + polling 1с) ловит session ID **в момент создания** `.jsonl` файла. Работает для 99% кейсов. Detect кнопка в InfoPanel — fallback, использует lsof + mtime.

## Что НЕ работает (проверено тестами)

| Метод | Почему не работает |
|-------|-------------------|
| `lsof -p PID \| grep .jsonl` | Claude открывает файл на append и **сразу закрывает** — нет постоянного FD |
| `sessions-index.json` | Не всегда существует (зависит от версии Claude) |
| `mtime -5min` fallback | Idle сессия >5 мин — файл не найдётся |
| `~/.claude/session-env/` | 289 папок, **все пустые** (0 files). Бесполезно |
| `CLAUDE_SESSION_ID` env var | Не реализовано — feature request #17188 открыт |
| Lock-файл `{session}.lock` | Не реализовано — feature request #19364 открыт |
| Парсинг первой строки .jsonl | Ненадёжно (см. ниже) |

## Парсинг .jsonl — детальный анализ

### Идея
Каждый `type: "user"` entry содержит `sessionId` и `cwd`. Можно сопоставить CWD процесса с CWD в файле.

### Тестирование (863 файла)
- **222 (25%)** — filename == entry.sessionId (корректно)
- **196 (23%)** — filename != entry.sessionId (session chain: fork/clear context создают новый файл, но первая строка ссылается на старый sessionId)
- **223 (26%)** — нет sessionId вообще (первая строка = `type: "summary"` после `/compact`)
- **222 (26%)** — пустые/parse error

### Критическая проблема
При нескольких сессиях в одном CWD (частый кейс для `custom-terminal` с 248 .jsonl файлами) — **выбирает неправильную сессию** по mtime. Тест подтвердил: для `--resume af8bd4a8...` алгоритм выбрал `7ff6c081...` (более свежий mtime, но чужая сессия).

## Что РАБОТАЕТ

### `ps -p PID -o args=` → `--resume <uuid>`
Если Claude запущен с `--resume`, session ID **прямо в аргументах процесса**. Но бесполезно для нас: при resume ID уже сохранён в БД.

### Hooks (`SessionStart`)
Claude Code поддерживает hooks в `~/.claude/settings.json`. При старте сессии hook получает JSON на stdin:
```json
{
  "session_id": "...",
  "transcript_path": ".../.jsonl",
  "cwd": "...",
  "source": "startup|resume"
}
```
**Подтверждено тестом.** Но это проактивный метод (ловит при старте) — то же самое что Sniper Watcher.

### `--session-id <uuid>` flag
Можно передать pre-generated UUID при запуске. Claude создаст файл с этим именем. Но мы контролируем запуск через Sniper, поэтому избыточно.

## Fix: Bridge File Filtering (Parallel Session Bug)

### Симптомы
В боковой панели управления сессией (InfoPanel) отображается история или ID из другого открытого проекта, либо кнопка "Продолжить" (Resume) пытается запустить не ту ветку диалога, которая видна в терминале.

### Баг
При параллельных Claude сессиях в одной директории Sniper мог поймать bridge-файл чужой сессии. Сценарий:
1. Сессия A работает в `/custom-terminal/`
2. Запускаем сессию B → Sniper стартует, snapshot фиксирует существующие файлы
3. Сессия A делает Clear Context → Claude создаёт новый `.jsonl` (bridge-файл)
4. Sniper B ловит bridge-файл, думая что это сессия B → **неверный ID**

### Ключевой инсайт
- **Bridge-файл** (от Clear Context): первая строка имеет `entry.sessionId !== filename` (указывает на родительскую сессию)
- **Fresh-файл** (новая сессия): первая строка имеет `entry.sessionId === filename`

### Тестирование (865 файлов)
- 178 (20.6%) — fresh (`sessionId === filename`) → корректно ACCEPT
- 163 (18.8%) — bridge (`sessionId !== filename`) → корректно REJECT
- 244 (28.2%) — нет uuid (не релевантно для Sniper)
- 280 (32.4%) — пустые/parse error

### Решение
В `checkFile()` после проверки времени — читаем первые 2KB файла:
- Если `entry.sessionId !== fileSessionId` → **SKIP** (bridge от другой сессии)
- Если файл пустой/непарсится → **return**, ждём следующий poll
- Если `entry.sessionId === fileSessionId` → **ACCEPT**

Код: `src/main/main.js`, функция `startSessionSniper()` → `checkFile()`.

## Вывод
Claude Code CLI **не предоставляет** прямого механизма для связи PID → Session ID через системные API (lsof, ps). 

### Итоговая стратегия (v3.0):
1. **Основной канал:** `StatusLine Bridge`. Мы используем легальную возможность Claude Code вызывать внешний скрипт после каждого ответа. Это дает 100% точность привязки через PID, так как скрипт запускается как дочерний процесс конкретного инстанса Claude.
2. **Интерактивный fallback:** Перехват вывода команды `/status` в терминале.
3. **Ручной ввод:** Возможность вставить UUID вручную через UI (✎).
4. **Архив:** Старая логика Sniper Watcher (отслеживание файлов) сохранена как `docs/knowledge/fact-legacy-sniper-watcher.md`, но не рекомендуется к использованию из-за "ловушки параллельных сессий".

## Потенциальные будущие решения
- Если Anthropic реализует lock-файл (#19364) — читать `{session}.lock`
- Если добавят env var (#17188) — читать через `ps eww` (но только для env на момент запуска)
- Hooks как альтернатива Sniper: прописать один раз в settings.json, hook пишет `.active-session.json` — Detect читает его

## Fix: Bridge CWD Guard (Foreign Resume Overwrites Tab)

### Симптомы
- Пользователь вводит `claude --resume <foreignId>` в табе проекта A — sessionId таба молча меняется на чужую сессию из проекта B
- В табе hh-tool появляется sessionId сессии из удалённого проекта cli-tools — настоящая сессия про hh-tool errors затирается
- Re-run `claude --resume` каждый раз пере-присваивает чужой sid вместо того что прописан в БД таба

### Природа бага
StatusLine Bridge определяет `tabId` через PID tree: `bridge.ppid (Claude PID) → parent shell PID → match to PTY`. PID-резолв даёт точную привязку к табу, но **не сверяет cwd**. Если Claude всё-таки запустился (нашёл JSONL в slug соответствующем cwd сессии, не текущему cwd таба) — bridge получит `data.session_id = <foreign>` и `data.cwd = <other-project>`, но tabId резолвится по PID правильный → `setClaudeSessionId(tabId, foreign)` → перезапись.

### Решение
В `processFile()` сразу после tabId resolve сравнивается `data.cwd` и `terminalProjects.get(tabId)`. Если пути unrelated, CwdGuard блокирует только main-side takeover vectors: не вызываются `terminalProjects.set` и `bridgeKnownSessions.set`, но renderer-side `claude:session-detected` может быть отправлен один раз для нового sessionId, потому что PID tree уже доказал, что live Claude parented этим PTY. Если пути related (ancestor/descendant), событие принимается для текущего апдейта, но canonical cwd таба всё равно не переписывается из bridge.

### Edge cases
- Пользователь делает `cd /other-project && claude` в табе → renderer получает OSC 7-кандидат от PTY → main подтверждает его по существующей директории и cwd живого shell-процесса → только положительный ACK меняет `tab.cwd`/`terminalProjects` → bridge.cwd = новый cwd → match → sessionId записывается. Это не bridge-mutate path: `processFile()` не должен переписывать canonical cwd из `bridge.cwd`. Обрезанный OSC, mismatch или `unknown` от process lookup оставляют последний хороший cwd; см. `fact-terminal-core.md::Reactive CWD Tracking`.
- Конфликт: таб привязан к hh-tool, юзер делает `cd /tmp && claude --resume <hh-toolSid>` — bridge.cwd = `/Desktop/hh-tool` (cwd сессии), tabCwd = `/tmp` → unrelated mismatch. Main-side caches не мутируются, чтобы чужой bridge не захватил tab; renderer-side persistence может получить sessionId только как восстановление конкретного live PTY после PID-resolution, без ослабления `terminalProjects`.

## Fix: Dead session_links + chain resolve trap

### Симптомы
- Manual ✎ Replace Session ID применился, но через секунду откатывается на другой UUID — ручной ввод не «прилипает».
- Timeline пустой (0 entries) сразу после того как Bridge захватил свежий sessionId; в логах `[Timeline:ChainResolve] OVERWRITE` тут же сменяет sessionId на UUID без `.jsonl` на диске.
- В правом сайдбаре после `claude-r <known-good-uuid>` показывается посторонняя сессия, чей UUID существует только как директория `<uuid>/subagents/` без JSONL.

### Природа бага
Три части собрались в один тихий сценарий. Subagent fork-flow внутри Claude TUI создаёт `~/.claude/projects/<slug>/<uuid>/subagents/` — UUID-папку без JSONL. `saveSessionLink(parent, child)` в `database.js` пишет любую ротацию sessionId которую видит Bridge, не проверяя что у child реальный файл. Со временем таблица `session_links` забивается мёртвыми ссылками. Тогда `resolveLatestSessionInChain` (`claude-data.js`), который вызывается в конце `claude:get-timeline`, идёт через `getSessionChild()` по этой таблице вперёд и возвращает renderer'у dead UUID как `latestSessionId`. Renderer видит расхождение с текущим sessionId и **перезаписывает store** через `setClaudeSessionId(tabId, <dead-uuid>)`. Следующий poll Timeline'а уже грузит несуществующий файл, видит `File not found`, рисует пустоту.

Production-аудит (2026-05-15): в одной БД 45 записей в `session_links`, **44 мёртвых**. ✎ flap воспроизводился стабильно для любой сессии у которой была хоть одна мёртвая ссылка вниз по цепочке.

### Решение
Liveness-guard на трёх уровнях, общий probe — `findSessionFile(uuid, cwd)` (null если `<uuid>.jsonl` нигде нет):

1. **`saveSessionLink(parent, child)`** в `database.js` — отказывается писать row если у child нет JSONL. Помечает в логе как `SKIPPING dead child ... (no JSONL file — likely subagent directory)`.
2. **`resolveLatestSessionInChain`** в `claude-data.js` — перед тем как принять `getSessionChild()` результат, проверяет `findSessionFile`. Если null — `break`, цепочка обрывается на последнем живом UUID.
3. **`resolveSessionChain`** (backward walk) — симметричный guard для `getSessionParent()`. Защита на будущее: если когда-то мёртвая запись попадёт со стороны родителя, цепочка не сломается.

Старая БД чистится разово SQL-скриптом (`DELETE FROM session_links WHERE child_session_id IN (...)` для всех UUID без `.jsonl`). Бэкап создаётся автоматически. См. [`fix-dead-session-link-overwrite.md`](fix-dead-session-link-overwrite.md) для процедуры и точного скрипта.

### Что НЕ ломаем
`latestSessionId` overwrite остаётся легитимным механизмом для Clear Context chains: parent JSONL заканчивается bridge entry на child, Timeline корректно прыгает вперёд в child, юзеру не нужно вручную менять таб. Guard срабатывает только когда цепочка указывает в пустоту.

## Fix: Stale bridge files + pendingResume guard

### Симптомы
- AutoResume сразу после рестарта приложения пишет `claude --resume <correctSid>` в новый PTY, и через 1-2 секунды claudeSessionId таба «сам собой» меняется на чужой UUID — часто на сессию из этого же проекта **двухмесячной давности**.
- Timeline затем фейлит с `[SessionChain] File not found for: <foreignSid>` и `[Timeline:Backtrace] No lastRecord for session: <foreignSid>`.
- Юзер вручную делает `claude --resume <X>` несколько раз, перебирая возможные UUID — каждая попытка перетирает claudeSessionId, история теряется без следа.

### Природа бага
Claude CLI **никогда не удаляет** свои bridge-файлы `~/.claude/bridge/<sid>.json` после exit, они копятся годами в одной директории с активными. Наш `processFile()` после рестарта Electron'а делает initial scan всех файлов в директории — встречает древнюю запись с `ppid` от давно умершего процесса. `ps -p <ppid> -o ppid=` неожиданно возвращает валидный родительский PID, потому что **ОС переиспользовала номер** для свежего shell'а нашей же только что созданной вкладки. Path-prefix tolerance из `Bridge:CwdGuard` пропускает mismatch (bridge.cwd = parent project, tabCwd = subdirectory — одна ветка ФС), и `claude:session-detected` уезжает в renderer с мёртвым sessionId, до того как реальный resumed claude успел дописать свой bridge.json.

Дополнительный путь race: рендерер слепо доверяет любому `claude:session-detected` IPC. Между моментом когда AutoResume записал `claude --resume <Y>` в PTY и моментом когда реальный bridge file для `<Y>` появится на диске — окно 1-3 секунды, в которое любой stale bridge с матчем по PID-tree успевает выиграть гонку.

### Решение (5 слоёв)
Все защиты обязательны вместе — каждая закрывает свою часть отказа, по отдельности дыры остаются.

1. **`processFile()` — transcript existence probe.** `fs.existsSync(data.transcript_path)` — если JSONL удалён вручную или сессия была вычищена, bridge.json — tombstone, skip. Лог `[Bridge:DeadTranscript] <file> references missing JSONL — ignoring forever`, dedupe через `bridgeStaleLogged` Set.
2. **`processFile()` — `updated_at` freshness probe.** `now - data.updated_at > BRIDGE_STALE_SECONDS` (600s) → skip. Живой Claude переписывает bridge.json после каждого assistant turn, 10 минут без апдейта = процесс умер.
3. **`processFile()` — command-name validation.** `ps -p <ppid> -o ppid=,command=`, regex по `claude` в commandline. Без этого PID reuse матчит случайные процессы. Лог `[Bridge:NotClaude] ppid=N command="..." — PID reuse, ignoring`.
4. **`processFile()` — убран `terminalProjects.set(tabId, bridge.cwd)` в path-drift ветке.** Раньше при принятии cwd-drift событие overwrite'ило canonical tab cwd на cwd зомби — следующие проверки становились ещё слабее. Теперь drift принимается **только для текущего вызова**, canonical cwd таба не трогается.
5. **`pendingResume` Map (`src/renderer/utils/pendingResume.ts`).** Любой код-path, пишущий `claude --resume <X>` в PTY, обязан вызвать `markPendingResume(tabId, X)`. `Terminal.tsx::handleSessionDetected` дропает bridge events с sessionId ≠ pending в течение 15 секунд. Wired в 6 точках: AutoResume (App.tsx), Claude Intercept Case 5 + Case 2 (Terminal.tsx), fork flows ×2, и сам bridge-success path очищает флаг.

### Last line of defense: claude_session_history
Колонка `tabs.claude_session_history TEXT` (JSON, cap 5 entries `{sessionId, reason, at}`) пишется автоматически когда `setClaudeSessionId(tabId, newSid, reason)` меняет значение. Reason — `SessionWriteReason` sealed union: `bridge` / `autoResume` / `userIntercept` / `userManual` / `timelineChain` / `fork` / `restoredFromDb` / `userRevert` / `unknown`. TabBar context-menu → «Revert Session ›» submenu показывает historystack с reason'ом и относительным временем каждой записи, один клик возвращает значение. Это страховка: если все 5 защитных слоёв всё-таки пропустят wrong write, юзер откатывается одним кликом, не grep'ая production.log.

### Связанные failure modes
- `## Fix: Bridge CWD Guard` (выше) — overwrite от **foreign-cwd resume**, не от stale file. Срабатывает когда юзер сознательно делает `claude --resume <chuzhoy-sid>` в `cd /tmp`.
- `## Fix: Dead session_links + chain resolve trap` (выше) — overwrite от **Timeline chain resolver**, не от bridge. Срабатывает когда в SQLite `session_links` есть мёртвые child UUID без JSONL.
- Все три — одна общая категория: «автоматический writer перетирает sessionId таба без подтверждения». Защитные слои разные, но контракт один: `setClaudeSessionId` теперь требует `reason: SessionWriteReason` от любого нового call-сайта (sealed union — TS не даст забыть).

Полный incident report (UTC хронология 2026-05-18, root cause analysis, обоснование «почему не SessionService») — `fix-bridge-stale-takeover.md`. Принцип «масштаб рефактора = масштабу проблемы» — `methodology/переносимый-дизайн.md`.
