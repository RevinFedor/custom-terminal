# Fix: paste дробится на N `[Pasted text #N]` chips в Claude TUI

## Симптомы
Юзер делает Cmd+V (или paste из меню) куска текста 5-100 KB в Claude Code TUI внутри нашего терминала. Вместо одного chip `[Pasted text #1]` Claude показывает 5-60 отдельных chip'ов. Иногда часть содержимого «раскрывается» как обычный текст, ломая разметку. Иногда `\r` внутри paste'а интерпретируются как Enter и Claude submit'ит куски как отдельные prompt'ы. После рестарта Claude процесса в той же вкладке текст продолжает «дописываться» — куски всё ещё в kernel PTY queue.

Поведение **рандомно меняется между сессиями Claude на той же машине**: в одной сессии тот же paste работает как один chip, в другой разваливается. Раньше (до апреля 2026) работало стабильно.

## Root cause: три независимых фактора, активных одновременно

### 1. node-pty 1.0/1.1 silent data loss (PR #831, Tyriar, дек 2025)

`CustomWriteStream` в node-pty до 1.2.0-beta использовал `tty.WriteStream` для записи в master fd PTY. `tty.WriteStream` ставит fd в `O_NONBLOCK` и при переполнении kernel buffer **молча дропает** байты вместо честного `EAGAIN` с retry. На macOS PTY input buffer = ~1 KB (TTYHOG); при write больше — кусок текста просто исчезает. node-pty 1.2.0-beta.1+ использует `fs.write` напрямую с EAGAIN-loop через `setImmediate` — байты доходят все.

См. [microsoft/node-pty PR #831](https://github.com/microsoft/node-pty/pull/831) и [VS Code issue #283056](https://github.com/microsoft/vscode/issues/283056) — VS Code удалил свой throttling workaround после фикса.

### 2. Claude Code 2.1.110+ aggressive alternate screen

С версии 2.1.110 (16 апреля 2026) Claude Code включил fullscreen-renderer на alternate screen по умолчанию. При каждом переключении alt-screen (`\x1b[?1049h/l`) Claude **теряет** свой DEC private mode 2004 (bracketed paste). Без `\x1b[?2004h` xterm.js не оборачивает Cmd+V в `\x1b[200~...\x1b[201~` — текст уходит в PTY raw. Дальше его дробит TTYHOG → Ink в Claude получает byte stream несколькими пачками между render cycle → каждая пачка становится отдельным `[Pasted text #N]`.

Обходной флаг — env `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (добавлен в Claude 2.1.132, май 2026). Возвращает Claude к scrollback-renderer'у, alt-screen toggle перестаёт случаться, DEC ?2004 не теряется.

### 3. Concurrent `safePasteAndSubmit` на одном PTY (см. также fix-claude-paste-race.md)

Если параллельно идёт ручной paste и программный (queue runner, MCP-continue, Compact кнопка), их `term.write` интерлевятся. См. `fix-claude-paste-race.md` — отдельный root cause со своим фиксом (WeakMap mutex по term).

## Что не сработало (отброшенные подходы из этой сессии)

- **Routing manual Cmd+V через `safePasteAndSubmit`** в `ipcMain.on('terminal:input')` — попытка обернуть длинный paste в наш chunking helper с brackets. Юзер сразу отверг: *«нет, чанкинг не надо, мне нужен ровно один paste как в iTerm2»*. Откатили на `term.write(data)` pass-through.
- **Pre-block grab/Compact кнопок на эвристике `claudeSpinnerBusy`** — теряли команды без следа. Заменили на runtime-mutex + paste-busy broadcast (`fix-claude-paste-race.md`).
- **Ручное оборачивание manual paste в `\x1b[200~` если xterm.js не обернул** — это работа xterm.js, делать на нашей стороне = маскировать root cause (Claude забыл `\x1b[?2004h`). Не делали.

## Фикс — три слоя одновременно

### 1. PTY env: `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`

В `terminal:create` shellEnv для каждой PTY. Применяется к **всем** табам (Claude / shell / gemini) — для не-Claude процессов env-переменная игнорируется. Эффект только для Claude 2.1.132+.

### 2. node-pty bump: 1.1.0 → 1.2.0-beta.13

`npm install node-pty@1.2.0-beta.13` + `npx electron-rebuild -f -w node-pty --only node-pty` (полный rebuild без `--only` падает на других native-модулях, см. `fix-electron-native-rebuild-trap.md`).

### 3. Manual paste — pass-through без обёрток

`ipcMain.on('terminal:input', ...)` для длинного paste делает только `term.write(data)`, как iTerm2. Никаких bracketed-paste обёрток на нашей стороне, никакого chunking — это работа Claude TUI на основе своего DEC ?2004 state. См. `methodology/переносимый-дизайн.md::Transparent passthrough`.

## Диагностика следующего рецидива: `[PasteDiag]`

При входящем paste >1000 байт пишутся две строки лога:

- **Renderer** (`Terminal.tsx` `term.onData`): `[PasteDiag:renderer] tab=... len=N bracketedPasteMode=true/false startsWith200=... endsWith201=... head=... tail=...`. Главное поле — `bracketedPasteMode`, читается из internal `(term as any)._core?.coreService?.decPrivateModes?.bracketedPasteMode`.
- **Main** (`terminal:input` handler): `[PasteDiag] tab=... len=N startsWith200=... endsWith201=... embed200=N embed201=N cr=N lf=N head=[...] tail=[...]`.

Чтение результата:
- `bracketedPasteMode=false` → root cause = Claude не выслал `\x1b[?2004h`. Проверь что Claude версии ≥2.1.132 И env `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` дошёл до PTY.
- `bracketedPasteMode=true` + `startsWith200=true` + `endsWith201=true` + chips всё равно N → root cause = node-pty data loss. Проверь версию `node_modules/node-pty/package.json`, должна быть ≥1.2.0-beta.x.
- `embed200>1` или `embed201>1` → внутри paste есть посторонние brackets — кто-то paste'ил содержимое **другого** bracketed-paste дампа (например, transcript уже содержит маркеры). Это нормально, Claude умеет вложенность.
- `cr>0` без brackets и без alt-screen фикса → `\r` внутри текста submit'ятся как Enter. Не баг, природа raw passthrough.

## Code map (неочевидное)

- `src/main/main.js::ipcMain.handle('terminal:create')` — shellEnv (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `NOTED_PARENT_PROJECT_ID`, `NOTED_MAIN_PID`).
- `src/main/main.js::ipcMain.on('terminal:input')` — manual paste pass-through + `[PasteDiag]` лог.
- `src/renderer/components/Workspace/Terminal.tsx::term.onData` — `[PasteDiag:renderer]` лог + internal `bracketedPasteMode` read.
- `node_modules/node-pty/lib/unixTerminal.js::CustomWriteStream::write` — fs.write с EAGAIN retry (PR #831).

## Связанные
- `fix-claude-paste-race.md` — concurrent `safePasteAndSubmit` race (другой root cause, тот же домен).
- `fact-claude-tui-mechanics.md::Section 4` — Atomic Bracketed Paste, single bracket pair правило.
- `fact-claude-tui-mechanics.md::Section 9` — Alt-screen ⇄ DEC ?2004 state loss.
- `fix-electron-native-rebuild-trap.md` — как делать `electron-rebuild` для отдельного модуля без падения на других native deps.
- `methodology/переносимый-дизайн.md::Transparent passthrough` — почему pass-through победил rerouting.
