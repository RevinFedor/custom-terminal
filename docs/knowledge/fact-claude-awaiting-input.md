# Факт: детерминированная детекция «Claude ждёт ответа на вопрос» (AskUserQuestion)

## Проблема
Нужен **детерминированный** сигнal состояния «Claude задал вопрос через `AskUserQuestion` и заблокирован, ждёт ответа человека» — чтобы подсветить таб и проект-таб фиолетовым (отдельно от обычного «AI думает» shimmer'а). Без таймаутов, без polling, без эвристик на PTY — той же архитектурой, что и loader (Stop hook).

## Почему это детерминированно — механика Claude Code

`AskUserQuestion` — **интерактивный permission-tool** (`requiresUserInteraction() === true`). В декомпиле (`packages/claude-code-src/services/tools/toolExecution.ts`) порядок выполнения ЛЮБОГО tool строго такой:

```
runPreToolUseHooks(tool)        ← строка ~800   PreToolUse hook FIRES
        ↓
resolveHookPermissionDecision   ← строка ~921
  → canUseTool(...)                              ЗДЕСЬ показывается диалог-вопрос и БЛОКИРУЕТ
        ↓ (человек ответил / отменил)
tool.call(...)                  ← строка ~1207
        ↓
executePostToolHooks(tool)                       PostToolUse hook FIRES (ответил)
  или executePostToolUseFailureHooks             PostToolUseFailure (отмена с фидбеком)
```

Для `AskUserQuestion` сам **вопрос = это и есть permission-фаза** (`hooks/toolPermission/handlers/interactiveHandler.ts` → `handleInteractivePermission` пушит диалог с вариантами и ждёт `onAllow`/`onReject`/`onAbort`). Значит окно ожидания человека **жёстко забракечено**:

```
PreToolUse(AskUserQuestion)  ──►  [человек думает, минуты]  ──►  PostToolUse(AskUserQuestion)
   = «вопрос появился»                                            = «ответил»
```

### Эмпирическое подтверждение (JSONL)
- **pending** вопрос в транскрипте = `{type:"assistant", message.stop_reason:"tool_use", content:[{type:"tool_use", name:"AskUserQuestion"}]}` — и **после него НЕТ записи `tool_result`** (Claude висит в permission-фазе).
- **отвеченный** → следом `{type:"user", message.content:[{type:"tool_result", content:"Your questions have been answered: ..."}]}`.

### bypassPermissions НЕ авто-отвечает на вопросы
`~/.claude/settings.json::permissions.defaultMode === "bypassPermissions"` **не** схлопывает AskUserQuestion — `requiresUserInteraction` tools всегда показывают диалог и блокируют (иначе вопрос не имел бы смысла). Подтверждено: pending-вопросы реально висят в JSONL без tool_result при bypassPermissions. Поэтому PreToolUse — не «ложный флэш», а настоящее начало ожидания.

## Реализация (та же socket-архитектура, что Stop hook)

### 1. `~/.claude/settings.json`
Добавлены 3 hook-группы со scoped matcher (как Stop/UserPromptSubmit/StopFailure, но с `matcher`):
```json
"PreToolUse":         [{ "matcher": "AskUserQuestion", "hooks": [{ "type":"command", "command":"node ~/.claude/hooks/noted-turn-event.js" }] }],
"PostToolUse":        [{ "matcher": "AskUserQuestion", "hooks": [{ ... }] }],
"PostToolUseFailure": [{ "matcher": "AskUserQuestion", "hooks": [{ ... }] }]
```
**Оверхед на другие tools = ноль:** `getMatchingHooks` сравнивает имя tool со строкой-matcher'ом (exact match, микросекунды) ДО спавна скрипта. Для Read/Bash/Edit matcher не совпадает → node-скрипт **не спавнится**. Спавн только на `AskUserQuestion`.

### 2. `~/.claude/hooks/noted-turn-event.js`
В envelope добавлено `tool_name: payload.tool_name || null` — main подтверждает scope (null на UserPromptSubmit/Stop/StopFailure).

### 3. `src/main/main.js` (socket-handler)
- Map `claudeAwaitingInput: Map<tabId, boolean>`.
- В обработчике envelope, ПОСЛЕ резолва `tabId` и `claudeHookLastEvent.set`, ДО `busy = event === 'UserPromptSubmit'`:
  ```js
  if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (msg.tool_name === 'AskUserQuestion') {
      const awaiting = event === 'PreToolUse';
      // ... set map, emit на edge ...
      mainWindow.webContents.send('claude:awaiting-input', { tabId, awaiting });
    }
    continue;  // ← КРИТИЧНО: Pre/Post — mid-turn, не должны падать в busy-state логику
  }
  ```
  `continue` обязателен: без него `busy = event === 'UserPromptSubmit'` даст `false` для PostToolUse → ложный `busy:false` погасит loader посреди turn'а.
- На turn-end edge (`Stop`/`StopFailure`, `busy===false`) — если awaiting ещё взведён, сбросить + emit (main-side bookkeeping).

### 4. Renderer — IPC `claude:awaiting-input { tabId, awaiting }`
- **`TabBar.tsx`**: `awaitingMap` (как `claudeBusyMap`), проп `isAwaitingInput` в `TabItem`, оверлей `.tab-awaiting-input` (zIndex:1, поверх busy-shimmer'а zIndex:0, под текстом z:5–6). Рендерится в `isVerticalMode`-ветке — там же где busy-shimmer.
- **`App.tsx`**: `awaitingTabs` Map, per-project `hasAwaitingTab`, проп `isProjectAwaiting` в `ProjectTabItem` → оверлей `.tab-awaiting-input` на всю кнопку проект-таба (zIndex:5, под z-10 текстом).

### 5. CSS `.tab-awaiting-input` (globals.css) — бегущая рамка, НЕ заливка
Финальная форма — тонкая (1.2px) рамка с ярким сегментом, бегущим по периметру таба, поверх еле заметного постоянного кольца. Не заливка фона.
```css
@property --awaiting-angle { syntax:'<angle>'; initial-value:0deg; inherits:false; }
@keyframes tab-awaiting-spin { to { --awaiting-angle: 360deg; } }
.tab-awaiting-input {
  padding: 1.2px;                                  /* толщина рамки */
  background:
    conic-gradient(from var(--awaiting-angle),     /* яркий сегмент с хвостом */
      rgba(168,85,247,0) 240deg, rgba(168,85,247,.85) 312deg,
      rgba(216,180,254,1) 348deg, rgba(168,85,247,0) 360deg),
    rgba(147,51,234,.22);                          /* постоянное кольцо */
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;                         /* вырез центра → только кольцо */
  animation: tab-awaiting-spin 1.6s linear infinite;
}
```
- `@property --awaiting-angle` обязателен для **плавной** интерполяции угла — без него `conic-gradient` в keyframe прыгает рывками (Electron 28 = Chromium 120, поддержка есть).
- `padding:1.2px` + `mask-composite:exclude` (content-box XOR border-box) оставляет только кольцо толщиной padding по `border-radius` элемента (`box-sizing:border-box` от Tailwind preflight). `border-radius` наследуется от inline-стиля оверлея (`tabGeo.borderRadius` в TabBar, `rounded-sm` в App project-tab).
- Сигнал несёт **движущийся сегмент** (высокая дельта пикселей по периметру → codec/AI-detectable, CLAUDE.md::AI-Optimized UI), фон НЕ анимируется.

**Что пробовали и отвергли:** первая версия = пульсация `background-color` всего таба (`tab-awaiting-pulse`, peak 0.42). Юзер отверг — *«мигает весь бэкграунд, а я хочу только рамку в 1.2px чтобы она вокруг ходила»*: заливка слепила и конкурировала с текстом таба за внимание (тот же класс что `methodology/переносимый-дизайн.md::Лоадер = локализованный элемент`). Переносимый принцип — `methodology/переносимый-дизайн.md::«Нужен твой ответ» ≠ «AI занят»`.

**Подавление busy-shimmer во время awaiting.** Пока висит вопрос, таб всё ещё `busy` (turn не закончен), поэтому под рамкой иначе пульсировал бы штатный thinking-shimmer фона. Чтобы осталась «только рамка», busy-фон гасится: `{verticalIsAiBusy && !verticalIsAwaiting && (...)}` в TabBar. Process-bar liveness (PTY-жив) остаётся. Логика: вопрос = Claude НЕ думает, а ждёт юзера, поэтому «думающий» фон неуместен.

## Инвариант awaiting ⊆ busy — почему не трогаем 12 busy:false-сайтов

Вопрос существует только посреди turn'а, значит **awaiting — подмножество busy**. Поэтому вместо правки всех мест где эмитится `busy:false` (interrupt/watchdog/manual-stop/Stop/StopFailure/exit — их 12), **renderer-consumer сам гасит awaiting на любом `claude:busy-state busy:false` edge**:
- `TabBar.tsx`: второй listener `handleClaudeBusyClearAwaiting` на тот же `claude:busy-state`.
- `App.tsx`: в `handleClaudeBusyState`, при `!data.busy` — `setAwaitingTabs(delete)`.

Так покрыт кейс «юзер нажал Esc чтобы отменить весь turn вместо ответа на вопрос» — PostToolUse может не прийти (turn оборвался через `aborted_streaming`), но `busy:false` придёт всегда (через JSONL-interrupt-watcher / idle-probe / watchdog) и погасит awaiting. Двойное покрытие, нет дыр.

## Известные ограничения
1. **Хуки читаются Claude при старте сессии.** На уже запущенных табах фича подхватится только после рестарта Claude-процесса; новые табы получают сразу. Идентично тому как подхватывался Stop hook (поведение самого Claude CLI).
2. **Horizontal layout табов** не показывает awaiting-glow (как и busy-shimmer — он vertical-only by design, `getBgColor` не реагирует на busy). Vertical sidebar — основной режим.
3. PreToolUse фактически fires за микросекунды ДО появления диалога (между `runPreToolUseHooks` и `canUseTool`). Незаметно — диалог появляется сразу следом.

## Мобильное расширение: показ + ответ на вопрос с телефона

Десктоп показывает вопрос в Ink TUI (xterm); мобилка TUI не имеет, поэтому ей нужен **контент** вопроса и путь **ответа**.

**Контент (PreToolUse → broadcast).** Хук `noted-turn-event.js` теперь форвардит `tool_input` в envelope (раньше только `tool_name`). В socket-handler'е на `PreToolUse(AskUserQuestion)`: `claudePendingQuestion.set(tabId, {questions, at})` + `_webBroadcast(tabId, {type:'ask-question', source:'pty', toolUseID:'pty', questions})`. На `Post/PostToolUseFailure` (и на turn-end safety-net по busy:false) — `delete` + `_webBroadcast({type:'question-cancelled', source:'pty'})`. SDK-путь шлёт тот же `ask-question`/`question-cancelled` но `source:'sdk'` + реальный `toolUseID`.

**Ответ — два разных механизма по `source`** (`answerClaudeQuestionUnified` в main, дёргается web-server'ом `POST /api/sdk-tabs/:id/answer-question`):
- `source:'sdk'` → резолв припаркованного `canUseTool` Promise (как десктопный `SDKAskQuestion` через `claude-sdk:answer-question`).
- `source:'pty'` → **драйвим Ink TUI клавишами** (`answerClaudeQuestionPTY`). IPC-пути ответа у PTY НЕТ — на десктопе юзер отвечает стрелками+Enter в xterm. Транслируем `{answers}` в keystroke-последовательность:
  - single-select: `↓`×(index выбранной опции) → `Enter` (`\r`) — picks + auto-advance.
  - multiSelect: `Space` на каждой выбранной опции (walk сверху вниз `↓` между), потом `→` на следующий вопрос/submit.
  - `hideSubmitTab = questions.length===1 && !multiSelect` → одиночный plain-вопрос авто-сабмитит на Enter, submit-view нет. Для multi/multiSelect — финальный `Enter` подтверждает Submit-view.
  - Stop («Respond manually») → `Esc` (`\x1b`) = `onCancel` в QuestionView → Claude перестаёт спрашивать, возврат к prompt для свободного ввода.
  - Inter-keystroke gap ~70-110ms — Ink батчит stdin по фрейму. Источник навигации: декомпил `QuestionView.tsx`/`AskUserQuestionPermissionRequest.tsx`.

**`getClaudePendingQuestion(tabId)`** (main) — читает PTY-store ИЛИ SDK-припаркованный (где теперь хранится `questions`), web-server отдаёт через `GET /pending-question` чтобы phone, подключившийся **mid-question**, всё равно показал карточку (live `ask-question` он пропустил).

**Индикатор = вращающаяся рамка (1:1 с десктопа), на карточках вкладки И проекта, НЕ в чате.** Прошло три итерации формы: (1) пульсирующая фиолетовая рамка вокруг всего экрана чата — юзер: *«рамка уходит вверх на историю, а не на блок вопросов; мигающую можно не отображать, и так карточка видна; рамку стоит только на самой вкладке в списке»*; (2) пульсирующая точка на строке таба; (3) финал — юзер потребовал ровно десктопный артефакт: *«как у меня на десктопном приложении там не точка, там именно рамка которая крутится по кругу. Просто скопируй как это у десктопного приложения. Причём как на проект, так и на вкладку»*. Итог: класс `.mob-awaiting-ring` — **дословная копия** десктопного `globals.css::.tab-awaiting-input` (`conic-gradient` с бегущим сегментом + `@property --mob-awaiting-angle` для плавной интерполяции угла + mask content-box XOR border-box → кольцо 1.2px, 1.6s linear). Применён на: строку вкладки (`TabRow`) и карточку проекта (`ProjectCard`, оба варианта). **Из самого чата всё убрано** — ни рамки вокруг, ни статической линии над блоком вопроса: внутри открытого чата `QuestionCard` сам по себе сигнал, индикатор нужен только когда юзер смотрит на **список** (правило — `methodology/переносимый-дизайн-mobile.md::Индикатор-паритет`).

Источник флага `awaiting`: `claude:get-presence` (main) возвращает его из `claudeAwaitingInput`. Протянут **тремя** путями, потому что у списков вкладок/проектов разные источники:
- вкладка в persisted-проекте → `getClaudeTabStatusBatch` (это batch-путь `/tabs`, НЕ `getProjectTabsLive` — частая ловушка: легко добавить `awaiting` только в live-fallback и не увидеть на DB-проектах) → `TabInfo.awaiting`;
- вкладка в draft-проекте → `getProjectTabsLive` (live-fallback);
- карточка проекта → `getOpenProjectIds::awaitingIds` (renderer сканирует claude-табы открытых проектов) → `ProjectInfo.hasAwaiting`.

E2E проверено браузером на dev-инстансе: PTY-вопрос (Red/Green/Blue) → `QuestionCard` на phone → тап Green → `[ClaudeQuestion] PTY answered` → JSONL `tool_result "...="Green"`; рамка крутится на карточке `claude` в списке, на соседней без вопроса — нет.

См. [`fact-mobile-web.md`](fact-mobile-web.md) (wire-протокол `ask-question`/`question-cancelled`, self-healing reconcile) и [`fact-claude-sdk-tab.md`](fact-claude-sdk-tab.md) (SDK `canUseTool` сторона).

## Связанные
- [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) — базовая socket-архитектура (per-PID sock, ack, session_id→tabId), которую эта фича переиспользует целиком.
- [`fix-claude-aborted-streaming-loader.md`](fix-claude-aborted-streaming-loader.md) — почему `busy:false` гарантированно приходит даже на Esc (JSONL-interrupt-watcher), что и кормит safety-net сброс awaiting.
- `methodology/переносимый-дизайн.md::Authoritative artifact > эвристика` — тот же принцип: хук (authoritative) вместо PTY-эвристики.
