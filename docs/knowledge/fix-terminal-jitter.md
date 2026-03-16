---
name: Terminal Jitter Fix (Synchronized Output DEC 2026)
description: Solution for viewport jitter in xterm.js when Claude Code uses differential rendering with DEC mode 2026 sync frames
type: fix
---

# Terminal Jitter Fix: Synchronized Output (DEC 2026) Support

## Problem
Terminal viewport "jitters" or "twitches" when Claude Code CLI writes output, especially during file reads or spinner transitions. Visual symptom: prompt line visually "jumps" or cursor position becomes unstable mid-frame.

## Root Cause
Claude Code (as of Feb 2026) uses **Synchronized Output** protocol (DEC mode 2026):
- Wraps each "frame" of differential updates in `\x1b[?2026h` (SYNC_START) and `\x1b[?2026l` (SYNC_END) escape sequences
- Between these markers, multiple intermediate cursor movements and partial line redraws occur
- **xterm.js 5.5.0 does NOT natively buffer these frames** — it renders each escape sequence immediately
- Result: xterm renders intermediate states (empty lines, cursor jumps), causing visual tearing

Example problematic sequence:
```
\x1b[?2026h
\x1b[2K           <- Erase line
\x1b[1A           <- Cursor up
\x1b[2K           <- Erase next line
<new content>
\x1b[?2026l       <- SYNC_END
```

Without buffering, xterm shows intermediate frames: **empty line → cursor up → empty line again → content**. This reads as "jitter" to the eye.

## Solution: Sync Frame Aware Write Buffer

Implement **manual buffering** in the renderer that:
1. **Detects sync markers** in incoming PTY data
2. **Holds writes** while inside an incomplete sync frame (`lastIndexOf(SYNC_START) > lastIndexOf(SYNC_END)`)
3. **Flushes atomically** when sync frame closes (or safety timeout fires)

### Implementation (Terminal.tsx)

```typescript
// Constants
const FLUSH_DELAY = 16;              // ms - one 60fps frame
const MAX_BUFFER_SIZE = 65536;       // 64KB safety valve
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const SYNC_SAFETY_TIMEOUT = 200;     // ms - force flush if sync never closes

// In component:
const writeBufferRef = useRef<string>('');
const pendingWriteRef = useRef<NodeJS.Timeout | null>(null);
const syncSafetyRef = useRef<NodeJS.Timeout | null>(null);

// In handleData:
writeBufferRef.current += payload.data;

// Detect if we're inside an incomplete sync frame
const buf = writeBufferRef.current;
const lastOpen = buf.lastIndexOf(SYNC_START);
const lastClose = buf.lastIndexOf(SYNC_END);
const insideSyncFrame = lastOpen !== -1 && lastOpen > lastClose;

if (insideSyncFrame) {
  // Cancel any scheduled flush, set safety timeout
  clearTimeout(pendingWriteRef.current);
  pendingWriteRef.current = null;

  if (!syncSafetyRef.current) {
    syncSafetyRef.current = setTimeout(() => {
      syncSafetyRef.current = null;
      xtermInstance.current?.write(writeBufferRef.current);
      writeBufferRef.current = '';
    }, SYNC_SAFETY_TIMEOUT);
  }
} else {
  // Not in sync frame — schedule normal flush
  clearTimeout(syncSafetyRef.current);
  syncSafetyRef.current = null;

  if (!pendingWriteRef.current) {
    pendingWriteRef.current = setTimeout(() => {
      xtermInstance.current?.write(writeBufferRef.current);
      writeBufferRef.current = '';
      pendingWriteRef.current = null;
    }, FLUSH_DELAY);
  }
}

// Safety valve: flush if buffer grows too large
if (writeBufferRef.current.length > MAX_BUFFER_SIZE) {
  xtermInstance.current?.write(writeBufferRef.current);
  writeBufferRef.current = '';
}
```

## Key Parameters

### FLUSH_DELAY = 16ms
- **Why 16ms:** One frame at 60fps = 16.67ms. Batching multiple Ink updates into a single frame eliminates intermediate rendering.
- **Too low (5-10ms):** May still render intermediate states, causing tearing.
- **Too high (20ms+):** May feel sluggish, defeats purpose of differential rendering.

### SYNC_SAFETY_TIMEOUT = 200ms
- **Invisible Intent (UX Psychology):** If Claude Code sends a malformed or stuck sync frame (never sends SYNC_END), we cannot freeze the terminal indefinitely.
- **200ms threshold:** Long enough to complete any realistic differential update batch, short enough that user won't notice a pause if something goes wrong.
- **Fallback:** Force flush and continue. Better to show one frame of jitter than to freeze the terminal.

### MAX_BUFFER_SIZE = 65536 (64KB)
- **Why 64KB:** Claude's differential renderer can emit heavyweight frames (large diffs, multiple redraws). 64KB accommodates these without premature flushing mid-frame.
- **Safety valve:** If buffer exceeds this despite buffering, flush immediately to prevent memory exhaustion.

## Result
- Smooth terminal rendering during Claude Code execution
- No viewport "jitter" or "jump" artifacts
- Maintains semantic correctness of differential rendering (xterm never sees broken intermediate states)
- Graceful fallback if sync protocol breaks (200ms timeout prevents freezing)

## Related
- `fact-terminal-rendering.md` — General terminal rendering architecture
- `Terminal.tsx:266-273` — Constants and write buffer refs
- `Terminal.tsx:436-517` — `handleData` implementation with sync frame detection
