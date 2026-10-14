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
  // Optional source-only RED control: run the identical browser scenario with
  // the captured pre-repair header. Never modifies the shared checkout.
  if (process.env.NOTED_PANE_HEADER_BASELINE_DIR) for (const name of ['SplitPaneChrome.tsx','PaneTabStrip.tsx']) {
    const relative=path.join('src/renderer/components/Workspace',name);
    await fs.copyFile(path.join(process.env.NOTED_PANE_HEADER_BASELINE_DIR,relative),path.join(snapshot,relative));
  }
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/pane-wrapped-strip.tsx'), path.join(snapshot, 'scripts/fixtures/pane-wrapped-strip.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', n), path.join(shared, n),
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
    for (const type of ['dragstart','drop','pointerdown','pointerup']) document.addEventListener(type,event=>f.gestures.push({type,trusted:event.isTrusted}),true);
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
    const actions=el.querySelector('[data-split-pane-actions]').getBoundingClientRect();
    return{overflow:getComputedStyle(strip).overflowX,scroll:strip.scrollLeft,
      actions:{left:actions.left,right:actions.right,top:actions.top,bottom:actions.bottom},
      paneRight:el.getBoundingClientRect().right,
      chooserY:el.querySelector('[data-pane-chooser-chip]')?.getBoundingClientRect().top,
      stripBottom:strip.getBoundingClientRect().bottom,
      headerBottom:header.getBoundingClientRect().bottom,
      belowHeaderHit:document.elementFromPoint(el.getBoundingClientRect().left+20,header.getBoundingClientRect().bottom+2)?.closest('[data-split-attach-row]')!=null,
      header:header.getBoundingClientRect().height,content:content.getBoundingClientRect().top,
      rows:[...new Set([...strip.querySelectorAll('[data-strip-item], [data-pane-chooser-chip]')].map(x=>Math.round(x.getBoundingClientRect().top)))],
      cards:[...strip.querySelectorAll('[data-strip-item]')].map(x=>{const r=x.getBoundingClientRect();return{id:x.dataset.stripTabId,x:r.left,y:r.top,w:r.width,h:r.height};})};});
  const initial=await measure();result.samples.push(initial);
  assert.equal(initial.overflow,'clip');assert.ok(initial.rows.length>=3);assert.equal(initial.scroll,0);
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

  // Choose the exact width at which chooser + project-C + D fit on row two,
  // while the first two cards plus the actions still fit on row one. The old
  // two-column header cannot do this: D remains on a third row.
  const fullSecondRowWidth=()=>pane(0).evaluate(el=>{
    const chooser=el.querySelector('[data-pane-chooser-chip]').getBoundingClientRect();
    const c=el.querySelector('[data-strip-tab-id="c"]').getBoundingClientRect();
    const d=el.querySelector('[data-strip-tab-id="d"]').getBoundingClientRect();
    return Math.ceil(chooser.width+c.width+d.width+12+4+16+2+2);
  });
  const widthForSecondRow=await fullSecondRowWidth();
  const setWidth=async width=>{await page.locator('[data-pane-width]').fill(String(width));await frames();};
  const assertHeaderGeometry=async(label,{mustUseActionsColumn=false}={})=>{
    const m=await measure();result.samples.push({label,...m});
    const first=m.cards.filter(c=>c.y<m.actions.bottom-1);
    assert.ok(first.length>0,label+': real chips remain beside first-row actions');
    assert.ok(first.every(c=>c.x+c.w<=m.actions.left-5),label+': first row avoids buttons');
    assert.ok(m.cards.every(c=>c.x+c.w<=m.paneRight-7),label+': cards stay within pane');
    assert.equal(m.belowHeaderHit,false,label+': header hit region cannot cover content below its published height');
    const rowBelow=m.cards.filter(c=>c.y>=m.actions.bottom-1);
    if(mustUseActionsColumn)assert.ok(rowBelow.some(c=>c.x+c.w>m.actions.left+4),label+': later rows use width below buttons');
    const h=await pane(0).locator('[data-split-attach-row]').boundingBox();
    assert.ok(Math.abs(m.content-(h.y+Math.ceil(h.height)))<1,label+': published height follows full header');
    const pairs=m.cards.flatMap((a,i)=>m.cards.slice(i+1).map(b=>({a,b})));
    assert.ok(pairs.every(({a,b})=>a.x+a.w<=b.x+.1||b.x+b.w<=a.x+.1||a.y+a.h<=b.y+.1||b.y+b.h<=a.y+.1),label+': cards never overlap');
    return m;
  };
  await reset();await page.locator('[data-add-hidden]').click();await frames();
  assert.equal(await pane(0).locator('[data-hidden-window-picker-button]').count(),1);
  await setWidth(widthForSecondRow);
  const reclaimed=await assertHeaderGeometry('first-row-only reservation',{mustUseActionsColumn:true});
  assert.equal(reclaimed.cards.find(x=>x.id==='c').y,reclaimed.cards.find(x=>x.id==='d').y,'C and D fit beside chooser on the full-width second row');
  assert.equal(reclaimed.chooserY,reclaimed.cards.find(x=>x.id==='c').y,'chooser and real cards share the same row top');
  await page.screenshot({path:path.join(artifact,'actions-first-row-only.png')});
  await chip('g').click();await frames();
  const reserved=await assertHeaderGeometry('unfocused reservation',{mustUseActionsColumn:true});
  assert.deepEqual(reserved.cards,reclaimed.cards);assert.equal(reserved.header,reclaimed.header);
  result.checks.push('only first row reserves actions; second row fills beneath buttons, focus does not rewrap, published content offset follows');

  for (const width of [320,470,widthForSecondRow]) {await setWidth(width);await assertHeaderGeometry('resize '+width);}
  await page.locator('[data-large-font]').click();await frames();await setWidth(await fullSecondRowWidth());await assertHeaderGeometry('font22',{mustUseActionsColumn:true});
  await page.locator('[data-zero-gap]').click();await frames();await assertHeaderGeometry('font22-gap0',{mustUseActionsColumn:true});
  await page.screenshot({path:path.join(artifact,'actions-large-gap0.png')});
  await reset();await setWidth(410);
  result.checks.push('browser reflow handles resize, large live font and zero badge gap without packing JS or overlapping actions');

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
    assert.equal((await state()).drag.source.input,'pointer');
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

  // A single crossing must paint immediately. No stationary hold and no
  // browser dragover are needed, and the next reverse crossing is immediate.
  await reset();
  const aFast=await chip('a').boundingBox(),bFast=await chip('b').boundingBox();
  await page.mouse.move(bFast.x+bFast.width/2,bFast.y+bFast.height/2);await page.mouse.down();
  await page.mouse.move(bFast.x+bFast.width/2+8,bFast.y+bFast.height/2);await frames();
  const fastStart=Date.now();
  await page.mouse.move(aFast.x+2,aFast.y+aFast.height/2);await frames();
  assert.deepEqual((await order(0)).slice(0,2),['b','a']);
  result.samples.push({label:'single-crossing-immediate',driverMs:Date.now()-fastStart});
  await page.mouse.move(bFast.x+bFast.width-2,bFast.y+bFast.height/2);await frames();
  assert.deepEqual((await order(0)).slice(0,2),['a','b']);
  await page.keyboard.press('Escape');await page.mouse.up();await frames();
  assert.equal((await state()).drag.active,false);assert.equal(await page.locator('[data-horizontal-row-cursor-chip]').count(),0);
  assert.deepEqual((await state()).panes[0].ids,['a','b','choice','c','d','e']);
  result.checks.push('single pointer crossing and reverse paint within two frames without dwell; Escape clears preview');

  await reset();const fromWorkflow=await chip('b').boundingBox(),nav=await page.locator('[data-space-chip="other-space"]').boundingBox();
  await page.mouse.move(fromWorkflow.x+fromWorkflow.width/2,fromWorkflow.y+fromWorkflow.height/2);await page.mouse.down();
  await page.mouse.move(fromWorkflow.x+fromWorkflow.width/2+8,fromWorkflow.y+fromWorkflow.height/2);await frames();
  await page.mouse.move(nav.x+nav.width/2,nav.y+nav.height/2);await frames();
  await page.waitForFunction(()=>window.pickerFixture.state().spaceId==='other-space');
  assert.equal((await state()).drag.source.rootTabId,'b','source survives replacement of its header');
  assert.equal(await page.locator('[data-horizontal-row-cursor-chip]').count(),1);
  const otherTarget=await item('g').boundingBox();await page.mouse.move(otherTarget.x+2,otherTarget.y+otherTarget.height/2);await frames();
  const navigationPreview=await order(0);await page.mouse.up();await frames();
  assert.deepEqual((await state()).panes[0].ids,navigationPreview);assert.deepEqual(navigationPreview,['b','g']);
  assert.equal((await state()).panes[0].shown,'b');assert.equal((await state()).pointer.active,false);
  assert.equal(await page.locator('[data-horizontal-row-cursor-chip]').count(),0);
  result.checks.push('pointer gesture survives workflow navigation/source DOM replacement and commits in exact target workflow');

  await reset();await page.locator('[data-show-sidebar]').click();await frames();
  const sidebarBox=await page.locator('[data-test-adoption] [data-tabbar-vertical]').boundingBox();
  assert.ok(sidebarBox,'real TabBar sidebar mounted');
  const fromSidebar=await chip('b').boundingBox();
  await page.mouse.move(fromSidebar.x+fromSidebar.width/2,fromSidebar.y+fromSidebar.height/2);await page.mouse.down();
  await page.mouse.move(fromSidebar.x+fromSidebar.width/2+8,fromSidebar.y+fromSidebar.height/2);await frames();
  await page.keyboard.down('Meta');
  const sidebarX=sidebarBox.x+sidebarBox.width/2,sidebarY=sidebarBox.y+Math.min(sidebarBox.height-15,70);
  await page.mouse.move(sidebarX,sidebarY);await frames();await page.mouse.move(sidebarX+1,sidebarY);await frames();
  await page.mouse.up();await page.keyboard.up('Meta');await frames();
  await page.waitForFunction(()=>!window.pickerFixture.state().panes.some(p=>p.ids.includes('b')));
  assert.equal((await state()).pointer.active,false);
  assert.equal(await page.locator('[data-pane-tab-pointer-drag-preview]').count(),0);
  assert.ok(await page.locator('[data-test-adoption] [data-tab-id="b"]').count()>0);
  result.checks.push('same pointer gesture is adopted by actual TabBar; Cmd sidebar drop detaches placement and keeps the tab');

  assert.equal(await page.locator('[data-strip-project-icon]').count(),0,'execution namespace does not create a directory prefix');
  await page.screenshot({path:path.join(artifact,'wrapped-dnd.png')});
  assert.deepEqual(result.errors,[]);
  result.state=await page.evaluate(()=>({violations:window.pickerFixture.violations,unknown:[...new Set(window.pickerFixture.unknown)],gestures:window.pickerFixture.gestures}));
  assert.equal(result.state.gestures.filter(x=>x.type==='dragstart').length,0,'pane reordering must not enter browser native drag cadence');
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
