#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-working-tail-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
if(process.env.NOTED_WORKING_TAIL_BASELINE==='1'){
 const file='src/renderer/components/Workspace/HistoryPanel.tsx';
 await fs.writeFile(path.join(snapshot,file),execFileSync('git',['show','HEAD:'+file],{cwd:repo,maxBuffer:8*1024*1024}));
}
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-working-tail.tsx'),path.join(snapshot,'scripts/fixtures/history-working-tail.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'../noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-working-tail.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
 define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
 alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
 loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact,'user-data'));
await fs.writeFile(path.join(artifact,'preload.cjs'),`const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
ipcMain.handle('fixture:invoke',(_e,{channel,args})=>{
 if(channel==='file:read')return{success:true,content:'# File preview\\nBody of the document.',size:40};
 if(channel==='file:exists-batch')return Object.fromEntries(args[0].map(p=>[p,!p.includes('missing')]));
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return[];
 if(channel==='terminal:getCommandStates')return{};
 if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState')return null;
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:720,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,checks:[],errors:[],problems:[]};const logs=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.ready);
 await page.waitForSelector('[data-virtuoso-scroller]');
 const sample=()=>page.evaluate(()=>{const s=document.querySelector('[data-virtuoso-scroller]');return {top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,gap:s.scrollHeight-s.scrollTop-s.clientHeight,timer:!!document.querySelector('[data-history-tail-response-timer][data-placement="tail"]')};});
 const bottom=async()=>{await page.evaluate(()=>window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom',{detail:{tabId:window.fixture.tabId}})));await page.waitForFunction(()=>{const s=document.querySelector('[data-virtuoso-scroller]');return s.scrollHeight-s.scrollTop-s.clientHeight<=2;});await page.waitForTimeout(350);};
 await bottom();result.initial=await sample();
 await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));
 await page.waitForSelector('[data-history-tail-response-timer][data-state="running"]');await page.waitForTimeout(400);
 result.appear=await sample();
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(350);
 result.removed=await sample();
 await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));await page.waitForTimeout(400);
 result.reappear=await sample();
 if(result.appear.gap>4||result.reappear.gap>4)result.problems.push('Working-only growth loses the physical bottom');
 result.checks.push('Working add/remove/reappear stays at bottom');
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(350);await bottom();
 await page.evaluate(()=>window.fixture.paste(true));await page.waitForSelector('[data-history-tail-response-timer][data-state="running"]');await page.waitForTimeout(200);
 await page.evaluate(()=>{
   window.fixture.frames=[];window.fixture.observe=true;
   const observe=()=>{if(!window.fixture.observe)return;const s=document.querySelector('[data-virtuoso-scroller]');
     window.fixture.frames.push({height:s.scrollHeight,top:s.scrollTop,timer:!!document.querySelector('[data-history-tail-response-timer][data-placement="tail"]')});requestAnimationFrame(observe);};observe();
   window.fixture.holdTiming();window.fixture.setTiming(window.fixture.running());window.fixture.paste(false);
 });
 await page.waitForTimeout(180);result.handoffWaiting=await sample();
 await page.evaluate(()=>window.fixture.releaseTiming());await page.waitForTimeout(350);result.handoffSettled=await sample();
 result.handoffFrames=await page.evaluate(()=>{window.fixture.observe=false;return window.fixture.frames;});
 result.missingWorkingFrames=result.handoffFrames.filter(f=>!f.timer).length;
 result.handoffHeightSpread=Math.max(...result.handoffFrames.map(f=>f.height))-Math.min(...result.handoffFrames.map(f=>f.height));
 if(!result.handoffWaiting.timer||result.missingWorkingFrames>0)result.problems.push('paste-to-agent handoff has an empty Working frame');
 if(result.handoffSettled.gap>4)result.problems.push('paste-to-agent handoff loses the physical bottom');
 delete result.handoffFrames;
 result.checks.push('paste→authoritative activity handoff');
 const scroller=page.locator('[data-virtuoso-scroller]');const b=await scroller.boundingBox();
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.wheel(0,-500);await page.waitForTimeout(300);
 result.up=await sample();assert.ok(result.up.gap>150);
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(300);await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));await page.waitForTimeout(400);
 result.reader=await sample();assert.ok(result.reader.gap>150);assert.ok(Math.abs(result.reader.top-result.up.top)<4);result.checks.push('trusted upward wheel cancels follow through timer changes');
 await page.screenshot({path:path.join(artifact,'final.png')});assert.deepEqual(result.errors,[]);assert.deepEqual(result.problems,[]);result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.stack;process.exitCode=1;await app.firstWindow().then(p=>p.screenshot({path:path.join(artifact,'failure.png')})).catch(()=>{});}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));console.log(JSON.stringify(result));}
