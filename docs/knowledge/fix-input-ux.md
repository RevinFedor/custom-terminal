# Сборник решений: Ввод, UX и Модальные окна

Этот файл объединяет решения проблем с вводом команд и заменой стандартных браузерных диалогов.

---

## 1. Enter Key Not Working in Auto-Commands
**Файл-источник:** `fix-enter-not-working.md`

### Problem
Commands sent via `terminal:executeCommand` (like `/chat save`) appeared in terminal but didn't execute (Enter was ignored).

### Root Causes
1. **Raw Mode Conflict**: Sending text + `\r` too fast causes CLI to treat it as a "paste", ignoring newlines for safety.
2. **Bracketed Paste Mode**: `\x1b[?2004h` wraps text, requiring manual Enter confirmation.

### Solution: Split writes with delay
In `main.js`:
```javascript
term.write(command);
await new Promise(r => setTimeout(r, 150)); // Allow CLI to process text
term.write('\r'); // Now send Enter separately
```

---

## 2. Fix: prompt() and alert() Not Supported in Electron
**Файл-источник:** `fix-prompt-alert-fix.md`

### Problem
App crashed with `Error: prompt() is and will not be supported` because Electron renderer doesn't support blocking browser dialogs.

### Solution
1. **Custom Modal**: Created a reusable HTML/CSS modal in `index.html`.
2. **showPromptModal()**: A Promise-based wrapper.
```javascript
const sessionKey = await showPromptModal('Title', 'Label', 'Placeholder');
if (sessionKey) { ... }
```
3. **Toasts**: Replaced `alert()` with non-blocking toast notifications for better UX.

---

## 3. Global Terminal Selection Sync
**Файл-источник:** Сессия 2026-01-21

### Проблема
Компоненты (например, GeminiPanel) не могли получить выделенный в терминале текст без прямого доступа к инстансу `xterm.js`. Кнопки поиска не знали, когда текст выделен, и не могли быть заблокированы (disabled).

### Решение
Внедрен глобальный стейт `terminalSelection` в `useUIStore`.
1.  **Terminal.tsx:** Слушает событие `onSelectionChange` и обновляет глобальный стейт.
2.  **Context Menu:** Принудительно вызывает `getSelection()` перед открытием меню.
3.  **UI:** Кнопки поиска используют `terminalSelection` для управления состоянием `disabled` и отображения счетчика символов.
См. также: `knowledge/fact-terminal-registry.md`.

```