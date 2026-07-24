# Terminal Core & Shell Integration

---

## Fact: Reactive CWD Tracking (OSC 7)

## Problem
Отслеживание текущей рабочей директории (CWD) в терминале через системные вызовы (`lsof`, `pgrep`, `ps`) является тяжелой и ненадежной операцией. Она вызывает задержки (Event Loop lag) и может возвращать неактуальные данные из-за асинхронности процессов.

## Решение: Shell Integration (OSC 7)
Вместо того чтобы "спрашивать" ОС о пути, терминал настраивается так, чтобы оболочка (Shell) сама сообщала о смене директории через специальные escape-последовательности (OSC 7).

### 1. Механизм внедрения
При старте приложения в директории `~/Library/Application Support/custom-terminal/` создается папка `shell-integration/`, содержащая файлы `.zshrc` и `.bashrc`.

### 2. Zsh (ZDOTDIR)
Для Zsh используется переменная окружения `ZDOTDIR`. 
1. Наш `.zshrc` загружает оригинальный конфиг пользователя (`source ~/.zshrc`).
2. Добавляет функцию в `chpwd_functions`, которая отправляет OSC 7 при каждом `cd`.
3. Код последовательности: `\e]7;file://localhost$PWD\a`.

### 3. Bash (BASH_ENV)
Для Bash используется `BASH_ENV`, который подгружает наш скрипт инициализации с аналогичным хуком на `PROMPT_COMMAND`.

### 4. Обработка в xterm.js
Терминал слушает последовательности OSC 7:
```typescript
term.onLineFeed(() => {
  // xterm.js автоматически парсит OSC 7 и обновляет внутреннее свойство, 
  // если подключен соответствующий парсер или аддон.
});
```
В нашем случае Renderer парсит OSC 7 только как **кандидат** и передаёт его в main через `terminal:updateCwd`, не меняя `tab.cwd` заранее. Поток PTY не является доказательством состояния файловой системы: TUI или повреждённый/обрезанный escape-фрагмент может выглядеть как валидный OSC 7. Main принимает кандидат только для живого PTY, проверяет существование директории и сравнивает её canonical path (`realpath`) с cwd живого shell-процесса этого PTY. Это сохраняет корректность на macOS, где один путь может выглядеть как `/tmp/...`, а наблюдаться как `/private/tmp/...`.

Только положительный proof обновляет `terminalProjects`. До ACK main точечно записывает подтверждённый cwd в строку вкладки SQLite, закрывая окно «процесс уже доказал новый путь, но renderer упал до общего saveTabs»; Renderer затем меняет `tab.cwd`, дожидается обычного store-save и тем самым синхронизирует полный workspace. Если точечная запись не нашла ещё не сохранённую новую вкладку, renderer-save остаётся fallback и обе стороны логируют потерю durability. `missing`, mismatch и неизвестный результат process lookup не очищают и не заменяют последний подтверждённый cwd; лог `[TerminalCwdProof]` сохраняет кандидат, наблюдавшийся путь, `persisted` и причину отказа. Пользовательский симптом нарушения этого контракта: в БД попадал обрезанный `/Users/fedor/Desktop/custom-`, а восстановление затем заявляло, что сохранённой папки нет, хотя настоящий проект `/Users/fedor/Desktop/custom-terminal` существовал.

Подтверждённая копия cwd нужна не только UI/persistence, но и фоновым main-сценариям — CwdGuard сравнивает bridge cwd с `terminalProjects`, а запуск последней shell-команды ищет persisted command по точному cwd.

## Преимущества
- **Реактивность:** Проверка запускается по событию OSC 7, без постоянного polling; на серию кандидатов оставляется последний, чтобы шумный TUI не создавал очередь IPC.
- **Производительность:** Один live-proof на фактический переход cwd вместо периодического обхода дерева процессов.
- **Надёжность:** Вывод терминала сообщает намерение, а cwd живого процесса подтверждает факт; `unknown` не трактуется как отсутствие.
- **Persistence:** Подтверждённый путь точечно пишется до ACK и повторно сходится через renderer workspace-save; последний хороший cwd сохраняется при сомнительном сигнале.

---

## ФАКТ: Shell Integration (OSC 133)

