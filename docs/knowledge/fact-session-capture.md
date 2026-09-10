# AI Session Capture: Sniper Watcher, Detection Methods & UI State

### Симптомы
После запуска Claude или Gemini в терминале боковая панель (InfoPanel) долго показывает статус "Ожидание сессии" (желтый индикатор с пульсом), даже если пользователь уже начал переписку. Из-за этого функции автоматизации (Fork, Resume, Timeline) остаются заблокированными для данной вкладки.

---

## 1. ОПЫТ: Захват ID сессии Claude CLI

### Проблема
Claude Code CLI (v2.0+) генерирует ID сессии (UUID) самостоятельно при старте. Для реализации функций "Продолжить" (`claude-c`) и "Форк" (`claude-f`) приложению необходимо знать этот ID. Однако CLI не предоставляет API для получения текущего ID извне.

### Неудачные попытки (Failed Attempts)

#### 1. "Метод Диктатора" (Injection)
**Идея:** Создать пустой файл `.jsonl` с нашим UUID в папке проекта и запустить `claude --resume <uuid>`.
**Результат:** ❌ **FAIL**. Claude валидирует структуру JSON при старте. Видя пустой файл, он считает его поврежденным и отказывается запускаться.

#### 2. "Agent Prefixes"
**Идея:** Использовать префиксы `agent-*`, которые Claude использует для внутренних воркеров.
**Результат:** ❌ **FAIL**. Использование таких ID в команде `--resume` триггерит встроенное TUI-меню выбора сессий (Picker), что требует от пользователя ручного подтверждения (Enter) и ломает автоматизацию.

#### 3. "Double Tap"
**Идея:** Программная отправка `\r` (Enter) через 1 секунду после запуска, чтобы "прожать" меню выбора.
**Результат:** ❌ **REJECTED**. Слишком хрупкое решение. Если меню не появится (или появится позже), лишний Enter уйдет в чат нейросети.

### Итоговое решение: Sniper Watcher

Был выбран проактивный, но безопасный метод слежки за файловой системой.

#### Алгоритм:
1. **Перехват ввода:** Когда пользователь вводит `claude`, рендерер посылает сигнал `claude:spawn-with-watcher`.
2. **Активация Снайпера:** Main-процесс включает `fs.watch` на директорию проекта ровно на 5 секунд.
3. **Фильтрация:** Система игнорирует изменения и ловит только событие создания (`rename`) файла с расширением `.jsonl` и форматом UUID.
4. **Захват:** Первый подходящий файл считается ID текущей сессии. Watcher мгновенно отключается (`close()`).
5. **Владение:** ID сохраняется в `useWorkspaceStore` и БД, становясь доступным для `claude-c` и `claude-f`.

---

## 2. Sniper Watcher — Dual-Method Detection

### Проблема
Старый Sniper использовал только `fs.watch` с таймаутом 5 секунд. Проблемы:
1. **macOS FSEvents задержка:** `fs.watch` на macOS может пропускать события из-за задержки инициализации FSEvents — файл создан, но событие не пришло.
2. **5с таймаут слишком мал:** Claude CLI создаёт `.jsonl` файл только после первого обмена. Без Default Prompt пользователь может думать дольше 5 секунд.
3. **Нет защиты от старых файлов:** Watcher мог поймать старый файл, если его `birthtime` совпадала по таймингу.

### Решение: `startSessionSniper()`
Выделена отдельная функция с тремя улучшениями:

#### 1. Snapshot (защита от ложных срабатываний)
```js
const existingFiles = new Set();
const files = fs.readdirSync(projectDir);
for (const f of files) {
  if (uuidPattern.test(f)) existingFiles.add(f);
}
```
Все существующие UUID-файлы фиксируются **до** запуска Claude. Файл из snapshot игнорируется даже если `fs.watch` отправит на него событие.

#### 2. Dual-Method Detection
- **fs.watch:** Мгновенная реакция (когда работает).
- **setInterval 1с:** `readdirSync` + проверка на новые файлы (вне snapshot). Надёжный fallback.
Оба метода вызывают один и тот же `checkFile()`, который устанавливает `sessionFound` lock.

#### 3. Таймаут 30с
Достаточно для ожидания первого сообщения пользователя. После таймаута cleanup закрывает и watcher, и polling.

### Использование
```js
// В claude:run-command (case 'claude'):
startSessionSniper(projectDir, Date.now(), (sessionId) => {
  event.sender.send('claude:session-detected', { tabId, sessionId });
});

// В claude:spawn-with-watcher:
startSessionSniper(projectDir, startTime, (sessionId) => {
  event.sender.send('claude:session-detected', { tabId, sessionId });
});
```

