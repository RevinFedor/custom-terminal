# Fix: Gemini Session Capture in Automation (Update Docs)

### Симптомы
При нажатии кнопки "Update Docs" создавалась новая вкладка с Gemini, но в боковой панели навсегда оставался статус "Ожидание сессии". Из-за этого невозможно было продолжить (`-r`) или ветвить (`fork`) сессию, созданную в рамках автоматизации документации.

---

## Проблема: Обход Sniper Watcher

### Техническая причина
- **Manual Launch:** При ручном вводе `gemini` в терминале компонент `Terminal.tsx` перехватывал команду и вызывал IPC `gemini:spawn-with-watcher`. Этот хендлер сначала инициализировал `fs.watch`, а затем писал `gemini` в PTY.
- **Update Docs Flow:** В `ActionsPanel.tsx` использовался универсальный `terminal:executeCommandAsync`. Он просто записывал текст в PTY. Sniper Watcher не запускался, и файловая система не отслеживалась в момент создания сессии Gemini (которая появляется только после первого сообщения).

---

## Решение: Унификация через Spawn-Watcher

Логика запуска Gemini в `ActionsPanel` была изменена: вместо прямой записи команды теперь вызывается тот же механизм, что и при ручном вводе.

1. **Замена метода:** `terminal:executeCommandAsync` -> `gemini:spawn-with-watcher` (IPC send).
2. **Гарантия захвата:** Sniper инициализируется ДО того, как Gemini получит промпт и создаст файл сессии.
3. **Цепочка событий:** 
   - `createTab` (создает PTY) 
   - `gemini:spawn-with-watcher` (ставит вочер + пишет 'gemini') 
   - `terminal:paste` (отправляет промпт документации) 
   - Gemini создает файл -> Sniper ловит UUID -> Инфо-панель оживает.

### Почему это важно (AI-to-AI)
Не пытайтесь "оптимизировать" запуск через `executeCommandAsync` для скорости. Без явного вызова `spawn-with-watcher` Sniper не узнает о необходимости слежки за конкретной папкой чатов, так как вочеры в проекте не глобальные, а привязаны к жизненному циклу команды.

---
**Связанные факты:**
- [`knowledge/fact-gemini-sessions.md`](fact-gemini-sessions.md)
- [`knowledge/fact-docs-update.md`](fact-docs-update.md)