## Суть
Протокол OSC 133 — это стандарт (популяризированный VS Code), позволяющий терминалу "общаться" с эмулятором через невидимые управляющие последовательности. Это позволяет эмулятору точно знать, когда команда началась, когда она выполняется и с каким кодом завершилась.

## Спецификация последовательностей
Используются коды `\x1b]133;[Type][;Params]\x07` (или `\033` вместо `\x1b` и `\007` вместо `\x07` в octal представлении).

| Код | Значение | Когда отправляется |
|-----|----------|-------------------|
| `A` | Prompt Start | Когда шелл готов к вводу и отрисовал промпт. |
| `B` | Command Start | Сразу после нажатия Enter, перед началом выполнения. |
| `C` | Command Executed | Когда команда начала выдавать результат. |
| `D;[ExitCode]` | Command Finished | Когда процесс завершился (содержит код возврата). |

## Реализация в проекте
При создании PTY в шелл (zsh/bash) "впрыскивается" скрипт инициализации, который вешает хуки на `preexec` и `precmd`.

### Zsh пример:
```bash
__custom_preexec() {
  printf "\033]133;B\007"
}
__custom_precmd() {
  printf "\033]133;D;%s\007" "$?"
  printf "\033]133;A\007"
}
add-zsh-hook preexec __custom_preexec
add-zsh-hook precmd __custom_precmd
```

## Почему это важно
Это избавляет от необходимости использовать **Polling (pgrep)**. Мы получаем события мгновенно, что критично для плавного переключения UI элементов (например, Timeline истории Claude).

## Безопасный запуск AI из idle shell

Состояние `inactive` доказывает только, что Claude/Codex сейчас не управляет PTY; оно не означает, что строка shell пуста. Пользователь мог набрать `git ...` без Enter, а затем нажать Start/Resume: простая допись `claude`/`codex` склеит две команды. Поэтому все программные fresh/resume/fork-запуски Claude и Codex сходятся в одной main-side границе, которая заново проверяет поколение PTY, отсутствие уже заявленного lifecycle/foreground-команды и делает свежий обход дерева процессов. Только доказанное `absent` разрешает очистку; `found` и `unknown` блокируют запуск без записи в PTY.

После proof отмена shell-черновика и команда запуска пишутся в одной упорядоченной операции: `Ctrl+C + command + Enter`. Одновременно очищается внутренний tracker строки, иначе следующий preflight увидит уже отменённый текст. Claude публикует `starting` только после успешной записи. Codex обязан вооружить watcher до записи, чтобы не потерять самые ранние события; поэтому любой отказ того же поколения симметрично снимает startup auto-enter/watchdog, возвращает command-state в inactive и посылает парный `command-finished`. Иначе loader останется от launch, который main отклонил.

Принятие запуска является границей транзакции и для соседнего состояния. Restore-action удаляется только после `accepted`; при отказе interrupted-overlay и одноразовое действие сохраняются. Claude Fork готовит копию JSONL до последнего proof, но при отказе/ошибке записи удаляет её, а fork marker и Timeline metadata коммитит только после принятых launch-байтов. Внешний API также сохраняет тип AI-вкладки только после принятия, чтобы отказ не создавал ложную постоянную привязку.

Этот контракт относится только к границе запуска нового AI-процесса. Обычный Send, управление моделью, Rewind и Stop работают внутри живого TUI; безусловный `Ctrl+C` там уничтожит draft, прервёт turn или выйдет из агента. Диагностический маркер успешного пути — `[AgentShellLaunch] clear-and-write` с числом замеченных символов; blocked launch обязан обходиться без такого маркера.

---

## Fact: Terminal Registry & Selection Sync

Глобальный механизм синхронизации состояния терминалов `xterm.js` с UI-компонентами React.

## 1. Реестр инстансов (terminalRegistry)
Поскольку инстансы `xterm.js` создаются внутри хуков и не хранятся в React-стейтах (для производительности), создан прямой реестр.
- **Файл:** `src/renderer/utils/terminalRegistry.ts`
- **Функция:** Позволяет любому компоненту (например, NotesPanel или App) получить доступ к объекту терминала по его `tabId`.
- **Методы:** `register`, `unregister`, `getSelection(tabId)`.

