// === NOTED TERMINAL DEBUG COMMANDS ===
// Copy all and paste into DevTools Console (Cmd+Option+I)

// 1. Check if canvas exists
console.log('=== CANVAS CHECK ===');
console.log('Canvas exists:', !!document.querySelector('canvas'));

// 2. Check WebGL support
console.log('\n=== WEBGL CHECK ===');
const canvas = document.querySelector('canvas');
if (canvas) {
  const gl2 = canvas.getContext('webgl2');
  const gl1 = canvas.getContext('webgl');
  console.log('WebGL2:', !!gl2);
  console.log('WebGL1:', !!gl1);
  console.log('Result:', gl2 ? 'WebGL2 OK' : (gl1 ? 'WebGL1 OK' : 'NO WEBGL'));
}

// 3. Check terminal renderer
console.log('\n=== RENDERER CHECK ===');
const term = Array.from(tabs.values())[0]?.terminal;
if (term) {
  console.log('Terminal exists:', true);
  console.log('RenderService:', term._core?._renderService);
  console.log('Renderer:', term._core?._renderService?._renderer);
  console.log('Renderer name:', term._core?._renderService?._renderer?.constructor?.name);
}

// 4. Check loaded addons
console.log('\n=== ADDONS CHECK ===');
if (term) {
  const addons = term._addonManager?._addons;
  if (addons) {
    console.log('Loaded addons:', addons.map(a => a?.instance?.constructor?.name));
  } else {
    console.log('No addon manager found');
  }
}

// 5. Check for WebGL context on all canvases
console.log('\n=== ALL CANVASES ===');
document.querySelectorAll('canvas').forEach((c, i) => {
  console.log(`Canvas ${i}:`, {
    width: c.width,
    height: c.height,
    className: c.className,
    hasWebGL: !!(c.getContext('webgl2') || c.getContext('webgl'))
  });
});

// 6. Terminal options
console.log('\n=== TERMINAL OPTIONS ===');
if (term) {
  console.log('fontSize:', term.options.fontSize);
  console.log('fontFamily:', term.options.fontFamily);
  console.log('lineHeight:', term.options.lineHeight);
  console.log('cols:', term.cols);
  console.log('rows:', term.rows);
}

console.log('\n=== DEBUG COMPLETE ===');
