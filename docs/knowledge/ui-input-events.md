# UI Input & Events

---

## Enter Key Not Working in Auto-Commands
**Файл-источник:** `fix-enter-not-working.md`

### Симптомы
При нажатии кнопок автоматизации (например, "Save Chat" или "Clear History") команда появляется в строке ввода терминала, но ничего не происходит — нажатие Enter как бы игнорируется системой, и команда не уходит в выполнение.

### Problem
Commands sent via `terminal:executeCommand` (like `/chat save`) appeared in terminal but didn't execute (Enter was ignored).

### Root Causes
1. **Raw Mode Conflict**: Sending text + `\r` too fast causes CLI to treat it as a "paste", ignoring newlines for safety.
2. **Bracketed Paste Mode**: `\x1b[?2004h` wraps text, requiring manual Enter confirmation.

### Solution: Split writes with delay
In `main.js`:
term.write(command);
await new Promise(r => setTimeout(r, 150)); // Allow CLI to process text
term.write('\r'); // Now send Enter separately

---

## Large Text Input (Buffer Overflow)
**Файл-источник:** `terminal-core.md`

### Problem
Вставка текста > 4KB (длинные промпты) обрывается из-за ограничений буфера TTY в ОС.

### Solution
Реализована функция `writeToPtySafe` с разбиением на чанки по 1KB и использованием **Bracketed Paste Mode**. Подробности в `knowledge/terminal-core.md`.

---

## 8. Event Loop Starvation (execSync Locks)
**Файл-источник:** Сессия 2026-01-21 (Performance Fix)

### Проблема
Интерфейс "замирал" (фризил) на 1-3 секунды при закрытии вкладок или переключении проектов.

### Причина
Использование `execSync` в Main процессе для проверки дочерних процессов терминала (`pgrep`, `ps`, `lsof`). `execSync` — это блокирующая операция. Пока системная команда выполняется (или ждет таймаута в 1000мс), весь Main процесс Electron стоит на месте, не обрабатывая IPC-сообщения от рендерера (клики, ввод).

### Решение
Полная замена всех системных вызовов на асинхронные с использованием промисов:
```javascript
const execAsync = (cmd, timeout = 1000) => {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    exec(cmd, { encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
};
```
Это позволяет Main процессу оставаться свободным и отзывчивым даже во время выполнения тяжелых системных запросов.

---

## 6. Перехват системного Zoom (Cmd+/-)
**Файл-источник:** `fix-zoom-override.md`

### Проблема
По умолчанию Electron масштабирует всё окно (Zoom), что ломит верстку.

### Решение
В `App.tsx` добавлен перехват `keydown` для `Cmd+Plus` и `Cmd+Minus`, который вызывает `incrementTerminalFontSize()` / `decrementTerminalFontSize()` вместо системного зума.

---

## 12. Фокусировка активной области (onMouseDown)

### Проблема
При клике на терминал фокус приложения (стейт `activeArea`) не всегда переключался на `'workspace'`. Из-за этого горячие клавиши (например, `Cmd+T`) продолжали интерпретироваться в контексте проектов (создавался новый проект вместо нового таба).

### Причина
Эмулятор терминала `xterm.js` использует Canvas для отрисовки. Он активно перехватывает события мыши для обработки выделения и кликов. Стандартное React-событие `onClick` на родительском контейнере могло не срабатывать, так как терминал мог останавливать всплытие (propagation) или поглощать событие раньше.

### Решение
Переход на использование `onMouseDown` на родительском контейнере `Workspace`.
- Событие `onMouseDown` срабатывает раньше `onClick` и `mouseup`.
- Оно гарантированно фиксирует намерение пользователя взаимодействовать с областью терминала до того, как эмулятор начнет свои внутренние расчеты.

### Результат
Мгновенное и надежное переключение контекста горячих клавиш при клике в любую точку рабочей области.

---

## navigator.clipboard ненадёжен в Electron

## Проблема
`navigator.clipboard.writeText()` в Electron renderer-процессе работает нестабильно:
- Требует фокус окна (если окно потеряло фокус во время async/await — промис "теряется")
- Возвращает Promise, который может отклониться без видимой причины
- Баг проявляется intermittently (то работает, то нет)

## Решение
Использовать синхронный `clipboard` из Electron:
```typescript
const { ipcRenderer, clipboard } = window.require('electron');

// ❌ Ненадёжно
await navigator.clipboard.writeText(text);

// ✅ Надёжно
clipboard.writeText(text);
```

## Где применено
- `Timeline.tsx`: копирование range, копирование текста сообщения, кнопка "Копировать" в тултипе.

---

## prompt() and alert() Not Supported fix
**Файл-источник:** `fix-prompt-alert-fix.md`

### Симптомы
Приложение внезапно "падает" или полностью перестает реагировать на действия пользователя (белый экран или зависание) в моменты, когда должен появиться диалог подтверждения (например, ввод API ключа или подтверждение удаления).

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
