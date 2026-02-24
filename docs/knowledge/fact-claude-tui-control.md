# Факт: Управление Claude Code TUI из приложения

## Проблема
Claude Code CLI работает на базе Ink (React TUI) в raw mode с включённым **bracketed paste mode**. Это означает:
- `\r` (CR) и `\n` (LF), отправленные через PTY → **не сабмитят ввод**, а создают новую строку
- Обычный `\t` (Tab) → не переключает thinking mode (нужен `meta+t`)
- Slash-команды (`/model`, `/compact` и т.д.) — обычный текстовый ввод, парсится после Enter

## Решение: Bracketed Paste + Delayed Enter

### Отправка команд (IPC `claude:send-command`)
Выполняется через универсальный механизм `safePasteAndSubmit` (см. ниже).

**Почему именно так:**
- Ctrl+C безопаснее Ctrl+U — очищает многострочный ввод, одиночное нажатие не выходит из Claude
- Paste brackets нужны потому что Ink в raw mode иначе обрабатывает каждый символ как keypress
- `\r` внутри paste brackets → новая строка. `\r` **после** paste end → submit
- Delay между paste и Enter нужен чтобы Ink успел обработать paste event в React render cycle

### Переключение модели
```js
ipcRenderer.send('claude:send-command', tabId, '/model sonnet');
// Aliases: sonnet, opus, haiku — работают мгновенно, без рестарта
```

Текущая модель определяется из bridge-данных (`claude:bridge-update` → `data.model`).

## Реактивное управление TUI через синхронизацию

