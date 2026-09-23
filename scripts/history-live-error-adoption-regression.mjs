#!/usr/bin/env node
// Isolated React/Virtuoso + shipping live merge/grouping/key functions.
// Controlled records and row bodies: no app, user session, PTY or native input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-error-adoption-'));
const expectDuplicates = process.argv.includes('--expect-duplicates');
const projectionPath = path.join(repo, 'src/renderer/utils/historyLiveProjection.mjs');
const projectionSource = await fs.readFile(projectionPath, 'utf8');
const panel = await fs.readFile(path.join(repo, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const tree = ts.createSourceFile('HistoryPanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let keyFunction;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'historyVirtuosoUnitKey') {
    keyFunction = node.initializer.getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(keyFunction);
const entry = `
import React, {useState, useRef, useLayoutEffect, useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {Virtuoso} from 'react-virtuoso';
import {buildHistoryLivePresentation, reduceHistoryLiveProjection, reconcileCommittedHistoryLiveProjection,
  historyLivePresentationKey} from './src/renderer/utils/historyLiveProjection.mjs';
import {buildHistoryDisplayUnits, isGroupUnit} from './src/renderer/utils/historyDisplayUnits.mjs';
const historyVirtuosoUnitKey = ${keyFunction};
const sessionId = 'fixture-only';
const text = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const event = (uuid, kind='provider-error') => ({toolType:'claude', sessionId, recordByteOffset:2100,
  message:{type:'assistant',uuid,sessionId,isApiErrorMessage:true,timestamp:'2026-09-22T17:41:59.011Z',
    ...(kind==='usage-limit'?{apiErrorStatus:429,error:'rate_limit'}:{}),
    message:{role:'assistant',content:[{type:'text',text}]}}});
const row = (uuid,content,offset) => ({uuid,role:'assistant',content,sessionId,recordByteOffset:offset});
const prefix = Array.from({length:20}, (_,i) => row('old-'+i,'Earlier record '+i+' · '.repeat(6),i*100));
function Case({kind}) {
 const [live,setLive] = useState(()=>reduceHistoryLiveProjection([],event('error-one',kind)));
 const [durable,setDurable] = useState(prefix);
 const [visible,setVisible] = useState(true);
 const list = useRef(null); const epoch = useRef(0);
 const entries=useMemo(()=>buildHistoryLivePresentation(durable,live),[durable,live]);
 const units=useMemo(()=>buildHistoryDisplayUnits(entries,{enabled:true,threshold:2,expandedKeys:new Set()}),[entries]);
 useLayoutEffect(()=>{
   const remaining=reconcileCommittedHistoryLiveProjection(live,durable).entries;
   if(remaining!==live)setLive(remaining);
 },[durable,live]);
 const accept=()=>setDurable([...prefix,...reduceHistoryLiveProjection([],event('error-one',kind)),
   row('after','Reply after the error. '.repeat(9),2200)]);
 const update=()=>{
   setLive(old=>reduceHistoryLiveProjection(old,event('error-one',kind)));
   setDurable(old=>[...old.filter(x=>x.uuid!=='working'),row('working','Working '+(++epoch.current),2300)]);
 };
 window.fixture={accept,update,show:setVisible,
   addRealFailure:()=>setDurable(old=>[...old,...reduceHistoryLiveProjection([],event('error-two',kind))]),
   state:()=>({rows:entries.length,errorRows:entries.filter(e=>e.uuid==='error-one').length,
     liveErrors:live.filter(e=>e.uuid==='error-one').length,keys:units.map(historyVirtuosoUnitKey)}),
 };
 return <><nav><button id="accept" onClick={accept}>Canonical refresh</button>
  <button id="update" onClick={update}>Next live update</button></nav>
  <section style={{opacity:visible?1:0,height:680}}>
  <Virtuoso ref={list} style={{height:'100%'}} data={units} initialTopMostItemIndex={16}
    computeItemKey={(_,unit)=>historyVirtuosoUnitKey(unit)} defaultItemHeight={90}
    skipAnimationFrameInResizeObserver
    itemContent={(_,unit)=><div data-record={unit.entry.uuid} data-role={unit.entry.role}
      style={{padding:'16px 8px',minHeight:unit.entry.role==='assistant'?90:22,
      color:unit.entry.role==='assistant'?'#ddd':'#cf4b78',borderBottom:'1px solid #333'}}>{unit.entry.content}</div>}/>
  </section></>;
}
let key=0;const root=createRoot(document.getElementById('root'));
window.start=(kind)=>root.render(<Case key={++key} kind={kind}/>);window.start('provider-error');
`;
await build({stdin:{contents:entry,resolveDir:repo,loader:'tsx'},bundle:true,platform:'browser',format:'iife',
  outfile:path.join(dir,'bundle.js'),define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
await fs.writeFile(path.join(dir,'index.html'), '<style>body{margin:0;background:#141414;color:white;font:16px Arial}button{margin:8px}*{box-sizing:border-box}</style><div id="root"></div><script src="bundle.js"></script>');
await fs.writeFile(path.join(dir,'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir,'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:1040,height:800,
 webPreferences:{offscreen:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(dir,'index.html'))});});
app.on('window-all-closed',()=>app.quit());`);
const result={artifacts:dir,expectDuplicates,sourceHash:createHash('sha256').update(projectionSource).digest('hex'),checks:[],pageErrors:[]};
let app;
try {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(dir,'main.cjs')],cwd:dir,env});
  const page=await app.firstWindow();page.setDefaultTimeout(10000);
  page.on('pageerror',e=>result.pageErrors.push(e.message));
  const frames=n=>page.evaluate(n=>new Promise(resolve=>{const tick=()=>--n<=0?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick)}),n);
  for(const kind of ['provider-error','usage-limit']){
    if(kind!=='provider-error')await page.evaluate(kind=>window.start(kind),kind);
    await page.waitForFunction(()=>!!window.fixture&&document.querySelector('[data-virtuoso-scroller]'));
    await frames(6);
    await page.screenshot({path:path.join(dir,kind+'-before.png')});
    const before=await page.evaluate(()=>({state:window.fixture.state(),copies:document.querySelectorAll('[data-record="error-one"]').length}));
    assert.equal(before.state.errorRows,1);
    await page.locator('#accept').click();await frames(8);
    const samples=[];
    for(let i=0;i<8;i++){
      await page.locator('#update').click();await frames(3);
      const rect=await page.locator('[data-virtuoso-scroller]').boundingBox();
      await page.mouse.move(rect.x+180,rect.y+250);await page.mouse.wheel(0,-280);await frames(12);
      samples.push(await page.evaluate(()=>document.querySelectorAll('[data-record="error-one"]').length));
      await page.mouse.wheel(0,280);await frames(12);
      samples.push(await page.evaluate(()=>document.querySelectorAll('[data-record="error-one"]').length));
    }
    await page.screenshot({path:path.join(dir,kind+'-after.png')});
    const after=await page.evaluate(()=>window.fixture.state());
    result.checks.push({kind,before,after,samples,maxCopies:Math.max(...samples)});
    if(expectDuplicates){assert.ok(after.errorRows>1);assert.ok(Math.max(...samples)>1);}
    else {
      assert.equal(after.errorRows,1);assert.equal(after.liveErrors,0);
      assert.equal(new Set(after.keys).size,after.keys.length);assert.equal(Math.max(...samples),1);
      await page.evaluate(()=>window.fixture.show(false));await frames(3);
      await page.evaluate(()=>{window.fixture.update();window.fixture.show(true)});await frames(8);
      assert.equal((await page.evaluate(()=>window.fixture.state())).errorRows,1);
      await page.evaluate(()=>window.fixture.addRealFailure());await frames(8);
      assert.equal((await page.evaluate(()=>window.fixture.state())).rows,24,'a real separate error is retained');
    }
  }
  assert.deepEqual(result.pageErrors,[]);result.status='pass';
} catch(error){result.status='fail';result.error=String(error.stack||error);process.exitCode=1;}
finally{if(app)await app.close();await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result));
