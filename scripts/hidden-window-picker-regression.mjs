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
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-hidden-window-picker-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
let app;
const result = { artifact, samples: [], checks: [], errors: [], pass: false };
const logs = [];
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/hidden-window-picker.tsx'), path.join(snapshot, 'scripts/fixtures/hidden-window-picker.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', n), path.join(shared, n),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  await build({ sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/hidden-window-picker.tsx')], bundle: true,
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
    const f = window.pickerFixture = { calls: [], unknown: [], violations: [], reads: 0,
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
      if (channel === 'tab:get-context-pct') return { pct: payload.tabId === 'c' ? 84 : 62 };
      if (channel === 'tab-work-context:get') return { success: true, context: { tabId: payload.tabId, revision: 1, files: [], updates: [], pendingCount: 0, responsibility: '' } };
      if (channel === 'terminal:getCommandState') return { isRunning: true, command: 'codex' };
      if (channel === 'terminal:getCommandStates') return Object.fromEntries(['a','b','c','d','e'].map(id => [id,{isRunning:true,command:'codex'}]));
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
      const w=new BrowserWindow({show:false,focusable:false,width:1000,height:650,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message)); page.on('console', m => logs.push(m.text()));

  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const trigger=page.locator('[data-hidden-window-picker-button]').first();
  const popup=page.locator('[data-hidden-window-picker]');
  const open=async()=>{await trigger.click();await popup.waitFor();await frames();};
  const reset=async()=>{await page.keyboard.press('Escape');await page.locator('[data-reset]').click();await frames();};
  const state=()=>page.evaluate(()=>window.pickerFixture.state());
  const card=tab=>popup.locator('[data-hidden-window-tab-id="'+tab+'"]');
  await trigger.waitFor();await open();
  const row=popup.locator('[data-hidden-window-id="hidden-many"]');
  assert.equal(await row.locator('[data-tab-card]').count(),3);
  const geometry=await row.evaluate(el=>{const c=getComputedStyle(el);return {padding:c.padding,margin:c.margin,transition:c.transitionDuration};});
  assert.deepEqual(geometry,{padding:'0px',margin:'0px',transition:'0s'});
  assert.equal(await row.getByText('run after / run cmd',{exact:true}).count(),1,'window does not duplicate a tab title as its own heading');
  await card('c').locator('[data-tab-context-usage]').waitFor();
  const metrics=async locator=>locator.evaluate(el=>{const s=getComputedStyle(el);return{font:s.fontSize,radius:s.borderRadius,padding:s.padding,
    percentage:el.querySelector('[data-tab-context-usage]')?.textContent,marker:!!el.querySelector('[data-tab-status-marker]'),tasks:el.querySelectorAll('[data-task-plan-tab-marker]').length};});
  const paneMetrics=await metrics(page.locator('[data-card-reference] [data-tab-card="c"]'));
  const hiddenMetrics=await metrics(card('c'));assert.deepEqual(hiddenMetrics,paneMetrics);
  assert.equal(hiddenMetrics.percentage,'84');assert.equal(hiddenMetrics.marker,true);assert.equal(hiddenMetrics.tasks,1);
  assert.equal(await card('c').locator('[data-tab-card-project-icon]').count(),1);
  assert.equal(await page.locator('[data-card-reference] [data-tab-card-project-icon]').count(),0,'project icon can be hidden by the shared card caller');
  assert.ok(await popup.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'signal overhang must not create a spurious scrollbar');
  assert.ok(await card('c').locator('.tab-process-bar-ai-shimmer-overlay').count()>0);
  const normalBg=await card('c').evaluate(e=>getComputedStyle(e).backgroundColor);
  await card('c').hover();await frames();
  const hover=await card('c').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,transition:getComputedStyle(e).transitionDuration,
    parentBg:getComputedStyle(e.parentElement).backgroundColor}));
  assert.notEqual(hover.bg,normalBg);assert.equal(hover.transition,'0s');assert.equal(hover.parentBg,'rgba(0, 0, 0, 0)');
  const cardHoverColor=await card('c').evaluate(e=>getComputedStyle(e).color);
  await page.locator('[data-card-reference] [data-tab-card="c"]').hover();await frames();
  assert.equal(await page.locator('[data-card-reference] [data-tab-card="c"]').evaluate(e=>getComputedStyle(e).color),cardHoverColor,
    'pane and picker share the same hover text profile');
  const bounds=await row.boundingBox();await page.mouse.move(bounds.x+bounds.width-3,bounds.y+bounds.height-3);await frames();
  assert.notEqual(await row.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','free background highlights independently');
  await page.screenshot({path:path.join(artifact,'hidden-windows.png')});
  result.checks.push('shared size/status/context/tasks/icon/busy chrome; no duplicate title, zero wrapper padding and instant separate hovers');
  await card('b').click();await frames();
  let s=await state();assert.equal(s.panes[0].id,'hidden-many');assert.equal(s.panes[0].shown,'b');assert.deepEqual(s.panes[0].tabs,['b','c','d']);
  assert.equal(s.panes.find(x=>x.id==='visible').hidden,true);assert.equal(s.mru[0],'b');assert.notEqual(s.mru[0],'c');
  await page.waitForFunction(()=>document.querySelector('[data-terminal-pane-wrapper="b"]')?.getAttribute('data-terminal-surface-presented')==='1');
  result.checks.push('click a parked card reveals that window with that exact tab and retained order');
  await reset();await open();
  const marker=await card('b').locator('[data-task-plan-tab-marker]').boundingBox();
  await page.mouse.click(marker.x+marker.width/2,marker.y+marker.height-1);await frames();
  s=await state();assert.equal(s.panes[0].shown,'b','the signal overhang belongs to its tab, not the surrounding window background');
  result.checks.push('click on the task signal overhang selects the same card');
  await reset();await open();const bg=popup.locator('[data-hidden-window-id="hidden-many"]');await bg.focus();await page.keyboard.press('Enter');await frames();
  s=await state();assert.equal(s.panes[0].shown,'c');result.checks.push('window background keyboard activation preserves its existing selection');
  await reset();await open();await card('d').click({button:'middle'});await frames();
  s=await state();assert.equal(s.panes[0].id,'visible');assert.deepEqual(s.panes.find(x=>x.id==='hidden-many').tabs,['b','c']);assert.equal(await popup.count(),1);
  await page.keyboard.down('Meta');try{await card('b').click();}finally{await page.keyboard.up('Meta');}await frames();
  s=await state();assert.deepEqual(s.panes.find(x=>x.id==='hidden-many').tabs,['c']);assert.equal(s.panes[0].id,'visible');
  result.checks.push('middle and Cmd clicks remove only the named hidden chip without revealing the window');
  await reset();const slot=await page.evaluate(()=>window.pickerFixture.chooser());await open();
  await popup.locator('[data-hidden-window-slot-id="'+slot+'"]').click();await frames();
  s=await state();assert.equal(s.panes[0].slot,slot);assert.equal(s.panes[0].shown,'');assert.ok(!s.mru.includes('c'));
  result.checks.push('chooser card reveals its placeholder without activating the old AI tab');
  await reset();await open();await page.evaluate(()=>window.pickerFixture.rename());await card('c').getByText('Переименованная вкладка',{exact:true}).waitFor();
  await page.evaluate(()=>window.pickerFixture.busy(false));await page.waitForFunction(()=>!document.querySelector('[data-hidden-window-tab-id="c"] .tab-process-bar-ai-shimmer-overlay'));
  await page.evaluate(()=>window.pickerFixture.icon(false));assert.equal(await card('c').locator('[data-tab-card-project-icon]').count(),0);
  result.checks.push('live name/activity/icon updates use the shared card while popup stays open');
  await page.keyboard.press('Escape');await page.locator('[data-run-after-host] [data-run-after-tab-row]').click();
  const runMenu=page.locator('[data-run-after-picker-menu]');await runMenu.waitFor();
  const runCard=runMenu.locator('[data-run-after-tab-row="c"]');await runCard.waitFor();
  const runMetrics=await metrics(runCard);assert.equal(runMetrics.radius,paneMetrics.radius);assert.equal(runMetrics.font,paneMetrics.font);
  assert.equal(runMetrics.percentage,'84');assert.equal(runMetrics.marker,true);assert.equal(runMetrics.tasks,1);
  await runMenu.locator('[data-run-after-tab-row="d"]').click();await frames();s=await state();assert.equal(s.selected,'d');assert.equal(s.panes[0].id,'visible');
  result.checks.push('Run After uses the same card and still selects a dependency without navigating');
  await reset();
  await trigger.evaluate(button=>Object.assign(button.parentElement.style,{position:'fixed',right:'4px',bottom:'4px',zIndex:'9000'}));
  await open();await page.evaluate(()=>window.pickerFixture.geometry(22,0));await frames();
  await page.waitForFunction(()=>{const e=document.querySelector('[data-hidden-window-picker]');if(!e)return false;const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;});
  const resized=await metrics(card('c'));assert.equal(resized.font,'22px');
  await page.screenshot({path:path.join(artifact,'hidden-windows-edge.png')});
  result.checks.push('font-size and zero-gap changes keep the popup within the viewport at the bottom edge');
  assert.deepEqual(result.errors,[]);
  result.state=await page.evaluate(()=>({violations:window.pickerFixture.violations,unknown:[...new Set(window.pickerFixture.unknown)]}));
  assert.deepEqual(result.state.violations,[]);result.pass=true;
} catch (error) { result.failure = String(error); process.exitCode = 1; }
finally {
  if (app) await app.close();
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
}
console.log(JSON.stringify(result));
