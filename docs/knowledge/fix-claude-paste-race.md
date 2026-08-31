# Fix: Concurrent safePasteAndSubmit на одном PTY + N chips от per-chunk brackets

## Симптомы (сессия `bb95e71d`, 16:01 MSK 2026-05-16)
- В Claude TUI один длинный prompt разбился на **20–30 chip'ов** `[Pasted text #N]` вместо одного.
- Сразу после большого prompt'а юзер нажал кнопку **Compact** — команда `/compact` бесследно исчезла, как будто не отправлялась.
- В Claude улетели **две** копии одного и того же длинного prompt'а: первая обрезана с конца, вторая обрезана с начала.
- `last-prompt` в JSONL начинается с середины слова: `"ило в лендинге другого проекта…"`.

## Root cause: два concurrent `claude:send-command` на одном `ptyProcess`

`ipcMain.handle('claude:send-command')` не сериализовался. Каждый invoke вызывал `safePasteAndSubmit(term, ...)` независимо. Когда два разных источника (queue runner с большим prompt'ом, UI-кнопка Compact с `/compact`) попадали на один и тот же tabId одновременно — их `term.write()` вызовы интерлевились в PTY.

Поток в PTY за 0.5 секунды:
```
13:01:42.317  [runner] Ctrl+S
              [runner] \x1b[200~chunk1\x1b[201~     waitForRender
              [runner] \x1b[200~chunk2\x1b[201~     waitForRender
              ...
              [runner] \x1b[200~chunk6\x1b[201~
13:01:42.856  [UI:Compact] Ctrl+S         ← залетел в середину чужого паста
              [UI:Compact] \x1b[200~/compact\x1b[201~
              [UI:Compact] Enter           ← submit'нул то, что было в input у Claude
              [runner] \x1b[200~chunk7\x1b[201~     продолжает писать
              ...
              [runner] \x1b[200~chunk55\x1b[201~
              [runner] Enter                ← submit хвоста как ещё одного prompt'а
```

Claude TUI увидел:
1. `Enter` от `/compact`'а в момент, когда в input лежали первые 5400 байт длинного prompt'а → submit как **первый prompt** (но не slash-команда, потому что `/compact` оказался текстом внутри ещё-открытого bracketed-paste первого источника).
2. `Enter` от runner'а после остальных 43756 байт → submit как **второй prompt** (хвост того же текста).

Юзеру это видится как «первый prompt продублировался два раза, /compact пропал».

### Параллельный root cause: per-chunk brackets в slow-mode

Даже без race у длинного prompt'а было бы 55 chip'ов:

`safePasteAndSubmit` бил контент на чанки по 900 байт (TTYHOG = 1024). В **slow-mode** (Claude Ink) каждый чанк оборачивался в **собственную** пару `\x1b[200~...\x1b[201~`:

```js
// БЫЛО:
payload = PASTE_START + chunk + PASTE_END;  // на КАЖДОЙ итерации
```

Ink TUI рендерит **один chip на одну bracket-pair**. 49156 байт = 55 чанков = 55 chip'ов. Юзер увидел `[Pasted text #1] [Pasted text #2] ... [Pasted text #N]`.

В **fast-mode** (Gemini, bash) уже было правильно — один общий `\x1b[200~` на первом чанке, один общий `\x1b[201~` на последнем, между ними только текст. Slow-mode дублировал brackets из-за старого ограничения записи и ошибочного ожидания отдельного ACK на каждый кусок. Современный node-pty доставляет Claude один большой logical paste; несколько bracket-pair нужны не для надёжности, а создают несколько независимых Ink paste-events. Sync marker при этом остаётся границей render-frame, а не подтверждением одного чанка или всего semantic input.

### Второй класс: Enter после промежуточного `Pasting…`

После перехода на single write осталась независимая гонка. Длинный prompt с
четырьмя изображениями дал новый честный sync marker, но он закрывал
промежуточный кадр `Pasting…`. Код сразу записал Enter; примерно через 500мс
Claude дорисовал четыре image chips и collapsed text, оставив их в composer без
user-turn. Ручной Enter позже отправил тот же input.

Фиксированный delay здесь только меняет вероятность. Transport marker не знает,
какую semantic-форму закрыл Ink, поэтому Enter должен ждать current committed
composer той же PTY/input generation. Порог collapsed paste угадывать нельзя:
принимаются реально наблюдённые законченные text/chip/image формы, неизвестное
состояние сохраняет draft и падает до Enter.

## Фикс

### 1. Per-term mutex в `safePasteAndSubmit`

WeakMap `pasteInflight: term → Promise`. Перед началом работы новый caller получает текущий inflight promise (если есть), чейнит свою работу через `.then(...)`. Финальный `try/finally` удаляет себя из map **только если** мы всё ещё последний writer (не оверрайдим следующего chained caller'а).

```js
const pasteInflight = new WeakMap();

async function safePasteAndSubmit(term, content, options = {}) {
  if (!term || ...) return { success: false, ... };
  const prev = pasteInflight.get(term) || Promise.resolve();
  const work = prev.catch(() => {}).then(() => _safePasteAndSubmitInner(term, content, options));
  pasteInflight.set(term, work);
  try { return await work; }
  finally {
    if (pasteInflight.get(term) === work) pasteInflight.delete(term);
  }
}
```

`prev.catch(() => {})` важен — если первый caller бросил исключение, мы **не должны** poison'ить chain для следующих. Каждый caller владеет своими ошибками.

WeakMap (а не Map) — потому что `term` это объект, при exit PTY и `terminals.delete(tabId)` JS освободит entry автоматически. Никакой ручной cleanup при `onExit` не нужен.

### 2. Single bracket pair во всех режимах

Slow-mode теперь использует ту же стратегию что fast-mode: `\x1b[200~` только на первом чанке, `\x1b[201~` только на последнем, между ними чистый текст + sync-marker wait между чанками для slow-mode (waitForRender как было). Claude видит **один** chip независимо от количества чанков.

### 3. Broadcast `claude:paste-busy`

Main эмитит `claude:paste-busy { tabId, busy: true/false }` вокруг `safePasteAndSubmit`. InfoPanel слушает и через derived `isControlBusy = isControlBusyLocal || isPasteBusy` отключает Compact/Model/Effort/Think пока идёт чужой paste. Belt-and-braces поверх mutex'а: даже если кнопка через гонку пройдёт `isControlBusyLocal`-гард, mutex всё равно сериализует, но disabled-state даёт юзеру **немедленную** обратную связь «сейчас нельзя».

### 4. Semantic composer gate и exact recovery

Обычный Claude submit ждёт после transport marker одну конечную форму composer:
inline text, полный collapsed-paste, images + text/chip либо image-only. После
Enter delivery подтверждает `UserPromptSubmit`/JSONL. Преобразование локальных
путей в provider image blocks сохраняет исходный operation hash только при
exact generation/route/chip-count proof; generic whitespace matching запрещён.

Если audit не появился, допустим ровно один повтор Enter — только когда точное
чтение вернуло тот же app-owned draft, causal user-records всё ещё ноль и ни
одна координата PTY/run/lifecycle/input не изменилась. Иначе исход остаётся
replay-safe unknown, а не превращается в blind retry.

## Что отбросили

- **Не глобальный mutex** (по всему process'у) — два разных tabId с двумя разными PTY должны pasteить **параллельно**, иначе UX встанет колом при многих табах.
- **Не очередь в renderer'е** (типа `useWorkspaceStore.pasteQueue: tabId → [...]`) — слишком много логики дублировать на JS-стороне, и не покрывает не-renderer источники (MCP, /effort auto-inject).
- **Не оптимистичная `if (busy) return`-guard** в `claude:send-command` — потеря команд. Mutex чейнит, не отбрасывает.

## Связанные
- `fact-claude-tui-mechanics.md::4. Atomic Bracketed Paste` — теоретический фрейм проблемы, теперь подтверждён эмпирически и применён к slow-mode тоже.
- `fact-claude-tui-control.md::Stash flow` — Ctrl+S перед paste; mutex гарантирует что Ctrl+S одного caller'а не залетит в середину bracketed paste другого.
- `methodology/переносимый-дизайн.md::Routing по контексту запроса` — параллельный паттерн для других race conditions.
