# Session Persistence Research: Technical Dump

**Дата:** 2026-01-19
**Цель:** Полное исследование механизмов сохранения/восстановления сессий для Gemini CLI и Claude Code

---

## 🔍 GEMINI CLI v0.24.0

### Структура хранения

```
~/.gemini/tmp/<SHA256_HASH>/
├── checkpoint-<tag>.json       # Сохраненные чекпоинты (JSON)
├── logs.json                   # Логи сессии
├── chats/                      # Обычные сессии
│   └── session-*.json
└── shell_history               # История команд
```

### Hash механизм

- **Алгоритм:** SHA-256 от абсолютного пути рабочей директории
- **Пример:** `/Users/fedor/Desktop` → `0a338f983c31cb7e12f607130a922ec49dc818bf04269015c0c57bfe80886d36`
- **Вычисление:** `echo "/path/to/directory" | shasum -a 256`

### Checkpoint формат (JSON)

```json
{
  "history": [
    {
      "role": "user",
      "parts": [
        {
          "text": "This is the Gemini CLI. We are setting up the context...\nI'm currently working in the directory: /Users/fedor/Desktop\n..."
        }
      ]
    },
    {
      "role": "model",
      "parts": [
        {
          "text": "response text"
        },
        {
          "functionCall": {
            "name": "list_directory",
            "args": {"dir_path": "/path"}
          }
        }
      ]
    }
  ]
}
```

**Что содержит checkpoint:**
- Полная история диалога (role: user/model)
- Абсолютные пути к файлам проекта
- Hash директории (многократно)
- Структура дерева файлов (до 200 items)
- Function calls и их результаты
- Контекст операционной системы

### Команды CLI

```bash
/chat save <tag>      # Создает checkpoint
/chat list            # Список checkpoint'ов
/chat resume <tag>    # Восстановление checkpoint
/exit                 # Выход
```

### Механизм checkpoint'ов

**Создание (`/chat save`):**
1. Создает физический JSON файл
2. Регистрирует checkpoint во внутреннем реестре CLI
3. Делает checkpoint "видимым" для `/chat list`

**Проблема простого копирования:**
- Копирование файла НЕ обновляет внутренний реестр
- CLI не видит checkpoint в `/chat list`
- Требуется регистрация

### "Trojan Horse" метод переноса

**Суть:** Создать легальную оболочку checkpoint'а, затем подменить содержимое

**Шаги:**

1. **Создать легальную оболочку в новой директории:**
```bash
cd /new/target/directory
gemini
> hi
> /chat save <tag>
> /exit
```

2. **Найти созданный файл:**
```bash
NEW_FILE=$(find ~/.gemini/tmp -name "checkpoint-<tag>.json" -print0 | xargs -0 ls -t | head -n 1)
```

3. **Подменить содержимое:**
```bash
OLD_FILE="~/.gemini/tmp/<OLD_HASH>/checkpoint-<tag>.json"
cp -f "$OLD_FILE" "$NEW_FILE"
```

4. **Патчить пути:**
```bash
sed -i '' 's|/old/path|/new/path|g' "$NEW_FILE"
```

5. **Патчить hash:**
```bash
NEW_HASH=$(echo "$NEW_FILE" | grep -oE '/[a-f0-9]{64}/' | tr -d '/')
sed -i '' "s|$OLD_HASH|$NEW_HASH|g" "$NEW_FILE"
```

6. **Восстановить:**
```bash
cd /new/target/directory
gemini
> /chat resume <tag>
```

### Текущее состояние

**Установлено:** ✅ `/opt/homebrew/bin/gemini` v0.24.0

**Существующие checkpoint'ы:**
```bash
~/.gemini/tmp/0a338f983c31cb7e12f607130a922ec49dc818bf04269015c0c57bfe80886d36/
└── checkpoint-point-tg-001.json  (150KB)
```

**Проекты с hash'ами:** 20+ директорий (по количеству папок в `~/.gemini/tmp/`)

---

## 🔍 CLAUDE CODE CLI v2.0.64

### Структура хранения

