#!/usr/bin/env node
// Actual reserve/hook/transport, isolated display rows/store persistence adapter.
// Whole app + real macOS drag remain the parent's acceptance lane.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url)),artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-reserve-forest-'));
const result={artifact,checks:[],errors:[],pass:false,lease:null};let app;
const shim=`window.require=()=>({ipcRenderer:{invoke:async(...args)=>{throw Error('Private fixture forbids IPC '+args[0]);},on(){},removeListener(){},send(){throw Error('Private fixture forbids send');}}});`;
try {
  await build({entryPoints:[path.join(repo,'scripts/fixtures/workflow-reserve-dnd.tsx')],outfile:path.join(artifact,'bundle.js'),bundle:true,
    platform:'browser',format:'iife',target:'chrome120',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},
    alias:{'@noted/structured-dnd':path.resolve(repo,'../noted-shared/packages/structured-dnd/src'),react:path.join(repo,'node_modules/react'),
      'react-dom':path.join(repo,'node_modules/react-dom')},
    plugins:[{name:'explicit-component-boundaries',setup(b){
      b.onResolve({filter:/\/(useWorkspaceStore|useUIStore)$/},()=>({path:path.join(repo,'scripts/fixtures/workflow-reserve-dnd-store.ts')}));
      b.onResolve({filter:/\/(TabCard|TabBar|WorkflowGroupMenu|tabLinkedFilePreview)$/},args=>({path:args.path.split('/').at(-1),namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'tsx',resolveDir:repo,contents:args.path==='TabCard'
        ? `import React from 'react';export default React.forwardRef(({children,projectId,tabId,fullWidth,sharedActivity,selected,interactiveStatus,onLinkedFileOpen,as,...props},ref)=><span {...props} ref={ref} data-tab-card style={{display:'flex',alignItems:'center',boxSizing:'border-box',height:tabId==='Q'?52:32,padding:'4px 8px',background:selected?'#36574c':'#292e30',border:'1px solid #788',borderRadius:5,color:'#ddd'}}>{children}</span>);`
        : args.path==='TabBar' ? `export const TAB_RENAME_REQUEST_EVENT='fixture-rename';export const openTabContextMenuAt=()=>{};`
          : args.path==='tabLinkedFilePreview' ? `export const openTabLinkedFile=()=>{};export const dismissTabLinkedFile=()=>{};` : `export default function(){return null;}`}));
    }}]});
  await fs.writeFile(path.join(artifact,'index.html'),`<html><head><link rel="stylesheet" href="bundle.css"></head><body style="margin:0;background:#171717;color:#ccc;font-family:Arial"><div id="root"></div><script>${shim}</script><script src="bundle.js"></script></body></html>`);
  await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,focusable:false,width:900,height:650,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.join(repo,'node_modules/.bin/electron'),args:[path.join(artifact,'main.cjs')],env});
  result.lease={pid:app.process().pid,main:path.join(artifact,'main.cjs'),userData:path.join(artifact,'profile')};
  const page=await app.firstWindow();page.on('pageerror',error=>result.errors.push(String(error)));
  const dragLogs=[];page.on('console',message=>{if(message.text().startsWith('[WorkflowReserveDnd:')){
    dragLogs.push(message.text());if(dragLogs.length>100)dragLogs.shift();}});
  await page.waitForFunction(()=>window.fixture?.snapshot().rows.length===5);
  await page.screenshot({path:path.join(artifact,'initial.png')});
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const snapshot=()=>page.evaluate(()=>window.fixture.snapshot());
  const reset=async options=>{await page.keyboard.up('Meta');await page.evaluate(options=>window.fixture.reset(options),options || {});await frames();};
  const point=async id=>{const row=await page.locator(`[data-node-id="reserve-tab:${id}"]`).boundingBox();assert.ok(row);return{x:row.x+90,y:row.y+row.height/2};};
  const pickup=async id=>{const p=await point(id);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+5,p.y);await frames();return p;};
  const end=async()=>{await page.mouse.up();await frames();};
  const committed=()=>page.evaluate(()=>window.fixture.commits);
  const beforePickup=await point('B');await pickup('B');let s=await snapshot();
  const held=s.rows.find(row=>row.id==='reserve-tab:B');assert.ok(Math.abs(held.rect.y+held.rect.height/2-beforePickup.y)<1);
  assert.deepEqual(s.rows.map(row=>row.id),['reserve-tab:A','reserve-tab:child','reserve-tab:Q','reserve-tab:B','reserve-tab:Z']);
  assert.deepEqual(s.rows.filter(row=>row.source==='true').map(row=>row.id),['reserve-tab:A','reserve-tab:child','reserve-tab:B']);
  await page.mouse.move(120,125);await frames();s=await snapshot();await end();
  let commits=await committed();assert.equal(commits.length,1);assert.deepEqual(commits[0].request.sourceRootTabIds,['A','B']);
  assert.deepEqual(commits[0].request.workflows.find(row=>row.workflowId==='w1').reserveOrder,s.rows.map(row=>row.id.replace('reserve-tab:','')));
  result.checks.push('A,Q,B pickup B: original pickup, frozen full forest, painted Y=commit once');

  await reset();const p=await pickup('B');await page.keyboard.down('Meta');await page.mouse.move(p.x+55,p.y);await frames();
  assert.equal(await page.locator('[data-outline-tab-feedback-blocked="true"]').count(),1);await page.keyboard.press('Escape');await page.mouse.up();await frames();
  assert.equal((await committed()).length,0);result.checks.push('multi-X blocked; Escape cancels transport and projection');

  await reset({selected:['B']});const single=await pickup('B');await page.keyboard.down('Meta');await page.mouse.move(single.x+55,single.y);await frames();
  s=await snapshot();assert.equal(s.rows.find(row=>row.id==='reserve-tab:B').parent,'reserve-tab:Q');await end();
  assert.equal((await committed()).length,1);result.checks.push('single-X still reparents in painted preview');

  await reset({file:true,selected:['child']});const fileSource=await pickup('child');await page.keyboard.down('Meta');
  await page.mouse.move(fileSource.x-65,fileSource.y);await frames();s=await snapshot();
  assert.equal(s.rows.find(row=>row.id==='reserve-tab:child').parent,'root');await end();
  assert.equal((await committed())[0].request.tabs.find(tab=>tab.tabId==='child').visualParentTabId,null);
  result.checks.push('linked file X-outdent uses ordinary visual hierarchy, preview matches committed parent');
  await reset({physical:true,selected:['child']});const physicalSource=await pickup('child');await page.keyboard.down('Meta');
  await page.mouse.move(physicalSource.x-65,physicalSource.y);await frames();
  assert.equal(await page.locator('[data-outline-tab-feedback-blocked="true"]').count(),1);
  await page.keyboard.press('Escape');await page.mouse.up();await frames();assert.equal((await committed()).length,0);
  result.checks.push('physical AI child keeps execution parent and blocked feedback');

  await reset({selected:['B']});await pickup('B');await page.mouse.move(480,210,{steps:12});await frames();
  s=await snapshot();assert.equal(s.pane.target?.zone,'body');await end();commits=await committed();
  assert.equal(commits.length,1);assert.equal(commits[0].request.destinationKind,'window');
  assert.deepEqual(commits[0].request.paneRootTabIds,['B']);
  result.checks.push('reserve to window body needs no Cmd; one painted canonical placement command');

  await reset();await pickup('B');await page.locator('[data-space-chip="w2"]').hover();
  await page.waitForFunction(()=>window.fixture.store.getState().activeSpaceId==='w2');
  await page.mouse.move(120,250,{steps:6});await frames();await end();commits=await committed();
  assert.equal(commits.length,1);assert.equal(commits[0].request.targetWorkflowId,'w2');
  assert.deepEqual(commits[0].request.sourceRootTabIds,['A','B']);
  result.checks.push('ordinary reserve drag navigates workflow without modifier and keeps frozen roots');

  await reset();await pickup('B');await page.keyboard.down('Meta');await page.locator('[data-space-chip="w2"]').hover();
  await page.waitForFunction(()=>window.fixture.store.getState().activeSpaceId==='w2');await page.mouse.move(120,220);await frames();
  await page.keyboard.up('Meta');await frames();s=await snapshot();assert.equal(s.pointer.source.workflowDrag.sourceWorkflowId,'w1');await end();
  commits=await committed();assert.equal(commits.length,1);assert.equal(commits[0].request.targetWorkflowId,'w2');
  assert.deepEqual(commits[0].request.sourceRootTabIds,['A','B']);result.checks.push('reserve-origin Cmd workflow handoff keeps original forest/guards and one receiver');

  await reset({pane:true});const source=await page.locator('[data-pane-source]').boundingBox();
  await page.mouse.move(source.x+20,source.y+15);await page.mouse.down();await page.mouse.move(source.x+27,source.y+15);await frames();
  await page.keyboard.down('Meta');await page.locator('[data-space-chip="w2"]').hover();
  await page.waitForFunction(()=>window.fixture.store.getState().activeSpaceId==='w2');await page.mouse.move(120,250);await frames();
  s=await snapshot();assert.deepEqual(s.rows.filter(row=>row.source==='true').map(row=>row.id),['reserve-tab:A','reserve-tab:child','reserve-tab:B']);
  await end();await page.keyboard.up('Meta');commits=await committed();assert.equal(commits.length,1);
  assert.deepEqual(commits[0].request.workflows.find(row=>row.workflowId==='w2').reserveOrder,s.rows.map(row=>row.id.replace('reserve-tab:','')));
  result.checks.push('several pane roots -> workflow -> normal bottom slot with Cmd, exactly one painted release');

  await reset({pane:true,destination:true});
  await page.mouse.move(source.x+20,source.y+15);await page.mouse.down();await page.mouse.move(source.x+27,source.y+15);await frames();
  await page.keyboard.down('Meta');await page.locator('[data-space-chip="w2"]').hover();
  await page.waitForFunction(()=>window.fixture.store.getState().activeSpaceId==='w2');await page.mouse.move(120,400);await frames();
  await page.keyboard.up('Meta');await frames();await page.mouse.move(120,130);await frames();s=await snapshot();await end();
  commits=await committed();assert.equal(commits.length,1);assert.deepEqual(commits[0].request.sourceRootTabIds,['A','B']);
  assert.deepEqual(commits[0].request.workflows.find(row=>row.workflowId==='w2').reserveOrder,s.rows.map(row=>row.id.replace('reserve-tab:','')));
  assert.ok(s.rows.findIndex(row=>row.id==='reserve-tab:A')<s.rows.findIndex(row=>row.id==='reserve-tab:Q'));
  result.checks.push('pane modifier changes preserve exact Y positioning of whole forest among destination rows');

  await reset();await pickup('B');
  await page.evaluate(()=>window.fixture.store.setState({workflowSidebarState:{w1:{selectedTabIds:['Q']}}}));
  await page.mouse.move(120,130);await frames();await end();commits=await committed();
  assert.deepEqual(commits[0].request.sourceRootTabIds,['A','B']);result.checks.push('ordinary selection update cannot change the frozen move set');

  await reset();await pickup('B');await page.mouse.move(120,130);await page.mouse.up();await frames();
  commits=await committed();assert.equal(commits.length,1);
  assert.deepEqual(commits[0].request.workflows.find(row=>row.workflowId==='w1').reserveOrder,commits[0].painted.map(id=>id.replace('reserve-tab:','')));
  result.checks.push('release without waiting for another preview frame consumes exactly one painted result');

  await reset();await pickup('B');const oldGesture=(await snapshot()).pointer.source.gestureId;
  await page.keyboard.press('Escape');await page.mouse.up();await frames();await pickup('B');
  assert.notEqual((await snapshot()).pointer.source.gestureId,oldGesture);await page.mouse.move(120,130);await frames();await end();
  assert.equal((await committed()).length,1);result.checks.push('fast same-root new gesture owns a new identity, old cleanup cannot release it');

  await reset();await page.evaluate(()=>{window.fixture.holdCommit=true;});await pickup('B');await page.mouse.move(120,130);await frames();
  await page.mouse.up();await page.waitForFunction(()=>!!window.fixture.releaseCommit);await page.keyboard.press('Escape');
  await page.evaluate(()=>window.fixture.releaseCommit());await frames();assert.equal((await committed()).length,0);
  result.checks.push('Escape across pending commit await invalidates the callback lease');

  await reset();await pickup('B');await page.mouse.move(120,620);await end();assert.equal((await committed()).length,0);
  assert.equal((await snapshot()).pointer.active,false);result.checks.push('outside host release cancels without durable intent');
  await reset();await pickup('B');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();await frames();
  assert.equal((await committed()).length,0);assert.equal((await snapshot()).pointer.active,false);result.checks.push('blur disposal (injected signal) leaves no source lease');

  await reset({groups:true,selected:['B']});
  const groupedStart=await point('B'),emptyId='reserve-group:["__tab_catalog_v2__","empty"]';
  const empty=await page.locator('[data-reserve-group-id="empty"]').boundingBox();assert.ok(empty);
  await page.mouse.move(groupedStart.x,groupedStart.y);await page.mouse.down();
  await page.mouse.move(groupedStart.x,empty.y+empty.height/2,{steps:15});await frames();
  s=await snapshot();await page.screenshot({path:path.join(artifact,'empty-group-preview.png')});
  result.groupedPreview={start:groupedStart,target:empty,rows:s.rows,logs:[...dragLogs]};
  assert.equal(s.rows.find(row=>row.id==='reserve-tab:B').parent,emptyId);
  await end();commits=await committed();assert.equal(commits.length,1);
  assert.equal(commits[0].request.tabs.find(row=>row.tabId==='B').groupId,'empty');
  result.checks.push('grouped single-Y reaches empty group under one 15-step pointer gesture; painted parent=commit');

  await reset({pane:true,selected:[]});
  const incoming=await page.locator('[data-pane-source]').boundingBox();
  await page.mouse.move(incoming.x+20,incoming.y+15);await page.mouse.down();
  await page.mouse.move(incoming.x+27,incoming.y+15);await frames();
  await page.mouse.move(120,300,{steps:6});await frames();await end();
  assert.equal((await committed()).length,1);
  await page.locator('[data-workflow-reserve-tab="Q"]').click({modifiers:['Meta']});
  await page.locator('[data-workflow-reserve-tab="Z"]').click({modifiers:['Meta']});
  const selected=await page.locator('[data-workflow-reserve-tab][aria-pressed="true"]').evaluateAll(rows=>rows.map(row=>row.dataset.workflowReserveTab));
  assert.deepEqual(selected,['Q','Z'],'fresh selection clicks after an adopted drop must both reach the sidebar');
  result.checks.push('first fresh selection click after pane adoption is not swallowed by old drag click suppression');
  assert.deepEqual(result.errors,[]);result.pass=true;
} catch(error){result.errors.push(error.stack || String(error));}
finally {
  if(app)await app.close();
  if(result.lease){try{process.kill(result.lease.pid,0);result.errors.push('Owned process still alive after close');result.pass=false;}catch(error){if(error.code!=='ESRCH')throw error;}}
  if(result.lease && !result.errors.includes('Owned process still alive after close')){
    await fs.rm(result.lease.userData,{recursive:true,force:true});result.privateProfileRemoved=true;
  }
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(!result.pass)process.exitCode=1;
}
