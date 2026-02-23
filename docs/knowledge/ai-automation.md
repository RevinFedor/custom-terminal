# AI Sessions & Automation Logic\n
\n---\n## File: ai-automation.md\n
# Сборник решений: AI Сессии и Автоматизация (Gemini/Claude)

Этот файл объединяет все решения, связанные с автоматизацией CLI агентов, восстановлением сессий и методом "Trojan Horse".

---

## 1. Smart Gemini Resume (State Detection)
**Файл-источник:** `fix-smart-gemini-resume.md`

### Problems
1. **Commands sent when Gemini already running**: Redundant `gemini` command breaks session restore.
2. **Commands sent before Gemini ready**: Gemini takes 2-5s to load; immediate commands are lost.

### Solution: New 3-stage approach
1. **Stage 1: Detect Current State**: Use `serializeAddon` to check if Gemini prompt `>` is already visible.
2. **Stage 2: Wait for Ready State**: If starting, wait up to 15s for "Type your message" pattern.
3. **Stage 3: Smart Execution**: Only send `gemini` if needed, then send `/chat resume`.

---

## 2. Silence & Cursor Detection (Automation Stability)
**Файл-источник:** `fix-gemini-cli-automation.md`

### Problems
1. **Fake Prompt**: Gemini CLI (Ink) draws `>` instantly, but internal loop is still busy.
2. **Error "Slash commands cannot be queued"**: Happens if command sent during "Generating" state.

### Solutions
- **Method A: HIDE Cursor Detection (Primary)**: Gemini hides cursor (`\x1b[?25l`) when ready for input. This is the fastest and most accurate method.
- **Method B: Silence Detection (Fallback)**: Wait for 1500-2000ms pause in PTY data stream.

---

## 3. Session Restore: From "Trojan Horse" to Direct Injection
**Файл-источник:** `fix-trojan-horse-replaced.md`

### Problem
Old method was confusing: it created a visible dummy checkpoint `trojan-xxx` in terminal, then renamed it.

### Solution: Direct Injection
Gemini CLI doesn't have an internal registry; it just scans `~/.gemini/tmp/<SHA256_HASH>/checkpoint-*.json`.
**New Strategy:**
1. Calculate SHA256 of the project directory.
2. Manually write the checkpoint JSON file into the correct Gemini temp folder.
3. User runs `/chat resume <name>` directly.
**Benefits:** Faster, invisible background work, no terminal pollution.

---

## 4. Claude Code Export: Predetermined Path Pattern
**Файл-источник:** Сессия 2026-01-21

### Problem
Парсинг вывода Claude Code для получения пути к экспортированной сессии ненадежен из-за ANSI-кодов, форматирования и асинхронности.

### Solution
Вместо парсинга ответа "Conversation exported to: ...", мы сами задаем путь в команде `/export path/to/file.md` и используем **FS Polling** для отслеживания момента появления файла.
1. Генерируем уникальный путь в `docs/tmp/`.
2. Отправляем команду в PTY.
3. Опрашиваем ФС (fs.existsSync) до появления файла (или таймаута 15с).
**Важно:** Claude всегда сохраняет файл с расширением `.txt`, даже если запрошен `.md`. Нужно учитывать это при ожидании.

---

## 5. Session Item Visual Selection
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
\n---\n## File: ai-automation.md\n
# ОПЫТ: Захват ID сессии Claude CLI

## Проблема
Claude Code CLI (v2.0+) генерирует ID сессии (UUID) самостоятельно при старте. Для реализации функций "Продолжить" (`claude-c`) и "Форк" (`claude-f`) приложению необходимо знать этот ID. Однако CLI не предоставляет API для получения текущего ID извне.

## Неудачные попытки (Failed Attempts)

### 1. "Метод Диктатора" (Injection)
**Идея:** Создать пустой файл `.jsonl` с нашим UUID в папке проекта и запустить `claude --resume <uuid>`.
**Результат:** ❌ **FAIL**. Claude валидирует структуру JSON при старте. Видя пустой файл, он считает его поврежденным и отказывается запускаться.

