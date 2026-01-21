// === PERFORMANCE DEBUG ===
// Paste into DevTools Console

const term = Array.from(tabs.values())[0]?.terminal;

// 1. Check which font is actually being used
const computedFont = getComputedStyle(term.element).fontFamily;

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


// 2. Check char size service (font metrics)
const charSize = term._core._charSizeService;

// 3. Monitor write frequency
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
}, 5000);

// 4. Check devicePixelRatio

// 5. Check renderer dimensions
const renderer = term._core._renderService._renderer._value;