```
~/.claude/
├── history.jsonl                # Глобальная история (JSONL)
├── settings.json                # Настройки (alwaysThinkingEnabled, model)
├── projects/                    # Проект-специфичные данные
│   ├── -Users-fedor-Desktop-custom-terminal/
│   │   ├── <UUID>.jsonl         # Сессии (JSONL)
│   │   ├── agent-<ID>.jsonl     # Агенты/субпроцессы
│   │   └── <UUID>/              # Папка сессии
│   │       └── tool-results/    # Сохраненные результаты tool calls
│   └── ...
├── session-env/                 # UUID папки (пустые)
│   ├── <UUID>/
│   └── ...                      # 135 папок
├── shell-snapshots/             # Bash snapshots
│   └── snapshot-zsh-<timestamp>-<random>.sh  # 809 файлов
├── plans/                       # Сохраненные планы
├── debug/                       # Отладочные данные (640 файлов)
├── todos/                       # Тудушки (2150 файлов)
├── ide/                         # IDE интеграция
├── plugins/                     # Плагины
├── statsig/                     # Телеметрия
└── telemetry/                   # Телеметрия
```

### Именование проектов

**Формат:** Слеши заменены на дефисы
```
/Users/fedor/Desktop/custom-terminal
→ -Users-fedor-Desktop-custom-terminal
```

### Формат JSONL (JSON Lines)

**Каждая строка = отдельное JSON событие:**

```jsonl
{"type":"summary","summary":"Project description","leafUuid":"..."}
{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/path","sessionId":"UUID","version":"2.0.64","gitBranch":"main","type":"user","message":{"role":"user","content":"user message"},"uuid":"...","timestamp":"2026-01-19T06:50:06.825Z","thinkingMetadata":{"level":"high","disabled":false,"triggers":[]},"todos":[]}
{"parentUuid":"...","type":"assistant","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"..."}],"usage":{...}},"uuid":"...","timestamp":"..."}
```

**Поля:**
- `type`: "summary" | "user" | "assistant"
- `parentUuid`: Связь сообщений (цепочка)
- `sessionId`: UUID сессии
- `cwd`: Рабочая директория
- `gitBranch`: Текущая git ветка
- `timestamp`: ISO 8601
- `thinkingMetadata`: Настройки thinking
- `todos`: Список задач
- `message.content`: Массив блоков (text, thinking, tool_use, tool_result)
- `usage`: Token usage statistics

### Tool Results

**Сохраняются в:**
```
~/.claude/projects/<project>/1f9ed5f8-0087-4916-a9bc-e2042fb9b3c3/tool-results/
└── toolu_013AR4kk8ZG5hy9LrNq27TQi.txt
```

**Для больших выводов** (чтобы не раздувать JSONL)

### Shell Snapshots

**Файлы:** `snapshot-zsh-<timestamp>-<random>.sh`

**Содержимое:**
```bash
# Snapshot file
unalias -a 2>/dev/null || true

# Functions
claude-c() { ... }   # Continue без аргументов
claude-r() { ... }   # Resume с session ID
claude-s() { ... }   # Resume из буфера обмена

# Aliases, variables, etc.
```

**Назначение:** Сохранение shell-окружения (функции, aliases)

### Команды CLI

```bash
claude                                    # Новая сессия
claude --continue                         # Продолжить последнюю
claude --resume <session-id>              # Восстановить конкретную
claude --dangerously-skip-permissions     # Без подтверждений
```

**НЕТ интерактивных команд** типа `/save` `/resume` (как в Gemini)

### Механизм восстановления

**Автоматический:**
- Claude читает `<UUID>.jsonl` из `~/.claude/projects/<project>/`
- Восстанавливает контекст из всех строк JSONL
- Загружает tool-results по ссылкам

**Ручной:**
```bash
cd /project/directory
claude --resume <session-id>
```

### History.jsonl (глобальный)

**Формат:**
```jsonl
{"display":"command text","pastedContents":{},"timestamp":1759215209802,"project":"/Users/fedor/Desktop/..."}
```

**Назначение:** Глобальная история всех команд (для статистики?)

### Settings

```json
{
  "alwaysThinkingEnabled": true,
  "feedbackSurveyState": {
    "lastShownTime": 1754452110006
  },
  "model": "sonnet"
}
```

### Текущее состояние

**Установлено:** ✅ `/opt/homebrew/bin/claude` v2.0.64

**Текущий проект:** `/Users/fedor/Desktop/custom-terminal`

**Активных сессий:** 47 файлов (включая agents)

**Общий размер сессий:** 2433 строк JSONL

**Текущая сессия:** `1f9ed5f8-0087-4916-a9bc-e2042fb9b3c3`

---

## 🔍 XTERM.JS (текущий терминал)

### Установленные addons

