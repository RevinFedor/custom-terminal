#!/usr/bin/env node
// Focused snapshot build + private offscreen Electron. Read-only Git baseline;
// no live application, provider, user-data mutations or global OS input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { historyVirtuosoMeasurementEsbuildPlugin } from './lib/history-virtuoso-measurement.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const closeCascade = process.argv.includes('--close-cascade');
const geometryOnly = process.argv.includes('--geometry');
const buildOnly = process.argv.includes('--build-only');
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
  const baselineCommit='f9b45cc89d56fecb5e8c535d1b6c1301486a498d';
  const baselineModules=[
    ['src/renderer/components/Workspace/TabCard.tsx','src/renderer/components/Workspace/TabCardBaseline.tsx'],
    ['src/renderer/components/Workspace/TabSignals.tsx','src/renderer/components/Workspace/TabSignalsBaseline.tsx'],
    ['src/renderer/components/Workspace/tabChrome.ts','src/renderer/components/Workspace/tabChromeBaseline.ts'],
    ['src/renderer/utils/tabCardVisual.mjs','src/renderer/utils/tabCardVisualBaseline.mjs'],
  ];
  for(const [original,destination] of baselineModules) {
    const originalText=execFileSync('git',['show',baselineCommit+':'+original],{cwd:repo,encoding:'utf8'});
    const text=originalText.replaceAll("from './TabSignals'","from './TabSignalsBaseline'")
      .replaceAll("from './tabChrome'","from './tabChromeBaseline'")
      .replaceAll("from '../../utils/tabCardVisual.mjs'","from '../../utils/tabCardVisualBaseline.mjs'");
    await fs.writeFile(path.join(snapshot,destination),text);
    result.sources['baseline:f9b45cc:'+original]=createHash('sha256').update(originalText).digest('hex');
  }
  const baselinePath=path.join(snapshot,baselineModules[0][1]);
  const shared=path.join(artifact,'noted-shared/packages');
  for(const name of ['structured-dnd','file-explorer']) await fs.cp(path.join(repo,'../noted-shared/packages',name),path.join(shared,name),
    {recursive:true,filter:p=>!p.includes('/node_modules')});
  for(const file of ['src/renderer/components/Workspace/TabCard.tsx','src/renderer/components/Workspace/PaneTabChip.tsx',
    'src/renderer/components/Workspace/TabSignals.tsx','src/renderer/components/Workspace/tabChrome.ts',
    'src/renderer/utils/tabCardVisual.mjs','src/renderer/hooks/useWorkspaceOverlayTarget.ts',
    'src/renderer/utils/tabCardTitleMetrics.ts',
    'src/renderer/components/Workspace/TabLinkedFiles.tsx','src/renderer/components/Workspace/TabLinkedFiles.css',
    'src/renderer/components/Workspace/FilePreview.tsx','src/renderer/components/Workspace/FilePreviewHeader.tsx','src/renderer/components/Workspace/Workspace.tsx',
    'src/renderer/store/useUIStore.ts','src/renderer/store/useWorkspaceStore.ts',
    'src/renderer/utils/tabLinkedFiles.mjs','src/renderer/utils/tabLinkedFilePreview.ts',
    'src/renderer/utils/tabLinkedFilePreviewBounds.ts','scripts/fixtures/tab-linked-files.tsx'])
    result.sources[file]=createHash('sha256').update(await fs.readFile(path.join(snapshot,file))).digest('hex');
  for(const file of ['scripts/tab-linked-files-regression.mjs','src/renderer/utils/tabLinkedFiles.test.mjs'])
    result.sources[file]=createHash('sha256').update(await fs.readFile(path.join(repo,file))).digest('hex');
  await build({entryPoints:[path.join(snapshot,'scripts/fixtures/tab-linked-files.tsx')],bundle:true,sourcemap:true,
    outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'iife',target:'chrome120',jsx:'automatic',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
    plugins:[historyVirtuosoMeasurementEsbuildPlugin()],
    alias:{'@visual-baseline/TabCard':baselinePath,'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),
      '@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),
      react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
    loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl','.b64':'text'}});
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
      if (channel === 'file:open-in-gt-editor' || channel === 'file:open-in-sublime') {f.openEditor={channel,path:payload};return {success:true};}
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
    html,body{margin:0;background:#1a1a1a;color:#ccc}button{cursor:pointer}
    .h-10{height:40px}.flex{display:flex}.items-center{align-items:center}.justify-between{justify-content:space-between}
    .flex-1{flex:1}.shrink-0{flex-shrink:0}.min-w-0{min-width:0}.px-4{padding:0 16px}.w-full{width:100%}
    .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    </style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
    const w=new BrowserWindow({show:false,focusable:false,width:800,height:560,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  if(buildOnly) {result.buildOnly=true;result.pass=true;} else {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});result.electronPid=app.process().pid;
  const page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.errors.push(e.stack||e.message));
  const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const check=name=>result.checks.push(name);
  const chip=id=>page.locator('[data-tab-linked-files="'+id+'"]');
  const popup=id=>page.locator('[data-tab-linked-files-popup="'+id+'"]');
  await page.screenshot({path:path.join(artifact,'initial.png')});
  await page.locator('[data-fixture-header]').waitFor();
  if (geometryOnly) {
    await page.evaluate(()=>window.linkedFixture.dense(true));
    await page.locator('[data-dense-current]').waitFor();
    result.limits=['Actual rendered current vs Git-before TabCard; synthetic IPC, no Main/lifecycle acceptance'];
    result.comparisons=[];
    for(const [font,padding,width,gap] of [[14,3,1000,4],[28,3,1700,4],[28,7,1100,4],[28,3,580,4],[28,3,1100,12]]) {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1000),width);
      await page.setViewportSize({width,height:1000});
      await page.evaluate(([font,padding,gap])=>window.linkedFixture.geometry(font,padding,gap),[font,padding,gap]);await frames();
      const comparison=await page.evaluate(()=>{
        const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};};
        const read=selector=>{const root=document.querySelector(selector),r=box(root);
          return [...root.querySelectorAll('[data-tab-card]')].map(n=>{const b=box(n);return{id:n.dataset.tabCard,x:b.x-r.x,y:b.y-r.y,w:b.w,h:b.h};});};
        const ink=[...document.querySelectorAll('[data-dense-current] [data-tab-linked-files]')].map(file=>{
          const card=file.closest('[data-tab-card]'),label=card.querySelector('[data-tab-card-label]');
          const marker=document.createElement('span');Object.assign(marker.style,{display:'inline-block',height:'0px',width:'0px',verticalAlign:'baseline'});label.prepend(marker);
          const context=document.createElement('canvas').getContext('2d');context.font=getComputedStyle(label).font;
          const text=context.measureText('HРрgjpqy');
          const baseline=marker.getBoundingClientRect().top,b=card.getBoundingClientRect(),f=file.getBoundingClientRect();marker.remove();
          const status=card.querySelector('[data-tab-status-marker]')?.getBoundingClientRect();
          return{id:card.dataset.tabCard,topGap:baseline-text.actualBoundingBoxAscent-b.top-1,
            fileGap:f.top-baseline-text.actualBoundingBoxDescent,overhang:f.bottom-b.bottom,
            statusCenterError:status?status.top+status.height/2-(baseline+(text.actualBoundingBoxDescent-text.actualBoundingBoxAscent)/2):null,
            height:b.height,inkHeight:text.actualBoundingBoxAscent+text.actualBoundingBoxDescent,chipHeight:f.height};
        });
        return{before:read('[data-dense-before]'),current:read('[data-dense-current]'),ink,
          rowGap:parseFloat(getComputedStyle(document.querySelector('[data-dense-current]')).rowGap),
          lowerMarkers:document.querySelectorAll('[data-dense-current] [data-task-plan-tab-markers]').length};
      });
      assert.equal(comparison.current.length,18);assert.equal(comparison.lowerMarkers,0);
      for(let i=0;i<18;i++) for(const metric of ['x','w'])
        assert.ok(Math.abs(comparison.before[i][metric]-comparison.current[i][metric])<.1,
          'Git-before '+metric+' differs at '+font+'/'+padding+'/'+width+' '+comparison.current[i].id);
      assert.ok(comparison.current.every(card=>Math.abs(card.h-comparison.current[0].h)<.06),'equal heights with/without files');
      for(const ink of comparison.ink){
        assert.ok(ink.topGap>=1.94,'title moves at least 1px down from old inset: '+JSON.stringify(ink));
        assert.ok(Math.abs(ink.fileGap)<.06,'chip above touching descenders: '+JSON.stringify(ink));
        assert.ok(Math.abs(comparison.rowGap-ink.overhang-1)<.06,'exact 1px before next row: '+JSON.stringify(ink));
        if(ink.statusCenterError!==null)assert.ok(Math.abs(ink.statusCenterError)<.06,'status stays opposite title glyphs: '+JSON.stringify(ink));
        assert.ok(ink.height-ink.chipHeight-ink.overhang>=0);
        const baseline=comparison.before.find(card=>card.id===ink.id);
        assert.ok(ink.height<=Math.max(baseline.h,Math.ceil(4+ink.inkHeight+ink.chipHeight-comparison.rowGap))+0.1,'only minimum necessary shared height');
      }
      const stem='dense-'+font+'-'+padding+'-'+width;
      await page.locator('[data-dense-before]').screenshot({path:path.join(artifact,stem+'-before.png')});
      await page.locator('[data-dense-current]').screenshot({path:path.join(artifact,stem+'-current.png')});
      result.comparisons.push({font,padding,width,...comparison});
      check('18 equal card heights, original widths/row gap, title down and exact 1px chip-to-next-row at '+font+'/'+padding+'/'+width+'/'+gap);
    }
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1700,1000));
    await page.setViewportSize({width:1700,height:1000});
    await page.evaluate(()=>window.linkedFixture.geometry(28,3));await frames();
    const many=page.locator('[data-dense-current] [data-tab-linked-files="dense-1"]');
    const single=page.locator('[data-dense-current] [data-tab-linked-files="dense-0"]');
    assert.match(await many.innerText(),/query.md\s*\+1/);
    await page.mouse.move(1690,5);await frames();
    const owner=page.locator('[data-dense-current] [data-tab-card="dense-1"]');
    const paint=await owner.evaluate(n=>({background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color}));
    const before=await owner.boundingBox();
    const restingChip=await many.boundingBox();
    await many.hover();await popup('dense-1').waitFor();await frames();
    const hoveringChip=await many.boundingBox();
    assert.ok(Math.abs(restingChip.y+restingChip.height-hoveringChip.y-hoveringChip.height)<.06,'hover keeps exact lower edge and next-row clearance');
    assert.ok(Math.abs(hoveringChip.height/restingChip.height-1.04)<.002,'hover scales the chip without layout reflow');
    assert.deepEqual(await owner.boundingBox(),before);
    assert.deepEqual(await owner.evaluate(n=>({background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color})),paint);
    const geometry=await owner.evaluate(n=>{const label=n.querySelector('[data-tab-card-label]').getBoundingClientRect();
      const file=n.querySelector('[data-tab-linked-files]').getBoundingClientRect();const card=n.getBoundingClientRect();
      return{labelBottom:label.bottom,fileTop:file.top,fileBottom:file.bottom,cardBottom:card.bottom};});
    assert.ok(geometry.cardBottom-geometry.fileTop>geometry.fileBottom-geometry.cardBottom);
    assert.equal(await popup('dense-1').locator('[data-linked-file-id] svg').count(),2);
    await popup('dense-1').locator('[data-linked-file-id]').first().hover();await frames();
    assert.deepEqual(await many.boundingBox(),hoveringChip,'moving into popup retains chip scale and lower edge');
    assert.deepEqual(await owner.evaluate(n=>({background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color})),paint);
    await page.screenshot({path:path.join(artifact,'dense-popup.png')});
    await page.mouse.move(1690,5);await frames();
    assert.equal(await popup('dense-1').count(),0);
    check('name +N, file icons, majority of absolute chip inside card, unchanged owner paint, closes by next paint');
    await single.hover();await popup('dense-0').waitFor();await frames();
    assert.equal(await popup('dense-0').locator('[data-linked-file-id]').count(),1);
    await single.click();await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='dense-0-file');
    check('single-file hover exposes its row while chip click opens exact preview directly');
    await page.screenshot({path:path.join(artifact,'single-direct.png')});
    await page.evaluate(()=>window.linkedFixture.close());
  } else {
  await chip('one').waitFor();await frames();
  assert.equal(await chip('empty').count(),0);assert.equal(await page.locator('[data-not-pane] [data-tab-linked-files]').count(),0);
  assert.equal(await page.evaluate(()=>window.linkedFixture.reads),0);check('zero hides; pane-only opt-in; no body reads for counts');
  assert.match(await chip('one').innerText(),/same.md/);assert.match(await chip('many').innerText(),/same\.md\s*\+2/);
  check('filename +N when it fits; 3 direct files across catalogs incl JSON/PNG; descendant excluded');
  await chip('one').hover();await popup('one').waitFor();await frames();
  assert.equal(await popup('one').locator('[data-linked-file-id="one-md"]').count(),1);
  await chip('one').click();await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='one-md');
  assert.equal(await popup('one').count(),1);
  await chip('one').click({button:'right'});
  const singleMenu=page.locator('[data-tab-context-menu]');await singleMenu.waitFor();
  await singleMenu.locator('[data-tab-context-action="copy-file-path"]').click();
  assert.equal(await page.evaluate(()=>window.linkedFixture.clipboard),'/same.md');
  assert.equal((await page.evaluate(()=>window.linkedFixture.preview())).sourceTabId,'one-md');
  const header=page.locator('[data-file-preview-header]');
  assert.equal(await header.locator('[data-file-preview-name]').innerText(),'same.md');
  assert.equal(await header.locator('button').count(),4);
  await header.getByRole('button',{name:'Open in GT Editor'}).click();
  assert.deepEqual(await page.evaluate(()=>window.linkedFixture.openEditor),{channel:'file:open-in-gt-editor',path:'/same.md'});
  await header.getByRole('button',{name:'Open in Sublime Text'}).click();
  assert.deepEqual(await page.evaluate(()=>window.linkedFixture.openEditor),{channel:'file:open-in-sublime',path:'/same.md'});
  await header.locator('[data-file-preview-copy]').click();
  assert.match(await page.evaluate(()=>window.linkedFixture.clipboard),/Synthetic document/);
  const headerMetrics=await header.evaluate(n=>{const b=n.querySelector('[aria-label="Close file preview"]'),icon=b.querySelector('svg'),r=b.getBoundingClientRect(),i=icon.getBoundingClientRect();
    return{height:n.getBoundingClientRect().height,closeCursor:getComputedStyle(b).cursor,copyCursor:getComputedStyle(n.querySelector('[data-file-preview-copy]')).cursor,
      center:[Math.abs(r.x+r.width/2-i.x-i.width/2),Math.abs(r.y+r.height/2-i.y-i.height/2)]};});
  assert.equal(headerMetrics.height,30);assert.equal(headerMetrics.closeCursor,'pointer');assert.equal(headerMetrics.copyCursor,'pointer');
  assert.ok(headerMetrics.center.every(delta=>delta<.1));
  await header.screenshot({path:path.join(artifact,'file-header.png')});
  check('compact file header: filename only, two exact editor actions, Copy All, pointer cursors and centered close icon');
  await header.getByRole('button',{name:'Close file preview'}).click();
  check('singleton opens exact file directly; overhanging chip stays clickable above preview and its menu addresses the file');
  await page.evaluate(()=>window.linkedFixture.navigate('empty'));await frames();
  const boxes=()=>page.locator('[data-split-pane-tab-chip]').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.tabId,x:r.x,y:r.y,w:r.width,h:r.height};}));
  const before=await boxes();await chip('many').hover();await popup('many').waitFor();await frames();
  const hoveredChip=await chip('many').boundingBox();
  assert.deepEqual(await popup('many').locator('[data-linked-file-id] [data-tab-card-title-line]').allTextContents(),['same.md','config.json','diagram.png']);
  const rowWidths=await popup('many').locator('[data-linked-file-id]').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().width));
  assert.ok(rowWidths[0]<rowWidths[1]&&rowWidths[1]<rowWidths[2],'file popup rows follow filename widths');
  assert.deepEqual(await boxes(),before);check('popup contains filename-only rows; opening leaves wrapped card boxes unchanged');
  await popup('many').locator('[data-linked-file-id]').first().hover();await frames();
  const motionBox=await popup('many').boundingBox();
  await page.evaluate(()=>{const f=window.linkedFixture;f.motionMutations=0;f.observer=new MutationObserver(rows=>f.motionMutations+=rows.length);
    f.observer.observe(document.querySelector('[data-tab-linked-files-popup="many"]'),{subtree:true,attributes:true,childList:true});});
  for(let i=0;i<30;i++) await page.mouse.move(motionBox.x+12+(i%10),motionBox.y+12+(i%5));
  result.motionMutations=await page.evaluate(()=>{window.linkedFixture.observer.disconnect();return window.linkedFixture.motionMutations;});
  assert.equal(result.motionMutations,0);check('continuous popup pointer movement causes no DOM/placement mutations');
  assert.deepEqual(await chip('many').boundingBox(),hoveredChip,'popup hover keeps chip scale');
  const density=await popup('many').evaluate(menu=>{
    const tree=menu.querySelector('[data-linked-file-tree]'),rows=[...menu.querySelectorAll('[data-linked-file-id]')];
    const rects=rows.map(n=>n.getBoundingClientRect()),m=menu.getBoundingClientRect();
    return {padding:getComputedStyle(menu).padding,treePadding:getComputedStyle(tree).padding,
      rowPadding:getComputedStyle(rows[0]).padding,rowHeight:rects[0].height,referenceHeight:document.querySelector('[data-tab-card="empty"]').getBoundingClientRect().height,gap:rects[1].top-rects[0].bottom,
      outer:[rects[0].top-m.top,m.bottom-rects.at(-1).bottom,rects[0].left-m.left,m.right-Math.max(...rects.map(r=>r.right))]};
  });
  assert.equal(density.padding,'1px');assert.equal(density.treePadding,'1px');assert.ok(Math.abs(density.rowHeight-density.referenceHeight)<.1,'popup and sidebar TabCard share row height');
  assert.ok(Math.abs(density.gap-1)<.1);assert.ok(density.outer.every(gap=>gap<=3.1));result.popupDensity=density;
  await popup('many').screenshot({path:path.join(artifact,'compact-popup.png')});
  check('compact popup: 1px frame/tree inset, 1px row gap, no empty feedback column; scale holds through popup hover');
  const geometry=await page.locator('[data-tab-card="many"]').first().evaluate(card=>{
    const bounds=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};
    return{card:bounds(card),file:bounds(card.querySelector('[data-tab-linked-files]')),
      tasks:card.querySelectorAll('[data-task-plan-tab-markers]').length,label:bounds(card.querySelector('[data-tab-card-label]'))};});
  result.geometry=geometry;
  assert.equal(geometry.tasks,0);assert.ok(geometry.card.bottom-geometry.file.y>geometry.file.bottom-geometry.card.bottom);
  assert.ok(Math.abs(geometry.file.bottom-geometry.card.bottom-5)<.06);
  check('no lower task lane; chip sits mostly inside the bottom of the original card');
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
  assert.match(await chip('many').innerText(),/config.json/);
  await row.click();await frames();assert.equal(await page.evaluate(()=>window.linkedFixture.preview()),null);
  assert.match(await chip('many').innerText(),/config.json/);
  await row.click();await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='many-json');
  check('same popup file toggles closed then reopens; chip follows active and last-opened file');
  await page.locator('[data-file-preview-root]').waitFor();await frames();
  const bounds=await page.evaluate(()=>{
    const header=document.querySelector('[data-fixture-header]');
    return {header:Math.max(header.getBoundingClientRect().bottom,...[...header.querySelectorAll('[data-tab-linked-files]')].map(chip=>chip.getBoundingClientRect().bottom)),
      preview:document.querySelector('[data-file-preview-root]').getBoundingClientRect().top};
  });
  assert.equal(bounds.preview,bounds.header);check('FilePreview starts below the visual header edge, preserving absolute-chip access');
  await page.screenshot({path:path.join(artifact,'selected.png')});check('exact owner+file selection and existing FilePreview; internal row does not pin');
  await page.locator('[data-file-preview-root]').getByRole('button',{name:'Close file preview'}).click();
  assert.equal(await page.evaluate(()=>window.linkedFixture.preview()),null);
  assert.equal(await page.locator('[data-chip-shown="1"]').getAttribute('data-tab-id'),'many');
  check('existing FilePreview close button clears selection and returns to exact owner');
  await page.evaluate(()=>window.linkedFixture.open('many','many-json'));
  await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='many-json');
  await chip('many').locator('[data-linked-file-open]').click({button:'middle'});
  await page.waitForFunction(()=>window.linkedFixture.preview()===null);
  assert.equal(await page.locator('[data-chip-shown="1"]').getAttribute('data-tab-id'),'many');
  assert.ok(await page.evaluate(()=>window.linkedFixture.tabIds().includes('many-json')));
  check('middle click on the file chip closes its reader and returns owner without unlink');
  await page.keyboard.press('Escape');assert.equal(await popup('many').count(),0);
  await chip('many').locator('[data-linked-file-menu-trigger]').click();assert.equal(await popup('many').getAttribute('data-pinned'),'1');
  await chip('many').locator('[data-linked-file-menu-trigger]').click();await frames();assert.equal(await popup('many').count(),0);
  await chip('many').hover();await frames();assert.equal(await popup('many').count(),0);
  await chip('many').locator('[data-linked-file-menu-trigger]').click();assert.equal(await popup('many').getAttribute('data-pinned'),'1');
  check('second menu-trigger click dismisses without hover reopening or timer');
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
  await chip('many').locator('[data-linked-file-menu-trigger]').click();await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  const menu=page.locator('[data-tab-context-menu]');await menu.waitFor();
  for(const action of ['copy-file-path','reveal-file','copy-file-content','unlink-file','delete-file']) assert.equal(await menu.locator('[data-tab-context-action="'+action+'"]').count(),1);
  await page.keyboard.press('Escape');assert.equal(await menu.count(),0);
  assert.ok(await page.evaluate(()=>window.linkedFixture.tabIds().includes('many-md')));
  await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  check('Escape cancels the exact file context menu before any destructive action');
  await menu.locator('[data-tab-context-action="copy-file-path"]').click();assert.equal(await page.evaluate(()=>window.linkedFixture.clipboard),'/same.md');
  await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  await menu.locator('[data-tab-context-action="reveal-file"]').click();assert.equal(await page.evaluate(()=>window.linkedFixture.finder),'/same.md');
  await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'right'});
  await menu.locator('[data-tab-context-action="copy-file-content"]').click();assert.match(await page.evaluate(()=>window.linkedFixture.clipboard),/Synthetic document/);
  check('Copy Path, Finder and Copy Content use exact file; OS integrations mocked');
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.open('many','many-md'));
  await chip('many').locator('[data-linked-file-menu-trigger]').click();
  await popup('many').locator('[data-linked-file-id="many-md"]').click({button:'middle'});
  await page.waitForFunction(()=>window.linkedFixture.preview()===null);
  assert.ok(await page.evaluate(()=>window.linkedFixture.tabIds().includes('many-md')));
  assert.match(await chip('many').innerText(),/same\.md\s*\+2/);
  assert.equal(await popup('many').locator('[data-linked-file-id="many-md"]').getAttribute('data-file-window-state'),'shown');
  check('middle click on popup row opens a separate file window and retains link, filename and +N; no disk deletion');
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.split(true));await frames();
  await page.evaluate(()=>window.linkedFixture.open('many','many-json'));await frames();
  const paneBounds=await page.evaluate(()=>{
    const r=document.querySelector('[data-file-preview-root]').getBoundingClientRect(),
      header=document.querySelector('[data-fixture-header]').getBoundingClientRect();
    const chipBottoms=[...document.querySelectorAll('[data-fixture-header] [data-tab-linked-files]')].map(chip=>chip.getBoundingClientRect().bottom);
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,headerBottom:Math.max(header.bottom,...chipBottoms)};
  });
  assert.equal(paneBounds.left,100);assert.equal(paneBounds.right,430);assert.equal(paneBounds.bottom,460);
  assert.equal(paneBounds.top,paneBounds.headerBottom);result.paneBounds=paneBounds;
  const toolbar=await page.locator('[data-file-preview-root]').evaluate(root=>{
    const header=root.firstElementChild, title=header.firstElementChild.getBoundingClientRect(),
      actions=header.lastElementChild.getBoundingClientRect(), bounds=root.getBoundingClientRect();
    return {titleRight:title.right,actionsLeft:actions.left,height:header.getBoundingClientRect().height,
      buttonsFit:[...header.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=bounds.right)};
  });
  assert.ok(toolbar.titleRight<=toolbar.actionsLeft);assert.equal(toolbar.height,30);assert.ok(toolbar.buttonsFit);
  check('compact FilePreview toolbar fits one row inside narrow owner pane without title overlap');
  await page.screenshot({path:path.join(artifact,'pane-preview.png')});check('reader stays inside exact owning pane below wrapped header');
  await page.evaluate(()=>{window.linkedFixture.close();window.linkedFixture.split(false);});await frames();
  await chip('long').hover();await popup('long').waitFor();
  await popup('long').locator('[data-linked-file-id="long-second"]').click();
  await page.waitForFunction(()=>window.linkedFixture.preview()?.sourceTabId==='long-second');
  await page.mouse.move(700,8);await frames();assert.equal(await popup('long').count(),0);
  await chip('long').hover();await popup('long').waitFor();
  check('a last-row chip remains reachable after its preview opens; strip layout height stays independent');
  await page.evaluate(()=>window.linkedFixture.close());
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.bottom(true));await frames();
  await chip('long').hover();await popup('long').waitFor();await frames();
  const long=await popup('long').evaluate(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,flipped:n.dataset.flipped,width:r.width};});
  assert.equal(long.flipped,'1');assert.ok(long.left>=8&&long.right<=792&&long.top>=8&&long.bottom<=552);
  await page.screenshot({path:path.join(artifact,'flipped-long-name.png')});result.long=long;check('pathological name clamped; bottom-edge flip');
  await page.keyboard.press('Escape');await page.evaluate(()=>{window.linkedFixture.bottom(false);window.linkedFixture.geometry(22,7);});await frames();
  await chip('many').hover();await frames();assert.equal(await popup('many').evaluate(n=>getComputedStyle(n).fontSize),'22px');
  await popup('many').locator('[data-linked-file-id]').first().hover();await frames();
  const lane=await page.locator('[data-tab-card="many"]').first().evaluate(n=>({
    taskCount:n.querySelectorAll('[data-task-plan-tab-markers]').length,
    cardBottom:n.getBoundingClientRect().bottom,
    fileBottom:n.querySelector('[data-tab-linked-files]').getBoundingClientRect().bottom,
    fileTop:n.querySelector('[data-tab-linked-files]').getBoundingClientRect().top,
    fileHeight:n.querySelector('[data-tab-linked-files]').getBoundingClientRect().height}));
  assert.equal(lane.taskCount,0);assert.ok(lane.cardBottom-lane.fileTop>lane.fileBottom-lane.cardBottom);
  assert.ok(Math.abs(lane.fileBottom-lane.cardBottom-5)<.06);
  assert.ok(lane.fileHeight>=20);result.largeFontLane=lane;
  assert.equal(await popup('many').locator('[data-linked-file-id]').first().evaluate(n=>getComputedStyle(n).padding),'7px 6px');
  await page.screenshot({path:path.join(artifact,'large-font.png')});check('configured font and sidebar row padding preserved; popup frame remains compact');
  await page.keyboard.press('Escape');await page.evaluate(()=>window.linkedFixture.navigateMode(true));await frames();
  const navigateChip=chip('many');await navigateChip.hover();await frames();
  assert.equal(await popup('many').count(),0);
  assert.equal(await navigateChip.evaluate(node=>getComputedStyle(node).transform),'none');
  await navigateChip.locator('[data-linked-file-more]').click();
  assert.equal(await page.evaluate(()=>window.linkedFixture.navigateFile.id),'many-json');
  assert.equal(await page.evaluate(()=>window.linkedFixture.ownerClicks || 0),0);
  await navigateChip.click({button:'right'});assert.equal(await page.locator('[data-tab-context-menu]').count(),0);
  check('navigate surface has exact MRU click only: no nested hover, scale, context menu or parent click');
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
  }
  assert.deepEqual(await page.evaluate(()=>window.linkedFixture.violations),[]);
  assert.deepEqual(result.errors,[]);result.pass=true;
  }
} catch(error){result.errors.push(error.stack||String(error));process.exitCode=1;}
finally{if(app)await app.close();await fs.rm(path.join(artifact,'user-data'),{recursive:true,force:true});result.privateProfileRemoved=true;
  if(result.electronPid){try{process.kill(result.electronPid,0);result.privatePidStopped=false;}catch{result.privatePidStopped=true;}}
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));}
