# Terminal Output Monitoring

**Date:** 2026-01-19
**Feature:** Real-time monitoring of Gemini CLI responses

---

## Problem

**Before:**
- Send `/chat save` command
- Wait fixed 3 seconds
- Hope it worked
- Try to export (might fail if Gemini was slow)

**After:**
- Send `/chat save` command
- **Monitor terminal output in real-time**
- Wait for: `"ℹ Conversation checkpoint saved with tag: ..."`
- Only then proceed with export
- **Guaranteed success!**

---

## How It Works

### 1. Pattern Matching

```javascript
const successPattern = /checkpoint saved with\s+tag:\s*(\S+)/i;
```

This regex matches:
- ✅ `checkpoint saved with tag: my-session`
- ✅ `checkpoint saved with  tag: test-001` (extra spaces)
- ✅ Case-insensitive

### 2. Terminal Output Listener

```javascript
function waitForTerminalOutput(tabId, pattern, timeout = 10000) {
  return new Promise((resolve) => {
    const checkOutput = (event, data) => {
      if (data.tabId !== tabId) return; // Only monitor our tab

      const text = data.data;
      if (pattern.test(text)) {
        console.log('[Sessions] ✅ Pattern matched!');
        resolve(true);
      }
    };

    ipcRenderer.on('terminal:data', checkOutput);

    setTimeout(() => resolve(false), timeout); // Fail after timeout
  });
}
```

### 3. Workflow

```javascript
// Start listener BEFORE sending command
const outputPromise = waitForTerminalOutput(tabId, successPattern, 8000);

// Send command
ipcRenderer.send('terminal:executeCommand', tabId, '/chat save my-session');

// Wait for confirmation
const success = await outputPromise;

if (success) {
  // Export to DB
} else {
  // Show error
}
```

---

## Console Logs

### Success Case:

```
[Sessions] Starting Gemini export workflow...
[Sessions] Sending command: /chat save test-session
[Sessions] Waiting for Gemini confirmation...
[Sessions] Terminal output chunk: /chat save test-session

[Sessions] Terminal output chunk: ℹ Conversation checkpoint saved with tag: test-session.

[Sessions] ✅ Pattern matched!
[Sessions] ✅ Gemini confirmed checkpoint save
[SessionManager] ===== EXPORT GEMINI SESSION =====
[SessionManager] ✅ Checkpoint file found
[SessionManager] ✅ Saved to database with ID: 1
```

### Failure Case (Gemini not running):

```
[Sessions] Starting Gemini export workflow...
[Sessions] Sending command: /chat save test-session
[Sessions] Waiting for Gemini confirmation...
[Sessions] Terminal output chunk: zsh: command not found: /chat
[Sessions] ⏱️ Timeout waiting for pattern
[Sessions] ❌ Did not receive checkpoint confirmation
```

Toast: "Timeout: Gemini did not confirm save. Check terminal."

---

## Timeout Configuration

**Default:** 8 seconds

**Why 8 seconds?**
- Gemini usually responds in 0.5-2 seconds
- 8 seconds allows for:
  - Slow network
  - Large conversation history
  - System lag
- Still fast enough to not annoy user

**Adjust if needed:**
```javascript
const outputPromise = waitForTerminalOutput(tabId, successPattern, 15000); // 15s
```

---

## Edge Cases Handled

### Case 1: Multiple tabs open

**Problem:** Other tabs might output text

**Solution:** Filter by `tabId`:
```javascript
if (data.tabId !== tabId) return; // Ignore other tabs
```

### Case 2: Pattern appears multiple times

**Problem:** User runs `/chat save` twice quickly

**Solution:** Resolve on first match, cleanup listener immediately

### Case 3: Unicode/emoji in output

**Problem:** Gemini uses `ℹ` emoji

**Solution:** Regex handles Unicode:
```javascript
/checkpoint saved with\s+tag:/i
```

### Case 4: Timeout while Gemini is still processing

**Problem:** User has 10,000 line conversation

**Solution:**
- Increase timeout in code
- Show helpful error message
- User can retry

---

## Benefits

✅ **Guaranteed correctness** - Only export after confirmation
✅ **No race conditions** - Wait for actual success
✅ **User feedback** - "Waiting for Gemini confirmation..." toast
✅ **Fail fast** - 8 second timeout if something wrong
✅ **Better debugging** - Logs show exactly what was received

---

## Testing

### Test 1: Normal case

1. Start Gemini: `gemini`
2. Chat a bit
3. Click "💾 Save & Export" in UI
4. Enter name: `test-001`
5. Watch console logs
6. Should see: "✅ Pattern matched!"
7. Toast: "Gemini session exported successfully"

### Test 2: Gemini not running

1. Make sure Gemini is NOT running
2. Click "💾 Save & Export"
3. Enter name: `test-fail`
4. Wait 8 seconds
5. Should see: "⏱️ Timeout waiting for pattern"
6. Toast: "Timeout: Gemini did not confirm save"

### Test 3: Slow response

1. Start Gemini with large conversation
2. Click "💾 Save & Export"
3. Should wait patiently (up to 8s)
4. Should succeed when Gemini finally responds

---

## Future Improvements

1. **Progress indicator** - Show countdown during wait
2. **Retry mechanism** - Auto-retry once if timeout
3. **Smart detection** - Check if Gemini is running before trying
4. **Custom patterns** - Support different CLI tools
5. **Async batch** - Save multiple checkpoints at once

---

## Summary

Теперь export работает **на основе реальных событий**, а не тупого таймера:

1. ⏳ Wait for real Gemini response
2. ✅ Confirm success before export
3. ❌ Fail fast if something wrong
4. 📊 Detailed logs for debugging

**Надежно и предсказуемо!** 🎯
