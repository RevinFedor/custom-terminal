#!/usr/bin/env node
// Focused snapshot build + private offscreen Electron. No Git, live app or OS input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const closeCascade = process.argv.includes('--close-cascade');
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-tab-linked-files-'));
const snapshot = path.join(artifact, 'source');
const result = { artifact, pass: false, checks: [], errors: [], sources: {} };
let app;
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo,name),path.join(snapshot,name),
    { recursive:true, filter:p=>!p.includes('/node_modules') });
  await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
  await fs.copyFile(path.join(repo,'scripts/fixtures/tab-linked-files.tsx'),path.join(snapshot,'scripts/fixtures/tab-linked-files.tsx'));
  await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  const shared=path.join(artifact,'noted-shared/packages');
  for(const name of ['structured-dnd','file-explorer']) await fs.cp(path.join(repo,'../noted-shared/packages',name),path.join(shared,name),
    {recursive:true,filter:p=>!p.includes('/node_modules')});
  for(const file of ['src/renderer/components/Workspace/TabCard.tsx','src/renderer/components/Workspace/PaneTabChip.tsx',
    'src/renderer/components/Workspace/TabLinkedFiles.tsx','src/renderer/components/Workspace/TabLinkedFiles.css',
    'src/renderer/components/Workspace/FilePreview.tsx','src/renderer/components/Workspace/Workspace.tsx',
    'src/renderer/store/useUIStore.ts','src/renderer/store/useWorkspaceStore.ts',
    'src/renderer/utils/tabLinkedFiles.mjs','src/renderer/utils/tabLinkedFilePreview.ts',
    'src/renderer/utils/tabLinkedFilePreviewBounds.ts','scripts/fixtures/tab-linked-files.tsx'])
    result.sources[file]=createHash('sha256').update(await fs.readFile(path.join(snapshot,file))).digest('hex');
  for(const file of ['scripts/tab-linked-files-regression.mjs','src/renderer/utils/tabLinkedFiles.test.mjs'])
    result.sources[file]=createHash('sha256').update(await fs.readFile(path.join(repo,file))).digest('hex');
  await build({entryPoints:[path.join(snapshot,'scripts/fixtures/tab-linked-files.tsx')],bundle:true,sourcemap:true,
    outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'iife',target:'chrome120',jsx:'automatic',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
    alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),
      '@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),
      react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
    loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
  function installShim() {
    const listeners = new Map(), rows = new Map(), saved = new Map();
    const f = window.linkedFixture = { calls: [], unknown: [], violations: [], reads: 0,
      capabilities: ['synthetic structured-clone history', 'diagnostic socket unavailable'] };
    const pendingMenus=[];
    f.releaseMenus=()=>{while(pendingMenus.length)pendingMenus.shift()();};
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
      if (channel === 'file:read') { f.reads++; return { success: true, content: '# Synthetic document\n\n' + payload }; }
      if (channel === 'project:validate-tab-snapshot') return { success: true };
      if (channel === 'file:probe-exists') return { success: true, exists: true };
      if (channel === 'tab:get-context-pct') return { pct: payload.tabId === 'c' ? 84 : 62 };
      if (channel === 'tab-work-context:get') return { success: true, context: { tabId: payload.tabId, revision: 1, files: [], updates: [], pendingCount: payload.tabId === 'many' ? 1 : 0, responsibility: '' } };
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
      if (channel === 'terminal:kill' && f.testClose && payload === 'many') return { success: true };
      if (channel === 'orchestration:tab-closed') return { success: true };
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
    const pendingReads=[]; f.releaseReads=()=>{ while(pendingReads.length) pendingReads.shift()(); };
    const ipc = f.ipc = {
      invoke(c, ...a) { f.calls.push(c);
        if(c==='file:read' && f.delayReads) return new Promise(resolve=>pendingReads.push(()=>resolve(result(c,a[0]))));
        if(c==='terminal:getCommandStates'&&a[0]?.caller==='TabBar.menuOpen'&&f.delayMenus)
          return new Promise(resolve=>pendingMenus.push(()=>resolve({states:{[a[0].tabs[0].tabId]:{isRunning:true}}})));
        return Promise.resolve().then(() => structuredClone(result(c, a[0]))); },
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
        readImage: () => ({ isEmpty: () => true }), writeText: text => f.clipboard = text },
        shell: { showItemInFolder: text => f.finder = text, openExternal: () => deny('shell'), openPath: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
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

  execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),
    '-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
  await fs.writeFile(path.join(artifact,'index.html'),`<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>
    html,body{margin:0;background:#1a1a1a;color:#ccc;font-family:Arial}button{cursor:pointer}
    .h-10{height:40px}.flex{display:flex}.items-center{align-items:center}.justify-between{justify-content:space-between}
    .flex-1{flex:1}.shrink-0{flex-shrink:0}.min-w-0{min-width:0}.px-4{padding:0 16px}.w-full{width:100%}
    .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    </style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
    const w=new BrowserWindow({show:false,focusable:false,width:800,height:560,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});result.electronPid=app.process().pid;
  const page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.errors.push(e.stack||e.message));
  const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const check=name=>result.checks.push(name);
  const chip=id=>page.locator('[data-tab-linked-files="'+id+'"]');
  const popup=id=>page.locator('[data-tab-linked-files-popup="'+id+'"]');
  await chip('one').waitFor();await frames();
  assert.equal(await chip('empty').count(),0);assert.equal(await page.locator('[data-not-pane] [data-tab-linked-files]').count(),0);
  assert.equal(await page.evaluate(()=>window.linkedFixture.reads),0);check('zero hides; pane-only opt-in; no body reads for counts');
  assert.match(await chip('one').innerText(),/same.md/);assert.equal((await chip('many').innerText()).trim(),'3');
  check('one filename; 3 direct files across catalogs incl JSON/PNG; descendant excluded');
  const boxes=()=>page.locator('[data-split-pane-tab-chip]').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.tabId,x:r.x,y:r.y,w:r.width,h:r.height};}));
  const before=await boxes();await chip('many').hover();await popup('many').waitFor();await frames();
  assert.deepEqual(await popup('many').locator('button').allTextContents(),['same.md','config.json','diagram.png']);
  assert.deepEqual(await boxes(),before);check('popup contains filename-only rows; opening leaves wrapped card boxes unchanged');
  const motionBox=await popup('many').boundingBox();
  await page.evaluate(()=>{const f=window.linkedFixture;f.motionMutations=0;f.observer=new MutationObserver(rows=>f.motionMutations+=rows.length);
    f.observer.observe(document.querySelector('[data-tab-linked-files-popup="many"]'),{subtree:true,attributes:true,childList:true});});
  for(let i=0;i<30;i++) await page.mouse.move(motionBox.x+12+(i%10),motionBox.y+12+(i%5));
  result.motionMutations=await page.evaluate(()=>{window.linkedFixture.observer.disconnect();return window.linkedFixture.motionMutations;});
  assert.equal(result.motionMutations,0);check('continuous popup pointer movement causes no DOM/placement mutations');
  const geometry=await page.locator('[data-tab-card="many"]').first().evaluate(card=>{
    const bounds=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};
    return{card:bounds(card),file:bounds(card.querySelector('[data-tab-linked-files]')),
      tasks:bounds(card.querySelector('[data-task-plan-tab-markers]')),label:bounds(card.querySelector('[data-tab-card-label]'))};});
  result.geometry=geometry;
  assert.ok(geometry.tasks.bottom<=geometry.file.y);assert.ok(geometry.label.bottom<=geometry.tasks.y);
  check('task marker row and label clear border-mounted chip');
  const signals=await page.locator('[data-tab-card="many"]').first().evaluate(card=>{
    const file=card.querySelector('[data-tab-linked-files]').getBoundingClientRect(),
      context=card.querySelector('[data-tab-context-update-badge]').getBoundingClientRect(),
      bell=card.querySelector('[data-tab-completion-notification-badge]')?.getBoundingClientRect();
    return {contextRight:context.right,fileLeft:file.left,bellBottom:bell?.bottom,fileTop:file.top};
  });
  assert.ok(signals.contextRight<=signals.fileLeft);check('context-update bottom badge remains clear of file chip');
  const row=popup('many').locator('[data-linked-file-id="many-json"]');await row.hover();await page.waitForTimeout(220);
  assert.equal(await popup('many').count(),1);check('hover bridge survives trigger-to-popup gap');
  const bridgeBox=await page.locator('[data-linked-files-hover-bridge]').boundingBox();
  await page.mouse.move(bridgeBox.x+6,bridgeBox.y+bridgeBox.height/2);await page.waitForTimeout(350);
  assert.equal(await popup('many').count(),1);check('stationary slow crossing stays open on real hover bridge');
  await page.mouse.click(bridgeBox.x+6,bridgeBox.y+bridgeBox.height/2);
  assert.equal(await popup('many').getAttribute('data-pinned'),'0');
  assert.equal(await page.locator('[data-chip-shown="1"]').getAttribute('data-tab-id'),'empty');
  check('bridge click neither pins popup nor activates parent card');
  await row.click();await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='many-json');
  assert.equal(await popup('many').getAttribute('data-pinned'),'0');
  assert.equal(await page.locator('[data-tab-card="many"]').first().getAttribute('data-linked-file-owner-selected'),'1');
  assert.equal(await row.getAttribute('data-file-selected'),'1');
  assert.equal(await chip('other').getAttribute('data-file-selected'),null);
  await page.locator('[data-file-preview-root]').waitFor();await frames();
  const bounds=await page.evaluate(()=>({header:document.querySelector('[data-fixture-header]').getBoundingClientRect().bottom,
    preview:document.querySelector('[data-file-preview-root]').getBoundingClientRect().top}));
  assert.equal(bounds.preview,bounds.header);check('FilePreview starts below measured header, preserving chip access');
  await page.screenshot({path:path.join(artifact,'selected.png')});check('exact owner+file selection and existing FilePreview; internal row does not pin');
  await page.locator('[data-file-preview-root] button').filter({hasText:'×'}).click();
  assert.equal(await page.evaluate(()=>window.linkedFixture.preview()),null);
  assert.equal(await page.locator('[data-chip-shown="1"]').getAttribute('data-tab-id'),'many');
  check('existing FilePreview close button clears selection and returns to exact owner');
  await page.keyboard.press('Escape');assert.equal(await popup('many').count(),0);
  await chip('many').click();assert.equal(await popup('many').getAttribute('data-pinned'),'1');
  await page.mouse.move(700,8);await page.waitForTimeout(250);assert.equal(await popup('many').count(),1);
  await page.locator('[data-outside]').click();assert.equal(await popup('many').count(),0);check('trigger click pins; outside and Escape dismiss');
  await page.evaluate(()=>window.linkedFixture.navigate('one'));assert.equal(await page.evaluate(()=>window.linkedFixture.preview()),null);
  assert.equal(await chip('many').getAttribute('data-file-selected'),null);check('navigation clears only linked preview selection');
  await page.evaluate(()=>{const f=window.linkedFixture;f.delayReads=true;void f.open('many','many-md');void f.open('many','many-json');f.releaseReads();f.delayReads=false;});
  await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='many-json');check('last click wins delayed concurrent reads');
  await page.evaluate(()=>{const f=window.linkedFixture;f.close();f.delayReads=true;void f.open('many','many-md');f.close();f.releaseReads();f.delayReads=false;});
  await frames();assert.equal(await page.evaluate(()=>window.linkedFixture.preview()),null);check('close during read cannot resurrect preview');
  await page.evaluate(()=>{const f=window.linkedFixture;f.delayReads=true;void f.open('many','many-md');f.navigate('one');f.navigate('many');f.releaseReads();f.delayReads=false;});
  await frames();assert.equal(await page.evaluate(()=>window.linkedFixture.preview()),null);check('navigate away/back invalidates pending read');
  await page.evaluate(()=>window.linkedFixture.open('many','many-md'));await frames();
  await page.evaluate(()=>{window.linkedFixture.replacePreview();window.linkedFixture.navigate('other');});
  assert.equal((await page.evaluate(()=>window.linkedFixture.preview())).path,'/replacement.md');check('old view lease cannot clear replacement preview');
  await page.evaluate(()=>window.linkedFixture.close());
  await chip('many').click();await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  const menu=page.locator('[data-tab-context-menu]');await menu.waitFor();
  for(const action of ['copy-file-path','reveal-file','copy-file-content','unlink-file']) assert.equal(await menu.locator('[data-tab-context-action="'+action+'"]').count(),1);
  await menu.locator('[data-tab-context-action="copy-file-path"]').click();assert.equal(await page.evaluate(()=>window.linkedFixture.clipboard),'/same.md');
  await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  await menu.locator('[data-tab-context-action="reveal-file"]').click();assert.equal(await page.evaluate(()=>window.linkedFixture.finder),'/same.md');
  await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  await menu.locator('[data-tab-context-action="copy-file-content"]').click();assert.match(await page.evaluate(()=>window.linkedFixture.clipboard),/Synthetic document/);
  check('Copy Path, Finder and Copy Content use exact file; OS integrations mocked');
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.open('many','many-md'));
  await chip('many').click();await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  await menu.locator('[data-tab-context-action="unlink-file"]').click();
  await page.waitForFunction(()=>window.linkedFixture.preview()===null);
  assert.equal((await chip('many').innerText()).trim(),'2');check('unlink updates count and closes exact preview; no disk deletion');
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.split(true));await frames();
  await page.evaluate(()=>window.linkedFixture.open('many','many-json'));await frames();
  const paneBounds=await page.evaluate(()=>{
    const r=document.querySelector('[data-file-preview-root]').getBoundingClientRect(),
      header=document.querySelector('[data-fixture-header]').getBoundingClientRect();
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,headerBottom:header.bottom};
  });
  assert.equal(paneBounds.left,100);assert.equal(paneBounds.right,430);assert.equal(paneBounds.bottom,460);
  assert.equal(paneBounds.top,paneBounds.headerBottom);result.paneBounds=paneBounds;
  const toolbar=await page.locator('[data-file-preview-root]').evaluate(root=>{
    const header=root.firstElementChild, title=header.firstElementChild.getBoundingClientRect(),
      actions=header.lastElementChild.getBoundingClientRect(), bounds=root.getBoundingClientRect();
    return {titleBottom:title.bottom,actionsTop:actions.top,
      buttonsFit:[...header.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=bounds.right)};
  });
  assert.ok(toolbar.titleBottom<=toolbar.actionsTop);assert.ok(toolbar.buttonsFit);
  check('existing FilePreview toolbar wraps inside narrow owner pane without title overlap');
  await page.screenshot({path:path.join(artifact,'pane-preview.png')});check('reader stays inside exact owning pane below wrapped header');
  await page.evaluate(()=>{window.linkedFixture.close();window.linkedFixture.split(false);});await frames();
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.bottom(true));await frames();
  await chip('long').hover();await popup('long').waitFor();await frames();
  const long=await popup('long').evaluate(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,flipped:n.dataset.flipped,width:r.width};});
  assert.equal(long.flipped,'1');assert.ok(long.left>=8&&long.right<=792&&long.top>=8&&long.bottom<=552);
  await page.screenshot({path:path.join(artifact,'flipped-long-name.png')});result.long=long;check('pathological name clamped; bottom-edge flip');
  await page.keyboard.press('Escape');await page.evaluate(()=>{window.linkedFixture.bottom(false);window.linkedFixture.geometry(22,7);});await frames();
  await chip('many').hover();await frames();assert.equal(await popup('many').evaluate(n=>getComputedStyle(n).fontSize),'22px');
  const lane=await page.locator('[data-tab-card="many"]').first().evaluate(n=>({
    taskBottom:n.querySelector('[data-task-plan-tab-markers]').getBoundingClientRect().bottom,
    fileTop:n.querySelector('[data-tab-linked-files]').getBoundingClientRect().top,
    fileHeight:n.querySelector('[data-tab-linked-files]').getBoundingClientRect().height}));
  assert.ok(lane.taskBottom<=lane.fileTop);assert.ok(lane.fileHeight>=20);result.largeFontLane=lane;
  await page.screenshot({path:path.join(artifact,'large-font.png')});check('configured font and padding honored');
  if (closeCascade) for (const width of [350, 500, 1100]) {
    if (width !== 350) { await page.reload(); await chip('many').waitFor(); }
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 560), width);
    await page.setViewportSize({ width, height: 560 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const f = window.linkedFixture; f.testClose = true; f.bottom(false); f.geometry(14, 3); });
    await page.evaluate(() => window.linkedFixture.open('many', 'many-json'));
    await page.locator('[data-file-preview-root]').waitFor();
    assert.equal(await page.evaluate(() => window.linkedFixture.closeOwner()), true);
    await page.waitForFunction(() => window.linkedFixture.preview() === null);
    assert.equal(await chip('many').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.linkedFixture.tabIds().filter(id =>
      ['many', 'many-md', 'many-json', 'many-png'].includes(id))), []);
    assert.ok(await page.evaluate(() => ['child', 'child-md', 'one-md', 'other-md']
      .every(id => window.linkedFixture.tabIds().includes(id))));
    await app.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const paint = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { contents.removeListener('paint', paint); reject(Error('close capture paint timeout')); }, 3000);
      contents.once('paint', paint); contents.invalidate();
    }));
    await page.screenshot({ path: path.join(artifact, 'closed-owner-' + width + '.png') });
    check('actual close owner clears linked cards/reader across catalogs at ' + width + '; independent child/files survive');
  }
  assert.deepEqual(await page.evaluate(()=>window.linkedFixture.violations),[]);
  assert.deepEqual(result.errors,[]);result.pass=true;
} catch(error){result.errors.push(error.stack||String(error));process.exitCode=1;}
finally{if(app)await app.close();await fs.rm(path.join(artifact,'user-data'),{recursive:true,force:true});result.privateProfileRemoved=true;
  if(result.electronPid){try{process.kill(result.electronPid,0);result.privatePidStopped=false;}catch{result.privatePidStopped=true;}}
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));}
