#!/usr/bin/env node
// Fresh CSS animations at exact phases. Actual StatusIcon and status-slot source;
// private Electron/native captures only, no app IPC or provider data.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
const repo=fileURLToPath(new URL('..',import.meta.url));
const arg=k=>process.argv.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);
const baseline=arg('baseline');assert.ok(baseline,'--baseline=path to frozen pre-fix OrchestrationStatusChip.tsx');
const compiledCss=arg('css');assert.ok(compiledCss,'--css=path to exact compiled global CSS');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'noted-orchestration-spinner-'));
const result={artifact:dir,checks:[],errors:[],pairs:[],hashes:{},cleanup:{}};let app;
const hash=s=>createHash('sha256').update(s).digest('hex');
function decl(source,name){const ast=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const node=ast.statements.find(n=>n.name?.text===name);assert.ok(node,name);return node.getText(ast)}
try{
 const file='src/renderer/components/Workspace/OrchestrationStatusChip.tsx';
 const before=await fs.readFile(baseline,'utf8'),after=await fs.readFile(path.join(repo,file),'utf8');
 const slot=await fs.readFile(path.join(repo,'src/renderer/components/Workspace/RequestTrackerRow.tsx'),'utf8');
 const css=await fs.readFile(compiledCss,'utf8'),gate=await fs.readFile(path.join(repo,'src/renderer/styles/presentationAnimations.css'),'utf8');
 result.hashes={before:hash(before),product:hash(after),slot:hash(slot),css:hash(css),gate:hash(gate)};
 for(const[arm,source]of[['old',before],['product',after]])await fs.writeFile(path.join(dir,arm+'.tsx'),`import React from 'react';import{CircleAlert,CircleCheck,Search,Timer,X,LoaderCircle}from'lucide-react';\n${decl(slot,'RequestTrackerStatus')}\nexport ${decl(source,'StatusIcon')}`);
 await fs.writeFile(path.join(dir,'entry.tsx'),`import React,{useState}from'react';import{flushSync}from'react-dom';import{createRoot}from'react-dom/client';import{StatusIcon as Old}from'./old';import{StatusIcon as Product}from'./product';
 const cases=[['loading',true,'#4ade80'],['loading',false,'#60a5fa'],['waiting',false,'#a1a1aa'],['success',false,'#4ade80'],['error',false,'#f87171'],['proof',false,'#fbbf24'],['recovery',false,'#fbbf24'],['cancelled',false,'#a1a1aa']];
 function App(){const[state,setState]=useState({arm:'old',generation:0,hidden:false});window.mountArm=(arm,hidden=false)=>flushSync(()=>setState(s=>({arm,generation:s.generation+1,hidden})));const Icon=state.arm==='old'?Old:Product;
 return <div id="gallery" key={state.generation} data-terminal-pane-wrapper="fixture" data-terminal-surface-presented={state.hidden?'0':'1'}>{cases.map(([icon,spinning,color],i)=><div key={i} className="case" data-case={i} style={{color}}><Icon presentation={{icon,spinning}}/><span>Label {i}</span></div>)}</div>}
 createRoot(document.getElementById('root')).render(<App/>);`);
 await build({entryPoints:[path.join(dir,'entry.tsx')],outfile:path.join(dir,'bundle.js'),bundle:true,platform:'browser',target:'chrome120',jsx:'automatic',nodePaths:[path.join(repo,'node_modules')],logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 await fs.writeFile(path.join(dir,'global.css'),css+'\n'+gate);
 await fs.writeFile(path.join(dir,'index.html'),`<!doctype html><link rel="stylesheet" href="global.css"><style>body{margin:0;background:#1a1a1a}#gallery{display:grid;grid-template-columns:repeat(4,100px);gap:4px;padding:10px;width:440px}.case{display:flex;align-items:center;gap:4px;height:30px;font:12px Arial}.case span{white-space:nowrap}.animate-spin{animation-play-state:paused!important}</style><div id="root"></div><script src="bundle.js"></script>`);
 await fs.writeFile(path.join(dir,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();global.w=new BrowserWindow({show:false,focusable:false,width:650,height:250,webPreferences:{offscreen:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(dir,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[path.join(dir,'main.cjs')],cwd:dir,env});result.pid=app.process().pid;
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await page.waitForFunction(()=>!!window.mountArm);
 for(const zoom of [.75,1,1.5]){await app.evaluate(({BrowserWindow},z)=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z),zoom);
  for(const phase of [0,.125,.25,.5,.75,.999]){
   const captures=[];
   for(const arm of ['old','product']){
    await page.evaluate(({arm,phase})=>{window.mountArm(arm);const list=document.getAnimations();if(list.length!==1)throw Error('one current animation required:'+list.length);window.phaseAnimation=list[0];}, {arm,phase});
    const geometry=await page.evaluate(async phase=>{const a=window.phaseAnimation;await a.ready;a.currentTime=phase*Number(a.effect.getTiming().duration);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(a.playState!=='paused'||document.getAnimations().length!==1)throw Error('fresh paused animation');return [...document.querySelectorAll('.case')].map(el=>{const r=el.getBoundingClientRect(),slot=el.querySelector('[data-request-status-slot]').getBoundingClientRect(),label=el.lastElementChild.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,slot:{x:slot.x,y:slot.y,w:slot.width,h:slot.height},labelX:label.x}})},phase);
    let previous=null,capture;let identical=false;
    for(let i=0;i<6;i++){capture=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));if(capture===previous){identical=true;break}previous=capture;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)))}
    assert.ok(identical,'stable native raster at exact phase');const file=arm+'-'+zoom+'-'+phase+'.png';await fs.writeFile(path.join(dir,file),Buffer.from(capture,'base64'));captures.push({file,geometry});
   }
   assert.deepEqual(captures[0].geometry,captures[1].geometry,'slot/labels/cases retain exact CSS geometry');result.pairs.push({zoom,phase,old:captures[0].file,product:captures[1].file,geometry:captures[1].geometry,viewport:await page.evaluate(()=>({w:innerWidth,h:innerHeight}))});
  }
 }
 await page.evaluate(()=>{const style=document.createElement('style');style.textContent='.animate-spin{animation-play-state:running!important}';document.head.appendChild(style);window.mountArm('product')});
 const visible=await page.evaluate(()=>document.getAnimations().map(a=>({state:a.playState,name:a.animationName,tag:a.effect.target.tagName})));
 assert.equal(visible.length,1);assert.equal(visible[0].state,'running');assert.equal(visible[0].tag,'SPAN');
 await page.evaluate(()=>window.mountArm('product',true));assert.equal(await page.evaluate(()=>document.getAnimations()[0].playState),'paused');
 result.checks.push('visible-unfocused HTML feedback runs; exact hidden owner pauses it','one animation only for executing/loading true; sending and all other glyphs static','same 26x14 status slot, glyph and neighboring label geometry');
 await fs.writeFile(path.join(dir,'pairs.json'),JSON.stringify(result.pairs));
 const script=`import json,sys\nfrom pathlib import Path\nfrom PIL import Image,ImageChops,ImageStat\nr=Path(sys.argv[1]);out=[]\nfor p in json.loads((r/'pairs.json').read_text()):\n a=Image.open(r/p['old']).convert('RGB');b=Image.open(r/p['product']).convert('RGB');assert a.size==b.size;d=ImageChops.difference(a,b);stat=ImageStat.Stat(d);p['meanRgb']=sum(stat.mean)/3;p['caseMeanRgb']=[];sx=a.width/p['viewport']['w'];sy=a.height/p['viewport']['h'];\n for g in p['geometry']:\n  q=g['slot'];box=(round(q['x']*sx),round(q['y']*sy),round((q['x']+q['w'])*sx),round((q['y']+q['h'])*sy));st=ImageStat.Stat(d.crop(box));p['caseMeanRgb'].append(sum(st.mean)/3)\n p['extrema']=stat.extrema;p['diffBBox']=d.getbbox();out.append(p)\n(r/'pixels.json').write_text(json.dumps(out,indent=2));print(json.dumps({'pairs':len(out),'maxMeanRgb':max(x['meanRgb'] for x in out),'maxSlotMeanRgb':max(max(x['caseMeanRgb']) for x in out),'different':sum(x['diffBBox'] is not None for x in out)}))\n`;
 await fs.writeFile(path.join(dir,'compare.py'),script);result.pixels=JSON.parse(execFileSync('python3',[path.join(dir,'compare.py'),dir],{encoding:'utf8'}));
 assert.ok(result.pixels.maxSlotMeanRgb<=3,'native status-slot pixels remain equivalent at every phase');
 for(const arm of ['old','product'])for(const zoom of [.75,1,1.5])assert.notEqual(hash(await fs.readFile(path.join(dir,arm+'-'+zoom+'-0.png'))),hash(await fs.readFile(path.join(dir,arm+'-'+zoom+'-0.25.png'))),'phase changes visible pixels');assert.deepEqual(result.errors,[]);result.pass=true;
}catch(e){result.pass=false;result.error=String(e.stack||e);process.exitCode=1}
finally{if(app)await app.close();await fs.rm(path.join(dir,'profile'),{recursive:true,force:true});result.cleanup={closed:true,profileRemoved:true};await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({artifact:dir,pass:result.pass,pixels:result.pixels,error:result.error}))}
