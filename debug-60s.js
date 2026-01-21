// === 60 SECOND MONITORING ===
// Paste this, then run "claude" and use it for 60 seconds

const term = Array.from(tabs.values())[0]?.terminal;

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


  if (writes.length > 1) {
    const gaps = [];
    for (let i = 1; i < writes.length; i++) gaps.push(writes[i].time - writes[i-1].time);
    gaps.sort((a, b) => a - b);
  }


  [...ansiCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([code, count]) => {
  });



  window.debugData = { writes, ansiCodes: Object.fromEntries(ansiCodes) };

}, 60000);

