# Runtime Tests - Playwright for Electron

Автоматизированное E2E тестирование Noted Terminal с помощью Playwright.

---

## 📖 Документация

- **[WORKFLOW.md](./WORKFLOW.md)** - 🔥 **НАЧНИ ЗДЕСЬ!** Итеративный подход к разработке тестов
- **[INTERPRETING-RESULTS.md](./INTERPRETING-RESULTS.md)** - Как читать результаты тестов
- **README.md** (этот файл) - Быстрый старт и референс

---

## 🎯 Что тестируется

1. **UI Elements** - Sessions tab, кнопки экспорта/импорта
2. **Modals** - Модальные окна ввода
3. **Session Export** - Экспорт Gemini/Claude сессий
4. **Toast Notifications** - Всплывающие уведомления
5. **Logs Capture** - Main + Renderer process логи
6. **Screenshots** - Автоматические снимки на каждом шаге

---

## 🚀 Быстрый старт

### 1. Установка (уже сделано)

```bash
npm install --save-dev @playwright/test playwright
```

### 2. Запуск всех тестов

```bash
npm run test:e2e
```

Или напрямую:

```bash
cd runtime-tests
npx playwright test
```

### 3. Запуск с UI (headed mode)

```bash
npx playwright test --headed
```

### 4. Запуск конкретного теста

```bash
npx playwright test session-export.spec.ts
```

### 5. Дебаг с пошаговым выполнением

```bash
npx playwright test --debug
```

---

## 📊 Результаты

После запуска тестов:

### 1. HTML Report (визуальный отчет)

```bash
npx playwright show-report results/playwright-report
```

Откроется в браузере с:
- ✅/❌ Результаты каждого теста
- 📸 Скриншоты
- 📹 Видео (если тест упал)
- 📋 Логи

### 2. Скриншоты

Сохраняются в `results/`:
- `01-initial-state.png` - Стартовое состояние
- `02-sessions-panel-open.png` - Открытая панель Sessions
- `03-export-modal-open.png` - Модальное окно
- `04-entering-session-name.png` - Ввод имени сессии
- `05-export-result.png` - Результат экспорта
- `06-list-sessions.png` - Список сессий

### 3. Логи

Все логи (Main + Renderer) сохраняются в `results/test-logs.txt`:

```
===== MAIN PROCESS LOGS =====
[main] terminal:create called with tabId: ...
[SessionManager] ===== EXPORT GEMINI SESSION =====
[SessionManager] Looking for checkpoint at: ...

===== RENDERER PROCESS LOGS =====
[log] [Session] Export started...
[log] [SessionManager] Files in gemini tmp dir: [...]
```

---

## 🧪 Структура тестов

### `session-export.spec.ts`

```typescript
test.describe('Session Persistence Tests', () => {
  test('should display Sessions tab', async () => { ... });
  test('should open Sessions panel', async () => { ... });
  test('should display session management buttons', async () => { ... });
  test('should open modal when Export Gemini clicked', async () => { ... });
  test('should show error if session not found', async () => { ... });
  test('should list saved sessions', async () => { ... });
});

test.describe('Log Analysis', () => {
  test('should not have critical errors in logs', async () => { ... });
  test('should log SessionManager operations', async () => { ... });
});
```

---

## 🔧 Конфигурация

### `playwright.config.ts`

```typescript
{
  timeout: 30000,        // 30 секунд на тест
  retries: 1,            // Повтор упавших тестов
  workers: 1,            // Последовательное выполнение
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
}
```

---

## 📝 Добавление новых тестов

### Пример: Тест импорта сессии

```typescript
test('should import Gemini session', async () => {
  // 1. Открыть панель
  await mainWindow.click('button[data-tab="sessions"]');

  // 2. Нажать Restore
  await mainWindow.click('button:has-text("Restore Gemini Session")');

  // 3. Ввести имя сессии
  await mainWindow.fill('#session-input-field', 'test-001');
  await mainWindow.keyboard.press('Enter');

  // 4. Проверить toast
  const toast = mainWindow.locator('.toast');
  await expect(toast).toContainText('restored');

  // 5. Скриншот
  await mainWindow.screenshot({ path: 'results/restore-success.png' });
});
```

---

## 🐛 Дебаг

### 1. Просмотр в реальном времени

```bash
npx playwright test --headed --debug
```

### 2. Проверка селекторов

```bash
npx playwright codegen http://localhost:3000
```

### 3. Trace Viewer (пошаговый просмотр)

```bash
npx playwright test --trace on
npx playwright show-trace results/test-artifacts/trace.zip
```

---

## 🎨 Best Practices

### 1. Используй `waitForTimeout` с умом

```typescript
// ❌ Плохо (жесткая задержка)
await mainWindow.waitForTimeout(5000);

// ✅ Хорошо (ждем конкретное событие)
await mainWindow.waitForSelector('.toast', { timeout: 5000 });
```

### 2. Проверяй логи

```typescript
mainWindow.on('console', (msg) => {
  if (msg.type() === 'error') {
    console.error('❌ Renderer error:', msg.text());
  }
});
```

### 3. Делай скриншоты на важных шагах

```typescript
await mainWindow.screenshot({
  path: 'results/critical-state.png',
  fullPage: true
});
```

---

## 📦 CI/CD Integration

### GitHub Actions

```yaml
- name: Run Playwright tests
  run: |
    npm run test:e2e

- name: Upload test results
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: runtime-tests/results/
```

---

## 🔍 Troubleshooting

### Electron не запускается

**Проблема:** `Error: Application exited`

**Решение:**
```bash
# Убедись что приложение работает
npm start

# Проверь путь в тесте
args: [path.join(__dirname, '../../')]  // Должен указывать на main.js
```

### Тесты падают по таймауту

**Проблема:** `Timeout 30000ms exceeded`

**Решение:**
```typescript
// Увеличь таймаут в конфиге
timeout: 60000,

// Или в конкретном тесте
test('slow test', async () => {
  test.setTimeout(60000);
  // ...
});
```

### Селекторы не находятся

**Проблема:** `waiting for selector ".my-button" to be visible`

**Решение:**
```bash
# Используй инспектор селекторов
npx playwright inspector
```

---

## 📚 Полезные ссылки

- [Playwright Docs](https://playwright.dev/docs/intro)
- [Electron Testing](https://playwright.dev/docs/api/class-electron)
- [Debugging Guide](https://playwright.dev/docs/debug)

---

## ✅ Чеклист запуска

- [ ] `npm install` выполнен
- [ ] `npm run test:e2e` запускается
- [ ] Скриншоты создаются в `results/`
- [ ] Логи сохраняются в `test-logs.txt`
- [ ] HTML report открывается без ошибок
- [ ] Все тесты проходят (зеленые ✅)

---

## 🔄 Следующая сессия

**Читай:** [WORKFLOW.md](./WORKFLOW.md)

Там описан полный цикл:
- Как AI пишет `.spec.ts` файлы
- Запуск → Анализ → Исправление
- Конкретный план для Gemini Full Flow теста
- Что делать если тест упал

**Команда для старта:**
```bash
npm run test:e2e
```

---

**Готово! Теперь у тебя полноценное E2E тестирование на Playwright! 🚀**
