# Dynamic Workflows в SDK-табе (отображение)

Claude Code 2.1.154 / SDK 0.3.156 (28 мая 2026) принёс **dynamic workflows** — модель планирует крупную задачу и оркестрирует её через десятки-сотни субагентов в фазах. Этот файл — про то, как мы это **отображаем** в SDK-табе. Сам workflow исполняет CLI-бинарь; SDK только эмитит телеметрию, мы её рендерим (как делает `/workflows` TUI оригинального Claude Code).

## workflow_progress[] — недокументированный, источник всего дерева

Главная ловушка: **`sdk.d.ts` НЕ объявляет форму данных workflow'а**, а живой бинарь шлёт намного больше, чем декларирует контракт. Реальный стрим (пойман логом `[Workflow]` на живом прогоне, не выведен из типов):

- **Один** `task_started` с `task_type: 'local_workflow'` + `workflow_name` (= `meta.name` скрипта). **НЕТ** отдельного `task_started` на каждого агента.
- Поток `task_progress`, где в **недокументированном поле `workflow_progress[]`** лежит всё дерево. Элементы двух типов:
  - `{type:'workflow_phase', index, title}` — фаза (`Fan-out`, `Synthesize`).
  - `{type:'workflow_agent', index, label, phaseIndex, phaseTitle, agentId, model, state, tokens, toolCalls, lastToolName, lastToolSummary, promptPreview, resultPreview, durationMs}` — агент.

**Каждое событие ПАРЦИАЛЬНО** — несёт только изменившиеся фазы/агенты. Мёржим **по `index`** в массивы `phases`/`agents` на единственном workflow-BgTask (см. `useWorkspaceStore.ts::WorkflowAgent` / handler в `ClaudeSDKTab.tsx`). `state` агента: `start → progress → done|error`.

**Что пробовали и почему не сработало (graveyard):** первая реализация строила линковку детей через `activeWorkflowRef` + `parentTaskId` (латчили workflow taskId, цепляли последующие `task_started` как детей). **Мёртвый код** — per-agent `task_started` не существует, агенты приходят только внутри `workflow_progress[]`. Симптом был `0 agents` через минуту работы при живом workflow. Вывод сделан по `.d.ts` (там `SDKTaskStartedMessage` без `phase`), а надо было поймать реальный стрим первым — классический *«не предполагай, ИССЛЕДУЙ»*.

**Storage на диске:** агенты workflow'а лежат в `~/.claude/projects/<dir>/<sessionId>/subagents/workflows/<workflowRunId>/agent-<id>.jsonl` + `.meta.json` (`{agentType:'workflow-subagent'}`) + `journal.jsonl` (orchestrator-internal resume-кэш: `started`/`result` + hash-ключи, не для рендера). Это **другой путь**, чем обычные Task-tool субагенты (`subagents/agent-<id>.jsonl`) — `getSubagentMessages(sessionId, agentId)` их так не найдёт. Но детали-панель агента строится из `workflow_progress`-телеметрии (label/model/tokens/toolCalls/promptPreview/resultPreview), JSONL-чтение не требуется.

## WorkflowPanel: чип → раскрытие по требованию

Workflow появляется **однострочным чипом** в `BackgroundTasksBar` (фиолетовый акцент `#a78bfa`, префикс `WORKFLOW`, счётчик агентов) — **не** авто-раскрывается и не отбирает композер. Раскрытие только по действию юзера: `↓` с конца текста в композере перебрасывает фокус на первый чип → `Enter`/клик раскрывает `WorkflowPanel`. Закрытие — `Escape` или `×`.

Это прямой фидбэк: *«обычно он появляется как уведомление просто внизу под инпутом… а сейчас почему-то сразу раскрывается и перекрывает инпут»*. Переносимый принцип — см. `methodology/переносимый-дизайн.md::Фоновый процесс = чип под инпутом, раскрытие по требованию`.

Панель (footer-зона, приоритет над TaskDetailPane через `expandedTaskIsWorkflow`): заголовок `Workflow <name> · N agents · elapsed` → левая колонка агентов **сгруппированных по фазам** (`phaseIndex` → титул фазы) → правая детали выбранного агента (Status / model / tokens / tool calls / Prompt с expand / Outcome из `resultPreview`) → нижняя hotkey-легенда.

**Hotkeys layout-independent (`e.code`, не `e.key`):** `KeyX` = стоп выбранного агента, `Escape` = закрыть. Работает на любой раскладке (RU/EN) — фидбэк *«чтобы работали даже если выбрана русская раскладка»*. См. `methodology/переносимый-дизайн.md::e.code для буквенных шорткатов`. **Навигации стрелками между агентами НЕТ** (убрана по запросу) — выбор кликом.

**Стоп одного агента, не всей сессии:** IPC `claude-sdk:stop-task` → `query.stopTask(agentId)` без `query.close()` — остальной workflow продолжает. Отдельно от `claude-sdk:stop` (тот рубит всю сессию).

**X работает только при живой сессии — и это завязано на soft/hard стоп.** `stop-task` первым делом ищет `sdkSessions.get(tabId)`; если сессии нет — возвращает `{success:false,'no active session'}` и молча ничего не делает (а UI-обработчик ловил только reject, не `success:false` — клик выглядел мёртвым). Симптом был: юзер жал Escape (раньше Escape **рубил всю сессию** hard'ом), потом открывал workflow, жал X — пусто. После перехода Escape на **soft-interrupt** (`fact-claude-sdk-tab.md::Soft interrupt vs hard kill`) сессия остаётся жить, фоновые workflow-агенты продолжают (нативное Esc-поведение — они in-process дети сессии, не отдельные процессы), и X наконец находит к чему обратиться. То есть «X не останавливает агента» был не багом панели, а следствием того, что предыдущий жест уже убил сессию. Сценарий целиком — `methodology/сценарии-использования.md::Стоп ответа и фоновые агенты в SDK-табе`.

## enableWorkflows / ultracode — через settings-слой, не Options

Чтобы workflow вообще запускался в SDK-табе, и чтобы включить ultracode — нужны флаги `enableWorkflows` / `ultracode`. **Ловушка:** оба — поля **Settings-схемы SDK**, а НЕ `query()` Options. Переданные top-level в options они **молча отбрасываются** (Options-деструктуризация их не видит). Канал — `extraArgs: { settings: JSON.stringify({...}) }` → CLI получает `--settings <json>`, который ложится в **flag-слой** (выше user/project/local, ниже managed) и **не затирает** `~/.claude` юзера. Подробнее про ultracode-транспорт — `fact-claude-sdk-tab.md::Effort: gating отменён, ultracode через settings`.

(`enableWorkflows` по факту no-op на Max/Team — workflows там on-by-default — но передаём явно.)
