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

## 3. Gemini Sniper 2.0 (SHA256 Hashing)

### Problem
Стандартный Sniper Watcher (используемый для Claude) не мог поймать сессию Gemini.

### Cause
1. **Lazy Creation:** Gemini создает файл сессии (`session-*.json`) только ПОСЛЕ того, как пользователь отправил первое сообщение. При простом запуске CLI папка пуста.
2. **Path Hashing:** Путь к сессиям зависит от SHA256 хеша текущей рабочей директории (CWD).

### Solution
1. **Dynamic Hashing:** Main-процесс вычисляет хеш CWD терминала для определения правильной папки `~/.gemini/tmp/<hash>/chats/`.
2. **Long-lived Watcher:** Увеличен таймаут вочера до 5 минут. Вочер привязан к жизненному циклу вкладки (`gemini:close-watcher`).
3. **JSON Parsing:** После обнаружения файла он парсится для извлечения полного UUID, так как имя файла содержит только короткий префикс.

### Результат
Надежный захват ID даже если пользователь долго думает над первым сообщением.

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
- **History Restore:** `claudeSessionId` берётся из БД (Immediate Injection), Sniper не нужен.

### Результат
Пользователь всегда видит корректный статус: AI запущен, но ID ещё не захвачен — жёлтый индикатор с пульсом.

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
