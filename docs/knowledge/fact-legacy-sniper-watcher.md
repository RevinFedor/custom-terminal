# ФАКТ: Sniper Watcher (Legacy Detection Method)

> ⚠️ **УСТАРЕЛО (DEPRECATED):** Этот метод признан нестабильным при работе с параллельными сессиями в одной директории. 
> С февраля 2026 года заменен на **StatusLine Bridge** (см. `docs/architecture.md`).
> Логика сохранена для истории и возможного использования в изолированных окружениях.

## Суть метода (Historical Logic)
Механизм проактивного захвата UUID сессии при запуске Claude Code. Использовался до внедрения системных хуков и StatusLine.

### Алгоритм "Снайпера"
1. **Snapshot:** Перед запуском PTY-процесса фиксируется список существующих `.jsonl` файлов в директории `~/.claude/projects/<slug>/`. Это позволяет отличить новый файл от старого.
2. **Dual-Method Detection:**
   - **fs.watch:** Мгновенная реакция на событие создания файла (может быть ненадёжным на macOS из-за задержки инициализации FSEvents).
   - **Polling (1с):** Фоновый опрос `readdirSync` каждую секунду как надёжный fallback.
3. **Валидация:** Файл должен соответствовать UUID-паттерну, отсутствовать в snapshot и иметь `birthtime >= startTime - 1000ms`.
4. **Bridge Filtering (v2):** Чтение первых 2KB файла для проверки `entry.sessionId === filename`. Если не совпадает — это bridge-файл (Clear Context) от другой параллельной сессии, он игнорировался.

### Код-прототип (Main Process)
```javascript
function startSessionSniper(projectDir, startTime, onDetected) {
  const existingFiles = new Set(fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')));
  let sessionFound = false;

  const checkFile = (filename) => {
    if (sessionFound || !filename.endsWith('.jsonl') || existingFiles.has(filename)) return;
    
    const filePath = path.join(projectDir, filename);
    const stats = fs.statSync(filePath);
    if (stats.birthtimeMs < startTime - 1000) return;

    // Bridge Filter
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString().split('
')[0];
    const entry = JSON.parse(firstLine);
    
    if (entry.sessionId === filename.replace('.jsonl', '')) {
      sessionFound = true;
      onDetected(entry.sessionId);
    }
  };

  const watcher = fs.watch(projectDir, (event, filename) => {
    if (filename) checkFile(filename);
  });

  const interval = setInterval(() => {
    fs.readdirSync(projectDir).forEach(checkFile);
  }, 1000);
}
```

## Почему мы от него отказались
1. **Race Condition:** При параллельной работе двух сессий в одной папке, если одна делает `Clear Context` ровно в момент старта второй, Снайпер второй сессии ловит bridge-файл первой.
2. **Polling Overhead:** Постоянный опрос ФС (даже 1с) создает лишнюю нагрузку.
3. **Delayed Detection:** Снайпер ловит файл только после первого сообщения пользователя (когда файл физически создается).
4. **Availability:** StatusLine Bridge дает 100% точность привязки к PID и мгновенно сообщает о смене ID при Clear Context/Plan Mode.
