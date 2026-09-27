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
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-history-timeline-live-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-timeline-live.tsx'),path.join(snapshot,'scripts/fixtures/history-timeline-live.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'../noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-timeline-live.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
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
const result={artifact,steps:[],errors:[]};const logs=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.state.ready);
 await page.waitForSelector('[data-timeline-entry-uuid="base-88"]');
 await page.evaluate(()=>window.fixture.show(false));
 await page.evaluate(()=>window.fixture.compact());
 await page.waitForSelector('[data-timeline-entry-uuid="live-compact"]',{state:'attached'});
 await page.evaluate(()=>window.fixture.show(true));
 await page.waitForSelector('[data-timeline-entry-uuid="live-compact"]');
 result.steps.push({phase:'compact-while-busy',reads:await page.evaluate(()=>window.fixture.state.reads)});
 await page.locator('[data-timeline-entry-uuid="live-compact"]').click();
 await page.waitForFunction(()=>window.fixture.state.scrolls.some(e=>e.uuid==='compact-source-100'&&e.found));
 await page.evaluate(()=>window.fixture.prompt());
 await page.evaluate(()=>window.fixture.answer());
 await page.waitForSelector('[data-timeline-entry-uuid="live-user"]');
 await page.locator('[data-timeline-entry-uuid="live-user"]').click();
 await page.waitForFunction(()=>window.fixture.state.scrolls.some(e=>e.uuid==='canonical-source-200'));
 result.steps.push({phase:'new-prompt-click',...await page.evaluate(()=>({reads:window.fixture.state.reads,scrolls:window.fixture.state.scrolls}))});
 assert.equal(result.steps.at(-1).scrolls.at(-1).found,true,'fresh canonical point must reach the still-local exact prompt');
 await page.evaluate(()=>{
   const state=window.fixture.state;state.frames=[];state.observe=true;
   const sample=()=>{if(!state.observe)return;
     const node=document.querySelector('[data-uuid="canonical-user"]')||document.querySelector('[data-uuid="local-prompt-timeline-live-tab-h1"]');
     state.frames.push({uuid:node?.getAttribute('data-uuid'),top:node?.getBoundingClientRect().top});requestAnimationFrame(sample);};sample();
 });
 await page.evaluate(()=>window.fixture.promote());
 await page.waitForSelector('[data-timeline-entry-uuid="canonical-user"]');
 await page.waitForTimeout(3200);
 result.steps.push({phase:'canonical-adoption',...await page.evaluate(()=>{const s=window.fixture.state;s.observe=false;return {acks:s.acks,
   row:!!document.querySelector('[data-uuid="canonical-user"]'),scrolls:s.scrolls,frames:s.frames.length,gaps:s.frames.filter(f=>!f.uuid),
   firstTop:s.frames[0]?.top,lastTop:s.frames.at(-1)?.top,
   maxDrift:Math.max(...s.frames.map(f=>Math.abs(f.top-s.frames[0].top)))};})});
 await page.screenshot({path:path.join(artifact,'final.png')});
 assert.equal(result.steps.at(-1).row,true,'navigated user row remains mounted after adoption');
 assert.deepEqual(result.steps.at(-1).gaps,[],'no presented frame loses both local and canonical rows');
 assert.ok(result.steps.at(-1).acks.length>0);
 // Virtuoso may commit its derived rows after its parent layout effect. The
 // public presentation invariant is no painted gap, including that handoff.
 assert.ok(Math.abs(result.steps.at(-1).firstTop-result.steps.at(-1).lastTop)<40,'adoption keeps the navigated row at its reading position');
 assert.ok(result.steps.at(-1).maxDrift<40,'no intermediate frame teleports the navigated row');
 assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.stack;process.exitCode=1;await app.firstWindow().then(p=>p.screenshot({path:path.join(artifact,'failure.png')})).catch(()=>{});}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));console.log(JSON.stringify(result));}
