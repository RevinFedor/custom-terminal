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
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-renderer-diagnostics-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/renderer-diagnostics.tsx'),path.join(snapshot,'scripts/fixtures/renderer-diagnostics.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/renderer-diagnostics.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
 define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
 alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
 loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact,'user-data'));
await fs.writeFile(path.join(artifact,'preload.cjs'),`const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
const {createNativePerfMonitor}=require(${JSON.stringify(path.join(snapshot,'src/main/perf-native-metrics.js'))});
const nativeLogs=[];let nativeMonitor;
ipcMain.on('perf:ui-summary',(_e,action)=>nativeMonitor?.sample('ui-action',action));
ipcMain.handle('fixture:invoke',(_e,{channel,args})=>{
 if(channel==='fixture:native')return nativeLogs;
 if(channel==='fixture:baseline')return nativeMonitor.sample('fixture-ready');
 if(channel==='agent:get-send-receipts')return {success:true,records:[]};
 if(channel==='file:read')return{success:true,content:'# File preview\\nBody of the document.',size:40};
 if(channel==='file:exists-batch')return Object.fromEntries(args[0].map(p=>[p,!p.includes('missing')]));
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return[];
 if(channel==='terminal:getCommandStates')return{};
 if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState')return null;
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:1100,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
nativeMonitor=createNativePerfMonitor({webContents:w.webContents,log:s=>nativeLogs.push(s)});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});

const result={artifact,checks:[],errors:[]};const logs=[];let page;
try{
 page=await app.firstWindow();page.setDefaultTimeout(16000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.locator('[data-probe-action]').waitFor();
 await page.waitForFunction(async()=>{
  const logs=await window.require('electron').ipcRenderer.invoke('fixture:native');
  return logs.some(s=>s.startsWith('[Perf:NativeWindow]'));
 });
 await page.getByLabel('Private draft').fill('DO-NOT-LOG-PRIVATE-DRAFT');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.evaluate(()=>window.require('electron').ipcRenderer.invoke('fixture:baseline'));
 await page.locator('[data-probe-action]').click();
 await page.locator('[data-probe-done]').waitFor();
 await page.waitForTimeout(1200); // observation interval, not readiness/behavior
 const actions=logs.filter(s=>s.startsWith('[Perf:UIAction]')).map(s=>{const begin=s.indexOf('{');const end=s.lastIndexOf('}');return JSON.parse(s.slice(begin,end+1));});
 const click=actions.find(a=>a.event==='click'&&a.target.source.includes('diagnostic-action.tsx')&&a.kind==='second-frame');
 assert.ok(click,'removed button must keep captured source');
 assert.ok(click.durationMs>=150);assert.ok(click.phases.some(p=>p.name==='fixture-known-cpu-end'&&p.ms>=150));
 assert.ok(click.styles?.added.some(s=>s.source.includes('diagnostic-style.tsx')),'nested stylesheet insertion must be attributed without scanning the retained DOM');
 result.checks.push('known long action, removed source target, two-frame outcome and stylesheet mutation share one action ID');
 result.native=await page.evaluate(()=>window.require('electron').ipcRenderer.invoke('fixture:native'));
 const counters=result.native.filter(s=>s.startsWith('[Perf:NativeWindow]')).map(s=>JSON.parse(s.slice(s.indexOf('{'))));
 assert.ok(counters.some(c=>c.ScriptDurationMs>=100),'native counters retain known JS busy work');
 assert.ok(counters.some(c=>c.RecalcStyleDurationMs>=30),'native counters independently identify retained restyle');
 const nativeAction=result.native.filter(s=>s.startsWith('[Perf:NativeAction]')).map(s=>JSON.parse(s.slice(s.indexOf('{')))).find(x=>x.action.id===click.id);
 assert.ok(nativeAction?.intervals.some(c=>c.ScriptDurationMs>=100)&&nativeAction?.intervals.some(c=>c.RecalcStyleDurationMs>=30),'the exact action must retain its expensive intervals even after a periodic sample consumed them');
 result.checks.push('actual Electron native counters separate JavaScript from style work and carry the same action ID');
 const draft=await page.getByLabel('Private draft').inputValue();assert.equal(draft,'DO-NOT-LOG-PRIVATE-DRAFT');
 assert.ok(!logs.join('\n').includes(draft));assert.ok(!result.native.join('\n').includes(draft));
 result.checks.push('diagnostics preserve the draft and do not log input text');
 const observerCost=actions.flatMap(a=>a.phases.filter(p=>p.name==='diagnostic-stylesheets').map(p=>p.ms));
 result.observerCost={maxMs:Math.max(...observerCost),samples:observerCost.length};
 assert.ok(result.observerCost.maxMs<10,'stylesheet observer must stay below a frame budget');
 result.click=click;result.counters=counters;
 await page.locator('[data-probe-reset]').click();await page.locator('[data-probe-action]').waitFor();
 await page.mouse.wheel(0,100);
 await page.waitForTimeout(100);
 assert.ok(logs.some(s=>s.startsWith('[Perf:UIAction]')&&s.includes('"event":"wheel"')),'wheel bursts share the diagnostic action path without changing the gesture');
 result.checks.push('wheel bursts receive bounded action/frame diagnostics too');
 assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.pass=false;result.failure=String(error);process.exitCode=1;}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});}
console.log(JSON.stringify({artifact,pass:result.pass,checks:result.checks,observerCost:result.observerCost,failure:result.failure,errors:result.errors}));