## UUID Colorization & OSC Protection
В Main-процессе реализован механизм автоматической подсветки UUID фиолетовым цветом.
- **Invisible Intent:** Колоризация использует посимвольный парсинг для обнаружения и пропуска **OSC-последовательностей** (например, OSC 8 гиперссылок от Claude Code). Вставка ANSI-кодов внутрь OSC ломает парсинг в xterm.js, из-за чего скрытые URL становятся видимыми.
- **Подробнее:** См. [`fix-claude-visual-glitches.md`](fix-claude-visual-glitches.md).

## Terminal links: xterm linkHandler + WebLinksAddon

HTTP(S)-ссылки в терминале должны открываться одним кликом без browser-style confirm. Живой симптом: клик по `https://x.com/...` показывал xterm-диалог `WARNING: This link could potentially be dangerous`, а после `OK` ничего не открывалось в системном Яндекс.Браузере. Это не политика приложения, а default behavior xterm.js core link provider'а: если не задать `linkHandler`, xterm сам показывает blocking confirm для ссылок, особенно для OSC 8 / link-provider путей.

`WebLinksAddon` сам по себе недостаточен. Он ловит plain-text URL detection, но не является единственным источником links в xterm: OSC 8 hyperlinks и internal link providers идут через core `linkHandler`. Поэтому оба `new XTerminal(...)` пути в `Terminal.tsx` (normal init и lazy reattach) обязаны передавать `linkHandler.activate`, а `WebLinksAddon` должен звать тот же shared handler. Иначе один lifecycle terminal'а работает правильно, второй возвращает default confirm.

Контракт активации: handler всегда делает `preventDefault()` + `stopPropagation()`. Для `http://`/`https://` сначала вызывается контекстный `onLinkClick` (BrowserTab открывает URL во встроенном webview и переключает view), иначе `shell.openExternal(uri)` передаёт ссылку OS default browser. `allowNonHttpProtocols:false` оставляет нестандартные протоколы неактивными на уровне xterm; локальные file-like пути (`/Users/...`, `./...`, `../...`) идут отдельным preview-path и не должны случайно стать external navigation. UX-принцип — `methodology/переносимый-дизайн.md::Недеструктивная внешняя навигация выполняется сразу`.

## 2. Синхронизация выделения (terminalSelection)
Для того чтобы кнопки "Research Selection" могли мгновенно реагировать на наличие выделенного текста (становиться активными), используется гибридный подход:
1.  **Событие `onSelectionChange`:** Терминал слушает изменения выделения.
2.  **Global State:** При изменении терминал записывает текст в `useUIStore.terminalSelection`.
3.  **Context Menu:** При правом клике терминал принудительно обновляет глобальный стейт, чтобы контекстное меню гарантированно видело актуальный текст.

## 3. Очистка состояния
При деактивации терминала (переключение вкладок или проектов) глобальный стейт `terminalSelection` принудительно очищается, чтобы избежать "фантомных" поисков по тексту из другого окна.

---

## Опыт: Переполнение буфера ввода TTY (PTY Buffer Overflow)

## Проблема
При попытке вставить большой объем текста (например, промпт на 7KB или 200+ строк) напрямую в PTY через `term.write()`, текст обрывается или повреждается. Gemini или другие CLI получают только часть данных.

## Причина: Kernel PTY Buffering
**PIPE_BUF гарантирует атомарность только для пайпов и FIFO.** Для PTY-устройств действуют иные ограничения буферизации в слое TTY line discipline:

1. **macOS (TTYHOG):** Критический лимит равен **1024 байтам** (raw input queue size в `bsd/sys/tty.h`). Ядро физически не может удержать `term.write()` больше 1024 байт за раз. Данные гарантированно режутся на куски, и точки разрыва непредсказуемы. Это может разорвать escape-последовательность bracketed paste (например, `\x1b[20` в одном `read()`, `1~` в другом), что Ink TUI не умеет обрабатывать.
2. **Linux (N_TTY_BUF_SIZE):** Лимит обычно равен **4096 байтам**. На Linux вероятность разрыва меньше, но атомарность всё равно не гарантируется (возможны "short reads").

## Двухуровневая система вставки (Two-Tier Paste)

В проекте реализованы два разных механизма вставки данных в PTY, каждый для своего сценария:

