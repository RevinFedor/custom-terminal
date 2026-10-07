#!/usr/bin/env node
// Bounded native-paint attribution fixture. Only this script and TMPDIR outputs
// change. Exact extracted TabProcessBar / History tail / spinner, actual shared
// conversation shells and terminal icon, exact authored CSS, synthetic content.
// No full app, IPC, API, PTY, production CDP, Git or global input. All A/Bs share
// one frozen bundle and one mounted tree. --suite=prototype adds PRIVATE CSS.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import ts from 'typescript';
import postcss from 'postcss';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('..', import.meta.url));
const arg = (key, fallback) => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3) ?? fallback;
const durationMs = Number(arg('duration-ms', 1800));
const owners = Number(arg('owners', 37)), rows = Number(arg('rows', 100));
const suite = arg('suite', 'isolate');
const sourceRoot = arg('source-root', repo);
const visualPhases = JSON.parse(arg('phases', '[0,0.25,0.5,0.75,0.999]'));
const baselineRoot = arg('baseline-root', '');
const compiledCssPath = arg('compiled-css', '');
const fullMatrix = arg('matrix', 'basic') === 'full';
assert.ok(durationMs >= 1000 && owners >= 1 && rows >= 1);
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-recurring-paint-'));
const snapshot = path.join(artifact, 'source'); await fs.mkdir(snapshot);
const result = { artifact, suite, durationMs, owners, rows, sourceHashes: {}, extracts: {}, samples: [], checks: [], errors: [], cleanup: {},
  boundary: 'Actual extracted presentation components and CSS; shared message shells with synthetic retained rows, opacity owners and titlebar app-region. Not full History lifecycle or installed workload.' };
