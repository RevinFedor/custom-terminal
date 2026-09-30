#!/usr/bin/env node
// Private offscreen Electron only; no live main, API, PTY or native input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-workflow-switch-cost-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
let app;
const result = { artifact, samples: [], checks: [], errors: [], pass: false };
const logs = [];
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/workflow-switch-cost.tsx'), path.join(snapshot, 'scripts/fixtures/workflow-switch-cost.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', n), path.join(shared, n),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  if (process.env.NOTED_WORKFLOW_BASELINE_GATE) await fs.copyFile(process.env.NOTED_WORKFLOW_BASELINE_GATE,
    path.join(snapshot, 'src/renderer/styles/presentationAnimations.css'));
  await build({ sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/workflow-switch-cost.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  function installShim() {
    const listeners = new Map(), rows = new Map(), saved = new Map();
    const f = window.workflowFixture = { calls: [], unknown: [], violations: [], reads: 0,
      capabilities: ['synthetic structured-clone history', 'diagnostic socket unavailable'] };
    const deny = kind => { f.violations.push(kind); throw Error('Fixture forbids ' + kind); };
    f.rowsFor = sid => {
      if (!rows.has(sid)) rows.set(sid, Array.from({ length: 240 }, (_, i) => ({
        uuid: sid + '-row-' + i, sessionId: sid, role: i % 2 ? 'assistant' : 'user',
        timestamp: new Date(1700000000000 + i * 1000).toISOString(),
        content: 'Synthetic row ' + i + '\n\n' + 'Formatted response text. '.repeat(12),
      })));
      return rows.get(sid);
    };
    const result = (channel, payload) => {
      if (channel === 'app:getState') return saved.get(payload) ?? null;
      if (channel === 'app:setState' || channel === 'app:setStateSync') { saved.set(payload.key, payload.value); return { success: true }; }
      if (channel === 'agent-transcript:get-history') { f.reads++; return { success: true, entries: f.rowsFor(payload.sessionId),
        payloadGeneration: 'fixture-source', revision: { sources: [{ sessionId: payload.sessionId, fileIdentity: 'fixture-source', linkKind: 'end' }] } }; }
      if (channel === 'agent-transcript:get-timeline') return { success: true, entries: f.rowsFor(payload.sessionId).filter(x => x.role === 'user').map(x => ({ ...x, type: 'user' })) };
      if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
      if (/^agent-transcript:(subscribe|unsubscribe|refresh)$/.test(channel)) return { success: true };
      if (channel === 'agent-session:get-availability-batch') return { success: true,
        results: (payload.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
      if (channel === 'terminal:get-headless-buffer-snapshot') return { success: true, serialized: '', generation: 'fixture-gen', generationOrdinal: 1, writeSeq: 0, cols: 80, rows: 24, promptBoundaries: [] };
      if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
      if (channel === 'terminal:getCommandState') return null;
      if (channel === 'terminal:getCommandStates') return {};
      if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:run|agent:(send|stop|rewind)|shell:|app:(open|select))/.test(channel)) return deny(channel);
      if (/^(tab:|tab-task-plan:|project:(save|layout|order)|terminal:(resize|subscribe|unsubscribe|remember))/.test(channel)) return { success: true };
      if (channel === 'agent:get-send-receipts' || channel === 'agent:list-send-receipts') return { success: true, records: [] };
      if (/git.*(status|diff|branch)/.test(channel)) return { success: true, isGitRepo: false, files: [], branches: [] };
      if (/list|catalog|get-models|get-prompts|get-task-plan/.test(channel)) return [];
      if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
      if (channel.startsWith('log:') || channel.startsWith('renderer:') || channel.startsWith('perf:')) return undefined;
      f.unknown.push(channel); return null;
    };
    const ipc = f.ipc = {
      invoke(c, ...a) { f.calls.push(c); return Promise.resolve().then(() => structuredClone(result(c, a[0]))); },
      send(c, ...a) { f.calls.push(c); return result(c, a[0]); }, sendSync(c, ...a) { return result(c, a[0]); },
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
      if (name === 'node:v8') return {}; // no binary envelope in the synthetic IPC
      if (name === 'node:buffer') return {}; // decoder remains unavailable explicitly
      return deny('require:' + name);
    };
    window.process = window.require('process');
    window.fetch = () => Promise.reject(Error('Fixture network denied'));
    window.WebSocket = class { constructor() { deny('WebSocket'); } };
    window.EventSource = class { constructor() { deny('EventSource'); } };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
      const w=new BrowserWindow({show:false,focusable:false,width:1600,height:1000,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message)); page.on('console', m => logs.push(m.text()));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('[data-space-chip="cost-main"]').waitFor();
  await page.locator('[data-history-composer-tab-id="workflow-cost-tab-0"]').waitFor();
  await page.locator('[data-history-row-real]').first().waitFor();
  await page.locator('[data-space-chip="cost-other"]').click();
  await page.locator('[data-history-composer-tab-id="workflow-cost-tab-4"]').waitFor();
  await page.locator('[data-space-chip="cost-main"]').click(); await frames();
  await page.waitForTimeout(800); // settle the warm queue before profiling
  const composer = page.locator('[data-history-composer-tab-id="workflow-cost-tab-0"] .cm-content');
  await composer.click(); await composer.pressSequentially('kept draft');
  const scroller = page.locator('[data-terminal-pane-wrapper="workflow-cost-tab-0"] [data-testid="virtuoso-scroller"]').first();
  const bottom = await scroller.evaluate(e => e.scrollTop);
  await scroller.hover({ position: { x: 120, y: 300 } }); await page.mouse.wheel(0, -350);
  await page.waitForFunction(previous => document.querySelector('[data-terminal-pane-wrapper="workflow-cost-tab-0"] [data-testid="virtuoso-scroller"]').scrollTop < previous - 200, bottom);
  await page.waitForTimeout(180); // observe wheel settling, not navigation readiness
  result.readingBefore = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-terminal-pane-wrapper="workflow-cost-tab-0"]');
    const scroller = wrapper.querySelector('[data-testid="virtuoso-scroller"]');
    window.savedCostOwner = wrapper; window.savedCostScroller = scroller;
    const viewport = scroller.getBoundingClientRect();
    const row = [...scroller.querySelectorAll('[data-history-row-real]')].find(n => n.getBoundingClientRect().bottom > viewport.top + 1);
    window.savedCostRow = row;
    return { scrollTop: scroller.scrollTop, uuid: row?.getAttribute('data-uuid'), offset: row?.getBoundingClientRect().top - viewport.top };
  });
  result.nodes = await page.evaluate(() => document.querySelectorAll('*').length);
  result.readsBefore = await page.evaluate(() => window.workflowFixture.reads);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start');
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordContinuously',
    includedCategories: ['toplevel', 'devtools.timeline', 'blink', 'cc', 'blink.user_timing', 'disabled-by-default-devtools.timeline.invalidationTracking'] } });
  for (let i = 0; i < 8; i++) {
    const name = (i % 2 ? 'main' : 'other') + '-' + i;
    const before = await cdp.send('Performance.getMetrics');
    await page.evaluate(n => performance.mark(n + '-start'), name);
    const start = Date.now(); await page.locator('[data-space-chip="cost-' + (i % 2 ? 'main' : 'other') + '"]').click(); await frames();
    await page.evaluate(n => performance.mark(n + '-end'), name);
    const after = await cdp.send('Performance.getMetrics');
    result.samples.push({ name, elapsed: Date.now() - start, metrics: Object.fromEntries(after.metrics.filter(m =>
      ['ThreadTime', 'ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].includes(m.name))
      .map(m => [m.name, m.value - before.metrics.find(b => b.name === m.name).value])) });
  }
  await fs.writeFile(path.join(artifact, 'renderer.cpuprofile'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end'); const { stream } = await complete;
  let raw = '';
  try { for (;;) { const part = await cdp.send('IO.read', { handle: stream, size: 1048576 }); raw += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data; if (part.eof) break; } }
  finally { await cdp.send('IO.close', { handle: stream }); }
  await fs.writeFile(path.join(artifact, 'trace.json'), raw);
  const traceEvents = JSON.parse(raw).traceEvents;
  const styles = traceEvents.filter(e => e.ph === 'X' && e.name === 'UpdateLayoutTree');
  result.styleTraversal = styles.map(e => ({ ms: e.dur / 1000, elements: e.args?.elementCount ?? null }));
  result.state = await page.evaluate(() => ({ ...window.workflowFixture.getState(), reads: window.workflowFixture.reads,
    violations: window.workflowFixture.violations, unknown: [...new Set(window.workflowFixture.unknown)] }));
  assert.deepEqual(result.errors, []); assert.deepEqual(result.state.violations, []);
  assert.equal(result.state.space, 'cost-main');
  assert.equal(result.state.reads, result.readsBefore, 'warm visits do not read the synthetic histories again');
  const afterReading = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-terminal-pane-wrapper="workflow-cost-tab-0"]');
    const scroller = wrapper.querySelector('[data-testid="virtuoso-scroller"]');
    const row = window.savedCostRow;
    return { sameWrapper: wrapper === window.savedCostOwner, sameScroller: scroller === window.savedCostScroller,
      sameRow: row?.isConnected && scroller.contains(row), scrollTop: scroller.scrollTop,
      offset: row?.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      draft: wrapper.querySelector('.cm-content')?.textContent,
      activeTab: document.activeElement?.closest('[data-terminal-pane-wrapper]')?.getAttribute('data-terminal-pane-wrapper') };
  });
  result.readingAfter = afterReading;
  assert.ok(afterReading.sameWrapper && afterReading.sameScroller && afterReading.sameRow, 'warm DOM identity is retained');
  assert.ok(Math.abs(afterReading.scrollTop - result.readingBefore.scrollTop) < 1 && Math.abs(afterReading.offset - result.readingBefore.offset) < 1,
    'return keeps the reading position instead of pulling the user to the tail');
  assert.equal(afterReading.draft, 'kept draft'); assert.equal(afterReading.activeTab, 'workflow-cost-tab-0');
  result.checks.push('warm wrapper, scroller, reading row and offset survive eight trusted switches', 'draft and exact input focus survive', 'history reads stay constant');
  const styleCosts = result.samples.map(s => s.metrics.RecalcStyleDuration * 1000).sort((a, b) => a - b);
  result.styleMedianMs = (styleCosts[3] + styleCosts[4]) / 2;
  if (process.env.NOTED_WORKFLOW_EXPECT_FAST === '1') {
    assert.ok(result.styleMedianMs < 35, 'indexed animation targets do not revisit thousands of ordinary retained elements');
    assert.ok(!result.styleTraversal.some(s => s.elements > 2000 && s.ms > 25), 'the previous broad selector traversal is gone');
    result.checks.push('native style work stays below35ms and removes the former >2000-element expensive traversal');
  }
  // Deliver a synthetic background record through the actual live/invalidation
  // listeners. This does not call a provider or require a real terminal.
  await page.evaluate(() => window.workflowFixture.emitAppend('workflow-cost-tab-4'));
  await page.waitForFunction(() => window.workflowFixture.reads > 6);
  await page.locator('[data-space-chip="cost-other"]').click(); await frames();
  await page.locator('[data-terminal-pane-wrapper="workflow-cost-tab-4"]').getByText('Synthetic background completion').first().waitFor();
  await page.locator('[data-space-chip="cost-main"]').click(); await frames();
  const retainedAfterBackground = await scroller.evaluate(e => ({ same: e === window.savedCostScroller, top: e.scrollTop,
    row: window.savedCostRow?.isConnected, offset: window.savedCostRow?.getBoundingClientRect().top - e.getBoundingClientRect().top }));
  assert.ok(retainedAfterBackground.same && retainedAfterBackground.row);
  assert.ok(Math.abs(retainedAfterBackground.top - result.readingBefore.scrollTop) < 1
    && Math.abs(retainedAfterBackground.offset - result.readingBefore.offset) < 1);
  result.background = retainedAfterBackground;
  result.checks.push('background transcript update appears after reveal and keeps the other pane reading position');
  result.pass = true;
} catch (error) { result.failure = String(error); process.exitCode = 1; }
finally {
  if (app) await app.close();
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.copyFile(path.join(snapshot, 'src/renderer/components/Workspace/HistoryPanel.tsx'), path.join(artifact, 'HistoryPanel.snapshot.tsx'));
  execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
}
console.log(JSON.stringify(result));