| | User Paste (Ctrl+V) | Programmatic Paste |
|---|---|---|
| **Путь данных** | Пользователь → xterm.js → `terminal:input` IPC → `term.write()` | Наш код → `safePasteAndSubmit()` → `term.write()` напрямую |
| **xterm.js в цепи** | Да (сам добавляет brackets) | Нет |
| **Кто шлёт Enter** | Человек (через секунды) | Код (через миллисекунды) |
| **React Batching Race** | Нет (человек медленный) | Да (код быстрый) |
| **Нужен sync marker** | Нет | Да |
| **Где применяется** | Любой терминал (bash, Claude, Gemini) | Handshake, send-command, Rewind |

---

### Tier 1: Simple TTYHOG-Safe Chunking (User Paste)

Обработчик IPC `terminal:input` для вставок > 1024 байт.

**Проблема (была до фикса):** `terminal:input` прогонял ВСЕ вставки через `safePasteAndSubmit`. Это вызывало:
1. **В обычных терминалах (bash/zsh):** Ожидание sync markers, которые bash не шлёт → 5-секундный таймаут на каждый чанк → вставка 5KB = 30 секунд.
2. **В Claude TUI:** xterm.js уже обернул текст в brackets + `safePasteAndSubmit` добавила ВТОРОЙ слой brackets → двойное обрамление → сломанный ввод.

**Решение:** Простой chunking без sync markers:
1. **Детекция brackets:** Если `data` содержит `\x1b[200~` — xterm.js добавил brackets (приложение в терминале запросило bracketed paste mode).
2. **Strip:** Убрать существующие brackets.
3. **Chunk:** Разбить текст на куски по 900 байт.
4. **Re-wrap:** Каждый кусок обернуть в ПОЛНЫЕ brackets `\x1b[200~...\x1b[201~` (если оригинал содержал brackets). Для обычных терминалов — отправить raw.
5. **Delay:** 10ms между чанками (дать ядру очистить буфер).
6. **Enter:** Отдельно, с задержкой 50ms (brackets) / 10ms (raw).

```javascript
// terminal:input — simple chunking for user paste
if (data.length > 1024) {
  const hasBrackets = data.includes('\x1b[200~');
  let content = data;
  if (hasBrackets) {
    content = content.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
  }
  // ... chunk + re-wrap + small delays
}
```

**Почему sync markers не нужны:** Enter всегда приходит как отдельное событие от пользователя (отдельный keystroke). К моменту нажатия Enter React гарантированно обработал вставку. Race condition невозможен.

---

### Tier 2: safePasteAndSubmit (Programmatic Paste)

Функция для программных операций, где код отправляет текст И Enter автоматически.

### Проблема с предыдущим подходом (writeToPtySafe)
Старая функция `writeToPtySafe` разбивала ВЕСЬ payload (включая escape-последовательности `\x1b[200~` и `\x1b[201~`) на чанки по 1KB. Это ломало bracketed paste — Ink TUI получал фрагментированные escape sequences и не мог их собрать.

### Алгоритм `safePasteAndSubmit(term, content, options)`:
1. **Chunking:** `fast=true` цели (Gemini/bash) режутся на UTF-8-safe чанки до 900 байт и пишутся back-to-back внутри одной logical bracketed paste. `fast=false` TUI-safe цели (Claude Ink, Codex AI Rewind) пишут весь payload одним `term.write()` и одной парой `\x1b[200~...\x1b[201~`. Не возвращать per-chunk bracket pairs: Ink/Codex увидят несколько отдельных paste-событий или submit успеет прочитать только хвост.
2. **Sync Marker Verification:** В обычном `fast=false` после закрывающего bracket функция слушает PTY output и ждёт sync marker `\x1b[?2026l` (конец render frame). Это подтверждает что TUI обработал paste и закоммитил новый кадр composer'а. Это **не** product-level событие «Codex принял вставку» и **не** text echo: Ink/Codex могут коллапсировать вставки в `[Pasted text #N +M lines]` / `[Pasted Content N chars]`, поэтому полный текст не обязан появиться в выводе.
   - **Stale Marker Protection:** Введена фильтрация маркеров, приходящих < 3мс после записи. Это предотвращает ложные срабатывания от предыдущих циклов рендеринга (спиннеры, статус-бары). См. `knowledge/fix-stale-sync-markers.md`.
3. **Submit:** `\r` отправляется ТОЛЬКО после подтверждения последнего чанка — гарантия что `onSubmit(value)` прочитает уже зафиксированный в стейте текст.