### Результат
Надёжный захват sessionId на macOS. При fs.watch failure polling подхватывает. Старые файлы не ловятся благодаря snapshot.

---

### 3. Gemini Sniper 2.0 (SHA256 & Slug Hashing)

### Problem
Стандартный Sniper Watcher (используемый для Claude) не мог поймать сессию Gemini.

### Cause
1. **Lazy Creation:** Gemini создает файл сессии (`session-*.json`) только ПОСЛЕ того, как пользователь отправил первое сообщение. При простом запуске CLI папка пуста.
2. **Path Resolution:** Путь к сессиям зависит от SHA256 хеша или человекочитаемого **slug-а** проекта (v0.30+).
3. **Stale Captures:** При старте Gemini может обновлять (`change` event) существующие файлы сессий для индексации. Старые Sniper-ы ошибочно принимали эти обновления за новую сессию.

### Solution
1. **Dynamic Resolution:** Система сначала проверяет `~/.gemini/projects.json` для поиска slug-а проекта, иначе откатывается к SHA256 хешу. 
2. **Snapshot Defense:** Перед запуском Gemini система запоминает список всех существующих файлов в папке `chats/`. 
   - События `change` на файлах из этого списка **игнорируются**.
   - Новой сессией считается только событие `rename` (создание нового файла) или `change` на файле, отсутствовавшем в начальном снапшоте.
3. **Long-lived Watcher:** Увеличен таймаут вочера до 5 минут. Вочер привязан к жизненному циклу вкладки.
4. **JSON Parsing:** После обнаружения файла он парсится для извлечения полного UUID.

### Результат
Надежный захват ID даже если пользователь долго думает над первым сообщением, и полное исключение захвата чужих (старых) сессий при запуске.

---

## 4. Промежуточное состояние "Ожидание сессии"

### Проблема
При запуске Claude без Default Prompt (промпт отключен в настройках) InfoPanel показывал "Нет активной сессии", хотя Claude CLI уже работал в терминале. Причина:

1. **Claude Sniper Watcher** отслеживает появление новых `.jsonl` файлов в `~/.claude/projects/<slug>/`.
2. Claude CLI **не создаёт** `.jsonl` файл при запуске — он создаётся только **после первого обмена сообщениями**.
3. Без Default Prompt пользователь сам должен ввести первый промпт. До этого момента Sniper не может ничего поймать.
4. InfoPanel видит `claudeSessionId === null` и показывает "Нет активной сессии" — это вводит в заблуждение.

### Решение: Трёхуровневое состояние
В InfoPanel добавлено отслеживание `commandType` таба (через поллинг store каждые 500мс):

```
commandType === 'claude'/'gemini' && sessionId → Активная сессия (зелёный)
commandType === 'claude'/'gemini' && !sessionId → Ожидание сессии... (жёлтый, пульс)
!commandType || commandType === null → Нет активной сессии (серый)
```

#### Код (InfoPanel.tsx)
```tsx
const [activeCommandType, setActiveCommandType] = useState<string | null>(null);

// В поллинге:
setActiveCommandType(tab.commandType || null);

// В JSX:
) : (activeCommandType === 'claude' || activeCommandType === 'gemini') ? (
  <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
  <span className="text-yellow-500/80 text-xs">Ожидание сессии...</span>
) : (
  <span className="w-2 h-2 rounded-full bg-[#666]"></span>
  <span className="text-[#888] text-xs">Нет активной сессии</span>
)
```

### Когда Sniper срабатывает
- **С Default Prompt:** Промпт отправляется автоматически через Handshake → Claude отвечает → `.jsonl` создан → Sniper ловит → `claudeSessionId` установлен → InfoPanel переключается на "Активная сессия".
- **Без Default Prompt:** Пользователь вводит промпт вручную → Claude отвечает → `.jsonl` создан → Sniper ловит → переход из "Ожидание" в "Активная".

### Когда используется Immediate Injection (Sniper не нужен)
1. **History Restore:** `claudeSessionId` берется из БД.
2. **Rollback / Fork:** ID новой сессии передается напрямую в `createTab()`.

### Результат
Пользователь всегда видит корректный статус: AI запущен, но ID ещё не захвачен — жёлтый индикатор с пульсом.

