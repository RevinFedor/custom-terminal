# Session Research - 2026-01-19

---

## ЧАСТЬ 1: EXPORT (РАБОТАЕТ)

### Что работает

Export Gemini сессий **полностью функционален**.

### Flow

1. Пользователь запускает Gemini CLI в терминале
2. Ведёт диалог
3. Нажимает "Export" в UI → вводит имя сессии
4. Приложение отправляет `/chat save <name>` в терминал
5. Ждёт подтверждение "checkpoint saved" в выводе терминала
6. Читает файл из `~/.gemini/tmp/<SHA256(cwd)>/checkpoint-<name>.json`
7. Сохраняет в SQLite БД

### Ключевые решения

**1. Проблема с Enter в Interactive CLI**

Когда отправляешь команду в Gemini CLI через `term.write(command + '\r')` или `\n` — Enter не срабатывал.

**Причина:** Gemini CLI (Node.js) работает в Raw Mode. Когда текст прилетает слишком быстро, CLI считает это "paste" и не триггерит событие Enter.

**Решение:** Разделить отправку текста и Enter с задержкой:
```javascript
// main.js - terminal:executeCommand
term.write(command);           // Сначала текст
setTimeout(() => {
  term.write('\r');            // Через 150ms - Enter
}, 150);
```

**2. Hash директории**

Gemini хранит данные в `~/.gemini/tmp/<SHA256(absolute_cwd)>/`:
```javascript
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update(absolutePath).digest('hex');
```

**3. Использование tabCwd вместо projectPath**

При Export нужно использовать **текущую директорию таба** (cwd), а не корень проекта, потому что Gemini считает hash от cwd где был запущен.

```javascript
const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
// Используем tabCwd для расчёта hash
```

**4. Умное ожидание вместо фиксированной задержки**

Вместо `await sleep(3000)` слушаем terminal:data и ждём паттерн:
```javascript
const waitForTerminalPattern = (pattern, timeout) => {
  return new Promise(resolve => {
    const handler = (event, { data }) => {
      if (data.includes(pattern)) {
        resolve(true);
      }
    };
    ipcRenderer.on('terminal:data', handler);
    setTimeout(() => resolve(false), timeout);
  });
};

// Ждём подтверждения
await waitForTerminalPattern('checkpoint saved', 10000);
```

**5. Auto-create project**

Если проект не существует в БД при сохранении сессии — создаём автоматически:
```javascript
// database.js - saveAISession
if (!project) {
  this.createProject(normalizedPath);
  project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);
}
```

### Файлы

- `src/main/main.js` - IPC handlers (`terminal:executeCommand`, `session:export-gemini`)
- `src/main/session-manager.js` - `exportGeminiSession()`
- `src/main/database.js` - `saveAISession()`, `getAllAISessions()`
- `src/renderer/components/Workspace/panels/SessionsPanel.tsx` - UI Export

---

## ЧАСТЬ 2: IMPORT (В ПРОЦЕССЕ)

### Текущая проблема

Import **НЕ работает корректно**. Команды отправляются в терминал, но Enter не нажимается.

### Что пытались

**Метод 1: Direct Injection (НЕ РАБОТАЕТ)**

Просто записать файл в `~/.gemini/tmp/<hash>/checkpoint-<name>.json` и вызвать `/chat resume <name>`.

**Почему не работает:** Gemini CLI ведёт внутренний реестр чекпоинтов. Если просто положить файл — CLI его не видит при `/chat resume`.

**Метод 2: Trojan Horse (В ПРОЦЕССЕ)**

1. Запустить `gemini`
2. Отправить dummy сообщение (создать сессию)
3. `/chat save <tag>` → Gemini **регистрирует** тег в своей БД
4. **Перезаписать** созданный файл нашим контентом (с патчингом путей)
5. `/chat resume <tag>` → загружает нашу подменённую сессию

**Текущая реализация:**
```javascript
// SessionsPanel.tsx - importGeminiSession

// Phase 2: Start Gemini
await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, 'gemini');
await waitForTerminalPattern('type your message', 15000);

// Phase 3: Dummy message
await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, 'init');
await waitForTerminalPattern('>', 10000);

// Phase 4: Create shell checkpoint
await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, `/chat save ${sessionKey}`);
await waitForTerminalPattern('checkpoint saved', 10000);

// Phase 5: Patch file
await ipcRenderer.invoke('session:patch-checkpoint', { targetCwd, sessionKey, patchedContent });

// Phase 6: Resume
await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, `/chat resume ${sessionKey}`);
```

### Проблемы

**1. Race Condition**

Изначально использовали `ipcRenderer.send('terminal:executeCommand')` который асинхронно планировал setTimeout для Enter. Следующая команда отправлялась до того как Enter предыдущей был нажат.

**Решение:** Создали `terminal:executeCommandAsync` через `invoke` который возвращает Promise:
```javascript
ipcMain.handle('terminal:executeCommandAsync', async (event, tabId, command) => {
  term.write(command);
  await new Promise(r => setTimeout(r, 150));  // Ждём
  term.write('\r');
  await new Promise(r => setTimeout(r, 100));  // Ждём обработки
  return { success: true };
});
```

**2. Enter всё равно не срабатывает**

Даже с async версией команды — Enter не нажимается в Gemini CLI.

Логи показывают:
```
[main] command: /chat save session-123
[main] ✅ Command text sent, waiting 150ms before Enter...
[main] ✅ Enter (\r) sent!
```

Но в терминале команда просто висит в поле ввода.

### Следующие шаги для отладки

1. **Попробовать посимвольный ввод** — эмуляция человеческой печати:
```javascript
for (const char of command) {
  term.write(char);
  await sleep(10);
}
await sleep(150);
term.write('\r');
```

2. **Попробовать \r\n вместо \r**

3. **Проверить что terminal:data правильно слушается** — возможно паттерны не находятся и timeouts срабатывают раньше

4. **Добавить больше логов** в waitForTerminalPattern

### Файлы

- `src/main/main.js` - `terminal:executeCommandAsync`, `session:patch-checkpoint`
- `src/main/session-manager.js` - `importGeminiSession()`, `patchCheckpointFile()`
- `src/renderer/components/Workspace/panels/SessionsPanel.tsx` - Trojan Horse flow

---

## Глобальные сессии и Deployments

### Что сделано

1. **Сессии теперь глобальные** — видны во всех проектах, не только в том где созданы

2. **Таблица session_deployments** — отслеживает куда сессия была импортирована:
```sql
CREATE TABLE session_deployments (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  deployed_cwd TEXT NOT NULL,
  deployed_hash TEXT,
  deployed_at INTEGER
);
```

3. **UI показывает locations** — каждая сессия показывает список папок где доступна

### API

```javascript
// Получить все сессии глобально
const sessions = await ipcRenderer.invoke('session:list', { global: true });
// sessions[0].locations = ['/path/a', '/path/b']
```

---

## Ключевые файлы проекта

```
src/main/main.js                 - IPC handlers
src/main/session-manager.js      - Export/Import логика
src/main/database.js             - SQLite (ai_sessions, session_deployments)
src/renderer/components/Workspace/panels/SessionsPanel.tsx - UI
docs/tmp-session-persistence-research.md - Детальное исследование Gemini internals
```
