# ОПЫТ: Sniper Watcher — Dual-Method Detection

## Проблема
Старый Sniper использовал только `fs.watch` с таймаутом 5 секунд. Проблемы:
1. **macOS FSEvents задержка:** `fs.watch` на macOS может пропускать события из-за задержки инициализации FSEvents — файл создан, но событие не пришло.
2. **5с таймаут слишком мал:** Claude CLI создаёт `.jsonl` файл только после первого обмена. Без Default Prompt пользователь может думать дольше 5 секунд.
3. **Нет защиты от старых файлов:** Watcher мог поймать старый файл, если его `birthtime` совпадала по таймингу.

## Решение: `startSessionSniper()`
Выделена отдельная функция с тремя улучшениями:

### 1. Snapshot (защита от ложных срабатываний)
```js
const existingFiles = new Set();
const files = fs.readdirSync(projectDir);
for (const f of files) {
  if (uuidPattern.test(f)) existingFiles.add(f);
}
```
Все существующие UUID-файлы фиксируются **до** запуска Claude. Файл из snapshot игнорируется даже если `fs.watch` отправит на него событие.

### 2. Dual-Method Detection
- **fs.watch:** Мгновенная реакция (когда работает).
- **setInterval 1с:** `readdirSync` + проверка на новые файлы (вне snapshot). Надёжный fallback.
Оба метода вызывают один и тот же `checkFile()`, который устанавливает `sessionFound` lock.

### 3. Таймаут 30с
Достаточно для ожидания первого сообщения пользователя. После таймаута cleanup закрывает и watcher, и polling.

## Использование
```js
// В claude:run-command (case 'claude'):
startSessionSniper(projectDir, Date.now(), (sessionId) => {
  event.sender.send('claude:session-detected', { tabId, sessionId });
});

// В claude:spawn-with-watcher:
startSessionSniper(projectDir, startTime, (sessionId) => {
  event.sender.send('claude:session-detected', { tabId, sessionId });
});
```

## Результат
Надёжный захват sessionId на macOS. При fs.watch failure polling подхватывает. Старые файлы не ловятся благодаря snapshot.