Если sync marker не пришёл до safety timeout, programmatic paste по умолчанию обязан вернуть failure до Enter. Это не retry/fallback состояние: без render ACK неизвестно, попал ли text в composer, и submit может отправить пустой, хвостовой или чужой input.

Codex external submit — сознательное исключение из этого правила. У Codex CLI нет детерминированного pre-Enter ACK: hidden renderer может не проснуться, PTY render marker может быть stale или не прийти, а текст уже принят composer'ом. Поэтому Codex send paths пропускают post-paste render wait (`skipRenderWait:true`), пишут paste+Enter в один упорядоченный PTY-поток и доказывают доставку только после Enter через rollout `user_message` audit. До paste остаётся отдельный guard от перетирания чужого draft.

```javascript
await safePasteAndSubmit(term, content, {
  submit: true,         // отправить \r после всех чанков
  ctrlCFirst: false,    // Ctrl+C перед paste (для очистки инпута)
  logPrefix: '[tag]',   // для логов
  safetyTimeoutMs: 8000 // fallback timeout (не основной механизм)
});
```

**Почему sync markers критичны именно здесь:** для Ink/Claude код отправляет текст и `\r` с минимальным разрывом; без sync marker verification React может не успеть закоммитить state, и `onSubmit` увидит пустую строку. Для Codex эта проверка не считается авторитетной, поэтому переносится на post-Enter rollout audit.

### Ключевые свойства
- **Event-driven:** Никаких фиксированных таймаутов. Sync marker = факт render, не предположение.
- **Любая длина:** fast-path чанкуется по байтам без разрыва UTF-8 code point; TUI-safe path держит один logical paste. Render ACK обязателен для обычного slow path, но Codex external submit подтверждается rollout audit'ом.
- **Только для программных операций:** Handshake, send-command, Rewind (Restore:History). **НЕ** для `terminal:input`.
- **Safety timeout:** 8s — это не "подождать", а "что-то фатально сломалось, abort".

### Main-side headless xterm mirror для фонового proof

Main process держит lightweight `@xterm/headless` mirror на tab, который получает тот же PTY stream, что и renderer. Это не новый UI renderer и не замена Canvas: mirror нужен для proof-операций, которые могут идти из фоновой вкладки или API без mounted React terminal. Общие запросы visible snapshot и Codex draft-state сначала читают headless mirror, а renderer `terminalRegistry` остаётся fallback/debug каналом.

Критичная граница: если action должен работать из History, mobile/iOS, Inbox или stopped-session Rewind, он не имеет права требовать mounted renderer xterm. Иначе баг выглядит как «сработало только после клика по вкладке» или как пропущенный draft guard. Mirror должен получать данные синхронно в PTY output path, resize'иться вместе с PTY и очищаться на exit/kill; `await` внутри high-frequency `onData` всё ещё запрещён.

### Bracketed Paste Mode
Данные оборачиваются в escape-последовательности:
- Начало: `\x1b[200~`
- Конец: `\x1b[201~`

**Важно:** `\r` для submit отправляется **после** закрывающего тега И подтверждения sync marker.

## Код
Реализовано в `src/main/main.js`: функции `safePasteAndSubmit()`, `waitForRender()`. Применяется для Handshake, `claude:send-command`, Codex external submit (`codex:send-command`, `codex:append-input`, MCP `/terminal/ai-prompt`) и Rewind (`claude:open-history-menu`). User paste (Ctrl+V) обрабатывается отдельным simple chunking в `terminal:input`.

---

## Fact: PTY Middleware & OSC 7777 (Deterministic Boundaries)

Для обеспечения 100% точности навигации в Claude Code (Timeline), приложение использует архитектуру **PTY Middleware**. 

### Проблема Heuristic-поиска
Ранее поиск границ сообщений выполнялся асинхронно через `SearchAddon` в уже отрендеренном буфере. Это приводило к "промахам", если буфер быстро рос или текст сообщения повторялся.