### 2. "Agent Prefixes"
**Идея:** Использовать префиксы `agent-*`, которые Claude использует для внутренних воркеров.
**Результат:** ❌ **FAIL**. Использование таких ID в команде `--resume` триггерит встроенное TUI-меню выбора сессий (Picker), что требует от пользователя ручного подтверждения (Enter) и ломает автоматизацию.

### 3. "Double Tap"
**Идея:** Программная отправка `\r` (Enter) через 1 секунду после запуска, чтобы "прожать" меню выбора.
**Результат:** ❌ **REJECTED**. Слишком хрупкое решение. Если меню не появится (или появится позже), лишний Enter уйдет в чат нейросети.

## Итоговое решение: Sniper Watcher

Был выбран проактивный, но безопасный метод слежки за файловой системой.

### Алгоритм:
1. **Перехват ввода:** Когда пользователь вводит `claude`, рендерер посылает сигнал `claude:spawn-with-watcher`.
2. **Активация Снайпера:** Main-процесс включает `fs.watch` на директорию проекта ровно на 5 секунд.
3. **Фильтрация:** Система игнорирует изменения и ловит только событие создания (`rename`) файла с расширением `.jsonl` и форматом UUID.
4. **Захват:** Первый подходящий файл считается ID текущей сессии. Watcher мгновенно отключается (`close()`).
5. **Владение:** ID сохраняется в `useWorkspaceStore` и БД, становясь доступным для `claude-c` и `claude-f`.

---

# ОПЫТ: Поддержка Truecolor (24-bit) в терминале

## Проблема
Интерфейсы на базе Ink (Gemini CLI, Claude Code) выглядели тусклыми (16/256 цветов), несмотря на поддержку Canvas рендерера.

## Причина
Многие современные CLI проверяют переменную окружения `COLORTERM`. Если она не установлена в `truecolor`, они переходят в режим совместимости с ограниченной палитрой.

## Решение
При создании PTY-процесса в `src/main/main.js` в объект `env` принудительно добавляется флаг:

```javascript
const ptyProcess = pty.spawn(shell, [], {
  ...
  env: {
    ...process.env,
    COLORTERM: 'truecolor'
  }
});
```

## Результат
Терминал корректно отображает яркие 24-битные цвета, что критично для визуального разделения блоков кода и системных сообщений AI-агентов.
\n---\n## File: ai-automation.md\n
# ОПЫТ: Особенности захвата ID сессии Gemini (Sniper 2.0)

## Problem
Стандартный Sniper Watcher (используемый для Claude) не мог поймать сессию Gemini.

## Cause
1. **Lazy Creation:** Gemini создает файл сессии (`session-*.json`) только ПОСЛЕ того, как пользователь отправил первое сообщение. При простом запуске CLI папка пуста.
2. **Path Hashing:** Путь к сессиям зависит от SHA256 хеша текущей рабочей директории (CWD).

## Solution
1. **Dynamic Hashing:** Main-процесс вычисляет хеш CWD терминала для определения правильной папки `~/.gemini/tmp/<hash>/chats/`.
2. **Long-lived Watcher:** Увеличен таймаут вочера до 5 минут. Вочер привязан к жизненному циклу вкладки (`gemini:close-watcher`).
3. **JSON Parsing:** После обнаружения файла он парсится для извлечения полного UUID, так как имя файла содержит только короткий префикс.

## Результат
Надежный захват ID даже если пользователь долго думает над первым сообщением.
\n---\n## File: ai-automation.md\n
# ОПЫТ: Sniper Watcher — Dual-Method Detection

## Проблема
Старый Sniper использовал только `fs.watch` с таймаутом 5 секунд. Проблемы:
1. **macOS FSEvents задержка:** `fs.watch` на macOS может пропускать события из-за задержки инициализации FSEvents — файл создан, но событие не пришло.
2. **5с таймаут слишком мал:** Claude CLI создаёт `.jsonl` файл только после первого обмена. Без Default Prompt пользователь может думать дольше 5 секунд.
3. **Нет защиты от старых файлов:** Watcher мог поймать старый файл, если его `birthtime` совпадала по таймингу.

