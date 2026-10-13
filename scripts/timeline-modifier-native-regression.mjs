// Actual Timeline in an owned offscreen Electron. All data/IPC are synthetic;
// no app server, provider, OS clipboard, user pointer or production inspector.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';
import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-timeline-modifier-'));
const snapshot = path.join(artifact, 'source');
const result = {artifact, status:'running', errors:[], cases:[],
  boundary:'Actual Timeline with one private render counter, synthetic store/data/IPC, owned offscreen Electron. Functional projection and diagnostic proof; concurrent peer native work may affect timings.'}; let app;
const logs=[];
try {
  for(const name of ['src','packages/claude-blocks']) await fs.cp(path.join(repo,name),path.join(snapshot,name),
    {recursive:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
  await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
  await fs.copyFile(path.join(repo,'scripts/fixtures/timeline-modifier-native.tsx'),path.join(snapshot,'scripts/fixtures/timeline-modifier-native.tsx'));
  await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  const timelinePath=path.join(snapshot,'src/renderer/components/Workspace/Timeline.tsx');
  const source=await fs.readFile(timelinePath,'utf8');
  result.timelineSHA=createHash('sha256').update(source).digest('hex');
  const ast=ts.createSourceFile('Timeline.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let insertion;
  function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='Timeline')insertion=node.body.getStart(ast)+1;ts.forEachChild(node,visit);}
  visit(ast);assert.ok(insertion,'actual Timeline function body');
  await fs.writeFile(timelinePath,source.slice(0,insertion)+'\n(window as any).modifierFixture.renders[tabId] = ((window as any).modifierFixture.renders[tabId] || 0) + 1;\n'+source.slice(insertion));
  result.instrumentation='one render counter at the start of the actual Timeline function, same in both arms';
  const shared=path.join(artifact,'noted-shared/packages');
  for(const name of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'../noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
  await build({entryPoints:[path.join(snapshot,'scripts/fixtures/timeline-modifier-native.tsx')],bundle:true,
    outfile:path.join(artifact,'bundle.js'),sourcemap:true,platform:'browser',format:'iife',target:'chrome120',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
    alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),
      '@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),
      react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
    loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl','.png':'dataurl','.b64':'text'}});
  execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
  function shim(){
    const listeners=new Map();const f=window.modifierFixture={renders:{},reads:0,violations:[]};
    const deny=c=>{f.violations.push(c);throw Error('Forbidden fixture operation '+c);};
    const ipc={invoke:async(c,p)=>{
      if(c==='agent-transcript:get-timeline'){f.reads++;return{success:true,entries:f.timeline(p.sessionId)};}
      if(c==='tab-work-context:get')return{success:true,context:{tabId:p.tabId,files:[],revision:1,updates:[],pendingCount:0}};
      if(c==='agent-session:get-availability-batch')return{success:true,results:p.sessions.map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
      if(c==='agent:get-send-receipts')return{success:true,records:[]};
      if(/terminal:(input|paste|create|kill)|agent:(send|rewind|stop)|claude.*spawn|codex:run/.test(c))return deny(c);
      if(/list|List|fork.*markers|fork-markers|notes/.test(c))return[];
      if(c.includes('getState')||c.includes('get-state'))return null;
      return{success:true};
    },send(c){if(/terminal:(input|paste|create|kill)|clipboard/.test(c))deny(c);},sendSync(){return null;},
    on(c,fn){if(!listeners.has(c))listeners.set(c,new Set());listeners.get(c).add(fn);return ipc;},
    off(c,fn){listeners.get(c)?.delete(fn);return ipc;},removeListener(c,fn){return ipc.off(c,fn);},removeAllListeners(c){listeners.delete(c);}};
    const fakePath={sep:'/',basename:s=>s.split('/').pop(),dirname:s=>s.slice(0,s.lastIndexOf('/'))||'/',
      join:(...s)=>s.join('/'),extname:s=>s.includes('.')?'.'+s.split('.').pop():'',resolve:(...s)=>s.join('/'),relative:(a,b)=>b.replace(a+'/',''),isAbsolute:s=>s.startsWith('/')};
    window.require=n=>n==='electron'?{ipcRenderer:ipc,clipboard:new Proxy({},{get:()=>()=>deny('clipboard')}),shell:{openExternal:()=>deny('shell')},webFrame:{getZoomFactor:()=>1}}:
      n==='path'?fakePath:n==='process'?{platform:'darwin',env:{NOTED_E2E_TEST:'true'}}:
      n==='net'?{createConnection:()=>({on(){return this;},unref(){},destroy(){},write(){}})}:
      n==='node:v8'||n==='node:buffer'?{}:deny('require:'+n);
    window.process=window.require('process');window.fetch=()=>Promise.reject(Error('fixture network disabled'));
  }
  await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;background:#181818;color:#ccc}</style><div id="root"></div><script>('+shim.toString()+')()</script><script src="bundle.js"></script>');
  await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));const w=new BrowserWindow({show:false,focusable:false,width:1000,height:720,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});result.pid=app.process().pid;
  const page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>result.errors.push(e.stack));
  page.on('console',message=>logs.push(message.text()));
  await page.waitForFunction(()=>document.querySelectorAll('[data-modifier-owner]').length===12
    && [...document.querySelectorAll('[data-modifier-owner]')].every(owner=>owner.querySelectorAll('[data-timeline-entry-uuid]').length===600));
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const client=await page.context().newCDPSession(page);await client.send('Performance.enable');
  const metrics=async()=>Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  await page.locator('[data-modifier-input]').focus();await frames();
  for(const phase of ['down','up']){
    const before=await page.evaluate(()=>({...window.modifierFixture.renders})),nativeBefore=await metrics();
    const summaryPromise=page.waitForEvent('console',{predicate:message=>message.text().startsWith('[Perf:ModifierOwners]')});
    const start=Date.now();await page.keyboard[phase]('Meta');await frames();
    const summaryLine=(await summaryPromise).text();
    const summary=JSON.parse(summaryLine.slice(summaryLine.indexOf('{')));
    assert.equal(summary.owners,12);assert.equal(summary.presentedRelevant,0);
    assert.equal(summary.truePublications+summary.falsePublications,0);
    const exactAction=await page.evaluate(id=>window.modifierFixture.actions.find(action=>action?.id===id),summary.actionId);
    assert.equal(exactAction.keyClass,'Meta');assert.equal(exactAction.event,phase==='down'?'keydown':'keyup');
    const after=await page.evaluate(()=>({...window.modifierFixture.renders})),nativeAfter=await metrics();
    result.cases.push({phase,wallMs:Date.now()-start,changedOwners:Object.keys(after).filter(k=>after[k]!==before[k]),
      summary,renders:Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-(before[k]||0)])),
      metrics:Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','ThreadTime'].map(k=>[k,(nativeAfter[k]-nativeBefore[k])*1000]))});
  }
  if(!process.argv.includes('--baseline'))for(const item of result.cases)assert.deepEqual(item.changedOwners,[],
    'a composer modifier must not publish React state to uninvolved retained Timelines');
  const snapshotRenders=()=>page.evaluate(()=>({...window.modifierFixture.renders}));
  const marker=page.locator('[data-timeline-entry-uuid="owner-0-row-599"]');
  const preview=page.locator('[data-timeline-preview-user="owner-0-row-599"]');
  const hoverBefore=await snapshotRenders();
  await page.keyboard.down('Meta');await marker.hover();await preview.waitFor({state:'visible'});await frames();
  const hoverAfter=await snapshotRenders();
  assert.ok(hoverAfter['owner-0']>hoverBefore['owner-0']);
  for(const id of Object.keys(hoverAfter))if(id!=='owner-0')assert.equal(hoverAfter[id],hoverBefore[id],'Cmd hover updates only its Timeline');
  await page.keyboard.up('Meta');await preview.waitFor({state:'hidden'});
  result.cases.push({phase:'Meta-before-hover',target:'owner-0-row-599',popup:true,otherOwnersChanged:false});
  await page.keyboard.down('Meta');await preview.waitFor({state:'visible'});
  await page.keyboard.down('Shift');await page.keyboard.up('Shift');await page.keyboard.up('Meta');await frames();
  assert.equal(await preview.isVisible(),true,'Cmd+Shift pin survives modifier release');
  await page.locator('[data-modifier-input]').click();await preview.waitFor({state:'hidden'});
  result.cases.push({phase:'hover-before-Meta-and-pin',releaseKeepsPinned:true,outsideDismisses:true});
  await page.keyboard.down('Meta');await marker.hover();await preview.waitFor({state:'visible'});
  await page.evaluate(()=>window.modifierFixture.show(false));await frames();await page.keyboard.up('Meta');
  await page.evaluate(()=>window.modifierFixture.show(true));await frames();
  await page.mouse.move(800,60);await page.locator('[data-modifier-input]').click();await frames();
  const resumedBefore=await snapshotRenders();await page.keyboard.down('Meta');await page.keyboard.up('Meta');await frames();
  const resumedAfter=await snapshotRenders();assert.deepEqual(resumedAfter,resumedBefore);
  result.cases.push({phase:'hide-show-release',before:resumedBefore,after:resumedAfter});
  await page.screenshot({path:path.join(artifact,'timeline.png')});
  result.state=await page.evaluate(()=>({reads:window.modifierFixture.reads,violations:window.modifierFixture.violations,
    nodes:document.getElementsByTagName('*').length,draft:document.querySelector('[data-modifier-input]').value}));
  assert.equal(result.state.draft,'unchanged draft');assert.deepEqual(result.state.violations,[]);assert.deepEqual(result.errors,[]);
  result.status='pass';
}catch(error){result.status='fail';result.error=error.stack;process.exitCode=1;}
finally{
  if(app)await app.close();
  if(result.pid){try{process.kill(result.pid,0);result.processExited=false;}catch{result.processExited=true;}}
  await fs.rm(snapshot,{recursive:true,force:true});await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});
  await fs.rm(path.join(artifact,'noted-shared'),{recursive:true,force:true});
  await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));result.cleanup=true;
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
}
console.log(JSON.stringify(result));
