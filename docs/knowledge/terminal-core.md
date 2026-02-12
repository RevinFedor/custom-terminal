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
В нашем случае, `ipcRenderer` в Main-процессе перехватывает данные, либо Renderer парсит их и обновляет `tab.cwd` в `useWorkspaceStore`.

## Преимущества
- **Мгновенность:** Путь обновляется ровно в момент выполнения команды `cd`.
- **Производительность:** Ноль системных вызовов к дереву процессов ОС.
- **Надежность:** Работает даже если процесс Shell "завис" или занят (сообщение приходит от самой оболочки).
- **Persistence:** Актуальный `cwd` всегда готов к сохранению в SQLite при закрытии приложения.

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

---

## Fact: Terminal Registry & Selection Sync

Глобальный механизм синхронизации состояния терминалов `xterm.js` с UI-компонентами React.

## 1. Реестр инстансов (terminalRegistry)
Поскольку инстансы `xterm.js` создаются внутри хуков и не хранятся в React-стейтах (для производительности), создан прямой реестр.
- **Файл:** `src/renderer/utils/terminalRegistry.ts`
- **Функция:** Позволяет любому компоненту (например, NotesPanel или App) получить доступ к объекту терминала по его `tabId`.
- **Методы:** `register`, `unregister`, `getSelection(tabId)`.

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

## Решение: safePasteAndSubmit (Chunked Paste + Sync Verification)

### Проблема с предыдущим подходом (writeToPtySafe)
Старая функция `writeToPtySafe` разбивала ВЕСЬ payload (включая escape-последовательности `\x1b[200~` и `\x1b[201~`) на чанки по 1KB. Это ломало bracketed paste — Ink TUI получал фрагментированные escape sequences и не мог их собрать. Дополнительно, macOS TTYHOG limit = 1024 bytes — ядро режет любой `term.write()` > 1024 байт.

### Новый подход: `safePasteAndSubmit(term, content, options)`
1. **Chunking:** Контент делится на чанки по 900 байт. Каждый чанк оборачивается в ПОЛНЫЙ bracketed paste (`\x1b[200~` + chunk + `\x1b[201~`), итого < 1024 байт — ядро не режет.
2. **Sync Marker Verification:** После каждого чанка функция слушает PTY output и ждёт sync marker `\x1b[?2026l` (конец Ink render frame). Это подтверждает что Ink обработал paste и React state committed. (**НЕ** text echo — Ink коллапсирует вставки в `[Pasted text #N +M lines]`, поэтому текст не появляется в выводе.)
3. **Submit:** `\r` отправляется ТОЛЬКО после подтверждения последнего чанка — гарантия что `onSubmit(value)` прочитает правильный state.

```javascript
await safePasteAndSubmit(term, content, {
  submit: true,         // отправить \r после всех чанков
  ctrlCFirst: false,    // Ctrl+C перед paste (для очистки инпута)
  logPrefix: '[tag]',   // для логов
  safetyTimeoutMs: 8000 // fallback timeout (не основной механизм)
});
```

### Ключевые свойства
- **Event-driven:** Никаких фиксированных таймаутов. Sync marker = факт render, не предположение.
- **Любая длина:** Чанков может быть сколько угодно (900 байт каждый).
- **Universal:** Используется для Handshake, send-command, terminal:input, Restore:History.
- **Safety timeout:** 8s — это не "подождать", а "что-то фатально сломалось, abort".

### Bracketed Paste Mode
Данные оборачиваются в escape-последовательности:
- Начало: `\x1b[200~`
- Конец: `\x1b[201~`

**Важно:** `\r` для submit отправляется **после** закрывающего тега И подтверждения echo.

## Код
Реализовано в `src/main/main.js`: функции `safePasteAndSubmit()`, `waitForRender()`. Автоматически применяется для любых данных длиннее 1024 байт через `terminal:input`, а также для всех Claude TUI операций.

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

### Решение
В файле `src/main/main.js` при создании PTY-процесса были принудительно установлены переменные окружения:

```javascript
const ptyProcess = pty.spawn(shell, [], {
  // ...
  env: {
    ...process.env,
    COLORTERM: 'truecolor',        // Включает яркие 24-bit цвета
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' // Обеспечивает корректный ввод UTF-8
  }
});
```

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
- `terminal-core.md` - OSC 133 protocol specification
- `terminal-core.md` - Similar event-driven pattern for CWD tracking
- `ui-ux-stability.md` (section 8) - execSync → execAsync migration

## Критическое правило (см. architecture.md)
**ЗАПРЕЩЁН polling через `pgrep`/`ps`** для определения статуса процесса. Использовать только:
- `terminal:getCommandState` (читает из памяти, 0 syscalls)
- IPC-события `terminal:command-started` / `terminal:command-finished`

## TRAP: IPC Listeners + useEffect Dependencies

**Ловушка:** Если `ipcRenderer.on(...)` подписки находятся в `useEffect` с нестабильной зависимостью (например `[workspace?.tabs.size]`), то при каждом изменении зависимости:
1. Cleanup снимает старые listeners
2. Между cleanup и новой подпиской — окно, когда OSC 133 events **теряются**
3. `initStatus()` внутри создаёт **новый Map** и перезаписывает `setProcessStatus(newMap)` — убивая актуальное состояние `isRunning: true` для долгоживущих процессов (dev-серверы)

**Решение (TabBar.tsx):** Два раздельных `useEffect`:
1. **Listeners** (`[]`) — подписка один раз, стабильная, никогда не переподписывается
2. **Sync** (`[workspace?.tabs.size]`) — только для новых табов, **дополняет** Map через `prev =>` вместо полной перезаписи. Если таб уже отслеживается — его значение не перетирается

**Почему нейронка не догадается:** Код с единым `useEffect([tabs.size])` выглядит корректно — listeners подписываются, cleanup их убирает. Баг проявляется только при специфическом сценарии: dev-сервер запущен → создание нового таба → `tabs.size` изменился → effect re-runs → `initStatus()` async-ответ может прийти с `isRunning: false` (race) → кнопка RestartZone пропадает.
