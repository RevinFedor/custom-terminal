#!/usr/bin/env node
// Actual components, frozen source, owned offscreen Electron, synthetic IPC only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-workflow-reserve-'));
const snapshot=path.join(artifact,'source');
const result={artifact,pass:false,checks:[],errors:[],sources:{},limits:['Synthetic IPC and canonical commit adapters; no Main migration/lifecycle or production acceptance.']};
let app;
try {
  for(const name of ['src','packages/claude-blocks']) await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,filter:p=>!p.includes('/node_modules')});
  await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
  await fs.copyFile(path.join(repo,'scripts/fixtures/workflow-reserve.tsx'),path.join(snapshot,'scripts/fixtures/workflow-reserve.tsx'));
  await fs.copyFile(path.join(repo,'scripts/workflow-reserve-regression.mjs'),path.join(snapshot,'scripts/workflow-reserve-regression.mjs'));
  await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  const shared=path.join(artifact,'noted-shared/packages');
  for(const name of ['structured-dnd','file-explorer']) await fs.cp(path.join(repo,'../noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p=>!p.includes('/node_modules')});
  const compiled=await build({entryPoints:[path.join(snapshot,'scripts/fixtures/workflow-reserve.tsx')],bundle:true,sourcemap:true,metafile:true,
    outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'iife',target:'chrome120',jsx:'automatic',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
    alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),
      '@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
    loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
  for(const input of Object.keys(compiled.metafile.inputs)) {
    if(input.startsWith('<')) continue;
    const absolute=path.resolve(input);
    if(absolute.includes('/node_modules/')) continue;
    result.sources[path.relative(artifact,absolute)]=createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
  }
  for(const name of ['scripts/workflow-reserve-regression.mjs','src/renderer/utils/workflowReserve.test.mjs'])
    result.sources['source/'+name]=createHash('sha256').update(await fs.readFile(path.join(snapshot,name))).digest('hex');
  function installFixtureShim() {
    const listeners = new Map(), rows = new Map(), saved = new Map();
    const f = window.reserveFixture = { calls: [], unknown: [], violations: [], reads: 0,
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

  execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
  await fs.writeFile(path.join(artifact,'index.html'),`<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc;font-family:Arial}textarea{background:#252525;color:#ddd;max-width:100%;height:70px}h2{font-size:16px}</style><div id="root"></div><script>(${installFixtureShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
    const w=new BrowserWindow({show:false,focusable:false,width:850,height:640,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});result.electronPid=app.process().pid;
  const page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.errors.push(e.stack||e.message));
  const check=name=>result.checks.push(name);
  const rows=()=>page.locator('[data-workflow-reserve-tab]');
  const ids=()=>rows().evaluateAll(nodes=>nodes.map(n=>n.dataset.workflowReserveTab));
  const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const reset=async name=>{await page.evaluate(name=>window.reserveFixture.case(name),name);await frames();};
  const row=id=>page.locator('[data-workflow-reserve-tab="'+id+'"]');
  await row('r3').waitFor();await frames();
  assert.deepEqual(await ids(),['r3','r1','r5','r0','r4','r2']);check('six reserve in manual order, hidden/parked/dormant/profile/center/archived excluded');
  assert.equal(await page.locator('[data-workflow-reserve-scroll]').count(),1);check('one scroll owner');
  await page.evaluate(()=>window.retainedDraft=document.querySelector('[data-retained-draft]'));
  await page.locator('[data-retained-draft]').fill('Private unsent draft — unchanged');
  await page.screenshot({path:path.join(artifact,'six.png')});
  await reset('partial');assert.deepEqual(await ids(),['r4','r2']);
  assert.equal(await page.locator('[data-reserve-group-id="same-id"]').count(),1);check('four placed, two reserve keep same group');
  await page.screenshot({path:path.join(artifact,'partial.png')});
  await reset('one');assert.deepEqual(await ids(),['r2']);check('one reserve');
  await reset('zero');assert.equal(await rows().count(),0);assert.equal(await page.locator('[data-reserve-group-id]').count(),0);
  assert.match(await page.locator('[data-workflow-reserve-scroll]').innerText(),/Все вкладки/);check('zero reserve hides fully placed group');
  await reset('namespaces');assert.equal(await page.locator('[data-reserve-group-id="same-id"]').count(),2);
  assert.equal(await row('other').getAttribute('data-execution-namespace'),'other-legacy');check('same group ID in separate namespace remains distinct');
  await reset('six');
  const chip=page.locator('[data-tab-linked-files="r1"]');await chip.hover();
  const popup=page.locator('[data-tab-linked-files-popup="r1"]');await popup.waitFor();
  assert.deepEqual(await popup.locator('[data-linked-file-id]').allTextContents(),['work.json']);
  assert.doesNotMatch(await popup.innerText(),/child.md/);check('direct attached JSON only, child AI files not parent files');
  await page.screenshot({path:path.join(artifact,'files.png')});
  await popup.locator('[data-linked-file-id="owner-file"]').click();
  await page.waitForFunction(()=>window.reserveFixture.actions.some(x=>x.type==='file'));
  assert.equal(await page.evaluate(()=>window.reserveFixture.actions.find(x=>x.type==='file').ownerProjectId),'reserve-legacy');check('exact file and owner callback');
  await page.keyboard.press('Escape');await page.mouse.move(810,10);await frames();
  await row('r3').click({modifiers:['Meta']});await row('r0').click({modifiers:['Shift']});
  assert.deepEqual(await rows().evaluateAll(nodes=>nodes.filter(n=>n.getAttribute('aria-pressed')==='true').map(n=>n.dataset.workflowReserveTab)),['r3','r1','r5','r0']);check('Meta selection and Shift range in manual order');
  await row('r4').click({button:'right'});await page.locator('[data-tab-context-menu]').waitFor();
  const menuIdentity=await page.locator('[data-tab-context-menu]').evaluate(n=>({text:n.textContent,visible:n.getBoundingClientRect().width>0}));
  result.menu=menuIdentity;
  assert.equal(menuIdentity.visible,true);check('existing exact-owner context menu opens');
  await page.locator('[data-tab-context-menu]').getByText('Rename',{exact:true}).click();
  const rename=page.locator('[data-workflow-reserve-tab="r4"] input');await rename.fill('Renamed exact tab');await rename.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-workflow-reserve-tab="r4"]').textContent.includes('Renamed exact tab'));
  check('existing context-menu Rename returns to reserve input and preserves exact tab record');
  await row('r4').focus();await page.keyboard.press('F2');await rename.fill('Cancelled');await rename.press('Escape');
  assert.match(await row('r4').innerText(),/Renamed exact tab/);check('Escape cancels rename');
  await page.getByRole('button',{name:'Новая вкладка в резерве'}).click();
  await page.waitForFunction(()=>window.reserveFixture.actions.some(x=>x.type==='create'));
  const create=await page.evaluate(()=>window.reserveFixture.actions.find(x=>x.type==='create').request);
  assert.deepEqual(create,{workflowId:'work',sourceTabId:'r1',cwd:'/synthetic-reserve',placement:'reserve'});check('new tab captures exact source cwd and workflow without project create');
  await page.getByRole('button',{name:'Создать группу',exact:true}).click();check('group creation delegates canonical workflow target');
  await page.evaluate(()=>window.reserveFixture.delayCreate=true);
  const createsBefore=await page.evaluate(()=>window.reserveFixture.actions.filter(x=>x.type==='create').length);
  await page.getByRole('button',{name:'Новая вкладка в резерве'}).click();
  assert.equal(await page.getByRole('button',{name:'Новая вкладка в резерве'}).isDisabled(),true);
  await page.getByRole('button',{name:'Новая вкладка в резерве'}).evaluate(n=>n.click());
  assert.equal(await page.evaluate(()=>window.reserveFixture.actions.filter(x=>x.type==='create').length),createsBefore+1);
  await page.evaluate(()=>{window.reserveFixture.delayCreate=false;window.reserveFixture.releaseCreate();});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Новая вкладка в резерве"]').disabled);
  check('pending create suppresses repeat click and releases button on completion');
  await reset('six');await row('r0').click();await page.waitForFunction(()=>!document.querySelector('[data-workflow-reserve-tab="r0"]'));
  assert.deepEqual(await page.evaluate(()=>window.reserveFixture.actions.filter(x=>x.type==='open').at(-1)),
    {type:'open',projectId:'reserve-legacy',tabId:'r0'});check('ordinary click opens exact owner through parent and leaves reserve');
  await reset('six');
  await page.getByRole('button',{name:/Свернуть группу Responsibility/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-workflow-reserve-tab]').length===0);
  await page.getByRole('button',{name:/Раскрыть группу Responsibility/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-workflow-reserve-tab]').length===6);check('group collapse and expansion preserve members');
  const drag=async(from,to)=>{const a=await from.boundingBox(),b=await to.boundingBox();
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2+12,{steps:4});
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:15});await frames();await page.mouse.up();await frames();};
  await row('r0').click({modifiers:['Meta']});await row('r4').click({modifiers:['Meta']});
  await drag(row('r0'),page.locator('[data-private-pane-header]'));
  await page.waitForFunction(()=>window.reserveFixture.actions.some(x=>x.type==='place'));
  const headerPlacement=await page.evaluate(()=>window.reserveFixture.actions.find(x=>x.type==='place'));
  assert.deepEqual(headerPlacement.entries,[{projectId:'reserve-legacy',tabId:'r0'},{projectId:'reserve-legacy',tabId:'r4'}]);
  assert.equal(headerPlacement.target.zone,'strip');assert.equal(headerPlacement.target.at,0);
  check('trusted multi-selection drag to existing header preserves manual order and exact owners');
  await reset('six');
  await row('r3').click({modifiers:['Meta']}); // remove range selection's root
  await drag(row('r2'),page.locator('[data-pane-tab-drop-zone="body"]'));
  await page.waitForFunction(()=>window.reserveFixture.actions.some(x=>x.type==='place'));
  const placement=await page.evaluate(()=>window.reserveFixture.actions.filter(x=>x.type==='place').at(-1));
  assert.deepEqual(placement.entries,[{projectId:'reserve-legacy',tabId:'r2'}]);assert.equal(placement.target.paneKey,'pane:0');check('trusted reserve drag to existing pane emits exact canonical placement');
  await reset('six');
  await drag(page.locator('[data-private-pane-source]'),row('r0'));
  await page.waitForFunction(()=>window.reserveFixture.actions.some(x=>x.type==='detach'));
  assert.equal(await row('placed0').count(),1);check('trusted pane drag into reserve requests detach and appears without replacement');
  await reset('six');
  const before=await ids();await drag(row('r2'),row('r3'));
  await page.waitForFunction(()=>window.reserveFixture.actions.some(x=>x.type==='outline'));
  assert.notDeepEqual(await ids(),before);check('trusted structured reorder commit updates manual order');
  const outlineCount=await page.evaluate(()=>window.reserveFixture.actions.filter(x=>x.type==='outline').length);
  const box=await row('r1').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,box.y+70,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();
  const actions=await page.evaluate(()=>window.reserveFixture.actions);
  assert.equal(actions.filter(x=>x.type==='outline').length,outlineCount);check('Escape ends structured drag without commit');
  assert.equal(await page.evaluate(()=>window.retainedDraft===document.querySelector('[data-retained-draft]')),true);
  assert.equal(await page.locator('[data-retained-draft]').inputValue(),'Private unsent draft — unchanged');
  assert.equal(await page.evaluate(()=>window.reserveFixture.state().openProjects.get('reserve-legacy').tabs.get('r1').draft),'Draft r1');check('runtime draft node and catalog draft retained across reserve changes');
  for(const width of [350,500,1000]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,640),width);await frames();
    assert.ok(await row('r1').evaluate(n=>n.getBoundingClientRect().width>0));
    await page.screenshot({path:path.join(artifact,'width-'+width+'.png')});
  }
  check('350/500/1000px screenshots');
  await reset('hierarchy');
  assert.equal(await row('r5').getAttribute('data-parent-id'),'reserve-tab:r3');
  check('reserve visual child remains nested under exact reserve parent');
  await reset('context');assert.equal(await row('r3').count(),0);
  assert.match(await row('r2').locator('..').innerText(),/↳ Task r3/);check('placed parent becomes small context label, no duplicate card');
  await page.screenshot({path:path.join(artifact,'hierarchy.png')});
  await reset('many');
  const scroller=page.locator('[data-workflow-reserve-scroll]');
  const sb=await scroller.boundingBox();await page.mouse.move(sb.x+sb.width/2,sb.y+sb.height/2);await page.mouse.wheel(0,380);
  await page.waitForFunction(()=>document.querySelector('[data-workflow-reserve-scroll]').scrollTop>0);
  const top=await scroller.evaluate(n=>n.scrollTop);await page.mouse.wheel(0,120);
  await page.waitForFunction(top=>document.querySelector('[data-workflow-reserve-scroll]').scrollTop>top,top);
  check('one user scroll owner keeps accepting scroll after offset callback');
  await scroller.evaluate(n=>n.scrollTop=0);
  const handle=page.locator('[data-tab-sidebar-resize-handle]'), hb=await handle.boundingBox();
  await page.mouse.move(hb.x+3,hb.y+hb.height/2);await page.mouse.down();
  await page.mouse.move(hb.x+53,hb.y+hb.height/2,{steps:10});await page.mouse.up();await frames();
  assert.equal(await page.locator('[data-workflow-tab-sidebar]').evaluate(n=>Math.round(n.getBoundingClientRect().width)),350);
  check('trusted sidebar resize uses existing helper and persists one width');
  assert.equal(await page.evaluate(()=>window.reserveFixture.violations.length),0);assert.deepEqual(result.errors,[]);
  result.actions=actions;result.pass=true;
} catch(error){result.failure=error.stack||String(error);process.exitCode=1;
  if(app)try{const page=(await app.windows())[0];result.debug=await page.evaluate(()=>({
    groups:window.reserveFixture?.state?.().openProjects.get('reserve-legacy')?.tabGroups,
    html:document.querySelector('[data-reserve-group-id]')?.outerHTML,
    actions:window.reserveFixture?.actions}));await page.screenshot({path:path.join(artifact,'failure.png')});}catch{}
}
finally{
  if(app)try{await app.close();result.cleanup=true;}catch(error){result.cleanupError=String(error);}
  await fs.rm(path.join(artifact,'user-data'),{recursive:true,force:true});
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({artifact,pass:result.pass,checks:result.checks.length,errors:result.errors,cleanup:result.cleanup,failure:result.failure},null,2));
}
