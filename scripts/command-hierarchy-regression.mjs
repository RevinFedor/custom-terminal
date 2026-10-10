#!/usr/bin/env node
// Actual shared React hook and file-explorer + Terminal hint. No application,
// filesystem moves, native cursor or provider. Whole-app proof is separate.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {_electron as electron} from 'playwright';
const repo=fileURLToPath(new URL('..',import.meta.url)),artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-command-hierarchy-'));
const result={artifact,checks:[],errors:[],pass:false};let app,page;
try {
  await build({entryPoints:[path.join(repo,'scripts/fixtures/command-hierarchy.tsx')],outfile:path.join(artifact,'bundle.js'),
    bundle:true,platform:'browser',format:'iife',jsx:'automatic',target:'chrome120',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"'},alias:{'@noted/structured-dnd':path.resolve(repo,'../noted-shared/packages/structured-dnd/src'),
      '@noted/file-explorer':path.resolve(repo,'../noted-shared/packages/file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')}});
  await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;background:#181a20;color:#ddd;font:14px system-ui}section{width:250px;height:350px;border:1px solid #555}header{padding:12px}.outline-dnd-tree{height:300px!important}[data-feedback]{float:right;color:#aacdff}</style><div id="root"></div><script src="bundle.js"></script>');
  await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});
    app.setActivationPolicy('accessory');app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!d.url.startsWith('file:')}));
    const w=new BrowserWindow({show:false,width:1000,height:600,webPreferences:{offscreen:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});result.pid=app.process().pid;
  page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.setDefaultTimeout(5000);
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const row=(id,panel='terminal')=>page.locator(`[data-panel="${panel}"] [data-node-id="${id}"]`);
  const reset=async()=>{await page.keyboard.up('Meta');await page.keyboard.press('Escape');await page.mouse.up();await page.evaluate(()=>{window.fixture.panels.terminal.reset();window.fixture.panels.legacy.reset();window.fixture.commits=[];});await frames();};
  const pickup=async(id,panel='terminal')=>{const r=await row(id,panel).boundingBox();const p={x:r.x+70,y:r.y+16};await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+6,p.y);await frames();return{x:p.x+6,y:p.y};};
  await row('b').waitFor();await row('b').hover();const renders=await page.evaluate(()=>[window.fixture.renders,window.fixture.retainedRenders]);
  await page.keyboard.down('Meta');await frames();assert.equal(await page.locator('[data-command-hierarchy-hint]').count(),1);
  assert.deepEqual(await page.evaluate(()=>[window.fixture.renders,window.fixture.retainedRenders]),renders);
  await page.keyboard.down('Shift');await page.keyboard.up('Shift');assert.ok((await page.evaluate(()=>window.fixture.previewCommands)).every(e=>!e.prevented));
  await page.screenshot({path:path.join(artifact,'hint.png')});await page.keyboard.up('Meta');await frames();assert.equal(await page.locator('[data-command-hierarchy-hint]').count(),0);
  result.checks.push('hover then Cmd: separate badge, no row/retained render, modifiers still reach independent handlers');
  const plain=await pickup('b');await page.mouse.move(plain.x+70,plain.y);await frames();assert.equal(await row('b').getAttribute('data-depth'),'0');
  await page.mouse.up();await frames();result.checks.push('plain X does not reparent');
  await reset();const p=await pickup('b');await page.mouse.move(p.x+55,p.y);await frames();await page.keyboard.down('Meta');await frames();
  assert.equal(await row('b').getAttribute('data-depth'),'0');await page.mouse.move(p.x+105,p.y);await frames();assert.equal(await row('b').getAttribute('data-parent-id'),'a');
  await page.keyboard.up('Meta');await page.mouse.move(p.x+40,p.y);await frames();assert.equal(await row('b').getAttribute('data-parent-id'),'a');
  await page.mouse.up();await frames();result.checks.push('Cmd key edge rebases, fresh X reparents once, Cmd-up disarms X without stale movement');
  await reset();const y=await pickup('c');const a=await row('a').boundingBox();await page.mouse.move(y.x,a.y+10,{steps:12});await frames();
  const painted=await page.locator('[data-panel="terminal"] [data-node-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.nodeId));await page.mouse.up();await frames();
  assert.equal(painted[0],'c');assert.equal((await page.evaluate(()=>window.fixture.commits)).length,1);result.checks.push('plain Y reorder still paints and commits');
  await reset();const old=await pickup('b','legacy');await page.mouse.move(old.x+55,old.y);await frames();assert.equal(await row('b','legacy').getAttribute('data-parent-id'),'a');
  await page.keyboard.press('Escape');await page.mouse.up();await frames();assert.equal(await row('b','legacy').getAttribute('data-depth'),'0');
  result.checks.push('default legacy client retains plain X and cancel');
  await reset();const nav=await pickup('c');const folder=await row('folder').boundingBox();
  await page.mouse.move(folder.x+70,folder.y+folder.height/2,{steps:20});
  await page.waitForSelector('[data-panel="terminal"] [data-node-id="child"]');await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Meta');await frames();
  assert.equal(await row('child').count(),0);result.checks.push('plain foreign-folder hover expands without Cmd, Escape restores temporary expansion');
  const file=row('/fixture/two.md','file-explorer'),fr=await file.boundingBox();await page.mouse.move(fr.x+55,fr.y+14);await page.mouse.down();
  await page.mouse.move(fr.x+61,fr.y+14);await frames();await page.mouse.move(fr.x+115,fr.y+14);await frames();assert.equal(await file.getAttribute('data-depth'),'0');
  await page.keyboard.down('Meta');await page.mouse.move(fr.x+166,fr.y+14);await frames();assert.equal(await file.getAttribute('data-depth'),'1');
  await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Meta');await frames();assert.equal(await file.getAttribute('data-depth'),'0');
  result.checks.push('actual FileOutlineExplorer opts in; plain X stable, Cmd X visual nesting, cancel has no filesystem side effect');
  assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.errors.push(error.stack||String(error));process.exitCode=1;
  if(page){result.failure=await page.evaluate(()=>({logs:window.fixture.logs,drag:window.fixture.panels.terminal.state(),
    rows:[...document.querySelectorAll('[data-node-id]')].map(el=>({id:el.dataset.nodeId,parent:el.dataset.parentId,rect:el.getBoundingClientRect().toJSON()}))}));
    await page.screenshot({path:path.join(artifact,'failure.png')});}}
finally{if(app){await app.close();try{process.kill(result.pid,0);result.pidStopped=false;}catch(error){result.pidStopped=error.code==='ESRCH';}}
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
