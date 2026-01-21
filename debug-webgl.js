// === WEBGL DEEP DEBUG ===
// Paste into DevTools Console

const term = Array.from(tabs.values())[0]?.terminal;

// 1. Check current renderer type
const renderer = term._core._renderService._renderer._value;

// 2. Check if WebglAddon is in the addons list
const addons = term._addonManager?._addons || [];
addons.forEach((addon, i) => {});

// 3. Try to manually create WebGL context on the main canvas
const canvases = document.querySelectorAll('canvas');
canvases.forEach((c, i) => {
  // Don't test on existing contexts, create new test
  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
  if (gl) {
  }
});

// 4. Check if there's a _webglAddon property

// 5. Look for WebGL-related properties in renderService
const rs = term._core._renderService;

// 6. Check dimensions
