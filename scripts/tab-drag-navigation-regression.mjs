#!/usr/bin/env node
// Actual gesture/indicator in an immutable, private Electron renderer. No
// Noted main/storage/PTY/ports or OS input. Optional same-fixture baseline.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const shared = path.resolve(root, 'vendor/noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js');
const arg = process.argv.indexOf('--baseline-dir');
const baseline = arg >= 0 ? process.argv[arg + 1] : null;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-dnd-navigation-'));
const proof = { dir, baseline, checks: [], samples: [] };
const overrides = new Map();
if (baseline) {
  for (const rel of ['src/renderer/components/Workspace/TabDragNavigationController.tsx',
    'src/renderer/utils/tabDragNavigationBridge.ts', 'src/renderer/utils/sidebarTabDragBridge.mjs']) {
    let source = await fs.readFile(path.join(baseline, rel), 'utf8');
    if (rel.endsWith('sidebarTabDragBridge.mjs')) source += '\nexport const getSidebarTabDragSessionSnapshot=getSidebarTabDragSnapshot;\nexport const subscribeSidebarTabDragSession=subscribeSidebarTabDrag;';
    overrides.set(path.join(root, rel), source);
  }
  overrides.set(shared, await fs.readFile(path.join(baseline, 'useOutlineDnd.js'), 'utf8'));
}
await build({ entryPoints: [path.join(root, 'scripts/fixtures/tab-drag-navigation.tsx')],
  outfile: path.join(dir, 'fixture.js'), bundle: true, format: 'iife',
  alias: { '@noted/structured-dnd/react': shared, react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom') },
  define: { 'process.env.NODE_ENV': '"production"' },
  // Store is the callback boundary under test, not a real workflow mutation.
  plugins: [{ name: 'fixture', setup(b) {
    b.onLoad({ filter: /useWorkspaceStore\.ts$/ }, () => ({ contents: `export const useWorkspaceStore={getState:()=>({switchWorkspaceSpace:id=>window.calls.push({kind:'workflow',id,at:performance.now()})})}`, loader: 'ts' }));
    b.onLoad({ filter: /\.(tsx?|m?js)$/ }, args => overrides.has(args.path)
      ? { contents: overrides.get(args.path), loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' } : undefined);
  } }],
});
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#181818;color:#ddd;font:14px sans-serif}button{position:absolute;top:20px;width:180px;height:50px;color:#eee;background:#335}
.retained{position:absolute;top:600px;width:800px;height:400px;opacity:0;pointer-events:none;overflow:hidden}
.row{display:flex;padding:3px}.row span{cursor:text}
</style><div id="retained"></div><div id="fixture"></div><script>
document.getElementById('retained').innerHTML=Array.from({length:100},()=>'<section class="retained">'+Array.from({length:125},()=>'<div class="row"><span>History</span><b>text</b><span>content</span></div>').join('')+'</section>').join('');
</script><script src="fixture.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();const win=new BrowserWindow({show:false,width:1020,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});
win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);win.loadFile(${JSON.stringify(path.join(dir, 'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('[data-row="a"]');
  await page.screenshot({ path: path.join(dir, 'initial.png') });
  proof.runtime = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  for (let i = 0; i < 3; i++) {
    const before = await metrics();
    const motion = await page.evaluate(() => window.motion());
    const after = await metrics();
    proof.samples.push({ ...motion, native: Object.fromEntries(['ThreadTime','ScriptDuration','RecalcStyleDuration','LayoutDuration','LayoutCount'].map(k => [k, (after[k] - before[k]) * (k === 'LayoutCount' ? 1 : 1000)])) });
    assert.ok(Math.abs(motion.point.x - motion.latest.clientX) < 2);
    if (!baseline) assert.ok(motion.counts.observers < 80, 'pointer must not broadcast React renders');
  }
  proof.checks.push('last pointer is painted; subscriber render counts recorded for baseline comparison');
  const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const move = async (x, y, meta = true) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers: meta ? 4 : 0 });
    await frame();
  };
  const pickup = async () => {
    await page.mouse.move(80, 120); await page.mouse.down(); await move(88, 128, false);
    await page.waitForFunction(() => window.state?.phase === 'dragging');
    await page.keyboard.down('Meta');
  };
  const release = async () => { await page.mouse.up(); await page.keyboard.up('Meta'); await frame(); };
  await page.evaluate(() => { window.calls = []; });
  await pickup(); await move(420, 45);
  const count = await page.evaluate(() => window.counts.outline);
  await page.waitForTimeout(200);
  proof.stationaryRenders = await page.evaluate(n => window.counts.outline - n, count);
  if (!baseline) assert.equal(proof.stationaryRenders, 0, 'external dwell must not render an unchanged outline');
  await page.waitForFunction(() => window.calls.some(c => c.id === 'workflow-b'));
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.id === 'workflow-b').length), 1);
  await move(630, 45);
  await page.waitForFunction(() => window.calls.some(c => c.id === 'project-b'));
  await release();
  assert.equal(await page.locator('[data-tab-drag-navigation-indicator]').count(), 0);
  assert.equal(await page.locator('[data-sidebar-tab-drag-cursor-chip]').count(), 0);
  proof.checks.push('same sidebar Cmd gesture dwells into workflow, then project; release clears feedback');
  await page.evaluate(() => { window.calls = []; });
  await pickup(); await move(835, 45); await page.waitForTimeout(560);
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  assert.equal(await page.locator('[data-tab-drag-navigation-indicator]').count(), 0);
  await move(630, 45); await move(350, 480); await page.waitForTimeout(560);
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await release();
  proof.checks.push('blocked target and leaving before 500ms do not navigate');
  await pickup(); await move(420, 45); await page.keyboard.up('Meta'); await move(90, 180, false);
  assert.equal(await page.evaluate(() => window.state.navigationMode), false);
  await page.keyboard.press('Escape'); await release();
  assert.equal(await page.evaluate(() => window.state), null);
  proof.checks.push('Meta release returns to outline; Escape cleans the same gesture');
  await pickup(); await move(90, 200); await page.waitForFunction(() => window.order.includes('child'));
  await page.keyboard.press('Escape'); await release();
  proof.checks.push('ordinary folder dwell still expands after external-target optimization');
  await page.screenshot({ path: path.join(dir, 'final.png') });
  assert.deepEqual(errors, []); proof.errors = errors; proof.pass = true;
} catch (error) { proof.pass = false; proof.error = error.stack; process.exitCode = 1; }
finally { await app?.close(); await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2)); }
