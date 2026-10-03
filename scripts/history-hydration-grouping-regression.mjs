#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-history-hydration-grouping-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
process.on('exit',()=>{try{execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});}catch{}});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-hydration-grouping.tsx'),path.join(snapshot,'scripts/fixtures/history-hydration-grouping.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const {applyHistoryRowWindow}=require(path.join(snapshot,'src/main/history-entry-window.js'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'../noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
const stamp=(i)=>new Date(Date.UTC(2026,8,1,0,0,i)).toISOString();
const rows=Array.from({length:200},(_,i)=>({uuid:'row-'+i,role:i%2?'assistant':'user',sessionId:'hydration-grouping-session',
 sourceIdentity:'source-'+i,timestamp:stamp(i),content:i%2?'Earlier answer. '.repeat(16):'Earlier question '+i}));
for(let i=80;i<140;i++)rows[i]=i%3===2?{...rows[i],role:'assistant',textPhase:'commentary',content:'Checking the requested file. '}:
 {...rows[i],role:'assistant',content:'',actions:[{tool:'__raw__',rawTool:{toolUseId:'call-'+i,toolName:'Read',family:'read',
 args:{file_path:'/synthetic/a.ts'},result:'Done'}}]};
rows[189]={...rows[189],textPhase:'final_answer',content:'This is the answer being read.\n\n'+
 Array.from({length:25},(_,i)=>'Paragraph '+i+': Stable reading position during an unrelated history refresh. '.repeat(3)).join('\n\n')};
const before=[...applyHistoryRowWindow(rows.slice(0,180),{radius:100,alwaysHydrateTail:2}).entries,...rows.slice(180)];
const after=applyHistoryRowWindow(rows,{radius:100,alwaysHydrateTail:2}).entries;
await fs.writeFile(path.join(snapshot,'scripts/fixtures/history-hydration-grouping.data.json'),JSON.stringify({before,after}));
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-hydration-grouping.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
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
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,status:'RUNNING',errors:[]};const logs=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.state.ready);
 await page.screenshot({path:path.join(artifact,'loaded.png')});
 await page.locator('[data-timeline-entry-uuid="row-188"]').click();
 await page.waitForFunction(()=>window.fixture.state.scrolls.some(e=>e.found));
 await page.waitForSelector('[data-uuid="row-189"]');
 const scroller=page.locator('[data-virtuoso-scroller]').first();
 await scroller.hover();await page.mouse.wheel(0,230);await page.waitForTimeout(900);
 await page.screenshot({path:path.join(artifact,'before.png')});
 await page.evaluate(()=>{
  const state=window.fixture.state;state.frames=[];state.observe=true;
  const sample=()=>{if(!state.observe)return;const row=document.querySelector('[data-uuid="row-189"]');
   const scroller=document.querySelector('[data-virtuoso-scroller]');
   state.frames.push({top:row?.getBoundingClientRect().top??null,scrollTop:scroller.scrollTop,
    index:row?.closest('[data-item-index]')?.getAttribute('data-item-index'),height:scroller.scrollHeight,
    loader:!!document.querySelector('[data-history-viewport-ready="0"]')});requestAnimationFrame(sample);};sample();
 });
 await page.evaluate(()=>window.fixture.promote());
 await page.waitForFunction(()=>window.fixture.state.reads>=2);
 await page.waitForTimeout(3200);
 result.frames=await page.evaluate(()=>{window.fixture.state.observe=false;return window.fixture.state.frames;});
 result.missing=result.frames.filter(f=>f.top===null).length;
 result.maxDrift=Math.max(...result.frames.filter(f=>f.top!==null).map(f=>Math.abs(f.top-result.frames[0].top)));
 await page.screenshot({path:path.join(artifact,'after.png')});
 assert.equal(result.missing,0,'refresh never dismounts the answer being read');
 assert.ok(result.maxDrift<=2,'every presented frame keeps the same reading position; drift='+result.maxDrift);
 assert.equal(result.frames.some(f=>f.loader),false,'refresh never replaces the ready History with a loader');
 assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.stack;process.exitCode=1;await app.firstWindow().then(p=>p.screenshot({path:path.join(artifact,'failure.png')})).catch(()=>{});}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
 await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));
 console.log(JSON.stringify({...result,frames:result.frames?.length}));}