## Решение: `startSessionSniper()`
Выделена отдельная функция с тремя улучшениями:

### 1. Snapshot (защита от ложных срабатываний)
```js
const existingFiles = new Set();
const files = fs.readdirSync(projectDir);
for (const f of files) {
  if (uuidPattern.test(f)) existingFiles.add(f);
}
```
Все существующие UUID-файлы фиксируются **до** запуска Claude. Файл из snapshot игнорируется даже если `fs.watch` отправит на него событие.

### 2. Dual-Method Detection
- **fs.watch:** Мгновенная реакция (когда работает).
- **setInterval 1с:** `readdirSync` + проверка на новые файлы (вне snapshot). Надёжный fallback.
Оба метода вызывают один и тот же `checkFile()`, который устанавливает `sessionFound` lock.

### 3. Таймаут 30с
Достаточно для ожидания первого сообщения пользователя. После таймаута cleanup закрывает и watcher, и polling.

## Использование
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

## Результат
Надёжный захват sessionId на macOS. При fs.watch failure polling подхватывает. Старые файлы не ловятся благодаря snapshot.
\n---\n## File: ai-automation.md\n
# ОПЫТ: Почему Gemini -r не является форком (True Fork)

## Problem
Первоначальная попытка реализовать `gemini-f` через простую команду `gemini -r <sessionId>` в новой вкладке привела к конфликту состояний.

## Symptoms
- Две вкладки работают с одним и тем же JSON-файлом в `~/.gemini/tmp/`.
- Сообщения из одной вкладки появляются в другой после перезапуска.
- Нарушается линейность диалога, сессия становится "битой".

## Cause
Gemini CLI привязывает сессию к конкретному файлу. Команда `-r` просто открывает этот файл. Если две копии CLI пишут в один файл одновременно, результат непредсказуем.

## Solution: True Fork
Реализован механизм физического клонирования состояния на уровне Main-процесса:
1. Поиск оригинального файла `session-*.json` по UUID.
2. Копирование файла под новым именем.
3. **Патчинг JSON:** Изменение поля `sessionId` внутри файла на новый UUID. Это критически важно, так как Gemini валидирует соответствие имени файла и внутреннего ID.
4. Запуск новой копии CLI с новым UUID.

## Результат
Каждая вкладка получает свой независимый файл сессии, что позволяет вести разные ветки диалога из одной точки.
\n---\n## File: ai-automation.md\n
# ОПЫТ: Промежуточное состояние "Ожидание сессии"

## Проблема
При запуске Claude без Default Prompt (промпт отключен в настройках) InfoPanel показывал "Нет активной сессии", хотя Claude CLI уже работал в терминале. Причина:

1. **Claude Sniper Watcher** отслеживает появление новых `.jsonl` файлов в `~/.claude/projects/<slug>/`.
2. Claude CLI **не создаёт** `.jsonl` файл при запуске — он создаётся только **после первого обмена сообщениями**.
3. Без Default Prompt пользователь сам должен ввести первый промпт. До этого момента Sniper не может ничего поймать.
4. InfoPanel видит `claudeSessionId === null` и показывает "Нет активной сессии" — это вводит в заблуждение.

## Решение: Трёхуровневое состояние
В InfoPanel добавлено отслеживание `commandType` таба (через поллинг store каждые 500мс):

```
commandType === 'claude'/'gemini' && sessionId → Активная сессия (зелёный)
commandType === 'claude'/'gemini' && !sessionId → Ожидание сессии... (жёлтый, пульс)
!commandType || commandType === null → Нет активной сессии (серый)
```

### Код (InfoPanel.tsx)
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

