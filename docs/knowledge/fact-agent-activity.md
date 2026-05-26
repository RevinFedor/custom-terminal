# Feature: Agent Activity Tracking (loader-on intervals)

Records **how long an agent was actively working** in each tab — Claude PTY, Claude SDK, and Gemini — and aggregates it by day / project / tab for a graph in the Claude usage popover ("Activity" section). "Active" is defined as **the tab loader being on**, i.e. the exact same busy-state signal the UI consumes. No separate heuristic.

Backend capture: [`main.js`](../../src/main/main.js) `recordActivity`. Storage: `agent_activity_intervals` table in [`database.js`](../../src/main/database.js). Aggregation: [`ipc/claude-usage.js`](../../src/main/ipc/claude-usage.js) `computeActivityStats` + IPC `claude-usage:activity`. UI: `ActivityView` in [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx).

## Почему busy-state, а не отдельный детектор

Юзер сформулировал «активность» как «loader загрузки» — буквально та полоска/пульс что горит пока агент думает. Этот сигнал уже детерминированно вычислен в main (`claude:busy-state` / `gemini:busy-state` / forwarded `claude-sdk:busy-state`). Строить второй параллельный детектор = расхождение (CLAUDE.md anti-pattern «Не дублируй детекцию событий»). Поэтому `recordActivity()` врезан **рядом** с каждым существующим busy-state send, не вместо и не как новый источник.

## recordActivity — единственный идемпотентный edge-triggered чокпоинт

```js
recordActivity(tabId, busy, engine)  // busy:true → open, busy:false → close+write
```

Сигнал `busy=true`/`busy=false` отправляется из ~12 разбросанных мест (hook, spinner-эвристика, gemini-spinner, watchdog, interrupt-watcher, idle-probe, manual-stop, PTY-exit, kill, SDK-forwarder). Вместо обвязки всех двенадцати по-разному — **один** идемпотентный рекордер:

- `busy=true` при уже открытом интервале → **no-op**. `busy=false` без открытого → **no-op**.
- Это позволяет дропнуть **чисто аддитивные** вызовы `recordActivity()` рядом с каждым busy-state send, **не трогая сами send'ы** (loader священен). Перекрытие hook+spinner для одного Claude PTY-таба безвредно: первый `true` открывает, второй — no-op.

Открытые интервалы живут в памяти (`activityOpenIntervals: Map<tabId, {...}>`). **Пишется в SQLite только ЗАКРЫТЫЙ интервал** (start+end известны) — нет dangling NULL-end строк, краш mid-interval теряет максимум один in-flight span, но никогда не коррапит таблицу. Это та же дисциплина что snapshot-only-on-success в usage-чипе.

## Identity snapshot на OPEN-time, денормализован в строку

`resolveActivityIdentity(tabId, engine)` снимает `{projectId, projectPath, projectName, tabName, sessionId}` в момент **открытия** интервала — пока таб жив. Все поля копируются в строку (денормализация), чтобы запись пережила удаление таба/проекта позже. Резолв best-effort: PTY-табы через `terminalProjectIds` (live) → SQLite `tabs` fallback; SDK-табы через `sdkSessions` (cwd+sessionId, их нет в `terminalProjectIds`); имя проекта — прямой `SELECT name,path FROM projects WHERE id=?` (НЕ `getProjectById` — тот ещё гидрирует все табы + global commands, перебор на каждый turn-start).

`engine` может быть известен только на close-time (например forwarder) — рекордер берёт engine с open, fallback на close-time hint.

## Закрытие на teardown — обязательно для обоих движков

PTY-exit и terminal-kill cleanup вызывают **безусловный** `recordActivity(tabId, false)` (без engine — закроет что было открыто, claude или gemini). Watchdog, interrupt-watcher (JSONL marker), idle-probe и manual-stop тоже закрывают — иначе зависший/прерванный turn оставил бы интервал открытым навсегда (до следующего close или quit-flush). Shutdown: `flushOpenActivityIntervals()` в `before-quit` пишет все открытые интервалы, обрезанные на момент quit'а.

## Таблица

```sql
CREATE TABLE agent_activity_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT, project_id TEXT, project_path TEXT, project_name TEXT,
  tab_name TEXT, engine TEXT, session_id TEXT,
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, duration_ms INTEGER NOT NULL
)
-- index idx_activity_start on (start_ts DESC)
```

Timestamps — **ms epoch** (не секунды как у usage-snapshots — там исторически секунды). `saveActivityInterval` дропает span'ы с `duration<=0`. **Без prune** — как и usage-snapshots после правки май-2026, история не чистится.

## Аггрегация (computeActivityStats)

IPC `claude-usage:activity { days }` (default 14). Читает сырые интервалы `getActivityIntervals(from,to)`, считает три среза:

- **byDay** — интервал, пересекающий локальную полночь, **разбивается** на границах полночи (та же local-date конвенция что usage-график; см. `fact-claude-usage-chip.md::Baseline дня`). Каждый день несёт `byEngine` разбивку.
- **byProject** — суммарное время + число уникальных табов. Ключ: `project_id` → `project_path` → `'∅'`.
- **byTab** — топ табов по времени.

«Active time» = сумма длительностей интервалов. Два агента параллельно = 2× wall-clock — это честный ответ на «сколько работы агентов произошло», не «сколько шёл таймер».

## UI — Activity section в popover'е

Collapsible-секция рядом с «By day» (та же механика expand/refresh/ephemeral-reset что у This-tab и By-day). Total active + per-day stacked bars (сегменты по engine-цвету: Claude `#DA7756`, Claude SDK `#C9826A`, Gemini `#4E86F8`) + by-project список + легенда. `dayLabel` теперь date-aware (today/yest от реального календаря, не от индекса массива) — у активности есть дырки (день без агентов = нет строки), индекс врал бы.

## Связи

- [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) — authoritative busy-сигнал для Claude PTY.
- [`fact-process-bar.md`](fact-process-bar.md) — визуальное представление того же busy-сигнала на табе.
- [`fact-claude-usage-chip.md`](fact-claude-usage-chip.md) — popover-хост Activity-секции; snapshot-only-on-success дисциплина.
- `CLAUDE.md::Anti-Patterns::Не дублируй детекцию событий` — почему врезка рядом, а не новый детектор.
