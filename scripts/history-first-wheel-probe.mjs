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
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-first-wheel-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-first-wheel.tsx'),path.join(snapshot,'scripts/fixtures/history-first-wheel.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-first-wheel.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
 define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
 alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
 loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact,'user-data'));
await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:760,height:1100,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
w.webContents.on('paint',()=>{});const handle=ipcMain.handle.bind(ipcMain);
for(const name of ['app:getState','app:setState','tab-work-context:get','timeline-prompt-summaries:get','timeline-outline:get','timeline-turn-action-overrides:get','agent-session:get-availability-batch','timeline:get-session-history-events','timeline:get-notes','timeline:get-rewind-markers'])handle(name,()=>null);
w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,cases:[],errors:[]};const logs=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 for(const delay of [40,180,600,850]){
  if(result.cases.length){await page.reload();}
  await page.waitForFunction(()=>window.fixture?.loaded);
  await page.locator('[data-show]').click();
  await page.locator('[data-history-viewport-ready="1"]').waitFor();
  await page.waitForTimeout(delay);
  const scroller=page.locator('[data-virtuoso-scroller]').first();
  await scroller.hover();
  await page.evaluate(()=>{window.fixture.writers=[];window.fixture.samples=[];window.fixture.capture=true;const tick=()=>{const s=document.querySelector('[data-virtuoso-scroller]');window.fixture.samples.push({at:performance.now(),top:s.scrollTop,height:s.scrollHeight,ready:document.querySelector('[data-history-viewport-ready]')?.getAttribute('data-history-viewport-ready')});if(window.fixture.capture)requestAnimationFrame(tick)};tick();});
  for(const [dy,wait] of [[-4,35],[-25.3,40],[-79.4,85],[-86.4,0]]){await page.mouse.wheel(0,dy);if(wait)await page.waitForTimeout(wait);}
  await page.waitForTimeout(75);
  await page.evaluate(()=>{const rows=[...document.querySelectorAll('[data-history-row-real]')];const row=rows.at(-1);if(row)row.style.paddingBottom=(parseFloat(getComputedStyle(row).paddingBottom)||0)+1+'px';});
  await page.waitForTimeout(600);
  const data=await page.evaluate(()=>{window.fixture.capture=false;return{samples:window.fixture.samples,writers:window.fixture.writers}});
  const backward=data.samples.slice(1).map((s,i)=>s.top-data.samples[i].top).filter(d=>d>4);
  result.cases.push({delay,backward,...data});
  await page.screenshot({path:path.join(artifact,'case-'+delay+'.png')});
 }
 result.status='MEASURED';
}catch(e){result.error=e.stack;result.status='FAIL';process.exitCode=1;}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));console.log(JSON.stringify({artifact,status:result.status,error:result.error,errors:result.errors,cases:result.cases.map(c=>({delay:c.delay,backward:c.backward,writers:c.writers.length}))}));}