```json
{
  "@xterm/addon-fit": "^0.10.0",
  "@xterm/addon-web-links": "^0.11.0",
  "@xterm/addon-webgl": "^0.19.0",
  "@xterm/xterm": "^5.5.0"
}
```

### ❌ НЕ установлено

**`@xterm/addon-serialize`** - нужен для сохранения визуального буфера

### Текущая реализация

**main.js:**
```javascript
const pty = require('node-pty');
terminals.set(tabId, {
  pty: ptyProcess,
  pid: ptyProcess.pid,
  cwd: cwd
});
```

**renderer.js:**
```javascript
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebglAddon } = require('@xterm/addon-webgl');

term = new Terminal({...});
term.loadAddon(fitAddon);
term.loadAddon(new WebglAddon());
```

**IPC:**
```javascript
ipcRenderer.send('terminal:input', tabId, data);       // PTY stdin
ipcRenderer.send('terminal:executeCommand', tabId, cmd); // Auto-command
```

---

## 🎯 ЧТО МЫ ЗНАЕМ (РЕЗЮМЕ)

### Gemini CLI

✅ **Полностью изучено:**
- Структура checkpoint JSON
- Hash механизм (SHA-256)
- "Trojan Horse" метод переноса
- Команды `/chat save/list/resume`
- Патчинг путей и хешей

❓ **Неизвестно:**
- Есть ли API для создания checkpoint программно
- Можно ли патчить JSON без запуска CLI

### Claude Code

✅ **Полностью изучено:**
- Структура JSONL сессий
- Формат сообщений (parentUuid chain)
- Tool results persistence
- Shell snapshots
- Команды `--resume --continue`
- Проект-специфичное хранение

❓ **Неизвестно:**
- Что в `session-env/<UUID>/` папках (пустые)
- Можно ли создать JSONL вручную
- Как работает автовосстановление контекста

### Xterm.js

✅ **Известно:**
- Установлены: fit, web-links, webgl addons
- PTY через node-pty
- IPC коммуникация работает

❌ **НЕ установлено:**
- `@xterm/addon-serialize` (нужен для visual layer)

### Noted Terminal

✅ **Готово:**
- SQLite база (projects, tabs, global_commands, gemini_history)
- PTY управление
- IPC handlers
- Metadata сохранение

❌ **НЕ готово:**
- Сохранение xterm буфера
- Checkpoint management для Gemini
- Session persistence для Claude
- Перенос между директориями

---

## 🚀 MVP АРХИТЕКТУРА (2 уровня)

### Level 1: Visual Layer (простой)

**Цель:** Видеть старый текст терминала при перезапуске

**Инструменты:**
- `@xterm/addon-serialize` (npm install)

**Реализация:**
```javascript
// При закрытии таба
const { SerializeAddon } = require('@xterm/addon-serialize');
const serializer = new SerializeAddon();
term.loadAddon(serializer);
const buffer = serializer.serialize();

// Сохранить в SQLite
db.prepare('UPDATE tabs SET terminal_buffer = ? WHERE id = ?')
  .run(buffer, tabId);

// При открытии таба
term.write(savedBuffer);
```

**Результат:** "Мертвый" текст, но визуально на месте

---

### Level 2: Brain Layer (сложный)

**Цель:** Полное восстановление AI контекста

#### Для Gemini CLI

**Таблица в SQLite:**
```sql
CREATE TABLE gemini_checkpoints (
  id INTEGER PRIMARY KEY,
  project_id TEXT,
  tag TEXT,
  checkpoint_json TEXT,  -- Полный JSON
  original_hash TEXT,    -- Старый hash
  created_at INTEGER
);
```

**Сохранение:**
```javascript
async function saveGeminiCheckpoint(projectPath, tag) {
  // 1. Отправить команду
  ptyProcess.write(`/chat save ${tag}\r`);
  await sleep(2000);

  // 2. Найти файл
  const hash = calculateSHA256(projectPath);
  const file = `~/.gemini/tmp/${hash}/checkpoint-${tag}.json`;

  // 3. Прочитать и сохранить в БД
  const content = fs.readFileSync(file, 'utf-8');
  db.prepare('INSERT INTO gemini_checkpoints ...')
    .run(projectId, tag, content, hash);
}
```

