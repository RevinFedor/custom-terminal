# Auto — Тестовая инфраструктура Noted Terminal

```
auto/
├── context.md                     # Entry point для AI-агента (читать первым)
├── playwright/                    # Фреймворк E2E: Playwright + Electron
│   ├── basics.md                  # Шаблоны, селекторы, ожидания, hover, формат вывода
│   └── electron.md                # Electron-специфика: env, clipboard, IPC, build sync, logs
├── libraries/                     # Цели: специфика тестирования конкретных подсистем
│   ├── xterm.md                   # xterm.js: селекторы, readiness, ввод, OSC 133
│   ├── zustand-store.md           # Zustand: чтение store, поля таба, event-driven polling
│   └── browser-tab.md             # BrowserTab: activeView, webview focus, URL sync
├── core/                          # Код: launcher, electron helpers
│   ├── launcher.js                # Запуск Electron, env cleanup, log capture, wait-хелперы
│   └── electron.js                # Хелперы: clipboard, focus, webContents, insertText
├── fixtures/                      # Фикстуры для тестов (golden sessions, mock data)
│   └── gemini-rewind-session.json # Golden session (13 messages) для Gemini rewind
├── stable/                        # Рабочие тесты (проходят, можно запускать для регрессии)
│   ├── test-sniper-handshake.js   # [E2E+Claude] Sniper + Handshake: Session ID detection
│   ├── test-ctrlc-danger-zone.js  # [E2E+Claude] Ctrl-C: детекция "again to exit"
│   ├── test-ctrlc-rapid-model-switch.js # [E2E+Claude] Быстрая смена моделей
│   ├── test-timeline.js           # [E2E+Claude] Timeline: точки, парсинг DOM
│   ├── test-rewind-navigation.js  # [E2E+Claude] Rewind: TUI-навигация, RGB поиск
│   ├── test-session-export.js     # [E2E+Claude] Export: backtrace, форматирование
│   ├── test-plan-mode-detect.js   # [E2E+Claude] Plan Mode: Clear Context, смена сессий
│   ├── test-history-restore.js    # [E2E] History: восстановление из SQLite ⚠️ BROKEN
│   ├── test-gemini-rewind.js      # [E2E+Fixture] Gemini Rewind: /rewind, зеленое меню
│   ├── test-gemini-timeline.js    # [E2E+Fixture] Gemini Timeline: рендер, IPC, slug/hash
│   └── test-gemini-timeline-nav.js # [E2E+Fixture] Gemini: клик по точкам + скролл
├── sandbox/                       # Эксперименты и отладка
└── screenshots/                   # Артефакты тестов
```

## Два уровня тестирования

### Уровень 1: Headless (без Electron)
Чистый Node.js + headless xterm.js. Тестирует **логику** изолированно.
- **Скорость:** < 1 секунда
- **Детерминированность:** 100% — синтетические данные, нет таймаутов
- **Запуск:** `node auto/sandbox/test-osc-boundary-markers.js`
- **Когда:** State machines, парсеры, алгоритмы поиска, маркеры

```javascript
// Паттерн headless теста
const { Terminal } = require('@xterm/xterm')
const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })

// Синтетические данные
await new Promise(r => term.write('⏵ hello\r\nResponse...\r\n⏵', r))

// Проверка (без таймаутов!)
assert(markers.size === 1, 'Marker created')
term.dispose()
```

### Уровень 2: E2E (Electron + Playwright)
Реальное приложение с реальным TUI. Тестирует **интеграцию**.
- **Скорость:** 15-60 секунд
- **Детерминированность:** Зависит от подхода (см. "Ожидания" ниже)
- **Запуск:** `node auto/stable/test-gemini-timeline.js` (нужен `npm run dev`)
- **Когда:** DOM-рендеринг, IPC, реальный парсинг TUI, контекстные меню

### Почему E2E обязателен (урок "Подожди")

Headless тест может пройти 22/22, но пропустить реальный баг:
- **Синтетические данные:** тест предполагает что в буфере 7503 символов сообщения
- **Реальный TUI:** Gemini обрезает сообщения в отображении до ~137 символов с префиксом ` > `
- **Результат:** `scrollToTextInBuffer` не находит текст, хотя headless тест утверждает что всё работает

**Правило:** Если тест проверяет взаимодействие с реальным TUI (Claude/Gemini) — нужен E2E. Headless тесты ловят логические ошибки, E2E ловит расхождения между моделью и реальностью.

## Ожидания: event-driven, не таймауты

### Принцип
Приложение event-driven (OSC 133 → IPC → Zustand store → React). Тесты должны ждать **те же сигналы**, а не слепые `waitForTimeout`.

### Сигналы в порядке приоритета

| Сигнал | Источник | Пример использования |
|--------|----------|---------------------|
| **Zustand store** | `page.waitForFunction(() => store.tabs.get(id).claudeSessionId)` | Ждать появления Claude session ID |
| **OSC 133 логи** | `findInLogs(mainProcessLogs, 'Prompt ready (A)')` | Ждать готовности shell |
| **BoundaryMarker логи** | `findInLogs(mainProcessLogs, /BoundaryMarker.*prompt #\d/)` | Ждать ответа Claude (промт вернулся) |
| **DOM элементы** | `page.waitForSelector('div[style*="border-radius: 50%"]')` | Ждать Timeline точки |
| **Store CWD** | `page.waitForFunction((dir) => tab.cwd?.includes(dir), targetDir)` | Ждать обновления CWD после `cd` |
| **Tab count** | `page.waitForFunction((prev) => tabs.size > prev, countBefore)` | Ждать создания нового таба |

