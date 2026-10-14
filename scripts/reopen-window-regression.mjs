#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import ts from 'typescript';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-reopen-window-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/reopen-window.tsx'),path.join(snapshot,'scripts/fixtures/reopen-window.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
const appSource=await fs.readFile(process.env.NOTED_REOPEN_BASELINE_APP||path.join(snapshot,'src/renderer/App.tsx'),'utf8');
const ast=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='handleReopenLastClosedCapture')handler=node.initializer.getText(ast);ts.forEachChild(node,visit);}visit(ast);assert.ok(handler);
await fs.writeFile(path.join(snapshot,'scripts/fixtures/reopen-window-hotkey.ts'),`export function installReopenHotkey({useWorkspaceStore,useUIStore,view,showToast}:any){const handle=${handler};window.addEventListener('keydown',handle,true);}`);
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/reopen-window.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
 define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
 alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
 loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact,'user-data'));
await fs.writeFile(path.join(artifact,'preload.cjs'),`const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
await fs.mkdir(path.join(artifact,'project'));
await fs.writeFile(path.join(artifact,'main.cjs'),`
const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
const DatabaseManager=require(${JSON.stringify(path.join(snapshot,'src/main/database.js'))});
const {TabHistoryRestoreLeases}=require(${JSON.stringify(path.join(snapshot,'src/main/tab-history-restore-leases.js'))});
const db=new DatabaseManager();const project=db.createEmptyProject('Reopen fixture');const projectId=project.id;
const cwd=${JSON.stringify(path.join(artifact,'project'))};
const ids={local:projectId+'-tab-834',full:projectId+'-tab-919',parent:projectId+'-tab-920'};
const tabs=[{id:ids.local,name:'Older removed tab 834'},{id:ids.full,name:'передача ios-skill',visualParentTabId:ids.parent},{id:ids.parent,name:'Parent neighbour'}]
 .map(t=>({...t,tabId:t.id,cwd,commandType:'codex',tabType:'terminal',color:'codex',codexSessionId:'fixture-session-'+t.id,nameSetManually:true}));
const calls=[];let createCount=0;
const reset=()=>{db.clearTabHistory(projectId);db.saveTabs(projectId,tabs,true);calls.length=0;createCount=0;};reset();
const leases=new TabHistoryRestoreLeases({getLatest:p=>db.getLatestTabHistory(p),getById:(id,p)=>db.getTabHistoryEntry(id,p),deleteById:id=>db.deleteTabHistoryEntry(id),token:()=>require('node:crypto').randomUUID()});
ipcMain.on('terminal:kill',(_e,id)=>calls.push({channel:'terminal:kill',id}));
ipcMain.handle('fixture:invoke',async(_e,{channel,args})=>{
 const payload=args[0];calls.push({channel});
 if(channel==='fixture:boot')return {projectId,cwd,ids,tabs};
 if(channel==='fixture:reset'){reset();return {success:true};}
 if(channel==='fixture:state')return {history:db.getTabHistory(projectId).map(r=>({id:r.id,name:r.name,tabId:r.tab_id})),createCount,calls,tabs:db.getProjectById(projectId).tabs};
 if(channel==='terminal:getCommandState')return {isRunning:false};
 if(channel==='terminal:hasRunningProcess')return {isRunning:false};
 if(channel==='terminal:stop-ai-process')return {success:true,stopped:true};
 if(channel==='terminal:create'){createCount++;return {pid:9000+createCount,cwd:payload.cwd};}
 if(channel==='app:nearest-existing-directory')return {path:payload,exact:true};
 if(channel==='app:check-path-exists')return true;
 if(channel==='project:archive-tab')return {success:true,historyId:Number(db.archiveTab(payload.projectId,payload.tab))};
 if(channel==='project:peek-window-tab-history')return {success:true,entry:db.getLatestWindowTabHistory(payload)};
 if(channel==='project:begin-tab-history-restore'){await new Promise(resolve=>setTimeout(resolve,80));return leases.begin(payload);}
 if(channel==='project:finish-tab-history-restore')return leases.finish(payload);
 if(channel==='project:delete-tab-history-entry')return {success:db.deleteTabHistoryEntry(payload.id)};
 if(channel==='project:validate-tab-snapshot')return {success:true};
 if(channel==='project:save-tabs')return db.saveTabs(payload.projectId,payload.tabs,payload.forceCleanup);
 if(channel==='project:get-tab-history-count')return db.getTabHistoryCount(payload.projectId);
 if(channel==='agent-session:get-availability-batch')return {success:true,results:(payload?.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel==='terminal:getCommandStates')return {};
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return [];
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 if(channel.includes(':send')||channel.includes(':paste')||channel==='terminal:input')throw Error('Provider input forbidden in fixture');
 return {success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:1250,height:760,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>{db.close();app.quit();});`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,checks:[],errors:[]};const logs=[];let page;
try{
 page=await app.firstWindow();page.setDefaultTimeout(14000);page.on('pageerror',e=>result.errors.push(e.stack||e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.ready);
 const ids=await page.evaluate(()=>window.fixture.ids);
 const chip=id=>page.locator('[data-split-pane-tab-chip]').filter({has:page.locator(':scope[data-tab-id="'+id+'"]')});
 const actualChip=id=>page.locator('[data-split-pane-tab-chip][data-tab-id="'+id+'"]');
 const removeLocal=async()=>{await actualChip(ids.local).click({button:'middle',position:{x:20,y:12}});await page.waitForFunction(id=>!window.fixture.snapshot().panes[0].tabs.some(t=>t.id===id),ids.local);};
 const closeFull=async()=>{await actualChip(ids.full).click({button:'right'});await page.locator('[data-tab-close-scope="full"]').click();await page.waitForFunction(id=>!window.fixture.snapshot().tabs.some(t=>t.id===id),ids.full);};
 const undo=()=>page.keyboard.press('Meta+Shift+T');
 const waitName=name=>page.waitForFunction(name=>{const s=window.fixture.snapshot();return s.tabs.find(t=>t.id===s.panes[0].shown)?.name===name;},name);
 const read=()=>page.evaluate(()=>window.require('electron').ipcRenderer.invoke('fixture:state'));
 await removeLocal();await closeFull();await undo();await waitName('передача ios-skill');
 let snapshot=await page.evaluate(()=>window.fixture.snapshot());let restored=snapshot.tabs.find(t=>t.name==='передача ios-skill');
 assert.notEqual(restored.id,ids.full);assert.equal(restored.parent,ids.parent);assert.equal(restored.session,'fixture-session-'+ids.full);
 assert.equal(snapshot.panes[1].shown,ids.parent);assert.equal((await read()).history.length,0);
 await undo();await waitName('Older removed tab 834');assert.equal((await read()).createCount,1);
 snapshot=await page.evaluate(()=>window.fixture.snapshot());assert.deepEqual(snapshot.panes[0].tabs.map(t=>t.name),['Older removed tab 834','передача ios-skill']);
 result.checks.push('trusted middle-remove, Full and hotkey restore 919 then 834 with hierarchy and strip order');
 await page.screenshot({path:path.join(artifact,'restored.png')});
 await page.evaluate(()=>window.fixture.reset());await closeFull();await removeLocal();await undo();await waitName('Older removed tab 834');
 assert.equal((await read()).history.length,1);await undo();await waitName('передача ios-skill');
 result.checks.push('reverse close order restores the newer removed chip first');
 await page.evaluate(()=>window.fixture.reset());await removeLocal();await closeFull();await undo();await undo();await waitName('Older removed tab 834');
 const final=await read();assert.equal(final.history.length,0);assert.equal(final.createCount,1);
 result.checks.push('rapid hotkeys during delayed archive creation stay ordered and create once');
 assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.pass=false;result.failure=String(error);process.exitCode=1;if(page){result.snapshot=await page.evaluate(()=>window.fixture?.snapshot()).catch(()=>null);await page.screenshot({path:path.join(artifact,'failure.png')}).catch(()=>{});}}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});}
console.log(JSON.stringify({artifact,pass:result.pass,checks:result.checks,failure:result.failure,errors:result.errors}));