## Когда Sniper срабатывает
- **С Default Prompt:** Промпт отправляется автоматически через Handshake → Claude отвечает → `.jsonl` создан → Sniper ловит → `claudeSessionId` установлен → InfoPanel переключается на "Активная сессия".
- **Без Default Prompt:** Пользователь вводит промпт вручную → Claude отвечает → `.jsonl` создан → Sniper ловит → переход из "Ожидание" в "Активная".
- **History Restore:** `claudeSessionId` берётся из БД (Immediate Injection), Sniper не нужен.

## Результат
Пользователь всегда видит корректный статус: AI запущен, но ID ещё не захвачен — жёлтый индикатор с пульсом.
\n---\n## File: ai-automation.md\n
# ОПЫТ: Навигация по JSONL через Backtrace

## Проблема: "Мёртвые" ветки диалога
Файлы `.jsonl`, которые генерирует Claude Code, являются журналом событий (append-only log), а не готовым списком сообщений. 
Когда пользователь нажимает **Escape (Undo)**:
1. Записи в файле НЕ удаляются.
2. В UI Claude откатывается к предыдущему состоянию.
3. Новое сообщение создаёт "вилку" (новую ветку) от старого родителя.

Если читать файл просто сверху вниз (как массив), Timeline покажет и отменённые сообщения, и новые, что ломает логику.

## Решение: Алгоритм Обратной Трассировки (Backtrace)
Вместо чтения подряд, мы собираем историю "с конца":

1. **Индексация:** Читаем всю цепочку файлов (через `resolveSessionChain`) и создаем единый Map `UUID -> Entry`. Каждой записи при загрузке присваиваются поля `_fileIndex` и `_fromFile` для фиксации физического порядка в JSONL.
2. **Фильтрация шума:** При парсинге JSONL система автоматически вырезает системный мусор, такой как `<task-notification>` (уведомления о завершении фоновых задач Claude Code), чтобы они не засоряли Timeline и экспорт.
3. **Определение головы:** Берем самую последнюю запись в последнем файле цепи.
4. **Обход:** Идем от "головы" назад к корню, используя поле `parentUuid`.
5. **Компакция:** Если встречаем маркер компакции, используем логику **Compact Gap Recovery** (см. ниже).
6. **Bridge Following:** Если `parentUuid` отсутствует (начало файла), ищем запись-мост (`_isBridge`) в других файлах цепи.
7. **Результат:** Инвертируем собранный список.

---

## 2. The Compact Gap Recovery (Dangling UUIDs)

### Природа Compact в Claude Code
Критически важно понимать: команда `/compact` **НЕ удаляет** записи из JSONL-файла. Это append-only лог. Все pre-compact записи физически сохранены на диске. 
Claude только добавляет запись типа `compact_boundary`, где поле `logicalParentUuid` указывает на UUID последнего сообщения перед сжатием. 

**Проблема:** Этот UUID часто является "dangling reference" — он существует в оперативной памяти Claude, но никогда не записывался в файл. Стандартный Backtrace, наткнувшись на такой UUID, останавливается, "теряя" всю историю до компакта.

### Двухуровневое восстановление (Recovery Logic)
Если `recordMap.get(uuid)` возвращает `null` сразу после `compact_boundary`, алгоритм применяет два уровня спасения цепочки:

1. **Level 1: parentUuid Fallback.** Проверяется наличие обычного `parentUuid` у записи компакта. Если он указывает на валидную запись в Map, трассировка продолжается по нему.
2. **Level 2: Physical Predecessor.** Если Level 1 не помог, алгоритм переходит к **физическому поиску**: в том же файле (`_fromFile`) ищется запись с максимальным `_fileIndex`, который строго меньше индекса текущего компакта. Поскольку JSONL линеен, эта запись гарантированно является хронологическим предшественником.

---

## 3. Bridge Following: Защита от циклов

### Проблема
При наличии в `mergedMap` записей из 3 и более файлов сессий, в общем индексе может оказаться несколько записей-мостов (`_isBridge`). Обычный поиск моста по `sessionId` может привести к выбору моста, который ведет назад к уже посещенным записям, вызывая бесконечный цикл или преждевременный обрыв.

