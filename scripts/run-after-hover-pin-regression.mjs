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
      if (channel === 'semantic-index:get-status') return { success: true, status: { fresh: 1, stale: 0, new: 0, removed: 0, indexExists: true, docsTotal: 1, indexedTotal: 1 } };
      if (channel === 'agent-transcript:get-timeline' && payload.sessionId === 'legacy-label-session') return { success: true,
        entries: [{ uuid: 'compact', type: 'compact' }, ...Array.from({ length: 21 }, (_, i) => ({ uuid: 'legacy-' + (i + 1), type: 'user' }))] };
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
      if (name === 'node:v8') return { deserialize: value => value };
      if (name === 'node:buffer') return { Buffer: { from: value => value } };
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
  await globalTrigger.waitFor();
  assert.equal((await globalTrigger.innerText()).trim(), '1');
  assert.equal(await globalTrigger.locator('svg.lucide-git-branch').count(), 1);
  assert.equal(await globalTrigger.getAttribute('aria-label'), 'Run After · 1');
  assert.match(await globalTrigger.getAttribute('title'), /Очереди всех вкладок/);
  await globalTrigger.screenshot({ path: path.join(artifact, 'global-trigger-icon-count.png') });
  result.checks.push('global trigger shows only SVG icon and queue count; accessible name and tooltip retain its purpose');
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
  const localChoice = await picker.locator('[data-run-after-tab-row="alternative"]').boundingBox();
  const localParent = await local.boundingBox();
  const choicePoint = { x: localChoice.x + localChoice.width / 2, y: localChoice.y + localChoice.height / 2 };
  assert.ok(choicePoint.x < localParent.x || choicePoint.x > localParent.x + localParent.width
    || choicePoint.y < localParent.y || choicePoint.y > localParent.y + localParent.height,
    'local OnTab selection really happens outside its parent');
  await picker.locator('[data-run-after-tab-row="alternative"]').click();
  // The clicked portal vanished outside the owner. Preserve a return trip,
  // not a permanent pin, even when the pointer takes a detour across the UI.
  await far(); assert.equal(await local.count(), 1, 'selection must keep a return trip to the owner');
  await assertPreview();
  assert.equal(await picker.count(), 0, 'local return trip is not held by a still-open picker');
  await page.screenshot({ path: path.join(artifact, 'local-on-tab-return.png') });
  await local.getByRole('button', { name: 'Post', exact: true }).hover(); await frames();
  assert.equal((await state()).items[0].trigger.tabId, 'alternative');
  await far(); assert.equal(await local.count(), 0); result.checks.push('context menu → on tab → target selection never pins the queue');

  for (const target of ['source', 'alternative']) {
    await openLocal(); await local.locator('[data-prompt-queue-item-list] > div').first().click({ button: 'right' });
    await context.waitFor(); await context.getByText('on tab', { exact: true }).click(); await picker.waitFor();
    await picker.locator('[data-run-after-tab-row="' + target + '"]').click();
    await far(); await assertPreview();
    await local.getByRole('button', { name: 'Post', exact: true }).hover(); await frames();
    await far(); assert.equal(await local.count(), 0);
  }
  result.checks.push('ordinary Run After repeats external OnTab selection/return/leave without a stale hold or pin');

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
  const embedded = global.locator('[data-global-run-after-inline-editor="owner"]');
  await embedded.waitFor();
  assert.equal(await page.locator('[data-global-run-after-editor-trigger]').count(), 0);
  assert.equal(await page.locator('[data-global-run-after-floating-editor]').count(), 0);
  assert.equal(await embedded.locator('[data-prompt-queue-item]').count(), 1);
  await embedded.getByRole('button', { name: 'Post', exact: true }).click();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  await far(); assert.equal(await global.count(), 0);
  result.checks.push('global queues are inline immediately; no disclosure or floating queue, internal clicks never pin');

  await globalTrigger.hover(); await global.waitFor();
  await embedded.getByText('Edited title', { exact: true }).click();
  await resizeOut();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  await page.mouse.up(); await frames(); assert.equal(await global.count(), 0);
  result.checks.push('inline item editor resize holds only its captured gesture and releases without pinning');

  await globalTrigger.hover(); await global.waitFor();
  const dragCard = embedded.locator('[data-prompt-queue-item]').first();
  const dragBox = await dragCard.boundingBox();
  await page.mouse.move(dragBox.x + 80, dragBox.y + 12); await page.mouse.down();
  await page.mouse.move(dragBox.x + 90, dragBox.y + 18, { steps: 3 });
  await page.mouse.move(15, 825, { steps: 5 }); await frames();
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  await page.mouse.up(); await frames(); assert.equal(await global.count(), 0);
  assert.ok(await page.evaluate(() => window.hoverFixture.dragEvents.some(e => e.name === 'dragstart' && e.trusted)));
  result.checks.push('trusted inline card drag holds preview only for its gesture');

  await globalTrigger.click(); await global.waitFor();
  await far(); assert.equal(await global.getAttribute('data-global-run-after-mode'), 'pinned');
  assert.equal(await embedded.count(), 1);
  assert.equal(await global.locator('[data-global-run-after-step-count]').count(), 0);
  assert.equal(await global.getByText('после завершения', { exact: true }).count(), 0);
  const targetNode = global.locator('[data-global-run-after-node="alternative"]');
  assert.equal(await targetNode.locator('[data-prompt-queue-edge-controls]').count(), 1);
  assert.equal(await targetNode.getByRole('button', { name: 'Запустить Run After', exact: true }).count(), 1);
  const headingMetrics = () => global.locator('[data-global-run-after-node]').evaluateAll(nodes => nodes.map(node => {
    const chip = node.querySelector('[data-global-run-after-tab-chip]').getBoundingClientRect();
    const frame = node.querySelector('[data-prompt-queue-panel-mode]').getBoundingClientRect();
    const controls = node.querySelector('[data-prompt-queue-edge-controls]').getBoundingClientRect();
    return { id: node.dataset.globalRunAfterNode, width: chip.width, frameWidth: frame.width,
      left: frame.left - chip.left, overlap: chip.bottom - controls.top,
      taskMarkers: node.querySelectorAll('[data-task-plan-tab-markers]').length };
  }));
  for (const metric of await headingMetrics()) {
    assert.ok(Math.abs(metric.left) < 1, JSON.stringify(metric));
    assert.ok(Math.abs(metric.overlap - 2) < 1, JSON.stringify(metric));
    assert.equal(metric.taskMarkers, 0);
    assert.ok(metric.width < 300);
  }
  await page.screenshot({ path: path.join(artifact, 'inline-queue.png') });
  const edge = global.locator('[data-run-after-edge-item="synthetic-card"]');
  await edge.waitFor();
  assert.equal(await edge.getAttribute('data-run-after-edge-owner'), 'owner');
  assert.equal(await edge.getAttribute('data-run-after-edge-target'), 'alternative');
  assert.match(await edge.getAttribute('d'), /^M .* H .* Q .* V .* Q .* H /);
  const actualDimensions = await embedded.evaluate(el => ({
    header: getComputedStyle(el.querySelector('[data-prompt-queue-item] > span')).fontSize,
    post: getComputedStyle(el.querySelector('.pq-edge-action')).fontSize,
    condition: getComputedStyle(el.querySelector('[data-prompt-context-condition-row]')).fontSize,
    height: el.getBoundingClientRect().height,
  }));
  assert.equal(actualDimensions.header, '12px');
  assert.equal(actualDimensions.post, '7px');
  assert.equal(actualDimensions.condition, '12px');
  result.checks.push('arrow goes owner → exact item target, bends left/down/right; title and toolbar compact, condition unchanged');
  await page.evaluate(() => window.hoverFixture.addDisabled()); await frames();
  const lateShelf = global.locator('[data-global-run-after-disabled-shelf]'); await lateShelf.waitFor();
  const shelfPosition = await lateShelf.boundingBox(), beforeShelfNode = await targetNode.boundingBox();
  assert.ok(shelfPosition.y >= beforeShelfNode.y + beforeShelfNode.height, 'a newly added disabled shelf must not cover the nodes');

  await embedded.locator('[data-prompt-queue-item="synthetic-card"]').click({ button: 'right' });
  await context.waitFor(); await context.getByText('on tab', { exact: true }).click();
  await picker.waitFor(); await picker.locator('[data-run-after-tab-row="source"]').click(); await frames();
  assert.equal((await state()).items[0].trigger.tabId, 'source');
  assert.equal(await edge.getAttribute('data-run-after-edge-target'), 'source');
  const sourceNode = global.locator('[data-global-run-after-node="source"]');
  await sourceNode.locator('[data-global-run-after-tab-chip]').click();
  assert.equal(await page.evaluate(() => window.hoverFixture.navigation.at(-1)[1]), 'source');
  await sourceNode.locator('[data-global-run-after-tab-chip]').click({ button: 'middle' });
  assert.equal(await page.evaluate(() => window.hoverFixture.navigation.at(-1)[2]?.mode), 'add-here');
  assert.equal((await state()).items[0].trigger.tabId, 'source', 'navigation must not remove the condition');
  await embedded.getByText('Edited title', { exact: true }).click();
  const globalTitle = page.locator('[data-run-after-satellite] input').first();
  await globalTitle.fill('Inline edited'); await global.getByRole('button', { name: /^Автокомпакт/ }).click(); await frames();
  assert.equal((await state()).items[0].title, 'Inline edited');
  await global.getByRole('button', { name: /^Очереди/ }).click(); await embedded.waitFor();
  assert.equal(await embedded.getByText('Inline edited', { exact: true }).count(), 1);
  result.checks.push('full dependency node owns its toolbar and Play; no counter/after text/pencil; chip navigation and step-context target editing remain distinct');
  await globalTrigger.click(); await frames(); assert.equal(await global.count(), 0);
  await openLocal(); assert.equal(await local.getByText('Inline edited', { exact: true }).count(), 1); await far();
  result.checks.push('inline and local editor share one queue while local disclosure state is untouched');

  await page.evaluate(() => window.hoverFixture.graph());
  await globalTrigger.click(); await global.waitFor(); await frames();
  const graph = global.locator('[data-global-run-after-graph]');
  assert.equal(await graph.locator('[data-global-run-after-inline-editor]').count(), 8);
  assert.equal(await graph.locator('[data-run-after-edge-owner="owner"]').count(), 3);
  assert.equal(await graph.locator('[data-run-after-edge-target="source"]').count(), 3);
  const geometry = () => graph.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const cards = [...el.querySelectorAll('[data-global-run-after-node]')].map(card => {
      const r = card.getBoundingClientRect(); return { id: card.dataset.globalRunAfterNode, x: r.x, y: r.y, right: r.right, bottom: r.bottom,
        width: r.width, depth: Number(card.dataset.globalRunAfterDepth), lane: card.dataset.globalRunAfterLane };
    });
    return { width: rect.width, scrollWidth: el.scrollWidth, columns: new Set(cards.map(r => r.lane)).size, cards };
  });
  let layout = await geometry();
  assert.ok(layout.columns >= 2);
  assert.ok(layout.scrollWidth <= layout.width + 1);
  assert.ok(layout.cards.every(card => card.depth <= 1));
  const compact = graph.locator('[data-prompt-queue-item="single-first"]');
  const compactText = await compact.locator('span').first().evaluate(el => ({ text: el.textContent, width: el.clientWidth, scroll: el.scrollWidth,
    rowWidth: el.parentElement.getBoundingClientRect().width, rowCss: el.parentElement.style.cssText,
    parent: getComputedStyle(el.parentElement.parentElement).gridTemplateColumns,
    children: [...el.parentElement.children].map(child => ({ tag: child.tagName, width: child.getBoundingClientRect().width, style: child.style.cssText })) }));
  assert.equal(compactText.text, '/compact'); assert.ok(compactText.scroll <= compactText.width + 1, JSON.stringify(compactText));
  const clippedShortTitles = await graph.locator('[data-prompt-queue-item] > span').evaluateAll(elements => elements
    .filter(el => (el.textContent || '').length < 24 && el.scrollWidth > el.clientWidth + 1)
    .map(el => ({ text: el.textContent, width: el.clientWidth, scroll: el.scrollWidth })));
  assert.deepEqual(clippedShortTitles, []);
  const widthsBeforeResize = await headingMetrics();
  const pathCollisions = await graph.evaluate(el => {
    const icons = [...el.querySelectorAll('[data-global-run-after-project-icon]')].map(icon => icon.getBoundingClientRect());
    const failures = [];
    for (const path of el.querySelectorAll('[data-run-after-edge-item]')) {
      const matrix = path.getScreenCTM(), length = path.getTotalLength();
      for (let i = 0; i <= 30; i++) {
        const point = path.getPointAtLength(length * i / 30).matrixTransform(matrix);
        if (icons.some(rect => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom)) failures.push(path.dataset.runAfterEdgeItem);
      }
    }
    return failures;
  });
  assert.deepEqual(pathCollisions, [], 'connectors must not cross project icons');
  for (let i = 0; i < layout.cards.length; i++) for (let j = i + 1; j < layout.cards.length; j++) {
    const a = layout.cards[i], b = layout.cards[j];
    assert.ok(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, a.id + ' overlaps ' + b.id);
  }
  await page.screenshot({ path: path.join(artifact, 'branching-overview.png') });
  const resizeRight = global.locator('[data-global-run-after-resize="right"]');
  assert.equal(await resizeRight.count(), 0, 'view mode has no resize hit target');
  await global.locator('[data-global-run-after-resize-toggle]').click(); await frames();
  const wideStart = await resizeRight.boundingBox();
  await page.mouse.move(wideStart.x + wideStart.width / 2, wideStart.y + 20); await page.mouse.down();
  await page.mouse.move(wideStart.x + 280, wideStart.y + 20, { steps: 8 }); await page.mouse.up(); await frames();
  const wideMetrics = await headingMetrics();
  for (const before of widthsBeforeResize) {
    const after = wideMetrics.find(row => row.id === before.id);
    assert.ok(Math.abs(before.width - after.width) < 0.2, 'chip stretched: ' + before.id);
    assert.ok(Math.abs(before.frameWidth - after.frameWidth) < 0.2, 'queue stretched: ' + before.id);
    assert.ok(Math.abs(after.overlap - 2) < 1); assert.ok(Math.abs(after.left) < 1);
  }
  await page.screenshot({ path: path.join(artifact, 'wide-overview.png') });
  const rr = await resizeRight.boundingBox();
  await page.mouse.move(rr.x + rr.width / 2, rr.y + 20); await page.mouse.down();
  await page.mouse.move(rr.x - 510, rr.y + 20, { steps: 8 }); await page.mouse.up(); await frames();
  layout = await geometry(); assert.ok(layout.scrollWidth <= layout.width + 1);
  await page.screenshot({ path: path.join(artifact, 'narrow-overview.png') });
  const paused = global.locator('[data-global-run-after-node="owner"]');
  await paused.getByRole('button', { name: 'Приостановить Run After', exact: true }).click(); await frames();
  assert.equal(await paused.isVisible(), true);
  assert.equal(await paused.getByRole('button', { name: 'Запустить Run After', exact: true }).count(), 1);
  result.checks.push('branching, shared prerequisite, repeated edges and deep chain pack without overlap or horizontal growth; pause retains the inspected card');
  result.checks.push('content widths remain identical on resize; toolbar overlaps by 2px, frame aligns to chip not icon, no task markers or crossed icons');
  const thirdTrigger = paused.locator('[data-prompt-trigger-row="owner-third"]');
  await thirdTrigger.click({ button: 'middle' }); await frames();
  assert.equal((await state()).items.find(item => item.id === 'owner-third').trigger, undefined);
  assert.equal((await state()).items.length, 3);
  await paused.locator('[data-prompt-queue-item="owner-third"]').click({ button: 'middle' });
  await page.waitForFunction(() => window.hoverFixture.state().items.length === 2);
  result.checks.push('middle click on the condition label removes only that condition; middle click on the step removes only that step');
  const shelf = global.getByRole('button', { name: /Выключенные/ });
  await shelf.scrollIntoViewIfNeeded(); await shelf.click(); await frames();
  assert.equal(await graph.locator('[data-global-run-after-inline-editor="disabled"]').count(), 1);
  await shelf.click(); assert.equal(await graph.locator('[data-global-run-after-inline-editor="disabled"]').count(), 0);
  await globalTrigger.click(); await frames(); assert.equal(await global.count(), 0);
  result.checks.push('disabled shelf shows the same inline editor; one shared scroll area and right resize remain usable');

  await page.evaluate(() => window.hoverFixture.legacy());
  await globalTrigger.click(); await global.waitFor(); await frames();
  const legacyClear = global.locator('[data-global-run-after-node="owner"] [data-chip-action="remove-trigger"]');
  await legacyClear.click(); await frames();
  assert.equal((await state()).runAfterTabId, null);
  assert.equal(await global.locator('[data-run-after-edge-item="queue-target"]').count(), 0);
  await globalTrigger.click(); await frames();
  result.checks.push('legacy Loop-only dependency remains visible as a full node and can still be cleared without a pencil');

  await far(); await page.evaluate(() => window.hoverFixture.minor());
  await globalTrigger.hover(); await global.waitFor(); await frames();
  const sourceEditor = global.locator('[data-global-run-after-inline-editor="source"]');
  const positions = () => global.locator('[data-global-run-after-node]').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect(); return { id: n.dataset.globalRunAfterNode, x: r.x, y: r.y };
  }));
  const beforeDependency = await positions();
  await sourceEditor.locator('[data-prompt-queue-item]').first().click({ button: 'right' });
  await context.waitFor(); await context.getByText('on tab', { exact: true }).click(); await picker.waitFor();
  await picker.locator('[data-run-after-tab-row="owner"]').click(); await frames();
  assert.deepEqual(await positions(), beforeDependency, 'adding second → first never swaps or reparents existing nodes');
  await sourceEditor.getByRole('button', { name: 'Post', exact: true }).hover(); await far();
  await globalTrigger.hover(); await global.waitFor(); await frames();
  assert.deepEqual(await positions(), beforeDependency, 'reopening must not apply the deferred topology swap either');
  await embedded.locator('[data-prompt-queue-item]').first().click({ button: 'right' });
  await context.waitFor(); await context.getByText('on tab', { exact: true }).click(); await picker.waitFor();
  const choice = await picker.locator('[data-run-after-tab-row="alternative"]').boundingBox();
  const parentBounds = await global.boundingBox();
  assert.ok(choice.x + 5 < parentBounds.x, 'selection point is really outside the parent');
  await page.mouse.click(choice.x + 5, choice.y + choice.height / 2); await frames();
  await far(); assert.equal(await global.count(), 1, 'global picker selection retains return trip');
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'preview');
  await page.screenshot({ path: path.join(artifact, 'selection-return-stable-order.png') });
  await sourceEditor.getByRole('button', { name: 'Post', exact: true }).hover(); await frames();
  await far(); assert.equal(await global.count(), 0, 'after returning, the next leave closes immediately');
  result.checks.push('external picker selection retains a one-shot return trip without pin; adding a reverse edge preserves existing positions');

  await globalTrigger.hover(); await global.waitFor();
  await sourceEditor.locator('[data-prompt-queue-item]').first().click({ button: 'right' });
  await context.waitFor(); await context.getByText('on tab', { exact: true }).click(); await picker.waitFor();
  await picker.locator('[data-run-after-tab-row="owner"]').hover(); await frames();
  await page.keyboard.press('Escape'); await frames(); await far();
  assert.equal(await global.count(), 0, 'Escape without a selection must not create a return trip');
  result.checks.push('dismissed picker without a committed selection keeps ordinary instant hover dismissal');

  await page.evaluate(() => window.hoverFixture.rewindElsewhere());
  const beforeRewind = await page.evaluate(() => window.hoverFixture.placement());
  await globalTrigger.click(); await global.waitFor();
  await embedded.getByRole('button', { name: 'Добавить prompt вручную', exact: true }).click({ button: 'right' });
  const actions = page.locator('[data-prompt-queue-meta-actions]'); await actions.waitFor();
  await actions.getByText('Rewind', { exact: true }).click(); await frames();
  const afterRewind = await page.evaluate(() => window.hoverFixture.placement());
  assert.equal(afterRewind.activeSpaceId, 'rewind-workflow');
  assert.equal(afterRewind.panes[0].windowId, 'rewind-other-window');
  assert.equal(afterRewind.panes[0].tabId, 'owner');
  assert.deepEqual(afterRewind.spaces.find(s => s.id === 'hover-workflow').panes, beforeRewind.panes,
    'Rewind navigation must not replace the current workflow tab');
  assert.equal(afterRewind.pending.tabId, 'owner', 'selection request survives until the target Timeline mounts');
  await page.evaluate(() => window.hoverFixture.cancelRewind()); await frames();
  assert.equal((await page.evaluate(() => window.hoverFixture.placement())).pending, null);
  assert.equal(await global.getAttribute('data-global-run-after-mode'), 'pinned');
  await globalTrigger.click(); await frames();
  result.checks.push('Rewind uses the existing remote workflow/window; current placement is untouched and pending target selection cancels safely');

  await page.evaluate(() => window.hoverFixture.stepDesign()); await globalTrigger.click(); await global.waitFor(); await frames();
  const actionEdge = global.locator('[data-run-after-edge-item="design-model"]');
  const assertStepOrigin = async () => {
    const proof = await actionEdge.evaluate(path => {
      const graph = path.closest('[data-global-run-after-graph]');
      const step = graph.querySelector('[data-prompt-queue-item="design-model"]').getBoundingClientRect();
      const p = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
      return { dx: p.x - (step.left - 3), dy: p.y - (step.top + step.height / 2) };
    }); assert.ok(Math.abs(proof.dx) < 1 && Math.abs(proof.dy) < 1, JSON.stringify(proof));
  };
  await assertStepOrigin();
  const visual = await global.locator('[data-global-run-after-node="source"]').evaluate(node => {
    const chip = node.querySelector('[data-global-run-after-tab-chip]'), label = chip.querySelector('[data-tab-card-label]');
    const marker = chip.querySelector('[data-global-run-after-awaited]');
    const controls = node.querySelector('[data-prompt-queue-edge-controls]'), run = controls.querySelector('[data-global-run-after-run-control]');
    return { markerInside: chip.contains(marker), markerX: marker.getBoundingClientRect().left, labelEnd: label.getBoundingClientRect().right,
      beforeMap: !!marker.nextElementSibling, headerRuns: node.querySelector('[data-global-run-after-heading]').querySelectorAll('[data-global-run-after-run-control]').length,
      run: { width: run.getBoundingClientRect().width, height: run.getBoundingClientRect().height, disabled: run.disabled } };
  });
  assert.equal(visual.markerInside, true); assert.ok(visual.markerX >= visual.labelEnd); assert.equal(visual.beforeMap, true);
  assert.equal(visual.headerRuns, 0); assert.deepEqual(visual.run, { width: 20, height: 20, disabled: true });
  const conditionEdge = global.locator('[data-prompt-trigger-row="design-model"]');
  assert.equal(await conditionEdge.evaluate(el => getComputedStyle(el).borderLeftStyle), 'none');
  const runControl = embedded.locator('[data-global-run-after-run-control="owner"]');
  await runControl.click(); assert.equal((await state()).autoRun, false);
  await runControl.click(); assert.equal((await state()).autoRun, true);
  await page.screenshot({ path: path.join(artifact, 'variant-a-implemented.png') });
  {
    const chip = global.locator('[data-global-run-after-node="owner"] [data-global-run-after-tab-chip]');
    const geometry = () => chip.evaluate(el => ({ card: el.getBoundingClientRect().toJSON(),
      label: el.querySelector('[data-tab-card-label]').getBoundingClientRect().toJSON() }));
    const before = await geometry();
    await page.evaluate(() => window.hoverFixture.notification(true)); await frames();
    assert.deepEqual(await geometry(), before, 'bell does not resize or shift the actual global Run After node');
    const proof = await chip.evaluate(el => {
      const bell = el.querySelector('[data-tab-completion-notification-badge]'), b = bell.getBoundingClientRect();
      const bar = el.querySelector('[data-tab-process-bar]')?.getBoundingClientRect();
      const rightEdge = el.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(el).borderRightWidth);
      const railCenter = bar ? bar.x + bar.width / 2 : rightEdge - 3 / 2;
      const matrix = bell.querySelector('svg').getScreenCTM();
      return { offset: b.x + b.width / 2 - railCenter, top: getComputedStyle(bell).top, scaleX: matrix.a, scaleY: matrix.d };
    });
    assert.ok(Math.abs(proof.offset) < 0.01); assert.equal(proof.top, '-2px');
    assert.ok(Math.abs(proof.scaleX - 11 / 24) < 0.00001 && Math.abs(proof.scaleY - 11 / 24) < 0.00001);
    const r = await chip.boundingBox();
    await page.screenshot({ path: path.join(artifact, 'global-bell-corner.png'),
      clip: { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 } });
    await page.evaluate(() => window.hoverFixture.notification(false)); await frames();
    assert.deepEqual(await geometry(), before);
    result.checks.push('global Run After bell sits above the right process rail at unchanged height, full SVG size and zero card/label movement');
  }
  const initialPath = await actionEdge.getAttribute('d');
  await page.evaluate(() => window.hoverFixture.reorderDesign()); await frames(); await assertStepOrigin();
  assert.notEqual(await actionEdge.getAttribute('d'), initialPath, 'moving a step updates its edge even when node size stays the same');
  const removeDependency = conditionEdge.locator('[data-chip-action="remove-trigger"]'); await removeDependency.click(); await frames();
  assert.equal(await actionEdge.count(), 0); assert.equal(await global.locator('[data-global-run-after-awaited="source"]').count(), 0);
  await globalTrigger.click(); await frames();
  result.checks.push('variant A: exact model-step origin follows reorder, hourglass inside unique target, 20px toolbar Play/Pause, no empty condition corner');

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
  await page.evaluate(() => window.hoverFixture.layoutAndRewind()); await frames();
  const toolbar = page.locator('[data-sidebar-tools-row]');
  for (const [width, presentation] of [[400, 'workspace'], [140, 'workspace'], [400, 'dashboard']]) {
    await page.evaluate(([width, presentation]) => window.hoverFixture.header(width, presentation), [width, presentation]); await frames();
    const row = await toolbar.boundingBox(), chip = await globalTrigger.boundingBox();
    assert.ok(Math.abs(row.x + row.width - chip.x - chip.width - 4) < 0.2, 'Run After stays 4px from the actual toolbar right edge');
    await toolbar.screenshot({ path: path.join(artifact, 'toolbar-' + width + '-' + presentation + '.png') });
    const scroll = toolbar.locator('[data-sidebar-tools-scroll]');
    if (width === 140) {
      const before = await globalTrigger.boundingBox(); await scroll.hover(); await page.mouse.wheel(0, 200); await frames();
      assert.deepEqual(await globalTrigger.boundingBox(), before, 'toolbar scroll cannot move the fixed Run After chip');
    }
  }
  await page.evaluate(() => window.hoverFixture.header(400)); await frames();
  await globalTrigger.click(); await global.waitFor(); await frames();
  assert.equal(await global.getAttribute('data-global-run-after-sizing'), 'content');
  assert.equal(await global.locator('[data-global-run-after-resize]').count(), 0);
  await global.getByText('Rewind: 17', { exact: true }).waitFor();
  await global.getByText('Rewind: 21', { exact: true }).waitFor(); await frames();
  assert.ok(!(await global.innerText()).includes('saved_prompt'));
  const labelItems = (await state()).items;
  assert.equal(labelItems[1].metaAction.targetText, 'Original <saved_prompt> payload');
  assert.equal(labelItems[1].metaAction.targetIteration, undefined, 'legacy label resolution never rewrites the queued command');
  const fit = await global.boundingBox();
  assert.ok(fit.width < 500 && fit.height < 300, 'legacy 1100×740 fixed canvas must trim to its two short steps');
  const tightBounds = await global.evaluate(el => {
    const r = el.getBoundingClientRect();
    const nodes = [...el.querySelectorAll('[data-global-run-after-node]')].map(n => n.getBoundingClientRect());
    return { right: r.right - Math.max(...nodes.map(n => n.right)), bottom: r.bottom - Math.max(...nodes.map(n => n.bottom)) };
  });
  assert.ok(tightBounds.right < 50 && tightBounds.bottom < 24, JSON.stringify(tightBounds));
  const panelScreenshot = async name => {
    const r = await global.boundingBox();
    await page.screenshot({ path: path.join(artifact, name), clip: { x: Math.max(0, r.x - 5), y: Math.max(0, r.y - 18),
      width: r.width + 10, height: r.height + 23 } });
  };
  await panelScreenshot('content-fit-rewind.png');
  const sizeToggle = global.locator('[data-global-run-after-resize-toggle]');
  await sizeToggle.click(); await frames(); assert.equal(await global.locator('[data-global-run-after-resize]').count(), 3);
  const reserved = await global.boundingBox(); assert.ok(reserved.width > fit.width && reserved.height > fit.height);
  const dragHandle = async (edge, dx, dy) => {
    const r = await global.locator('[data-global-run-after-resize="' + edge + '"]').boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 4 }); await page.mouse.up(); await frames();
  };
  await dragHandle('bottom', 0, -160);
  const shorter = await global.boundingBox(); assert.ok(shorter.height < reserved.height - 100); assert.equal(shorter.width, reserved.width);
  await dragHandle('right', -230, 0);
  const narrower = await global.boundingBox(); assert.ok(narrower.width < shorter.width - 150); assert.equal(narrower.height, shorter.height);
  await dragHandle('corner', -35, -35);
  const corner = await global.boundingBox(); assert.ok(corner.width < narrower.width && corner.height < narrower.height);
  await panelScreenshot('resize-guides.png');
  await dragHandle('right', -700, 0);
  const minimum = await global.evaluate(el => {
    const frame = el.getBoundingClientRect();
    return [...el.querySelectorAll('[data-global-run-after-pages], [data-prompt-queue-edge-controls]')]
      .map(control => ({ right: control.getBoundingClientRect().right - frame.right, left: control.getBoundingClientRect().left - frame.left }));
  });
  assert.ok(minimum.every(control => control.right <= 1 && control.left >= 0), JSON.stringify(minimum));
  await dragHandle('right', 200, 0);
  await sizeToggle.click(); await frames(); assert.equal(await global.locator('[data-global-run-after-resize]').count(), 0);
  const trimmed = await global.boundingBox(); assert.ok(trimmed.width < corner.width && trimmed.height < corner.height);
  await globalTrigger.click(); await globalTrigger.click(); await global.waitFor(); await frames();
  assert.equal(await global.getAttribute('data-global-run-after-sizing'), 'content');
  const reopened = await global.boundingBox(); assert.equal(reopened.width, trimmed.width); assert.equal(reopened.height, trimmed.height);
  await global.getByRole('button', { name: /^Автокомпакт/ }).click(); await frames();
  const compactBounds = await global.boundingBox(); assert.ok(compactBounds.height < 350);
  assert.equal(await global.locator('[data-global-run-after-resize]').count(), 0);
  await globalTrigger.click();
  result.checks.push('right-anchored toolbar chip, legacy fixed canvas auto-fit, explicit three-edge resize mode, fit after resize/reopen, compact page and ordinal-only Rewind labels');
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
