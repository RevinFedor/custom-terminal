# Experience: Advanced Automation Pitfalls & Guidelines

## 1. Terminal Readiness & Shell Synchronization

### Проблема (The Pitfall)
Тесты часто падают с ошибкой "Timeout" или вводят команды "в никуда", потому что пытаются взаимодействовать с терминалом сразу после открытия окна приложения. В Electron-терминале существует задержка между появлением UI и готовностью PTY-процесса (`node-pty`) принять ввод.

### Симптомы
- Команды `page.keyboard.type()` не отображаются в терминале.
- Тест не видит ожидаемого ответа на команду.
- Случайные падения на этапе инициализации.

### Решение
Никогда не начинайте ввод без явного ожидания готовности шелла. В проекте это реализуется через ожидание символа промпта:

```javascript
// ПЛОХО:
await page.keyboard.type('npm run dev'); 

// ХОРОШО:
const terminal = page.locator('.xterm-rows');
await expect(terminal).toContainText('%', { timeout: 10000 }); // Ждём zsh промпт
await page.keyboard.type('npm run dev');
await page.keyboard.press('Enter');
```

---

## 2. Zombie Processes & Resource Cleanup

### Проблема
При падении теста или аварийном завершении процесса Playwright, инстанс Electron может "зависнуть" в памяти. Это приводит к блокировке портов (5173, 5182) и конфликтам доступа к SQLite базе данных.

### Симптомы
- Ошибка "EADDRINUSE" при запуске следующего теста.
- База данных заблокирована (Database is locked).
- Тесты ведут себя странно, так как используют "хвосты" предыдущих сессий.

### Решение
1.  **Принудительная очистка:** В скриптах запуска (`run.sh`) всегда добавляйте команду очистки перед стартом.
2.  **Graceful Shutdown:** В коде теста используйте блоки `try/finally` или хуки `afterEach`.

```javascript
// Скрипт очистки в терминале:
pkill -f "Electron" || true

// В коде теста:
try {
  // логика теста
} finally {
  await electronApp.close();
}
```

---

## 3. IPC Data Structure Mismatch

### Проблема
Контракты IPC (Inter-Process Communication) в проекте могут меняться. Часто разработчик ожидает, что IPC вернет чистые данные (например, контент файла), в то время как бэкенд возвращает объект обертку `{ success, content, error }`.

### Причина
Эволюция архитектуры. Переход от простых возвратов к типизированным ответам с обработкой ошибок часто забывают отразить в тестовых моках.

### Пример балованного теста:
```javascript
// БЫЛО (тест падает, так как content — это [object Object]):
const content = await ipcRenderer.invoke('file:read', path);
expect(content).toContain('scripts');

// СТАЛО (правильная обработка структуры):
const result = await ipcRenderer.invoke('file:read', path);
if (!result.success) throw new Error(result.error);
expect(result.content).toContain('scripts');
```

---

## 4. CWD Context & Environment Isolation

### Проблема
Команды, вводимые в терминал в ходе теста, выполняются в текущей рабочей директории (CWD) процесса PTY. По умолчанию это может быть домашняя папка пользователя, а не корень проекта, что ломает работу AI-агентов (Claude/Gemini).

### Решение
Первым шагом любого интеграционного теста должен быть принудительный переход в нужную директорию. Не полагайтесь на настройки по умолчанию.

```javascript
// Рекомендуемый паттерн начала теста:
await page.keyboard.type(`cd ${process.cwd()}`);
await page.keyboard.press('Enter');
// Ожидаем подтверждения смены пути (через OSC 7 или текст промпта)
```

---

## 5. Debugging Headless Mode

### Проблема
В режиме `headless: true` невозможно увидеть, что происходит на экране, а логи Renderer-процесса часто теряются.

### Решение
Используйте перехват консоли в лаунчере для вывода всех логов в один поток терминала. Это позволяет видеть ошибки React прямо в логах теста.

```javascript
// В лаунчере (core/launcher.js):
window.on('console', (msg) => {
  console.log(`[Renderer] ${msg.text()}`);
});
```

## Checklist для написания новых тестов:
1. [ ] Выполнена команда `npx electron-vite build`?
2. [ ] Добавлено ожидание промпта `%` перед вводом?
3. [ ] Проверена структура ответов IPC (success/content)?
4. [ ] Выполнен `cd` в целевую директорию?
5. [ ] Настроен `steps` для перемещений мыши (hover)?
6. [ ] Обеспечено закрытие приложения в блоке `finally`?