### CwdGuard ловушка: «Ожидание сессии» при `cd` внутри шелла
Sniper полагается на StatusLine Bridge (`~/.claude/bridge/<sid>.json`), который Claude пишет после каждого ответа. В main.js (`startSessionBridge`) есть CwdGuard, сравнивающий `bridge.cwd` с `terminalProjects.get(tabId)`. Защита нужна для случая «запустил `claude --resume <foreignId>` в табе X — bridge приходит из чужого проекта, не клеим его на X».

**Шрам:** старая версия делала строгое сравнение `===` при main-side cwd, который фактически зафиксировался один раз при создании PTY. Симптом: юзер стартанул таб в `/Users/fedor/Desktop/custom-terminal`, в шелле сделал `cd ..`, запустил `claude` — bridge пишет `cwd=/Users/fedor/Desktop`, а main всё ещё сравнивает с начальным cwd → guard skip → sessionId не доходит до renderer → жёлтый pulse навсегда, хотя в логах виден `sid=a5abf565...`.

**Текущий фикс:** canonical cwd обновляет не bridge и не сам текст OSC 7, а подтверждённое состояние live PTY. Renderer после `cd` отправляет OSC-кандидат в main, но меняет `tab.cwd` только после положительного ACK: main проверяет существование директории и совпадение с cwd живого shell-процесса. Bridge cwd после этого должен совпасть с `terminalProjects`, но сам bridge **не владеет** `terminalProjects`: path-drift событие можно принять для текущего `session-detected` side effect, но нельзя переписывать canonical cwd из `bridge.cwd` (см. `fix-bridge-stale-takeover.md`). Только полностью несвязанные пути (`/A/proj1` vs `/A/proj2`) реально считаются конфликтом. Полный контракт proof/retained-last-good описан в `fact-terminal-core.md::Reactive CWD Tracking`.

**Почему `===` был исходно:** автор боялся, что path-prefix позволит чужому проекту проникнуть. На практике: путь к другому проекту НЕ может быть префиксом текущего, кроме случая когда оба лежат в одной директории (`/Users/fedor/Desktop/projA` vs `/Users/fedor/Desktop` — да, второе префикс первого, но это родитель → нормальный случай `cd ..`). Сценарий "юзер из `/Users/fedor/Desktop/projA` сделал `cd ../projB && claude --resume <projA-sid>`" даст `bridge.cwd=/projB`, `tab.cwd=/projA` — не префикс друг друга → guard продолжит работать. Принцип: см. `methodology/дизайн-принципы.md::Path-prefix tolerance для cwd-сравнений`.

---

## 5. Интерактивная Валидация ID (UI Feedback)
При ручном вводе ID сессии (через кнопку ✎ "Set ID") в `InfoPanel` реализована проверка существования файла на диске в реальном времени.

### Логика обратной связи:
- **Цвет рамки инпута:**
    - **Желтый:** Идет проверка (debounce 300мс).
    - **Зеленый:** Файл сессии найден на диске (для Claude — по UUID, для Gemini — по UUID или 8-char префиксу).
    - **Красный:** Файл не найден или формат ID невалиден.
- **Статус-строка:** Под инпутом отображается краткий статус `C: found` / `G: found` с превью первого сообщения сессии в тултипе.
- **Блокировка действий:** Кнопки **C** (Claude) и **G** (Gemini) заблокированы (`disabled`), пока система не подтвердит наличие соответствующего файла на диске. Это предотвращает установку "битых" ID, которые привели бы к ошибкам при попытке Resume/Fork.
- **Resolved IDs:** При вводе короткого 8-символьного ID для Gemini, система резолвит его в полный UUID. При нажатии кнопки "Apply", в store записывается именно полный UUID.

### Apply pipeline (cd + stop + resume)

Apply для Claude делает три действия в одном flow, независимо от того, запущен Claude в табе или нет.

**1. Auto-cd до origin-cwd сессии.** `claude --resume <uuid>` ребилдит project slug из `process.cwd()` и ищет `~/.claude/projects/<slug>/<uuid>.jsonl`. Если шелл таба сидит в другом проекте, CLI отвечает *«No conversation found»*. Заранее зная это, renderer перед resume дёргает IPC `claude:resolve-session-cwd` — main читает первую строку JSONL (там Claude всегда пишет `entry.cwd`) и возвращает реальный путь. Команда собирается одной строкой `cd '<path>' && claude --dangerously-skip-permissions --resume <uuid>\r` и пишется в PTY атомарно: юзер не успевает вклиниться между cd и resume. Single-quote escape (`safe = cdTo.replace(/'/g, "'\\''")`) защищает от путей со спецсимволами.

