# Interpreting Playwright Test Results

Как читать и анализировать результаты тестов.

---

## 📊 Где найти результаты

После запуска тестов (`npm run test:e2e`) результаты сохраняются в:

```
runtime-tests/results/
├── playwright-report/      # HTML отчет (откроется автоматически)
├── test-artifacts/         # Видео и trace файлы
├── test-logs.txt          # Все логи (Main + Renderer)
└── *.png                  # Скриншоты каждого шага
```

---

## 1️⃣ HTML Report (главный источник)

### Открыть:
```bash
npm run test:report
```

### Что смотреть:

#### ✅ Зеленые тесты (Passed)
- Все хорошо, функциональность работает
- Можно посмотреть скриншоты для подтверждения

#### ❌ Красные тесты (Failed)
1. Кликни на тест → увидишь:
   - **Error message** - что именно упало
   - **Stack trace** - где в коде произошла ошибка
   - **Screenshot** - состояние UI в момент падения
   - **Video** - запись всего теста (если включено)

2. Типичные причины падения:
   - **TimeoutError** - элемент не появился вовремя
   - **Selector not found** - UI изменился, селектор устарел
   - **Assertion failed** - ожидалось одно, получилось другое

#### 📹 Видео (если тест упал)
- Находится в `test-artifacts/`
- Показывает весь процесс выполнения теста
- Помогает понять в какой момент все сломалось

---

## 2️⃣ Test Logs (детальная информация)

### Файл: `results/test-logs.txt`

Структура:
```
===== MAIN PROCESS LOGS =====
[main] terminal:create called with tabId: L1VzZXJz...
[SessionManager] ===== EXPORT GEMINI SESSION =====
[SessionManager] Project path: /Users/fedor/Desktop/custom-terminal
[SessionManager] Session key: test-001
[SessionManager] Directory hash: 0a338f983c31cb...
[SessionManager] Looking for checkpoint at: ~/.gemini/tmp/.../checkpoint-test-001.json
[SessionManager] ⚠️ Gemini tmp dir does not exist!
[SessionManager] ❌ Checkpoint file not found

===== RENDERER PROCESS LOGS =====
[log] [Session] Export started...
[log] [SessionManager] Checkpoint not found
[error] Export failed: Checkpoint "test-001" not found
```

### Как читать:

#### 🟢 Успешный экспорт:
```
[SessionManager] ✅ Checkpoint file found, reading...
[SessionManager] Checkpoint size: 145892 bytes
[SessionManager] ✅ Saved to database with ID: 1
```

#### 🔴 Ошибка "Session not found":
```
[SessionManager] Files in gemini tmp dir: ["logs.json", "chats"]
[SessionManager] ❌ Checkpoint file not found
```
**Причина:** Чекпоинт не был создан в Gemini или неверное имя.

**Решение:**
1. Открой терминал в приложении
2. Запусти `gemini`
3. Создай чекпоинт: `/chat save test-001`
4. Запусти тест снова

#### 🔴 Ошибка "Gemini tmp dir does not exist":
```
[SessionManager] ⚠️ Gemini tmp dir does not exist!
```
**Причина:** Gemini CLI еще ни разу не запускался в этой директории.

**Решение:**
1. Запусти `gemini` в терминале приложения
2. Скажи "hi" (чтобы создалась сессия)
3. Теперь папка будет создана

---

## 3️⃣ Screenshots (визуальная проверка)

### Файлы: `results/*.png`

Карта скриншотов:

| Файл | Описание | Что проверить |
|------|----------|--------------|
| `01-initial-state.png` | Стартовое состояние | Проект загружен, табы видны |
| `02-sessions-panel-open.png` | Sessions tab открыт | Панель справа активна, кнопки видны |
| `03-export-modal-open.png` | Модалка экспорта | Поле ввода, кнопки Confirm/Cancel |
| `04-entering-session-name.png` | Ввод имени | Текст в поле ввода |
| `05-export-result.png` | Результат экспорта | Toast уведомление (зеленое/красное) |
| `06-list-sessions.png` | Список сессий | Toast с количеством сессий |

### Типичные проблемы на скриншотах:

