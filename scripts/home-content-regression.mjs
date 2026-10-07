#!/usr/bin/env node
// Frozen actual Home components in owned offscreen Electron. No product Main,
// user storage, process controls, native focus, clipboard or real file removal.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
// Darwin aliases /var to /private/var. Canonicalize before module aliases so
// fixture stores cannot accidentally bundle twice under two absolute paths.
const artifact = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-home-content-')));
const snapshot = path.join(artifact, 'source');
const result = { artifact, status: 'running', checks: [], widths: [], errors: [], sources: {}, cleanup: false };
let app, child;
try {
  await fs.cp(path.join(repo, 'src'), path.join(snapshot, 'src'), { recursive: true });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  for (const file of ['home-content.tsx', 'home-content-stores.ts']) {
    await fs.copyFile(path.join(repo, 'scripts/fixtures', file), path.join(snapshot, 'scripts/fixtures', file));
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const stores = path.join(snapshot, 'scripts/fixtures/home-content-stores.ts');
  const bundle = await build({
    entryPoints: [path.join(snapshot, 'scripts/fixtures/home-content.tsx')],
    bundle: true, metafile: true, sourcemap: true, outfile: path.join(artifact, 'bundle.js'),
    platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'private-stores', setup(builder) {
      builder.onResolve({ filter: /\/store\/use(?:Workspace|UI|ControlHelp)Store$/ }, () => ({ path: stores }));
    } }],
  });
  await fs.writeFile(path.join(artifact, 'bundle-inputs.json'), JSON.stringify(bundle.metafile, null, 2));
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const full = path.resolve(input);
    if (full.startsWith(snapshot)) result.sources[path.relative(snapshot, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
  }
  const cssInput = path.join(snapshot, 'src/renderer/styles/globals.css');
  result.sources['src/renderer/styles/globals.css'] = createHash('sha256').update(await fs.readFile(cssInput)).digest('hex');
  result.sources['scripts/home-content-regression.mjs'] = createHash('sha256').update(await fs.readFile(path.join(repo, 'scripts/home-content-regression.mjs'))).digest('hex');
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', cssInput, '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });

  function installAdapters() {
    const f = window.homeFixture = { calls: [], violations: [], creates: [], toasts: [], clipboard: '', prepares: [], deletes: [], listeners: new Map() };
    const item = (id, sizeBytes, protectedItem = false) => ({
      id, deletionRevision: 'revision-' + id, section: 'sessions', group: protectedItem ? 'open' : 'regular',
      provider: id === 'second' ? 'claude' : 'codex', sessionId: 'session-' + id,
      title: id === 'first' ? 'A long session name that must truncate within the row' : id + ' session',
      project: 'Legacy directory label', cwd: '/synthetic/workspace', path: '/synthetic/session/' + id + '.jsonl',
      sizeBytes, modifiedAt: 1770000000000, createdAt: 1760000000000, iterations: null,
      notedTerminal: true, protected: protectedItem, protectedReason: protectedItem ? 'Open tab keeps history protected' : null,
      deletable: !protectedItem, eligible: !protectedItem, deleteAfter: 1700000000000,
    });
    f.items = [item('first', 8000000), item('second', 4000000), item('protected', 2000000, true),
      { ...item('build', 1000000), section: 'builds', group: 'build', provider: null, sessionId: null },
      { ...item('database', 500000, true), section: 'app', group: 'app-active', provider: null, sessionId: null }];
    f.settings = { enabled: false, provider: 'all', retentionDays: { regular: 7, build: null } };
    f.inventory = () => ({ success: true, generation: 'fixture-generation', scannedAt: Date.now(), settings: f.settings,
      summary: { totalBytes: f.items.reduce((sum, x) => sum + x.sizeBytes, 0), reclaimableBytes: 13000000,
        eligibleBytes: 12000000, protectedBytes: 2500000, totalItems: f.items.length, sessionItems: 3, codexItems: 2, claudeItems: 1 }, items: f.items });
    const respond = async (channel, payload) => {
      f.calls.push({ channel, payload });
      if (channel === 'storage:get-inventory') return structuredClone(f.inventory());
      if (channel === 'storage:get-session-details') return { success: true, totalIterations: 123, branchLength: 123 };
      if (channel === 'storage:set-settings') { f.settings = payload; return { success: true, settings: payload }; }
      if (channel === 'storage:prepare-delete') {
        f.prepares.push(payload);
        if (f.delayPrepare) await new Promise(resolve => { f.releasePrepare = resolve; });
        return { success: true, confirmationToken: 'exact-token', generation: payload.generation,
          affectedItems: payload.itemIds.length, affectedBytes: f.items.filter(x => payload.itemIds.includes(x.id)).reduce((s, x) => s + x.sizeBytes, 0) };
      }
      if (channel === 'storage:delete-items') {
        f.deletes.push(payload);
        if (f.delayDelete) await new Promise(resolve => { f.releaseDelete = resolve; });
        f.items = f.items.filter(x => !payload.itemIds.includes(x.id));
        return { success: true, removed: payload.itemIds, failures: [], reclaimedBytes: 8000000 };
      }
      f.violations.push(channel); throw new Error('Unapproved fixture IPC: ' + channel);
    };
    const ipc = { invoke: respond, on(channel, fn) { f.listeners.set(channel, fn); }, removeListener(channel) { f.listeners.delete(channel); } };
    window.require = (name) => {
      if (name === 'electron') return { ipcRenderer: ipc, clipboard: { writeText(value) { f.clipboard = value; } } };
      throw new Error('Forbidden require: ' + name);
    };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;font-family:Arial}button{cursor:pointer}</style><div id="root"></div><script>(${installAdapters.toString()})();</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'profile'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
