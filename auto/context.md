# Auto — Тестовая инфраструктура Noted Terminal

```
auto/
├── context.md                     # Entry point для AI-агента (читать первым)
├── playwright/                    # Фреймворк: как писать и запускать тесты
│   ├── basics.md                  # Шаблоны, селекторы, ожидания, hover, формат вывода
│   └── electron.md                # Electron-специфика: env, clipboard, IPC, build sync, logs
├── libraries/                     # Цели: специфика тестирования конкретных подсистем
│   ├── xterm.md                   # xterm.js: селекторы, readiness, ввод, OSC 133
│   ├── zustand-store.md           # Zustand: чтение store, поля таба, event-driven polling
│   └── browser-tab.md             # BrowserTab: activeView, webview focus, URL sync
├── core/                          # Код: launcher, electron helpers
│   ├── launcher.js                # Запуск Electron, env cleanup, log capture, wait-хелперы
│   └── electron.js                # Хелперы: clipboard, focus, webContents, insertText
├── stable/                        # Рабочие тесты (проходят, можно запускать повторно)
│   ├── test-sniper-handshake.js   # Sniper + Handshake: Claude Session ID detection
│   ├── test-ctrlc-danger-zone.js  # Ctrl-C: детекция "again to exit" и блокировка
│   ├── test-ctrlc-rapid-model-switch.js # Claude: быстрая смена моделей под нагрузкой
│   ├── test-timeline.js           # Timeline: запуск Claude, появление точек, парсинг DOM
│   ├── test-rewind-navigation.js  # Rewind: сложная TUI-навигация, RGB поиск, откат
│   ├── test-session-export.js     # Export: работа backtrace, форматирование кода/диффов
│   ├── test-plan-mode-detect.js   # Plan Mode: детекция Clear Context и смены сессии
│   ├── test-history-restore.js    # History: восстановление вкладок из SQLite
│   └── test-gemini-rewind.js      # Gemini Rewind: нативный /rewind, парсинг зеленого меню
├── sandbox/                       # Одноразовые эксперименты и дебаг
└── screenshots/                   # Артефакты тестов
```

**playwright/** = инструмент. Как пользоваться Playwright в Electron-среде. Ограничения фреймворка, workaround'ы, паттерны ожиданий.

**libraries/** = цель. Как тестировать конкретную подсистему. Специфика DOM-структуры, событий, состояний. Один файл = одна библиотека/подсистема.

**stable/** — тесты которые прошли и работают. Можно запускать для регрессии.

**sandbox/** — одноразовые скрипты для отладки. Тест прошёл → переносить в `stable/`.

## Специфика сложных тестов (Terminal & Timeline)

Тестирование AI-интерфейсов (Claude TUI) требует особого подхода из-за инкрементального рендеринга и ANSI-кодов.

### 1. Парсинг терминала (xterm.js)
Для чтения текста из терминала используется `page.evaluate` с обходом `.xterm-rows > div`. 
- **Нюанс:** Текст в DOM часто разбит на мелкие `span` с разными стилями. Нужно джойнить их через `textContent`.
- **Индексация:** Последние строки в DOM могут быть пустыми — используй `.slice(-30)` и `.filter(line => line.trim())`.

### 2. Взаимодействие с Timeline
- **DOM Check:** Точки таймлайна ищутся по ширине (`16px`) и наличию `border-radius: 50%`.
- **Async Timing:** Claude может инициализировать сессию до 10-15 секунд. Используй `waitForClaudeSessionId` из `launcher.js` с таймаутом 35с+.

### 3. Rewind & TUI Navigation (Критично)
Тестирование отката по истории (`test-rewind-navigation.js`) — самый сложный сценарий:
- **Sync Markers:** После нажатия `Esc` для открытия меню, система ДОЛЖНА дождаться маркера готовности отрисовки `\x1b[?2026l`.
- **RGB Matching:** В тестах навигации по меню используется анализ сырого PTY-вывода на предмет Lavender цвета (`177;185;249m`).
- **Safety:** Тест должен имитировать ввод нескольких команд (например, ALPHA, BRAVO, CHARLIE), чтобы создать историю, а затем проверять точность возврата к первой.

### 4. Plan Mode & Session Links
Тест `test-plan-mode-detect.js` проверяет "невидимые" связи:
- **Polling:** Отслеживает смену `claudeSessionId` в Zustand store после того, как пользователь выбирает "Clear Context" в Claude.
- **SQLite Bridge:** Проверяет, что Main процесс успел записать связь сессий в БД до того, как Timeline попытается их джойнить.

### 5. Zustand Store Polling
Для проверки захвата сессий тесты читают состояние напрямую из window:
```javascript
const tab = window.useWorkspaceStore.getState().openProjects.get(projectId).tabs.get(tabId);
```
Это надёжнее, чем ждать изменений в DOM, так как Store обновляется мгновенно.

## Специфика регрессионного тестирования

### Миграция Gemini (Slug vs Hash)
При тестировании Gemini-функционала необходимо проверять оба сценария:
1. **Legacy:** Отсутствие проекта в `projects.json` (проверка работы через SHA256).
2. **Modern:** Наличие slug-а (проверка корректного резолвинга через индекс).
Тест `test-gemini-timeline.js` имитирует оба состояния, подменяя содержимое домашней директории в тестовом окружении.

### Синхронизация UUID (Timeline Sync)
Для исключения багов рассинхронизации:
- Тест должен скроллить `HistoryPanel` до середины.
- Проверять, что в `useWorkspaceStore` массив `historyVisibleUuids` содержит именно те ID, которые отображаются как выделенные точки в Timeline.
- **Критично:** UUID должны иметь формат `${sessionId}-msg-${index}` при отсутствии нативного ID.

## Запуск

```bash
# Требование: dev server должен быть запущен
npm run dev   # → http://localhost:5182

# Запуск напрямую через node (launcher сам проверит dev server)
node auto/stable/test-sniper-handshake.js
node auto/stable/test-timeline.js
node auto/stable/test-rewind-navigation.js
node auto/stable/test-plan-mode-detect.js
```

Launcher поднимает **отдельный Electron-инстанс** (не трогает основной), делает проверки, закрывает.

### Параллельный запуск (важно для субагентов)

Основной Noted Terminal может быть запущен одновременно с тестовым — **это нормально**. Launcher создаёт второй Electron-инстанс параллельно.

**Типичная ошибка:** `electron.launch: Process failed to launch!` / `kill EPERM`. Это НЕ фатально — случается из-за конкуренции за ресурсы (файлы БД, порты DevTools) при параллельном запуске.

**Правила для субагентов:**
- Таймаут bash-команды: **минимум 180 секунд** (тесты с Electron запускаются 15-30 сек)
- Если launch упал — подождать **10 секунд** и повторить (до 3 раз)
- Не пытаться убивать основной экземпляр — тесты ДОЛЖНЫ работать параллельно
- Для диагностики: `pgrep -lf "Electron.*custom-terminal" | wc -l` (обычно 5-8 процессов у основного)

---

Ссылка на `auto/context.md` размещается в `CLAUDE.md` проекта как опциональный раздел. AI читает его только когда задача связана с тестированием.
