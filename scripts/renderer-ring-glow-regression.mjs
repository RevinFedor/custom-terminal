#!/usr/bin/env node
// Private Electron presentation-only acceptance for the recurring rings/glows.
// No app API, PTY, provider, production inspector or global input.
import { _electron as electron } from 'playwright';
import postcss from 'postcss';
import ts from 'typescript';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Minimize2 } from 'lucide-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo=fileURLToPath(new URL('..',import.meta.url));
const arg=(name,fallback)=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const baselinePath=arg('baseline',null),candidatePath=arg('candidate',null),suite=arg('suite','visual'),onlyFamily=arg('family',null);
assert.ok(baselinePath,'Provide the frozen pre-change --baseline=globals.css');
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-ring-glow-'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const result={artifact,suite,sourceHashes:{},visual:[],samples:[],errors:[],cleanup:{}};
const read=async(file)=>{const s=await fs.readFile(file,'utf8');result.sourceHashes[file]=hash(s);return s};
const baseline=await read(baselinePath),current=await read(path.join(repo,'src/renderer/styles/globals.css'));
const gate=await read(path.join(repo,'src/renderer/styles/presentationAnimations.css'));
const sidebar=await read(path.join(repo,'src/renderer/components/Workspace/SidebarToolsRow.tsx'));
await read(fileURLToPath(import.meta.url));
const sidebarAst=ts.createSourceFile('SidebarToolsRow.tsx',sidebar,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let iconSource;const findIcon=node=>{if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(sidebarAst)==='span'&&node.getText(sidebarAst).includes('animate-glow-indigo')&&node.getText(sidebarAst).includes('<Minimize2'))iconSource=node.getText(sidebarAst);ts.forEachChild(node,findIcon)};findIcon(sidebarAst);assert.ok(iconSource,'actual SidebarToolsRow HTML glow host');
const iconMarkup={};for(const [arm,jsx]of Object.entries({before:'<Minimize2 size={13} className={isCompressing ? "text-indigo-400 animate-glow-indigo" : ""} />',after:iconSource})){const source='exports.Icon = (isCompressing) => ('+jsx+');';const js=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;const sandbox={exports:{},React,Minimize2};vm.runInNewContext(js,sandbox);iconMarkup[arm]=renderToStaticMarkup(sandbox.exports.Icon(true));result.sourceHashes['SidebarToolsRow compress icon '+arm]=hash(jsx)}
const candidate=candidatePath?await read(candidatePath):'';
const extract=css=>postcss.parse(css).nodes.filter(n=>n.type==='atrule'&&['keyframes','property','media'].includes(n.name)
  ||n.type==='rule'&&/noted-shape-ring|tab-awaiting|tab-completion-notification|animate-glow|cb-run-after-hotkey/.test(n.selector)).map(n=>n.toString()).join('\n');
