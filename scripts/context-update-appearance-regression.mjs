#!/usr/bin/env node
// Actual renderer components with controlled IPC in a private, offscreen Electron.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-context-appearance-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name), {
  recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git'),
});
await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
await fs.copyFile(path.join(repo, 'scripts/fixtures/context-update-appearance.tsx'), path.join(snapshot, 'scripts/fixtures/context-update-appearance.tsx'));
await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
const shared = path.join(artifact, 'noted-shared/packages');
for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, name), {
  recursive: true, filter: p => !p.includes('/node_modules'),
});
await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/context-update-appearance.tsx')], bundle: true,
  outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
  alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
    '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
    react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' },
});
execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
  '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
await fs.writeFile(path.join(artifact, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact, 'user-data'));
await fs.writeFile(path.join(artifact, 'preload.cjs'), `const {ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
ipcMain.handle('fixture:invoke',(_e,{channel,args})=>{
 if (/send-command|send-prompt|orchestration.*create/.test(channel)) throw new Error('Fixture must never send: '+channel);
 if(channel==='file:exists-batch')return Object.fromEntries(args[0].map(p=>[p,false]));
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return [];
 if(channel==='terminal:getCommandStates')return {};
 if(channel==='terminal:hasRunningProcess')return {isRunning:false};
 if(channel==='terminal:getCommandState'||channel.includes('getState')||channel.includes('get-state'))return null;
 return {success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:1060,height:760,
webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact, 'preload.cjs'))}}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: path.join(artifact, 'user-data') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
const result = { artifact, checks: [], errors: [] };
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForFunction(() => window.fixture?.ready);
  const band = page.locator('[data-history-composer-prompt-band]');
  await band.locator('.hp-context-update-chip').waitFor();
  await page.waitForSelector('[data-history-viewport-ready="1"]');
  await page.locator('[data-history-viewport-loader]').waitFor({ state: 'hidden' });
  await page.locator('[data-history-user-prompt-band] .hp-context-update-chip').waitFor();
  await page.evaluate(() => window.fixture.seedContextMeter());
  const measure = () => page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const overlap = (a, b) => Math.min(a.right, b.right) > Math.max(a.x, b.x) + 0.5 && Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y) + 0.5;
    const bands = [...document.querySelectorAll('[data-history-composer-prompt-band], [data-history-user-prompt-band]')].map(b => ({
      overflow: b.scrollWidth > b.clientWidth + 1,
      chips: [...b.querySelectorAll('.cb-composer-chip')].map(c => ({ context: c.classList.contains('hp-context-update-chip'),
        rect: rect(c), color: getComputedStyle(c).color, background: getComputedStyle(c).backgroundColor,
        icon: c.querySelector('.cb-composer-chip-leading') ? getComputedStyle(c.querySelector('.cb-composer-chip-leading')).color : null,
        segment: getComputedStyle(c, '::before').backgroundColor,
      })),
    }));
    const markers = [...document.querySelectorAll('[data-tab-context-update-badge]')].map(b => {
      const card = b.parentElement, top = card.querySelector('[data-tab-top-left-signals]');
      const tasks = [...card.querySelectorAll('[data-task-plan-tab-marker]')];
      return { rect: rect(b), card: rect(card), color: getComputedStyle(b).color,
        animation: getComputedStyle(b.querySelector('svg')).animationName,
        inTop: !!b.closest('[data-tab-top-left-signals]'),
        overlapTop: !!top && overlap(rect(b), rect(top)), overlapTasks: tasks.some(t => overlap(rect(b), rect(t))),
        taskCount: tasks.length,
      };
    });
    return { bands, markers };
  });
  for (const [width, gap, fontSize, paddingY] of [[1060, 4, 14, 3], [610, 0, 14, 3], [610, 2, 12, 3], [1060, 8, 20, 5], [610, 0, 12, 0]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 760), width);
    await page.evaluate(([g, f, p]) => window.fixture.geometry(g, f, p), [gap, fontSize, paddingY]);
    await page.evaluate(() => { window.fixture.stableSince = null; window.fixture.lastGeometry = ''; });
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-fixture-history]');
      const rect = host.getBoundingClientRect();
      const geometry = `${rect.width}:${rect.height}`;
      const busy = !!document.querySelector('[data-history-viewport-loader]');
      if (busy || window.fixture.lastGeometry !== geometry) {
        window.fixture.stableSince = null; window.fixture.lastGeometry = geometry;
      } else if (window.fixture.stableSince === null) window.fixture.stableSince = performance.now();
      return !busy && window.fixture.stableSince !== null && performance.now() - window.fixture.stableSince > 300;
    });
    const state = await measure();
    assert.equal(state.bands.length, 2, 'sent and composer bands must both be painted');
    assert.equal(state.markers.length, 2, 'sidebar and pane both show pending context');
    for (const m of state.markers) {
      assert.equal(m.color, 'rgb(167, 139, 250)');
      assert.equal(m.animation, 'none');
      assert.ok(m.rect.y > m.card.y + m.card.height / 2 - 2, JSON.stringify(m));
      assert.equal(m.inTop || m.overlapTop || m.overlapTasks, false, JSON.stringify(m));
      assert.equal(m.taskCount, 2);
    }
    for (const b of state.bands) {
      assert.equal(b.overflow, false, JSON.stringify(b));
      const update = b.chips.find(c => c.context), ordinary = b.chips.find(c => !c.context);
      assert.ok(update && ordinary);
      assert.equal(update.background, 'rgb(36, 36, 38)');
      assert.equal(update.segment, 'rgb(56, 43, 85)');
      assert.equal(update.icon, 'rgb(167, 139, 250)');
      assert.notEqual(update.background, ordinary.background);
      assert.ok(Math.abs(update.rect.height - ordinary.rect.height) < 1);
    }
    result.checks.push({ width, gap, fontSize, paddingY, bands: state.bands.length, markers: state.markers.length });
    await page.screenshot({ path: path.join(artifact, `appearance-${width}-${gap}-${fontSize}-${paddingY}.png`) });
  }
  await page.evaluate(() => window.fixture.geometry(4, 14));
  await band.locator('.hp-context-update-chip').click({ button: 'middle' });
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-context-update-badge]').length === 0);
  await page.locator('.cm-content[contenteditable="true"]').click();
  await page.keyboard.press('Meta+z');
  await band.locator('.hp-context-update-chip').waitFor();
  result.checks.push('middle-click hide + Cmd+Z restores the update and lower badges');
  await band.locator('.hp-context-update-chip').click();
  await page.getByRole('dialog', { name: /Рабочее состояние/ }).waitFor();
  await page.screenshot({ path: path.join(artifact, 'preview.png') });
  await page.getByRole('dialog', { name: /Рабочее состояние/ }).getByRole('button', { name: /input/i }).click();
  assert.ok(await page.locator('.cm-content').innerText().then(t => t.includes('context-update-id="context-appearance-update"')));
  result.checks.push('move to input keeps the exact context identity');
  await page.evaluate(() => window.fixture.restored());
  await band.locator('.hp-context-update-chip').waitFor();
  assert.equal((await measure()).markers.length, 0, 'a restored chip does not invent pending updates');
  result.checks.push('restored composer chip keeps the context segment');

  // Mode changes use the real context-menu buttons and Zustand actions. The
  // fixture IPC boundary cannot send sound, Telegram or production mutations.
  await page.evaluate(() => window.fixture.reset());
  const sidebarTab = page.locator('[data-fixture-sidebar] [data-tab-item]').first();
  const onceButton = page.locator('[data-tab-context-action="notify-once"]');
  const persistentButton = page.locator('[data-tab-context-action="notify-persistent"]');
  const bells = page.locator('[data-tab-completion-notification-badge]');
  const readBells = () => bells.evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(), c = node.parentElement.getBoundingClientRect();
    const svg = node.querySelector('svg');
    const targets = [...node.parentElement.querySelectorAll('[data-tab-pane-map], [data-pane-map-workflow-icon], [data-pane-map-cell], [data-tab-top-left-signals], [data-task-plan-tab-marker], [data-tab-process-bar]')];
    const overlaps = targets.some(target => { const t = target.getBoundingClientRect();
      return Math.min(r.right, t.right) > Math.max(r.left, t.left) + 0.5 && Math.min(r.bottom, t.bottom) > Math.max(r.top, t.top) + 0.5; });
    return { mode: svg.getAttribute('data-tab-notification-mode'), fill: svg.getAttribute('fill'),
      color: getComputedStyle(svg).color, top: r.top - c.top, right: c.right - r.right,
      width: r.width, height: r.height, cardWidth: c.width, overlaps };
  }));
  assert.equal(await bells.count(), 0);
  await sidebarTab.click({ button: 'right' });
  assert.equal(await onceButton.locator('svg').getAttribute('fill'), 'none');
  assert.equal(await persistentButton.locator('svg').getAttribute('fill'), 'currentColor');
  await page.screenshot({ path: path.join(artifact, 'notification-menu-off.png') });
  await onceButton.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-completion-notification-badge]').length === 2);
  const onceBells = await readBells();
  assert.ok(onceBells.every(b => b.mode === 'once' && b.fill === 'none' && b.color === 'rgb(248, 113, 113)'));
  await sidebarTab.click({ button: 'right' });
  await persistentButton.click();
  const persistentBells = await readBells();
  assert.ok(persistentBells.every(b => b.mode === 'persistent' && b.fill === 'currentColor' && b.color === 'rgb(248, 113, 113)'));
  assert.deepEqual(persistentBells.map(b => [b.width, b.height, b.cardWidth]), onceBells.map(b => [b.width, b.height, b.cardWidth]));
  assert.ok(persistentBells.every(b => !b.overlaps && b.top <= 1 && b.right >= 4 && b.right <= 7), JSON.stringify(persistentBells));
  await sidebarTab.click({ button: 'right' });
  await page.screenshot({ path: path.join(artifact, 'notification-menu-on.png') });
  await onceButton.click();
  assert.ok((await readBells()).every(b => b.mode === 'persistent'), 'persistent mode survives disabling only this turn');
  await page.evaluate(() => window.fixture.processSide('right'));
  assert.ok((await readBells()).every(b => !b.overlaps), 'right-side process bar and pane map keep their own space');
  await page.screenshot({ path: path.join(artifact, 'notification-persistent.png') });
  await sidebarTab.click({ button: 'right' });
  await persistentButton.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-completion-notification-badge]').length === 0);
  assert.equal((await measure()).markers.length, 2, 'notification toggles must not clear pending context');
  result.checks.push('real menu: gray/active outline vs filled bell; same top-right mode in sidebar and pane; persistent survives one-shot disable; full disable clears both');
  assert.deepEqual(result.errors, []);
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1;
  await app.firstWindow().then(p => p.screenshot({ path: path.join(artifact, 'failure.png') })).catch(() => {});
} finally {
  await app.close();
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
