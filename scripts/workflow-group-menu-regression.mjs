#!/usr/bin/env node
// Frozen new menu and authored shared styles; owned offscreen Electron only.
// Parent callbacks are spies, not proof of Root/Main workflow or close integration.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'noted-workflow-group-menu-')));
const snapshot=path.join(artifact,'source');
const files=['src/renderer/components/Workspace/WorkflowGroupMenu.tsx','src/renderer/components/Workspace/tabChrome.ts',
  'src/renderer/components/UI/contextMenuMetrics.mjs','src/renderer/styles/globals.css','src/renderer/styles/presentationAnimations.css',
  'scripts/fixtures/workflow-group-menu.tsx','scripts/workflow-group-menu-regression.mjs'];
const result={artifact,status:'running',checks:[],errors:[],hashes:{},cleanup:false,limits:['Synthetic parent callbacks; no Main/Root creation/move/close or installed app acceptance.']};
let app,child;
try {
  for(const file of files){const out=path.join(snapshot,file);await fs.mkdir(path.dirname(out),{recursive:true});const data=await fs.readFile(path.join(repo,file));
    await fs.writeFile(out,data);result.hashes[file]=createHash('sha256').update(data).digest('hex');}
  await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  const bundle=await build({entryPoints:[path.join(snapshot,'scripts/fixtures/workflow-group-menu.tsx')],bundle:true,metafile:true,
    sourcemap:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'iife',target:'chrome120',jsx:'automatic',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"'}});
  await fs.writeFile(path.join(artifact,'bundle-inputs.json'),JSON.stringify(bundle.metafile,null,2));
  execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
  await fs.writeFile(path.join(artifact,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="globals.css"><style>html,body{margin:0;background:#202020;font-family:Arial}button{cursor:pointer}</style><div id="root"></div><script src="bundle.js"></script>');
  await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
const w=new BrowserWindow({show:false,focusable:false,width:800,height:600,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});child=app.process();result.pid=child.pid;
  const page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',e=>result.errors.push(e.stack||e.message));
  const menu=page.locator('[data-workflow-group-menu]'),button=label=>page.getByRole('menuitem',{name:label,exact:true});
  const check=name=>result.checks.push(name);
  const open=async(position)=>{await page.evaluate(pos=>{window.groupFixture.fail=false;window.groupFixture.delay=false;window.groupFixture.open(pos);},position);await menu.waitFor();};
  const calls=()=>page.evaluate(()=>window.groupFixture.calls);
  const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await menu.waitFor();assert.equal(await menu.getAttribute('data-context-menu-metrics'),'compact-v1');
  assert.equal(await menu.getByText('3',{exact:true}).count(),1);assert.equal(await menu.getByText(/Project/).count(),0);
  check('Global group actions and exact active member count; no project target');
  for(const width of [350,1440]){
    await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,600),width);
    await open({x:width-2,y:598});await frames();
    const r=await menu.boundingBox();assert.ok(r.x>=8&&r.y>=8&&r.x+r.width<=width-7&&r.y+r.height<=593);
    assert.equal(await button('Переименовать').evaluate(e=>e.getBoundingClientRect().height),28);
    await page.screenshot({path:path.join(artifact,`menu-${width}.png`)});
    check('Shared 28px row and viewport clamp at '+width);
  }
  await open();await button('Переименовать').click();const name=page.getByRole('textbox',{name:'Название группы'});
  await name.fill('Изменено');await name.press('Escape');await button('Переименовать').waitFor();assert.equal((await calls()).length,0);
  await button('Переименовать').click();await name.fill('');assert.equal(await page.getByRole('button',{name:'Сохранить',exact:true}).isDisabled(),true);
  check('Rename Escape cancels and empty names cannot submit');
  await name.fill('Новая группа');await page.evaluate(()=>window.groupFixture.delay=true);
  await page.getByRole('button',{name:'Сохранить',exact:true}).dblclick();assert.equal((await calls()).length,1);
  assert.equal(await menu.getAttribute('aria-busy'),'true');await page.keyboard.press('Escape');assert.equal(await menu.count(),1);
  await page.evaluate(()=>{window.groupFixture.delay=false;window.groupFixture.release();});await menu.waitFor({state:'detached'});
  const first=(await calls())[0].payload.request;assert.equal(first.groupId,'g');assert.equal(first.expectedRevision,7);assert.equal(first.expectedGroupRevision,2);assert.equal(first.version,1);
  check('Delayed rename double click submits once, awaits real acceptance and carries exact CAS');
  await open();await button('Цвет').click();await page.evaluate(()=>window.groupFixture.lose=true);await button('Green').click();
  await page.getByRole('alert').waitFor();assert.equal(await menu.count(),1);assert.equal(await button('Назад').isDisabled(),true);
  const beforeRetry=(await calls()).at(-1);await page.getByRole('button',{name:'Повторить запрос',exact:true}).click();await menu.waitFor({state:'detached'});
  assert.deepEqual((await calls()).at(-1),beforeRetry);check('Lost mutation reply retries exact immutable request with same ID');
  await open();await button('Статус').click();await button('Готово').click();await menu.waitFor({state:'detached'});
  assert.equal((await calls()).at(-1).payload.request.status,'done');
  await open();await button('Развернуть').click();await menu.waitFor({state:'detached'});assert.equal((await calls()).at(-1).payload.request.collapsed,false);
  check('Custom status IDs and collapse state use canonical metadata mutations');
  await open();await button('Закрыть вкладки группы').click();const count=(await calls()).length;
  await button('Назад').click();assert.equal((await calls()).length,count);
  await button('Закрыть вкладки группы').click();await page.evaluate(()=>window.groupFixture.changeMembers());
  await page.getByText('Закрыть 3 вкладок группы?',{exact:false}).waitFor();await button('Подтвердить закрытие').click();await menu.waitFor({state:'detached'});
  const close=(await calls()).at(-1);assert.equal(close.type,'close');assert.deepEqual(close.payload.members.map(x=>[x.tabId,x.namespace]),[['T','P'],['U','Q'],['V2','__tab_catalog_v2__']]);
  assert.equal(close.payload.intent.expectedRevision,7);assert.ok(close.payload.intent.mutationId);
  check('Close confirmation freezes exact cross-namespace members, excludes archive, cancel makes no call');
  await open();await button('Перенести в workflow').click();await button('Inbox').click();await menu.waitFor({state:'detached'});
  const move=(await calls()).at(-1);assert.equal(move.type,'move');assert.equal(move.payload.workflowId,'inbox');assert.equal(move.payload.members.length,3);assert.ok(move.payload.intent.mutationId);
  check('Move only calls parent workflow command with exact members and stable intent');
  await open();await page.evaluate(()=>window.groupFixture.fail=true);await button('Удалить группу').click();await page.getByRole('alert').waitFor();
  assert.equal(await menu.count(),1);assert.equal(await button('Удалить группу').isEnabled(),true);
  assert.equal((await calls()).at(-1).type,'delete');assert.equal((await calls()).at(-1).payload.request.groupId,'g');
  await page.screenshot({path:path.join(artifact,'refused.png')});check('Delete definition is separate from close; false acceptance keeps menu open');
  await page.locator('#outside').click();await menu.waitFor({state:'detached'});check('Outside pointer dismisses only idle menu');
  assert.deepEqual(result.errors,[]);
  result.drift=[];for(const[file,hash]of Object.entries(result.hashes))if(createHash('sha256').update(await fs.readFile(path.join(repo,file))).digest('hex')!==hash)result.drift.push(file);
  assert.deepEqual(result.drift,[]);result.status='pass';
}catch(e){result.status='fail';result.failure=e.stack;throw e;}
finally{
  if(app){try{await app.close();}catch{if(child?.exitCode==null)child.kill('SIGTERM');}}
  await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});await fs.rm(snapshot,{recursive:true,force:true});
  result.cleanup=child?child.exitCode!==null:true;await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  process.stdout.write(JSON.stringify({artifact,status:result.status,checks:result.checks.length,errors:result.errors.length,cleanup:result.cleanup})+'\n');
}