const before=extract(baseline),after=extract(candidatePath?baseline:current)+'\n'+candidate;
await fs.writeFile(path.join(artifact,'before.css'),before);await fs.writeFile(path.join(artifact,'after.css'),after);
await fs.writeFile(path.join(artifact,'gate.css'),gate);
const geometries=[{w:340,h:28,r:4,t:1.2},{w:160,h:36,r:9,t:1.5},{w:32,h:32,r:999,t:3},{w:28,h:110,r:8,t:1.5},{w:18,h:14,r:0,t:1},{w:72,h:18,r:999,t:2}];
const cases=[];
for(const cls of ['noted-shape-ring','tab-awaiting-input','tab-completion-notification-alert'])for(const [i,g]of geometries.entries())cases.push({name:cls+'-'+i,cls,...g,kind:'ring'});
for(const color of ['yellow','purple','green','indigo','blue','red','white'])for(const [i,g]of [{w:10,h:10,r:999},{w:10,h:3,r:1},{w:120,h:28,r:5},{w:210,h:32,r:5,border:1,text:'Pending work',absolute:true}].entries())cases.push({name:'glow-'+color+'-'+i,cls:'animate-glow-'+color,...g,kind:'glow'});
for(const color of ['orange','violet'])cases.push({name:'hotkey-'+color,cls:'cb-run-after-hotkey-surface cb-run-after-hotkey-surface-'+color,w:120,h:28,r:5,kind:'hotkey'});
cases.push({name:'actual-compress-icon',cls:'',w:13,h:13,r:0,kind:'icon'});
await fs.writeFile(path.join(artifact,'index.html'),`<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#18181b;color:#ddd;font:12px sans-serif;overflow:hidden}.titlebar{height:30px;-webkit-app-region:drag}.absolute{position:absolute}.text-indigo-400{color:#818cf8}
#gallery{display:grid;grid-template-columns:repeat(3,370px);gap:16px 10px;padding:20px;width:1160px}.case{height:135px;padding:15px;position:relative;background:#18181b}.caption{position:absolute;bottom:0;color:#bbb;font-size:11px}.shape{position:relative;background:#24372d;flex:none}.ring{position:absolute;inset:0;border-radius:inherit;pointer-events:none}
#gallery[data-visual-paused="1"] *,#gallery[data-visual-paused="1"] *::before,#gallery[data-visual-paused="1"] *::after{animation-play-state:paused!important}
.glow{display:block;position:relative}.hotkey{position:relative;background:#252526}.small-native{display:flex;gap:15px;align-items:center;padding:20px}.small-native .case{height:150px;width:365px}
button{color:#ddd;background:#333;border:1px solid #777}textarea{width:200px;height:28px;background:#222;color:#ddd}
</style><style id="current-css"></style><style>${gate}</style><style id="control"></style>
<div class="titlebar">Private ring/glow fixture</div><button id="hide">Hide owner</button><button id="show">Show owner</button><button id="dismiss">Dismiss workflow notification</button>
<div id="owner" data-terminal-pane-wrapper="private" data-terminal-surface-presented="1" style="position:relative;will-change:opacity"><textarea>Draft retained</textarea><div id="gallery"></div></div>
<script>
const cases=${JSON.stringify(cases)};const icons=${JSON.stringify(iconMarkup)};const css={before:${JSON.stringify(before)},after:${JSON.stringify(after)}};
window.fixture={gallery(arm,family,visualPaused=false){document.getElementById('gallery').replaceChildren();document.getElementById('current-css').textContent=css[arm];
 const target=document.getElementById('gallery');target.className='';target.dataset.visualPaused=visualPaused?'1':'0';
 for(const c of cases.filter(c=>!family||c.kind===family||c.cls===family)){const box=document.createElement('div');box.className='case';box.dataset.case=c.name;
 const shape=document.createElement('div');shape.className='shape '+(c.kind==='ring'?'':c.kind)+(c.absolute?' absolute':'');Object.assign(shape.style,{width:c.w+'px',height:c.h+'px',borderRadius:c.r+'px'});
 if(c.border)shape.style.border=c.border+'px solid rgba(123,151,168,.6)';if(c.text)shape.textContent=c.text;
 const indicator=c.kind==='glow'?shape:document.createElement('span');indicator.className+=(c.kind==='ring'?'ring ':' ')+c.cls;indicator.dataset.indicator=c.name;
 if(c.kind==='ring'){indicator.style.setProperty('--noted-ring-thickness',c.t+'px');if(c.name.endsWith('-4')){indicator.style.setProperty('--noted-ring-color','rgba(148,163,184,.75)');indicator.style.setProperty('--noted-ring-track','rgba(255,255,255,.16)')}}
 if(indicator!==shape)shape.append(indicator);if(c.kind==='icon'){shape.innerHTML=icons[arm];shape.firstElementChild.dataset.indicator=c.name}box.append(shape);const label=document.createElement('div');label.className='caption';label.textContent=c.name;box.append(label);target.append(box)}
 return document.querySelectorAll('[data-indicator]').length},
 arm(arm){document.getElementById('current-css').textContent=css[arm]},
 async pause(phase){const as=document.getAnimations();for(const a of as)a.pause();await Promise.all(as.map(a=>a.ready));for(const a of as){const d=a.effect.getTiming().duration;a.currentTime=d*phase}return as.map(a=>({name:a.animationName,pseudo:a.effect.pseudoElement,time:a.currentTime,duration:a.effect.getTiming().duration,playState:a.playState,target:a.effect.target.dataset.indicator,current:a.effect.target.isConnected&&getComputedStyle(a.effect.target,a.effect.pseudoElement).animationName.split(',').map(n=>n.trim()).includes(a.animationName)}))},
 resume(){for(const a of document.getAnimations()){a.currentTime=0;a.play()}}};
window.ends=[];document.addEventListener('animationend',e=>ends.push({name:e.animationName,pseudo:e.pseudoElement,elapsed:e.elapsedTime,target:e.target.dataset.indicator}));
document.getElementById('dismiss').onclick=()=>{document.querySelector('.tab-completion-notification-alert').classList.add('tab-completion-notification-alert--dismiss')};
document.getElementById('hide').onclick=()=>{document.getElementById('owner').dataset.terminalSurfacePresented='0';document.getElementById('owner').style.opacity=0};document.getElementById('show').onclick=()=>{document.getElementById('owner').dataset.terminalSurfacePresented='1';document.getElementById('owner').style.opacity=1};fixture.gallery('before');
</script>`);
await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();global.events=[];global.win=new BrowserWindow({width:1180,height:1800,show:false,focusable:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});win.on('focus',()=>events.push('focus'));win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);win.loadFile(${JSON.stringify(path.join(artifact,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
let app;
try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await page.waitForFunction(()=>!!window.fixture);
 result.engine=await app.evaluate(({app})=>({pid:process.pid,electron:process.versions.electron,chrome:process.versions.chrome,gpu:app.getGPUFeatureStatus()}));assert.equal(result.engine.gpu.gpu_compositing,'enabled');
 result.visualMethod='Fresh CSS-paused gallery before mount; await every CSSAnimation.ready, exact seek, 2 rAF; native paint ACK before each PNG; two consecutive identical PNGs required. No phase offset, no per-frame performance probe.';
 if(suite==='visual'||suite==='all')for(const family of ['ring','glow','hotkey','icon'].filter(f=>!onlyFamily||f===onlyFamily))for(const phase of [0,.125,.25,.5,.75,.999]){
  const pair=[];
  for(const arm of ['before','after']){
   await page.evaluate(({arm,family})=>fixture.gallery(arm,family,true),{arm,family});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const animations=await page.evaluate(phase=>fixture.pause(phase),phase);assert.ok(animations.length>0&&animations.every(a=>a.current&&a.playState==='paused'&&Math.abs(a.time-a.duration*phase)<.01));
   const expected=arm==='after'&&family!=='ring'?2:1;for(const id of new Set(animations.map(a=>a.target)))assert.equal(animations.filter(a=>a.target===id).length,expected,'only current pseudo/host animations for '+id);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   // Offscreen can have an older native frame even after two renderer rAFs.
   // Force one acknowledged paint only for the paused screenshot, never in
   // a native performance interval or a per-frame application probe.
   const geom=await page.evaluate(()=>[...document.querySelectorAll('[data-case]')].map(e=>({name:e.dataset.case,box:e.getBoundingClientRect().toJSON(),rect:e.querySelector('.shape').getBoundingClientRect().toJSON(),styles:[null,'::before','::after'].map(p=>{const el=e.querySelector('[data-indicator]'),s=getComputedStyle(el,p);return{pseudo:p,animation:s.animationName,width:s.width,height:s.height,transform:s.transform,background:s.background,opacity:s.opacity,borderImage:s.borderImage,borderColor:s.borderColor,borderWidth:s.borderWidth}})})));
   let png,previous,stable=false;const frameHashes=[];
   for(let attempt=0;attempt<6;attempt++){
    await app.evaluate(()=>new Promise((resolve,reject)=>{
     const contents=win.webContents;
     const finish=error=>{clearTimeout(timer);contents.removeListener('paint',paint);error?reject(error):resolve(true)};
     const paint=()=>finish();
     const timer=setTimeout(()=>finish(new Error('native paint timeout')),3000);
     contents.once('paint',paint);
     try{contents.invalidate()}catch(error){finish(error)}
    }));
    png=await page.locator('#gallery').screenshot({animations:'allow'});frameHashes.push(hash(png));
    if(previous?.equals(png)){stable=true;break}previous=png;
   }
   assert.ok(stable,'two consecutive acknowledged native frames agree at '+family+'/'+phase+'/'+arm);
   const name=family+'-'+phase+'-'+arm+'.png',bounds=await page.locator('#gallery').boundingBox();await fs.writeFile(path.join(artifact,name),png);pair.push({arm,name,base64:png.toString('base64'),bounds,geom,animations,frameHashes,stable});
  }
  const diff=await app.evaluate(({nativeImage},pair)=>{const [a,b]=pair.map(p=>nativeImage.createFromBuffer(Buffer.from(p.base64,'base64'))),size=a.getSize(),av=a.toBitmap(),bv=b.toBitmap(),scale=size.width/pair[0].bounds.width;return{sameSize:JSON.stringify(size)===JSON.stringify(b.getSize()),cases:pair[0].geom.map(g=>{const region={x:g.rect.x-12,y:g.rect.y-12,width:g.rect.width+24,height:g.rect.height+24};let sum=0,max=0,count=0,changed=0;for(let y=Math.ceil((region.y-pair[0].bounds.y)*scale);y<Math.floor((region.y+region.height-pair[0].bounds.y)*scale);y++)for(let x=Math.ceil((region.x-pair[0].bounds.x)*scale);x<Math.floor((region.x+region.width-pair[0].bounds.x)*scale);x++)for(let c=0;c<3;c++){const idx=(y*size.width+x)*4+c,d=Math.abs(av[idx]-bv[idx]);sum+=d;max=Math.max(max,d);count++;if(d)changed++}return{name:g.name,meanAbs:sum/count,max,changedFraction:changed/count}})}} ,pair);
  result.visual.push({family,phase,...diff,geometryEqual:JSON.stringify(pair[0].geom.map(g=>g.rect))===JSON.stringify(pair[1].geom.map(g=>g.rect)),captures:pair.map(({base64,...p})=>p)});
 }
 if(result.visual.length){result.visualEquivalent=result.visual.every(v=>v.sameSize&&v.geometryEqual&&v.cases.every(c=>Number.isFinite(c.meanAbs)&&c.meanAbs<=(v.family==='ring'?.1:2)&&(v.family==='ring'||c.max<=24)));assert.ok(result.visualEquivalent,'visual equivalence per case: ring <=.1 mean, glow/hotkey/icon <=2 mean and <=24 max; no geometry drift');}
 if(suite==='native'||suite==='all'){
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
  for(const family of ['noted-shape-ring','tab-awaiting-input','tab-completion-notification-alert','glow','hotkey'].filter(f=>!onlyFamily||f===onlyFamily)){
   await page.evaluate(f=>fixture.gallery('before',f),family);
   const saved=await page.evaluate(()=>{window.saved=document.querySelector('[data-indicator]');return document.querySelectorAll('*').length});
   for(const arm of ['before','after']){
    await page.evaluate(a=>fixture.arm(a),arm);await page.waitForTimeout(250);
    await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordContinuously',includedCategories:['toplevel','devtools.timeline','blink','cc']}});const m0=await cdp.send('Performance.getMetrics');await page.waitForTimeout(1100);const m1=await cdp.send('Performance.getMetrics');const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const{stream}=await done;let raw='';try{for(;;){const c=await cdp.send('IO.read',{handle:stream,size:1048576});raw+=c.base64Encoded?Buffer.from(c.data,'base64').toString():c.data;if(c.eof)break}}finally{await cdp.send('IO.close',{handle:stream})}const events=JSON.parse(raw).traceEvents,thread=events.find(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain');const counts={};for(const e of events)if(e.ph==='X'&&e.pid===thread.pid&&e.tid===thread.tid)counts[e.name]=(counts[e.name]||0)+1;const name=family+'-'+arm;await fs.writeFile(path.join(artifact,name+'.trace.json'),raw);result.samples.push({name,nodes:saved,sameNode:await page.evaluate(()=>saved===document.querySelector('[data-indicator]')),paint:counts.Paint||0,prePaint:counts.PrePaint||0,lifecycle:counts['LocalFrameView::RunPaintLifecyclePhase']||0,metrics:Object.fromEntries(m1.metrics.filter(m=>['ThreadTime','ScriptDuration','LayoutDuration','RecalcStyleDuration'].includes(m.name)).map(m=>[m.name,m.value-m0.metrics.find(b=>b.name===m.name).value]))});
   }
  }
 }
 if(suite==='behavior'||suite==='all'){
  result.behavior=[];await page.evaluate(()=>{fixture.gallery('after');window.savedOwner=document.getElementById('owner');window.savedIndicators=[...document.querySelectorAll('[data-indicator]')];document.querySelector('textarea').value='Owned draft retained'});
  await page.locator('#hide').click();await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState==='paused'));
  result.behavior.push({name:'hidden pauses all recurring pseudo layers',animations:await page.evaluate(()=>document.getAnimations().length)});
  await page.locator('#show').click();await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState==='running'));
  const retained=await page.evaluate(()=>({owner:savedOwner===document.getElementById('owner'),indicators:savedIndicators.every((e,i)=>e===document.querySelectorAll('[data-indicator]')[i]),draft:document.querySelector('textarea').value}));assert.deepEqual(retained,{owner:true,indicators:true,draft:'Owned draft retained'});result.behavior.push({name:'show keeps DOM and draft',...retained});
  await page.emulateMedia({reducedMotion:'reduce'});const reduced=await page.evaluate(()=>({hotkeys:[...document.querySelectorAll('.cb-run-after-hotkey-surface')].map(e=>({background:getComputedStyle(e).backgroundColor,before:getComputedStyle(e,'::before').display,after:getComputedStyle(e,'::after').display})),rings:document.getAnimations().filter(a=>a.animationName==='noted-ring-sweep').map(a=>a.playState)}));assert.ok(reduced.hotkeys.every(e=>e.background==='rgba(196, 181, 253, 0.18)'&&e.before==='none'&&e.after==='none'));assert.ok(reduced.rings.length===18&&reduced.rings.every(s=>s==='running'));result.behavior.push({name:'reduced motion preserves hotkey static cue and working rings',...reduced});await page.emulateMedia({reducedMotion:'no-preference'});
  for(const hidden of [false,true]){
   await page.evaluate(()=>{fixture.gallery('after','ring');window.ends=[]});await page.locator(hidden?'#hide':'#show').click();await page.locator('#dismiss').click();await page.waitForFunction(()=>ends.some(e=>e.name==='tab-completion-notification-dismiss'),{timeout:3000});
   const state=await page.evaluate(()=>({ends,opacity:getComputedStyle(document.querySelector('.tab-completion-notification-alert')).opacity,animations:document.querySelector('.tab-completion-notification-alert').getAnimations({subtree:true}).map(a=>({name:a.animationName,pseudo:a.effect.pseudoElement,state:a.playState}))}));assert.equal(state.ends.length,1);assert.equal(state.ends[0].pseudo,'');assert.equal(state.ends[0].elapsed,.42);assert.equal(state.opacity,'0');assert.ok(state.animations.filter(a=>a.name==='noted-ring-sweep').every(a=>a.state===(hidden?'paused':'running')));result.behavior.push({name:'finite dismissal completes with hidden='+hidden,...state});
  }
 }
 result.isolation=await app.evaluate(()=>({visible:win.isVisible(),focused:win.isFocused(),focusEvents:events}));assert.deepEqual(result.isolation,{visible:false,focused:false,focusEvents:[]});assert.deepEqual(result.errors,[]);result.status='pass';
}catch(e){result.status='fail';result.error=e.stack;process.exitCode=1}
finally{if(app){await app.close();result.cleanup.electronClosed=true}await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});result.cleanup.profileRemoved=true;await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({artifact,status:result.status,error:result.error,samples:result.samples,visual:result.visual.map(v=>({family:v.family,phase:v.phase,geometry:v.geometryEqual,worstMean:Math.max(...v.cases.map(c=>c.meanAbs)),worstCase:v.cases.toSorted((a,b)=>b.meanAbs-a.meanAbs)[0]})),cleanup:result.cleanup}));}
