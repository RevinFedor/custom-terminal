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
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-pane-wrapped-strip-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
let app;
const result = { artifact, samples: [], checks: [], errors: [], pass: false };
const logs = [];
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/pane-wrapped-strip.tsx'), path.join(snapshot, 'scripts/fixtures/pane-wrapped-strip.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', n), path.join(shared, n),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  await build({ sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/pane-wrapped-strip.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  function installShim() {
    const listeners = new Map(), rows = new Map(), saved = new Map([['paneTabStripWrap',false],['paneTabStripAutoReveal',true]]);
    localStorage.setItem('noted-terminal-pane-strip-wrap','false');
    localStorage.setItem('noted-terminal-pane-strip-auto-reveal','true');
    const f = window.pickerFixture = { calls: [], obsoleteRequests: [], unknown: [], violations: [], reads: 0, gestures: [],
      capabilities: ['synthetic structured-clone history', 'diagnostic socket unavailable'] };
    for (const type of ['dragstart','drop']) document.addEventListener(type,event=>f.gestures.push({type,trusted:event.isTrusted}),true);
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
      if (channel === 'app:getState') { if (/^paneTabStrip/.test(payload)) f.obsoleteRequests.push(payload); return saved.get(payload) ?? null; }
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


  const frames=async()=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  const state=()=>page.evaluate(()=>window.pickerFixture.state());
  const pane=i=>page.locator('[data-test-pane="'+i+'"]');
  const item=id=>page.locator('[data-strip-item][data-strip-tab-id="'+id+'"]');
  const chip=id=>item(id).locator('[data-tab-card]').first();
  const order=i=>pane(i).locator('[data-strip-item], [data-pane-chooser-chip]').evaluateAll(nodes=>nodes.map(e=>e.getAttribute('data-strip-tab-id')||e.getAttribute('data-chooser-slot-id')));
  const reset=async()=>{await page.locator('[data-reset]').click();await frames();};
  await item('a').waitFor();await frames();
  const measure=()=>pane(0).evaluate(el=>{const strip=el.querySelector('[data-pane-tab-strip-scroller]'),header=el.querySelector('[data-split-attach-row]'),content=el.querySelector('[data-test-content]');
    return{wrap:getComputedStyle(strip).flexWrap,overflow:getComputedStyle(strip).overflowX,scroll:strip.scrollLeft,
      header:header.getBoundingClientRect().height,content:content.getBoundingClientRect().top,
      rows:[...new Set([...strip.querySelectorAll('[data-strip-item], [data-pane-chooser-chip]')].map(x=>Math.round(x.getBoundingClientRect().top)))],
      cards:[...strip.querySelectorAll('[data-strip-item]')].map(x=>{const r=x.getBoundingClientRect();return{id:x.dataset.stripTabId,x:r.left,y:r.top,w:r.width,h:r.height};})};});
  const initial=await measure();result.samples.push(initial);
  assert.equal(initial.wrap,'wrap');assert.equal(initial.overflow,'clip');assert.ok(initial.rows.length>=3);assert.equal(initial.scroll,0);
  assert.deepEqual((await state()).obsoleteKeys,[]);
  assert.deepEqual(await page.evaluate(()=>window.pickerFixture.obsoleteRequests),[]);
  assert.deepEqual(await order(0),['a','b','choice','c','d','e']);
  assert.equal(await page.locator('[data-strip-overflow]').count(),0);
  await page.screenshot({path:path.join(artifact,'wrapped-header.png')});
  result.checks.push('stale localStorage false/SQLite false do not read or revive removed settings; all rows and mixed places visible');

  const menu=pane(0).locator('[data-split-strip-menu-button]');await menu.click();
  await page.locator('[data-split-strip-menu]').waitFor();
  assert.equal(await page.locator('[data-split-strip-menu-item="wrap"], [data-split-strip-menu-item="auto-reveal"]').count(),0);
  assert.ok(await page.locator('[data-split-strip-menu-item="swap-workspace-window"]').count()>0);
  await page.screenshot({path:path.join(artifact,'window-menu.png')});
  await page.locator('[data-split-strip-menu-backdrop]').click({position:{x:920,y:520}});
  await page.locator('[data-split-strip-menu]').waitFor({state:'detached'});
  await menu.click();await page.locator('[data-split-strip-menu-backdrop]').click({position:{x:920,y:520}});await frames();
  result.checks.push('ellipsis retains window actions, removes wrap/auto-reveal, closes/reopens by outside click');

  await chip('g').click();await frames();
  const unfocused=await measure();assert.deepEqual(unfocused.cards,initial.cards);assert.equal(unfocused.header,initial.header);assert.equal(unfocused.content,initial.content);
  assert.equal((await state()).focus,1);assert.equal((await state()).panes[1].shown,'g');
  await pane(0).locator('[data-pane-chooser-chip]').click();await frames();
  assert.equal((await state()).focus,0);assert.equal((await state()).panes[0].slot,'choice');
  assert.equal((await measure()).header,initial.header);
  await reset();await chip('c').click();await frames();assert.equal((await state()).panes[0].shown,'c');
  assert.equal(await pane(0).locator('[data-test-input]').inputValue(),'unchanged draft 0');
  result.checks.push('focus and chooser selection preserve row geometry, exact shown tab and input');

  await item('a').hover();await page.mouse.wheel(0,150);await frames();assert.equal((await measure()).scroll,0);
  // Clip also rejects programmatic scroll for very long single items.
  const scroll=await pane(0).locator('[data-pane-tab-strip-scroller]').evaluate(el=>{el.scrollLeft=999;return el.scrollLeft;});assert.equal(scroll,0);
  result.checks.push('wheel and programmatic scroll cannot create a hidden horizontal row');

  async function drag(source,target,{side='left'}={}) {
    const from=await chip(source).boundingBox(),to=await item(target).boundingBox();
    const x=side==='left'?to.x+3:to.x+to.width-3,y=to.y+to.height/2;
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
    await page.mouse.move(from.x+from.width/2+8,from.y+from.height/2,{steps:4});
    await page.mouse.move(x,y,{steps:12});await page.mouse.move(x,y);await frames();
    await page.waitForFunction(()=>window.pickerFixture.state().drag.active);
    const before=await state(),preview=[await order(0),await order(1)];
    await page.mouse.up();await page.waitForFunction(()=>!window.pickerFixture.state().drag.active);await frames();
    const after=await state();
    result.samples.push({source,target,before:before.drag,preview,after});
    // Source keeps a placeholder until cross-window commit; target previews
    // the final insertion. Only that placeholder disappears on release.
    const sourcePane=Number(before.drag.source.sourcePaneKey.split(':')[1]);
    const targetPane=before.drag.target.paneIndex;
    const expected=preview.map((ids,i)=>i===sourcePane&&i!==targetPane?ids.filter(id=>id!==source):ids);
    assert.deepEqual(after.panes.map(x=>x.ids),expected,'committed mixed order equals target preview and source placeholder removal');
    return after;
  }
  await reset();const beforeA=await chip('a').boundingBox(),beforeB=await chip('b').boundingBox();assert.equal(beforeA.y,beforeB.y);
  let s=await drag('b','a');assert.deepEqual(s.panes[0].ids,['b','a','choice','c','d','e']);assert.equal(s.panes[0].shown,'a');
  result.checks.push('trusted same-row reorder preserves shown tab and chooser position');
  await reset();const eBox=await chip('e').boundingBox();assert.ok(eBox.y>beforeA.y);
  s=await drag('e','a');assert.deepEqual(s.panes[0].ids,['e','a','choice','b','c','d']);assert.equal(s.panes[0].shown,'a');
  s=await drag('a','d',{side:'right'});assert.equal(s.panes[0].ids.at(-1),'a');
  result.checks.push('trusted cross-row reorder and next drag commit the painted mixed order');
  await reset();s=await drag('b','g');assert.deepEqual(s.panes[1].ids,['f','b','g']);assert.equal(s.panes[1].shown,'b');assert.ok(!s.panes[0].ids.includes('b'));assert.ok(s.panes[0].ids.includes('choice'));
  result.checks.push('trusted cross-window drop moves exactly once, preserves chooser and shows chosen tab');

  const grouping=await page.locator('[data-strip-project-start]').evaluateAll(nodes=>nodes.every(node=>{const icon=node.querySelector('[data-strip-project-icon]'),card=node.querySelector('[data-tab-card]');const a=icon.getBoundingClientRect(),b=card.getBoundingClientRect();return a.left<b.left&&a.top>=b.top&&a.bottom<=b.bottom;}));assert.equal(grouping,true);
  await page.screenshot({path:path.join(artifact,'wrapped-dnd.png')});
  assert.deepEqual(result.errors,[]);
  result.state=await page.evaluate(()=>({violations:window.pickerFixture.violations,unknown:[...new Set(window.pickerFixture.unknown)],gestures:window.pickerFixture.gestures}));
  assert.equal(result.state.gestures.filter(x=>x.type==='dragstart').length,4);
  assert.ok(result.state.gestures.every(x=>x.trusted),'DnD enters through trusted Chromium input');
  assert.deepEqual(result.state.violations,[]);result.pass=true;
} catch (error) { result.failure=error.stack||String(error);process.exitCode=1; }
finally {
  if(app)await app.close();
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));
  execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});
}
console.log(JSON.stringify(result));
