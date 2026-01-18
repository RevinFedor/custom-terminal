// === PERFORMANCE DEBUG ===
// Paste into DevTools Console

const term = Array.from(tabs.values())[0]?.terminal;

// 1. Check which font is actually being used
console.log('=== FONT CHECK ===');
const computedFont = getComputedStyle(term.element).fontFamily;
console.log('Requested font:', term.options.fontFamily);
console.log('Computed font:', computedFont);

// Check if MesloLGS NF is available
const testFont = (font) => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const testStr = 'mmmmmmmmmmlli';
  ctx.font = `72px monospace`;
  const defaultWidth = ctx.measureText(testStr).width;
  ctx.font = `72px ${font}, monospace`;
  const testWidth = ctx.measureText(testStr).width;
  return defaultWidth !== testWidth;
};

console.log('MesloLGS NF installed:', testFont('"MesloLGS NF"'));
console.log('Fira Code installed:', testFont('"Fira Code"'));
console.log('Menlo installed:', testFont('Menlo'));

// 2. Check char size service (font metrics)
console.log('\n=== CHAR SIZE SERVICE ===');
const charSize = term._core._charSizeService;
console.log('Char width:', charSize?.width);
console.log('Char height:', charSize?.height);
console.log('Has valid size:', charSize?.hasValidSize);

// 3. Monitor write frequency
console.log('\n=== WRITE FREQUENCY MONITOR ===');
console.log('Starting 5 second monitor...');
let writeCount = 0;
let totalBytes = 0;
const originalWrite = term.write.bind(term);
term.write = (data) => {
  writeCount++;
  totalBytes += typeof data === 'string' ? data.length : data.byteLength;
  return originalWrite(data);
};

setTimeout(() => {
  term.write = originalWrite;
  console.log('Write calls in 5s:', writeCount);
  console.log('Total bytes in 5s:', totalBytes);
  console.log('Avg writes/sec:', (writeCount / 5).toFixed(1));
  console.log('Avg bytes/sec:', (totalBytes / 5).toFixed(0));
}, 5000);

// 4. Check devicePixelRatio
console.log('\n=== DISPLAY INFO ===');
console.log('devicePixelRatio:', window.devicePixelRatio);
console.log('Screen size:', screen.width, 'x', screen.height);

// 5. Check renderer dimensions
console.log('\n=== RENDERER DIMENSIONS ===');
const renderer = term._core._renderService._renderer._value;
console.log('Canvas dimensions:', renderer?._canvas?.width, 'x', renderer?._canvas?.height);
console.log('Device max texture size:', renderer?._deviceMaxTextureSize);

console.log('\n=== RUN A COMMAND AND WATCH WRITE FREQUENCY ===');
console.log('(Results will appear in 5 seconds)');
