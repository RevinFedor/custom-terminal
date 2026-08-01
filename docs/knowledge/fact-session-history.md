# Feature: Cross-session history tools

## Intro
History-tools единого Terminal MCP позволяют **любой полноценной вкладке читать историю любой другой Claude/Codex-сессии** поверх тех же JSONL-парсеров, что Timeline. Это peer-доступ к транскриптам, а не отдельный управляющий процесс. Публичный `overseer MCP` удалён; старое имя `/overseer/*` пока остаётся только у внутренних HTTP-маршрутов.

Редактирование истории остаётся **Claude-only**. Claude JSONL имеет `parentUuid`-цепочку и существующий edit-range/fork pipeline, поэтому `fork_session` / `propose_edit` / `apply_edit` идут через Timeline IPC. Codex rollout читается для discovery/stats/turn pull, но не переписывается: файл append-only принадлежит живому Codex CLI и не имеет Claude edit-range модели.

Процедура выбора методов находится в глобальном skill `~/.claude/skills/terminal/SKILL.md`; отдельный prompt со списком endpoint'ов больше не нужен.

## Почему peer-доступ не равен делегации

Четыре параллельных JSONL в четырёх процессах нельзя слить в один turn без потери временной нити, поэтому нужен адресуемый read/edit чужой истории. Полноценная делегация — другой контракт: persistent run Project API с completion-уведомлением и точным result endpoint. Временная декомпозиция без отдельной вкладки принадлежит встроенным subagent-инструментам Claude/Codex.

## Внутренняя граница единого Terminal MCP

Namespace объединён, ownership нет:
- live process/scenario tools действуют на текущий runtime;
- history-tools читают сохранённый transcript и только для Claude могут вызвать подтверждённый edit/fork pipeline.

Один MCP нужен для обнаруживаемости нейронкой, а не для слияния реализаций. Подробнее см. [`fact-terminal-mcp.md`](fact-terminal-mcp.md).

## History-tools: granular-чтение + редактирование

**Чтение** — agent сам решает сколько контекста забрать, сервер не навязывает:
- `list_open_sessions` — все Claude/Codex табы всех проектов: tabId, sessionId, cwd, project, createdAt + runtime-поля `status`, `busy`, `busySources`, `turnBusy`, `lastEventType/lastEventTs`. Для Claude дополнительно отдаёт `model`, `contextUsedPct/contextRemainingPct` и `contextSource` (`bridge` или persisted DB), если это видно из statusline bridge. Эти поля нужны регистратору: `isLive` означает только «PTY/таб жив», а не «ответ уже готов».
- `session_stats` — масштаб **без контента**: turnCount, char-counts по ролям, toolUseCount, largestUserTurn/largestThinkingTurn, compact-счётчики, заметки/rewind-маркеры/docs-edits
- `list_turns` — карта ходов: preview (220 char) + размеры каждого thinking/text-блока + имена tool_uses. Контент НЕ грузится
- `list_notes` — пользовательские якоря Timeline (заметки, rewind-маркеры, orphan-notes)
- `get_user_prompt` / `get_thinking` / `get_assistant_text` — точечный pull одного блока, byte-range через `start/end` (negative offsets как в Python)

**Редактирование Claude** — через те же IPC что Timeline-кнопка; Terminal MCP **никогда не пишет JSONL напрямую**:
- `fork_session` — клон под новым UUID
- `propose_edit` — dry-run: что именно удалится (backtrace + forward-expand), без записи на диск
- `apply_edit` — реальная правка через `claude:edit-range` (mode=compact) или `claude:delete-range` (mode=delete)

Для Codex эти же имена tools остаются видимыми как единый контракт, но mutation path обязан отказать явно. Молчаливый no-op хуже ошибки: агент решит, что переписал историю, и начнёт строить следующий шаг на несуществующем fork/edit.

## Granular-чтение: почему agent decides volume

