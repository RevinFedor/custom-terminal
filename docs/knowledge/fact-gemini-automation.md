# AI Gemini Automation: Resume, Detection, Injection & Fork

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

## 2. Sniper Watcher (Auto-Capture)
Sniper — фоновый процесс, следящий за активностью Gemini CLI.

### Динамический резолвинг (v0.30+)
Ранее Sniper следил за жестко заданным списком SHA256-директорий. Теперь он использует `resolveGeminiProjectDir`:
1. При запуске `gemini` в табе Sniper запрашивает slug проекта через `projects.json`.
2. Путь наблюдения (`fs.watch`) динамически переключается на `~/.gemini/tmp/<slug>/chats/`.
3. Это позволяет мгновенно подхватывать новые сессии даже в проектах, которые только что были проиндексированы Gemini CLI.

---

## 3. Handshake Strategy
**Файл-источник:** `fix-gemini-cli-automation.md`

### Problems
1. **Fake Prompt**: Gemini CLI (Ink) draws `>` instantly, but internal loop is still busy.
2. **Error "Slash commands cannot be queued"**: Happens if command sent during "Generating" state.

### Solutions
- **Method A: HIDE Cursor Detection (Primary)**: Gemini hides cursor (`\x1b[?25l`) when ready for input. This is the fastest and most accurate method.
- **Method B: Silence Detection (Fallback)**: Wait for 1500-2000ms pause in PTY data stream.

---

## 4. Session Restore: From "Trojan Horse" to Direct Injection
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

## 5. Поддержка Truecolor (24-bit) в терминале

### Проблема
Интерфейсы на базе Ink (Gemini CLI, Claude Code) выглядели тусклыми (16/256 цветов), несмотря на поддержку Canvas рендерера.

### Причина
Многие современные CLI проверяют переменную окружения `COLORTERM`. Если она не установлена в `truecolor`, они переходят в режим совместимости с ограниченной палитрой.

### Решение
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

### Результат
Терминал корректно отображает яркие 24-битные цвета, что критично для визуального разделения блоков кода и системных сообщений AI-агентов.

---

## 6. Почему Gemini -r не является форком (True Fork)

### Problem
Первоначальная попытка реализовать `gemini-f` через простую команду `gemini -r <sessionId>` в новой вкладке привела к конфликту состояний.

### Symptoms
- Две вкладки работают с одним и тем же JSON-файлом в `~/.gemini/tmp/`.
- Сообщения из одной вкладки появляются в другой после перезапуска.
- Нарушается линейность диалога, сессия становится "битой".

### Cause
Gemini CLI привязывает сессию к конкретному файлу. Команда `-r` просто открывает этот файл. Если две копии CLI пишут в один файл одновременно, результат непредсказуем.

### Solution: True Fork
Реализован механизм физического клонирования состояния на уровне Main-процесса:
1. Поиск оригинального файла `session-*.json` по UUID.
2. Копирование файла под новым именем.
3. **Патчинг JSON:** Изменение поля `sessionId` внутри файла на новый UUID. Это критически важно, так как Gemini валидирует соответствие имени файла и внутреннего ID.
4. Запуск новой копии CLI с новым UUID.

### Результат
Каждая вкладка получает свой независимый файл сессии, что позволяет вести разные ветки диалога из одной точки.
