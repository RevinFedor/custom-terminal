# Session Persistence Guide

**Status:** ✅ MVP Ready (v1.0)
**Date:** 2026-01-19

---

## Overview

Session Persistence allows you to save and restore AI conversations (Gemini CLI and Claude Code) across terminal sessions. This includes both the visual terminal buffer and the AI's context/memory.

### Two Layers

1. **Visual Layer** - What you see in the terminal (text, colors, formatting)
2. **Brain Layer** - What the AI remembers (conversation history, context)

---

## Quick Start

### 1. Open Sessions Panel

Click the **"Sessions"** tab in the right panel (next to Notes, AI, Actions).

### 2. Save a Session

#### For Gemini CLI:
1. In the terminal, create a checkpoint manually:
   ```bash
   gemini
   # Chat with Gemini...
   /chat save my-session-name
   ```

2. Click **"Export Gemini Session"**
3. Enter the checkpoint name (e.g., `my-session-name`)
4. Session is now saved to database

#### For Claude Code:
1. Run Claude in the terminal:
   ```bash
   claude
   # Chat with Claude...
   ```

2. Find the session UUID in `~/.claude/projects/`:
   ```bash
   ls ~/.claude/projects/-Users-fedor-Desktop-your-project/
   ```

3. Click **"Export Claude Session"**
4. Enter the UUID (or leave empty to auto-detect latest)
5. Session is now saved to database

### 3. Restore a Session

#### For Gemini CLI:
1. Click **"Restore Gemini Session"**
2. Enter the session name
3. Wait for the automatic restoration process
4. Gemini will automatically resume the conversation

#### For Claude Code:
1. Click **"Restore Claude Session"**
2. Enter the session UUID
3. Manually run the restore command:
   ```bash
   claude --resume <session-id>
   ```

---

## Features

### Visual Buffer Save/Restore
- Click **"Save Terminal Buffer"** to snapshot the current terminal output
- Automatically restored when reopening a project (future feature)

### List All Sessions
- Click **"List All Sessions"** to see saved sessions
- Shows tool type, session key, and last update timestamp

---

## How It Works

### Gemini CLI ("Direct Injection" Method)

Gemini CLI scans the filesystem for checkpoints - there's no internal registry. This makes restoration simple:

1. **Export:**
   - Reads checkpoint file from `~/.gemini/tmp/<hash>/checkpoint-<name>.json`
   - Stores in database with original path and hash

2. **Import:**
   - Calculates new directory hash (SHA-256 of current working directory)
   - Creates checkpoint file directly with original name
   - Patches all file paths and directory hashes to match new location
   - Gemini automatically discovers it when you run `/chat resume`

### Claude Code (Direct JSONL Manipulation)

Claude Code stores sessions as JSONL files, making it easier to work with:

1. **Export:**
   - Reads `.jsonl` file from `~/.claude/projects/<project-slug>/`
   - Stores in database

2. **Import:**
   - Creates/overwrites JSONL file in target project directory
   - Patches all paths in JSON objects to match new location
   - Creates empty session-env folder (required by Claude)

---

## Database Schema

### ai_sessions Table
```sql
CREATE TABLE ai_sessions (
  id INTEGER PRIMARY KEY,
  project_id TEXT,
  tool_type TEXT CHECK(tool_type IN ('gemini', 'claude')),
  session_key TEXT,
  content_blob TEXT,      -- Full JSON/JSONL content
  original_cwd TEXT,       -- Original working directory
  original_hash TEXT,      -- Gemini directory hash (null for Claude)
  created_at INTEGER,
  updated_at INTEGER
);
```

### tabs Table (Visual Snapshot)
```sql
ALTER TABLE tabs ADD COLUMN visual_snapshot TEXT DEFAULT NULL;
```

---

## Architecture

### Files

- `session-manager.js` - Core SessionManager class with export/import logic
- `database.js` - SQLite methods for session persistence
- `main.js` - IPC handlers for session operations
- `renderer.js` - UI functions for save/restore buttons

