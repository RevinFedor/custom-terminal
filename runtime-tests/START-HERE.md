# 👋 Следующая сессия - START HERE

**Дата создания:** 2026-01-19

---

## 🎯 Текущая задача

Реализовать **E2E тест для Gemini Session Export/Import** используя Playwright.

---

## 📚 Прочитай в порядке:

1. **[WORKFLOW.md](./WORKFLOW.md)** ⭐ **ГЛАВНОЕ!**
   - Концепция: Iterative Code Generation (не Live MCP)
   - Полный цикл разработки теста
   - Конкретный план для Gemini Full Flow
   - Как AI исправляет упавшие тесты

2. **[README.md](./README.md)**
   - Быстрый старт
   - Команды запуска
   - Структура проекта

3. **[INTERPRETING-RESULTS.md](./INTERPRETING-RESULTS.md)**
   - Как читать результаты
   - Где искать ошибки
   - Типичные проблемы

---

## 🚀 Следующий шаг

### Написать файл: `tests/gemini-full-flow.spec.ts`

**Что должен делать тест:**

1. Запустить Electron
2. Открыть терминал (xterm)
3. Ввести `gemini`
4. Написать "привет как дела"
5. Дождаться ответа
6. Выполнить `/chat save test-001`
7. Открыть Sessions panel
8. Нажать "Export Gemini Session"
9. Ввести "test-001" в модалку
10. Проверить toast "exported successfully"
11. Проверить что сессия есть в SQLite

**Детали в:** [WORKFLOW.md](./WORKFLOW.md) → Секция "Конкретный план для Gemini Full Flow"

---

## 💡 Важно помнить

- ✅ xterm.js - это DOM элемент, Playwright может с ним работать
- ✅ Селектор терминала: `.xterm textarea`
- ✅ Используй `await terminal.type('команда')` для ввода
- ✅ Используй `await mainWindow.keyboard.press('Enter')` для подтверждения
- ✅ Ждем загрузки Gemini: `waitForTimeout(3000)`
- ✅ Ждем ответа: `waitForTimeout(5000)` или лучше `waitForSelector`

---

## 🔧 Команды

```bash
# Запустить тест
npm run test:e2e

# С видимым окном (для отладки)
npm run test:e2e:headed

# Пошаговая отладка
npm run test:e2e:debug

# Посмотреть результаты
npm run test:report
```

---

## 📊 Если тест упал

1. Открыть `results/test-results.json`
2. Прочитать `error.message` и `error.stack`
3. Посмотреть скриншоты `results/*.png`
4. Прочитать логи `results/test-logs.txt`
5. Исправить `.spec.ts` на основе ошибки
6. Запустить снова

**Детали в:** [WORKFLOW.md](./WORKFLOW.md) → Секция "Что делать когда тест упал"

---

## ✅ Цель

Получить зеленый (PASSED) тест, который:
- Стабильно работает
- Можно запускать без AI
- Сохранен в репозитории
- Готов для CI/CD

---

**Вперед! 🚀**
