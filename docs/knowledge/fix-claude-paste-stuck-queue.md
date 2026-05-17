# Fix: очередь промптов «зависает» на ~1 минуту перед отправкой большого paste

## Симптом
Юзер:
1. Делает Cmd+V большого текста (50KB) в Claude TUI → один chip `[Pasted text #1]` появляется мгновенно, как в iTerm2.
2. Жмёт `+grab` в PromptQueueOverlay → chip уходит в очередь, autoRun армится.
3. Cold-start runner запускает `claude:send-command` с тем же 50KB payload.
4. **Между кликом и моментом, когда Claude примет промпт — 50-60 секунд тишины.** Никакой ошибки, очередь не падает, просто «как будто всё повисло». Иногда юзер думает что фича сломана и нажимает ещё раз.
5. Через минуту Claude всё-таки получает промпт, отвечает корректно.

**Контраст:** Тот же 50KB через ручной Cmd+V — instant.

## Repro (детерминированно, prod 2026-05-17)

production.log, tab-88, sessionId `f70739d4`:

```
02:15:33.988 [capture-input:grab] sending Ctrl+G pid=62190
02:15:34.060 [ClaudeHook] #4 GrabInput tab=...-88 mode=grab bytes=50230
02:15:34.061 [send-command] 🚀 Start: "..." (50230 chars → 56 chunk(s), fast=false, stashFirst=true)
02:15:34.084 [BoundaryMarker] Tab ...-88: Injected prompt #11   ← Ctrl+S landed
02:15:35.244 :chunk1 ⏱️ TIMEOUT (1000ms), buf=0B          ← chunk 1
02:15:36.301 :chunk2 ⏱️ TIMEOUT (1000ms)
... (53 timeouts × ~1057ms gap)
02:16:31.207 :chunk56 ✅ sync marker at +26ms              ← последний чанк
02:16:31.263 ✅ Sent Enter (total: 57202ms)
02:16:31.349 [ClaudeHook] #6 UserPromptSubmit tab=...-88
```

**Цифры:** 56 чанков × ~1057ms timeout = 57 секунд гэпа. Совпадает с тем, что воспринял юзер.

## Root cause

Слой safePasteAndSubmit в slow-mode (Claude) бил payload на чанки по `CHUNK_MAX=900` байт (TTYHOG margin) и после каждого вызывал `waitForRender(term, 1000ms)`. Ожидание: Ink эмитит `\x1b[?2026l` (DEC private mode 2026, sync marker) на каждом render cycle, в том числе на промежуточных рендерах внутри ещё-открытого bracketed paste (`\x1b[200~...`). Эту гипотезу мы зафиксировали в `fact-claude-tui-mechanics.md::Section 4`.

**Гипотеза не подтвердилась на больших payload:** Ink **батчит** все рендеры до закрытия paste-а (`\x1b[201~`). Внутри открытого `\x1b[200~` поток приходит, но `setNeedsUpdate` Ink-а откладывается до конца paste — `\x1b[?2026l` не эмитится. Каждый из 53 промежуточных чанков ждёт полный timeout, возвращает `timedOut=true` и идёт дальше «по таймеру». Последний чанк (с `\x1b[201~`) получает marker мгновенно (26ms) — paste закрыт, Ink наконец рендерит.

Параллельно интересный факт: chunks 6 и 7 в нашем repro получили marker за 327ms и 394ms (не timeout). Связано с focus event или scroll mid-paste. Не критично для root cause, но фиксируем как наблюдение — может всплыть на других repro.

### Почему ручной Cmd+V работает

