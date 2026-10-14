#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {writeSyntheticRollout}=require('./codex-turn-append-cost-regression.cjs');
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-fork-rename-load-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.mkdir(path.join(snapshot,'scripts/lib'),{recursive:true});
for(const name of ['fixtures/fork-rename-load.tsx','lib/codex-turn-append-harness.cjs'])await fs.copyFile(path.join(repo,'scripts',name),path.join(snapshot,'scripts',name));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const name of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/fork-rename-load.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
 define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
 alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
 loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact,'user-data'));
await fs.writeFile(path.join(artifact,'preload.cjs'),`const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
const file=path.join(artifact,'synthetic-rollout.jsonl');
const expected=await writeSyntheticRollout(file);
await fs.writeFile(path.join(artifact,'main.cjs'),`
const {app,BrowserWindow,ipcMain}=require('electron');
const {performance}=require('node:perf_hooks');
const Database=require(${JSON.stringify(path.join(repo,'node_modules/better-sqlite3'))});
const {createHarness}=require(${JSON.stringify(path.join(snapshot,'scripts/lib/codex-turn-append-harness.cjs'))});
app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
const db=new Database(${JSON.stringify(path.join(artifact,'user-data/tabs.sqlite'))});
db.exec('CREATE TABLE tabs(id TEXT PRIMARY KEY,name TEXT,parent TEXT,session TEXT,manual INTEGER)');
const upsert=db.prepare('INSERT OR REPLACE INTO tabs VALUES(?,?,?,?,?)');
upsert.run('synthetic-parent','Parent',null,'synthetic-parent-session',0);upsert.run('synthetic-child','Fork','synthetic-parent','synthetic-child-session',0);
let reading=false,scan=null;const saves=[];
ipcMain.handle('fixture:invoke',async(e,{channel,args})=>{
 if(channel==='fixture:read'){
  reading=true; const h=createHarness(${JSON.stringify(file)});const start=performance.now();await h.scan();reading=false;
  scan={records:h.result.records,digest:h.digest(),warnings:h.result.warnings,elapsedMs:performance.now()-start,stats:h.result.read?.stats};
  return{ok:!scan.warnings.length};
 }
 if(channel==='fixture:result')return{scan,saves,rows:db.prepare('SELECT * FROM tabs ORDER BY id').all()};
 if(channel==='project:save-tabs'){
  const start=performance.now();for(const t of args[0].tabs)upsert.run(t.tabId,t.name,t.visualParentTabId||null,t.codexSessionId||null,Number(!!t.nameSetManually));
  saves.push({reading,ms:performance.now()-start});e.sender.send('fixture:saved',db.prepare('SELECT name FROM tabs WHERE id=?').get('synthetic-child').name);return{success:true};
 }
 if(channel==='agent-session:get-availability-batch')return{success:true,results:(args[0]?.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return[];
 if(channel==='terminal:getCommandStates')return{};if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState'||channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:800,height:500,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
 w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>{db.close();app.quit();});`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,expected,checks:[],errors:[],logs:[]};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.stack||e.message));page.on('console',m=>result.logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.ready);
 await page.locator('[data-start-read]').click();
 await page.locator('[data-read-status]').filter({hasText:'Reading'}).waitFor();
 const started=Date.now();
 await page.getByText('Fork',{exact:true}).dblclick();
 const input=page.locator('input');await input.waitFor();await input.fill('uav — данные 🧩');await input.press('Enter');
 await page.locator('[data-saved-name]').filter({hasText:'uav — данные 🧩'}).waitFor();
 result.renameElapsedMs=Date.now()-started;
 await page.locator('[data-read-status]').filter({hasText:'Complete'}).waitFor();
 result.main=await page.evaluate(()=>window.require('electron').ipcRenderer.invoke('fixture:result'));
 assert.equal(result.main.scan.digest,expected.digest);assert.equal(result.main.scan.records,expected.records);
 assert.ok(result.main.saves.some(s=>s.reading),'rename must persist while scan is still running');
 const child=result.main.rows.find(t=>t.id==='synthetic-child');assert.equal(child.name,'uav — данные 🧩');assert.equal(child.parent,'synthetic-parent');assert.equal(child.session,'synthetic-child-session');assert.equal(child.manual,1);
 assert.equal(result.main.rows.find(t=>t.id==='synthetic-parent').name,'Parent');
 result.checks.push('trusted double click and typing persist child name during real bounded scan','parent/session/manual ownership preserved','every physical record processed with exact digest');
 await page.screenshot({path:path.join(artifact,'renamed.png')});
 await page.getByText('uav — данные 🧩',{exact:true}).first().dblclick();await page.locator('input').fill('cancelled');await page.locator('input').press('Escape');
 assert.equal((await page.evaluate(()=>window.require('electron').ipcRenderer.invoke('fixture:result'))).rows.find(t=>t.id==='synthetic-child').name,'uav — данные 🧩');
 result.checks.push('Escape does not persist an uncommitted rename');assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.pass=false;result.failure=String(error);process.exitCode=1;}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});}
console.log(JSON.stringify({artifact,pass:result.pass,checks:result.checks,renameElapsedMs:result.renameElapsedMs,failure:result.failure,errors:result.errors}));
