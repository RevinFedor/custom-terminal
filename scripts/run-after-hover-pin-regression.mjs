#!/usr/bin/env node
// Source-snapshot, offscreen Electron 28. No live app, API, PTY or OS input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-run-after-hover-'));
const snapshot = path.join(artifact, 'source');
let app;
const result = { artifact, checks: [], errors: [], pass: false };
const logs = [];
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/run-after-hover-pin.tsx'), path.join(snapshot, 'scripts/fixtures/run-after-hover-pin.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  await build({ sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/run-after-hover-pin.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  function installShim() {
    const listeners = new Map(), saved = new Map();
    const f = window.hoverFixture = { calls: [], unknown: [], violations: [] };
    f.dragEvents = [];
    for (const name of ['dragstart', 'dragend']) document.addEventListener(name, e => f.dragEvents.push({ name, trusted: e.isTrusted }));
    const deny = kind => { f.violations.push(kind); throw Error('Hover fixture forbids ' + kind); };
    const response = (channel, payload) => {
      if (channel === 'app:getState') return saved.get(payload) ?? null;
      if (channel === 'app:setState' || channel === 'app:setStateSync') { saved.set(payload.key, payload.value); return { success: true }; }
      if (channel === 'provider:get-status') return { type: 'codex' };
      if (channel === 'prompts:get') return [];
      if (channel === 'orchestration:get-settings') return { success: true, settings: { showIndicator: false } };
      if (channel === 'agent-session:get-availability-batch') return { success: true,
        results: (payload.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
      if (channel === 'tab:get-context-pct') return { pct: 62 };
      if (channel === 'tab-work-context:get') return { success: true, context: { tabId: payload.tabId, revision: 1, files: [], updates: [], pendingCount: 0 } };
      if (channel === 'terminal:getCommandState') return { isRunning: true, command: 'codex' };
      if (channel === 'terminal:getCommandStates') return Object.fromEntries(['owner', 'source', 'alternative'].map(id => [id, { isRunning: true, command: 'codex' }]));
      if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:(run|append-input)|claude:(append-input|send-command)|agent:(send|stop|rewind)|shell:)/.test(channel)) return deny(channel);
      if (/^(tab:|tab-task-plan:|project:(save|layout|order)|terminal:(resize|subscribe|unsubscribe))/.test(channel)) return { success: true };
      if (/^agent:.*send-receipts/.test(channel)) return { success: true, records: [] };
      if (/list|catalog|get-models|get-prompts|get-task-plan/.test(channel)) return [];
      if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
      if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
      f.unknown.push(channel); return null;
    };
    const ipc = f.ipc = {
      invoke(c, ...a) { f.calls.push(c); return Promise.resolve().then(() => structuredClone(response(c, a[0]))); },
      send(c, ...a) { f.calls.push(c); return response(c, a[0]); }, sendSync(c, ...a) { return response(c, a[0]); },
      on(c, cb) { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb); return ipc; },
      once(c, cb) { const fn = (...a) => { ipc.off(c, fn); cb(...a); }; return ipc.on(c, fn); },
      off(c, cb) { listeners.get(c)?.delete(cb); return ipc; }, removeListener(c, cb) { return ipc.off(c, cb); },
      removeAllListeners(c) { listeners.delete(c); return ipc; }, emit(c, ...a) { for (const fn of listeners.get(c) || []) fn(...a); },
    };
    const fakePath = { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')) || '/',
      join: (...s) => s.join('/').replace(/\/+/g, '/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '',
      isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (from, to) => to.replace(from + '/', '') };
    window.require = name => {
      if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [],
        readImage: () => ({ isEmpty: () => true }), writeText: () => deny('clipboard') },
        shell: { openExternal: () => deny('shell'), openPath: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
      if (name === 'path') return fakePath;
      if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true' } };
      if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
      return deny('require:' + name);
    };
    window.process = window.require('process');
    window.fetch = () => Promise.reject(Error('Fixture network denied'));
    window.WebSocket = class { constructor() { deny('WebSocket'); } };
    window.EventSource = class { constructor() { deny('EventSource'); } };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc;font-family:Arial,sans-serif}*{box-sizing:border-box}</style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
      const w=new BrowserWindow({show:false,focusable:false,width:1200,height:850,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message)); page.on('console', m => logs.push(m.text()));
  await page.screenshot({ path: path.join(artifact, 'initial.png') });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const count = page.locator('[data-local-fixture] .pq-rail-count');
  const local = page.locator('[data-local-fixture] [data-prompt-queue-panel-mode]');
  const globalTrigger = page.locator('[data-global-run-after-trigger]');
  const global = page.locator('[data-global-run-after-panel]');
  const far = async () => { await page.mouse.move(15, 825); await frames(); };
  const state = () => page.evaluate(() => window.hoverFixture.state());
  const assertPreview = async () => { assert.equal(await local.getAttribute('data-prompt-queue-panel-mode'), 'preview'); assert.equal((await state()).panelCollapsed, true); };
  const openLocal = async () => { await far(); await count.hover(); await local.waitFor(); await frames(); await assertPreview(); };
  const reference = id => page.locator('[data-workflow-reference] [data-workflow-chip="' + id + '"]');
  const profile = locator => locator.evaluate(el => { const s = getComputedStyle(el), img = el.querySelector('img'); return {
    height: s.height, padding: s.padding, fontSize: s.fontSize, radius: s.borderRadius, color: s.color,
    background: s.backgroundColor, border: s.borderColor, transition: s.transitionDuration,
    icon: img?.getAttribute('src') ?? null, iconWidth: img ? getComputedStyle(img).width : null,
    fallback: !!el.querySelector('[data-workflow-fallback-icon]') }; });
  await reference('hover-workflow').waitFor();
  const originalSelected = await profile(reference('hover-workflow'));
  const originalLegacy = await profile(reference('legacy-workflow'));
  const originalCleared = await profile(reference('cleared-workflow'));
  await count.waitFor(); await openLocal();
  const appearance = await local.evaluate(el => { const s = getComputedStyle(el); return { animation: s.animationName, transform: s.transform, opacity: s.opacity, border: s.borderColor }; });
  assert.equal(appearance.animation, 'none'); assert.equal(appearance.transform, 'none'); assert.equal(appearance.opacity, '1');
  const countBox = await count.boundingBox(), panelBox = await local.boundingBox();
  await page.mouse.move(countBox.x + countBox.width / 2, (countBox.y + countBox.height + panelBox.y) / 2); await frames();
  assert.equal(await local.count(), 1, 'the geometric seam keeps the menu open');
  await local.getByRole('button', { name: 'Post', exact: true }).click(); await assertPreview();
  await far(); assert.equal(await local.count(), 0); result.checks.push('instant local preview, bridge and internal Post click without pin');

  await openLocal(); await local.locator('[data-prompt-queue-item-list] > div').first().click({ button: 'right' });
  const context = page.locator('[data-prompt-queue-chip-menu]'); await context.waitFor();
  await context.getByText('on tab', { exact: true }).click();
  const picker = page.locator('[data-run-after-picker-menu]'); await picker.waitFor();
  await picker.locator('[data-run-after-tab-row="alternative"]').click();
  // Selecting a target may remove the menu beneath a stationary pointer. Move
  // back into the owner, then out: neither selection nor focus is a pin.
  await openLocal(); assert.equal((await state()).items[0].trigger.tabId, 'alternative');
  await far(); assert.equal(await local.count(), 0); result.checks.push('context menu → on tab → target selection never pins the queue');

  await openLocal(); await local.getByText('Check changes', { exact: true }).click();
  const editor = page.locator('[data-run-after-satellite] input').first(); await editor.waitFor();
  await editor.fill('Edited title'); await assertPreview();
  await far(); assert.equal(await local.count(), 0); assert.equal(await editor.count(), 0);
  assert.equal((await state()).items[0].title, 'Edited title'); result.checks.push('focused item editor does not hold hover parent; title saved on exit');

  const resizeOut = async () => {
    const handle = page.locator('.pq-editor-resize-handle').first(); await handle.waitFor();
    const r = await handle.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down();
    await page.mouse.move(15, 825, { steps: 4 }); await frames();
  };
  await openLocal(); await local.getByText('Edited title', { exact: true }).click();
  await resizeOut(); await assertPreview(); assert.equal(await local.count(), 1);
  await page.mouse.up(); await frames(); assert.equal(await local.count(), 0);
  result.checks.push('local editor resize holds only during the captured gesture; release outside closes preview without pin');

  await count.click(); await local.waitFor();
  assert.equal(await local.getAttribute('data-prompt-queue-panel-mode'), 'pinned');
  assert.notEqual(await local.evaluate(e => getComputedStyle(e).borderColor), appearance.border);
  await far(); assert.equal(await local.count(), 1);
  await local.getByRole('button', { name: 'Loop', exact: true }).click(); await far(); assert.equal(await local.count(), 1);
  await count.click(); await frames(); assert.equal(await local.count(), 0);
  await count.click(); await count.click(); await frames(); assert.equal(await local.count(), 0);
  result.checks.push('only count click adds white pin frame; leave/internal click preserve it; repeat click closes immediately');

  await openLocal();
  await page.locator('[data-local-fixture] .pq-rail-run').hover(); await frames(); assert.equal(await local.count(), 0);
  await page.locator('[data-local-fixture] .pq-rail-run').hover(); assert.equal(await local.count(), 0);
  result.checks.push('neighbouring Play is not part of the orange count hover');

  await globalTrigger.hover(); await global.waitFor();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  await global.getByRole('button', { name: /^Автокомпакт/ }).click();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  const scopeChip = id => global.locator('[data-auto-compact-workflow-chip="' + id + '"]');
  assert.deepEqual(await profile(scopeChip('hover-workflow')), originalSelected);
  assert.deepEqual(await profile(scopeChip('legacy-workflow')), originalLegacy);
  assert.deepEqual(await profile(scopeChip('cleared-workflow')), originalCleared);
  assert.notEqual(originalSelected.icon, originalLegacy.icon);
  assert.equal(originalCleared.fallback, true); assert.equal(originalCleared.icon, null);
  await scopeChip('legacy-workflow').click(); await frames();
  const selectedScope = await page.evaluate(() => window.hoverFixture.scope());
  assert.ok(selectedScope.policy.workflowIds.includes('legacy-workflow')); assert.equal(selectedScope.activeSpaceId, 'hover-workflow');
  const toggled = await profile(scopeChip('legacy-workflow'));
  assert.equal(toggled.background, originalSelected.background); assert.equal(toggled.color, originalSelected.color);
  assert.equal(await scopeChip('legacy-workflow').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: path.join(artifact, 'workflow-scope.png') });
  await scopeChip('legacy-workflow').click();
  await page.evaluate(() => window.hoverFixture.font(17)); await frames();
  assert.equal((await profile(scopeChip('legacy-workflow'))).fontSize, (await profile(reference('legacy-workflow'))).fontSize);
  await page.evaluate(() => window.hoverFixture.icon()); await frames();
  assert.equal((await profile(scopeChip('legacy-workflow'))).icon, (await profile(reference('legacy-workflow'))).icon);
  assert.notEqual((await profile(scopeChip('legacy-workflow'))).icon, originalLegacy.icon);
  await page.evaluate(() => window.hoverFixture.font(14)); await frames();
  await global.getByRole('button', { name: 'Все workflow', exact: true }).click(); await frames();
  assert.equal(await scopeChip('legacy-workflow').isDisabled(), true);
  await global.getByRole('button', { name: 'Все workflow', exact: true }).click();
  result.checks.push('workflow scope mirrors navbar icon/colors/metrics; explicit/legacy/cleared icons and live font/icon changes; selection never navigates');
  await far(); assert.equal(await global.count(), 0);
  result.checks.push('global page clicks remain preview and leave closes without delay');

  await globalTrigger.hover(); await global.waitFor(); await global.getByRole('button', { name: /^Очереди/ }).click();
  const globalCount = page.locator('[data-global-run-after-editor-trigger="owner"]');
  await globalCount.hover();
  const floating = page.locator('[data-global-run-after-floating-editor="owner"]'); await floating.waitFor();
  const embedded = floating.locator('[data-prompt-queue-panel-mode]');
  assert.equal(await floating.getAttribute('data-global-run-after-editor-mode'), 'preview');
  assert.equal(await embedded.getAttribute('data-prompt-queue-panel-mode'), 'preview');
  await embedded.getByRole('button', { name: 'Post', exact: true }).click();
  assert.equal(await floating.getAttribute('data-global-run-after-editor-mode'), 'preview');
  await far(); assert.equal(await floating.count(), 0); assert.equal(await global.count(), 0);
  result.checks.push('floating child has no false white frame or click-inside pin');

  await globalTrigger.hover(); await global.waitFor(); await globalCount.hover(); await floating.waitFor();
  await embedded.getByText('Edited title', { exact: true }).click();
  await resizeOut();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  assert.equal(await floating.getAttribute('data-global-run-after-editor-mode'), 'preview');
  await page.mouse.up(); await frames(); assert.equal(await floating.count(), 0); assert.equal(await global.count(), 0);
  result.checks.push('child editor resize temporarily holds both previews and releases without pinning either');

  await globalTrigger.hover(); await global.waitFor(); await globalCount.hover(); await floating.waitFor();
  const dragCard = embedded.locator('[data-prompt-queue-item-list] > div').first();
  const dragBox = await dragCard.boundingBox();
  await page.mouse.move(dragBox.x + 80, dragBox.y + 12); await page.mouse.down();
  await page.mouse.move(dragBox.x + 90, dragBox.y + 18, { steps: 3 });
  await page.mouse.move(15, 825, { steps: 5 }); await frames();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  assert.equal(await floating.getAttribute('data-global-run-after-editor-mode'), 'preview');
  await page.mouse.up(); await frames(); assert.equal(await floating.count(), 0); assert.equal(await global.count(), 0);
  assert.ok(await page.evaluate(() => window.hoverFixture.dragEvents.some(e => e.name === 'dragstart' && e.trusted)));
  result.checks.push('trusted card drag holds both previews only for the gesture and releases without an implicit pin');

  await globalTrigger.click(); await global.waitFor(); assert.equal(await global.getAttribute('data-global-run-after-mode'), 'pinned');
  await globalCount.click(); await floating.waitFor(); assert.equal(await floating.getAttribute('data-global-run-after-editor-mode'), 'pinned');
  await far(); assert.equal(await floating.count(), 1); assert.equal(await global.count(), 1);
  await page.screenshot({ path: path.join(artifact, 'explicit-pins.png') });
  await globalCount.click(); assert.equal(await floating.count(), 0);
  await far(); assert.equal(await global.count(), 1);
  await globalTrigger.click(); await frames(); assert.equal(await global.count(), 0);
  result.checks.push('global header pin and child count pin are independent, repeat triggers close');

  const bellMenu = page.locator('[data-open-bell-menu]');
  for (const action of ['notify-once', 'notify-persistent']) {
    await bellMenu.click({ button: 'right' });
    const bell = page.locator('[data-tab-context-action="' + action + '"]'); await bell.waitFor();
    await page.mouse.move(15, 825); await frames();
    const base = await bell.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage }));
    await bell.hover(); await frames();
    const hovered = await bell.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage,
      transition: getComputedStyle(el).transitionDuration }));
    assert.equal(base.image, 'none'); assert.equal(hovered.bg, base.bg); assert.notEqual(hovered.image, 'none'); assert.equal(hovered.transition, '0s');
    await page.mouse.move(15, 825); await frames(); assert.equal(await bell.evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    await bell.click(); assert.equal(await bell.count(), 0);
    await bellMenu.click({ button: 'right' }); await bell.waitFor(); assert.equal(await bell.getAttribute('aria-pressed'), 'true');
    await bell.hover(); await frames();
    assert.notEqual(await bell.evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    await page.screenshot({ path: path.join(artifact, action + '-hover.png') });
    await bell.click();
  }
  result.checks.push('both context-menu bells highlight whole hit target immediately; pressed tint and click toggles survive hover');
  const safety = await page.evaluate(() => ({ violations: window.hoverFixture.violations, unknown: [...new Set(window.hoverFixture.unknown)] }));
  result.safety = safety;
  assert.deepEqual(safety.violations, []); assert.deepEqual(safety.unknown, []); assert.deepEqual(result.errors, []);
  result.pass = true;
} catch (error) {
  result.errors.push(error.stack || String(error));
  try { await app?.windows()[0]?.screenshot({ path: path.join(artifact, 'failure.png') }); } catch {}
} finally {
  if (app) { try { await app.close(); } catch {} }
  await fs.writeFile(path.join(artifact, 'console.log'), logs.join('\n'));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}