`ipcMain.on('terminal:input')` для длинного paste делает один `term.write(data)` (transparent passthrough, см. `fix-paste-bracket-mode-loss.md`). Одна пара brackets, одна доставка → Ink парсит за один тик. node-pty 1.2.0-beta.13 (PR #831) умеет писать >TTYHOG без потерь через `fs.write + EAGAIN retry`.

## Фикс

`safePasteAndSubmit` slow-mode переведён на single-write: `chunks.length === 1 by construction` независимо от длины. Внутренний цикл оставлен — он остался нужен для fast-mode (Gemini/bash, where Ink не задействован). Один `waitForRender` **после** записи (а не per-chunk) — Ink emits sync marker один раз, когда `\x1b[201~` закрывает paste.

```js
// Внутри safePasteAndSubmit:
const chunks = [];
if (fast) {
  for (let i = 0; i < content.length; i += CHUNK_MAX) {
    chunks.push(content.substring(i, i + CHUNK_MAX));
  }
} else {
  chunks.push(content); // slow-mode = один chunk = один bracket pair = один write
}
// ...
for (let i = 0; i < chunks.length; i++) {
  let payload = chunk;
  if (i === 0) payload = PASTE_START + payload;
  if (i === chunks.length - 1) payload = payload + PASTE_END;
  term.write(payload);
}
// slow-mode только:
if (!fast) {
  const render = waitForRender(term, safetyTimeoutMs, logPrefix + ':paste');
  render.markWriteTime();
  await render;
}
```

После фикса 50KB paste из очереди отправляется за ~100-200ms (один write + один render cycle), визуально неотличимо от ручного Cmd+V.

## Защита от регрессий: PasteAudit

После единственного term.write нет per-chunk verification что Ink получил все байты. Чтобы будущая потеря данных (новый node-pty с регрессией, новая alt-screen quirk, новый Ink-баг) не молчала — добавили **post-hoc audit** через UserPromptSubmit hook.

### Механизм

1. `safePasteAndSubmit` прямо перед Enter записывает в `pendingPasteAudit.set(tabId, ...)`:
   ```js
   { expectedLen, expectedHash /* sha1[:16] */, headPreview, tailPreview, sentAt, logPrefix }
   ```
2. Через ~50-300ms прилетает hook `UserPromptSubmit` с `transcript_path`.
3. Handler читает JSONL, walk-back до последней `{type:"user", message:{role:"user", content:...}}` записи, извлекает `content` (string или `Array<{type:"text", text:string}>`).
4. Считает sha1, сравнивает с `expected*`.

### Что пишется в лог

- **Match:** `[PasteAudit] tab=...-88 ✅ match len=50230 hash=a3b...c12 (sent 245ms ago)`
- **Mismatch:** `[PasteAudit:MISMATCH] tab=...-88 expectedLen=50230 actualLen=49873 Δ=-357 expectedHash=a3b... actualHash=8f1... expectedHead=[...] actualHead=[...] expectedTail=[...] actualTail=[...] transcript=/path`
- **Cleared без сравнения:** транскрипт missing — лог о cleanup.

### Когда сработает

- node-pty снова потеряет байты на большом payload (PR #831 регрессит).
- Claude TUI изменит alt-screen behavior, и кусок paste'а выпадет в shell вместо Ink.
- Encoding mismatch (CRLF/LF, BOM, multibyte).
- Race с следующим safePasteAndSubmit на этом таб'е (mutex отрабатывает, но если он сломается — `Δ` покажет smear).

Не сработает: на ошибку рендеринга UI (Ink получил всё, но Claude submitted с обрезанным `m.content` — это уже Claude bug, не наш). На fast-mode (Gemini не отправляет UserPromptSubmit hook).

## Что не сработало (попытки до single-write)

- **Per-chunk `waitForRender(2000ms)` instead of 1000ms** — увеличение timeout удвоило задержку до 2 минут, marker всё равно не приходил mid-paste.
- **Drain pause 50ms между чанками без waitForRender** — данные теряются, потому что нет sync. Ink читает буфер batch-ами, успевает скушать только часть до следующего write.
- **Sync marker эмулировать через bytewise echo grep** — Ink collapse'ит paste в `[Pasted text #N +M lines]`, оригинальный текст в PTY output не виден.

## Code map (неочевидное)

- `src/main/main.js::safePasteAndSubmit` — single-write для slow-mode.
- `src/main/main.js::pendingPasteAudit` — Map<tabId, {expectedLen, expectedHash, ...}>, заполняется перед Enter.
- `src/main/main.js::startClaudeHookServer::UserPromptSubmit branch` — consumer audit, читает `transcript_path`, walk-back JSONL, sha1 compare.
- `~/.claude/hooks/noted-turn-event.js` — уже forward'ит `transcript_path` в envelope, ничего не нужно менять.
- `src/main/main.js::clearBridgeForTab` — `pendingPasteAudit.delete(tabId)` на teardown таба.

## Связанные
- `fact-claude-tui-mechanics.md::Section 4` — single bracket pair правило (всё ещё актуально для fast-mode chunking).
- `fact-claude-tui-mechanics.md::Section 9` — alt-screen DEC ?2004 state loss (другой root cause N chips, не этот gap).
- `fix-paste-bracket-mode-loss.md` — три фактора потери bracketed paste mode (env, node-pty, single bracket pair).
- `fix-claude-paste-race.md` — concurrent safePasteAndSubmit race (тот же файл, но другой механизм — interleaved bytes из двух callers).
- `fact-prompt-queue.md::cold-start через store subscription` — почему очередь вообще fires автоматически после +grab.
- `methodology/design.md::Transparent passthrough` — почему manual Cmd+V не идёт через тот же helper.
