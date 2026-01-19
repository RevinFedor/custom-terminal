# Auto-Save Gemini Checkpoints

**Date:** 2026-01-19
**Feature:** Automatic `/chat save` execution before export

---

## Problem Solved

**Before:**
1. User manually types `/chat save my-session` in terminal
2. User switches to UI
3. User clicks "Export"
4. User types "my-session" again
5. Export happens

**After:**
1. User clicks "💾 Save & Export"
2. User types session name ONCE
3. **Automatically runs `/chat save <name>` in terminal**
4. Waits 3 seconds for Gemini to create file
5. Exports to database
6. Done!

---

## How It Works

### Workflow:

```javascript
async function exportGeminiSession() {
  // 1. Get session name from user
  const sessionKey = await showPromptModal('...');

  // 2. Send /chat save command to active terminal
  ipcRenderer.send('terminal:executeCommand', activeTabId, `/chat save ${sessionKey}`);

  // 3. Wait for Gemini to create checkpoint file
  await sleep(3000);

  // 4. Export checkpoint to database
  const result = await ipcRenderer.invoke('session:export-gemini', { sessionKey });

  // 5. Refresh UI list
  await refreshSessionsList();
}
```

### Requirements:

- ✅ Active terminal tab must exist
- ✅ Gemini CLI must be running in that tab
- ✅ User must be in Gemini interactive mode (not shell)

---

## UI Changes

**Button label:** `💾 Save & Export` (was: `💾 Export`)

**Tooltip:** "Runs /chat save in terminal, then exports to DB"

**Toast notifications:**
1. "Saving checkpoint in Gemini..." (blue)
2. "Exporting to database..." (blue)
3. "Gemini session exported successfully" (green)

---

## Console Logs

```
[Sessions] Starting Gemini export workflow...
[Sessions] Active tab: L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvZ3QtZWRpdG9y-tab-1
[Sessions] Sending command: /chat save my-work-session
[Sessions] Waiting 3 seconds for checkpoint creation...

[SessionManager] ===== EXPORT GEMINI SESSION =====
[SessionManager] Files in gemini tmp dir: ['checkpoint-my-work-session.json']
[SessionManager] ✅ Checkpoint file found
[SessionManager] ✅ Saved to database with ID: 1
```

---

## Edge Cases

### Case 1: Gemini Not Running

**Error:** "Checkpoint not found" (after 3 seconds)

**Solution:** User should start Gemini first:
```bash
gemini
```

### Case 2: User Not in Gemini Interactive Mode

**Problem:** Command `/chat save` goes to shell, not Gemini

**Solution:** Make sure you're in Gemini (see `>` prompt)

### Case 3: No Active Tab

**Error:** "Please open a terminal tab first"

**Solution:** Create a tab before exporting

---

## Testing

1. Open terminal with Gemini running:
   ```bash
   cd /Users/fedor/Desktop/gt-editor
   gemini
   # Chat with Gemini...
   ```

2. In UI: Click "💾 Save & Export"

3. Enter name: `test-auto-save`

4. Watch terminal: `/chat save test-auto-save` appears automatically

5. Wait for toast: "Gemini session exported successfully"

6. Check list: `test-auto-save` appears with "just now"

7. Click on it and "↩️ Restore" to verify

---

## Benefits

✅ **One-step export** - No manual terminal commands
✅ **Less context switching** - Stay in UI
✅ **No typos** - Name entered once
✅ **Visual feedback** - Toast notifications at each step
✅ **Auto-refresh** - List updates immediately

---

## Future Improvements

1. **Detect if Gemini is running** - Check terminal output for `>` prompt
2. **Auto-start Gemini** - Run `gemini` if not started
3. **Progress indicator** - Show countdown during 3-second wait
4. **Smart wait time** - Detect when file is created (instead of fixed 3s)
5. **Batch export** - Export all unsaved checkpoints at once

---

## Summary

Теперь export - это **полностью автоматизированный процесс**:
- Нажал кнопку
- Ввел имя
- Команда `/chat save` выполнилась автоматически
- Checkpoint экспортирован в БД
- Список обновился

**Готово!** 🚀
