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

**Original code in main.js:**
```javascript
term.write(command + '\r');
```

**Problem:** Sending `command + '\r'` as one string didn't work reliably with PTY.

---

## Solution

**Split into two separate writes:**
```javascript
// Step 1: Write command text
term.write(command);

// Step 2: Send Enter separately
term.write('\r');
```

**Why this works:**
- PTY processes each write() call separately
- First write types the text
- Second write sends carriage return
- Gemini CLI interprets it correctly

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
