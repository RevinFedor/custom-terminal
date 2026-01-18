// === 60 SECOND MONITORING ===
// Paste this, then run "claude" and use it for 60 seconds

const term = Array.from(tabs.values())[0]?.terminal;
console.log('=== MONITORING STARTED (60 seconds) ===');
console.log('Run "claude" now and use it normally...');

let writes = [];
let ansiCodes = new Map();
const originalWrite = term.write.bind(term);

term.write = (data) => {
  const now = Date.now();
  const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
  writes.push({
    time: now,
    length: str.length,
    hasCursorMove: /\x1b\[\d*[ABCDEFGH]/.test(str),
    hasErase: /\x1b\[\d*[JK]/.test(str),
    hasCursorSave: /\x1b\[s|\x1b7/.test(str),
    hasCursorRestore: /\x1b\[u|\x1b8/.test(str),
    hasScrollRegion: /\x1b\[\d*;\d*r/.test(str),
    hasReverseVideo: /\x1b\[7m/.test(str),
  });
  const codes = str.match(/\x1b\[[^m]*m|\x1b\[\d*[A-Za-z]/g) || [];
  codes.forEach(code => ansiCodes.set(code, (ansiCodes.get(code) || 0) + 1));
  return originalWrite(data);
};

setTimeout(() => {
  term.write = originalWrite;
  console.log('\n========================================');
  console.log('=== 60 SECOND ANALYSIS COMPLETE ===');
  console.log('========================================\n');

  console.log('=== WRITE FREQUENCY ===');
  console.log('Total writes:', writes.length);
  console.log('Total bytes:', writes.reduce((a, w) => a + w.length, 0));
  console.log('Avg writes/sec:', (writes.length / 60).toFixed(1));

  if (writes.length > 1) {
    const gaps = [];
    for (let i = 1; i < writes.length; i++) gaps.push(writes[i].time - writes[i-1].time);
    gaps.sort((a, b) => a - b);
    console.log('Min gap:', gaps[0], 'ms');
    console.log('Max gap:', gaps[gaps.length - 1], 'ms');
    console.log('Median gap:', gaps[Math.floor(gaps.length / 2)], 'ms');
    console.log('Gaps < 10ms:', gaps.filter(g => g < 10).length, '(potential jitter source)');
  }

  console.log('\n=== ANSI CODES USAGE ===');
  console.log('Cursor movements:', writes.filter(w => w.hasCursorMove).length);
  console.log('Erase commands:', writes.filter(w => w.hasErase).length);
  console.log('Cursor save:', writes.filter(w => w.hasCursorSave).length);
  console.log('Cursor restore:', writes.filter(w => w.hasCursorRestore).length);
  console.log('Scroll regions:', writes.filter(w => w.hasScrollRegion).length);
  console.log('Reverse video (input bar):', writes.filter(w => w.hasReverseVideo).length);

  console.log('\n=== TOP 15 ANSI CODES ===');
  [...ansiCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([code, count]) => {
    console.log(`${code.replace(/\x1b/g, 'ESC')}: ${count}`);
  });

  console.log('\n=== TERMINAL STATE ===');
  console.log('Buffer type:', term.buffer.active.type);
  console.log('Cursor:', { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY });
  console.log('Viewport Y:', term.buffer.active.viewportY);

  console.log('\n=== CURRENT SETTINGS ===');
  console.log('Font:', term.options.fontFamily);
  console.log('FontSize:', term.options.fontSize);
  console.log('LineHeight:', term.options.lineHeight);
  console.log('scrollOnUserInput:', term.options.scrollOnUserInput);
  console.log('customGlyphs:', term.options.customGlyphs);

  console.log('\n=== RAW DATA ===');
  console.log('window.debugData = { writes, ansiCodes }');
  window.debugData = { writes, ansiCodes: Object.fromEntries(ansiCodes) };

  console.log('\n=== DONE ===');
}, 60000);

console.log('Timer started. Results in 60 seconds...');
