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
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-file-return-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/file-tab-return.tsx'),path.join(snapshot,'scripts/fixtures/file-tab-return.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/file-tab-return.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
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
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:1100,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,steps:[],errors:[]};const logs=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.snapshot);
 result.steps.push({phase:'initial',...await page.evaluate(()=>window.fixture.snapshot())});
 await page.screenshot({path:path.join(artifact,'before.png')});
 await page.locator('[data-tab-id="FILE"]').first().click();
 result.steps.push({phase:'file',...await page.evaluate(()=>window.fixture.snapshot())});
 await page.keyboard.down('Control');await page.keyboard.press('Tab');
 await page.waitForTimeout(80);
 result.overlay=await page.locator('[data-tab-switcher-root]').count();
 await page.screenshot({path:path.join(artifact,'switcher.png')});
 await page.keyboard.up('Control');
 await page.waitForTimeout(200);
 result.steps.push({phase:'returned',...await page.evaluate(()=>window.fixture.snapshot())});
 assert.equal(result.steps.at(-1).active,'A');
 // The file belongs to OWNER in the other pane. A is nevertheless the return
 // target: navigation history is independent from sidebar file parentage.
 await page.locator('[data-tab-id="FILE"]').first().click();
 await page.mouse.move(10,800);
 await page.evaluate(()=>window.fixture.holdFrames());
 await page.keyboard.down('Control');await page.keyboard.press('Tab');
 const otherRow=page.locator('[data-tab-switcher-root] [data-tab-list-row="OTHER"]');
 await otherRow.waitFor({state:'visible'});
 const box=await otherRow.boundingBox();assert.ok(box);
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
 result.steps.push({phase:'pre-paint-pointer',...await page.evaluate(()=>window.fixture.snapshot())});
 await page.keyboard.up('Control');
 await page.evaluate(()=>window.fixture.releaseFrames());
 await page.waitForFunction(()=>!document.querySelector('[data-tab-switcher-root]'));
 result.steps.push({phase:'pre-paint-returned',...await page.evaluate(()=>window.fixture.snapshot())});
 assert.equal(result.steps.at(-1).active,'A','pre-paint pointer must not replace the keyboard return target');
 const capture=async(phase)=>{
   const value={phase,...await page.evaluate(()=>window.fixture.snapshot())};result.steps.push(value);return value;
 };
 const openFile=async()=>{
   await page.evaluate(()=>window.fixture.showA());
   await page.locator('[data-tab-id="FILE"]').first().click();
   await page.waitForFunction(()=>window.fixture.snapshot().active==='FILE');
 };
 const openCtrl=async()=>{await page.keyboard.down('Control');await page.keyboard.press('Tab');
   await page.locator('[data-tab-switcher-root]').waitFor({state:'visible'});};
 const presented=async()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
 const pointOf=async(id)=>{
   const b=await page.locator(`[data-tab-switcher-root] [data-tab-list-row="${id}"]`).boundingBox();assert.ok(b);
   return {x:b.x+b.width/2,y:b.y+b.height/2};
 };
 const release=async()=>{await page.keyboard.up('Control');await page.waitForFunction(()=>!document.querySelector('[data-tab-switcher-root]'));};

 // A layout-triggered zero-distance mousemove after paint is not new intent.
 await openFile();await page.mouse.move(10,800);await page.evaluate(()=>window.fixture.holdFrames());await openCtrl();
 const stationary=await pointOf('OTHER');await page.mouse.move(stationary.x,stationary.y);
 await page.evaluate(()=>window.fixture.releaseFrames());await presented();
 await page.mouse.move(stationary.x,stationary.y);await release();
 assert.equal((await capture('stationary-after-paint')).active,'A');

 // An old input timestamp remains old even when its delivery follows paint.
 await openFile();await page.mouse.move(10,800);
 const queuedAt=await page.evaluate(()=>performance.now());await openCtrl();await presented();
 const stalePoint=await pointOf('OTHER');
 await page.evaluate(({queuedAt,point})=>{
   const event=new MouseEvent('mousemove',{clientX:point.x,clientY:point.y,movementX:10,bubbles:true});
   Object.defineProperty(event,'timeStamp',{value:queuedAt});window.dispatchEvent(event);
 },{queuedAt,point:stalePoint});
 await release();assert.equal((await capture('stale-delivery-after-paint')).active,'A');

 // Real movement over the presented list still selects; releasing Ctrl commits it.
 await openFile();await page.mouse.move(10,800);await openCtrl();await presented();
 const freshPoint=await pointOf('OTHER');await page.mouse.move(freshPoint.x,freshPoint.y);
 await release();assert.equal((await capture('intentional-hover')).active,'OTHER');

 // Explicit clicks do not wait for the hover guard, even during delayed paint.
 await openFile();await page.mouse.move(10,800);await page.evaluate(()=>window.fixture.holdFrames());await openCtrl();
 const clickedPoint=await pointOf('OTHER');await page.mouse.click(clickedPoint.x,clickedPoint.y);
 await page.keyboard.up('Control');await page.evaluate(()=>window.fixture.releaseFrames());
 await page.waitForFunction(()=>!document.querySelector('[data-tab-switcher-root]'));
 assert.equal((await capture('explicit-click-before-paint')).active,'OTHER');

 // Ordinary held chips stay absent, a vanished file stays visible but cannot
 // take over the selection, and repeated Ctrl+Tab keeps normal MRU stepping.
 await openFile();await page.mouse.move(10,800);await openCtrl();await presented();
 assert.equal(await page.locator('[data-tab-switcher-root] [data-tab-list-row="PIN"]').count(),0);
 assert.equal(await page.locator('[data-tab-switcher-root] [data-tab-list-row="OWNER"]').count(),0);
 const missing=await pointOf('MISSING');await page.mouse.move(missing.x,missing.y);
 await release();assert.equal((await capture('missing-file-hover')).active,'A');
 await openFile();await page.mouse.move(10,800);await openCtrl();
 await page.keyboard.press('Tab');await release();
 assert.equal((await capture('held-ctrl-step')).active,'OTHER');
 await openFile();await page.mouse.move(10,800);await page.keyboard.down('Control');
 await page.keyboard.press('Shift+Tab');await release();
 assert.equal((await capture('reverse-step')).active,'B');
 assert.deepEqual(result.errors,[]);
 result.status='PASS';
}catch(e){result.error=e.stack;result.status='FAIL';process.exitCode=1;await app.firstWindow().then(p=>p.screenshot({path:path.join(artifact,'failure.png')})).catch(()=>{});}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));console.log(JSON.stringify(result));}