### Анти-паттерн: слепые таймауты

```javascript
// ПЛОХО — 66 таких мест в текущих тестах:
await page.waitForTimeout(15000)  // "ждём ответ Claude"
await page.waitForTimeout(2000)   // "ждём cd"
await page.waitForTimeout(1500)   // "ждём новый таб"

// ХОРОШО — ждём сигнал:
await waitForMainProcessLog(mainProcessLogs, /BoundaryMarker.*prompt #\d/, 30000)
await page.waitForFunction((dir) => /* tab.cwd.includes(dir) */, targetDir)
await page.waitForFunction((prev) => /* tabs.size > prev */, countBefore)
```

### Допустимые фиксированные задержки
- `100ms` между набором и Enter (keyboard simulation)
- `300ms` для анимации контекстного меню
- `8000ms` retry после падения Electron (реальное время восстановления)

## Специфика тестов

### 1. Парсинг терминала (xterm.js)
Для чтения текста из терминала используется `page.evaluate` с обходом `.xterm-rows > div`.
- **Нюанс:** Текст в DOM разбит на `span` с разными стилями → `textContent` для джойна.
- **Индексация:** Последние строки могут быть пустыми → `.slice(-30).filter(line => line.trim())`.
- **Truncation:** Gemini TUI обрезает длинные сообщения. В буфере может быть 137 chars вместо 7503 из JSON.

### 2. Timeline DOM
- **Поиск точек:** По ширине (`23px`) и `border-radius: 50%`.
- **Async Timing:** Используй `waitForClaudeSessionId` (event-driven) вместо `waitForTimeout(12000)`.

### 3. Rewind & TUI Navigation
- **Sync Markers:** После `Esc` система ждёт `\x1b[?2026l]`.
- **RGB Matching:** Зеленый `166;227;161m` для выделения в меню.
- **Deterministic:** `waitForPtyText(term, textOrRegex, timeout)` вместо `drainPtyData(ms)`.

### 4. Plan Mode & Session Links
- **Polling:** Zustand store `claudeSessionId` через `page.waitForFunction()`.
- **SQLite Bridge:** Main процесс записывает связь сессий в БД.

### 5. Golden Session Pattern
Для Gemini тестов — стратегия клонирования готовой сессии из `auto/fixtures/`:
- Тест копирует fixture в `~/.gemini/tmp/` → мгновенный старт с заполненным таймлайном.
- Не зависит от AI-ответов и сетевых задержек.

### 6. OSC 7777 Prompt Boundary Markers (новое)
State machine в main.js инжектирует невидимые OSC маркеры в PTY-поток:
- **Логика:** `IDLE (промт)` → `BUSY (ответ AI)` → `IDLE (промт вернулся)` → инжекция `\x1b]7777;prompt:N\x07`
- **xterm.js:** `parser.registerOscHandler(7777)` создаёт `registerMarker(0)` на точной строке
- **Timeline:** Entry N привязывается к marker N-1 (entry 0 не имеет маркера)
- **Headless тест:** `auto/sandbox/test-osc-boundary-markers.js` (39/39)
- **Только Claude:** Gemini использует alternate buffer, маркеры не применимы

## Известные проблемы (2026-02-27)

| Тест | Статус | Причина |
|------|--------|---------|
| `test-history-restore.js` | BROKEN | `setCurrentView` отсутствует в store API |
| `test-gemini-rewind.js` | 11/12 | Golden fixture drift: ожидает 13 entries, IPC возвращает 11 |
| E2E общее | WARNING | `MaxListenersExceededWarning` при 8+ сохранённых табах |
| E2E общее | WARNING | `projectManager.getAIPrompts is not a function` |

## Запуск

```bash
# Headless тесты (без Electron, без dev server)
node auto/sandbox/test-osc-boundary-markers.js
node auto/sandbox/test-gemini-scroll-sameline.js

# E2E тесты (требуют npm run dev + electron-vite build)
npm run dev   # → http://localhost:5182
npx electron-vite build   # синхронизировать dist/ с src/

node auto/stable/test-gemini-timeline.js
node auto/stable/test-gemini-rewind.js
node auto/stable/test-sniper-handshake.js
```

Launcher поднимает **отдельный Electron-инстанс** (не трогает основной).

### Параллельный запуск (важно для субагентов)

Основной Noted Terminal может быть запущен одновременно с тестовым — **это нормально**.

**Типичная ошибка:** `electron.launch: Process failed to launch!`. Причина — конкуренция за SQLite (`better-sqlite3` WAL mode блокирует write). Тестовый инстанс зависает на инициализации `projectManager`.

**Правила для субагентов:**
- Таймаут bash-команды: **минимум 180 секунд**
- Если launch упал — подождать **10 секунд** и повторить (до 3 раз)
- Не пытаться убивать основной экземпляр
- Для диагностики: `pgrep -lf "Electron.*custom-terminal" | wc -l`

---

Ссылка на `auto/context.md` размещается в `CLAUDE.md` проекта как опциональный раздел. AI читает его только когда задача связана с тестированием.
