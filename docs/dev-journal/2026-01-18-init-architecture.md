# 2026-01-18: The "Project-First" Refactor

## Context
We started with a standard terminal emulator (tabs, simple notes).
**Problem:** Working with AI tools (Gemini/Claude CLI) requires persistent context.
**Initial Idea:** Save session history (restore `tmux` style).
**Research:** Gemini CLI and Claude Code store sessions in isolated/hidden DBs (`~/.gemini/tmp/hash/`). Restoring them programmatically ("Trojan Horse" method) is unstable and hacky.

## Decision: Pivot to "Context Injection"
Instead of restoring the *internal state* of the AI tool, we restore the *User's Context* (Notes, Docs, Prompts).
We shifted the architecture from "Terminal App" to "Project Workstation".

## Key Changes implemented

### 1. Dashboard Architecture
*   **Before:** App opens directly to a blank terminal.
*   **After:** App opens to a Dashboard. User selects a project context ("hh-tool", "custom-terminal") before spawning shells.

### 2. Multi-Project Support
*   We realized users work on multiple repos simultaneously.
*   Implemented **Project Chips** in the title bar.
*   **Technical Challenge:** `renderer.js` assumed a single `tabs` Map.
*   **Solution:** Refactored state to `openProjects = Map<ProjectId, ProjectState>`. Each project has its own isolated tabs and active state.

### 3. IPC Fixes
*   **Bug:** `terminal:data` was broadcasting to all tabs or using PIDs inconsistently.
*   **Fix:** Enforced `tabId` as the single source of truth in `main.js` and `renderer.js`. PTY output is now routed strictly to its owner tab.

### 4. Quick Actions
*   Added `.prompt.md` concept (simplified for now to JSON config).
*   **UX:** Sidebar "Actions" tab.
*   **Logic:** `terminal.paste(cmd + '\r')` allows one-click execution of complex prompts (e.g., "Summarize this session").

## Future Steps
*   File Tree integration (left sidebar).
*   Real `.prompt.md` parsing from `Global-Templates`.
*   Search across Project Notes.
