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
│   └── test-ctrlc-rapid-model-switch.js # Claude: быстрая смена моделей под нагрузкой
├── sandbox/                       # Одноразовые эксперименты и дебаг
└── screenshots/                   # Артефакты тестов
```

**playwright/** = инструмент. Как пользоваться Playwright в Electron-среде. Ограничения фреймворка, workaround'ы, паттерны ожиданий.

**libraries/** = цель. Как тестировать конкретную подсистему. Специфика DOM-структуры, событий, состояний. Один файл = одна библиотека/подсистема.

**stable/** — тесты которые прошли и работают. Можно запускать для регрессии.

**sandbox/** — одноразовые скрипты для отладки. Тест прошёл → переносить в `stable/`.

Тест: "Это ограничение Playwright или особенность тестируемой подсистемы?"
- Hover не срабатывает через `mouse.move()` → **playwright/basics.md** (эффект телепортации)
- `waitForFunction` на Zustand store → **libraries/zustand-store.md** (как читать store)
- OSC 133 не приходит → **libraries/xterm.md** (command lifecycle)
- `CLAUDECODE` блокирует запуск → **playwright/electron.md** (env изоляция)
- `dist/` не обновляется → **playwright/electron.md** (build sync)

## Запуск

```bash
# Требование: dev server должен быть запущен
npm run dev   # → http://localhost:5182

# Запуск напрямую через node (launcher сам проверит dev server)
node auto/stable/test-sniper-handshake.js
node auto/sandbox/test-timeline.js
```

Launcher поднимает **отдельный Electron-инстанс** (не трогает основной), делает проверки, закрывает.

---

Ссылка на `auto/context.md` размещается в `CLAUDE.md` проекта как опциональный раздел. AI читает его только когда задача связана с тестированием.