#### Пустая панель Sessions:
- **Причина:** JavaScript не загрузился или ошибка в коде
- **Где смотреть:** Renderer logs на наличие `[error]`

#### Модалка не открылась:
- **Причина:** `onclick` не сработал или модал скрыт CSS
- **Где смотреть:** Test logs → ищи `click('button:has-text("Export")')`

#### Toast не появился:
- **Причина:** Функция `showToast()` не вызвалась
- **Где смотреть:** Renderer logs → ищи `showToast(...)`

---

## 4️⃣ Trace Viewer (пошаговая отладка)

### Включить:
```bash
npx playwright test --trace on
```

### Открыть:
```bash
npx playwright show-trace results/test-artifacts/trace.zip
```

### Что дает:
- **Timeline** - шкала времени выполнения теста
- **Actions** - каждое действие (click, fill, etc.)
- **Screenshots** - снимок после каждого действия
- **Console** - логи в момент действия
- **Network** - запросы (если есть)

### Когда использовать:
- Тест падает, но непонятно почему
- Нужно понять порядок выполнения действий
- Проверить что UI действительно изменился после клика

---

## 🔍 Анализ конкретных проблем

### Проблема: "Checkpoint not found"

#### Что смотреть в логах:
```
[SessionManager] Files in gemini tmp dir: [...]
```

Если список файлов НЕ содержит `checkpoint-test-001.json`:
- ✅ Чекпоинт не был создан
- 🔧 Решение: Создать чекпоинт вручную в Gemini

Если папка вообще не существует:
- ✅ Gemini никогда не запускался в этой директории
- 🔧 Решение: Запустить Gemini хотя бы раз

#### Что смотреть на скриншотах:
- `05-export-result.png` → Toast должен быть красный с текстом "not found"

---

### Проблема: "Modal not visible"

#### Что смотреть в логах:
```
[error] Timeout 5000ms exceeded.
  =========================== logs ===========================
  waiting for selector "#session-input-modal" to be visible
```

#### Причины:
1. **CSS class `hidden`** - модал скрыт
   - Проверь `showPromptModal()` → вызывается ли `modal.classList.remove('hidden')`

2. **JavaScript error** - функция не выполнилась
   - Renderer logs → ищи `[error]`

3. **Селектор изменился** - ID модала поменялся
   - Проверь HTML → `id="session-input-modal"` существует?

---

### Проблема: "Test passed but functionality broken"

Бывает, что тест зеленый, но фича не работает.

#### Почему:
- Тест проверяет только UI (модал открылся)
- Но не проверяет логику (сессия сохранилась)

#### Как фиксить:
Добавь проверку результата:
```typescript
// После экспорта
await mainWindow.click('button:has-text("List All Sessions")');
const toast = mainWindow.locator('.toast');
await expect(toast).toContainText('Found 1 session'); // Проверяем что сессия действительно сохранилась
```

---

## ✅ Чеклист анализа упавшего теста

1. [ ] Открыть HTML report → найти упавший тест
2. [ ] Посмотреть screenshot в момент падения
3. [ ] Прочитать error message
4. [ ] Открыть `test-logs.txt` → найти `[SessionManager]` логи
5. [ ] Проверить Main process logs на ошибки
6. [ ] Проверить Renderer logs на `[error]`
7. [ ] Если непонятно → включить trace и посмотреть timeline
8. [ ] Если все равно непонятно → запустить `--headed --debug` и смотреть руками

---

## 💡 Типичные паттерны

### 1. "Все упало сразу"
- **Причина:** Приложение не запустилось
- **Где смотреть:** Main logs → первые 10 строк
- **Что искать:** `Error:`, `FATAL`, `Cannot find module`

### 2. "Первые тесты прошли, последние упали"
- **Причина:** Состояние приложения изменилось
- **Где смотреть:** Сравни скриншоты начала и конца
- **Что искать:** Открытые модалки, застрявшие тосты

### 3. "Тест иногда падает, иногда проходит"
- **Причина:** Race condition (асинхронность)
- **Решение:** Добавь `waitForSelector` перед действием

---

**Теперь ты знаешь как читать результаты Playwright тестов! 🚀**

Если тест упал → не паникуй → открой HTML report → посмотри screenshot → прочитай логи → найди причину.