**Восстановление ("Trojan Horse"):**
```javascript
async function restoreGeminiCheckpoint(projectPath, tag) {
  // 1. Создать легальную оболочку
  ptyProcess.write(`gemini\r`);
  await sleep(500);
  ptyProcess.write(`hi\r`);
  await sleep(500);
  ptyProcess.write(`/chat save ${tag}\r`);
  await sleep(1000);
  ptyProcess.write(`/exit\r`);

  // 2. Найти созданный файл
  const newHash = calculateSHA256(projectPath);
  const trojanFile = `~/.gemini/tmp/${newHash}/checkpoint-${tag}.json`;

  // 3. Загрузить из БД
  const saved = db.prepare('SELECT checkpoint_json, original_hash FROM ...')
    .get(projectId, tag);

  // 4. Патчить и подменить
  let content = saved.checkpoint_json;
  content = content.replace(new RegExp(saved.original_hash, 'g'), newHash);
  content = content.replace(/\/old\/path/g, projectPath);
  fs.writeFileSync(trojanFile, content);

  // 5. Запустить и восстановить
  ptyProcess.write(`gemini\r`);
  await sleep(500);
  ptyProcess.write(`/chat resume ${tag}\r`);
}
```

#### Для Claude Code

**Таблица в SQLite:**
```sql
CREATE TABLE claude_sessions (
  id INTEGER PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  jsonl_content TEXT,  -- Весь JSONL
  cwd TEXT,
  git_branch TEXT,
  created_at INTEGER
);
```

**Сохранение:**
```javascript
async function saveClaudeSession(projectPath) {
  // 1. Найти активную сессию
  const projectKey = projectPath.replace(/\//g, '-');
  const sessionFiles = fs.readdirSync(`~/.claude/projects/${projectKey}/`)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

  // 2. Прочитать последнюю сессию
  const latest = sessionFiles[sessionFiles.length - 1];
  const content = fs.readFileSync(`~/.claude/projects/${projectKey}/${latest}`, 'utf-8');

  // 3. Сохранить в БД
  const sessionId = latest.replace('.jsonl', '');
  db.prepare('INSERT INTO claude_sessions ...')
    .run(projectId, sessionId, content, projectPath, gitBranch);
}
```

**Восстановление:**
```javascript
async function restoreClaudeSession(projectPath, sessionId) {
  // 1. Загрузить из БД
  const saved = db.prepare('SELECT jsonl_content, cwd FROM ...')
    .get(projectId, sessionId);

  // 2. Создать файл в ~/.claude/projects/
  const projectKey = projectPath.replace(/\//g, '-');
  const targetFile = `~/.claude/projects/${projectKey}/${sessionId}.jsonl`;

  // 3. Патчить пути в JSONL
  let lines = saved.jsonl_content.split('\n');
  lines = lines.map(line => {
    if (!line) return line;
    const obj = JSON.parse(line);
    if (obj.cwd) obj.cwd = projectPath;
    return JSON.stringify(obj);
  });

  // 4. Записать
  fs.writeFileSync(targetFile, lines.join('\n'));

  // 5. Запустить
  // cd в projectPath уже сделан через PTY
  ptyProcess.write(`claude --resume ${sessionId}\r`);
}
```

---

## 📊 ГОТОВНОСТЬ К MVP

### ✅ Готово (40%)

1. SQLite инфраструктура
2. PTY управление
3. IPC коммуникация
4. Metadata сохранение
5. Понимание механизмов Gemini/Claude

### ⏳ Требуется (60%)

1. **Visual Layer (3-4 часа):**
   - Установить `@xterm/addon-serialize`
   - Добавить поле `terminal_buffer` в таблицу `tabs`
   - Сохранение при закрытии
   - Восстановление при открытии

2. **Brain Layer - Gemini (6-8 часов):**
   - Таблица `gemini_checkpoints`
   - SHA-256 hash функция
   - "Trojan Horse" implementation
   - UI кнопки Save/Restore

3. **Brain Layer - Claude (4-6 часов):**
   - Таблица `claude_sessions`
   - JSONL парсинг
   - Path patching
   - UI кнопки Save/Restore

4. **Перенос между директориями (2-3 часа):**
   - Path replacement логика
   - Hash recalculation
   - Validation

---

## 🔧 СЛЕДУЮЩИЕ ШАГИ

### Вариант A: Быстрый MVP (3-4 часа)
**Только Visual Layer**

### Вариант B: Полный MVP (15-20 часов)
**Visual Layer + Brain Layer (Gemini + Claude)**

### Вариант C: Поэтапный (по неделям)
1. Неделя 1: Visual Layer + Gemini
2. Неделя 2: Claude + Перенос директорий
3. Неделя 3: Полировка UI

---

**Дамп завершен. Все технические знания задокументированы.**
