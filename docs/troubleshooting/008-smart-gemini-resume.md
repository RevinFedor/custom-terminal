# Troubleshooting: Smart Gemini Resume

**Date:** 2026-01-19
**Issue:** Restore button blindly sends commands without detecting terminal state

---

## Problems

### Problem 1: Commands sent when Gemini already running
**Scenario:**
- User already in Gemini CLI (`>` prompt visible)
- Clicks "🔄 Resume"
- System sends: `gemini` (redundant!)
- Then: `/chat resume test-001`

**Result:**
- Gemini interprets `gemini` as user message (wrong!)
- Session restore fails

### Problem 2: Commands sent before Gemini ready
**Scenario:**
- User in bash shell
- Clicks "🔄 Resume"
- System sends: `gemini`
- **Immediately** sends: `/chat resume test-001` (1 second delay)

**Result:**
- Gemini still loading (takes 2-5 seconds)
- `/chat resume` command lost or executed in bash (wrong!)
- User sees error

---

## Root Cause

**Old "dumb" approach:**
```javascript
// Send commands blindly with fixed delays
ipcRenderer.send('terminal:executeCommand', tabId, 'gemini');
await new Promise(resolve => setTimeout(resolve, 1000)); // ❌ Fixed delay
ipcRenderer.send('terminal:executeCommand', tabId, '/chat resume test-001');
```

**Issues:**
1. ❌ No state detection (is Gemini running?)
2. ❌ Fixed delay (not reliable, Gemini load time varies)
3. ❌ No error handling (what if Gemini fails to start?)

---

## Solution: Smart Resume

**New approach with 3 stages:**

### Stage 1: Detect Current State
```javascript
async function detectGeminiRunning(tab) {
  const buffer = tab.serializeAddon.serialize(); // Get terminal buffer

  // Check for Gemini prompt patterns
  const patterns = [
    'Type your message or @path/to/file',
    'YOLO mode',
    />\s*$/m  // Prompt ">" at end of buffer
  ];

  for (const pattern of patterns) {
    if (buffer.includes(pattern) || pattern.test(buffer)) {
      return true; // ✅ Gemini is running
    }
  }

  return false; // ❌ Gemini not running
}
```

### Stage 2: Wait for Ready State (if needed)
```javascript
function waitForGeminiReady(tab, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const buffer = tab.serializeAddon.serialize();

      // Check for ready patterns
      if (buffer.includes('Type your message') || buffer.includes('YOLO mode')) {
        clearInterval(checkInterval);
        resolve(true); // ✅ Gemini ready!
      }

      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        resolve(false); // ⏱️ Timeout
      }
    }, 100); // Check every 100ms
  });
}
```

### Stage 3: Smart Command Execution
```javascript
async function smartGeminiResume(tabId, sessionKey) {
  const tab = getTabById(tabId);

  // Check if Gemini already running
  const isRunning = await detectGeminiRunning(tab);

  if (isRunning) {
    // ✅ Already running → send resume directly
    console.log('Gemini already running');
    ipcRenderer.send('terminal:executeCommand', tabId, `/chat resume ${sessionKey}`);
    return;
  }

  // ❌ Not running → start and wait
  console.log('Starting Gemini...');
  ipcRenderer.send('terminal:executeCommand', tabId, 'gemini');

  // Wait for ready state (up to 15 seconds)
  const ready = await waitForGeminiReady(tab, 15000);

  if (!ready) {
    showToast('Timeout. Please run: /chat resume ' + sessionKey, 'warning');
    return;
  }

  // ✅ Ready → send resume
  console.log('Gemini ready, resuming...');
  await new Promise(resolve => setTimeout(resolve, 500)); // Small stability delay
  ipcRenderer.send('terminal:executeCommand', tabId, `/chat resume ${sessionKey}`);

  showToast('Session resumed!', 'success');
}
```

---

## How It Works

