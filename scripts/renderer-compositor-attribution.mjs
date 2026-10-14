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
import ts from 'typescript';
import { createHash } from 'node:crypto';
const ownerCount=Number(process.argv.find(a=>a.startsWith('--owners='))?.slice(9)||6);
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-compositor-components-'));
const snapshot = path.join(artifact, 'source');
await fs.mkdir(snapshot);
let app;
const result = { artifact, samples: [], checks: [], errors: [], pass: false };
const logs = [];
const { historyVirtuosoMeasurementEsbuildPlugin } = await import('./lib/history-virtuoso-measurement.mjs');
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/renderer-compositor-attribution.tsx'), path.join(snapshot, 'scripts/fixtures/renderer-compositor-attribution.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', n), path.join(shared, n),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  if (process.env.NOTED_WORKFLOW_BASELINE_GATE) await fs.copyFile(process.env.NOTED_WORKFLOW_BASELINE_GATE,
    path.join(snapshot, 'src/renderer/styles/presentationAnimations.css'));
  const iconSource=await fs.readFile(path.join(snapshot,'src/renderer/components/Workspace/OrchestrationStatusChip.tsx'),'utf8');
  const iconAst=ts.createSourceFile('icons.tsx',iconSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const iconDecl=iconAst.statements.find(n=>n.name?.text==='StatusIcon');assert.ok(iconDecl);
  const baselineStatus=process.argv.find(a=>a.startsWith('--baseline-status='))?.slice('--baseline-status='.length);assert.ok(baselineStatus);
  const oldIconSource=await fs.readFile(baselineStatus,'utf8'),oldAst=ts.createSourceFile('old.tsx',oldIconSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const oldIconDecl=oldAst.statements.find(n=>n.name?.text==='StatusIcon');assert.ok(oldIconDecl);
  await fs.writeFile(path.join(snapshot,'scripts/fixtures/ActualStatusIcon.tsx'),`import React from 'react';import{CircleAlert,CircleCheck,Search,Timer,X,LoaderCircle}from'lucide-react';
import{RequestTrackerStatus}from'../../src/renderer/components/Workspace/RequestTrackerRow';
export ${iconDecl.getText(iconAst)}\nexport ${oldIconDecl.getText(oldAst).replace('function StatusIcon(', 'function OldStatusIcon(')}`);
  const bundle=await build({ metafile:true, plugins: [historyVirtuosoMeasurementEsbuildPlugin()], sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/renderer-compositor-attribution.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const canonicalSnapshot=await fs.realpath(snapshot);
  result.sourceHashes={};
  for(const file of Object.keys(bundle.metafile.inputs)){
    if(file.startsWith('<'))continue;
    const absolute=await fs.realpath(path.resolve(file));
    if(absolute.startsWith(canonicalSnapshot+path.sep))result.sourceHashes[path.relative(canonicalSnapshot,absolute)]=createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
  }
  assert.ok(Object.keys(result.sourceHashes).length>100,'actual component inputs, not only extracted indicator');
  result.iconSourceHash=createHash('sha256').update(iconSource).digest('hex');
  result.baselineIconSourceHash=createHash('sha256').update(oldIconSource).digest('hex');
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
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script>(${installShim.toString()})();window.__fixtureOwnerCount=${ownerCount}</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
      const w=new BrowserWindow({show:false,focusable:false,width:1600,height:1000,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.pid=app.process().pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message)); page.on('console', m => logs.push(m.text()));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('[data-space-chip="cost-main"]').waitFor();
  await page.locator('[data-history-composer-tab-id="workflow-cost-tab-0"]').waitFor();
  await page.locator('[data-history-row-real]').first().waitFor();
  await page.locator('[data-space-chip="cost-other"]').click();
  await page.locator('[data-history-composer-tab-id="workflow-cost-tab-4"]').waitFor();
  for(const chip of await page.locator('[data-space-chip^="cost-extra-"]').all()){await chip.click();await frames();}
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
  await cdp.send('LayerTree.enable');
  let lastLayers=[];const onLayers=e=>lastLayers=e.layers||[];cdp.on('LayerTree.layerTreeDidChange',onLayers);
  await frames();await page.waitForTimeout(100);
  result.layers=lastLayers.map(l=>({id:l.layerId,node:l.backendNodeId,w:l.width,h:l.height,paintCount:l.paintCount,draws:l.drawsContent}));
  result.layerReasons=[];for(const layer of lastLayers.slice(0,100))result.layerReasons.push({id:layer.layerId,node:layer.backendNodeId,...await cdp.send('LayerTree.compositingReasons',{layerId:layer.layerId}).catch(()=>({unavailable:true}))});
  await cdp.send('LayerTree.disable');cdp.off('LayerTree.layerTreeDidChange',onLayers);
  const controls = [
    ['before-svg', 'old', ''],
    ['paused-svg-control', 'old', '#status-fixture svg{animation-play-state:paused!important}'],
    ['product-html', 'product', ''],
    ['before-svg-return', 'old', ''],
    ['product-html-return', 'product', ''],
  ];
  for (const [name, arm, css] of controls) {
    await page.evaluate(arm=>window.setSpinnerArm(arm),arm);
    await page.evaluate(css=>{let el=document.getElementById('attribution-control');if(!el){el=document.createElement('style');el.id='attribution-control';document.head.appendChild(el)}el.textContent=css},css);
    await page.waitForTimeout(550);
    const animations=await page.evaluate(()=>document.getAnimations().map(a=>({name:a.animationName,state:a.playState,target:a.effect?.target?.tagName,classes:a.effect?.target?.getAttribute('class'),owner:a.effect?.target?.closest('[data-terminal-pane-wrapper]')?.getAttribute('data-terminal-pane-wrapper')})));
    await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordContinuously',includedCategories:['toplevel','devtools.timeline','blink','cc','disabled-by-default-devtools.timeline.invalidationTracking']}});
    const before=await cdp.send('Performance.getMetrics');await page.waitForTimeout(1800);const after=await cdp.send('Performance.getMetrics');
    const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const{stream}=await done;let raw='';
    try{for(;;){const p=await cdp.send('IO.read',{handle:stream,size:1048576});raw+=p.base64Encoded?Buffer.from(p.data,'base64').toString('utf8'):p.data;if(p.eof)break}}finally{await cdp.send('IO.close',{handle:stream})}
    await fs.writeFile(path.join(artifact,name+'.trace.json'),raw);const events=JSON.parse(raw).traceEvents;
    const main=events.find(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain'),totals={};
    for(const e of events)if(e.pid===main.pid&&e.tid===main.tid&&e.ph==='X'&&/Paint|Layer|Lifecycle|Frame|Layout|Style|Animation/.test(e.name)){const row=totals[e.name]||={count:0,ms:0,max:0};row.count++;row.ms+=(e.dur||0)/1000;row.max=Math.max(row.max,(e.dur||0)/1000)}
    const metrics=Object.fromEntries(after.metrics.filter(m=>['ThreadTime','TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].includes(m.name)).map(m=>[m.name,1000*(m.value-before.metrics.find(b=>b.name===m.name).value)]));
    result.samples.push({name,animations,metrics,nestedDoNotSum:totals});console.log(JSON.stringify({name,metrics,layerize:totals.Layerize,paint:totals.Paint,prepaint:totals.PrePaint}));
  }
  result.state=await page.evaluate(()=>({reads:window.workflowFixture.reads,violations:window.workflowFixture.violations,unknown:[...new Set(window.workflowFixture.unknown)]}));
  result.retention=await page.evaluate(()=>{
    const wrapper=document.querySelector('[data-terminal-pane-wrapper="workflow-cost-tab-0"]');
    const scroll=wrapper.querySelector('[data-testid="virtuoso-scroller"]');
    return{sameOwner:wrapper===window.savedCostOwner,sameScroller:scroll===window.savedCostScroller,
      sameRow:window.savedCostRow?.isConnected,top:scroll.scrollTop,
      offset:window.savedCostRow.getBoundingClientRect().top-scroll.getBoundingClientRect().top,
      draft:wrapper.querySelector('.cm-content')?.textContent};
  });
  assert.ok(result.retention.sameOwner&&result.retention.sameScroller&&result.retention.sameRow);
  assert.ok(Math.abs(result.retention.top-result.readingBefore.scrollTop)<1&&Math.abs(result.retention.offset-result.readingBefore.offset)<1);
  assert.equal(result.retention.draft,'kept draft');assert.equal(result.state.reads,result.readsBefore);
  result.checks.push('same actual owner, scroller, reading row, offset and draft through all arms; no History reread');
  await page.evaluate(()=>{window.inputEvidence=[];window.inputObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())if(e.interactionId)window.inputEvidence.push({event:e.name,id:e.interactionId,ms:e.duration,inputMs:e.processingStart-e.startTime,handlerMs:e.processingEnd-e.processingStart,presentationMs:e.startTime+e.duration-e.processingEnd})});window.inputObserver.observe({type:'event',durationThreshold:16,buffered:false})});
  result.inputPairs=[];
  for(const arm of ['old','product']){
    await page.evaluate(arm=>window.setSpinnerArm(arm),arm);
    const from=await page.evaluate(()=>window.inputEvidence.length);
    await composer.click();await composer.press('Meta+A');await composer.press('Backspace');
    await composer.pressSequentially('retained-input');await frames();await page.waitForTimeout(100);
    const evidence=await page.evaluate(from=>({events:window.inputEvidence.slice(from),text:document.querySelector('[data-history-composer-tab-id="workflow-cost-tab-0"] .cm-content').textContent}),from);
    assert.equal(evidence.text,'retained-input');result.inputPairs.push({arm,...evidence});
  }
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.state.violations,[]);
  result.checks.push('trusted actual History input retained in both arms; EventTiming floor16ms, no inference for absent events');
  await page.screenshot({path:path.join(artifact,'actual.png')});
  result.pass = true;
} catch (error) { result.failure = String(error); process.exitCode = 1; }
finally {
  if (app) await app.close();
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.copyFile(path.join(snapshot, 'src/renderer/components/Workspace/HistoryPanel.tsx'), path.join(artifact, 'HistoryPanel.snapshot.tsx'));
  await fs.rm(snapshot,{recursive:true,force:true});
  await fs.rm(path.join(artifact,'user-data'),{recursive:true,force:true});
  result.cleanup={electronClosed:true,sourceSnapshotRemoved:true,profileRemoved:true};await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
}
console.log(JSON.stringify({artifact,pass:result.pass,failure:result.failure,nodes:result.nodes,errors:result.errors,state:result.state}));
