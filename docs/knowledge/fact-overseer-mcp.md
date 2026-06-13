# Feature: Overseer MCP (cross-session inspection & editing)

## Intro
Overseer — глобальный MCP-сервер (`~/.claude/mcp/overseer-server.mjs`), через который **любая вкладка читает и редактирует историю любой другой сессии** в приложении. Подключается из любого SDK-таба или Claude/Codex CLI. Не оркестратор, раздающий задачи — peer-доступ к JSONL-транскриптам всех открытых сессий поверх того же парсинга, что использует Timeline.

Системный промпт-роль регистратора (что делать, как обходить большие ходы) — `docs/meta/оркестратор.prompt.md`, копируется в первое сообщение SDK-таба руками.

## Почему peer-доступ, а не orchestrator-делегация

Старая модель (Gemini→Claude delegation, удалена 2026-06) раздавала задачи суб-агентам и собирала ответы через очередь. 1M-контекст убил этот use-case: один агент справляется сам. Реальная оставшаяся потребность — **discovery**: 4 параллельных JSONL в 4 процессах, и агент в табе A не знает что делает агент в табе Б. Это indexing-проблема, не contextual: нельзя слить 4 транскрипта в один turn (теряется temporal thread), нужен адресуемый доступ. Поэтому overseer — read/edit поверх чужих сессий, без понятия «подчинённый агент».

## Граница с terminal MCP

Два MCP, один main-process HTTP backend, разный blast radius:
- **terminal MCP** = *оператор*: что сейчас крутится, перезапустить/убить процесс. Project-scoped.
- **overseer MCP** = *историк/редактор*: что сессия сделала, прочитать/переписать транскрипт. Cross-project.

Не объединять: read-introspection целиком принадлежит overseer, act-on-process — terminal, зон размытия нет. terminal MCP имеет независимого потребителя (skill `electron-e2e-testing` гоняет dev-сервер). Подробнее границу см. [`fact-terminal-mcp.md`](fact-terminal-mcp.md).

## 10 тулов: чтение (granular) + редактирование

**Чтение** — agent сам решает сколько контекста забрать, сервер не навязывает:
- `list_open_sessions` — все Claude/Codex табы всех проектов: tabId, sessionId, isLive, cwd, project, createdAt
- `session_stats` — масштаб **без контента**: turnCount, char-counts по ролям, toolUseCount, largestUserTurn/largestThinkingTurn, compact-счётчики, заметки/rewind-маркеры/docs-edits
- `list_turns` — карта ходов: preview (220 char) + размеры каждого thinking/text-блока + имена tool_uses. Контент НЕ грузится
- `list_notes` — пользовательские якоря Timeline (заметки, rewind-маркеры, orphan-notes)
- `get_user_prompt` / `get_thinking` / `get_assistant_text` — точечный pull одного блока, byte-range через `start/end` (negative offsets как в Python)

**Редактирование** — через те же IPC что Timeline-кнопка, overseer **никогда не пишет JSONL напрямую**:
- `fork_session` — клон под новым UUID
- `propose_edit` — dry-run: что именно удалится (backtrace + forward-expand), без записи на диск
- `apply_edit` — реальная правка через `claude:edit-range` (mode=compact) или `claude:delete-range` (mode=delete)

## Granular-чтение: почему agent decides volume

19MB-сессия (262 turn'а) → читаемый overview за ~6K токенов. Сервер отдаёт **карту размеров** (`session_stats` → `list_turns`), агент видит где мясо и тянет точечно `get_thinking` только нужных ходов с byte-range для больших. Это не truncate-на-сервере: агент сам решает глубину. Эмпирически agent сначала зовёт thinking (плотнее текста — Claude в нём пересказывает задачу), text только если непонятно.

## Edit через существующие IPC + auto-fork safety

`apply_edit` не дублирует backtrace/orphan-cleanup/relink — оборачивает `_api.editRange`/`_api.deleteRange`, экспортированные из `ipc/claude-data.js` (те же функции что зовёт IPC-handler Timeline-кнопки). Это гарантирует идентичное поведение с UI и не удваивает поверхность багов (logic знает про compact-границы, parentUuid-цепочку, atomic temp-write).

**Auto-fork по умолчанию**: первая правка сессии (`autoFork: true`) сначала делает `fork_session`, оперирует на копии, возвращает новый sessionId — оригинал нетронут, откат = закрыть таб форка. `fs.copyFile` 19MB ≈ 50ms. Для chained-правок на том же форке — `autoFork: false` + sessionId форка.

`propose_edit` обязателен перед `apply_edit` (правило в промпте регистратора) — сначала план в чат, OK юзера, потом запись.

## Двухзаписный compact

Каждый `/compact` в JSONL — **пара соседних записей**: `compact_boundary` (turnIndex N, без контента, `preTokens`/`postTokens` в `compactMetadata`) и сразу следом `isCompactSummary`-user-запись (turnIndex N+1, 6-17K символов auto-сгенерированного summary). `list_turns` отдаёт их как `kind:'compact_boundary'` и `kind:'compact_summary'` — это **одна логическая операция**, не две. Точка сжатия = boundary, содержимое сжатого = summary. Агент, ссылающийся на «turn N+1» после boundary, не ошибается — это summary-запись, отдельный addressable entry.

## Что намеренно НЕ выставлено

`tool_use` args и `tool_result` контент в overseer-API **отсутствуют сознательно** — это дампы файлов, диффы, stdout, которые забьют контекст регистратора. Для понимания «что агент делал» достаточно имён tool_uses из `list_turns` (`Bash`, `Read`, `Edit`, `mcp__electron__*`). `isCompactSummary` помечается отдельным kind, чтобы агент не спутал auto-summary с реальным user-промптом.

## Транспорт

stdio MCP → HTTP к main (`/overseer/*` endpoints в `mcpHttpServer`) → парсеры из `ipc/claude-data.js`. Port discovery через `~/.noted-terminal/mcp-port-<PID>` (JSON-формат с `openProjectPaths`, routing по cwd — longest-prefix match). Кэш распарсенных turns по `mtime+size` JSONL: первый `list_turns` на 19MB ~3-4с (CPU-bound parse), последующие миллисекунды пока сессия не дописана. См. [`fix-mcp-multi-instance.md`](fix-mcp-multi-instance.md) про PID-порт инфру.

## Code Map (неочевидные связи)
- `_api` объект в `ipc/claude-data.js` — `forkSessionFile`/`editRange`/`deleteRange` вынесены из IPC-handler'ов в named-функции, handler стал тонким шимом `(e,payload)=>_api.editRange(payload)`. main.js импортирует `_api` как `claudeDataApi`, overseer endpoints зовут его напрямую. Edit-логика живёт в одном месте, два входа (IPC от Timeline + HTTP от overseer).
- `_computeEditRangePlan` (main.js) — read-only зеркало forward-expand логики edit-range для `propose_edit`, считает removeUuids без записи.
