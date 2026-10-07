#!/usr/bin/env node
// Bounded actual-component visual proof. The baseline must be a frozen source
// tree from BEFORE this repair; never compare a replacement with itself.
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
const baseline = process.argv.find(x => x.startsWith('--baseline='))?.slice(11);
const measurementOnly = process.argv.includes('--measure-only');
const measurementControl = process.argv.includes('--measure-no-deps-control');
const unbatchedTickControl = process.argv.includes('--measure-unbatched-tick-control');
const deferredResizeControl = process.argv.includes('--measure-deferred-resize-control');
assert.ok(baseline, 'Pass --baseline=<frozen pre-repair tree>');
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-text-shimmer-'));
const snapshot = path.join(artifact, 'source'); await fs.mkdir(snapshot);
const hash = text => createHash('sha256').update(text).digest('hex');
const result = { artifact, baseline, sourceHashes: {}, baselineHashes: {}, visual: [], checks: [], errors: [], cleanup: {}, boundary: 'Exact extracted History timer/spinner, actual CompositedTextShimmer, exact naming wrapper and authored CSS; no provider, PTY, app IPC, production, or OS input. Visual pixel/geometry proof, not a CPU benchmark.' };
result.driverHash = hash(await fs.readFile(fileURLToPath(import.meta.url)));
result.measurementOnly = measurementOnly;
result.measurementControl = measurementControl;
result.unbatchedTickControl = unbatchedTickControl;
result.deferredResizeControl = deferredResizeControl;
const read = async (file, old = false) => {
  const value = await fs.readFile(path.join(old ? baseline : repo, file), 'utf8');
  (old ? result.baselineHashes : result.sourceHashes)[file] = hash(value); return value;
};
function declaration(source, name) {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = ast.statements.find(s => s.name?.text === name || ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(ast) === name));
  assert.ok(found, name); return found.getText(ast);
}
function styles(history) {
  const start = history.indexOf('const historyPanelStyleText = `') + 'const historyPanelStyleText = `'.length;
  return history.slice(start, history.indexOf('`;', start));
}
function namingWrapper(source) {
  const ast=ts.createSourceFile('TabBar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;
  const visit=n=>{if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.text==='className'&&a.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text==='tab-title-naming-frame'))found=n.getText(ast);ts.forEachChild(n,visit)};
  visit(ast);assert.ok(found,'actual naming callsite');return found;
}
let app;
try {
  const hpFile = 'src/renderer/components/Workspace/HistoryPanel.tsx';
  const hp = await read(hpFile), oldHp = await read(hpFile, true);
  assert.ok(oldHp.includes('@keyframes hp-history-working-shimmer'), 'pre-repair baseline');
  const globals = await read('src/renderer/styles/globals.css', true);
  const naming = postcss.parse(globals).nodes.filter(n => n.type === 'rule' && n.selector.startsWith('.tab-title-naming') || n.type === 'atrule' && n.name === 'keyframes' && n.params === 'tab-title-naming-sweep').map(n => n.toString()).join('\n');
  for (const name of ['CompositedTextShimmer.tsx', 'compositedTextShimmer.css']) {
    let source = await read('src/renderer/components/UI/' + name);
    if (name === 'CompositedTextShimmer.tsx' && (measurementControl || unbatchedTickControl)) {
      assert.ok(source.includes('}, [children, variant, className]);'));
      if (measurementControl) source = source.replace('}, [children, variant, className]);', '});');
      // Deliberately restore unconditional immediate geometry work in this
      // PRIVATE control only; source and the paired product stay unchanged.
      source = source.replace('const previous = previousRef.current;', 'const previous = null;');
    }
    if(name==='CompositedTextShimmer.tsx'&&deferredResizeControl){
      assert.ok(source.includes('measureMasks(Array.from(tasks));'));
      source=source.replace('measureMasks(Array.from(tasks));','for (const task of tasks) enqueueMaskMeasurement(task);');
    }
    await fs.writeFile(path.join(snapshot, name), source);
  }
  await fs.writeFile(path.join(snapshot, 'historyResponseTiming.mjs'), await read('src/renderer/utils/historyResponseTiming.mjs'));
  await fs.writeFile(path.join(snapshot, 'gate.css'), await read('src/renderer/styles/presentationAnimations.css'));
  await fs.writeFile(path.join(snapshot, 'naming.css'), naming);
  await fs.writeFile(path.join(snapshot, 'old.css'), styles(oldHp));
  await fs.writeFile(path.join(snapshot, 'current.css'), styles(hp));
  // A private web-font face verifies that the mask uses the page's loaded
  // font, rather than silently substituting a font inside a data:image SVG.
  const fontFile = '/System/Library/Fonts/Supplemental/Arial Narrow.ttf';
  const font = await fs.readFile(fontFile);
  result.sourceHashes[fontFile] = hash(font);
  await fs.writeFile(path.join(artifact, 'font.ttf'), font);
  for (const [name, source] of [['Old', oldHp], ['Current', hp]]) {
    await fs.writeFile(path.join(snapshot, name + '.tsx'), `import React,{memo,useState,useEffect}from'react';import{CompositedTextShimmer}from'./CompositedTextShimmer';import{historyResponseTailLabel,formatHistoryResponseCompletedAt}from'./historyResponseTiming.mjs';\n${declaration(source, 'HistoryResponseTailTimer')}\n${declaration(source, 'HistorySpinner')}\nexport{HistoryResponseTailTimer,HistorySpinner};`);
  }
  for(const [name,old] of [['Old',true],['Current',false]]){
    const namingSource=await read('src/renderer/components/Workspace/TabBar.tsx',old);
    await fs.writeFile(path.join(snapshot,name+'Naming.tsx'),`import React from'react';import{CompositedTextShimmer}from'./CompositedTextShimmer';export function Naming(){const tab={name:'Reserved title'};return(${namingWrapper(namingSource)})}`);
  }
  await fs.writeFile(path.join(snapshot, 'fixture.tsx'), `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{HistoryResponseTailTimer as OldTimer,HistorySpinner as OldSpinner}from'./Old';import{HistoryResponseTailTimer as Timer,HistorySpinner as Spinner}from'./Current';import{CompositedTextShimmer}from'./CompositedTextShimmer';
import{Naming as OldNaming}from'./OldNaming';import{Naming}from'./CurrentNaming';
const root=createRoot(document.getElementById('fixture'));window.realNow=Date.now;window.testNow=1791000000000;Date.now=()=>window.testNow;const startTs=window.testNow-87000;
const NativeRO=window.ResizeObserver;window.roCounts={created:0,closed:0};window.ResizeObserver=class extends NativeRO{constructor(cb){super(cb);window.roCounts.created++}disconnect(){window.roCounts.closed++;super.disconnect()}};
window.measureReads={boxes:0,lengths:0,maskWrites:0,redundantMaskWrites:0};window.recordGeometry=false;window.geometryEvents=[];const nativeRect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){if(this.classList.contains('noted-text-shimmer')||this.classList.contains('noted-text-shimmer__baseline')){window.measureReads.boxes++;if(window.recordGeometry)window.geometryEvents.push({kind:'read',owner:this.closest('[data-case]')?.dataset.case})}return nativeRect.call(this)};
const nativeLength=SVGTextContentElement.prototype.getComputedTextLength;SVGTextContentElement.prototype.getComputedTextLength=function(){window.measureReads.lengths++;return nativeLength.call(this)};
const nativeAttribute=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if((this instanceof SVGMaskElement||this instanceof SVGTextElement)&&['width','height','y'].includes(name)&&this.closest('.noted-text-shimmer')){window.measureReads.maskWrites++;if(this.getAttribute(name)===String(value))window.measureReads.redundantMaskWrites++;if(window.recordGeometry)window.geometryEvents.push({kind:'write',owner:this.closest('[data-case]')?.dataset.case,name})}return nativeAttribute.call(this,name,value)};
window.fontLoadEvents=0;document.fonts.addEventListener('loadingdone',()=>window.fontLoadEvents++);
const cases=[12,14,22,32].flatMap(font=>['Arial','monospace','FixtureWebFont'].map(family=>({font,family})));let serial=0;
function Gallery({old,hidden,completed}){const T=old?OldTimer:Timer,S=old?OldSpinner:Spinner,N=old?OldNaming:Naming;return <div id="gallery" data-terminal-pane-wrapper="test-owner" data-terminal-surface-presented={hidden?'0':'1'}>
{cases.map(({font,family},i)=><div className="cell" key={i} data-case={'working-'+font+'-'+family} style={{fontSize:font,fontFamily:family}}><T timing={{state:completed?'completed':'running',startTs,intervalId:1,endTs:completed?window.testNow:null,durationMs:completed?window.testNow-startTs:null}}/></div>)}
{cases.map(({font,family},i)=><div className="cell" key={'n'+i} data-case={'naming-'+font+'-'+family} style={{fontSize:font,fontFamily:family,'--naming-fixture-width':(i%2===0?58:210)+'px'}}><N/></div>)}
{[10,14,28].map(size=><div className="cell" key={'s'+size} data-case={'spinner-'+size}><S size={size}/></div>)}
</div>}
function App(){const[state,setState]=useState({old:true,key:serial,hidden:false,completed:false,parentCommits:0});window.fixture={gallery(old,initiallyPaused=false){document.getElementById('visual-pause').textContent=initiallyPaused?'#gallery *,#gallery *::before,#gallery *::after{animation-play-state:paused!important}':'';document.querySelector('#old-css').disabled=!old;document.querySelector('#current-css').disabled=old;flushSync(()=>setState({old,key:++serial,hidden:false,completed:false,parentCommits:0}))},parents(count){for(let i=0;i<count;i++)flushSync(()=>setState(s=>({...s,parentCommits:s.parentCommits+1})))},hide(hidden){flushSync(()=>setState(s=>({...s,hidden})))},finish(){flushSync(()=>setState(s=>({...s,completed:true})))},tick(ms){window.testNow+=ms},now(){return window.testNow}};return <><button id="toggle" onClick={()=>window.fixture.hide(!state.hidden)}>Toggle</button><Gallery {...state} key={state.key}/></>};flushSync(()=>root.render(<App/>));`);
  await build({ entryPoints: [path.join(snapshot, 'fixture.tsx')], outfile: path.join(artifact, 'bundle.js'), bundle: true, platform: 'browser', target: 'chrome120', nodePaths: [path.join(repo, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', sourcemap: true });
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><style id="visual-pause"></style><link rel="stylesheet" href="source/naming.css"><link id="old-css" rel="stylesheet" href="source/old.css"><link id="current-css" disabled rel="stylesheet" href="source/current.css"><link rel="stylesheet" href="bundle.css"><link rel="stylesheet" href="source/gate.css"><style>@font-face{font-family:FixtureWebFont;src:url(font.ttf)}body{margin:0;background:#18181b;color:#ddd;font:600 14px/1.45 Arial}#gallery{display:grid;grid-template-columns:repeat(3,360px);gap:0;padding:10px}.cell{height:80px;display:flex;align-items:center;padding:12px;box-sizing:border-box;overflow:hidden}.tab-title-naming-frame{background:#24372d;width:var(--naming-fixture-width)}button{color:#ddd;background:#333}@keyframes spinner-rotate{to{transform:rotate(360deg)}}</style><div id="fixture"></div><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();const win=global.win=new BrowserWindow({width:1110,height:840,show:false,focusable:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true}});win.webContents.setFrameRate(60);win.loadFile(${JSON.stringify(path.join(artifact,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
  console.log(JSON.stringify({artifact,stage:'start'}));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  const page = await app.firstWindow(); page.on('pageerror', e => result.errors.push(e.message));
  await page.waitForFunction(() => !!window.fixture);
  await page.evaluate(() => document.fonts.ready);
  const acknowledgeVisualPaint = () => app.evaluate(() => new Promise((resolve, reject) => {
    const wc = global.win.webContents;
    const start = Date.now();
    const paint = (_event, dirtyRect, image) => {
      clearTimeout(timeout);
      resolve({ acknowledged: true, elapsedMs: Date.now() - start, dirtyRect, imageSize: image.getSize() });
    };
    const timeout = setTimeout(() => {
      wc.removeListener('paint', paint);
      reject(new Error('phase native paint acknowledgement timeout'));
    }, 3000);
    wc.once('paint', paint);
    wc.invalidate();
  }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const phase of measurementOnly ? [] : [0, .25, .5, 9/13, .75, .999]) {
    const shots = [];
    for (const old of [true, false]) {
      // CSS is paused before fresh nodes mount: the first GPU raster must not
      // depend on how far its animation advanced before the driver reached it.
      await page.evaluate(old => window.fixture.gallery(old, true), old);
      await page.waitForFunction(() => document.querySelectorAll('[data-case]').length === 27);
      const animationReady = await page.evaluate(async phase => {
        const animations = document.getAnimations();
        for (const a of animations) a.pause();
        await Promise.all(animations.map(a => a.ready));
        for (const a of animations) a.currentTime = phase * a.effect.getTiming().duration;
        return { resolved: true, count: animations.length, phase };
      }, phase);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // A native paint acknowledgement alone can still precede a compositor
      // phase update. Require two consecutive identical PNGs, independent of
      // the other arm/reference. Bound captures; never relax pixel tolerance.
      const captureProof = [];
      let previousPng, png, stable = false;
      for (let capture = 0; capture < 8; capture++) {
        const nativePaint = await acknowledgeVisualPaint();
        png = await page.locator('#gallery').screenshot({ animations: 'allow' });
        captureProof.push({ capture: capture + 1, nativePaint, sha256: hash(png) });
        if (previousPng?.equals(png)) { stable = true; break; }
        previousPng = png;
      }
      assert.equal(stable, true, 'two consecutive matching phase PNGs within eight captures');
      const proof = await page.evaluate(() => [...document.querySelectorAll('[data-case]')].map(el => ({ name: el.dataset.case, rect: el.getBoundingClientRect().toJSON(), labelRect: el.firstElementChild.getBoundingClientRect().toJSON(), text: el.textContent, mask: el.querySelector('text')?.textContent, animations: el.getAnimations({subtree:true}).map(a => ({name:a.animationName,state:a.playState,time:a.currentTime,duration:a.effect.getTiming().duration,target:a.effect.target.tagName})) })));
      assert.ok(proof.every(x => x.animations.length === 1 && x.animations[0].state === 'paused' && Math.abs(x.animations[0].time - phase*x.animations[0].duration) < .01), 'one CURRENT paused animation per fresh node');
      const file = `phase-${phase}-${old?'baseline':'product'}.png`; await fs.writeFile(path.join(artifact, file), png);
      shots.push({ file, proof, initiallyCssPaused: true, animationReady, captureProof, stable, bounds: await page.locator('#gallery').boundingBox(), base64: png.toString('base64') });
    }
    const compare = await app.evaluate(({ nativeImage }, shots) => {
      const a=nativeImage.createFromBuffer(Buffer.from(shots[0].base64,'base64')),b=nativeImage.createFromBuffer(Buffer.from(shots[1].base64,'base64'));const size=a.getSize(), av=a.toBitmap(), bv=b.toBitmap(), scale=size.width/shots[0].bounds.width;
      return {sameSize:JSON.stringify(size)===JSON.stringify(b.getSize()),cases:shots[0].proof.map((c,j)=>{let sum=0,count=0,changed=0,max=0;const l=c.labelRect;const r={x:l.x-4,y:l.y-4,width:l.width+8,height:l.height+8};
        for(let y=Math.ceil((r.y-shots[0].bounds.y)*scale);y<Math.floor((r.y-shots[0].bounds.y+r.height)*scale);y++)for(let x=Math.ceil((r.x-shots[0].bounds.x)*scale);x<Math.floor((r.x-shots[0].bounds.x+r.width)*scale);x++)for(let channel=0;channel<3;channel++){const k=(y*size.width+x)*4+channel,d=Math.abs(av[k]-bv[k]);sum+=d;max=Math.max(max,d);count++;if(d>2)changed++;}
        const q=shots[1].proof[j].labelRect;return{name:c.name,mean:sum/count,max,changed:changed/count,geometryEqual:JSON.stringify(l)===JSON.stringify(q)};})};
    },shots);
    result.visual.push({phase,...compare,shots:shots.map(({base64,...r})=>r)});
    console.log(JSON.stringify({phase,worst:Math.max(...compare.cases.map(c=>c.mean)),geometry:compare.cases.every(c=>c.geometryEqual)}));
  }
  await page.evaluate(() => window.fixture.gallery(false));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  result.parentCommitMeasurements = await page.evaluate(() => {
    const before = {...window.measureReads};
    window.fixture.parents(40);
    const after = {...window.measureReads};
    return { commits: 40, before, after, delta: { boxes: after.boxes-before.boxes, lengths: after.lengths-before.lengths, maskWrites:after.maskWrites-before.maskWrites } };
  });
  assert.deepEqual(result.parentCommitMeasurements.delta,{boxes:0,lengths:0,maskWrites:0},'unrelated parent commits do not measure labels');
  result.checks.push({name:'40 unrelated ancestor commits cause zero box/text-length reads'});
  const beforeObservers = await page.evaluate(() => window.roCounts.created);
  const before = await page.locator('[data-case="working-14-Arial"]').textContent();
  const beforeTickGeometry = await page.evaluate(() => ({...window.measureReads}));
  await page.evaluate(() => window.fixture.tick(1000));
  await page.waitForFunction(before => document.querySelector('[data-case="working-14-Arial"]').textContent !== before, before);
  result.checks.push({name:'one-second timer changes actual label',before,after:await page.locator('[data-case="working-14-Arial"]').textContent()});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  result.sameWidthTickMeasurements = await page.evaluate(before => {
    const after={...window.measureReads};return{before,after,delta:Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]]))};
  }, beforeTickGeometry);
  assert.deepEqual(result.sameWidthTickMeasurements.delta,{boxes:0,lengths:0,maskWrites:0,redundantMaskWrites:0},'one-second same-width timer updates need no geometry or SVG attribute write');
  assert.equal(await page.evaluate(() => window.roCounts.created),beforeObservers,'timer keeps its existing observers');
  await page.evaluate(() => {
    window.rolloverBeforePaint=null;
    const root=document.querySelector('[data-case="working-14-Arial"] .noted-text-shimmer'),width=root.getBoundingClientRect().width;
    const observer=new ResizeObserver(entries=>{
      if(entries[0].contentRect.width===width)return;
      observer.disconnect();window.rolloverBeforePaint={observedWidth:entries[0].contentRect.width,maskWidth:Number(root.querySelector('mask').getAttribute('width')),glyph:root.querySelector('text').textContent};
    });observer.observe(root);
  });
  const beforeRolloverGeometry = await page.evaluate(() => {window.geometryEvents=[];window.recordGeometry=true;return{...window.measureReads}});
  await page.evaluate(() => window.fixture.tick(3514000));
  await page.waitForFunction(() => document.querySelector('[data-case="working-14-Arial"] .noted-text-shimmer__source').textContent.includes('1:00:02'));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-case^="working-"]')].every(el => el.querySelector('text').textContent===el.querySelector('.noted-text-shimmer__source').textContent)), 'hour rollover also updates mask');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  result.rolloverMeasurements = await page.evaluate(before => {
    window.recordGeometry=false;const after={...window.measureReads};return{before,after,events:window.geometryEvents,delta:Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]]))};
  },beforeRolloverGeometry);
  assert.equal(result.rolloverMeasurements.delta.lengths,0);assert.equal(result.rolloverMeasurements.delta.redundantMaskWrites,0);
  assert.ok(result.rolloverMeasurements.delta.boxes>0&&result.rolloverMeasurements.delta.maskWrites>0,'real width changes update the mask');
  await page.waitForFunction(() => window.rolloverBeforePaint!==null);
  result.rolloverBeforePaint = await page.evaluate(() => window.rolloverBeforePaint);
  assert.equal(result.rolloverBeforePaint.maskWidth,result.rolloverBeforePaint.observedWidth,'first growing-row RO delivery already has the complete new mask before paint');
  result.checks.push({name:'hour rollover keeps native width and current glyphs without new observers'});
  result.resizeMeasurements = await page.evaluate(async () => {
    const el=document.querySelector('[data-case="naming-14-Arial"]');
    const mask=el.querySelector('mask'), before=Number(mask.getAttribute('width'));
    const readsBefore={...window.measureReads};el.style.setProperty('--naming-fixture-width','58px');
    for(let frame=0;frame<8&&Number(mask.getAttribute('width'))!==58;frame++)await new Promise(requestAnimationFrame);
    return {before,after:Number(mask.getAttribute('width')),boxReads:window.measureReads.boxes-readsBefore.boxes,textLengthReads:window.measureReads.lengths-readsBefore.lengths,glyph:el.querySelector('text').textContent};
  });
  assert.equal(result.resizeMeasurements.after,58);assert.ok(result.resizeMeasurements.before>58&&result.resizeMeasurements.boxReads>0&&result.resizeMeasurements.textLengthReads>0);
  result.fontLoadMeasurements = await page.evaluate(async () => {
    const el=document.querySelector('[data-case="working-14-Arial"]');const mask=el.querySelector('mask'),glyph=el.querySelector('text');
    mask.setAttribute('width','1');glyph.setAttribute('y','-1000');
    const eventsBefore=window.fontLoadEvents,readsBefore={...window.measureReads};
    const face=new FontFace('LateShimmerFace','url(font.ttf?late=1)');document.fonts.add(face);
    await document.fonts.load('14px LateShimmerFace');await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {fontEvents:window.fontLoadEvents-eventsBefore,boxReads:window.measureReads.boxes-readsBefore.boxes,width:Number(mask.getAttribute('width')),baselineY:Number(glyph.getAttribute('y'))};
  });
  assert.ok(result.fontLoadMeasurements.fontEvents>0&&result.fontLoadMeasurements.boxReads>0&&result.fontLoadMeasurements.width>1&&result.fontLoadMeasurements.baselineY>0,'actual font loadingdone remeasures an unchanged-size label');
  result.checks.push({name:'local resize and real font load remeasure without parent renders'});
  result.inactiveMeasurements = await page.evaluate(async () => {
    const gallery=document.getElementById('gallery');gallery.style.display='none';await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const before={...window.measureReads};const face=new FontFace('InactiveShimmerFace','url(font.ttf?inactive=1)');document.fonts.add(face);await document.fonts.load('14px InactiveShimmerFace');await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const after={...window.measureReads};gallery.style.display='';await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return{before,after,delta:Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]])),shownMasks:[...document.querySelectorAll('.noted-text-shimmer mask')].every(m=>Number(m.getAttribute('width'))>0&&Number(m.querySelector('text').getAttribute('y'))>0)};
  });
  assert.equal(result.inactiveMeasurements.delta.lengths,0);assert.equal(result.inactiveMeasurements.delta.maskWrites,0);assert.equal(result.inactiveMeasurements.shownMasks,true);
  result.checks.push({name:'inactive zero-size masks skip SVG work; visible masks are restored through RO'});
  await page.locator('#toggle').click();
  assert.ok(await page.evaluate(() => document.getAnimations().every(a => a.playState === 'paused')), 'hidden presentation pauses all');
  await page.locator('#toggle').click();
  assert.ok(await page.evaluate(() => document.getAnimations().every(a => a.playState === 'running')), 'visible unfocused feedback resumes');
  result.checks.push({name:'trusted hide/show preserves mounted visual feedback'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  result.reducedMotionNativePaint = await acknowledgeVisualPaint();
  result.reducedMotion = await page.locator('[data-case="working-14-Arial"]').screenshot({path:path.join(artifact,'reduced-motion.png')}).then(()=>true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(() => window.fixture.finish());
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-case^="working-"]')].every(el => !el.querySelector('.noted-text-shimmer') && el.getAnimations({subtree:true}).length===0 && el.textContent.startsWith('Worked'))),'completed labels are ordinary unchanged text');
  result.checks.push({name:'completed state removes running animation and keeps Worked/completed-at'});
  result.firstVisibleGeometry = await page.evaluate(async () => {
    const host=document.getElementById('fixture');host.style.display='none';window.fixture.gallery(false);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const root=document.querySelector('[data-case="working-14-Arial"] .noted-text-shimmer'),mask=root.querySelector('mask');
    const before={width:mask.getAttribute('width'),height:mask.getAttribute('height'),baselineY:mask.querySelector('text').getAttribute('y')};
    const firstPositiveDelivery=await new Promise((resolve,reject)=>{
      const observer=new ResizeObserver(entries=>{if(entries[0].contentRect.width<=0)return;clearTimeout(timeout);observer.disconnect();resolve({width:Number(mask.getAttribute('width')),height:Number(mask.getAttribute('height')),baselineY:Number(mask.querySelector('text').getAttribute('y'))})});
      const timeout=setTimeout(()=>{observer.disconnect();reject(Error('first visible mask timeout'))},3000);
      // This observer is registered AFTER the real helper observer. Its first
      // positive-size callback still runs before paint, so a deferred first
      // mask update would be visible here as missing/zero geometry.
      observer.observe(root);host.style.display='';
    });return{before,firstPositiveDelivery};
  });
  assert.equal(result.firstVisibleGeometry.before.width,null);
  assert.ok(Object.values(result.firstVisibleGeometry.firstPositiveDelivery).every(v=>v>0),'first visible RO phase already has usable glyph geometry');
  result.checks.push({name:'first visible pre-paint RO delivery contains the finished mask'});
  result.loadedFontSwap = await page.evaluate(async () => {
    const cell=document.querySelector('[data-case="naming-14-Arial"]');cell.style.setProperty('--naming-fixture-width','58px');cell.style.lineHeight='24px';cell.style.fontFamily='Arial';
    const root=cell.querySelector('.noted-text-shimmer'),glyph=root.querySelector('text'),probe=root.querySelector('.noted-text-shimmer__baseline');
    for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
    const state=()=>{const box=root.getBoundingClientRect();return{width:box.width,height:box.height,actualBaseline:probe.getBoundingClientRect().top-box.top,maskBaseline:Number(glyph.getAttribute('y')),font:getComputedStyle(root).fontFamily,glyph:glyph.textContent}};
    const before=state(),fontEvents=window.fontLoadEvents,samples=[];
    for(const family of ['monospace','FixtureWebFont']){
      cell.style.fontFamily=family;for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
      // Fresh native glyph probe in <defs>, outside the visible mask. This
      // checks ellipsis as well as baseline without mutating the real label.
      const probeGlyph=glyph.cloneNode(true);root.querySelector('defs').appendChild(probeGlyph);const full='naming...';let end=full.length;probeGlyph.textContent=full;
      while(end>0&&probeGlyph.getComputedTextLength()>58)probeGlyph.textContent=full.slice(0,--end)+'…';
      const expectedGlyph=probeGlyph.textContent;probeGlyph.remove();samples.push({...state(),expectedGlyph});
    }
    return{before,after:state(),samples,fontLoadEvents:window.fontLoadEvents-fontEvents};
  });
  assert.equal(result.loadedFontSwap.fontLoadEvents,0);
  assert.equal(result.loadedFontSwap.before.width,result.loadedFontSwap.after.width);assert.equal(result.loadedFontSwap.before.height,result.loadedFontSwap.after.height);
  assert.equal(result.loadedFontSwap.after.maskBaseline,result.loadedFontSwap.after.actualBaseline,'already-loaded font swap in fixed naming box follows actual native baseline');
  assert.ok(result.loadedFontSwap.samples.every(s=>s.glyph===s.expectedGlyph),'already-loaded font swap recomputes native ellipsis inside fixed box');
  result.checks.push({name:'already-loaded font swap in a fixed58px naming box updates baseline without loadingdone'});
  assert.deepEqual(result.errors, []);
  result.visualEquivalent=measurementOnly?null:result.visual.every(v=>v.sameSize && v.cases.every(c=>c.geometryEqual && c.mean<=3));
  if(!measurementOnly)assert.equal(result.visualEquivalent,true,'tight label ROI mean channel difference <=3/255 and identical geometry');
  result.status='pass';
} catch(error) { result.status='fail'; result.error=error.stack; process.exitCode=1; }
finally {
  if(app){await app.close();result.cleanup.electronClosed=true;}
  await fs.rm(snapshot,{recursive:true,force:true});result.cleanup.snapshotRemoved=true;
  await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});result.cleanup.profileRemoved=true;
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,artifact,error:result.error,cleanup:result.cleanup}));
}
