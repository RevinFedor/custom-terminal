# Ops Guide: Infrastructure

## 1. Разработка (Dev)
- `npm run dev` — запуск приложения с hot-reload.
- Tailwind обрабатывается Vite-плагином; отдельного `dev:css` в текущем package.json нет.
- `npm run _rebuild` — текущий pinned `node-pty` build/verification path; обычный generic rebuild не заменяет его packaging proof.
- **После `npm install <native-module>`** — `npx electron-rebuild -f -w <module> --only <module>`. Без `--only` падает на других native-deps (`better-sqlite3` не собирается на Xcode 26 из-за `libexpat`), целевой модуль рядом не пересоберётся. См. [`fix-electron-native-rebuild-trap.md`](fix-electron-native-rebuild-trap.md) — там же про restore `.node` из `/Applications/Noted Terminal.app` когда rebuild не вариант.

## 2. Сборка (Build)
- `npm run build` — сборка через electron-builder.
- Текущий target — directory `.app`; отдельного `dist` script/готового DMG pipeline здесь нет.
- Публичный source checkout имеет собственные переносимые build/setup-команды. Не применять его `build:app` как описание private certificate-backed install: [граница публикации](fact-public-source-publication.md).

## 3. Пути данных
- **DB:** `~/Library/Application Support/noted-terminal/noted-terminal.db`
- **Config:** `~/Library/Application Support/noted-terminal/projects.json`
- **Logs (Dev):** `<project_root>/logs/dev.log`
- **Logs (Production):** `~/Library/Logs/noted-terminal/production.log` (через `app.getPath('logs')`). См. [`fix-packaged-app-logs.md`](fix-packaged-app-logs.md).
- **AI History:** `~/.minayu/history/` — снепшоты Gemini Time Machine.
- **Claude Bridge:** `~/.claude/bridge/` — временные JSON-файлы для идентификации активных сессий Клода.

## 4. Отладка (Debug)
Скрипты отладки находятся в корне проекта:
- `debug-60s.js` — мониторинг производительности.
- `debug-claude-cli.js` — отладка интеграции с Claude Code.

### File logger — часть resource budget

Поток `dev.log` / `production.log` не имеет права удерживать неограниченную очередь в RAM. `Writable.write(false)` означает «запись принята, внутренний буфер заполнен»; до `drain` новые records идут в свою bounded очередь: максимум 256 строк / 512 KiB. При переполнении отдельные noisy diagnostics теряются, но после `drain` пишется агрегат `[LogBackpressure] droppedLines/droppedBytes`. Это осознанный выбор: потерять часть шума, но не превратить logger в memory leak.

Ротация идёт на startup по возрасту или размеру; порог размера — 64 MiB. Инцидентные файлы до этого контракта вырастали примерно до 1.7 GB в production и 125 MB в dev. Их вклад в наблюдавшийся 19-GB пик не был измерен, поэтому logger — доказанный риск-множитель, но не единолично доказанный root cause. Renderer `main.tsx` уже форвардит каждую tagged console-line в `log:renderer`; component не должен посылать ту же строку вторым explicit IPC. History до фикса дублировал каждую diagnostic обоими путями.

**Категории логов (localStorage.debug):**
- `app:gemini` — детальная отладка Sniper Watcher, True Fork и Time Machine.
- `app:claude` — сессии Клода.
- `app:tabs` — управление вкладками.

## 5. Тестирование
В проекте используется двухуровневая система тестирования.

### 1. Unit-тесты TUI (Headless)
Для тестирования логики парсинга, OSC-маркеров и алгоритмов поиска в буфере используются изолированные Node.js скрипты на базе `@xterm/headless`.
- **Преимущество:** 100% стабильность, не зависят от состояния БД и графического окружения macOS.
- **Пример:** `node auto/sandbox/test-osc-boundary-markers.js`.

### 2. Интеграционные тесты (Playwright)
Используются для проверки сквозных сценариев (UI + Main process).
- **Файлы:** `auto/stable/` и `auto/sandbox/`.
- **Запуск:**
```bash
# Запуск конкретного теста
./auto/run.sh sandbox/test-timeline.js
```

**Важно:** Если тест проверяет низкоуровневый поток данных PTY (маркеры, навигация), приоритет отдается Headless Unit-тестам. Playwright используется только для верификации визуальных состояний React и IPC-взаимодействия.

### Отладка
Тесты автоматически выводят логи из Renderer и Main процессов в консоль терминала с префиксами `[Renderer]` и `[Main]`.
