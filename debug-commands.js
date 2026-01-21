// === NOTED TERMINAL DEBUG COMMANDS ===
// Copy all and paste into DevTools Console (Cmd+Option+I)

// 1. Check if canvas exists

// 2. Check WebGL support
const canvas = document.querySelector('canvas');
if (canvas) {
  const gl2 = canvas.getContext('webgl2');
  const gl1 = canvas.getContext('webgl');
}

// 3. Check terminal renderer
const term = Array.from(tabs.values())[0]?.terminal;
if (term) {
}

// 4. Check loaded addons
if (term) {
  const addons = term._addonManager?._addons;
  if (addons) {
  } else {
  }
}

// 5. Check for WebGL context on all canvases
document.querySelectorAll('canvas').forEach((c, i) => { || c.getContext('webgl'))
  });
});

// 6. Terminal options
if (term) {
}

