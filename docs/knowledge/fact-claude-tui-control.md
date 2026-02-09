# Факт: Управление Claude Code TUI из приложения

## Проблема
Claude Code CLI работает на базе Ink (React TUI) в raw mode с включённым **bracketed paste mode**. Это означает:
- `\r` (CR) и `\n` (LF), отправленные через PTY → **не сабмитят ввод**, а создают новую строку
- Обычный `\t` (Tab) → не переключает thinking mode (нужен `meta+t`)
- Slash-команды (`/model`, `/compact` и т.д.) — обычный текстовый ввод, парсится после Enter

## Решение: Bracketed Paste + Delayed Enter

### Отправка команд (IPC `claude:send-command`)
```
1. Ctrl+C (\x03)                          — очистка текущего ввода (даже многострочного)
2. 50ms delay
3. \x1b[200~ + command + \x1b[201~        — paste brackets (Ink принимает как вставку)
4. 100ms delay
5. \r                                      — Enter отдельно от paste (Ink обрабатывает как submit)
```

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

Thinking mode при запуске **не отправляется** через Handshake — это делает `alwaysThinkingEnabled: true` в `~/.claude/settings.json` глобально.

### Шаги
1. **WAITING_PROMPT:** Ждёт prompt-символа (`⏵` или `>`) в PTY output через `stripVTControlCharacters()`
2. **DEBOUNCE_PROMPT:** 300ms тишины (Ink рисует UI, может быть несколько чанков)
3. **Send prompt:** Bracketed paste + delayed `\r` (тот же паттерн что и `claude:send-command`)

### Что убрано (v2 → v3)
- **TAB_SENT / DEBOUNCE_TAB** — отправка `\t` для thinking mode. Стало ненужным с `alwaysThinkingEnabled: true`
- Было 4 состояния, стало 2

## Code Map
- **Main (send command):** `src/main/main.js` — IPC `claude:send-command`
- **Main (think toggle):** `src/main/main.js` — IPC `claude:toggle-thinking` (handle)
- **Main (handshake):** `src/main/main.js` — стейт-машина `claudeState` в `ptyProcess.onData`
- **Renderer (UI):** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — кнопки модели + think toggle
- **Bridge script:** `~/.claude/statusline-bridge.sh` — источник данных о текущей модели
- **Settings:** `~/.claude/settings.json` — `alwaysThinkingEnabled`, `statusLine`