### Особенности парсинга Claude Code TUI
1. **Sync Markers (\x1b[?2026h/l):** Современные TUI (включая Claude) используют эти маркеры для обозначения границ кадра отрисовки. 
    - **Правило:** Любой парсинг буфера (меню истории, пикер модели) должен начинаться только ПОСЛЕ детекции `\x1b[?2026l` (конец кадра).
2. **Проблема исчезновения пробелов:** Claude TUI не всегда использует `0x20` (пробел). Вместо этого часто шлется `\x1b[NC` (cursor forward). 
    - **Правило:** Перед очисткой VT-символов необходимо заменять `\x1b[(\d*)C` на соответствующее количество пробелов. Иначе текст склеится (`каксейчасработает`).
3. **Детекция готовности инпута:** После выполнения команд (например, `/model` или откат), нужно ждать отрисовки промпт-бокса. Признак готовности — появление в кадре символов `╰` (низ бокса), `⏵` или `>`.

## Rewind Automation (Откат истории)

### Симптомы (при сбоях)
При восстановлении истории слова могут слипаться в одну строку без пробелов (`каксейчасработает`), либо курсор навигации в TUI-меню "промахивается" мимо нужной записи, из-за чего сессия откатывается не в ту точку или закрывается с ошибкой.

Для программного отката используется IPC `claude:open-history-menu`.

**Алгоритм навигации:**
1. **Открытие:** Отправить `\x03` (Ctrl+C) → `\x1b` (Esc) → `\x1b` (Esc).
2. **Парсинг:** Ждать sync marker, извлечь список записей.
3. **Сопоставление (Text Match):** Найти нужную запись по префиксу текста сообщения.
4. **Синхронная навигация:** Каждое нажатие `Arrow Up` верифицируется — система ждет новый кадр и проверяет, что курсор `❯` переместился на нужную строку.
5. **Подтверждение:** Отправить `\r` (Enter) для выбора точки отката.

**Очистка и вставка:**
После отката Claude часто сохраняет старое сообщение в инпуте.
1. **Wait for prompt:** Ждем полной отрисовки промпта (sync marker + `╰`).
2. **Clear:** Отправить `\x03` (Ctrl+C).
3. **safePasteAndSubmit:** Вставить сжатое резюме чанками по 900 байт, дожидаясь подтверждения отрисовки каждого чанка через sync marker.
4. **Submit:** Отправить `\r`.

## Решение: safePasteAndSubmit (Programmatic Chunked Paste)

**⚠️ КРИТИЧЕСКОЕ ПРАВИЛО: macOS TTYHOG = 1024 bytes.**
Ядро macOS режет любой `term.write()` > 1024 байт. Это создает три уровня проблем:
1. **Kernel Split:** Escape-последовательность `\x1b[201~` может быть разорвана между вызовами `read()`.
2. **Ink Parsing:** Ink не имеет полноценного стейт-машины для bracketed paste. Он парсит байты через `parseKeypress()` и при разрыве последовательности может проигнорировать её или интерпретировать как обычный текст.
3. **React Batching Race:** Даже если paste дошел целиком, React батчит обновления стейта. Если `\r` (Enter) приходит слишком быстро после paste (в том же микротаске), обработчик `onSubmit` увидит **старый (пустой) стейт**, так как ре-рендер еще не произошел.

### ⚠️ ВАЖНО: safePasteAndSubmit ≠ user paste (Ctrl+V)

`safePasteAndSubmit` — это функция **только для программных операций**, где наш код отправляет текст напрямую в PTY (минуя xterm.js) и сразу шлёт Enter. Она **НЕ используется** в обработчике `terminal:input` (user paste).

**Два разных пути:**

| | User Paste (Ctrl+V) | Programmatic Paste |
|---|---|---|
| **Путь** | xterm.js (добавляет brackets) → `terminal:input` → simple chunking | Наш код → `safePasteAndSubmit` → `term.write()` напрямую |
| **xterm.js** | В цепи (сам добавляет brackets) | Не участвует |
| **Enter** | Человек жмёт (секунды спустя) | Код шлёт (миллисекунды) |
| **Sync markers** | Не нужны | Обязательны |

**Почему в `terminal:input` нельзя было использовать `safePasteAndSubmit`:**
1. Обычные терминалы (bash/zsh) не шлют sync markers → 5-сек таймаут на каждый чанк.
2. xterm.js уже добавил brackets → `safePasteAndSubmit` создавала второй слой → двойное обрамление.

Подробнее: `knowledge/fact-fact-terminal-core.md` (секция "Двухуровневая система вставки").

### Алгоритм `safePasteAndSubmit`:
1. **Chunking:** Контент делится на чанки по ~900 байт.
2. **Bracketed Wrap:** Каждый чанк оборачивается в ПОЛНЫЙ `\x1b[200~` + chunk + `\x1b[201~`. Итоговый размер каждого `term.write()` < 1024 байт, что гарантирует атомарную доставку в PTY.
3. **Sync Marker Verification:** После каждого чанка система слушает PTY и ждёт `\x1b[?2026l` (sync marker). Это подтверждает, что Ink обработал вставку, React выполнил стейт-апдейт и отрендерил кадр.
4. **Submit:** `\r` отправляется только после подтверждения последнего чанка. Это гарантирует, что `onSubmit` прочитает уже зафиксированный в стейте текст.

### Где используется
- **Handshake:** Автоотправка default prompt при запуске Claude.
- **send-command:** `/model sonnet`, `/compact` и др. из UI.
- **Rewind:** Вставка compact-резюме после отката.

**Почему не Text Echo:** Ink коллапсирует большие вставки в строку вида `[Pasted text #N +M lines]`, поэтому проверять наличие самого текста в выводе невозможно. Только sync markers гарантируют успех.

## Реактивное управление Think Mode

### Почему не просто отправить команду
Think mode переключается через `meta+t` (`\x1bt` = ESC + t), но это открывает **TUI пикер** с двумя опциями:
1. Enabled ✔ / Disabled
2. "Enter to confirm · Esc to exit"

При переключении mid-conversation Claude показывает **второй диалог** подтверждения: "Do you want to proceed?"

### Реактивный алгоритм (IPC `claude:toggle-thinking`)
```
1. Отправить \x1bt (meta+t)                  — открыть пикер
2. Слушать PTY, копить буфер
3. Детект \x1b[?2026l (synchronized output end)  — пикер готов
4. stripVTControlCharacters(buffer)           — получить чистый текст
5. Найти позиции "Enabled", "Disabled", "✔"  — определить текущее состояние
6. Отправить стрелку (\x1b[B вниз или \x1b[A вверх) — перейти на другую опцию
7. Слушать PTY → первый ответ = Ink перерисовал  — стрелка обработана
8. Отправить \r                               — подтвердить выбор
9. Слушать PTY → если "proceed" в тексте       — второй диалог подтверждения
10. Отправить \r                              — подтвердить proceed
```

**Ключевые маркеры PTY:**
- `\x1b[?2026h` — начало synchronized output (Ink рисует)
- `\x1b[?2026l` — конец synchronized output (Ink закончил, можно парсить)
- `✔` (U+2714) — галочка активной опции
- `❯` — курсор выбора в пикере
- "proceed" — маркер второго диалога подтверждения

**Определение текущего состояния:**
```
enabledIdx  = clean.indexOf('Enabled')
disabledIdx = clean.indexOf('Disabled')
checkIdx    = clean.indexOf('✔')
wasEnabled  = |checkIdx - enabledIdx| < |checkIdx - disabledIdx|
```

### UI отображение
Кнопка "toggle" в InfoPanel. После переключения показывает "think on" / "think off" фиолетовым цветом (#b4b9f9) на 3 секунды.

## Handshake (Prompt Injection при запуске)

### Текущая версия (упрощённая)
```
WAITING_PROMPT → DEBOUNCE_PROMPT → send prompt → done
```

Thinking mode при запуске **не отправляется** через Handshake — это делает `alwaysThinkingEnabled: true` in `~/.claude/settings.json` глобально.

### Шаги
1. **WAITING_PROMPT:** Ждёт prompt-символа (`⏵` или `>`) в PTY output через `stripVTControlCharacters()`
2. **DEBOUNCE_PROMPT:** 300ms тишины (Ink рисует UI, может быть несколько чанков)
3. **Send prompt:** Bracketed paste + delayed `\r` (тот же паттерн что и `claude:send-command`)

### Что убрано (v2 → v3)
- **TAB_SENT / DEBOUNCE_TAB** — отправка `\t` для thinking mode. Стало ненужным с `alwaysThinkingEnabled: true`
- Было 4 состояния, стало 2

## Code Map
- **Main (send command):** `src/main/main.js` — IPC `claude:send-command`
- **Main (history menu / rewind):** `src/main/main.js` — IPC `claude:open-history-menu`
- **Main (think toggle):** `src/main/main.js` — IPC `claude:toggle-thinking` (handle)
- **Main (handshake):** `src/main/main.js` — стейт-машина `claudeState` в `ptyProcess.onData`
- **Renderer (UI):** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — кнопки модели + think toggle
- **Bridge script:** `~/.claude/statusline-bridge.sh` — источник данных о текущей модели
- **Settings:** `~/.claude/settings.json` — `alwaysThinkingEnabled`, `statusLine`