### Решение: In-stream Injection
В Main-процессе реализована Middleware-прослойка между `node-pty` и IPC-каналом.
1. **State Machine:** Система отслеживает переходы `IDLE → BUSY → IDLE`. 
2. **Injection:** Когда детектируется возврат промпта (`⏵` / `❯`) после фазы BUSY, в поток данных ПЕРЕД текстом промпта впрыскивается невидимая последовательность `\x1b]7777;prompt:<seq>\x07`.
3. **Escape Carryover:** Middleware автоматически буферизует неполные escape-последовательности в конце чанков (PTY chunking), чтобы инъекция маркера не "разрезала" CSI-код и не приводила к визуальному мусору. См. `knowledge/fix-osc7777-escape-carryover.md`.
4. **Synchronous Registration:** Парсер xterm.js (Renderer) встречает этот OSC-код синхронно во время обработки чанка и мгновенно вызывает `registerMarker(0)`.

### Преимущества
- **Точность:** Маркер ставится на ту самую строку, где появился промпт, еще до того как React-компоненты узнают о завершении команды.
- **Timeline Integration:** Timeline использует эти маркеры для детерминированного определения позиций сообщений Claude. 
- **First Entry Logic:** Первый entry в сессии (набранный до появления первого промпта с OSC-маркером) принудительно получает позицию 0, чтобы его диапазон видимости покрывал начало буфера.
- **Persistence:** Маркеры xterm.js автоматически обновляют свой индекс `.line` при росте скроллбека, что делает скролл к ним атомарной операцией $O(1)$.

### Lifetime `prompt:<seq>`

`prompt:<seq>` монотонен на жизнь xterm buffer/tab, а не на жизнь Claude process. При `clearBridgeTab` нельзя сбрасывать `promptBoundarySeq`: renderer хранит уже зарегистрированные xterm markers, и новый `prompt:1` после restart выглядит как duplicate/stale marker. Симптом: stopped-session Rewind запускает Claude, `/model`/`/effort` визуально проходят, но gate ждёт boundary до timeout и `/rewind` не стартует.

Prompt detector должен считать prompt glyph не только `⏵`/`❯`, но и `›`/`╰` — Claude TUI может менять видимый символ между версиями/темами. Для служебных slash-команд, которые не дают spinner-phase (`/model`, `/effort`), caller обязан перед submit взвести boundary state в `busy`; иначе state machine не увидит BUSY→IDLE и marker не появится.

SerializeAddon сохраняет клетки экрана, но не сам невидимый OSC 7777 event и не identity созданного xterm marker. Поэтому cold renderer получает prompt boundaries отдельным sidecar с точными строками того же generation/sequence snapshot и регистрирует их после восстановления экрана. Маркеры, пришедшие в более новом same-generation live-tail, проходят обычный OSC handler; смешивать sidecar прошлого PTY с новым поколением запрещено. Иначе терминал визуально выглядит правильным, но Timeline-клики молча теряют навигацию.

---

## Fix: Terminal Colors and Input (Truecolor & UTF-8)

## 🛠 ОПЫТ: "Почему в AI CLI тусклые цвета и странный ввод?"

### Проблема
При использовании Ink-based CLI (Gemini CLI, Claude Code) в кастомном терминале наблюдались две проблемы:
1. **Цвета:** Текст выглядел тусклым и ненасыщенным (fallback на 256 цветов вместо 24-bit Truecolor).
2. **Ввод (UTF-8):** При вводе кириллицы или использовании некоторых escape-последовательностей в терминале появлялись "битые" символы (Unicode-артефакты).

### Причина
Источник истины находился во **внешних ограничениях окружения PTY**. По умолчанию `node-pty` не передает полную конфигурацию переменных окружения, необходимую современным CLI для активации расширенных режимов.

1. **COLORTERM:** CLI проверяют эту переменную. Если она не равна `truecolor`, они переходят в режим совместимости.
2. **LANG/LC_ALL:** Без явного указания UTF-8 локали, терминал может некорректно интерпретировать многобайтовые символы (кириллицу).
3. **Inherited no-color flags:** dev Electron часто запускается из Claude/Codex tab, а родительский agent может держать `NO_COLOR=1` или `FORCE_COLOR=0`. Если без фильтра передать `...process.env` в PTY, Claude/Codex CLI честно отключают ANSI-цвета, даже при `COLORTERM=truecolor`. Симптом для пользователя — Claude/Codex TUI становится почти чёрно-белым, пропадает оранжевый/акцентный статус.

### Решение
В файле `src/main/main.js` при создании PTY-процесса принудительно задаются цвет/locale переменные и вычищаются родительские запреты цвета:

