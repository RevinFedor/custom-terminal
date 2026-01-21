# Session Persistence v2 - Changelog

**Date:** 2026-01-19
**Version:** 2.0

---

## Новые возможности

### 1. Подробное логирование

Добавлены детальные логи в `session-manager.js`:

- ✅ Показывает путь проекта
- ✅ Показывает hash директории
- ✅ Список файлов в ~/.gemini/tmp/
- ✅ Размер checkpoint файла
- ✅ Доступные сессии при ошибке

**Пример логов:**
```
[SessionManager] ===== EXPORT GEMINI SESSION =====
[SessionManager] Project path: /Users/fedor/Desktop/gt-editor
[SessionManager] Session key: test-001
[SessionManager] Normalized path: /Users/fedor/Desktop/gt-editor
[SessionManager] Directory hash: 0a338f983c31cb7e...
[SessionManager] Gemini tmp dir: /Users/fedor/.gemini/tmp/0a338f...
[SessionManager] Files in gemini tmp dir: ['checkpoint-test-001.json', 'logs.json']
[SessionManager] ✅ Checkpoint file found
[SessionManager] Checkpoint size: 156743 bytes
[SessionManager] ✅ Saved to database with ID: 1
```

### 2. UI со списком сессий

Вместо простых кнопок теперь есть **интерактивный список**:

**Gemini CLI секция:**
- Список сохраненных сессий
- Количество сессий (badge)
- Time ago (just now, 5m ago, 2h ago, 3d ago)
- Клик для выбора сессии
- Кнопка удаления (🗑️)
- Кнопки: 💾 Export | ↩️ Restore

**Claude Code секция:**
- Аналогично Gemini
- Автообновление после export

**Utilities:**
- 📸 Save Terminal Buffer
- 🔄 Refresh button в header

### 3. Workflow

**Export:**
1. Нажми "💾 Export"
2. Введи имя checkpoint
3. Сессия сохраняется в БД
4. Список автоматически обновляется
5. Новая сессия появляется в списке

**Restore:**
1. Кликни на сессию в списке (border станет accent)
2. Нажми "↩️ Restore"
3. Система автоматически восстановит

### 4. Функции

**Новые функции в renderer.js:**
- `refreshSessionsList()` - Обновить список сессий
- `getTimeAgo(date)` - Форматирование времени
- `deleteSession(event, sessionId)` - Удалить сессию
- `importGeminiSessionFromList()` - Восстановить из списка (Gemini)
- `importClaudeSessionFromList()` - Восстановить из списка (Claude)

**Автозагрузка:**
- При открытии вкладки "Sessions" список загружается автоматически
- После export - автообновление
- После delete - автообновление

---

## Исправленные проблемы

### Проблема: "Session not found in database"

**Причина:** Checkpoint был создан в Gemini, но не экспортирован в БД

**Решение:**
1. Логи теперь показывают доступные сессии
2. UI показывает список сохраненных сессий
3. Можно экспортировать только после `/chat save <name>`

**Debug workflow:**
1. В терминале: `/chat save test-001`
2. В Sessions tab: нажми "Export"
3. Введи `test-001`
4. Проверь логи в консоли (Cmd+Option+I)
5. Сессия появится в списке

---

## Технические детали

### Database

Сессии привязаны к **project_id** (не глобально):

```sql
SELECT * FROM ai_sessions WHERE project_id = 'L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvZ3QtZWRpdG9y';
```

Каждый проект имеет свои сессии.

### UI State

Выбранная сессия:
```javascript
const selected = document.querySelector('.session-item.border-accent');
const sessionKey = selected.dataset.sessionKey;
```

### Logs Location

- **Console:** Cmd+Option+I (Developer Tools)
- **Format:** `[SessionManager]` prefix
- **Levels:** ✅ Success, ❌ Error, ⚠️ Warning

---

## Тестирование

### 1. Export Gemini Session

```bash
# В терминале
cd /Users/fedor/Desktop/gt-editor
gemini
# Chat...
/chat save my-test-session
```

**В Noted Terminal:**
1. Open Sessions tab
2. Click "💾 Export"
3. Enter: `my-test-session`
4. Check console for logs
5. Session appears in list

**Expected Logs:**
```
[SessionManager] ===== EXPORT GEMINI SESSION =====
[SessionManager] ✅ Checkpoint file found
[SessionManager] ✅ Saved to database with ID: 1
```

### 2. Restore Session

1. Click on session in list (border becomes accent)
2. Click "↩️ Restore"
3. Wait for automatic restoration
4. Check console for Trojan Horse process

**Expected Behavior:**
- Toast: "Restoring session..."
- Terminal: `gemini` command auto-executed
- Terminal: `/chat resume my-test-session` auto-executed
- Gemini resumes conversation

### 3. Delete Session

1. Hover over session item
2. Click 🗑️ button
3. Confirm deletion
4. Session removed from list

---

## Известные ограничения

1. **Gemini hash calculation:** Завязано на абсолютный путь проекта
   - При переносе проекта нужен re-export
   - Hash пересчитывается автоматически при import

2. **Claude UUID:** Пользователь должен знать UUID
   - Auto-detect помогает, но не всегда точен
   - Лучше вручную найти в `~/.claude/projects/`

3. **Visual snapshots:** Пока только ручное сохранение
   - Auto-restore при создании таба - в будущей версии

---

## Что дальше (Future Improvements)

1. **Auto-export on `/chat save`** - Перехватывать команду и автоматически экспортировать
2. **Session tags** - Добавить метки (work, experiment, backup)
3. **Session search** - Фильтр по имени/дате
4. **Export/Import to file** - Для переноса между машинами
5. **Visual diff** - Сравнение сессий
6. **Session merge** - Объединение checkpoint'ов

---

## Summary

✅ Логирование работает
✅ UI со списком сессий готов
✅ Auto-refresh после операций
✅ Клик для выбора сессии
✅ Delete функционал
✅ Привязка к project_id

**Готово к тестированию!**

Теперь можно:
1. Запустить `npm start`
2. Открыть Sessions tab
3. Создать checkpoint в Gemini: `/chat save test-001`
4. Export через UI
5. Проверить что сессия появилась в списке
6. Выбрать и восстановить
