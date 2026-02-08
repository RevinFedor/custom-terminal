# ОПЫТ: Устранение мерцания (flicker) AI-интерфейса

## Problem
При использовании Rollback или создании форка, правая панель (InfoPanel) на короткое время (300-500мс) показывала состояние "Нет активной сессии", хотя сессия восстанавливалась.

## Symptoms
- Визуальный "прыжок" интерфейса.
- Скрытие кнопок управления сессией сразу после нажатия Rollback.

## Cause: Race Condition
1. `closeTab()` обнуляет `geminiSessionId` в сторе.
2. `createTab()` создает пустой таб.
3. InfoPanel через поллинг видит `null` и рендерит пустой экран.
4. `executePendingAction` в `Terminal.tsx` срабатывает только ПОСЛЕ готовности PTY.
5. Только тогда вызывается `setGeminiSessionId()`, и InfoPanel "просыпается".

## Solution: Immediate Injection
Изменен метод создания вкладок для AI-команд. Теперь `geminiSessionId` / `claudeSessionId` передается в `options` метода `createTab` или `createTabAfterCurrent`.
- Таб создается **уже** с ID сессии.
- InfoPanel видит ID мгновенно, не дожидаясь готовности PTY.

### Применение паттерна
1. **Fork/Rollback:** При создании форка или отката ID сессии передаётся в `createTab()` напрямую.
2. **History Restore:** При восстановлении вкладки из History (ProjectHome) `claudeSessionId` / `geminiSessionId` берутся из SQLite и передаются в `createTab()`. Sniper Watcher **не нужен** — ID уже известен. См. `features/project-home.md`.

## Результат
Бесшовный переход между вкладками и мгновенное отображение статуса сессии после отката или восстановления из истории.