### Решение
При поиске моста в алгоритме Backtrace введена проверка: `!seen.has(entry.parentUuid)`. 
Мы следуем только по тем мостам, чья родительская запись еще не была обработана. Это гарантирует строго направленное движение к корню цепочки (root session).

---

## 3.1. Fork Copies Bridges (Ловушка при форке)

### Проблема
При форке сессии приложение **копирует JSONL-файл** целиком. Внутри копии сохраняются все bridge-записи (`_isBridge`) от оригинальной цепи. Когда `resolveSessionChain` обрабатывает форкнутый файл, он следует по этим скопированным мостам и попадает в оригинальную цепь, **пропуская промежуточные сессии**.

### Пример
Оригинальная цепь: `A → B(plan mode) → C(plan mode)`.
Форк из `C` → создаёт `D.jsonl` (копия `C.jsonl`).
В `D.jsonl` есть bridge к `B` (из оригинала).
`resolveSessionChain(D)` строит цепь: `D → B → A`. Сессия `C` пропущена.

### Следствие для UI
`sessionBoundaries` из `resolveSessionChain` НЕ содержит всех plan mode переходов. Записи внутри `entries` при этом СОДЕРЖАТ правильные `sessionId` (из оригинальных данных).

### Решение (Timeline)
Plan mode маркеры в Timeline детектируются **не через `sessionBoundaries`**, а через прямое сравнение `entry.sessionId` между соседними записями. Если `sessionId` меняется и в этой позиции нет fork-маркера → это plan mode граница. См. `features/timeline.md`.

---

## 4. Hierarchical Session Tree Logic

### Принцип построения
При экспорте сессии строится вложенное дерево (root → fork → plan mode) на основе сегментации `sessionId` в активной ветке диалога.

### Определение типов переходов:
- **(plan mode):** Определяется, если переход между разными `sessionId` произошел через запись, помеченную как `_isBridge` (Clear Context / Plan Mode в Claude).
- **(fork):** Определяется, если в точке перехода в БД существует `fork_marker`.
- **(root):** Самый первый сегмент цепочки.

### Визуальные индикаторы:
- `*` — помечает текущую (активную) сессию.
- `♻️ ×N` — счетчик компакт-операций внутри сегмента.
- `messages` — количество пользовательских промптов в сегменте.

---

## 5. Вычисление границ (Export Fork Boundaries)

В текстовом экспорте сессии (`/export`) форк-маркеры отображаются как разделители `🔵 FORK`.

### Проблема "Assistant Noise"
Файлы `.jsonl` содержат сообщения от пользователя, ассистента и результаты инструментов. Снапшот UUID (`entry_uuids`) содержит только **Timeline-eligible** записи (User messages + Compact boundaries). 
Если при вычислении границы сравнивать текущую запись из снапшота со СЛЕДУЮЩЕЙ записью в сыром логе (которая обычно является Assistant), то **каждое** сообщение пользователя будет помечено как граница форка.

### Решение
При генерации экспорта система ищет "следующую Timeline-запись":
1. Берется текущий `index` в массиве `activeBranch`.
2. Система ищет ближайшую следующую запись, которая подходит под критерии Timeline (User или Compact).
3. Сравнение производится только с этой найденной записью. Если её нет в снапшоте — значит, это точка форка.

Это гарантирует, что в текстовом файле будет ровно один маркер `🔵 FORK` в том месте, где действительно произошло ветвление, а не после каждого сообщения.
\n---\n## File: ai-automation.md\n
# ОПЫТ: Чистый экспорт Claude (Code Stripping)

## Проблема
Прямой экспорт логов Claude (`.jsonl`) содержит огромные дампы кода: результаты `read_file` (весь контент файла) и `edit_file` (огромные diff-ы). Копирование такой сессии в другую нейросеть забивает контекстное окно мусором.

