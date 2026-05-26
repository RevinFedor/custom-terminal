# Fix: Anti-arrow-mash guard на terminal:input

### Симптомы
- Однократная вспышка corruption в JSONL: одна строка ~2000+ байт, состоящая из повторов `\x1b[D` (или `\x1b[A/B/C`).
- Claude TUI крашится посреди turn'а на «странном» вводе.
- Tab переходит в DangerZone (`Press Ctrl-C again to exit`) без действий пользователя.
- В рендерер-логах `[PasteDiag:renderer] bracketedPasteMode=true startsWith200=false` для входа 1500+ байт где tail и head — одни и те же 3 байта escape sequence.

---

## 1. Incident 2026-05-21 15:09:13

Из renderer'а xterm.js пришло 2265 байт чистых `\x1b[D` (стрелка влево × 755 повторов). `bracketedPasteMode=true`, но **без обёртки** `\x1b[200~/\x1b[201~` — значит xterm не считал это paste-event'ом, а **keyboard input**. ~9 секунд непрерывного удержания клавиши Left при default macOS keyrepeat.

Источник: предположительно залипшая физическая клавиша, AppleScript-helper, или accessibility-feature. **Не наш код** — в нашем codebase нет `.repeat()` строки из escape-кодов. xterm.js собрал ввод как keystrokes и отдал в `term.onData` callback.

Этот блок попал в PTY как обычный input → Claude TUI обработал как 755 нажатий стрелки → курсор ушёл далеко влево от начала prompt → следующие записи в JSONL получили битый context → orphan parentUuid.

---

## 2. Guard в `terminal:input` IPC handler (main.js)

```js
if (data.length >= 200 && /^(\x1b\[[ABCD])\1{60,}$/.test(data)) {
  const arrow = data.substring(0, 3);
  const count = Math.floor(data.length / 3);
  console.error('[terminal:input] BLOCKED arrow-mash: tab=... count=N arrow=LEFT/RIGHT/UP/DOWN ...');
  mainWindow.webContents.send('arrow-mash:blocked', { count, arrowName });
  return;
}
```

Условия срабатывания **И** (все три обязательны):
1. Длина блока **≥ 200 байт**.
2. Regex `^(\x1b\[[ABCD])\1{60,}$` — uniform run **одной** arrow-последовательности, повторённой 60+ раз, без любых других байтов.
3. Никаких печатных символов в блоке.

При срабатывании → drop с forensic-log в production.log + IPC `arrow-mash:blocked` в renderer → toast «Заблокирован поток из N стрелок LEFT/RIGHT/UP/DOWN от клавиатуры — возможно залипла клавиша».

---

## 3. Почему пороги выбраны так

**200 байт минимум** — отсекает любые случаи короткого удержания клавиши (~30 повторов в практике = 90 байт). 200 = `66 * 3 + 2` — комфортно покрывает «нормальные» Hold-навигации не задевая.

**60 повторов одной escape** — реальный paste **никогда** не содержит uniform escape-runs (там печатные символы перемешаны с CR/LF). 60 = ~2 секунды зажатой клавиши, что уже подозрительно для целенаправленной навигации.

**Один тип стрелки в run'е** (regex backreference `\1`) — отсекает шум из real Ink-меню (`A,B,A,B` для Up/Down nav). Только когда мы видим **750 × LEFT подряд** без вкраплений — это аномалия.

---

## 4. Что guard НЕ ловит

- Mixed escape-mash (`\x1b[A\x1b[B\x1b[A\x1b[B` × 100) — потенциально баг scroll-helper'а, но не наблюдался.
- Короткий burst 30-60 повторов — пропускает, потому что в реальной TUI-навигации Hold-arrow-key даёт ~30-50 events до того как юзер отпустит.
- Real paste с встроенными escape-кодами — пропускает (regex требует start-to-end uniform).

При появлении новых форм mash в production — расширять регexp или вводить второй фильтр.

---

## 5. Связанные правила

- [`methodology/переносимый-дизайн.md::Anti-mash guard на любой repeating input`](../methodology/переносимый-дизайн.md) — переносимый принцип защиты boundary IPC.
- [`fact-terminal-core.md::Paste passthrough`](fact-terminal-core.md) — нормальные paste через bracketed-paste mode, для контраста с patterns которые блокирует guard.

### Forensic
```bash
grep "BLOCKED arrow-mash" ~/Library/Logs/noted-terminal/production.log
```
