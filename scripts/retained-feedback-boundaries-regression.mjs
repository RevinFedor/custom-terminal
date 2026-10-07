#!/usr/bin/env node
// Actual sidebar/Home boundaries and indicator declarations, frozen source.
// Private Electron only. Same retained tree, serial old/product CSS arms.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import ts from 'typescript';
import postcss from 'postcss';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-retained-feedback-'));
const snapshot = path.join(artifact, 'source');
const sha = value => createHash('sha256').update(value).digest('hex');
const result = { artifact, sourceHashes: {}, samples: [], checks: [], errors: [], cleanup: {},
  boundary: 'Actual PersistentTabSidebarStack and WorkspacePresentationBoundary; actual extracted indicators; synthetic store, row bodies and retained topology. No production API, PTY/provider or OS focus.' };
let app;
const check = (name, value, evidence) => { result.checks.push({ name, pass: !!value, evidence }); assert.ok(value, name); };
function declaration(source, name) {
  const ast = ts.createSourceFile(name + '.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const node of ast.statements) if (node.name?.text === name || ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(ast) === name)) return node.getText(ast);
  throw Error('missing actual declaration ' + name);
}
try {
  await fs.cp(path.join(repo, 'src/renderer'), path.join(snapshot, 'renderer'), { recursive: true });
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const read = async file => {
    const data = await fs.readFile(path.join(snapshot, 'renderer', file), 'utf8');
    result.sourceHashes['src/renderer/' + file] = sha(data); return data;
  };
  const globals = await read('styles/globals.css');
  const gate = await read('styles/presentationAnimations.css');
  const before = gate.replaceAll(/,\n  \[data-tab-sidebar-layer\]\[data-sidebar-presented="0"\],\n  \[data-workspace-presentation\]\[aria-hidden="true"\]/g, '');
  assert.notEqual(before, gate, 'control removes only the two new boundary selectors');
  await fs.writeFile(path.join(artifact, 'before.css'), before);
  await fs.writeFile(path.join(artifact, 'product.css'), gate);
  result.controlHash = sha(before); result.productHash = sha(gate);
  const css = postcss.parse(globals).nodes.filter(n => n.type === 'atrule' && ['keyframes', 'property'].includes(n.name)
    || n.type === 'rule' && /\.(tab-process-bar|tab-awaiting|tab-completion-notification|noted-shape-ring|animate-glow)/.test(n.selector)).map(n => n.toString()).join('\n');
  await fs.writeFile(path.join(artifact, 'indicators.css'), css);
  const signals = await read('components/Workspace/TabSignals.tsx');
  await fs.writeFile(path.join(snapshot, 'Signals.tsx'), `import React from 'react';
import {useUIStore} from './stores';
${['TAB_PROCESS_BAR_W_PX', 'TabProcessBarProps', 'TabProcessBar'].map(name => declaration(signals, name)).join('\n')}`);
  await fs.writeFile(path.join(snapshot, 'stores.ts'), `import{create}from'zustand';
export const useUIStore=create(()=>({tabSidebarWidth:210,processBar:{position:'right'},setActiveArea(){},setTabSidebarWidth(){}}));
export const useWorkspaceStore=create(()=>({openProjects:new Map(['a','b','c','d'].map(id=>[id,{activeTabId:id,projectPath:'/private-fixture'}])),
splitPanes:[],splitFocusedIndex:0,focusedProjectId:'a',activeProjectId:'a',activeSpaceId:'one'}));`);
  await fs.writeFile(path.join(snapshot, 'SidebarBody.tsx'), `import React from 'react';export default function Body({projectId}){return window.sidebarBody(projectId)}`);
  await fs.writeFile(path.join(snapshot, 'Location.tsx'), `import React from 'react';export const TabLocationLine=()=> <span>Private fixture</span>;`);
  await fs.writeFile(path.join(snapshot, 'fixture.tsx'), `import React,{memo,useState}from'react';import{createRoot}from'react-dom/client';
import Boundary from './renderer/components/Workspace/WorkspacePresentationBoundary';
import{PersistentTabSidebarStack}from'./renderer/components/Workspace/TabSidebar';
import{completeStartupRestore}from'./renderer/utils/startupRestoreProgress.mjs';
import{TabProcessBar}from'./Signals';
const ids=['a','b','c','d'], maps=new Map();window.ends=[];window.trusted=[];
for(const type of ['click','wheel','keydown'])document.addEventListener(type,e=>window.trusted.push({type,trusted:e.isTrusted}),true);
function Indicators({id}){return <div data-feedback={id}>
 {Array.from({length:5},(_,i)=><span className="chip" key={i}>Busy {i}<TabProcessBar hasProcess busy inheritedBusy={i===1} radius={5}/></span>)}
 <span className="chip">Waiting<span className="tab-awaiting-input ring"/></span>
 <span className="chip">Notification<span className="tab-completion-notification-alert ring"/></span>
 <span className="chip">Shape<span className="noted-shape-ring ring"/></span>
 <span className="chip animate-glow-yellow">Active glow</span>
 <span className="chip">Dismiss<span data-dismiss={id} className="tab-completion-notification-alert ring"
 onAnimationEnd={e=>{if(e.animationName==='tab-completion-notification-dismiss')window.ends.push(id)}}/></span>
 </div>}
window.sidebarBody=id=><><Indicators id={'sidebar-'+id}/><textarea data-draft={id} defaultValue={'Draft '+id}/></>;
const Retained=memo(()=>Array.from({length:37},(_,i)=><section key={i} data-terminal-pane-wrapper={'owner-'+i}
 data-terminal-surface-presented={i<2?'1':'0'} data-pane-focus-isolated={i<2?'0':'1'} aria-hidden={i>=2}
 style={{position:'absolute',inset:'60px 0 0',width:'50%',left:i%2?'50%':0,opacity:i<2?1:0,willChange:'opacity',pointerEvents:i<2?'auto':'none',zIndex:i<2?1:0}}>
 <div data-history-owner={i} data-history-presented="1"><Indicators id={'pane-'+i}/><textarea defaultValue={'Unsent '+i}/>
 <div className="scroller">{Array.from({length:125},(_,j)=><article key={j}><p>Retained message {j}<b> stable text</b></p>
 <ul><li>first <code>task</code></li><li>second <em>result</em></li></ul><pre><code>const value = await work();</code></pre><span>Saved response</span></article>)}</div></div>
 </section>));
function App(){const[view,setView]=useState('workspace'),[selected,setSelected]=useState('a');
 window.fixture={setView,setSelected};return <><nav><button id="home" onClick={()=>setView(v=>v==='workspace'?'dashboard':'workspace')}>Home</button>
 {ids.map(id=><button key={id} id={'select-'+id} onClick={()=>setSelected(id)}>{id}</button>)}</nav>
 {view==='dashboard'&&<div className="dashboard"><input id="home-input" placeholder="Home input"/></div>}
 <Boundary view={view}><PersistentTabSidebarStack projectIds={ids} presentedProjectId={selected} processStatus={maps} busyTabs={maps} pasteBusyTabs={maps}/>
 <main><Retained/></main></Boundary></>}
createRoot(document.getElementById('root')).render(<App/>);completeStartupRestore({delayMs:0});`);
  const boundaryPaths = ['components/Workspace/TabSidebar.tsx', 'components/Workspace/WorkspacePresentationBoundary.tsx'];
  for (const file of boundaryPaths) await read(file);
  const bundle = await build({ entryPoints: [path.join(snapshot, 'fixture.tsx')], outfile: path.join(artifact, 'bundle.js'), bundle: true,
    platform: 'browser', target: 'chrome120', jsx: 'automatic', sourcemap: true, metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    plugins: [{ name: 'private-stores-only', setup(b) {
      b.onResolve({ filter: /\/store\/use(?:UI|Workspace)Store$/ }, () => ({ path: path.join(snapshot, 'stores.ts') }));
      b.onResolve({ filter: /^\.\/TabBar$/ }, () => ({ path: path.join(snapshot, 'SidebarBody.tsx') }));
      b.onResolve({ filter: /^\.\/TabLocationLine$/ }, () => ({ path: path.join(snapshot, 'Location.tsx') }));
    } }] });
  for (const file of Object.keys(bundle.metafile.inputs)) {
    const resolved = path.resolve(file);
    if (resolved.startsWith(path.join(snapshot, 'renderer') + path.sep)) result.sourceHashes['src/' + path.relative(snapshot, resolved)] = sha(await fs.readFile(resolved));
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="indicators.css">
<link id="old-gate" rel="stylesheet" href="before.css"><link id="new-gate" rel="stylesheet" href="product.css" disabled>
<style>body{margin:0;background:#18181b;color:#ccc;font:14px sans-serif}nav{height:38px;position:relative;z-index:1000}
[data-workspace-presentation]{display:flex;height:700px;width:1200px}main{position:relative;flex:1;min-width:0;overflow:hidden}
[data-tab-sidebar]{height:100%;position:relative;display:flex;flex-direction:column}.chip{display:inline-block;position:relative;margin:4px;height:27px;line-height:27px;min-width:80px;border-radius:5px;background:#333}
.ring{position:absolute;inset:0;border-radius:5px}.scroller{height:460px;overflow:auto}textarea{width:170px;height:35px;background:#222;color:#ccc}
.dashboard{position:absolute;inset:38px 0 0;background:#252525}button,input{font:inherit}article{padding:4px}p{margin:2px}</style>
<div id="root"></div><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact, 'profile'))});app.setActivationPolicy?.('accessory');
global.calls=[];ipcMain.handle('fixture:invoke',(_e,channel)=>{global.calls.push(channel);return null});
app.whenReady().then(()=>{app.dock?.hide();global.win=new BrowserWindow({show:false,focusable:false,width:1200,height:760,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});
win.webContents.on('paint',()=>{});win.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  result.pid = app.process().pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-sidebar-layer]').length === 4);
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
  await page.evaluate(() => {
    window.boundaryEvents = [];
    window.eventObserver = new PerformanceObserver(list => {
      for (const e of list.getEntries()) if (e.name === 'click') window.boundaryEvents.push({
        target: e.target?.id || null, startTime: e.startTime, duration: e.duration,
        inputMs: e.processingStart - e.startTime, scriptMs: e.processingEnd - e.processingStart,
        presentationMs: e.startTime + e.duration - e.processingEnd,
      });
    });
    window.eventObserver.observe({ type: 'event', durationThreshold: 16, buffered: true });
  });
  const animations = () => page.evaluate(() => {
    const by = {}, all = document.getAnimations();
    for (const a of all) {
      const el = a.effect.target, surface = el.closest('[data-tab-sidebar-layer]')?.dataset.tabSidebarLayer || el.closest('[data-feedback]')?.dataset.feedback || 'other';
      const entry = by[surface] ||= { running: 0, paused: 0, hiddenRunning: 0, names: [] };
      if (a.playState in entry) entry[a.playState]++;
      const hidden = el.closest('[data-sidebar-presented="0"],[data-terminal-surface-presented="0"],[data-workspace-presentation="dashboard"]');
      if (hidden && a.playState === 'running') entry.hiddenRunning++;
      if (!entry.names.includes(a.animationName)) entry.names.push(a.animationName);
    }
    return { count: all.length, nodes: document.querySelectorAll('*').length, by };
  });
  const selectArm = async arm => {
    await page.evaluate(arm => { document.querySelector('#old-gate').disabled = arm !== 'old'; document.querySelector('#new-gate').disabled = arm !== 'product'; }, arm);
    await page.waitForTimeout(450);
  };
  const measure = async (arm, view) => {
    await selectArm(arm);
    if (await page.getAttribute('[data-workspace-presentation]', 'data-workspace-presentation') !== view) await page.locator('#home').click();
    await page.waitForTimeout(450); const state = await animations();
    await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordContinuously', includedCategories: ['toplevel', 'devtools.timeline', 'blink', 'cc'] } });
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    await page.waitForTimeout(1800);
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end');
    const { stream } = await done; let raw = '';
    try { for (;;) { const part = await cdp.send('IO.read', { handle: stream, size: 1048576 }); raw += part.data; if (part.eof) break; } }
    finally { await cdp.send('IO.close', { handle: stream }); }
    const events = JSON.parse(raw).traceEvents;
    const thread = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain'); const totals = {};
    for (const e of events) if (e.pid === thread.pid && e.tid === thread.tid && e.ph === 'X' && /Paint|Layer|Lifecycle|Animation/.test(e.name)) {
      const row = totals[e.name] ||= { count: 0, ms: 0 }; row.count++; row.ms += (e.dur || 0) / 1000;
    }
    const sample = { arm, view, state, nestedDoNotSum: totals, threadMs: (after.ThreadTime - before.ThreadTime) * 1000, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000 };
    result.samples.push(sample); await fs.writeFile(path.join(artifact, arm + '-' + view + '.trace.json'), raw);
    console.log(JSON.stringify({ arm, view, nodes: state.nodes, hiddenRunning: Object.values(state.by).reduce((n, r) => n + r.hiddenRunning, 0), threadMs: sample.threadMs, lifecycle: totals['LocalFrameView::RunPaintLifecyclePhase'] }));
  };
  await page.evaluate(() => { window.kept = [...document.querySelectorAll('[data-tab-sidebar-layer],section,textarea,.scroller')]; document.querySelector('.scroller').scrollTop = 240; document.querySelector('textarea').value = 'Unsent preserved'; });
  for (const [arm, view] of [['old', 'workspace'], ['product', 'workspace'], ['old', 'dashboard'], ['product', 'dashboard']]) await measure(arm, view);
  const sum = (s, key) => Object.values(s.state.by).reduce((n, r) => n + r[key], 0);
  check('old exact boundaries reproduce hidden running feedback', sum(result.samples[0], 'hiddenRunning') > 0 && sum(result.samples[2], 'hiddenRunning') > 0);
  check('product pauses every externally hidden owner', sum(result.samples[1], 'hiddenRunning') === 0 && sum(result.samples[3], 'running') === 0);
  check('both visible panes and sidebar keep feedback', ['a', 'pane-0', 'pane-1'].every(k => result.samples[1].state.by[k]?.running > 0));
  await page.locator('#home').click(); await page.locator('#select-b').click();
  let state = await animations(); check('trusted sidebar switch resumes only selected surface', state.by.b.running > 0 && state.by.a.running === 0);
  await page.locator('#home').click();
  await page.evaluate(() => document.querySelector('[data-dismiss="sidebar-a"]').classList.add('tab-completion-notification-alert--dismiss'));
  await page.waitForFunction(() => window.ends.includes('sidebar-a'));
  check('finite hidden dismiss completes', await page.evaluate(() => window.ends.filter(x => x === 'sidebar-a').length === 1));
  await page.locator('#home-input').fill('Visible Home draft'); await page.locator('#home').click(); await page.locator('#select-a').click();
  check('owners drafts and scroll survive Home and sidebar round trips', await page.evaluate(() => window.kept.every(node => node.isConnected)
    && document.querySelector('.scroller').scrollTop === 240 && document.querySelector('textarea').value === 'Unsent preserved'));
  await page.locator('section textarea').first().fill('Visible owner input');
  await page.locator('.scroller').first().hover(); await page.mouse.wheel(0, 150);
  await page.waitForFunction(() => document.querySelector('.scroller').scrollTop > 240);
  check('visible input and wheel remain live', await page.evaluate(() => document.querySelector('section textarea').value === 'Visible owner input' && window.trusted.every(e => e.trusted)));
  result.switches = [];
  for (const arm of ['old', 'product']) {
    await selectArm(arm);
    const eventsFrom = await page.evaluate(() => window.boundaryEvents.length);
    for (let i = 0; i < 8; i++) {
      const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      await page.locator('#home').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      result.switches.push({ arm, view: await page.getAttribute('[data-workspace-presentation]', 'data-workspace-presentation'),
        threadMs: (after.ThreadTime - before.ThreadTime) * 1000,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000 });
    }
    await page.waitForTimeout(120);
    result[arm + 'Events'] = await page.evaluate(from => window.boundaryEvents.slice(from), eventsFrom);
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const switchStyle = arm => median(result.switches.filter(s => s.arm === arm).map(s => s.styleMs));
  check('exact owner selectors avoid a new whole-tree restyle stall', switchStyle('product') < switchStyle('old') + 20,
    { oldStyleMs: switchStyle('old'), productStyleMs: switchStyle('product'), eventTimingLimit: '16ms reporting floor; temporal metrics, not an installed latency claim' });
  await page.screenshot({ path: path.join(artifact, 'workspace.png') });
  check('no renderer errors', result.errors.length === 0, result.errors);
  result.status = 'pass';
} catch (error) { result.status = 'failed'; result.error = String(error.stack || error); process.exitCode = 1; }
finally {
  if (app) { await app.close(); result.cleanup.closed = true; }
  await fs.rm(path.join(artifact, 'profile'), { recursive: true, force: true });
  await fs.rm(snapshot, { recursive: true, force: true });
  result.cleanup.sourceAndProfileRemoved = true;
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, checks: result.checks.length, error: result.error }));
}