```javascript
const shellEnv = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',        // Включает яркие 24-bit цвета
  CLICOLOR: '1',
  LANG: process.env.LANG || 'en_US.UTF-8',
  LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' // Обеспечивает корректный ввод UTF-8
};
delete shellEnv.NO_COLOR;
if (shellEnv.FORCE_COLOR === '0') delete shellEnv.FORCE_COLOR;

const ptyProcess = pty.spawn(shell, [], {
  // ...
  env: shellEnv
});
```

Граница важна: `NO_COLOR` полезен внутри самой AI-сессии, но пользовательский PTY в Noted Terminal должен вести себя как нормальный терминал. Запрет цвета из управляющего процесса не является настройкой будущих вкладок.

### Дополнительно: Кэширование (Production)
Для стабильности отображения изменений после сборки (Production build) в главный процесс добавлен флаг:
`app.commandLine.appendSwitch('disable-http-cache');`
Это гарантирует, что Electron не будет использовать устаревшие ресурсы из внутреннего кэша.

---

## Resizing: Управление размером и активностью
Управление размером терминала осуществляется через `ResizeObserver`. Для стабильности и предотвращения лишних вычислений используются следующие механизмы:

1.  **Ref-защита от Stale Closure:** Колбэк `ResizeObserver` использует `activeRef.current`, который синхронизируется с состоянием активности терминала.
2.  **effectiveActive Logic:** Терминал реагирует на ресайз и вызывает `safeFit()` только когда он действительно виден пользователю (`effectiveActive`). Это исключает «прыжки» и ошибки FitAddon, когда контейнер имеет нулевой размер или скрыт за Dashboard/Home.
3.  **Delayed Fit:** При активации терминала (`visibility: hidden` -> `inherit`), вызов `safeFit` оборачивается в `requestAnimationFrame`. Это дает браузеру время отрисовать контейнер и гарантирует, что `getBoundingClientRect()` вернет актуальные размеры для xterm.js.
4.  **Pinned Timeline settle:** `ResizeObserver` делает обычный `fit()` во время изменения ширины, но не обязан возвращать scrollback вниз. Когда закреплённый Timeline завершает width-transition, он отправляет `timeline:pinned-layout-settled`; активный Terminal повторяет `safeFit()` через два кадра и вызывает `scrollToBottom()`, чтобы после reflow пользователь оставался у нижнего prompt'а.

```typescript
const activeRef = useRef(effectiveActive);
useEffect(() => { activeRef.current = effectiveActive; }, [effectiveActive]);

// Внутри ResizeObserver
if (activeRef.current) {
  safeFit();
}
```

## Урок для проекта
Никогда не вызывайте методы подстройки размера (`fit()`) или фокуса (`focus()`) у терминала, если его контейнер скрыт или имеет `visibility: hidden`. Это может привести к некорректным расчетам ширины символов в xterm.js.

---

## Fix: Process Status Polling → OSC 133 Event-Driven

## Problem
Noted Terminal was causing extreme CPU load on `sysmond` (334% CPU) due to constant polling for process status.

### Симптомы
Вентиляторы компьютера начинают сильно шуметь (высокая нагрузка на CPU), а индикаторы активности на вкладках терминала (зеленые точки запущенных процессов) обновляются с заметной задержкой или "залипают".

### Диагностика (как обнаружили)
При работе с несколькими терминалами Activity Monitor показывал `sysmond` на 334% CPU. Диагностика через `sample`:

```bash
sudo sample sysmond 10 -file /tmp/sysmond_dump.txt
```

Анализ показал главные "горячие" функции:
```
4486 samples: _xpc_connection_call_event_handler (XPC запросы)
2053 samples: sysctl (информация о процессах)
211 samples: responsibility_get_uniqueid_responsible_for_pid
204 samples: proc_pidinfo
```

Это означало что кто-то постоянно бомбит sysmond запросами "дай статус процессов".

### Root Cause
Three components were polling `terminal:hasRunningProcess` every 2 seconds:
- `TabBar.tsx` - to show green dot indicator on tabs
- `Dashboard.tsx` - to show process status on project cards
- Each call executed `pgrep -P ${pid}` + `ps -p ${childPid}` via shell

