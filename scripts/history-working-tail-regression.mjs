#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-working-tail-'));
const snapshot=path.join(artifact,'source');
const result={artifact,checks:[],errors:[],problems:[]};const logs=[];
let app=null,ownsWorktree=false;
try{
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
ownsWorktree=true;
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
// An immutable pre-fix renderer can be supplied during concurrent product edits.
// Only this private worktree is replaced; the shared checkout is never reset.
if(process.env.NOTED_WORKING_TAIL_SOURCE){
 for(const name of ['src/renderer','packages/claude-blocks/src']){
  await fs.rm(path.join(snapshot,name),{recursive:true,force:true});
  await fs.cp(path.join(process.env.NOTED_WORKING_TAIL_SOURCE,name),path.join(snapshot,name),{recursive:true});
 }
}
if(process.env.NOTED_WORKING_TAIL_BASELINE==='1'){
 const file='src/renderer/components/Workspace/HistoryPanel.tsx';
 await fs.writeFile(path.join(snapshot,file),execFileSync('git',['show','HEAD:'+file],{cwd:repo,maxBuffer:8*1024*1024}));
}
result.source={baseline:process.env.NOTED_WORKING_TAIL_BASELINE==='1',
 frozenRenderer:process.env.NOTED_WORKING_TAIL_SOURCE||null,
 historyPanelSha256:createHash('sha256').update(await fs.readFile(path.join(snapshot,'src/renderer/components/Workspace/HistoryPanel.tsx'))).digest('hex')};
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-working-tail.tsx'),path.join(snapshot,'scripts/fixtures/history-working-tail.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-working-tail.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
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
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:720,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.ready);
 await page.waitForSelector('[data-virtuoso-scroller]');
 const sample=()=>page.evaluate(()=>{const s=document.querySelector('[data-virtuoso-scroller]');return {top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,gap:s.scrollHeight-s.scrollTop-s.clientHeight,timer:!!document.querySelector('[data-history-tail-response-timer][data-placement="tail"]')};});
 const bottom=async()=>{await page.evaluate(()=>window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom',{detail:{tabId:window.fixture.tabId}})));await page.waitForFunction(()=>{const s=document.querySelector('[data-virtuoso-scroller]');return s.scrollHeight-s.scrollTop-s.clientHeight<=2;});await page.waitForTimeout(350);};
 await bottom();result.initial=await sample();
 await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));
 await page.waitForSelector('[data-history-tail-response-timer][data-state="running"]');await page.waitForTimeout(400);
 result.appear=await sample();
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(350);
 result.removed=await sample();
 await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));await page.waitForTimeout(400);
 result.reappear=await sample();
 if(result.appear.gap>4||result.reappear.gap>4)result.problems.push('Working-only growth loses the physical bottom');
 result.checks.push('Working add/remove/reappear stays at bottom');
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(350);await bottom();
 await page.evaluate(()=>window.fixture.paste(true));await page.waitForSelector('[data-history-tail-response-timer][data-state="running"]');await page.waitForTimeout(200);
 await page.evaluate(()=>{
   window.fixture.frames=[];window.fixture.observe=true;
   const observe=()=>{if(!window.fixture.observe)return;const s=document.querySelector('[data-virtuoso-scroller]');
     window.fixture.frames.push({height:s.scrollHeight,top:s.scrollTop,timer:!!document.querySelector('[data-history-tail-response-timer][data-placement="tail"]')});requestAnimationFrame(observe);};observe();
   window.fixture.holdTiming();window.fixture.setTiming(window.fixture.running());window.fixture.paste(false);
 });
 await page.waitForTimeout(180);result.handoffWaiting=await sample();
 await page.evaluate(()=>window.fixture.releaseTiming());await page.waitForTimeout(350);result.handoffSettled=await sample();
 result.handoffFrames=await page.evaluate(()=>{window.fixture.observe=false;return window.fixture.frames;});
 result.missingWorkingFrames=result.handoffFrames.filter(f=>!f.timer).length;
 result.handoffHeightSpread=Math.max(...result.handoffFrames.map(f=>f.height))-Math.min(...result.handoffFrames.map(f=>f.height));
 if(!result.handoffWaiting.timer||result.missingWorkingFrames>0)result.problems.push('paste-to-agent handoff has an empty Working frame');
 if(result.handoffSettled.gap>4)result.problems.push('paste-to-agent handoff loses the physical bottom');
 delete result.handoffFrames;
 result.checks.push('paste→authoritative activity handoff');
 const scroller=page.locator('[data-virtuoso-scroller]');const b=await scroller.boundingBox();
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.wheel(0,-500);await page.waitForTimeout(300);
 result.up=await sample();assert.ok(result.up.gap>150);
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(300);await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));await page.waitForTimeout(400);
 result.reader=await sample();assert.ok(result.reader.gap>150);assert.ok(Math.abs(result.reader.top-result.up.top)<4);result.checks.push('trusted upward wheel cancels follow through timer changes');

 const phase=name=>page.evaluate(name=>{window.fixture.state.phase=name;},name);
 const snapshotFrames=async name=>{
  const frames=await page.evaluate(()=>window.fixture.state.frames);
  await fs.writeFile(path.join(artifact,name+'.frames.json'),JSON.stringify(frames,null,2));
  return frames;
 };
 const failIf=(condition,message)=>{if(condition)result.problems.push(message);};
 const mouseWheel=async dy=>{const box=await scroller.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,dy);};
 const beginProbe=async(cancel,hold=false)=>page.evaluate(({cancel,hold})=>{
  window.fixture.state.wheels=[];window.fixture.state.scrolls=[];window.fixture.installWheelProbe(cancel,hold);
 },{cancel,hold});

 // Real reveal/search actions run while callbacks queued by a cancelled wheel
 // are held in the fixture scheduler. Do not replace product handlers/state.
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(350);await bottom();
 await beginProbe(true,true);await mouseWheel(-2);
 await page.waitForFunction(()=>window.fixture.state.wheels.length===1);
 result.expandPendingFrames=await page.evaluate(()=>window.fixture.heldFrameCount());
 assert.ok(result.expandPendingFrames>0,'fixture must hold wheel-scheduled callbacks');
 const tool=page.locator('[data-uuid="row-99"] .cb-tool-head--clickable').first();
 await tool.locator('.cb-tool-head-inner').click();
 await page.waitForFunction(()=>document.querySelector('[data-uuid="row-99"] .cb-tool-head--clickable')?.getAttribute('aria-expanded')==='true');
 await page.waitForTimeout(300);result.afterExpand=await sample();
 await page.evaluate(()=>{window.fixture.releaseWheelFrames();window.fixture.removeWheelProbe();});
 await page.waitForTimeout(100);await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));await page.waitForTimeout(300);
 result.afterExpandWorking=await sample();
 failIf(result.afterExpandWorking.gap<20||Math.abs(result.afterExpandWorking.top-result.afterExpand.top)>1,'pending wheel verification overrides explicit card reveal');
 await tool.locator('.cb-tool-head-inner').click();
 await page.waitForTimeout(300);await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(300);
 result.checks.push('real card expand before pending wheel callbacks retains reader ownership on Working growth');

 await page.evaluate(()=>window.fixture.search());
 const search=page.locator('[data-history-search-panel]');await search.waitFor();
 await search.getByLabel('Поиск по чату',{exact:true}).fill('Record 99');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/1');
 await bottom();await beginProbe(true,true);await mouseWheel(-2);
 await page.waitForFunction(()=>window.fixture.state.wheels.length===1);
 result.searchPendingFrames=await page.evaluate(()=>window.fixture.heldFrameCount());assert.ok(result.searchPendingFrames>0);
 await search.locator('[data-history-search-result="0"]').click();await page.waitForTimeout(350);
 result.afterSearch=await sample();
 await page.evaluate(()=>{window.fixture.releaseWheelFrames();window.fixture.removeWheelProbe();});
 await page.waitForTimeout(100);await page.evaluate(()=>window.fixture.setTiming(window.fixture.running()));await page.waitForTimeout(350);
 result.afterSearchWorking=await sample();
 failIf(result.afterSearchWorking.gap<20||Math.abs(result.afterSearchWorking.top-result.afterSearch.top)>1,'pending wheel verification overrides explicit search navigation');
 await search.getByLabel('Закрыть поиск по чату').click();
 result.checks.push('real search-result click before pending wheel callbacks retains reader ownership on Working growth');

 // Browser-cancelled trusted wheel is a deterministic zero-displacement outcome,
 // not a replay of macOS momentum/hardware. The app's own wheel listener still runs.
 await page.evaluate(()=>window.fixture.setTiming(null));await page.waitForTimeout(350);await bottom();
 await beginProbe(true);result.zeroMotionBefore=await sample();await mouseWheel(-2);
 await page.waitForTimeout(260);result.zeroMotionAfter=await sample();
 result.zeroMotionWheel=await page.evaluate(()=>({wheels:window.fixture.state.wheels,scrolls:window.fixture.state.scrolls}));
 assert.equal(result.zeroMotionWheel.wheels.length,1);
 assert.ok(result.zeroMotionWheel.wheels[0].trusted&&result.zeroMotionWheel.wheels[0].prevented);
 assert.equal(result.zeroMotionAfter.top,result.zeroMotionBefore.top,'cancelled native wheel must not move the scroller');
 assert.equal(result.zeroMotionWheel.scrolls.length,0,'zero-motion control must have no scroll event');
 assert.ok(logs.some(line=>line.includes('SCROLL_GESTURE_INPUT')&&line.includes('deltaY=-2')),'actual History wheel handler must receive the trusted event');
 await page.evaluate(()=>window.fixture.removeWheelProbe());
 await page.evaluate(()=>window.fixture.startObservation());await phase('composer-grow');
 const editor=page.locator('[data-history-composer-tab-id] .cm-content[contenteditable="true"],.cm-content[data-history-composer-tab-id][contenteditable="true"]').last();
 const prompt=Array.from({length:8},(_,i)=>'Fixture multiline prompt line '+i).join('\n');
 const composerHeight=()=>page.locator('[data-history-controls]').evaluate(el=>el.getBoundingClientRect().height);
 result.composerBefore=await composerHeight();await editor.click();await page.keyboard.insertText(prompt);
 await page.waitForFunction(h=>document.querySelector('[data-history-controls]').getBoundingClientRect().height>h+20,result.composerBefore);
 await page.waitForTimeout(300);result.composerAfter=await composerHeight();result.afterComposer=await sample();
 await phase('real-composer-send');await editor.press('Enter');
 await page.waitForFunction(()=>window.fixture.state.sends.length===1);
 result.sent=await page.evaluate(()=>window.fixture.state.sends[0]);assert.equal(result.sent.text,prompt);
 await page.waitForSelector('[data-history-tail-response-timer][data-state="running"]');
 await page.waitForTimeout(250);result.afterSend=await sample();
 await phase('send-settled');await page.evaluate(()=>window.fixture.releaseSend());await page.waitForTimeout(350);
 result.afterReceipt=await sample();
 result.streaming=[];
 for(let step=1;step<=5;step++){
  await phase('stream-'+step);await page.evaluate(step=>window.fixture.stream(step),step);
  await page.waitForFunction(step=>[...document.querySelectorAll('[data-uuid]')].some(e=>e.textContent.includes('STREAMED TAIL '+step)),step);
  await page.waitForTimeout(180);result.streaming.push(await sample());
 }
 await page.evaluate(()=>{window.fixture.state.observing=false;});
 const followFrames=await snapshotFrames('zero-motion-send');
 result.followFrameCount=followFrames.length;
 result.followMaxGap=Math.max(...followFrames.map(f=>f.gap));
 result.followMaxConsecutiveOffBottom=followFrames.reduce((s,f)=>{s.run=f.gap>4?s.run+1:0;s.max=Math.max(s.max,s.run);return s;},{run:0,max:0}).max;
 // Existing tail pin intentionally settles across layout frames. Record every
 // frame, reject a stuck interval, and require the edge after every mutation.
 failIf(result.afterComposer.gap>4,'zero-motion wheel loses bottom when multiline composer grows');
 failIf(result.afterSend.gap>4||result.afterReceipt.gap>4,'zero-motion wheel loses bottom after real composer Send');
 failIf(result.streaming.some(s=>s.gap>4),'zero-motion wheel loses bottom during live tail growth');
 failIf(result.followMaxConsecutiveOffBottom>6,'follow remains off-bottom for more than six layout frames');
 result.checks.push('trusted cancelled -2 wheel, multiline composer, real Enter Send through mock IPC, streamed tail across frames');
 await page.screenshot({path:path.join(artifact,'zero-motion-send.png')});

 // Tiny real displacement must retain reader ownership even inside the usual
 // four-pixel bottom tolerance. Every stimulus is trusted browser wheel input.
 result.tinyUp=[];
 for(const pixels of [1,2]){
  await bottom();await beginProbe(false);const before=await sample();await mouseWheel(-pixels);await page.waitForTimeout(260);
  const up=await sample();const probe=await page.evaluate(()=>({wheels:window.fixture.state.wheels,scrolls:window.fixture.state.scrolls}));
  assert.ok(probe.wheels.some(e=>e.trusted&&!e.prevented&&e.deltaY===-pixels));
  assert.ok(probe.scrolls.length>0,'tiny wheel must produce an actual browser scroll');
  assert.ok(before.top-up.top>=pixels-0.1&&before.top-up.top<=pixels+0.1,'tiny wheel must displace exactly '+pixels+'px');
  await page.evaluate(()=>window.fixture.removeWheelProbe());
  await phase('tiny-up-'+pixels);await page.evaluate(()=>window.fixture.startObservation());
  // Keep Working mounted: removing its height would legally clamp an offset
  // only one pixel above the old bottom. This case tests growth, never shrink.
  await page.evaluate(step=>window.fixture.stream(step),5+pixels);await page.waitForTimeout(350);
  const after=await sample();await page.evaluate(()=>{window.fixture.state.observing=false;});
  const frames=await snapshotFrames('tiny-up-'+pixels);const maxDrift=Math.max(...frames.map(f=>Math.abs(f.top-up.top)));
  result.tinyUp.push({pixels,before,up,after,probe,maxDrift,frames:frames.length});
  failIf(Math.abs(after.top-up.top)>0.5||maxDrift>0.5,'real '+pixels+'px upward motion is overwritten during tail growth');
  failIf(after.gap<=4,'real '+pixels+'px reader must stay above the growing tail');
 }
 result.checks.push('real one- and two-pixel upward wheel preserve reading during streaming growth with Working mounted');
 result.fixture=await page.evaluate(()=>({forbidden:window.fixture.state.forbidden,invokes:[...new Set(window.fixture.state.invokes)],reads:window.fixture.state.reads}));
 assert.deepEqual(result.fixture.forbidden,[]);
 await page.screenshot({path:path.join(artifact,'final.png')});assert.deepEqual(result.errors,[]);assert.deepEqual(result.problems,[]);result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.stack;process.exitCode=1;if(app)await app.firstWindow().then(p=>p.screenshot({path:path.join(artifact,'failure.png')})).catch(()=>{});}
finally{
 let closed=!app;
 if(app)try{await app.close();closed=true;}catch(error){result.closeError=String(error);process.exitCode=1;}
 // Remove only the exact worktree created by this run, after its Electron lease
 // closes. A failed build also arrives here. Never prune somebody else's trees.
 if(ownsWorktree&&closed)try{execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});result.worktreeRemoved=true;}
 catch(error){result.cleanupError=String(error);process.exitCode=1;}
 await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
 await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));console.log(JSON.stringify(result));
}
