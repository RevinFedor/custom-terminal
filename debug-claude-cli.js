// === CLAUDE CODE CLI DEBUG ===
// Run this BEFORE launching claude command
// Then run: claude
// Wait 10 seconds while using it, then check console

const term = Array.from(tabs.values())[0]?.terminal;

console.log('=== CLAUDE CODE CLI DEEP DEBUG ===');
console.log('Starting monitoring... Run "claude" now and use it for 10 seconds');

// Track all writes
let writes = [];
let ansiCodes = new Map();
const originalWrite = term.write.bind(term);

term.write = (data) => {
  const now = Date.now();
  const str = typeof data === 'string' ? data : new TextDecoder().decode(data);

  writes.push({
    time: now,
    length: str.length,
    // Check for cursor movement / screen clearing codes
    hasCursorMove: /\x1b\[\d*[ABCDEFGH]/.test(str),
    hasErase: /\x1b\[\d*[JK]/.test(str),
    hasCursorSave: /\x1b\[s|\x1b7/.test(str),
    hasCursorRestore: /\x1b\[u|\x1b8/.test(str),
    hasScrollRegion: /\x1b\[\d*;\d*r/.test(str),
  });

  // Count ANSI codes
  const codes = str.match(/\x1b\[[^m]*m|\x1b\[\d*[A-Za-z]/g) || [];
  codes.forEach(code => {
    ansiCodes.set(code, (ansiCodes.get(code) || 0) + 1);
  });

  return originalWrite(data);
};

// Stop after 10 seconds and report
setTimeout(() => {
  term.write = originalWrite;

  console.log('\n=== WRITE FREQUENCY ANALYSIS ===');
  console.log('Total writes:', writes.length);
  console.log('Total bytes:', writes.reduce((a, w) => a + w.length, 0));
  console.log('Avg writes/sec:', (writes.length / 10).toFixed(1));

  // Time between writes
  if (writes.length > 1) {
    const gaps = [];
    for (let i = 1; i < writes.length; i++) {
      gaps.push(writes[i].time - writes[i-1].time);
    }
    gaps.sort((a, b) => a - b);
    console.log('Min gap between writes:', gaps[0], 'ms');
    console.log('Max gap between writes:', gaps[gaps.length - 1], 'ms');
    console.log('Median gap:', gaps[Math.floor(gaps.length / 2)], 'ms');
  }

  console.log('\n=== ANSI CODE ANALYSIS ===');
  console.log('Writes with cursor movement:', writes.filter(w => w.hasCursorMove).length);
  console.log('Writes with erase commands:', writes.filter(w => w.hasErase).length);
  console.log('Writes with cursor save:', writes.filter(w => w.hasCursorSave).length);
  console.log('Writes with cursor restore:', writes.filter(w => w.hasCursorRestore).length);
  console.log('Writes with scroll region:', writes.filter(w => w.hasScrollRegion).length);

  console.log('\n=== TOP 10 ANSI CODES ===');
  const sortedCodes = [...ansiCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  sortedCodes.forEach(([code, count]) => {
    const readable = code
      .replace(/\x1b/g, 'ESC')
      .replace(/\[/, '[');
    console.log(`${readable}: ${count} times`);
  });

  console.log('\n=== TERMINAL STATE ===');
  console.log('Cursor position:', { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY });
  console.log('Viewport:', { scrollTop: term.buffer.active.viewportY, baseY: term.buffer.active.baseY });
  console.log('Buffer type:', term.buffer.active.type);

  console.log('\n=== XTERM OPTIONS ===');
  console.log('scrollback:', term.options.scrollback);
  console.log('fastScrollSensitivity:', term.options.fastScrollSensitivity);
  console.log('smoothScrollDuration:', term.options.smoothScrollDuration);

  console.log('\n=== DEBUG COMPLETE ===');
  console.log('Raw data saved to window.claudeDebug');
  window.claudeDebug = { writes, ansiCodes: Object.fromEntries(ansiCodes) };

}, 10000);

console.log('Monitoring active for 10 seconds...');