const hash = text => createHash('sha256').update(text).digest('hex');
async function freeze(file, name) {
  let text;
  try { text = await fs.readFile(path.join(file.startsWith('scripts/') ? repo : sourceRoot, file), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT' || sourceRoot === repo) throw error; text = await fs.readFile(path.join(repo, file), 'utf8'); }
  result.sourceHashes[file] = hash(text);
  await fs.writeFile(path.join(snapshot, name), text);
  return text;
}
function node(source, name) {
  const ast = ts.createSourceFile(name + '.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  for (const statement of ast.statements) {
    if (statement.name?.text === name || ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(d => d.name.getText(ast) === name)) found = statement.getText(ast);
  }
  assert.ok(found, 'exact declaration ' + name);
  result.extracts[name] = hash(found); return found;
}
function scopeCss(css, arm, legacy = false) {
  const parsed = postcss.parse(css), names = new Map();
  if (legacy) parsed.walkAtRules('keyframes', rule => {
    const name = rule.params; names.set(name, 'r04-legacy-' + name); rule.params = names.get(name);
  });
  parsed.walkDecls(decl => {
    if (legacy && /^animation(?:-name)?$/.test(decl.prop)) for (const [name, replacement] of names) {
      // CSS identifiers include '-': a later bare "spin" key must not rename
      // the suffix of an already-prefixed "tab-awaiting-spin" identifier.
      decl.value = decl.value.replace(new RegExp('(?<![\\w-])' + name + '(?![\\w-])', 'g'), replacement);
    }
  });
  parsed.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    rule.selector = rule.selectors.map(selector => '[data-r04-arm="' + arm + '"] ' + selector).join(',');
  });
  return parsed.toString();
}
function historyCss(source) {
  const start = source.indexOf('const historyPanelStyleText = `') + 'const historyPanelStyleText = `'.length;
  const end = source.indexOf('`;', start), ratio = source.match(/const HISTORY_SERVICE_TEXT_RATIO = ([0-9.]+);/);
  assert.ok(start > 30 && end > start && ratio);
  return source.slice(start, end).replaceAll('${HISTORY_SERVICE_TEXT_RATIO}', ratio[1]);
}
let app;
try {
  const globals = await freeze('src/renderer/styles/globals.css', 'globals.source.css');
  const history = await freeze('src/renderer/components/Workspace/HistoryPanel.tsx', 'HistoryPanel.source.tsx');
  const signals = await freeze('src/renderer/components/Workspace/TabSignals.tsx', 'TabSignals.source.tsx');
  await freeze('src/renderer/components/Workspace/TerminalArea.tsx', 'TerminalArea.source.tsx');
  await freeze('src/renderer/styles/presentationAnimations.css', 'gate.css');
  await freeze('src/renderer/utils/historyResponseTiming.mjs', 'historyResponseTiming.mjs');
  await freeze('packages/claude-blocks/src/components/TerminalActivityIcon.tsx', 'TerminalActivityIcon.tsx');
  await freeze('packages/claude-blocks/src/components/ConversationMessage.tsx', 'ConversationMessage.tsx');
  await freeze('packages/claude-blocks/src/blocks.css', 'blocks.css');
  await freeze('scripts/renderer-recurring-paint-regression.mjs', 'driver.mjs');
  const compiledCss = compiledCssPath ? await fs.readFile(compiledCssPath, 'utf8') : null;
  if(compiledCss)result.compiledCss={path:compiledCssPath,sha256:hash(compiledCss)};
  const cssRoot = postcss.parse(compiledCss || globals);
  const authored = cssRoot.nodes.filter(n => (n.type === 'atrule' && ['keyframes', 'property'].includes(n.name))
    || n.type === 'rule' && /\.(tab-process-bar|tab-awaiting|tab-title-naming|tab-completion-notification|noted-shape-ring|animate-glow|cb-run-after-hotkey|noted-text-shimmer)/.test(n.selector)).map(n => n.toString()).join('\n');
  await fs.writeFile(path.join(snapshot, 'indicators.css'), suite === 'acceptance' ? scopeCss(authored, 'product') : authored);
  const hstart = history.indexOf('const historyPanelStyleText = `') + 'const historyPanelStyleText = `'.length;
  const hend = history.indexOf('`;', hstart); assert.ok(hstart > 30 && hend > hstart);
  await fs.writeFile(path.join(snapshot, 'history.css'), suite === 'acceptance' ? scopeCss(historyCss(history), 'product') : historyCss(history));
  for (const name of ['CompositedTextShimmer.tsx', 'compositedTextShimmer.css']) await freeze('src/renderer/components/UI/' + name, name);
  const bar = node(signals, 'TabProcessBar');
  await fs.writeFile(path.join(snapshot, 'TabProcessBar.tsx'), `import React from 'react';
const useUIStore = (pick:any) => pick({processBar:{position:'right'}});
${node(signals, 'TAB_PROCESS_BAR_W_PX')}\n${node(signals, 'TabProcessBarProps')}\n${bar}`);
  await fs.writeFile(path.join(snapshot, 'HistorySignals.tsx'), `import React,{memo,useState,useEffect} from 'react';
import {CompositedTextShimmer} from './CompositedTextShimmer';
import {historyResponseTailLabel,formatHistoryResponseCompletedAt} from './historyResponseTiming.mjs';
${node(history, 'HistoryResponseTailTiming')}\n${node(history, 'HistoryResponseTailTimer')}\n${node(history, 'HistorySpinner')}
export {HistoryResponseTailTimer,HistorySpinner};`);
  if (suite === 'acceptance') {
    assert.ok(baselineRoot, '--baseline-root must contain frozen pre-repair source');
    const oldHistory = await fs.readFile(path.join(baselineRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
    const oldGlobals = await fs.readFile(path.join(baselineRoot, 'src/renderer/styles/globals.css'), 'utf8');
    result.baselineHashes = { HistoryPanel: hash(oldHistory), globals: hash(oldGlobals) };
    const begin = oldHistory.indexOf('const historyPanelStyleText = `') + 'const historyPanelStyleText = `'.length;
    const end = oldHistory.indexOf('`;', begin);
    const oldAuthored = postcss.parse(oldGlobals).nodes.filter(n => n.type === 'atrule' && ['keyframes', 'property'].includes(n.name)
      || n.type === 'rule' && /\.(tab-process-bar|tab-awaiting|tab-title-naming|tab-completion-notification|noted-shape-ring|animate-glow|cb-run-after-hotkey)/.test(n.selector)).map(n => n.toString()).join('\n');
    await fs.writeFile(path.join(snapshot, 'legacy.css'), scopeCss(oldAuthored + '\n' + historyCss(oldHistory), 'baseline', true));
    await fs.writeFile(path.join(snapshot, 'LegacyHistorySignals.tsx'), `import React,{memo,useState,useEffect} from 'react';
import {historyResponseTailLabel,formatHistoryResponseCompletedAt} from './historyResponseTiming.mjs';
${node(oldHistory, 'HistoryResponseTailTiming')}\n${node(oldHistory, 'HistoryResponseTailTimer')}\n${node(oldHistory, 'HistorySpinner').replaceAll('spinner-rotate', 'r04-legacy-spinner-rotate')}
export {HistoryResponseTailTimer,HistorySpinner};`);
  }
  await fs.writeFile(path.join(snapshot, 'fixture.tsx'), `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{TabProcessBar}from'./TabProcessBar';import{HistoryResponseTailTimer,HistorySpinner}from'./HistorySignals';
import{CompositedTextShimmer}from'./CompositedTextShimmer';
${suite === 'acceptance' ? "import{HistoryResponseTailTimer as LegacyTail,HistorySpinner as LegacySpinner}from'./LegacyHistorySignals';" : 'const LegacyTail=HistoryResponseTailTimer,LegacySpinner=HistorySpinner;'}
import{TerminalActivityIcon}from'./TerminalActivityIcon';import{ConversationMessage}from'./ConversationMessage';
const root=createRoot(document.getElementById('fixture'));
const startTs=Date.now()-85000;
let frameLoop=0;
function requestMainThreadFrames(enabled){cancelAnimationFrame(frameLoop);frameLoop=0;
 if(enabled){const next=()=>{frameLoop=requestAnimationFrame(next)};frameLoop=requestAnimationFrame(next)}}
function Indicators({owner,legacy=false}){const Tail=legacy?LegacyTail:HistoryResponseTailTimer,Spin=legacy?LegacySpinner:HistorySpinner;return <div className="fixture-indicators">
 <div data-family="process" className="chip-row">{Array.from({length:12},(_,i)=><span key={i} className="chip" data-process-chip={i}>task {i+1}<TabProcessBar hasProcess busy inheritedBusy={i===2} radius={5}/></span>)}</div>
 <div className="indicator-line"><div data-family="tail"><Tail timing={{state:'running',startTs,intervalId:owner,endTs:null,durationMs:null}}/></div>
 <span data-family="terminal"><TerminalActivityIcon busy color="#d97706"/></span><span data-family="spinner"><Spin size={18}/></span>
 <span data-family="naming" className="chip"><span className="tab-title-naming-frame"><span className="tab-title-naming-ghost">Naming task</span>{legacy||${!history.includes('import { CompositedTextShimmer }')}?<span className="tab-title-naming-text">Naming task</span>:<CompositedTextShimmer className="tab-title-naming-text" variant="naming">Naming task</CompositedTextShimmer>}</span></span>
 <span data-family="awaiting" className="chip">Awaiting input<span className="tab-awaiting-input ring"/></span>
 <span data-family="notification" className="chip">Workflow notice<span className="tab-completion-notification-alert ring"/></span>
 <span data-family="shape" className="chip">Loader<span className="noted-shape-ring ring"/></span>
 <span data-family="glow" className="chip animate-glow-yellow">Glow</span><span data-family="hotkey" className="chip cb-run-after-hotkey-surface cb-run-after-hotkey-surface-orange">Hotkey</span></div>
 </div>}
function BarGallery(){const cases=[20,37,50,73,100,200].flatMap(spacing=>[18,36,64].flatMap((height,j)=>${fullMatrix ? "['normal','inherited','both'].flatMap(mode=>['left','right'].map(side=>({spacing,height,mode,side})))" : "[{spacing,height,mode:j===1?'both':'normal',side:j===2?'left':'right'}]"}));return <div id="bar-gallery" style={{display:'grid',gridTemplateColumns:'repeat(6,180px)',gap:14,padding:20}}>{cases.map(({spacing,height,mode,side})=><span key={spacing+'-'+height+'-'+mode+'-'+side} data-gallery-case={spacing+'-'+height+'-'+mode+'-'+side} className="chip"
 style={{height,width:180,boxSizing:'border-box','--process-bar-shimmer-spacing':spacing+'%','--process-bar-color-a':'#178257',...(${fullMatrix}?{'--process-bar-inherited-shimmer-rgb':'255, 255, 255'}:{})}}>{spacing}% · {height}px
 <TabProcessBar hasProcess busy={mode!=='inherited'} inheritedBusy={mode!=='normal'} radius={5} positionOverride={side}/></span>)}</div>}
function App(){const[hidden,setHidden]=useState(false),[dense,setDense]=useState(true),[gallery,setGallery]=useState(0);
 window.fixture={requestMainThreadFrames,setMode(mode){document.getElementById('control-style').textContent=mode==='baseline'?'':
  mode==='paused'?'.fixture-indicators *, .fixture-indicators *::before,.fixture-indicators *::after{animation-play-state:paused!important}':
  '.fixture-indicators [data-family]:not([data-family="'+mode+'"]) , .fixture-indicators [data-family]:not([data-family="'+mode+'"]) *, .fixture-indicators [data-family]:not([data-family="'+mode+'"]) *::before,.fixture-indicators [data-family]:not([data-family="'+mode+'"]) *::after{animation-play-state:paused!important}';
  document.documentElement.dataset.mode=mode;},setArm(arm){document.documentElement.dataset.r04SelectedArm=arm},setDense(value){flushSync(()=>setDense(value))},setHidden(value){flushSync(()=>setHidden(value))},
  prototype(value){document.getElementById('prototype-css').disabled=!value;},setSpacing(value){document.documentElement.style.setProperty('--process-bar-shimmer-spacing',value)},gallery(){flushSync(()=>setGallery(x=>x+1))}};
 if(gallery)return <BarGallery key={gallery}/>;
 return <><div className="titlebar" style={{WebkitAppRegion:'drag'}}>Private recurring paint fixture <button id="toggle" style={{WebkitAppRegion:'no-drag'}} onClick={()=>setHidden(x=>!x)}>Show/hide owner</button></div>
 <main>{Array.from({length:dense?${owners}:1},(_,i)=><section key={i} data-fixture-owner={i} data-terminal-pane-wrapper={'fixture-'+i}
 data-terminal-surface-presented={i===0&&!hidden?'1':'0'} data-pane-focus-isolated={i===0&&!hidden?'0':'1'}
 aria-hidden={i!==0||hidden||undefined} style={{position:'absolute',inset:'46px 18px 16px',opacity:i===0&&!hidden?1:0,visibility:'visible',willChange:'opacity',overflow:'hidden',pointerEvents:i===0&&!hidden?'auto':'none',zIndex:i===0&&!hidden?2:0}}>
 <div data-history-owner={'history-'+i} data-history-presented="1">${suite === 'acceptance' ? '<div data-r04-arm="baseline"><Indicators owner={i} legacy/></div><div data-r04-arm="product"><Indicators owner={i}/></div>' : '<Indicators owner={i}/>'}<textarea aria-label={'Draft '+i} defaultValue="Unsent local draft"/>
 <div className="scroller">{Array.from({length:${rows}},(_,j)=><ConversationMessage key={j} layout={j%6===0?'user':'assistant'} entryUuid={i+'-'+j}>
 <div className="rich-row"><p>Retained response {j}: <b>formatted content</b> and <span>background data</span>.</p>
 <ul><li><span>One retained result</span><code>ready</code></li><li>Second <em>independent</em> result</li></ul>
 <pre><code>const answer = await work();</code></pre><div className="nested-detail"><span>Read × 2</span><span> Saved · immutable synthetic response</span></div></div>
 </ConversationMessage>)}</div></div></section>)}</main></>}
flushSync(()=>root.render(<App/>));`);
  // Private transform candidate: same gradient period T=s*H, raster height
  // 4H, origin at -T (one whole tile). It covers the bar over the complete
  // configured s=.2..2 interval. Translation matches the old background
  // positioning travel H-T. Not written to product sources.
  const prototypeCss = arg('prototype-css', '') ? await fs.readFile(arg('prototype-css', ''), 'utf8') : `@keyframes private-process-transform {from{transform:translateY(0)}to{transform:translateY(calc((100% - var(--process-bar-shimmer-spacing,50%)) / 4))}}
.tab-process-bar-ai-shimmer-overlay{inset:auto 0 auto;top:calc(-1 * var(--process-bar-shimmer-spacing,50%));height:400%;background-size:100% calc(var(--process-bar-shimmer-spacing,50%) / 4);background-position:0 0;will-change:transform;animation-name:private-process-transform}`;
  await fs.writeFile(path.join(snapshot, 'prototype.css'), prototypeCss);
  await fs.writeFile(path.join(artifact, 'private-prototype.css.txt'), prototypeCss);
  await build({ entryPoints:[path.join(snapshot,'fixture.tsx')],outfile:path.join(artifact,'bundle.js'),bundle:true,platform:'browser',target:'chrome120',
    nodePaths:[path.join(repo,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',sourcemap:true });
  await fs.writeFile(path.join(artifact,'index.html'), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'self' 'unsafe-inline';script-src 'self'">
<link rel="stylesheet" href="source/blocks.css"><link rel="stylesheet" href="source/history.css"><link rel="stylesheet" href="source/indicators.css"><link rel="stylesheet" href="source/gate.css">
${compiledCss ? '' : '<link rel="stylesheet" href="bundle.css">'}${suite === 'acceptance' ? '<link rel="stylesheet" href="source/legacy.css">' : ''}
<link id="prototype-css" rel="stylesheet" href="source/prototype.css" disabled><style id="control-style"></style><style id="reset-style"></style>
<style>#bar-gallery .tab-process-bar-ai-shimmer-overlay{animation-play-state:paused!important}body{margin:0;overflow:hidden;background:#18181b;color:#ccc;font:14px sans-serif}.titlebar{height:36px;background:#303033;padding-left:24px;display:flex;align-items:center;gap:20px}
html:not([data-r04-selected-arm="baseline"]) [data-r04-arm="baseline"],html[data-r04-selected-arm="baseline"] [data-r04-arm="product"]{display:none}
button{color:#ddd;background:#444;border:1px solid #666}textarea{color:#ddd;background:#222;width:90%;height:38px;margin:12px 0}.scroller{height:530px;overflow:auto}
.rich-row{font-size:14px;line-height:1.45}.rich-row p{margin:3px}.rich-row ul{margin:3px}.rich-row pre{margin:4px;background:#222}.nested-detail{color:#aaa;margin:3px}
.chip{position:relative;display:inline-flex;align-items:center;padding:4px 8px;border:1px solid #486355;border-radius:5px;background:#24372d;white-space:nowrap}
.chip-row{display:flex;gap:4px}.indicator-line{display:flex;gap:9px;align-items:center;margin-top:9px;height:35px}.ring{position:absolute;inset:-1px;border-radius:5px}
</style><div id="fixture"></div><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact,'main.cjs'), `const{app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();global.focusEvents=[];global.paintCount=0;const win=global.fixture=new BrowserWindow({width:1300,height:${fullMatrix ? 1500 : 800},show:false,focusable:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
win.on('focus',()=>focusEvents.push(Date.now()));win.webContents.on('paint',()=>paintCount++);win.webContents.setFrameRate(60);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.loadFile(${JSON.stringify(path.join(artifact,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
  await fs.writeFile(path.join(artifact,'source-hashes.json'),JSON.stringify(result.sourceHashes,null,2));
  console.log(JSON.stringify({stage:'ready',artifact,suite,owners,rows}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});
  const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.setDefaultTimeout(12000);
  await page.waitForFunction(()=>!!window.fixture);await page.emulateMedia({reducedMotion:'no-preference'});
  result.engine=await app.evaluate(({app})=>({electron:process.versions.electron,chrome:process.versions.chrome,pid:process.pid,gpu:app.getGPUFeatureStatus(),userData:app.getPath('userData')}));
  assert.match(result.engine.electron,/^28\./);assert.equal(result.engine.gpu.gpu_compositing,'enabled');
  assert.equal(await page.evaluate(()=>document.visibilityState),'visible');
  await page.screenshot({path:path.join(artifact,'fixture.png')});
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
  const metricNames=['ThreadTime','ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'];
  const animationState=()=>page.evaluate(()=>{
    const animations=document.getAnimations();const families={};
    for(const a of animations){const el=a.effect?.target;const family=el?.closest?.('[data-family]')?.dataset.family||'other';
      const group=families[family]??={running:0,paused:0,hiddenRunning:0,names:[]};group[a.playState]=(group[a.playState]||0)+1;
      if(a.playState==='running'&&el.closest('[data-terminal-surface-presented="0"]'))group.hiddenRunning++;
      if(!group.names.includes(a.animationName))group.names.push(a.animationName);}
    const visible=document.querySelector('[data-fixture-owner="0"]');
    const arms=[...visible.querySelectorAll('[data-r04-arm]')].filter(el=>getComputedStyle(el).display!=='none');
    const controls=[...(arms[0]||visible).querySelectorAll('[data-family]')].map(el=>{
      const target=el.querySelector('.tab-awaiting-input,.tab-completion-notification-alert,.noted-shape-ring')||el;
      return{family:el.dataset.family,animation:getComputedStyle(target).animationName,pseudoAnimation:getComputedStyle(target,'::before').animationName};
    });
    return{nodes:document.querySelectorAll('*').length,owners:document.querySelectorAll('[data-fixture-owner]').length,families,controls};});
  const measure=async(name,mode,{dense=true,hidden=false,prototype=false,arm='product'}={})=>{
    await page.evaluate(({mode,dense,hidden,prototype,arm})=>{window.fixture.setArm(arm);window.fixture.setDense(dense);window.fixture.setHidden(hidden);window.fixture.setMode(mode);window.fixture.prototype(prototype)}, {mode,dense,hidden,prototype,arm});
    if(suite==='acceptance')await page.evaluate(async()=>{
      // Recreate only CSS animations, never retained owners/data/drafts. Both
      // arms enter the same initial visible phase; no WAAPI-held old effect.
      const style=document.getElementById('reset-style');
      style.textContent='.fixture-indicators *,.fixture-indicators *::before,.fixture-indicators *::after{animation-name:none!important}';
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      style.textContent='';
      await new Promise(resolve=>requestAnimationFrame(resolve));
    });
    // Settling is excluded from the measured interval; DOM readiness above is
    // deterministic. No synthetic motion or React updates are added per frame.
    await page.waitForTimeout(450);const state=await animationState();
    assert.ok(Object.values(state.families).every(g=>g.hiddenRunning===0),'authored hidden gate remains enabled');
    if(suite==='acceptance'&&mode==='baseline'&&!hidden)for(const family of ['process','tail','terminal','spinner','naming','awaiting','notification','shape','glow','hotkey']) {
      assert.ok(state.families[family]?.running>0,'active '+arm+' fixture must contain real running '+family);
    }
    await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordContinuously',includedCategories:['toplevel','devtools.timeline','blink','cc','gpu','disabled-by-default-devtools.timeline.invalidationTracking']}});
    const before=await cdp.send('Performance.getMetrics');const start=Date.now();await page.waitForTimeout(durationMs);const after=await cdp.send('Performance.getMetrics');const elapsedMs=Date.now()-start;
    const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const{stream}=await done;let raw='';
    try{for(;;){const chunk=await cdp.send('IO.read',{handle:stream,size:1048576});raw+=chunk.base64Encoded?Buffer.from(chunk.data,'base64').toString('utf8'):chunk.data;if(chunk.eof)break;}}finally{await cdp.send('IO.close',{handle:stream})}
    await fs.writeFile(path.join(artifact,name+'.trace.json'),raw);const{traceEvents}=JSON.parse(raw);
    const main=traceEvents.find(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain');assert.ok(main);
    const totals={},paintNodes={},invalidations={};
    for(const e of traceEvents){if(e.pid!==main.pid||e.tid!==main.tid)continue;
      if(e.ph==='X'){const m=totals[e.name]??={count:0,sumMs:0,maxMs:0};m.count++;m.sumMs+=(e.dur||0)/1000;m.maxMs=Math.max(m.maxMs,(e.dur||0)/1000);
        if(e.name==='Paint'&&e.args?.data?.nodeId)paintNodes[e.args.data.nodeId]=(paintNodes[e.args.data.nodeId]||0)+1;}
      if(e.name.includes('Invalidation')){const reason=e.args?.data?.reason||e.name;invalidations[reason]=(invalidations[reason]||0)+1;}}
    const selected=Object.fromEntries(Object.entries(totals).filter(([key])=>/Paint|PrePaint|Layer|MainFrame|Layout|Style|Annotat/.test(key)));
    const delta=Object.fromEntries(after.metrics.filter(m=>metricNames.includes(m.name)).map(m=>[m.name,m.value-before.metrics.find(b=>b.name===m.name).value]));
    const sample={name,mode,dense,hidden,prototype,arm,state,elapsedMs,delta,traceComplete:true,nestedTraceMetricsDoNotSum:selected,paintNodes,invalidations};
    result.samples.push(sample);await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({stage:'sample',name,nodes:state.nodes,cpuMs:delta.ThreadTime*1000,scriptMs:delta.ScriptDuration*1000,paint:totals.Paint,prepaint:totals.PrePaint,lifecycle:totals['LocalFrameView::RunPaintLifecyclePhase']}));
  };
  if(suite==='frame-loop'){
    await measure('01-animation-alone','baseline');
    await page.evaluate(()=>window.fixture.requestMainThreadFrames(true));
    await measure('02-animation-with-frame-loop','baseline');
    await measure('03-paused-with-frame-loop','paused');
    await page.evaluate(()=>window.fixture.requestMainThreadFrames(false));
    await measure('04-animation-alone-return','baseline');
  }else if(suite==='acceptance'){
    await measure('legacy-all','baseline',{arm:'baseline'});
    await measure('product-paused','paused');
    await measure('product-all','baseline');
    for(const family of ['process','tail','spinner','naming','awaiting','notification','shape','glow','hotkey'])await measure('product-only-'+family,family);
    await measure('product-all-hidden','baseline',{hidden:true});
    const before=result.samples.find(sample=>sample.name==='legacy-all');
    const after=result.samples.find(sample=>sample.name==='product-all');
    const count=(sample,event)=>sample.nestedTraceMetricsDoNotSum[event]?.count||0;
    result.nativeAcceptance={beforePaint:count(before,'Paint'),afterPaint:count(after,'Paint'),
      beforePrePaint:count(before,'PrePaint'),afterPrePaint:count(after,'PrePaint'),
      beforeLifecycle:count(before,'LocalFrameView::RunPaintLifecyclePhase'),afterLifecycle:count(after,'LocalFrameView::RunPaintLifecyclePhase')};
    assert.ok(result.nativeAcceptance.afterPaint<result.nativeAcceptance.beforePaint*.25,'product removes recurring document Paint');
    assert.ok(result.nativeAcceptance.afterPrePaint<result.nativeAcceptance.beforePrePaint*.6,'PrePaint is no longer a60Hz document loop');
    assert.ok(result.nativeAcceptance.afterLifecycle<result.nativeAcceptance.beforeLifecycle*.6,'check lifecycle as well as raster Paint');
  }else if(suite==='isolate'){
    await measure('01-dense-baseline','baseline');await measure('02-dense-all-paused','paused');
    for(const family of ['process','tail','terminal','spinner','naming','awaiting','notification','shape','glow'])await measure('only-'+family,family);
    await measure('12-dense-all-hidden','baseline',{hidden:true});
    await measure('13-small-process','process',{dense:false});await measure('14-small-tail','tail',{dense:false});
    await measure('15-dense-process-return','process');await measure('16-dense-paused-return','paused');
  }else if(suite==='prototype'){
    await measure('process-original','process');await measure('process-transform','process',{prototype:true});
    await measure('process-transform-small','process',{dense:false,prototype:true});await measure('process-original-small','process',{dense:false});
    await measure('process-transform-hidden','process',{hidden:true,prototype:true});
  }else if(suite!=='visual')throw Error('Unknown suite '+suite);
  // Check the real presentation gate through trusted private input. No remount
  // between hide/show and no draft/scroll reset introduced by the experiment.
  await page.evaluate(()=>{window.fixture.setDense(true);window.fixture.setHidden(false);window.fixture.setMode('baseline');window.fixture.prototype(false);
    window.savedOwner=document.querySelector('[data-fixture-owner="0"]');window.savedScroller=window.savedOwner.querySelector('.scroller');window.savedScroller.scrollTop=240;window.savedOwner.querySelector('textarea').value='Private draft survives';});
  await page.locator('#toggle').click();await page.waitForFunction(()=>document.querySelector('[data-fixture-owner="0"]').getAttribute('data-terminal-surface-presented')==='0');
  result.hiddenAnimations=await animationState();assert.ok(Object.values(result.hiddenAnimations.families).every(f=>f.running===0));
  await page.locator('#toggle').click();
  result.retention=await page.evaluate(()=>({sameOwner:window.savedOwner===document.querySelector('[data-fixture-owner="0"]'),sameScroller:window.savedScroller===window.savedOwner.querySelector('.scroller'),scrollTop:window.savedScroller.scrollTop,draft:window.savedOwner.querySelector('textarea').value}));
  assert.deepEqual(result.retention,{sameOwner:true,sameScroller:true,scrollTop:240,draft:'Private draft survives'});
  if(suite==='prototype'||suite==='visual'){
    await page.evaluate(()=>{window.fixture.setMode('baseline');window.fixture.gallery()});
    result.visual=[];
    for(const phase of visualPhases){
      const captures=[];
      for(const candidate of [false,true]){
        // Fresh gallery nodes discard WAAPI-persisted old CSS animations.
        // Changing currentTime can keep a detached CSSAnimation alive even
        // after switching its stylesheet. That would compare two animations
        // stacked together, not the candidate against the original.
        await page.evaluate(candidate=>{window.fixture.prototype(candidate);window.fixture.gallery()},candidate);
        const expectedName=candidate?'private-process-transform':'tab-process-bar-ai-shimmer';
        await page.waitForFunction(expected=>[...document.querySelectorAll('#bar-gallery .tab-process-bar-ai-shimmer-overlay')].every(el=>getComputedStyle(el).animationName===expected),expectedName);
        await page.evaluate(async({phase})=>{
          const animations=[...document.querySelectorAll('#bar-gallery .tab-process-bar-ai-shimmer-overlay')].flatMap(el=>el.getAnimations());
          for(const a of animations)a.pause();
          await Promise.all(animations.map(a=>a.ready));
          for(const a of animations)a.currentTime=phase*1200;
        },{phase});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        // rAF acknowledges the main-thread style, not the offscreen compositor
        // frame. Request/await one fresh native paint before reading pixels at
        // this paused phase. This visual-only barrier is outside native traces.
        await app.evaluate(async()=>new Promise((resolve,reject)=>{
          const wc=global.fixture.webContents;
          const timeout=setTimeout(()=>{wc.removeListener('paint',paint);reject(Error('phase paint timeout'))},3000);
          const paint=()=>{clearTimeout(timeout);resolve(true)};
          wc.once('paint',paint);wc.invalidate();
        }));
        const gallery=page.locator('#bar-gallery');const bounds=await gallery.boundingBox();
        // Require independently stable captures; a stale offscreen frame must
        // not decide equivalence. No comparison with the reference is used to
        // choose a frame. Every animation remains paused at the same phase.
        let png, previousHash, stableFrames=0, captureCount=0;
        for(;captureCount<8;captureCount++){
          const next=await gallery.screenshot({animations:'allow'}),digest=hash(next);
          stableFrames=digest===previousHash?stableFrames+1:0;previousHash=digest;png=next;
          if(stableFrames>=1)break;
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        }
        assert.ok(stableFrames>=1,'paused gallery produces two consecutive identical pixel frames');
        const name='bars-'+phase+'-'+(candidate?'transform':'original')+'.png';await fs.writeFile(path.join(artifact,name),png);
        const geometry=await page.evaluate(()=>[...document.querySelectorAll('[data-gallery-case]')].map(el=>{
          const bar=el.querySelector('[data-tab-process-bar]'),r=bar.getBoundingClientRect();
          return{name:el.dataset.galleryCase,x:r.x,y:r.y,width:r.width,height:r.height};}));
        const animationProof=await page.evaluate(()=>[...document.querySelectorAll('#bar-gallery [data-gallery-case]')].map(el=>{
          const overlay=el.querySelector('.tab-process-bar-ai-shimmer-overlay'),s=getComputedStyle(overlay);
          return{name:el.dataset.galleryCase,rect:overlay.getBoundingClientRect().toJSON(),style:{height:s.height,top:s.top,backgroundSize:s.backgroundSize,backgroundPosition:s.backgroundPosition,transform:s.transform},animations:overlay.getAnimations().map(a=>({name:a.animationName,playState:a.playState,time:a.currentTime}))};}));
        assert.ok(animationProof.every(p=>p.animations.length===1&&p.animations[0].name===expectedName&&p.animations[0].playState==='paused'&&Math.abs(p.animations[0].time-phase*1200)<.001),'visual pair freezes exactly one current animation at the same phase');
        captures.push({name,base64:png.toString('base64'),bounds,geometry,animationProof,captureCount:captureCount+1,stableFrames});
      }
      const comparison=await app.evaluate(({nativeImage},{left,right})=>{
        const a=nativeImage.createFromBuffer(Buffer.from(left.base64,'base64')),b=nativeImage.createFromBuffer(Buffer.from(right.base64,'base64'));
        const size=a.getSize(),av=a.toBitmap(),bv=b.toBitmap(),scale=size.width/left.bounds.width;
        return{size,bitmapBytes:av.length,scale,sameSize:JSON.stringify(size)===JSON.stringify(b.getSize()),cases:left.geometry.map(r=>{
          let sum=0,max=0,count=0,changed=0;
          for(let y=Math.ceil((r.y-left.bounds.y)*scale);y<Math.floor((r.y-left.bounds.y+r.height)*scale);y++)for(let x=Math.ceil((r.x-left.bounds.x)*scale);x<Math.floor((r.x-left.bounds.x+r.width)*scale);x++)for(let c=0;c<3;c++){
            const i=(y*size.width+x)*4+c,d=Math.abs(av[i]-bv[i]);sum+=d;max=Math.max(max,d);count++;if(d)changed++;
          }
          return{name:r.name,meanAbs:sum/count,max,changedFraction:changed/count};
        })};
      },{left:captures[0],right:captures[1]});
      result.visual.push({phase,files:captures.map(c=>c.name),captures:captures.map(({base64,...rest})=>rest),geometryEqual:JSON.stringify(captures[0].geometry)===JSON.stringify(captures[1].geometry),...comparison});
    }
    result.visualEquivalent=result.visual.every(v=>v.sameSize&&v.geometryEqual&&v.cases.every(c=>c.meanAbs<=3));
    if(arg('require-visual','0')==='1')assert.equal(result.visualEquivalent,true,'every controlled visual case must preserve geometry and bounded pixel error');
    // This is a diagnostic prototype result, not a product assertion. A failed
    // visual comparison is retained as a rejected candidate, not hidden.
  }
  result.isolation=await app.evaluate(()=>({visible:global.fixture.isVisible(),focused:global.fixture.isFocused(),focusEvents:global.focusEvents}));
  assert.deepEqual(result.isolation,{visible:false,focused:false,focusEvents:[]});assert.deepEqual(result.errors,[]);result.status='pass';
}catch(error){result.status='fail';result.error=error.stack;process.exitCode=1;}
finally{
  if(app){await app.close();result.cleanup.electronClosed=true;}
  result.cleanup.sourceSnapshotRemoved=true;await fs.rm(snapshot,{recursive:true,force:true});
  await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});result.cleanup.profileRemoved=true;
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,artifact,error:result.error,cleanup:result.cleanup}));
}
