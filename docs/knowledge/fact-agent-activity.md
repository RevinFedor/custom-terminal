# Feature: Agent Activity Tracking (loader-on intervals)

Records **how long an agent was actively working** in each tab — Claude PTY, Claude SDK, Gemini, and Codex — and aggregates it by day / project / tab for a graph in the usage popovers ("Activity" section). "Active" is defined as **the tab loader being on**, i.e. the exact same busy-state signal the UI consumes. No separate heuristic.

Backend capture: [`main.js`](../../src/main/main.js) `recordActivity`. Storage: `agent_activity_intervals` table in [`database.js`](../../src/main/database.js). Aggregation: [`ipc/claude-usage.js`](../../src/main/ipc/claude-usage.js) `computeActivityStats` + IPC `claude-usage:activity`. UI: `ActivityView` in [`ClaudeUsageButton.tsx`](../../src/renderer/components/Workspace/ClaudeUsageButton.tsx).

## Почему busy-state, а не отдельный детектор

Юзер сформулировал «активность» как «loader загрузки» — буквально та полоска/пульс что горит пока агент думает. Этот сигнал уже детерминированно вычислен в main (`claude:busy-state` / `gemini:busy-state` / forwarded `claude-sdk:busy-state`; для Codex — `codex:run-command` open и OSC `command-finished`/kill close). Строить второй параллельный детектор = расхождение (CLAUDE.md anti-pattern «Не дублируй детекцию событий»). Поэтому `recordActivity()` врезан **рядом** с каждым существующим busy/lifecycle send, не вместо и не как новый источник.

## recordActivity — единственный идемпотентный edge-triggered чокпоинт

```js
recordActivity(tabId, busy, engine)  // busy:true → open, busy:false → close+write
```

Сигнал `busy=true`/`busy=false` отправляется из ~12 разбросанных мест (hook, spinner-эвристика, gemini-spinner, watchdog, interrupt-watcher, idle-probe, manual-stop, PTY-exit, kill, SDK-forwarder). Вместо обвязки всех двенадцати по-разному — **один** идемпотентный рекордер:

- `busy=true` при уже открытом интервале → **no-op**. `busy=false` без открытого → **no-op**.
- Это позволяет дропнуть **чисто аддитивные** вызовы `recordActivity()` рядом с каждым busy-state send, **не трогая сами send'ы** (loader священен). Перекрытие hook+spinner для одного Claude PTY-таба безвредно: первый `true` открывает, второй — no-op.

Открытые интервалы живут в памяти (`activityOpenIntervals: Map<tabId, {...}>`). **Пишется в SQLite только ЗАКРЫТЫЙ интервал** (start+end известны) — нет dangling NULL-end строк, краш mid-interval теряет максимум один in-flight span, но никогда не коррапит таблицу. Это та же дисциплина что snapshot-only-on-success в usage-чипе.

## Identity snapshot на OPEN-time, денормализован в строку

`resolveActivityIdentity(tabId, engine)` снимает `{projectId, projectPath, projectName, tabName, sessionId}` в момент **открытия** интервала — пока таб жив. Все поля копируются в строку (денормализация), чтобы запись пережила удаление таба/проекта позже. Резолв best-effort: PTY-табы через `terminalProjectIds` (live) → SQLite `tabs` fallback; SDK-табы через `sdkSessions` (cwd+sessionId, их нет в `terminalProjectIds`). Session id выбирается строго по engine: Codex-интервал не имеет права взять сохранённый Claude id той же вкладки и наоборот. Имя проекта — прямой `SELECT name,path FROM projects WHERE id=?` (НЕ `getProjectById` — тот ещё гидрирует все табы + global commands, перебор на каждый turn-start).

`engine` может быть известен только на close-time (например forwarder) — рекордер берёт engine с open, fallback на close-time hint.

## Закрытие на teardown — обязательно для обоих движков