19MB-сессия (262 turn'а) → читаемый overview за ~6K токенов. Сервер отдаёт **карту размеров** (`session_stats` → `list_turns`), агент видит где мясо и тянет точечно `get_thinking` только нужных ходов с byte-range для больших. Это не truncate-на-сервере: агент сам решает глубину. Эмпирически agent сначала зовёт thinking (плотнее текста — Claude в нём пересказывает задачу), text только если непонятно.

## Ожидание ответа: status первичен, текст вторичен

Terminal MCP `send_prompt` подтверждает только доставку текста в живую вкладку. `Status: sent` не означает, что Claude/Codex закончил отвечать. Для разовой ручной инспекции регистратор использует history-tools того же MCP: `list_open_sessions` пока нужная сессия появилась с `sessionId`, затем `busy:false` / terminal completion event.

Это ручной MCP-flow для разовой инспекции уже открытой сессии. Продуктовая оркестрация долгих и удалённых запросов не должна воспроизводить его серией вызовов `list_open_sessions`/`session_stats`: она создаёт persistent run через Project API, получает completion по SSE и забирает результат одним структурным запросом. Такой клиент может работать на другом компьютере без установленных MCP; см. [`fact-оркестрация-вкладок.md`](fact-оркестрация-вкладок.md).

`get_assistant_text` может уже показывать промежуточные text-блоки, пока `busy:true`: для длинного Claude-аудита это нормальное состояние, а не готовый финал. Если оркестратор объявил «Claude не ответил», а позже в JSONL появился финальный text-блок, это баг преждевременного ожидания/timeout в оркестраторе, не потеря ответа.

`read_output` допустим только как аварийный fallback, когда history backend вообще не видит sessionId. TUI-буфер содержит ANSI/обрезку/wrap и может отставать от JSONL, поэтому не является источником истины для ответа агента.

## Edit через существующие IPC + auto-fork safety

`apply_edit` не дублирует backtrace/orphan-cleanup/relink — оборачивает `_api.editRange`/`_api.deleteRange`, экспортированные из `ipc/claude-data.js` (те же функции что зовёт IPC-handler Timeline-кнопки). Это гарантирует идентичное поведение с UI и не удваивает поверхность багов (logic знает про compact-границы, parentUuid-цепочку, atomic temp-write).

**Auto-fork по умолчанию**: первая правка сессии (`autoFork: true`) сначала делает `fork_session`, оперирует на копии, возвращает новый sessionId — оригинал нетронут, откат = закрыть таб форка. `fs.copyFile` 19MB ≈ 50ms. Для chained-правок на том же форке — `autoFork: false` + sessionId форка.

`propose_edit` обязателен перед `apply_edit` (правило в промпте регистратора) — сначала план в чат, OK юзера, потом запись.

## Двухзаписный compact

Каждый `/compact` в JSONL — **пара соседних записей**: `compact_boundary` (turnIndex N, без контента, `preTokens`/`postTokens` в `compactMetadata`) и сразу следом `isCompactSummary`-user-запись (turnIndex N+1, 6-17K символов auto-сгенерированного summary). `list_turns` отдаёт их как `kind:'compact_boundary'` и `kind:'compact_summary'` — это **одна логическая операция**, не две. Точка сжатия = boundary, содержимое сжатого = summary. Агент, ссылающийся на «turn N+1» после boundary, не ошибается — это summary-запись, отдельный addressable entry.

## Что намеренно НЕ выставлено

`tool_use` args и `tool_result` контент в history API **отсутствуют сознательно** — это дампы файлов, диффы, stdout, которые забьют контекст регистратора. Для понимания «что агент делал» достаточно имён tool_uses из `list_turns` (`Bash`, `Read`, `Edit`, `mcp__electron__*`). `isCompactSummary` помечается отдельным kind, чтобы агент не спутал auto-summary с реальным user-промптом.

## Транспорт

Terminal MCP stdio → HTTP к main (`/overseer/*` остаются внутренними endpoint'ами) → парсеры из `ipc/claude-data.js`. Port discovery сначала использует `NOTED_MAIN_PID`, затем longest-prefix по cwd. Кэш распарсенных turns по `mtime+size` JSONL: первый `list_turns` на 19MB ~3-4с (CPU-bound parse), последующие миллисекунды пока сессия не дописана. См. [`fix-mcp-multi-instance.md`](fix-mcp-multi-instance.md) про PID-порт инфру.

## Code Map (неочевидные связи)
- `_api` объект в `ipc/claude-data.js` — `forkSessionFile`/`editRange`/`deleteRange` вынесены из IPC-handler'ов в named-функции, handler стал тонким шимом `(e,payload)=>_api.editRange(payload)`. main.js импортирует `_api` как `claudeDataApi`, history endpoints зовут его напрямую. Edit-логика живёт в одном месте, два входа (IPC от Timeline + внутренний HTTP).
- `_computeEditRangePlan` (main.js) — read-only зеркало forward-expand логики edit-range для `propose_edit`, считает removeUuids без записи.

## Main-owned bounded History

Claude и Codex History читаются одним main-owned сервисом. Ограничения `last`,
`before`, `after` и `around` применяются на этой границе, до передачи в HTTP/MCP;
доступность renderer и произвольный UI-timeout не участвуют в результате.
Persisted tab/session binding является первичным для остановленной фоновой
вкладки, поэтому открывать History ради чтения не требуется.

Для обычного Claude `last=N` rich-проекция удерживает только хвост N записей уже
во время прохода по transcript. Полный parentUuid/backtrace всё ещё строится там,
где он нужен для edit/fork, но bounded read не создаёт второй полный массив и не
маскирует тяжёлую работу пятитисекундным отказом.
