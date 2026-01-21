// === CLAUDE CODE CLI DEBUG ===
// Run this BEFORE launching claude command
// Then run: claude
// Wait 10 seconds while using it, then check console

const term = Array.from(tabs.values())[0]?.terminal;


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


  // Time between writes
  if (writes.length > 1) {
    const gaps = [];
    for (let i = 1; i < writes.length; i++) {
      gaps.push(writes[i].time - writes[i-1].time);
    }
    gaps.sort((a, b) => a - b);
  }


  const sortedCodes = [...ansiCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  sortedCodes.forEach(([code, count]) => {
    const readable = code
      .replace(/\x1b/g, 'ESC')
      .replace(/\[/, '[');
  });



  window.claudeDebug = { writes, ansiCodes: Object.fromEntries(ansiCodes) };

}, 10000);

