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

### Model Switching & Queueing
Gemini CLI не поддерживает очередь команд (ошибка "Slash commands cannot be queued"). 
- **Mechanism:** В `main.js` реализована `geminiCommandQueue` для каждого таба.
- **Execution:** Кнопки моделей (pro/flash) вызывают `gemini:send-command`. Система ждет `HIDE CURSOR` (`\x1b[?25l`) или окно тишины перед отправкой следующей команды. Это гарантирует, что команда `/model` уйдет только тогда, когда CLI готов.

---

## 4. Gemini Rewind Flow (Deterministic Navigation)

Для автоматизации меню `/rewind` приложение отказалось от слепых пауз «тишины» (`drainPtyData`) в пользу **детерминированного ожидания** конкретных маркеров через функцию `waitForPtyText`.

### Алгоритм синхронизации
1. **Загрузка меню:** После отправки `/rewind\r` система ждет появления текста `Stay at current position` или символа `╰──` (нижний угол бокса).
2. **Навигация (UP/DOWN):** Каждое нажатие клавиши верифицируется появлением ANSI-последовательности зеленого цвета (`\x1b[38;2;166;227;161m`). Если после нажатия UP в течение 2с данные не пришли (0B) — достигнута верхняя граница истории.
3. **Подтверждение:** После Enter система ждет текст `Rewind conversation` или `Do nothing` (последний пункт диалога подтверждения).
4. **Завершение:** Финальная готовность определяется по возврату статус-бара (маркеры `shift+tab`, `INSERT` или `NORMAL`).

### Особенности буфера
Поскольку Gemini CLI использует **Alternate Screen Buffer**, стандартные маркеры xterm.js (`registerMarker`) в этом режиме не работают. Поэтому навигация в Gemini всегда использует текстовый поиск по буферу (Heuristic Search), в то время как Claude использует детерминированные OSC-маркеры.

### Визуальная синхронизация (scrollToTextInBuffer)
После успешного отката вызывается `scrollToTextInBuffer`. Поскольку Gemini CLI (Ink TUI) при перерисовке может "выбрасывать" пользователя в случайную часть буфера, система сканирует буфер xterm.js на наличие текста восстановленного сообщения и принудительно скроллит терминал к этой позиции. Это критично для бесшовного UX, чтобы пользователь видел именно ту точку истории, на которую он нажал.

---

## 5. Safe Input & Control (Danger Zone)
 Стандартный `Ctrl+C` в Gemini CLI часто приводит к мгновенному выходу из процесса («Terminated»), что фатально для активной сессии.
- **Очистка ввода:** Для очистки длинных промптов в терминале вместо `Ctrl+C` используется связка `Ctrl+A` (в начало) + `Ctrl+K` (удалить до конца). Это позволяет очистить инпут, оставаясь внутри интерактивной сессии.

---

## 6. Golden Session Pattern (Test Optimization)
Для ускорения автотестов и UI-дебага используется паттерн «Золотой сессии».
- **Механика:** Вместо того чтобы каждый раз отправлять 10-20 промптов через PTY (что занимает до 60 секунд), тест один раз создает эталонную сессию.
- **Клонирование:** Последующие тесты используют `gemini-f` (True Fork) для мгновенного клонирования этой сессии.
- **Результат:** Время подготовки окружения сокращается с 40-60с до 2-3с, что критично для стабильности Playwright-тестов.

---

## 7. Session Restore: From "Trojan Horse" to Direct Injection
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