## Решение: Трансформация в Markdown
Введен механизм фильтрации (IPC `claude:export-clean-session`), который превращает сырые данные в компактный отчет. Этот же механизм используется в **Update Docs** для подготовки данных для Gemini.

1. **User:** Сохраняется только текст промпта. `tool_result` (результаты выполнения команд) полностью вырезаются.
2. **Assistant:** Сохраняется текст ответа и `thinking` блоки.
3. **Actions:** Вместо вложенного кода вызовы инструментов заменяются на эмодзи-метки:
   - `📄 Чтение (/path/to/file)`
   - `✏️ Редактирование (/path/to/file)`
   - `🖥 Команда ("ls -la")`
4. **Thinking:** Блоки `thinking` сохраняются полностью без обрезания.

## Результат
Сессия на 5000 строк кода превращается в Markdown-текст на 50-100 строк, сохраняющий всю логику диалога и последовательность действий AI.
\n---\n## File: ai-automation.md\n
# Fix: Gemini Search & Research Activation

## 🛠 ОПЫТ: "Почему Gemini не искал и не открывался с первого раза?"

### 1. Проблема с Google Search (Tools)
При ответах Gemini не использовал поиск в интернете, хотя это было заявлено в интерфейсе.

#### Причина
В теле запроса к API отсутствовал параметр `tools`. Простой вызов `generateContent` без этого параметра ограничивает модель только её внутренними знаниями.

#### Решение
В `GeminiPanel.tsx` была добавлена динамическая вставка инструментов. 
**Важное ограничение:** Инструмент `googleSearch` (Grounding) поддерживается не всеми моделями. Передача его в `gemini-2.0-flash` вызывала ошибку `400 Bad Request`.

```javascript
body: JSON.stringify({
  contents: [{ parts: [{ text: fullPrompt }] }],
  // Включаем поиск только для продвинутых моделей
  ...(selectedModel.includes('gemini-3') || selectedModel.includes('gemini-2.5') ? {
    tools: [{ googleSearch: {} }]
  } : {})
})
```

---

### 2. Проблема "Холодного старта" панели (Research Trigger)
При нажатии "Искать в AI" в контекстном меню терминала, панель открывалась, но поиск не запускался (приходилось нажимать второй раз).

#### Причина
Использовалась система событий `window.dispatchEvent(new CustomEvent('trigger-research'))`. 
Когда панель закрыта, компонент `GeminiPanel` не смонтирован -> слушатель события не существует -> событие улетает в пустоту. При втором нажатии панель уже открыта, слушатель активен, и всё работает.

#### Решение
Переход с Event-driven подхода на **State-driven** через Zustand Store (`useResearchStore`).

1. **App.tsx (Trigger):** Вызывает `triggerResearch()`, который ставит флаг `pendingResearch: true` и открывает панель.
2. **GeminiPanel (Mount):** При монтировании (или изменении флага) проверяет `pendingResearch`. Если `true` — запускает поиск и сбрасывает флаг.

Это гарантирует выполнение задачи независимо от того, была ли панель открыта в момент клика.

---

## 6. Rewind Prompt: Пересказ без мнений
**Файл-источник:** Сессия 2026-02-12

### Problem
Стандартные промпты для суммаризации часто включают "планы на будущее", советы ИИ и вежливые вступления. При откате сессии это забивает контекст Claude ненужным шумом.

### Solution: Fact-only Rewind Prompt
Специализированный промпт для Gemini, используемый при откате:
1. **Жесткое вступление:** "Ниже представлена краткая сводка логов...".
2. **Запрет на планы:** Прямой запрет на генерацию "следующих шагов", "плана действий" или "тестовых запусков".
3. **Фокус на "Почему":** Требование выделить именно причины ошибок (почему не сработало) и неочевидные связи в коде.
4. **Отсутствие мнения:** ИИ должен выступать как объективный пересказчик логов, а не как советник.

**Результат:** Claude получает чистый технический контекст "потерянной" части истории, что позволяет ему продолжить работу без галлюцинаций о будущем.

