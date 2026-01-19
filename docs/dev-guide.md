# Developer Guide

## Быстрый старт

### 1. Установка
```bash
npm install
```

### 2. Запуск
```bash
npm start
```

### 3. Перестройка native модулей (если node-pty не работает)
```bash
npm run rebuild
```

## Команды NPM

| Команда | Описание |
|---------|----------|
| `npm start` | Запуск приложения |
| `npm run dev` | Запуск с hot-reload (nodemon) |
| `npm run dev:css` | Watch режим для Tailwind CSS |
| `npm run build:css` | Сборка Tailwind CSS (минифицированный) |
| `npm run rebuild` | Пересборка node-pty для текущей версии Node |
| `npm run build` | Сборка приложения (electron-builder) |
| `npm run dist` | Сборка для macOS в папку |

## Структура проекта

```
custom-terminal/
├── main.js                  # Главный процесс Electron
├── renderer.js              # Рендерер (UI, терминал, Gemini)
├── project-manager.js       # Менеджер проектов (JSON storage)
├── index.html               # HTML структура
├── input.css                # Tailwind исходный файл
├── output.css               # Tailwind скомпилированный
├── package.json             # Dependencies & scripts
├── assets/                  # Шрифты, иконки
│   └── fonts/
├── docs/                    # Документация (Gold Standard v3.4)
└── build-resources/         # Ресурсы для сборки (иконки)
```

## Разработка

### Hot Reload
```bash
npm run dev
```
Автоматически перезапускает Electron при изменении файлов (main.js, renderer.js, index.html).

### Tailwind CSS
**Watch mode (для разработки):**
```bash
npm run dev:css
```

**Build (для коммита):**
```bash
npm run build:css
```

### DevTools
- `Cmd + Option + I` — открыть DevTools
- `Cmd + R` — перезагрузить окно

## Архитектура

### IPC Communication
- `terminal:create` — создать PTY процесс
- `terminal:input` — отправить input в PTY
- `terminal:data` — получить output из PTY
- `terminal:resize` — изменить размер PTY
- `terminal:kill` — убить PTY процесс
- `project:get` — получить данные проекта
- `project:save-*` — сохранить данные проекта

### Data Storage
```bash
~/Library/Application Support/custom-terminal/projects.json
```

**Schema:**
```json
{
  "/absolute/path/to/project": {
    "id": "base64-encoded-path",
    "name": "Project Name",
    "description": "Optional description",
    "geminiPrompt": "Custom AI prompt template",
    "notes": { "global": "..." },
    "quickActions": [...],
    "tabs": [...]
  }
}
```

## Troubleshooting

### node-pty не работает
```bash
npm run rebuild
```

### Tailwind изменения не применяются
```bash
npm run build:css
```

### Терминал не отображается
1. Проверь DevTools Console на ошибки
2. Проверь что шрифт загружен: `document.fonts.check("14px 'JetBrainsMono NF'")`
3. См. `docs/troubleshooting/001-font-loading-race.md`

### WebGL не работает
```javascript
// В DevTools Console:
const term = Array.from(tabs.values())[0]?.terminal;
const renderer = term._core._renderService._renderer._value;
console.log(Object.keys(renderer)); // Должен содержать _gl
```

---

# Debug Guide

## Debug Scripts Location
All debug scripts are in project root:
- `debug-60s.js` - 60-second monitoring (recommended)
- `debug-commands.js` - Basic checks
- `debug-performance.js` - Font and write frequency
- `debug-webgl.js` - WebGL renderer verification
- `debug-claude-cli.js` - Claude CLI specific

## How to Use Debug Scripts

1. Open the terminal app
2. Press `Cmd+Option+I` to open DevTools
3. Go to Console tab
4. Copy entire content of debug script
5. Paste and press Enter
6. Follow script instructions (usually: run a command and wait)

## Key Metrics to Check

### 1. Font Check
```javascript
getComputedStyle(document.querySelector('.xterm')).fontFamily
```
**Expected:** `'JetBrainsMono NF', monospace`
**Bad:** `-apple-system, ...` (see troubleshooting/font-loading-race-condition.md)

### 2. WebGL Check
```javascript
const term = Array.from(tabs.values())[0]?.terminal;
const renderer = term._core._renderService._renderer._value;
console.log(Object.keys(renderer));
```
**Expected:** Should contain `_gl`, `_glyphRenderer`
**Bad:** No WebGL properties = falling back to canvas

### 3. Write Frequency (use debug-60s.js)
After running Claude CLI for 60 seconds:
```
Gaps < 10ms: 0        // GOOD - buffer working
Gaps < 10ms: 150      // BAD - buffer not working or FLUSH_DELAY too low
```

### 4. Buffer Type
```javascript
term.buffer.active.type
```
**Expected:** `normal` for inline CLI tools
**Note:** `alternate` means app took over screen (like vim)

## Diagnostic Flowchart

```
Problem: Terminal jitters/flickers
                |
                v
    Is font correct? (check computed font)
        |               |
       YES             NO
        |               |
        v               v
    Is WebGL active?   Fix font loading
        |               (see troubleshooting/)
       YES
        |
        v
    Run debug-60s.js with problematic CLI
        |
        v
    Check "Gaps < 10ms"
        |               |
       = 0            > 0
        |               |
     Buffer OK      Buffer not working
        |               |
        v               v
    Issue elsewhere   Check FLUSH_DELAY
                      Check write handler
```

## Console Warnings to Watch

- `WebGL addon failed to load` - GPU issue, will fall back to canvas
- `Font load failed` - Check font path in input.css
- `JetBrainsMono NF not loaded` - Font not ready, init may have wrong metrics

## Performance Tab Usage

1. Open DevTools > Performance
2. Click Record
3. Use terminal (type, run commands)
4. Stop recording
5. Check:
   - **Scripting** high = JS bottleneck
   - **Rendering** high = too many repaints
   - **GPU** active = WebGL working

## Useful Console Commands

```javascript
// Get current tab's terminal
const term = Array.from(tabs.values())[0]?.terminal;

// Check all terminal options
console.log(term.options);

// Check char metrics
console.log(term._core._charSizeService);

// Force terminal refresh
term.refresh(0, term.rows - 1);

// Check buffer state
console.log({
  type: term.buffer.active.type,
  cursorX: term.buffer.active.cursorX,
  cursorY: term.buffer.active.cursorY,
  viewportY: term.buffer.active.viewportY
});
```
