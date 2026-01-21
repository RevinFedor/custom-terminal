# Ink/TUI Render Tearing (Input Jitter)

## Problem
When running CLI tools built with Ink framework (e.g., Claude Code CLI, Gemini CLI), the input bar at the bottom of the terminal jitters/flickers during typing or when the tool is "thinking".

## Symptoms
- Input field visually "jumps" or "shakes"
- Text briefly disappears and reappears
- Cursor position seems unstable
- Problem is specific to Ink-based CLIs, not regular commands

## Root Cause
Ink framework updates the terminal UI at very high frequency (~100 writes/sec, 9ms gaps between updates). Each update sends a sequence:
1. `ESC[2K` - Erase line
2. `ESC[1A` - Move cursor up
3. Write new content

When xterm.js processes these as separate frames:
- Frame 1: Empty line (after erase)
- Frame 2: New content (after write)

The human eye perceives the empty frame as a "flash" or "jitter".

## Solution
Implement a **Write Buffer** that batches PTY output before sending to xterm.

### Key Code (renderer.js)
```javascript
const FLUSH_DELAY = 10; // ms - aligns with 60fps
const MAX_BUFFER_SIZE = 4096; // safety valve

ipcRenderer.on('terminal:data', (event, tabId, data) => {
  const tabData = tabs.get(tabId);
  tabData.writeBuffer += data;

  if (!tabData.pendingWrite) {
    tabData.pendingWrite = setTimeout(() => {
      tabData.terminal.write(tabData.writeBuffer);
      tabData.writeBuffer = '';
      tabData.pendingWrite = null;
    }, FLUSH_DELAY);
  }

  // Flush immediately if buffer too large
  if (tabData.writeBuffer.length > MAX_BUFFER_SIZE) {
    clearTimeout(tabData.pendingWrite);
    tabData.terminal.write(tabData.writeBuffer);
    tabData.writeBuffer = '';
    tabData.pendingWrite = null;
  }
});
```

## Why FLUSH_DELAY = 10ms?
- 60fps = 16.67ms per frame
- 10ms ensures we batch multiple Ink updates into single frame
- Lower values (5ms) may still cause tearing
- Higher values (20ms+) may feel laggy

## Verification
Run debug script and check:
```
Gaps < 10ms: 0
```
If this is 0, the problem is solved. The buffer is successfully grouping fast updates.

## Related Terminal Options
```javascript
const terminal = new Terminal({
  scrollOnUserInput: false,    // Prevents scroll interference
  drawBoldTextInBrightColors: false,
  customGlyphs: true,
  screenReaderMode: false,     // Performance
});
```

## Environment Variables (main.js)
```javascript
env: {
  COLORTERM: 'truecolor',
  FORCE_COLOR: '1',
  LANG: 'en_US.UTF-8'
}
```
These tell Ink that terminal supports full color, preventing fallback to "dumb" mode.

## Debug Metrics (Successful State)
```
Total writes: ~600 per 60s
Avg writes/sec: ~10
Min gap: 10ms (matches FLUSH_DELAY)
Gaps < 10ms: 0
Cursor movements: ~560
Reverse video (input bar): ~450
```