PTY-exit и terminal-kill cleanup вызывают **безусловный** `recordActivity(tabId, false)` (без engine — закроет что было открыто, claude/gemini/codex). Watchdog, interrupt-watcher (JSONL marker), idle-probe, manual-stop и Codex command-finished тоже закрывают — иначе зависший/прерванный turn оставил бы интервал открытым навсегда (до следующего close или quit-flush). Shutdown: `flushOpenActivityIntervals()` в `before-quit` пишет все открытые интервалы, обрезанные на момент quit'а.

## Время конкретного ответа — sidecar поверх activity

Activity отвечает на вопрос «сколько работал агент» и поэтому честно сохраняет interrupted turn, local command и teardown. Время под assistant-ответом — более узкая сущность: оно создаётся только для Claude/Codex и только когда lifecycle доказал естественно завершённый ответ. Для Claude это штатный Stop исходного model-turn, для Codex — `task_complete` с непустым final result. `/compact`, watchdog, принудительная остановка и quit закрывают activity, но не имеют права подписывать предыдущий ответ новой длительностью.

Начало response-интервала вооружается уже на preflight программной отправки, поэтому видимый таймер охватывает раннюю фазу paste/starting до первого авторитетного busy-edge. Пришедший затем `recordActivity(true)` принимает тот же start вместо открытия второго интервала. Это сохраняет пользовательскую модель «таймер идёт ровно столько, сколько непрерывно виден loader», но не превращает renderer mount или локальный секундомер в источник истины.

Завершённая длительность хранится отдельно от JSONL: `history_response_timings` связывает activity interval с вкладкой и, после доказательства, с точной assistant-записью; aliases сохраняют несколько доказанных проекций одной записи. Сначала строка может оставаться tab-owned pending. Transcript reader привязывает её только к новой содержательной assistant-записи с timestamp не раньше start и не позже короткого post-close допуска; запись до начала интервала никогда не кандидат. Если подходящего ответа ещё нет или два кандидата неразличимы, привязка остаётся незавершённой, а не выбирает «последний ответ».

Codex Resume/Rewind требует отдельной дисциплины identity: session id из CLI-аргумента может оказаться source, тогда как реальный writer продолжил source-rollout или создал linked child. Pending timing переносится только после exact child proof; уже привязанный source timing проецируется в child через подтверждённое соответствие содержимого/времени и fail-closed при дублях. History revision учитывает и session, и tab-owned sidecar, поэтому поздняя привязка обновляет UI даже без новой JSONL-строки.

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
- **byProject** — wall-clock union времени + число уникальных табов. Ключ: `project_id` → `project_path` → `'∅'`.
- **byTab** — топ табов по времени.

«Active time» в UI = **wall-clock union**, а не сумма работы всех агентов. Если Claude и Codex работали параллельно с 12:00 до 13:00, total = 1h, не 2h. Пользовательский вопрос был именно «сколько часов суммарно потрачено» в смысле прошедшего времени, а не CPU-agent-hours; сумма интервалов завышала бы дни с параллельными сессиями. Для stacked bars overlap делится между активными engines поровну внутри пересекающегося slice, чтобы цветные сегменты всё равно складывались в 100% union-бара и не врали total.

## UI — Activity section в popover'е

Collapsible-секция рядом с «By day» (та же механика expand/refresh/ephemeral-reset что у This-tab и By-day). Body имеет собственный scroll (`maxHeight` + `overflowY:auto`), иначе by-day + by-project + legend раздувают usage popover и нижние строки становятся недоступны. Total wall time + per-day stacked bars (сегменты по engine-цвету: Claude `#DA7756`, Claude SDK `#C9826A`, Gemini `#4E86F8`, Codex `#22c55e`) + by-project список + легенда. `dayLabel` теперь date-aware (today/yest от реального календаря, не от индекса массива) — у активности есть дырки (день без агентов = нет строки), индекс врал бы.

## Связи

- [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) — authoritative busy-сигнал для Claude PTY.
- [`fact-process-bar.md`](fact-process-bar.md) — визуальное представление того же busy-сигнала на табе.
- [`fact-claude-usage-chip.md`](fact-claude-usage-chip.md) — popover-хост Activity-секции; snapshot-only-on-success дисциплина.
- `CLAUDE.md::Anti-Patterns::Не дублируй детекцию событий` — почему врезка рядом, а не новый детектор.
