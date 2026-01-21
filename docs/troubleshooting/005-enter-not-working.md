# Troubleshooting: Enter Key Not Working in Auto-Commands

**Date:** 2026-01-19
**Issue:** Commands sent via `terminal:executeCommand` appeared in terminal but didn't execute

---

## Problem

When clicking "💾 Save & Export", the command `/chat save sessions-1` was typed into terminal but **Enter was not pressed**.

**Expected:**
```
> /chat save sessions-1 [ENTER pressed automatically]
ℹ Conversation checkpoint saved with tag: sessions-1.
```

**Actual:**
```
> /chat save sessions-1 [cursor just sits there, no Enter]
[timeout after 8 seconds]
```

---

## Root Cause

**1. Raw Mode Conflict**
Gemini CLI (и другие Node.js CLI) переключают терминал в **Raw Mode**. Если отправить текст слишком быстро (текст + `\r` одним куском), парсер `readline` считает это "вставкой" (paste) и может игнорировать символы перевода строки внутри нее для безопасности.

**2. Bracketed Paste Mode**
Некоторые терминалы и CLI используют коды `\x1b[?2004h` (enable) и `\x1b[?2004l` (disable). Если режим включен, любой вставленный текст оборачивается в "скобки" `\x1b[200~` и `\x1b[201~`. Gemini CLI при виде такой вставки может блокировать выполнение команды до ручного подтверждения.

---

## Solution

**1. Split writes with delay (Main Process)**
В `main.js` (IPC handler `terminal:executeCommandAsync`) мы разделили ввод и нажатие Enter:
```javascript
term.write(command);
await new Promise(r => setTimeout(r, 150)); // Ждем, чтобы CLI не считал это paste
term.write('\r');
```

**2. Disable Bracketed Paste (Optional)**
Если CLI все равно капризничает, можно принудительно выключить режим вставки перед командой:
```javascript
term.write('\x1b[?2004l'); // Disable bracketed paste
term.write(command);
// ... Enter ...
```
*Примечание: В финальной версии мы отказались от этого в пользу задержек, так как задержки оказались надежнее.*

---

## Affected Features

✅ **Fixed:**
- Auto-save Gemini checkpoints (export)
- Auto-restore Gemini sessions (import)
- Quick Actions buttons
- Any `terminal:executeCommand` IPC calls

---

## Logs Before Fix

```
[main] command: "/chat save sessions-1"
[main] Full command with \r: "/chat save sessions-1\r"
[main] ✅ Written to PTY
[Sessions] ⏱️ Timeout waiting for pattern
[Sessions] ❌ Did not receive checkpoint confirmation
```

## Logs After Fix

```
[main] command: "/chat save sessions-1"
[main] Step 1: Writing command text...
[main] Step 2: Sending Enter (\r)...
[main] ✅ Command + Enter sent to PTY
[Sessions] Terminal output chunk: ℹ Conversation checkpoint saved...
[Sessions] ✅ Pattern matched!
```

---

## Testing

Run this to verify:
1. Open Gemini in terminal
2. Click "💾 Save & Export"
3. Enter session name
4. Watch terminal - should see command + automatic Enter
5. Should get success toast

---

## Summary

**Before:** `term.write(command + '\r')` → Enter не работал
**After:** `term.write(command); term.write('\r')` → Работает ✅