### Scenario A: Gemini Already Running
```
User: [in Gemini CLI]
>

[Clicks "🔄 Resume"]

System checks buffer → finds ">" pattern
✅ Gemini detected!
→ Sends: /chat resume test-001
→ Success! ✅
```

### Scenario B: Gemini Not Running
```
User: [in bash]
$

[Clicks "🔄 Resume"]

System checks buffer → no Gemini patterns
❌ Gemini not running
→ Sends: gemini
→ Waits for "Type your message"...
→ Pattern detected after 3.2 seconds
✅ Gemini ready!
→ Sends: /chat resume test-001
→ Success! ✅
```

### Scenario C: Timeout (Gemini fails to start)
```
User: [in bash]
$

[Clicks "🔄 Resume"]

System checks buffer → no Gemini patterns
→ Sends: gemini
→ Waits for ready pattern...
→ 15 seconds pass...
⏱️ Timeout!
→ Shows toast: "Timeout. Please run: /chat resume test-001"
→ User runs manually
```

---

## Detection Patterns

### Gemini Running Patterns
- `"Type your message or @path/to/file"` - Main prompt text
- `"YOLO mode"` - YOLO mode indicator
- `/>\s*$/m` - Prompt `>` at end of buffer (regex)

### Gemini Ready Patterns
- `"Type your message or @path/to/file"` - Shows when ready for input
- `"YOLO mode"` - YOLO mode active (also ready)

---

## Benefits

**Before (dumb):**
- ❌ Redundant `gemini` command when already running
- ❌ Commands lost due to fixed delays
- ❌ No feedback on failures
- ❌ Manual recovery required

**After (smart):**
- ✅ Detects if Gemini running → skips redundant command
- ✅ Waits for actual ready state → reliable timing
- ✅ 15-second timeout with user notification
- ✅ Works in all scenarios

---

## Testing

### Test 1: Resume from Bash
1. Open terminal (bash prompt)
2. Click "🔄 Resume" → Select session
3. ✅ Should see: `gemini` executed → waits → `/chat resume` executed
4. ✅ Session resumes successfully

### Test 2: Resume from Gemini
1. Already in Gemini CLI (`>` prompt)
2. Click "🔄 Resume" → Select session
3. ✅ Should see: `/chat resume` executed immediately (no `gemini` command)
4. ✅ Session resumes successfully

### Test 3: Timeout Scenario
1. Open terminal
2. Simulate slow Gemini (add breakpoint or disconnect network)
3. Click "🔄 Resume"
4. ✅ Should see toast after 15 seconds: "Timeout. Please run: /chat resume test-001"

---

## Code Changes

**Files modified:**
- `renderer.js`

**Functions added:**
- `smartGeminiResume()` - Main orchestrator
- `detectGeminiRunning()` - State detection
- `waitForGeminiReady()` - Ready state waiter
- `getTabById()` - Helper to find tab across projects

**Functions updated:**
- `importGeminiSessionFromList()` - Now uses `smartGeminiResume()`
- `importGeminiSession()` - Now uses `smartGeminiResume()`

---

## Configuration

**Timeout:** 15 seconds (configurable in `smartGeminiResume()`)
**Check interval:** 100ms (configurable in `waitForGeminiReady()`)
**Stability delay:** 500ms after ready detection (configurable)

---

## Limitations

1. **Pattern-based detection** - If Gemini changes prompt format, patterns need update
2. **Buffer-based** - Only works with xterm SerializeAddon
3. **Timeout is fixed** - Could be made adaptive based on system speed
4. **No retry** - If Gemini fails to start, user must manually retry

---

## Future Improvements

1. **Auto-retry** on timeout (up to 3 attempts)
2. **Adaptive timeout** based on past load times
3. **More robust patterns** (handle different Gemini versions)
4. **Visual progress indicator** showing wait state
5. **Claude Code support** (similar smart resume for Claude)

---

## Summary

**Problem:** Blind command execution → unreliable resume
**Solution:** State detection + ready waiting → smart automation
**Result:** Works in all scenarios, proper error handling ✅
