# Troubleshooting: Trojan Horse Method Replaced

**Date:** 2026-01-19
**Issue:** User confused by temporary `trojan-1768817559341` name appearing during restore

---

## Problem

When clicking "🔄 Resume Gemini Session", the user would see:

```bash
> /chat save trojan-1768817559341
> /exit
```

**Expected:** No temporary names visible, just the original session name

**Why it happened:**
- Old "Trojan Horse" method created a dummy checkpoint first
- Then overwrote and renamed it
- This was visible in the terminal and confusing

---

## Solution: Direct Injection

**New approach:**
Instead of creating a trojan checkpoint through Gemini CLI, we now **directly write the checkpoint file** to the filesystem.

### Before (Trojan Horse)
```javascript
// 1. Create dummy checkpoint via CLI
await sendCommand(tabId, '/chat save trojan-1768817559341');
await sendCommand(tabId, '/exit');

// 2. Find the created file
const trojanPath = '~/.gemini/tmp/<hash>/checkpoint-trojan-xxx.json';

// 3. Overwrite with saved content
fs.writeFileSync(trojanPath, patchedContent);

// 4. Rename to original name
fs.renameSync(trojanPath, finalPath);
```

**Problems:**
- ❌ Visible temporary commands in terminal
- ❌ Requires Gemini to be running
- ❌ Extra steps (create → overwrite → rename)

### After (Direct Injection)
```javascript
// 1. Calculate target path
const targetPath = '~/.gemini/tmp/<hash>/checkpoint-test-001.json';

// 2. Create directory if needed
fs.mkdirSync(geminiTmpDir, { recursive: true });

// 3. Patch content (paths, hashes)
let patched = session.content_blob
  .replace(/old-path/g, newPath)
  .replace(/old-hash/g, newHash);

// 4. Write directly with correct name
fs.writeFileSync(targetPath, patched);

// Done! Gemini will find it when user runs /chat resume test-001
```

**Benefits:**
- ✅ No temporary names visible
- ✅ Doesn't require Gemini running
- ✅ One-step file creation
- ✅ Cleaner user experience

---

## How It Works

### Gemini Checkpoint Discovery

Gemini CLI looks for checkpoints in:
```
~/.gemini/tmp/<SHA256_HASH>/checkpoint-*.json
```

Where `<SHA256_HASH>` is calculated from the current working directory.

When you run `/chat list`, Gemini:
1. Calculates hash of current directory
2. Looks in `~/.gemini/tmp/<hash>/`
3. Lists all files matching `checkpoint-*.json`

**Key insight:** Gemini doesn't maintain an internal registry. It just scans the filesystem!

So we can:
- ✅ Create checkpoint files directly
- ✅ Edit them manually
- ✅ Copy them between machines
- ✅ Transfer sessions by moving files

---

## Code Changes

### session-manager.js
```javascript
// Removed:
// - await sendCommandAndWait('/chat save trojan-xxx')
// - await sendCommandAndWait('/exit')
// - fs.renameSync(trojanPath, finalPath)

// Added:
fs.mkdirSync(geminiTmpDir, { recursive: true }); // Create dir if needed
fs.writeFileSync(targetPath, patchedContent);    // Write directly
```

### User Experience
**Before:**
```
[User clicks "Resume"]
Terminal shows: /chat save trojan-1768817559341
Terminal shows: /exit
[5 seconds later]
Alert: "Session restored! Run gemini"
```

**After:**
```
[User clicks "Resume"]
[No terminal output - happens in background]
Alert: "Session test-001 restored. Click Resume or run: gemini → /chat resume test-001"
```

---

## Testing

1. Export a session:
   ```bash
   gemini
   You: Hello
   Gemini: Hi!
   /chat save my-test
   ```
   Click "💾 Save & Export"

2. Delete the checkpoint:
   ```bash
   rm ~/.gemini/tmp/<hash>/checkpoint-my-test.json
   ```

3. Restore the session:
   Click "🔄 Resume" → Select "my-test"

4. Verify:
   - ✅ No "trojan" commands visible in terminal
   - ✅ File appears: `ls ~/.gemini/tmp/<hash>/checkpoint-my-test.json`
   - ✅ Run `gemini` → `/chat resume my-test` → conversation continues

---

## Why Original Trojan Horse Existed

The original implementation was based on Reddit community patterns where:
- Users didn't know Gemini just scans the filesystem
- Assumed there was an internal registry
- Thought you needed to "register" checkpoints via CLI

But testing revealed:
- Gemini has no internal registry
- It's just a filesystem scan
- Direct file creation works perfectly

---

## Summary

**Problem:** User confused by `trojan-xxx` temporary names
**Solution:** Write checkpoint files directly to filesystem
**Result:** Cleaner UX, faster restore, no visible temporary commands

---

## Related

- See `docs/session-persistence-guide.md` for full architecture
- See `docs/tmp-session-persistence-research.md` for original research
