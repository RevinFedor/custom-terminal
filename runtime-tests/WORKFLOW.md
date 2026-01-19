# Testing Workflow - Iterative Code Generation Approach

**Дата:** 2026-01-19
**Подход:** Best Practice 2025/2026 (Reddit consensus)

---

## 🎯 Концепция

**НЕ "Live MCP"** (AI тыкает кнопки в реальном времени) ❌

**ДА "Iterative Code Generation"** (AI пишет `.spec.ts` → запуск → анализ → фикс) ✅

---

## 💡 Почему Live MCP - плохо:

1. **Нестабильность** - AI может ошибиться, но запись не сохранится
2. **Замусоривание токенов** - каждое действие съедает контекст
3. **Нет регрессии** - завтра нужно снова запускать AI
4. **Нет CI/CD** - невозможно автоматизировать

---

## ✅ Почему Iterative Code Generation - правильно:

1. **Детерминизм** - код всегда работает одинаково
2. **Скорость** - Playwright компилит JS, не думает на каждом шаге
3. **Репозиторий** - `.spec.ts` живет в git навсегда
4. **CI/CD ready** - запускается без участия AI
5. **Trace Viewer** - детальная отладка постфактум

---

## 🔄 Итеративный цикл

```
┌─────────────────────────────────────────────┐
│  1. AI пишет код теста (.spec.ts)           │
│     ↓                                       │
│  2. Запуск: npm run test:e2e                │
│     ↓                                       │
│  3. Playwright выполняет тест               │
│     ↓                                       │
│  4. Результат:                              │
│     • test-results.json                     │
│     • Скриншоты (*.png)                     │
│     • Логи (test-logs.txt)                  │
│     • Trace (trace.zip)                     │
│     ↓                                       │
│  5. Анализ результата:                      │
│     ✅ PASSED → Коммит в репо               │
│     ❌ FAILED → Переход к шагу 6            │
│     ↓                                       │
│  6. AI читает ошибки:                       │
│     • Error message                         │
│     • Stack trace                           │
│     • Скриншот момента падения              │
│     • DOM snapshot                          │
│     ↓                                       │
│  7. AI исправляет .spec.ts                  │
│     ↓                                       │
│  8. Возврат к шагу 2 (повтор)               │
└─────────────────────────────────────────────┘
```

---

## 📋 Конкретный план для Gemini Full Flow

### Файл: `tests/gemini-full-flow.spec.ts`

#### Шаги теста:

1. **Запуск Electron**
   ```typescript
   const electronApp = await electron.launch({ args: ['.'] });
   const mainWindow = await electronApp.firstWindow();
   ```

2. **Открыть терминал xterm**
   ```typescript
   const terminal = mainWindow.locator('.xterm textarea');
   await terminal.click(); // Focus
   ```

3. **Запустить Gemini**
   ```typescript
   await terminal.type('gemini');
   await mainWindow.keyboard.press('Enter');
   await mainWindow.waitForTimeout(3000); // Ждем загрузки
   ```

4. **Написать сообщение**
   ```typescript
   await terminal.type('привет как дела');
   await mainWindow.keyboard.press('Enter');
   await mainWindow.waitForTimeout(5000); // Ждем ответа
   ```

5. **Сохранить checkpoint**
   ```typescript
   await terminal.type('/chat save test-001');
   await mainWindow.keyboard.press('Enter');
   await mainWindow.waitForTimeout(2000);
   ```

6. **Открыть Sessions panel**
   ```typescript
   await mainWindow.click('button[data-tab="sessions"]');
   ```

7. **Нажать Export**
   ```typescript
   await mainWindow.click('button:has-text("Export Gemini Session")');
   ```

8. **Ввести имя в модалку**
   ```typescript
   const modal = mainWindow.locator('#session-input-modal');
   await expect(modal).not.toHaveClass(/hidden/);

   await mainWindow.fill('#session-input-field', 'test-001');
   await mainWindow.keyboard.press('Enter');
   ```

9. **Проверить toast**
   ```typescript
   const toast = mainWindow.locator('.toast');
   await expect(toast).toContainText('exported successfully');
   ```

10. **Проверить базу данных**
    ```typescript
    // Читаем SQLite напрямую
    const db = require('better-sqlite3')('~/.config/Electron/noted-terminal.db');
    const sessions = db.prepare('SELECT * FROM ai_sessions WHERE session_key = ?').all('test-001');
    expect(sessions.length).toBeGreaterThan(0);
    ```

---

## 🔧 Что делать когда тест упал

### 1. Читать JSON результаты

```bash
cat runtime-tests/results/test-results.json
```

**Ключевые поля:**
- `status` - passed/failed/timedOut
- `error.message` - текст ошибки
- `error.stack` - где упало

### 2. Смотреть скриншот

```bash
open runtime-tests/results/*.png
```

Скриншот показывает состояние UI в момент падения.

### 3. Читать логи

```bash
cat runtime-tests/results/test-logs.txt
```

Искать:
- `[SessionManager]` - логи экспорта
- `[error]` - ошибки renderer process
- `[MAIN ERROR]` - ошибки main process

### 4. Открыть Trace Viewer

```bash
npx playwright show-trace results/test-artifacts/trace.zip
```

Показывает:
- Timeline выполнения
- Каждое действие (click, type, wait)
- DOM state в каждый момент
- Console logs

---

## 🤖 Как AI исправляет тест

### Типичные ошибки и фиксы:

#### 1. "Selector not found"

**Ошибка:**
```
Error: Locator.click: Selector ".xterm textarea" not found
```

**Причина:** Селектор неверный или элемент еще не загрузился

**Фикс:**
```typescript
// До (плохо)
await terminal.click();

// После (хорошо)
await terminal.waitFor({ state: 'visible', timeout: 10000 });
await terminal.click();
```

#### 2. "Timeout exceeded"

**Ошибка:**
```
Error: Test timeout of 30000ms exceeded
```

**Причина:** Gemini долго отвечает или вообще не ответил

**Фикс:**
```typescript
// До (плохо)
await mainWindow.waitForTimeout(5000);

// После (хорошо)
test.setTimeout(60000); // Увеличить таймаут теста
await mainWindow.waitForSelector('.gemini-response', { timeout: 30000 });
```

#### 3. "Modal not visible"

**Ошибка:**
```
Error: expect(received).not.toHaveClass(expected)
Expected: not /hidden/
Received: "fixed inset-0 ... hidden"
```

**Причина:** JavaScript функция не сработала

**Фикс:**
```typescript
// Добавить явный wait
await modal.waitFor({ state: 'visible', timeout: 5000 });
```

#### 4. "Checkpoint not found"

**Ошибка (в логах):**
```
[SessionManager] ❌ Checkpoint file not found
```

**Причина:** Gemini не успел сохранить или команда не прошла

**Фикс:**
```typescript
// Проверить что команда сработала
await terminal.type('/chat save test-001');
await mainWindow.keyboard.press('Enter');

// Ждем подтверждения в терминале
await mainWindow.locator('.xterm').locator('text=/Conversation checkpoint saved/').waitFor();
```

---

## 📊 Критерии успеха теста

### Тест считается PASSED если:

1. ✅ Gemini запустился без ошибок
2. ✅ Ответил на сообщение
3. ✅ Checkpoint сохранился (`/chat save`)
4. ✅ Export button кликнулся
5. ✅ Модалка открылась
6. ✅ Имя введено и подтверждено
7. ✅ Toast показал "exported successfully"
8. ✅ В базе есть запись с `session_key = 'test-001'`
9. ✅ Нет критических ошибок в логах
10. ✅ Файл checkpoint существует в `~/.gemini/tmp/...`

---

## 🚀 Как запускать в следующей сессии

### Команды:

```bash
# 1. Запустить все тесты
npm run test:e2e

# 2. Запустить с видимым окном (для отладки)
npm run test:e2e:headed

# 3. Запустить с пошаговой отладкой
npm run test:e2e:debug

# 4. Посмотреть отчет
npm run test:report
```

### Файлы для анализа AI:

```bash
runtime-tests/
├── results/
│   ├── test-results.json         # Главный файл для AI
│   ├── test-logs.txt             # Логи Main + Renderer
│   ├── *.png                     # Скриншоты каждого шага
│   └── test-artifacts/
│       └── trace.zip             # Для детальной отладки
```

---

## 📝 Инструкция для AI в следующей сессии

### Шаг 1: Написать тест

Создать файл `runtime-tests/tests/gemini-full-flow.spec.ts` с полным E2E флоу (см. выше).

### Шаг 2: Запустить

```bash
npm run test:e2e
```

### Шаг 3: Если упал - прочитать результаты

```typescript
// AI читает:
const results = JSON.parse(fs.readFileSync('results/test-results.json'));
const logs = fs.readFileSync('results/test-logs.txt', 'utf-8');

// Анализирует:
if (results.status === 'failed') {
  console.log('Error:', results.error.message);
  console.log('Stack:', results.error.stack);

  // Ищет в логах причину
  const sessionLogs = logs.match(/\[SessionManager\].*/g);
  console.log('SessionManager logs:', sessionLogs);
}
```

### Шаг 4: Исправить .spec.ts

На основе ошибки AI переписывает файл теста.

### Шаг 5: Повторить запуск

Цикл повторяется до PASSED.

---

## 🎓 Best Practices

1. **Делай скриншоты после каждого важного действия**
   ```typescript
   await mainWindow.screenshot({ path: 'results/step-X.png' });
   ```

2. **Логируй все важные моменты**
   ```typescript
   console.log('🧪 [TEST] Starting Gemini...');
   console.log('✅ [TEST] Gemini responded');
   ```

3. **Используй explicit waits**
   ```typescript
   // НЕ используй:
   await mainWindow.waitForTimeout(5000);

   // Используй:
   await mainWindow.waitForSelector('.expected-element');
   ```

4. **Проверяй состояние после каждого действия**
   ```typescript
   await button.click();
   await expect(modal).toBeVisible(); // Проверка что клик сработал
   ```

5. **Увеличивай таймауты для медленных операций**
   ```typescript
   test.setTimeout(60000); // Gemini может отвечать долго
   ```

---

## 🏁 Итог

**Этот флоу гарантирует:**

- ✅ Стабильные, воспроизводимые тесты
- ✅ Возможность запуска без AI (CI/CD)
- ✅ Детальную отладку через Trace Viewer
- ✅ Автоматическое исправление AI при падении
- ✅ Долгоживущие тесты в репозитории

**Следующая сессия:**
1. Написать `gemini-full-flow.spec.ts`
2. Запустить
3. Прочитать результаты
4. Исправить если упало
5. Повторить до зеленого статуса

**Готово к работе! 🚀**
