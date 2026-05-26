# Факт: Prompt Queue overlay + External Editor hijack

## Зачем
Юзер пишет промпт, Claude отвечает, юзер хочет следующий промпт отправить **автоматически после окончания ответа**. Очередь промптов справа-вверху Claude таба + auto-runner на Stop hook. Без поллинга, без таймаутов — на каждый Stop pop'аем head.

Вторая сторона — **захват текущего ввода Claude** для перекладки в очередь / clipboard / просто очистки. Без danger zone (Ctrl+C single press = clear input, но Claude TUI это handle'ит как "Press Ctrl+C again to exit" → можно случайно убить сессию).

## Архитектура — три блока

### 1. Store (`usePromptQueueStore.ts`)
Per-tab очередь: `Map<tabId, { items: QueuedPrompt[], autoRun: boolean, stopAfter: boolean, previewId: string | null }>`.
- `autoRun` — на каждый `claude:busy-state` busy:true→false pop'аем head и шлём `claude:send-command`. После последнего prompt'а **auto-disarm** (`setAutoRun(false)` если очередь стала пустой).
- `stopAfter` — после следующего turn-end если очередь пуста, вызывает `terminal:stop-ai-process` (SIGTERM по PID). One-shot: disarm после первого срабатывания. Независим от `autoRun` — можно использовать "пиши промпт сам → ответ → авто-стоп".

**SQLite persistence через `app:setState`.** `items` / `autoRun` / `stopAfter` per-tab сохраняются в `app_state` под ключом `promptQueueByTab` (JSON-encoded `Record<tabId, {items, autoRun, stopAfter}>`). Throttle 250мс на каждый mutator — drag-reorder и быстрый ввод не должны писать SQLite 60 раз/сек, но последнее значение перед unmount-ом гарантированно flush'нется. `previewId` (UI-only state) **не** персистится. Cold tabs (пустой queue + autoRun=false + stopAfter=false) при serialize'е дропаются — kv-таблица не пухнет от мёртвых табов. Hydrate один раз через `hydratePromptQueueStore()` в `App.tsx::useEffect([])` — fire-and-forget, runner ниже терпит появление items после mount'а через subscribe-механизм (см. cold-start).

**Auto-arm Run after на первый chip.** Когда `items.length === 0 && autoRun === false` и юзер дергает `+ grab` или `+ add` — `autoArmIfFirst()` ставит `setAutoRun(true)` ДО `addPrompt`. Логика: пустая очередь + добавление = намерение «хочу автозапуск», иначе зачем класть в очередь вместо обычной отправки. Subsequent adds в уже-armed очередь не re-arm (state уже true). Если юзер потом вручную выключил Run after — следующее добавление не reactivate'ит (`items.length > 0` после disarm). Триггер строго на edge `0 → first`.

### 2. Overlay UI (`PromptQueueOverlay.tsx`)
Sticky 240px справа-вверху Claude таба. Гейтится тремя условиями:
- `commandType === 'claude'` (не bash/gemini)
- `tab.claudeSessionId` существует (есть зарегистрированная сессия)
- `claudeProcessAlive` — local state от `terminal:command-started/finished` (OSC 133), pure-React: подписка в Terminal.tsx, гейт через prop. **Когда Claude процесс умирает (Stop кнопка) — оверлей мгновенно пропадает**, иначе остался бы по `claudeSessionId` (он persistит после exit для /resume).

### 3. External Editor hijack
Claude Code TUI имеет хоткей `Ctrl+G` → `chat:externalEditor` → `execSync($EDITOR <tempfile>)`. Мы перехватываем это:
- В `pty.spawn` инжектим `EDITOR=~/.claude/hooks/noted-code-grab.js`
- Helper script читает tempfile, шлёт текст в наш Unix socket, опционально truncate'ит файл → инпут Claude очищается

## Lock-file dispatcher — 4 mode помощника

`~/.claude/hooks/noted-code-grab.js` диспетчер по lock-file `/tmp/noted-grab-<claudePID>.json`. Main process пишет lock **перед** отправкой Ctrl+G в PTY:

| mode | Что делает | Lifecycle tempfile |
|---|---|---|
| `grab` | Читает → шлёт в socket → **truncate** | пусто (input Claude очищается) |
| `copy` | Читает → шлёт в socket → **не трогает** | как было (input сохраняется) |
| `clear` | Truncate, **не шлёт в socket** | пусто |
| `<no lock>` | passthrough на `$NOTED_ORIGINAL_EDITOR` (user's Sublime/vim) | редактор юзера управляет |

**Lock потребляется на чтении** (`unlinkSync`) — стейл не может выстрелить случайно на следующий Ctrl+G.

**Поле `sock` в lock-payload — authoritative routing к owner-main'у.** Lock-файл пишет тот main, который отправил Ctrl+G в PTY и держит `grabInputPending[tabId]` Promise. Helper-script обязан вернуть `GrabInput` envelope именно этому main'у, иначе oригинальный main timeout'ит на 3000ms. Раньше helper резолвил sock через cwd-discovery — это ломалось когда dev+prod open'или один cwd (longest-prefix tie, выбирался arbitrarily). Теперь main кладёт в lock `{mode, ts, sock: CLAUDE_HOOK_SOCK}`, helper читает `sock` и connect'ится ровно туда без discovery. cwd-routing остаётся fallback ТОЛЬКО для passthrough-mode (когда lock'а нет — manual Ctrl+G юзера, ожидающего свой Sublime). См. `fix-claude-hook-silent-dropouts.md::Слой 4`.

**Truncate FIRST в `grab` mode:** перед socket-write. Если socket упадёт — инпут Claude всё равно очистится. Recoverable. В `copy` mode — наоборот, **не** truncate, user должен видеть свой текст обратно.

## Имя скрипта — `code` в basename важно

Claude classifies `$EDITOR` по basename:
- содержит `code|cursor|windsurf|codium|subl|atom|gedit|notepad++|notepad` → GUI editor → `inkInstance.pause()` + `suspendStdin()` (тихо, без вспышки)
- иначе → терминальный → `\x1b[?1049h` alt-screen flash, видно как мерцание

`noted-code-grab.js` начинается с `code` → GUI path. Без флэша.

Источник: `packages/claude-code-src/utils/editor.ts:20-30`, `:49-52`.

**`EDITOR_OVERRIDES` ловушка:** Claude дописывает `-w` для `code/subl` (`promptEditor.ts:68`). Lookup **exact**, поэтому `noted-code-grab` не получит `-w` — basename совпадение через `includes`, но override map по точному имени.

## Защита от user-zshrc clobber

У юзера в `~/.zshrc` может быть `export EDITOR="/usr/local/bin/subl -w"`. Когда наш shell-integration source'ит user-zshrc — он **затирает** наш EDITOR injection. Решение в `setupShellIntegration`:

```bash
__ct_injected_editor="$EDITOR"      # сохраняем наш до source'а user-zshrc
source "$HOME/.zshrc"               # user-zshrc может затереть EDITOR
# Восстанавливаем наш ТОЛЬКО если path указывает на наш helper:
if [[ -n "$__ct_injected_editor" && "$__ct_injected_editor" == *noted-code-grab* ]]; then
  export EDITOR="$__ct_injected_editor"
fi
# Параллельно сохраняем user'ский EDITOR в NOTED_ORIGINAL_EDITOR для passthrough mode:
if [[ -n "$EDITOR" && "$EDITOR" != *noted-code-grab* ]]; then
  export NOTED_ORIGINAL_EDITOR="$EDITOR"
fi
```

Guard `*noted-code-grab*` — не трогаем случайные пользовательские настройки. Только наши перезаписываем.

## getExternalEditor memoize — рестарт Claude обязателен

`getExternalEditor()` в Claude **memoize'ан на первом вызове** (`utils/editor.ts:164-183`). EDITOR должен быть в env **до** spawn'а Claude. Существующие табы запущенные ДО env injection не получат фичу до перезапуска Claude в табе.

**Pre-flight check в `claude:grab-input`:** через `ps -p <claudePid> -wwwE | grep EDITOR=` — если EDITOR ≠ наш → return `wrong_editor` error code → toast `"Restart Claude in this tab — grab needs our editor helper"`. Без этого юзер кликает grab, Sublime открывается в стороне, никаких ошибок — недоумение.

## Auto-runner — singleton hook, не в overlay

Auto-runner живёт в `src/renderer/hooks/usePromptQueueRunner.ts` и **монтируется один раз в App root** (`App.tsx`), не внутри `PromptQueueOverlay`.

```ts
// App.tsx (mount once)
usePromptQueueRunner();

// Внутри runner:
const prevBusyRef = useRef<Map<string, boolean>>(new Map());
ipcRenderer.on('claude:busy-state', ({ tabId, busy }) => {
  const wasBusy = prevBusyRef.current.get(tabId) ?? false;
  prevBusyRef.current.set(tabId, busy);
  if (wasBusy && !busy) {
    // pop next + send-command, или stopAfter если очередь пуста
  }
});
```

`claudeBusy` приходит из `claude:busy-state` который authoritative от Stop hook (см. `fact-claude-stop-hook.md::Интеграция в claude:busy-state`). Никаких setTimeout, никакого spinner-эвристики — pure event chain.

### Почему не в overlay (первая реализация была там и сломалась)

Overlay рендерится через гейт `effectiveActive && isClaudeTab && hasClaudeSession && claudeProcessAlive`. `effectiveActive` становится `false` как только юзер уходит на другой таб / Dashboard / Home view → React unmount'ит overlay → `useEffect` cleanup → `prevBusyRef` теряется.

**Симптом который мы поймали:** юзер армит "Run after", уходит на gemini-таб работать, Claude в фоне закончил turn → `claude:busy-state busy=false` приходит → **никто не слушает** (overlay unmounted) → следующий промпт не отправляется. Возвращается на Claude-таб → overlay re-mounts → `prevBusyRef.current = claudeBusy` (текущее значение, не old) → пропустили edge transition → **ничего не происходит**. Юзер думает что фича сломана.

**Решение:** singleton hook на верхнем уровне, не зависит от того что показано на экране. State хранится в `useRef<Map<tabId, boolean>>` — per-tab busy tracking без React state churn. Идентичная семантика, но **глобальный scope**.

### Cold-start через store subscription

Когда юзер добавляет промпт через `+ grab` / `+ add` в **idle** Claude таб — autoRun должен сразу отправить, не ждать первого busy→idle цикла (которого никогда не будет если Claude уже idle).

Реализация: вторая часть hook'а подписывается на `usePromptQueueStore.subscribe` и ловит **два независимых edge'а**, любой из которых триггерит fire когда `claude is idle && queue.autoRun && items.length > 0`:

- `items 0 → N` — юзер добавил chip когда autoRun уже армлен.
- `autoRun false → true` — юзер только что нажал «Run after» когда items уже стояли в очереди (например, Claude закончил отвечать, юзер забыл нажать Run after до отправки промптов, потом вспомнил).

Второй edge — реальный шрам: без него юзер арм-ал Run after поверх готовой очереди и ничего не запускалось до следующего вручную отправленного промпта (которого он не собирался отправлять — для этого и была очередь). Re-entrancy guard `firing = true/false` защищает от двойного fire (popNext → state change → ещё один subscribe-callback → потенциальная рекурсия).

### Auto-disarm

Когда последний элемент покинул очередь, `setAutoRun(false)` — pulsing pill гаснет визуально. Юзер видит что очередь завершилась. Реализуется через `beforePop === 1` check (читаем длину **до** popNext, если была 1 → теперь будет 0 → disarm).

## Toast UX — `Copied: "first 20 chars…"`

Сразу после copy/grab показываем превью того что попало в clipboard/queue. Одна строка, 20 символов, ellipsis. Multi-line schлёпывается в single-line через `text.replace(/\s+/g, ' ')`.

**Зачем:** юзер не видел финальный вид (Claude collapse'ит paste в `[Pasted text #N +M lines]`). Toast = подтверждение **что именно** ушло. Если ушло что-то не то — юзер замечает через 1.5 секунды, может поправить.

## Post-prompt: per-tab суффикс для каждого элемента очереди

В шапке очереди живёт сплит-кнопка `▣ Post | ✎`: левая зона — per-tab toggle `postPromptEnabled`, правая (✎ карандашик) открывает slideout-редактор в режиме `isPostPromptMode`. Когда toggle включён — runner аппендит `\n\n${postPromptText}` к **каждому** элементу очереди прямо перед `claude:send-command`. Per-tab — у разных Claude-табов могут быть свои post-prompt'ы (типовой сценарий: в одной вкладке гоняем рефакторинг с системным «не трогай тесты», в другой пишем тесты с «всегда добавляй edge case for null»). Empty text + toggle ON = no-op (suffix не аппендится), но визуально toggle всё ещё «active» с tooltip-намёком «click ✎ чтобы наполнить» — иначе юзер думает «включил, ничего не работает».

**Replay (▶ на чипе) намеренно обходит post-prompt.** Replay = «верни текст в композер чтобы посмотреть глазами и отправить руками»; auto-аппенд суффикса там сломал бы инвариант «вижу ровно то что отправлю». Runner-аппенд только для авто-pop'аемых элементов очереди.

## First-chip armed hint: красный blink, не оранжевый

Когда `items.length === 0 && autoRun === false` и юзер дёргает `+grab` / `+add` — Run after pill получает красную обводку + красный фон + 2×0.7s CSS-keyframes blink (`pq-hint-blink`, total 1.4s). По истечении анимации JS-таймер на тот же `BLINK_CYCLE_MS * BLINK_ITERATIONS` интервал зовёт `consumeFirstChipHint(tabId)` — base armed-state снимается в той же frame что и last keyframe. **Никакого frozen-red после анимации.** Hover остаётся как fast-path (юзер увидел раньше → таймер чистится через cleanup, hint снимается мгновенно). Анимация перезапускается на каждом re-arm'е через `key={blinkKey}` remount span-overlay'я (иначе React не дропнет завершённый animation state). Константы `BLINK_CYCLE_MS = 700` и `BLINK_ITERATIONS = 2` живут одной парой — поменять одну значит подтянуть и CSS-string, и JS-таймер, иначе рассинхрон между «когда CSS закончил» и «когда JS считает что закончил». Принцип переносимый — см. `methodology/переносимый-дизайн.md::Animation-driven hint: auto-consume на frame окончания`.

**Шрам про палитру.** Первая реализация использовала янтарный `#d97706` (типичный «attention» цвет в проекте). Юзер прочитал его как «оранжевый» и спутал с **уже** оранжевым активным состоянием Run after — hint визуально неотличим от state. Переделали в чистый красный `#ef4444`: красный нигде больше в panel-кластере не задействован, читается однозначно как «обрати внимание». Принцип переносимый — см. `methodology/переносимый-дизайн.md::Hint colour ≠ active colour`.

**Шрам про длительность.** Первая версия — 5×0.5s = 2.5s — юзер прочитал как «слишком долго мельтешит» (*«около 5 раз мигает красная кнопка [...] она должна мигать где-то секунды 2, то есть покороче»*). Снизили до 2×0.7s = 1.4s. Один цикл чуть медленнее (полсекунды → 0.7s) — визуально перцептивно мягче, не рвёт зрение. Главное — total ≤ 2 секунд по запросу юзера.

## Replay (▶) на чипе + guard от bash/zsh

Слева на каждом чипе — кнопка ▶. Клик пастит текст чипа в input Claude через IPC `claude:append-input`, который внутри вызывает `safePasteAndSubmit({submit:false, stashFirst:false, ctrlCFirst:false})`. Без `submit:true` — текст ложится в композер без Enter, юзер ревьюит и сабмитит сам. Без `stashFirst` — текущий draft Claude не трогается (мы аппендим к existing input, не замещаем).

**На success — чип удаляется из очереди** (`removePrompt(tabId, it.id)` в renderer-handler). Семантика replay = **переезд** промпта в input, а не копия. Юзер сформулировал: *«если перемещение прошло успешно — у нас он должен из очереди удаляться»*. Без удаления тот же текст потом мог бы повторно выстрелить через auto-run drain — двойная отправка. На error (`!res.success` или исключение в IPC) — чип остаётся, юзер ретрайнет. Дополнительный side-effect: если это был **последний** чип очереди, removePrompt на transition 1→0 каскадно гасит `stopAfter/closeAfter` через store-mutator (см. секцию Stop/Close split ниже) — replay = «я сам этим займусь дальше», promise-state X-after становится беспочвенным.

**Spinner on the button while IPC is in flight.** Replay roundtrip — ~400-800ms (Ctrl+G grab → helper write → main IPC paste). Без видимой in-flight индикации юзер двойным кликом ставит вторую `claude:append-input` параллельно, потом `removePrompt` дважды — второй уже на несуществующем id. Guard через `replayingIds: Set<string>` в локальном state'е: на entry в handler добавляем id, кнопка для этого chip'а рендерится с `<span class="pq-spinner" />` вместо `▶` + `disabled` + статичный hover-палитра. Hover-handlers `if (replayingIds.has(it.id)) return;` чтобы стиль не дёргался при движении курсора. В `finally` удаляем id из set'а (на success чип всё равно уже исчез через removePrompt — set-операция no-op).

**Hard guard `claudeCliActive.get(tabId)` в main-handler.** Без него: Claude exit-нулся между renderer-снимком и приходом IPC → bracketed paste чипа улетает в живой shell-parent PTY (bash/zsh). Современный zsh поддерживает bracketed paste mode → весь чип становится **одной shell command-line**. Чип `rm -rf node_modules` отрабатывает мгновенно, чип `sudo apt remove ...` запрашивает пароль. Handler сразу `return { success: false, error: 'no_claude_session' }` если флаг false; renderer показывает toast «No Claude session for replay». Тело чипа открывает редактор по клику; ▶ и × используют `data-chip-action` + `stopPropagation`, чтобы клик не пробил в тело.

## Stop/Close split: каскад stopAfter ↔ closeAfter

Бывший «Stop after» pill стал сплит-кнопкой. Левая зона — `stopAfter` (SIGTERM по окончанию очередного turn-а когда очередь пуста, one-shot disarm). Правая — `closeAfter` (после SIGTERM ещё и закрывает таб через `useWorkspaceStore.closeTab(tabId, { skipProcessCheck: true, forceCleanup: true })` — без модалки подтверждения). closeAfter невозможен без stopAfter: закрытие таба при живом Claude процессе бессмысленно. Поэтому `setCloseAfter(true)` каскадно ставит `setStopAfter(true)`; обратно — `setStopAfter(false)` каскадно гасит `setCloseAfter(false)` (orphan "close but don't stop" — недопустимая комбинация). Лейбл переключается «Stop after» ↔ «Close after» в одной CSS-grid ячейке (обе строки в `grid-template-columns: auto`, неактивная `visibility: hidden`) — ширина блока не дёргается. Каждая зона со своим border-radius'ом и border'ом: когда только stopAfter включён, левая зона оранжевая, правая остаётся серой на всех сторонах (не должна наследовать оранж от соседа через общий outer-frame).

**Pre-arm memory: `stopBeforeCloseArm`.** Клик ⏻ из baseline `(stop=off, close=off)` поднимает обе зоны (cascade). Повторный клик ⏻ должен **вернуть к baseline**, а не оставлять `(stop=on, close=off)` — иначе orange-зона зависает без обоснования. Хранится UI-only slot `stopBeforeCloseArm: boolean` (не персистится). `setCloseAfter(true)` пишет `stopBeforeCloseArm: cur.stopAfter` (записываем что было ДО форса); `setCloseAfter(false)` восстанавливает `stopAfter: cur.stopBeforeCloseArm`, обнуляет слот. `setStopAfter(any)` обнуляет slot всегда — клик по левой зоне = новый baseline, прошлая память невалидна. Таблица:

| Старт | Клик ⏻ | Клик ⏻ повторно |
|---|---|---|
| `stop=OFF, close=OFF` | `stop=ON, close=ON` | `stop=OFF, close=OFF` ✓ |
| `stop=ON,  close=OFF` | `stop=ON, close=ON` | `stop=ON,  close=OFF` ✓ |

**Auto-disarm при ручном empty-out очереди.** Если последний чип уходит **руками** (× или ▶ Replay), `removePrompt` на transition `items.length === 1 → 0` дополнительно гасит `stopAfter/closeAfter/stopBeforeCloseArm`. Причина: X-after без очереди превращается в зомби-promise, юзер потом удивляется когда после следующего автономного turn'а Claude вдруг убивается. Юзер: *«если пропадает последняя запись там через Play либо через ×, StopAfter должен переставать быть активным»*. **Граница против `popNext`** — там очередь опустошается естественно (autoRun-runner отстрелял последний промпт в Claude), X-after должен **остаться** armed, чтобы runner на следующем busy→idle edge выстрелил `terminal:stop-ai-process`. Если бы `popNext` тоже триггерил disarm — main use case «отправь N промптов и убей Claude» сломался бы. Различие в store-mutator: `removePrompt` гасит, `popNext` не трогает.

**Seam-фикс правой рамки.** Раньше: левая `borderRight: none`, правая `borderLeft: 1px BORDER` (grey 0.08-alpha) — seam рисовала **правая** через свою левую границу. На retina + темном фоне 0.08-alpha 1px-border попадает в subpixel rounding compositing → Chromium периодически дропает draw при relayout (tab-switch overlay mounted, props меняются). На клик-relayout восстанавливается. Плюс `transition: all 0.15s` анимировал смену border-color между табами → 150ms fade orange→grey = «подёргивание внутри». Юзер: *«при переключении вкладок она просто-напросто, блять, пропадает, потом если я заново нажимаю кнопку, она появляется»*. Фикс — перенёс ownership seam'а на **левую** кнопку: full `1px solid` со всех 4 сторон (включая seam = `borderRight`), правая кнопка имеет `borderLeft: 'none'` + три остальные стороны. Seam теперь integer-pixel border-right с непрозрачным цветом, Chromium не теряет. Цвет seam = `leftBorder` (orange/red/grey), семантически правильно — active-зона «прокрашивает» seam своим цветом. `transition` убран — на tab-switch снапит мгновенно. Hover-handler правой кнопки трогает только три свои стороны, seam под управлением leftBorder. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Split-button seam: один owner draws border, не adjacency`.

**Hover policy: только color, не border/background.** На idle-зоне hover красит **только** `color` (текст «Stop after» → orange, ⏻ icon → red). Background и border-color **не трогаются** — они закреплены за state-сигналом. Юзер: *«фон и рамку менять не надо»*. На активной зоне (stop armed → левая orange; close armed → обе red) hover вообще no-op — state уже даёт сильный цвет. Без этого правила hover-эхо конфликтует с armed-эхом (юзер не отличает «hover-orange» от «armed-orange»). См. `methodology/переносимый-дизайн.md::Hover-isolation для split-button` (расширение секции).

Принцип каскада переносимый — см. `methodology/переносимый-дизайн.md::Toggle cascade: dependent ⇒ parent`. Скрытое-но-резервированное «Close after» расширение grid-ячейки — частный случай `methodology/переносимый-дизайн.md::Layout reservation для toggle-able children` (там добавлен абзац про variable-label). Auto-disarm при manual empty-out — `methodology/переносимый-дизайн.md::Promise-state auto-disarm: manual context-drop vs pipeline-drain`.

## Image-paths resolution из grabbed `[Image #N]`

Когда юзер пастит картинку в Claude TUI через Cmd+V (или drag-and-drop), Claude Code не отправляет её сразу — она живёт в **двух местах**:

1. В RAM Claude как `pastedContents: Record<number, PastedContent>` под ключом `pasteId` (счётчик `nextPasteIdRef++`).
2. В тексте input'а — плейсхолдер `[Image #N]` в позиции курсора (`formatImageRef(pasteId)`).
3. На диске — асинхронно через `storeImage()` в `~/.claude/image-cache/<sessionId>/<N>.<ext>`, режим `0o600`, расширение `mediaType.split('/')[1]` (`png|jpeg|jpg|gif|webp|bmp`). Размер cap в RAM: 200 файлов с FIFO eviction. Источник: декомпиленный `packages/claude-code-src/utils/imageStore.ts`.

**Файлы не удаляются в течение жизни сессии.** Удаление плейсхолдера через бэкспейс пруньет **только** in-memory `pastedContents`, файл на диске остаётся. `cleanupOldImageCaches()` запускается ровно один раз — при boot'е Claude — и сносит **все** session-папки **кроме текущей**. Внутри текущей сессии очистки нет.

При финальном submit в API `processUserInput.ts::storeImages` идемпотентно гарантирует что все картинки на диске (повторно пишет если что-то пруньнули) и шлёт `image_url` content-blocks. Это значит: пока live sessionId — все `[Image #N]` имеют живые файлы рядом.

**Наш resolver `resolveGrabbedImagePaths(sessionId, text)`** парсит регексом `\[Image\s+#?(\d+)\]` плейсхолдеры из grabbed-текста (helper приходит с `[Image #N]` дословно — `expandPastedTextRefs` Claude'а раскрывает text-refs, image-refs оставляет литералом). Для каждого id перебирает расширения, ищет файл, отдаёт `{id, path, mediaType, size}` если существует. В `claude:grab-input` resolve добавляем `imagePaths` к ответу, кладём в `QueuedPrompt.imagePaths` через `addPrompt(tabId, text, images, imagePaths)`. Лог `[GrabImages] tab=... sessionId=... refs=N resolved=[#1:46KB,#2:MISSING]` — `MISSING` = ссылка в тексте есть, файл нет (Claude был рестартован после paste, image-cache папка ещё не очищена но текущий sessionId уже другой; либо grab случился в момент когда file write ещё не флашнулся — редко).

**Граница persistence.** `QueuedPrompt.imagePaths` хранится в очереди вместе с текстом, переживает app restart через `app:setState`. **Но** если Claude в этом табе рестартовали — `cleanupOldImageCaches` снёс старую sessionId-папку, пути валидны на диске только пока live тот же sessionId что был при grab'е. После рестарта Claude в табе chip'ы со старыми imagePaths становятся «текст + сломанные ссылки». UI это пока не визуализирует — индикатор «📎N» рисуется из `it.images` (count), не из `it.imagePaths?.length`.

**Что НЕ делает** текущая фича: re-paste картинок при Replay (▶). Кнопка вставляет только текст с плейсхолдерами `[Image #N]` в input Claude — Claude увидит ссылки на несуществующие в его новой `pastedContents` map'е id (если delete-range / fork session). Полноценный image re-attach требует либо (a) копировать файл в clipboard + симулировать Cmd+V в PTY (нужен native paste hook со стороны Claude), либо (b) `/file <path>` команды если она есть. Отдельный pipeline на будущее.

## Editor open = toggle, не permanent open

Все три триггера, открывающие slideout-редактор (тело чипа, `+add` в футере, ✎ post-prompt в шапке), стали toggle'ами: повторный клик на **том же** триггере закрывает редактор. Предикаты per-trigger:
- chip → `editorOpen && !isPostPromptMode && editingId === id`
- `+add` → `editorOpen && !isPostPromptMode && !editingId`
- ✎ → `editorOpen && isPostPromptMode`

Cross-trigger swap (чип A → ✎ post-prompt, или ✎ → `+add`) по-прежнему мгновенно переключает purpose редактора без закрытия. При swap'е чип→post-prompt с **незакоммиченными** правками чипа (`editorText` !== оригинального текста чипа) — показывается `window.confirm` перед сменой purpose. Без этого юзер набирал правки в чипе, тыкал ✎ «дай-ка гляну post-prompt» — правки чипа молча сохранялись как post-prompt, чип терял изменения.

Унифицирующий helper `closeEditor()` сбрасывает все editor-state поля одним вызовом (`setEditorOpen(false)`, `setEditingId(null)`, `setIsPostPromptMode(false)`, `setEditorText('')`) — без него повторный open подхватывал stale `editingId`. Принцип «триггер = toggle» переносимый, см. `methodology/переносимый-дизайн.md::Open-toggle для slideout/popover триггеров`.

## Focus terminal перед `clear-input`

После `copy-input` тут же шлём `clear-input` IPC → main посылает Ctrl+G → helper truncate'ит tempfile → Claude перечитывает → инпут гаснет. **Но** если фокус был на InfoPanel-кнопке, Ink render-loop в неактивной browser-вкладке throttled → "Save and close editor..." flash проигрывается **только когда юзер кликнет в терминал**. Симптом: юзер копирует → инпут стоит → кликает в терминал → инпут мгновенно гаснет ("какой-то flash был, потом стёр").

Фикс: `focusActiveTerminal()` **между** showToast и `clear-input` IPC. RAF-обёртка → фокус → Ctrl+G в активный render-loop → мгновенная обработка.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `~/.claude/hooks/noted-code-grab.js` | Helper script, lock-file dispatcher |
| `/tmp/noted-grab-<claudePID>.json` | Mode lock-file, consumed on read |
| `/tmp/noted-terminal-claude-hook.sock` | Unix socket для GrabInput payload |
| `src/main/main.js::captureClaudeInput` | Shared между `claude:grab-input` и `claude:copy-input`. Делает `process.kill(claudePid, 0)` alive-probe перед всем — если кэш PID мёртвый, возвращает `stale_pid` сразу, не пишет lock и не шлёт Ctrl+G. См. [`fix-prompt-queue-stale-pid.md`](fix-prompt-queue-stale-pid.md). |
| `src/main/main.js::claude:clear-input` | Fire-and-forget вариант без socket roundtrip |
| `src/renderer/store/usePromptQueueStore.ts` | Per-tab queue + autoRun + stopAfter state |
| `src/renderer/components/Workspace/PromptQueueOverlay.tsx` | UI overlay (gated by active tab) — only renders pills/chips/editor, NO runner logic |
| `src/renderer/hooks/usePromptQueueRunner.ts` | Singleton auto-runner. Mounted in App.tsx, fires regardless of which tab is visible |

## Что пробовали и почему отбросили

- **Ctrl+C для clear input** — single press в Claude TUI = "clear input" но **также** взводит "Press Ctrl-C again to exit" danger zone. Race: если в момент клика юзера на + grab юзер случайно дёрнет Ctrl+C через keyboard — два подряд → exit Claude. Стало через external editor mode=clear — безопасно, не трогает stdin keystrokes.
- **`/edit` slash command** — нет такого в Claude Code (`packages/claude-code-src/commands/`). `/copy` и `/export` работают над assistant response, не над draft.
- **Stash flow (Ctrl+S)** — кладёт draft в `stashedPrompt` slot, инпут визуально пуст. Но stash восстанавливается **при следующем обычном submit** — если юзер потом напишет `hello\r`, Claude вернёт `<stashed>` + `hello`. Не работает для нашего случая.
- **Double Ctrl+S (stash → pop)** — `handleStash` bi-directional, второй Ctrl+S попнет stash **в инпут**, не очистит. Тупик.
- **Auto-runner внутри PromptQueueOverlay компонента** — первая реализация. Слушал `claudeBusy` prop, делал `wasBusy → !claudeBusy` edge detection через `useRef`. Падало когда юзер переключался на другой таб: overlay unmount'ится по гейту `effectiveActive`, runner с ним умирает, следующий busy→idle transition в фоне не ловится. Переехал в `usePromptQueueRunner` hook на App root. Урок переносимый — любой listener для **глобальных** событий (IPC от main, OS-level signals) не должен жить в gated-by-active-tab компонентах. См. `methodology/переносимый-дизайн.md::Singleton listener для global events, не в conditionally-rendered компонентах`.
- **Silent 3s timeout без specific error code** — был один код `editor_not_wired` на ВСЁ что пошло не так после `term.write('\x07')`. Helper не запустился, ppid не сматчился, socket упал — всё превращалось в одинаковый toast «Helper not reachable» через 3 секунды. Юзер не знал что делать. Прод-лог за 13:20-13:21 показал что одинаковый симптом приходил из **двух** разных источников (мёртвый cached PID + слишком ранний клик после spawn) — оба молчали 3 секунды и оба выдавали тот же toast. Фикс: `stale_pid` отдельным кодом с прямой инструкцией «close & reopen this tab». См. [`fix-prompt-queue-stale-pid.md`](fix-prompt-queue-stale-pid.md), общий принцип — `methodology/переносимый-дизайн.md::Cached external resource: alive-probe перед использованием`.
- **Per-chunk `waitForRender` на slow-mode paste из очереди** — давал 57с гэп между cold-start `popNext()` и фактическим UserPromptSubmit для 50KB payload (56 чанков × 1000ms timeout). Юзер думал что очередь сломана. Root cause: Ink батчит рендеры до `\x1b[201~`, sync marker эмитит один раз в конце, не на каждом промежуточном чанке. Фикс: single write для slow-mode (chunks.length === 1 by construction), один post-write `waitForRender`. См. [`fix-claude-paste-stuck-queue.md`](fix-claude-paste-stuck-queue.md).
- **Stash-detect через `tail.slice(-40)` + `stripVTControlCharacters` + `.includes('Stashed (auto-restores after submit)')`** — первая реализация helper'а который ждёт появления stash-маркера в output buffer перед тем как считать команду применённой. Поймала задокументированный Ink-баг сразу (см. `fact-claude-tui-control.md::Ink TUI: пробелы как ANSI-команды`): Ink эмитит inline-пробелы как `\x1b[<N>C` (cursor-forward escape), `stripVTControlCharacters` сносит их вместе с реальными ANSI-кодами → литерал склеивается в `"Stashed(auto-restoresaftersubmit)"`, `.includes` не матчится. Плюс маркер может лечь через границу `data.split('\n')` (две физические строки в одном PTY chunk'е), плюс длинный стрим assistant-ответа выталкивает stash-маркер за хвост 40-строчного окна. Фикс: сканируем **весь** `terminalOutputBuffer` (cap 500 строк — bounded, не растёт бесконечно), join → один strip-pass → tolerant regex `/Stashed\s*\(\s*auto-restores\s*after\s*submit\s*\)/`. Регекс с `\s*` терпит и схлопывание пробелов после strip, и сохранившиеся реальные пробелы — оба варианта валидны.
- **Pre-block grab по `claudeSpinnerBusy`** — первая попытка фикса misleading `editor_not_wired` toast'а во время стрима. Логика: если Claude стримит ответ, Ctrl+G no-op'нется в TUI (`chat:externalEditor` binding неактивен mid-turn) → helper не запустится → timeout → красный toast. Решение «не пускать grab вообще пока spinner busy» казалось правильным. Юзер прямо возразил: *«нет, +grab наоборот должен работать когда стриминг — это и есть его смысл, поставить промпт в очередь пока Claude думает»*. Откатили pre-block, остался только hook-confirmed `claudeTurnBusy === true` (короткое окно когда Stop hook ещё не пришёл). Замена для misleading toast'а — diagnostic-on-timeout: snapshot'им size `/tmp/noted-grab-helper.log` ДО `term.write('\x07')` и после 3с timeout. Если log не вырос — helper не запустился (Ctrl+G ate by TUI) → resolve `claude_busy` toast «Claude is busy…». Если log вырос — helper отработал но не достиг socket → `editor_not_wired` остаётся. См. `methodology/переносимый-дизайн.md::Action валиден mid-state — не блокировать по чужому busy-флагу` и `methodology/переносимый-дизайн.md::Diagnose with instrumentation, not guesses`.