With 6 terminals open:
- 12+ system calls per second
- Each syscall → sysmond XPC request → sysctl
- Result: sysmond overloaded

## Solution
Replace polling with **OSC 133 Shell Integration** (already implemented in main.js).

### How OSC 133 Works
Shell sends escape codes when commands start/finish:
```
\x1b]133;B\x07  → Command started (user pressed Enter)
\x1b]133;D;0\x07 → Command finished with exit code 0
```

Main process parses these and:
1. Stores state in `terminalCommandState` Map (memory)
2. Emits IPC events: `terminal:command-started`, `terminal:command-finished`

### Changes Made

#### TabBar.tsx
```javascript
// BEFORE: Polling every 2 seconds
const interval = setInterval(async () => {
  const result = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);
}, 2000);

// AFTER: Event-driven
useEffect(() => {
  // Initial load from memory (no syscalls)
  const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);

  // Listen for events (instant, no polling)
  ipcRenderer.on('terminal:command-started', handleStart);
  ipcRenderer.on('terminal:command-finished', handleFinish);
}, []);
```

#### Dashboard.tsx
Same pattern as TabBar.tsx.

#### useWorkspaceStore.ts (closeTab)
```javascript
// BEFORE: Always called pgrep/ps
const { hasProcess } = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);

// AFTER: First check memory, then syscall only if needed
const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
if (state.isRunning) {
  // Only now call hasRunningProcess to get process name
  const { processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);
}
```

## Result
- **0 syscalls** for process status monitoring
- Instant UI updates (no 2-second delay)
- sysmond CPU: 0% (was 334%)

## Files Modified
- `src/renderer/components/Workspace/TabBar.tsx`
- `src/renderer/components/Dashboard/Dashboard.tsx`
- `src/renderer/store/useWorkspaceStore.ts`

## Related
- `fact-terminal-core.md` - OSC 133 protocol specification
- `fact-terminal-core.md` - Similar event-driven pattern for CWD tracking
- `fact-input-events.md` (section 8) - execSync → execAsync migration
- `fix-mcp-spawn-non-interactive-shell.md` — родственный кейс: спавн с `-c` обёрткой ломает OSC 133 (не только polling, но и неправильный shell-flag убивает event-цепочку индикатора).

## Критическое правило (см. CLAUDE.md)
**ЗАПРЕЩЁН polling через `pgrep`/`ps`** для определения статуса процесса. Использовать только:
- `terminal:getCommandState` (читает из памяти, 0 syscalls)
- IPC-события `terminal:command-started` / `terminal:command-finished`

Исключение — Dashboard inventory внешних AI/Electron/MCP процессов, потому что external terminal нельзя узнать через OSC 133 текущего PTY. Это не должно становиться process-status polling: только один aggregate `ps` snapshot на refresh, без per-tab/per-card `pgrep`, с visible-window guard и медленным safety interval. Если нужен новый тип процесса на Dashboard — добавлять его в общий snapshot-builder, а не новый самостоятельный IPC с отдельным `ps`.

## TRAP: IPC Listeners + useEffect Dependencies

**Ловушка:** Если `ipcRenderer.on(...)` подписки находятся в `useEffect` с нестабильной зависимостью (например `[workspace?.tabs.size]`), то при каждом изменении зависимости:
1. Cleanup снимает старые listeners
2. Между cleanup и новой подпиской — окно, когда OSC 133 events **теряются**
3. `initStatus()` внутри создаёт **новый Map** и перезаписывает `setProcessStatus(newMap)` — убивая актуальное состояние `isRunning: true` для долгоживущих процессов (dev-серверы)

**Решение (TabBar.tsx):** Два раздельных `useEffect`:
1. **Listeners** (`[]`) — подписка один раз, стабильная, никогда не переподписывается
2. **Sync** (`[workspace?.tabs.size]`) — только для новых табов, **дополняет** Map через `prev =>` вместо полной перезаписи. Если таб уже отслеживается — его значение не перетирается

**Почему нейронка не догадается:** Код с единым `useEffect([tabs.size])` выглядит корректно — listeners подписываются, cleanup их убирает. Баг проявляется только при специфическом сценарии: dev-сервер запущен → создание нового таба → `tabs.size` изменился → effect re-runs → `initStatus()` async-ответ может прийти с `isRunning: false` (race) → кнопка RestartZone пропадает.