Тот же принцип обязателен для `claude-f` / fork-from-clipboard: источник cwd — первая запись исходного JSONL, а не cwd текущего таба. Fork-copy надо класть в project-dir, соответствующий **session cwd**, и запускать `cd '<sessionCwd>' && claude --resume <newForkId>`. Если копию создать или resume выполнить из текущего cwd, Claude может показать интерактивное окно `Choose working directory to resume this session` (`Session = ...`, `Current = ...`). Сам chooser не ломает историю, но это лишний ручной шаг и он сразу проявляет другой баг — фокус должен уже быть в терминале после Continue/Start, иначе Enter не сработает без клика по xterm.

**2. Always-stop, не trust the polled flag.** Renderer **всегда** делает `await ipcRenderer.invoke('terminal:stop-ai-process', tabId)` — без условия на `isCommandRunning`. Локальный флаг — это polled-snapshot store через 500ms-таймер, окно расхождения с реальностью измеряется секундами. Доверять ему как gate'у нельзя: воспроизводилось так — `[InfoPanel:ManualSet]` отработал, `[StopAI]` отсутствует в логах, сразу `[Claude Runner] Continuing session`, а команда `cd … && claude --resume …` уходит в композер живого Claude TUI как user-prompt. Авторитетный источник — main через `ps -eo pid,ppid,command`: если процесса реально нет, IPC возвращает `success:false, error:'no AI process found'` — это **ожидаемый** no-op-код, обрабатываем тихо и сразу переходим к launch. Близкая методология — `methodology/дизайн-принципы.md::Cached external resource: alive-probe перед использованием` (probe перед использованием cached external handle — тот же класс «не доверять локальной проекции, спрашивать авторитет»).

**3. Auto-launch когда Claude не запущен.** Тот же `runResume()` вызывается без stop-grace 150ms. Юзеру не нужно второго жеста («набрал UUID → нажал C → нажал Continue»): свежий Claude сразу стартует с правильной сессией в правильном cwd.

**Сигнатура расширена в main:** `claude:run-command` теперь принимает опциональный `cdTo` параметр; в branch `claude-c` пишется `cd '<cdTo>' && claude --resume <sessionId>` если `cdTo` непустой, иначе только `claude --resume`. Этим же путём может пользоваться любой другой UI-сценарий, где нужен resume чужой сессии — Continue-кнопка, Restore tab.

### Anti-flap на dead session_links
Раньше Apply «откатывался через секунду» — Timeline через `latestSessionId` тащил dead UUID из `session_links` SQLite и перезатёртывал store. Это **другой** баг с другим фиксом — см. [`fix-dead-session-link-overwrite.md`](fix-dead-session-link-overwrite.md) и [`fact-session-detection.md::Dead session_links + chain resolve trap`](fact-session-detection.md). Без liveness-guard'а никакой Apply корректно не работал, потому что polling Timeline'а перетоптывал ручной выбор.

### SessionWriteReason contract + claude_session_history

После инцидента с stale bridge takeover (см. `fix-bridge-stale-takeover.md`) `setClaudeSessionId(tabId, sessionId, reason)` теперь требует обязательный третий параметр — `SessionWriteReason` sealed union: `bridge` / `autoResume` / `userIntercept` / `userManual` / `timelineChain` / `fork` / `restoredFromDb` / `userRevert` / `unknown`. TypeScript не даст забыть — любой новый call-сайт обязан декларировать почему пишет в общее поле.

При смене значения предыдущий sessionId пушится в `tab.claudeSessionHistory` (cap 5, JSON в SQLite колонке `tabs.claude_session_history`), вместе с reason и timestamp. История переживает рестарт. TabBar context-menu → «Revert Session ›» submenu отображает её с relative time и одним кликом возвращает значение (запишется обратно с `reason: 'userRevert'` — тоже в историю). Это last line of defense, когда защитные слои в bridge watcher'е и `pendingResume` guard'е пропустят wrong write.

Полный список 9 writer'ов и их reason-тэгов — `fact-session-detection.md::Stale bridge files + pendingResume guard` секция «Решение».

---

## 6. Session Item Visual Selection
**Файл-источник:** `fix-session-item-not-selecting.md`

### Problem
Clicking a session didn't show a border because `border-transparent` was still present alongside `border-accent`.

### Solution
Explicitly swap classes:
```javascript
// On click:
el.classList.remove('border-transparent');
el.classList.add('border-accent');
// On deselect:
el.classList.remove('border-accent');
el.classList.add('border-transparent');
```
Tailwind classes are atomic and have equal specificity; order in JS doesn't matter, only the absence of conflict.