### IPC API

```javascript
// Export sessions
ipcRenderer.invoke('session:export-gemini', { dirPath, sessionKey })
ipcRenderer.invoke('session:export-claude', { dirPath, sessionKey })

// Import sessions
ipcRenderer.invoke('session:import-gemini', { dirPath, sessionKey, tabId })
ipcRenderer.invoke('session:import-claude', { dirPath, sessionKey })

// List sessions
ipcRenderer.invoke('session:list', { dirPath, toolType })

// Visual snapshots
ipcRenderer.invoke('session:save-visual', { dirPath, tabIndex, snapshot })
ipcRenderer.invoke('session:get-visual', { dirPath, tabIndex })
```

---

## Troubleshooting

### Gemini Session Not Found
- Ensure you ran `/chat save <name>` in Gemini first
- Check `~/.gemini/tmp/<hash>/` for checkpoint file
- Verify the session name matches exactly (case-sensitive)

### Claude Session Import Fails
- Verify the UUID exists in database (use "List All Sessions")
- Check `~/.claude/projects/` permissions
- Try auto-detect by leaving session key empty during export

### Visual Buffer Not Restoring
- Currently manual only - use "Save Terminal Buffer" button
- Auto-restore on tab creation coming in future version

### Path Patching Issues
- Sessions are tied to project paths
- If you move a project, sessions need to be re-exported
- Check console logs for path replacement errors

---

## Limitations

### Current MVP Limitations
1. **Manual Process** - Requires button clicks (no auto-save on close yet)
2. **No Auto-Restore** - Visual buffers must be manually restored
3. **Session Transfer** - Moving between machines requires database copy
4. **Gemini Dependency** - Requires Gemini CLI to create checkpoints first
5. **Claude UUID** - Need to find UUID manually (auto-detect helps)

### Future Improvements
1. Auto-save on project close
2. Auto-restore visual buffers on tab open
3. Session export/import via files (for transferring between machines)
4. Better UI for session management (list, delete, rename)
5. Gemini checkpoint creation via API (if Google exposes it)

---

## Testing Workflow

### Test Gemini Persistence
```bash
# 1. Start Gemini
gemini

# 2. Chat
You: What is the capital of France?
Gemini: Paris

# 3. Save checkpoint
/chat save test-session-001

# 4. Exit
/exit
```

**In Noted Terminal:**
1. Click "Export Gemini Session"
2. Enter: `test-session-001`
3. Confirm success message

**Restore:**
1. Click "Restore Gemini Session"
2. Enter: `test-session-001`
3. Watch automatic restoration
4. Verify conversation continues from Paris

### Test Claude Persistence
```bash
# 1. Start Claude
claude

# 2. Chat
You: What is 2+2?
Claude: 4

# 3. Find session UUID
# (Check ~/.claude/projects/...)
```

**In Noted Terminal:**
1. Click "Export Claude Session"
2. Leave empty (auto-detect) or enter UUID
3. Confirm success message

**Restore:**
1. Click "Restore Claude Session"
2. Enter the UUID
3. Manually run: `claude --resume <uuid>`
4. Verify conversation continues

---

## API Reference

See `session-manager.js` for full API documentation.

### SessionManager Methods

```javascript
// Gemini
exportGeminiSession(projectPath, sessionKey)
importGeminiSession(projectPath, sessionKey, sendCommand, tabId)

// Claude
exportClaudeSession(projectPath, sessionKey)
importClaudeSession(projectPath, sessionKey)

// Utilities
listSessions(projectPath, toolType = null)
deleteSession(sessionId)
calculateGeminiHash(dirPath) // SHA-256 hash
```

---

## Credits

Based on research:
- Reddit community ("Trojan Horse" technique)
- Gemini CLI checkpoint transfer patterns
- Claude Code JSONL session format analysis

**Implementation:** Session Persistence MVP
**Version:** 1.0
**Status:** Ready for Testing
