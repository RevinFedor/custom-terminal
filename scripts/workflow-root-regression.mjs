#!/usr/bin/env node
// Actual App + Root store + Workspace. Owned offscreen Electron and synthetic
// IPC only; no production Main, PTY, provider, user storage, Git or OS input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import {historyVirtuosoMeasurementEsbuildPlugin} from './lib/history-virtuoso-measurement.mjs';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-workflow-root-'));
const width=Number(process.argv.find(arg=>arg.startsWith('--width='))?.split('=')[1] || 1200);
const archiveOnly=process.argv.includes('--archive-only');
const source=path.join(artifact,'source');
const result={artifact,pass:false,checks:[],errors:[],screens:[],boundary:{
 actual:['App','useWorkspaceStore','ConnectedWorkflowSidebar','Workspace','xterm','RootGlobalArchive','HistoryPanel/Timeline preview'],
 synthetic:['Main canonical catalog/commit IPC','process/data/availability','owned fixture files'],
 excluded:['production Main/DB','real PTY/provider','installation','user storage','native OS input']}};
let app,page;const logs=[];
try{
 for(const dir of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,dir),path.join(source,dir),{recursive:true,filter:p=>!p.includes('/node_modules')});
 await fs.mkdir(path.join(source,'scripts/fixtures'),{recursive:true});
 await fs.copyFile(path.join(repo,'scripts/fixtures/workflow-root.tsx'),path.join(source,'scripts/fixtures/workflow-root.tsx'));
 await fs.copyFile(path.join(repo,'package.json'),path.join(source,'package.json'));
 await fs.symlink(path.join(repo,'node_modules'),path.join(source,'node_modules'));
 const shared=path.join(artifact,'shared');
 for(const name of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p=>!p.includes('/node_modules')});
 const base=await fs.readFile(path.join(repo,'scripts/terminal-full-view-regression.mjs'),'utf8');
 const shim=base.slice(base.indexOf('function installShim('),base.indexOf('\ntry {\n  execFileSync'));
 assert.ok(shim.endsWith('}\n'),'exact isolated existing IPC adapter');
 const bundled=await build({entryPoints:[path.join(source,'scripts/fixtures/workflow-root.tsx')],bundle:true,metafile:true,sourcemap:true,
  outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'iife',target:'chrome120',jsx:'automatic',logLevel:'silent',
  nodePaths:[path.join(repo,'node_modules')],plugins:[historyVirtuosoMeasurementEsbuildPlugin()],
  define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}',
    'import.meta.url':JSON.stringify('file://' + path.join(artifact,'bundle.js'))},
  alias:{'@noted/claude-blocks':path.join(source,'packages/claude-blocks/src'),
   '@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),
   react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
  loader:{'.b64':'text','.ttf':'file','.woff2':'file','.svg':'dataurl','.png':'dataurl'}});
 const hashes={};const root=await fs.realpath(source);
 for(const input of Object.keys(bundled.metafile.inputs)){
  const file=await fs.realpath(path.resolve(input)).catch(()=>null);
  if(file?.startsWith(root+path.sep))hashes[path.relative(root,file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
 }
 result.inputHashes=hashes;
 result.harnessHashes=Object.fromEntries(await Promise.all(['scripts/workflow-root-regression.mjs','scripts/terminal-full-view-regression.mjs',
  'scripts/lib/history-virtuoso-measurement.mjs'].map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(repo,name))).digest('hex')])));
 await fs.writeFile(path.join(artifact,'bundle-inputs.json'),JSON.stringify(bundled.metafile,null,2));
 await fs.writeFile(path.join(artifact,'source-hashes.json'),JSON.stringify(hashes,null,2));
 execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(source,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:source,stdio:'pipe'});
 await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:#171717;color:#ccc}</style><div id="root"></div><script>'+shim+';installShim(360,false)</script><script src="bundle.js"></script>');
 await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,session}=require('electron');
 app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');
 app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
 const w=new BrowserWindow({show:false,focusable:false,frame:false,width:${width},height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
 if(!process.argv.includes('--build-only')){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});result.pid=app.process().pid;
 page=await app.firstWindow();page.setDefaultTimeout(15000);
 page.on('pageerror',error=>result.errors.push(error.stack || error.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.rootFixture?.store.getState().organizationReady && !window.rootFixture.store.getState().isRestoring);
 const state=()=>page.evaluate(()=>window.rootFixture.state());
 const open=(id,options={})=>page.evaluate(async({id,options})=>window.rootFixture.open(id,options),{id,options});
 const screenshot=async(name)=>{await page.screenshot({path:path.join(artifact,name+'.png')});result.screens.push(name+'.png');};
 if(!archiveOnly){
 assert.equal((await state()).hotPreserved,true);
 assert.equal(await page.evaluate(()=>window.rootFixture.runtimeCreates.length),0,'bootstrap metadata starts no runtime');
 assert.ok(!(await state()).reserve.includes('P'),'profile-only placement excluded from reserve');
 result.checks.push('actual Root bootstrap preserves hot object; cold catalog performs zero runtime admission; profiles are placed');
 await page.locator('[data-space-chip="space-1"]').click();
 await page.waitForFunction(()=>window.rootFixture.state().view==='workspace');
 assert.equal(await open('A'),true);
 await page.waitForFunction(()=>{const term=window.rootFixture.terminal('A');return !!term?.element &&
   Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString(true)).some(line=>line?.includes('0419 BOTTOM'));});
 const expectedDraft='Root retained unsent draft';
 await page.locator('[data-history-composer-tab-id="A"] .cm-content').fill(expectedDraft);
 await page.waitForFunction(()=>window.rootFixture.terminal('A').cols!==80 && window.rootFixture.terminal('A').rows>24);
 await page.evaluate(()=>new Promise(resolve=>{let frames=4;const step=()=>--frames?requestAnimationFrame(step):resolve();requestAnimationFrame(step);}));
 await page.evaluate(()=>{window.rootFixture.hold('A');window.rootFixture.scroll('A',40);});
 const scroll=await page.evaluate(()=>window.rootFixture.identity('A').scroll);
 await screenshot('root-main');
 assert.equal(await open('A2',{projectId:'wrong-namespace'}),true);
 let s=await state();assert.equal(s.panes[s.focus].windowId,'main-first');assert.equal(s.panes[s.focus].tabId,'A2');
 assert.deepEqual(s.panes.find(p=>p.windowId==='main-first').tabs.map(x=>x.tabId),['A','A2']);
 result.checks.push('non-selected chip reveals exact window; stale execution hint never transfers ownership');
 assert.equal(await open('H'),true);s=await state();assert.equal(s.panes[s.focus].windowId,'main-hidden');assert.equal(s.panes[s.focus].displayHidden,undefined);
 result.checks.push('hidden exact window revealed with own contents');
 assert.equal(await open('C'),true);s=await state();assert.equal(s.space,'other');assert.equal(s.panes[s.focus].windowId,'other-first');
 assert.equal(await open('R'),true);s=await state();assert.equal(s.space,'other');
 // R remembers the persisted last-focused window, which is now C's own window after explicit navigation.
 assert.deepEqual(s.panes[s.focus].tabs.map(x=>x.tabId),['C','R']);assert.equal(s.panes[1].tabId,'D');
 result.checks.push('dormant reveal and reserve append preserve unrelated window/chips');
 assert.equal(await open('P'),true);s=await state();assert.equal(s.space,'space-1');assert.equal(s.panes[s.focus].windowId,'profile-exact');
 assert.deepEqual(s.panes[s.focus].tabs.map(x=>x.tabId),['P','P2']);
 result.checks.push('profile-only exact window and full chip sequence materialize without replacement');
 assert.equal(await open('S'),true);s=await state();assert.equal(s.panes[s.focus].windowId,'main-first');
 assert.deepEqual(s.panes[s.focus].tabs.map(x=>x.tabId),['A','A2','S']);
 result.checks.push('profile-only link into an existing window preserves its current chips/order and appends missing saved content');
 assert.equal(await open('child'),true);s=await state();assert.equal(s.current,'child');assert.equal(s.panes[s.focus].tabId,'A');
 result.checks.push('physical subagent selects parent window plus child view');
 await page.locator('[data-app-home-button]').click();await page.waitForFunction(()=>window.rootFixture.state().view==='dashboard');
 await page.locator('[data-space-chip="space-1"]').click();assert.equal((await state()).view,'workspace');
 const identity=await page.evaluate(()=>window.rootFixture.identity('A'));
 assert.ok(identity.tab&&identity.terminal&&identity.element&&identity.buffer);assert.equal(identity.scroll,scroll);
 assert.equal(await page.locator('[data-history-composer-tab-id="A"] .cm-content').textContent(),expectedDraft);
 result.checks.push('Home returns to same workflow, retained tab/xterm/DOM/buffer/scroll survive navigation');
 // Public setter must derive local intent while automation remains committed.
 await page.evaluate(()=>{const f=window.rootFixture,s=f.store.getState();f.store.setState({splitPanes:s.splitPanes.map(p=>({...p,tabs:(p.tabs||[]).filter(x=>x.tabId!=='A2')})),
 spaces:s.spaces.map(space=>space.id==='other'?{...space,layout:{...space.layout,splitPanes:[...space.layout.splitPanes,{windowId:'public-move',projectId:'full-view-project',tabId:'A2',tabs:[{projectId:'full-view-project',tabId:'A2'}]}]}}:space)});});
 s=await state();assert.equal(s.pending.A2.workflowId,'other');assert.equal(s.membership.A2.workflowId,'space-1');
 await page.evaluate(()=>window.rootFixture.store.getState().commitOrganization());assert.equal((await state()).membership.A2.workflowId,'other');
 result.checks.push('actual public setState records pending placement; Main CAS ACK changes canonical membership');
 // Inflight cold catalog read must lose to later user navigation.
 await page.evaluate(()=>{const f=window.rootFixture;f.gate('workflow:catalog');f.pendingOpen=f.open('cold');});
 await open('B');await page.evaluate(()=>window.rootFixture.release('workflow:catalog'));
 assert.equal(await page.evaluate(()=>window.rootFixture.pendingOpen),false);assert.equal((await state()).panes[(await state()).focus].tabId,'B');
 result.checks.push('delayed cold read loses to newer navigation; false ACK preserves newer selection');
 // Delayed file read belongs to the original owner visit. Away/back and
 // closing the reader invalidate the lease without resurrecting a document.
 await open('A');await page.evaluate(()=>window.rootFixture.gate('file:read'));
 await page.locator('[data-tab-linked-files="A"]:visible').first().click();
 await page.locator('[data-linked-file-id="file"]:visible').first().click();
 await page.waitForFunction(()=>window.rootFixture.rootRequests.some(r=>r.channel==='file:read'));
 await open('B');await open('A');await page.evaluate(()=>window.rootFixture.release('file:read'));
 await page.waitForFunction(()=>!window.rootFixture.gates.has('file:read'));
 assert.equal(await page.evaluate(()=>window.rootFixture.ui.getState().filePreview),null);
 await page.locator('[data-linked-file-id="file"]:visible').first().click();
 await page.waitForSelector('[data-file-preview-root]');
 assert.equal(await page.evaluate(()=>window.rootFixture.ui.getState().filePreview.ownerTabId),'A');
 await screenshot('root-file-popup');
 await page.evaluate(()=>window.rootFixture.ui.getState().closeFilePreview());
 await page.keyboard.press('Escape');
 result.checks.push('actual pane file popup uses Root owner reveal; away/back cancels delayed read; exact reader owner and close lease');
 // New v2 execution needs no Project row/path match. Metadata writes queued
 // before the first ACK advance only the CAS proof, preserving their payloads.
 const created=await page.evaluate(async()=>window.rootFixture.store.getState().createWorkflowTab({workflowId:'other',cwd:'/synthetic/unmatched',
  tabOptions:{tabType:'file',filePath:'/synthetic/new.md',background:true,skipInitialRename:true}}));
 await page.waitForFunction(id=>window.rootFixture.saved.some(r=>r.tabs.some(t=>t.tabId===id)),created);
 await page.evaluate(id=>{const f=window.rootFixture;f.gate('project:save-tabs');f.rename1=f.store.getState().renameTab('__tab_catalog_v2__',id,'Queued first');
  f.rename2=f.store.getState().renameTab('__tab_catalog_v2__',id,'Queued second');},created);
 await page.evaluate(()=>window.rootFixture.release('project:save-tabs'));
 await page.waitForFunction(id=>window.rootFixture.saved.some(r=>r.tabs.some(t=>t.tabId===id&&t.name==='Queued second')),created);
 const saves=await page.evaluate(id=>window.rootFixture.saved.flatMap(r=>r.tabs.filter(t=>t.tabId===id)),created);
 const first=saves.find(r=>r.name==='Queued first'),second=saves.find(r=>r.name==='Queued second');
 assert.equal(second.executionStorageRevision,first.executionStorageRevision+1);
 assert.equal(second.executionSubject.executionNamespace,'__tab_catalog_v2__');assert.equal(second.cwd,'/synthetic/unmatched');
 result.checks.push('actual v2 constructor accepts independent cwd/no Project row; queued metadata snapshots advance execution CAS after ACK');
 const foreground=await page.evaluate(()=>window.rootFixture.store.getState().createWorkflowTab({workflowId:'other',sourceTabId:'A',
   tabOptions:{tabType:'file',filePath:'/synthetic/foreground.md',background:false,skipInitialRename:true}}));
 s=await state();assert.equal(s.space,'other');assert.equal(s.panes[s.focus].tabId,foreground);
 assert.equal(await page.evaluate(id=>window.rootFixture.store.getState().openProjects.get('__tab_catalog_v2__').tabs.get(id).cwd,foreground),'/synthetic/A');
 result.checks.push('foreground constructor chooses explicit workflow over source, captures source cwd, appends through Root navigation');
 await page.getByRole('button',{name:'Создать группу',exact:true}).click();
 await page.waitForSelector('[data-reserve-group-id]');
 assert.ok(await page.locator('[data-reserve-group-id]').getByText('Новая группа',{exact:true}).count());
 result.checks.push('empty global group remains visible at creation workflow');
 }
 await page.locator('[data-global-archive-open]').click();await page.waitForSelector('[data-root-global-archive]');
 const before=await page.evaluate(()=>window.rootFixture.runtimeCreates.length);
 await page.getByText('Archived dialogue',{exact:true}).click();
 await page.waitForSelector('[data-global-archive-preview]');
 await page.locator('[data-global-archive-preview]').getByText('Synthetic history row 15. No provider was started.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.rootFixture.runtimeCreates.length),before,'preview never launches');
 await page.locator('[data-root-global-archive]').getByRole('button',{name:'Индексы и очистка',exact:true}).click();
 await page.getByLabel('Каталог архива').selectOption('full-view-project');
 await page.getByRole('button',{name:'Статистика',exact:true}).click();
 await screenshot('root-archive');
 assert.equal(await page.evaluate(()=>window.innerWidth),width);
 assert.equal(await page.locator('[data-root-global-archive]').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
 await screenshot('root-archive-'+width);
 result.checks.push('global archive Root entry renders real read-only History/Timeline; namespace index controls remain accessible with zero launches');
 await page.keyboard.press('Escape');await page.waitForSelector('[data-root-global-archive]',{state:'detached'});
 if(!archiveOnly){const refused=await page.evaluate(()=>window.rootFixture.store.getState().restoreTabHistoryEntry('full-view-project',7,{
   background:true,resumePolicy:'never',expectedTabId:'archived',targetWorkflowId:'other'}));
 assert.equal(refused.historyDeleteFailed,true);
 assert.equal(await page.evaluate(()=>!!window.rootFixture.archiveConsumed),false);
 await page.evaluate(()=>{window.rootFixture.fileRestoreFail=false;});
 const restored=await page.evaluate(()=>window.rootFixture.store.getState().restoreTabHistoryEntry('full-view-project',7,{
   background:true,resumePolicy:'never',expectedTabId:'archived',targetWorkflowId:'other'}));
 assert.equal(restored.tabId,'archived');assert.equal(restored.historyDeleteFailed,false);
 const events=await page.evaluate(()=>window.rootFixture.restoreEvents);
 assert.equal(events.filter(e=>e.channel==='project:restore-execution-tab').length,1,'retry reuses exact surviving Root object');
 const committed=events.findIndex(e=>e.channel==='project:finish-tab-history-restore'&&e.request.commit);
 assert.ok(committed>events.findIndex(e=>e.channel==='project:restore-file-links'));
 assert.equal(await page.evaluate(()=>window.rootFixture.store.getState().openProjects.get('full-view-project').tabs.get('restored-file').visualParentTabId),'archived');
 result.checks.push('actual Root native restore holds owner archive until exact file-links ACK; refusal retains history; retry restores chips without duplicate owner/runtime');
 }
 const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused(),focusable:w.isFocusable()})));
 assert.ok(windows.every(w=>!w.visible&&!w.focused&&!w.focusable));
 result.violations=await page.evaluate(()=>window.rootFixture.violations);assert.deepEqual(result.violations,[]);
 result.terminalInput=await page.evaluate(()=>window.rootFixture.writes);assert.deepEqual(result.terminalInput,[]);
 assert.deepEqual(result.errors,[]);
 result.final=await state();
 result.unknownIpc=await page.evaluate(()=>[...new Set(window.rootFixture.unknown)]);
 }
 result.sourceChanges=[];
 for(const [name,hash] of Object.entries(hashes))if(createHash('sha256').update(await fs.readFile(path.join(repo,name))).digest('hex')!==hash)result.sourceChanges.push(name);
 assert.deepEqual(result.sourceChanges,[],'current renderer inputs still match frozen Root proof');
 result.pass=true;
}catch(error){result.failure=error.stack || String(error);process.exitCode=1;
 if(page&&!page.isClosed()){try{await page.screenshot({path:path.join(artifact,'failure.png')});result.debug=await page.evaluate(()=>({state:window.rootFixture?.state?.(),unknown:window.fullViewFixture?.unknown,violations:window.fullViewFixture?.violations,html:document.body.innerText.slice(0,8000)}));}catch{}}
}finally{
 if(app){const child=app.process();try{await app.close();}catch{if(child.exitCode===null)child.kill('SIGTERM');}result.electronExited=child.exitCode!==null||child.signalCode!==null;}
 if(!app||result.electronExited){await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});result.profileRemoved=true;}
 await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));
}
console.log(JSON.stringify({artifact,pass:result.pass,checks:result.checks,failure:result.failure,errors:result.errors,cleanup:result.profileRemoved}));
