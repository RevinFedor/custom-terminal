// === WEBGL DEEP DEBUG ===
// Paste into DevTools Console

const term = Array.from(tabs.values())[0]?.terminal;

// 1. Check current renderer type
console.log('=== CURRENT RENDERER ===');
const renderer = term._core._renderService._renderer._value;
console.log('Renderer object:', renderer);
console.log('Renderer constructor:', renderer?.constructor);
console.log('Renderer type:', renderer?.constructor?.name || 'unknown');

// 2. Check if WebglAddon is in the addons list
console.log('\n=== ADDON INSTANCES ===');
const addons = term._addonManager?._addons || [];
addons.forEach((addon, i) => {
  console.log(`Addon ${i}:`, {
    instance: addon?.instance,
    constructor: addon?.instance?.constructor,
    name: addon?.instance?.constructor?.name,
    hasActivate: typeof addon?.instance?.activate === 'function'
  });
});

// 3. Try to manually create WebGL context on the main canvas
console.log('\n=== MANUAL WEBGL TEST ===');
const canvases = document.querySelectorAll('canvas');
canvases.forEach((c, i) => {
  // Don't test on existing contexts, create new test
  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
  console.log(`WebGL available in browser: ${!!gl}`);
  if (gl) {
    console.log('WebGL Vendor:', gl.getParameter(gl.VENDOR));
    console.log('WebGL Renderer:', gl.getParameter(gl.RENDERER));
  }
});

// 4. Check if there's a _webglAddon property
console.log('\n=== WEBGL ADDON REFERENCE ===');
console.log('term._webglAddon:', term._webglAddon);

// 5. Look for WebGL-related properties in renderService
console.log('\n=== RENDER SERVICE INTERNALS ===');
const rs = term._core._renderService;
console.log('RenderService keys:', Object.keys(rs));
console.log('_renderer:', rs._renderer);
console.log('_renderer._value:', rs._renderer?._value);
console.log('_renderer._value keys:', rs._renderer?._value ? Object.keys(rs._renderer._value) : 'N/A');

// 6. Check dimensions
console.log('\n=== DIMENSIONS ===');
console.log('term.element size:', {
  width: term.element?.offsetWidth,
  height: term.element?.offsetHeight
});

console.log('\n=== WEBGL DEBUG COMPLETE ===');