global.win=new BrowserWindow({show:false,focusable:false,width:800,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
win.webContents.on('paint',()=>{});win.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  child = app.process(); result.pid = child.pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(9000);
  page.on('pageerror', error => result.errors.push(error.stack || error.message));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const check = name => result.checks.push(name);
  const checkbox = id => page.locator(`[data-storage-row-checkbox="${id}"]`);
  await page.locator('[data-storage-row="first"]').waitFor();
  assert.equal(await page.locator('[data-home-empty]').getAttribute('data-home-empty'), 'true');
  assert.equal(await page.locator('[data-storage-browser]').count(), 1);
  assert.equal(await page.locator('[data-ai-processes],[data-mcp-processes]').count(), 0);
  check('Inbox alone shows first workflow prompt; one Storage owner; no duplicate process panels');
  await page.screenshot({ path: path.join(artifact, 'home-empty.png'), fullPage: true });

  await page.evaluate(() => { window.homeFixture.delayCreate = true; });
  await page.locator('[data-home-create-workflow]').dblclick();
  assert.equal(await page.evaluate(() => window.homeFixture.creates.length), 1);
  await page.evaluate(() => { window.homeFixture.releaseCreate(); window.homeFixture.delayCreate = false; });
  await page.waitForFunction(() => document.querySelector('[data-home-empty]').dataset.homeEmpty === 'false');
  assert.deepEqual(await page.evaluate(() => window.homeFixture.creates[0]), { activate: true });
  check('Create workflow calls only canonical command; repeated click cannot duplicate pending creation');

  await page.evaluate(() => {
    window.homeFixture.setSpaces([]);
    window.homeFixture.failCreate = true;
  });
  await page.waitForFunction(() => document.querySelector('[data-home-empty]').dataset.homeEmpty === 'true');
  await page.locator('[data-home-create-workflow]').click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-home-create-workflow]').isEnabled(), true);
  await page.evaluate(() => { window.homeFixture.failCreate = false; });
  await page.locator('[data-home-create-workflow]').click();
  await page.waitForFunction(() => document.querySelector('[data-home-empty]').dataset.homeEmpty === 'false');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.evaluate(() => window.homeFixture.setSpaces([{ id: 'i', kind: 'inbox', name: 'Renamed inbox' }]));
  await page.waitForFunction(() => document.querySelector('[data-home-empty]').dataset.homeEmpty === 'true');
  await page.evaluate(() => window.homeFixture.setSpaces([{ id: 'ordinary', kind: 'ordinary', name: 'Inbox' }]));
  await page.waitForFunction(() => document.querySelector('[data-home-empty]').dataset.homeEmpty === 'false');
  check('Zero workflows, renamed system Inbox and ordinary workflow named Inbox distinguished by kind; create failure/retry remains usable');

  await checkbox('first').click();
  assert.equal(await checkbox('protected').isDisabled(), true);
  await page.locator('[data-storage-delete-checked]').click();
  await page.locator('[data-storage-confirmation]').waitFor();
  await page.evaluate(() => { window.homeFixture.storageNode = document.querySelector('[data-storage-browser]'); });
  for (const width of [350, 800, 1440, 2600]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 1100), width);
    await frames();
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, right: r.right }; };
      return { viewport: innerWidth, storage: rect('[data-storage-browser]'), items: rect('[data-storage-items]'), details: rect('[data-storage-details]'),
        columns: getComputedStyle(document.querySelector('.home-storage-layout')).gridTemplateColumns,
        overflow: document.querySelector('[data-dashboard-root]').scrollWidth > document.querySelector('[data-dashboard-root]').clientWidth,
        sameOwner: window.homeFixture.storageNode === document.querySelector('[data-storage-browser]') };
    });
    assert.equal(geometry.viewport, width); assert.equal(geometry.overflow, false); assert.equal(geometry.sameOwner, true);
    assert.ok(geometry.storage.w >= width - 110);
    if (width >= 1440) { assert.ok(geometry.details.x > geometry.items.x); assert.equal(geometry.details.y, geometry.items.y); }
    else { assert.equal(geometry.items.x, geometry.details.x); assert.ok(geometry.details.y > geometry.items.y); }
    assert.equal(await checkbox('first').isChecked(), true);
    assert.equal(await page.locator('[data-storage-confirmation]').count(), 1);
    await page.screenshot({ path: path.join(artifact, `home-${width}.png`), fullPage: true });
    if (width < 1100) {
      await page.locator('[data-storage-confirm-delete]').scrollIntoViewIfNeeded();
      const visibleControls = await page.locator('[data-storage-confirmation]').evaluate(node => {
        const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      });
      assert.equal(visibleControls, true);
      await page.screenshot({ path: path.join(artifact, `home-${width}-details.png`), fullPage: true });
      await page.evaluate(() => { document.querySelector('[data-dashboard-root]').scrollTop = 0; });
    }
    result.widths.push({ width, geometry });
  }
  check('350/800 stack and 1440/2600 two columns; full available width; no overflow; selection/confirmation persist without remount');
  await page.locator('[data-storage-cancel-delete]').click();
  assert.equal(await page.evaluate(() => window.homeFixture.deletes.length), 0);
  check('Cancel deletes nothing and retains selection');
  await page.locator('[data-storage-details]').getByText('Copy path', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.homeFixture.clipboard), '/synthetic/session/first.jsonl');
  await page.locator('[data-storage-details]').getByText('123', { exact: true }).waitFor();
  check('Details lazy load and Copy path preserved through private memory clipboard');

  await page.evaluate(() => { window.homeFixture.delayPrepare = true; });
  await page.locator('[data-storage-delete-checked]').click();
  await page.locator('[data-storage-provider="claude"]').click();
  await page.evaluate(() => { window.homeFixture.releasePrepare(); window.homeFixture.delayPrepare = false; });
  await frames();
  assert.equal(await page.locator('[data-storage-confirmation]').count(), 0);
  assert.equal(await page.locator('[data-storage-row="first"]').count(), 0);
  assert.equal(await checkbox('second').isChecked(), false);
  check('Filter change invalidates delayed confirmation and clears exact selection');
  await page.locator('[data-storage-provider="all"]').click();
  await checkbox('first').click();
  await checkbox('second').click({ modifiers: ['Shift'] });
  assert.equal(await checkbox('first').isChecked(), true); assert.equal(await checkbox('second').isChecked(), true);
  await page.locator('[data-storage-delete-checked]').click();
  await page.locator('[data-storage-confirmation]').waitFor();
  const prepared = await page.evaluate(() => window.homeFixture.prepares.at(-1));
  assert.deepEqual(prepared.itemIds, ['first', 'second']);
  assert.deepEqual(prepared.itemRevisions, { first: 'revision-first', second: 'revision-second' });
  await page.evaluate(() => { window.homeFixture.delayDelete = true; });
  await page.locator('[data-storage-confirm-delete]').dblclick();
  assert.equal(await page.evaluate(() => window.homeFixture.deletes.length), 1);
  assert.equal(await page.locator('[data-storage-cancel-delete]').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => { const { itemIds, generation, confirmationToken } = window.homeFixture.deletes[0]; return { itemIds, generation, confirmationToken }; }),
    { itemIds: ['first', 'second'], generation: 'fixture-generation', confirmationToken: 'exact-token' });
  await page.evaluate(() => { window.homeFixture.releaseDelete(); window.homeFixture.delayDelete = false; });
  await page.waitForFunction(() => !document.querySelector('[data-storage-confirmation]'));
  assert.equal(await page.locator('[data-storage-row="first"]').count(), 0);
  assert.equal(await checkbox('protected').isDisabled(), true);
  check('Shift range, revision/token-bound confirm, double-submit guard, refresh and protected item preserved; removal synthetic only');

  await page.locator('[data-storage-section="builds"]').click();
  await page.locator('[data-storage-row="build"]').waitFor();
  await page.getByText('Manual cleanup · no auto-delete', { exact: true }).waitFor();
  await page.locator('[data-storage-groups] select').selectOption('7');
  await page.waitForFunction(() => window.homeFixture.settings.retentionDays.build === 7);
  await page.getByText('Auto-delete off', { exact: true }).click();
  await page.getByText('Auto-delete on', { exact: true }).waitFor();
  await page.locator('[data-storage-section="app"]').click();
  await page.locator('[data-storage-row="database"]').waitFor();
  assert.equal(await checkbox('database').isDisabled(), true);
  check('Build manual retention, settings update, auto-delete toggle and protected application data remain accessible');
  await page.locator('[data-storage-toggle]').click();
  assert.equal(await page.locator('.home-storage-layout').count(), 0);
  await page.locator('[data-storage-toggle]').click();
  await page.locator('[data-storage-row="database"]').waitFor();
  check('Storage collapse/reopen preserves section and cached data');
  assert.deepEqual(await page.evaluate(() => window.homeFixture.violations), []);
  assert.deepEqual(result.errors, []);
  assert.equal(await app.evaluate(() => global.win.isFocused()), false);
  result.calls = await page.evaluate(() => window.homeFixture.calls);
  result.status = 'pass';
} catch (error) {
  result.status = 'fail'; result.error = error.stack; process.exitCode = 1;
} finally {
  await app?.close();
  await fs.rm(path.join(artifact, 'profile'), { recursive: true, force: true });
  result.cleanup = !child || child.exitCode !== null || child.signalCode !== null;
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'manifest.json'), JSON.stringify(result.sources, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, checks: result.checks.length, error: result.error, cleanup: result.cleanup }));
}
