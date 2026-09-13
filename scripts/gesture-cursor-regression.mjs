#!/usr/bin/env node
// Standalone Electron fixture, no Noted app/DB/PTY, native input or live source
// server. The bundle is an immutable snapshot. Offscreen painting keeps the
// user's OS focus/cursor untouched while CDP dispatches trusted pointer input.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-gesture-cursor-'));
const source = await build({ entryPoints: [path.join(root, 'src/renderer/utils/interactionCursor.ts')],
  bundle: true, write: false, format: 'iife', globalName: 'cursorModule' });
await fs.writeFile(path.join(dir, 'cursor.js'), source.outputFiles[0].text);
const rowSource = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React, {useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {useConstrainedHorizontalReorder,HORIZONTAL_ROW_DRAG_END} from './src/renderer/hooks/useConstrainedHorizontalReorder';
import {historyForegroundPriority} from './src/renderer/utils/historyForegroundPriority.mjs';
import {getInteractionCursor} from './src/renderer/utils/interactionCursor';
function Row(){
 const [ids,setIds]=useState(['a','b','c','d']);const ref=useRef(null);
 useConstrainedHorizontalReorder({ownerKey:'fixture-workflow',baseIds:ids,containerRef:ref,
   itemSelector:'[data-fixture-chip]',idAttribute:'data-fixture-chip',onCommit:next=>{window.rowCommits++;setIds(next)}});
 window.rowIds=ids;window.rowPriority=()=>historyForegroundPriority.interactionCount();window.rowCursor=getInteractionCursor;
 return <div ref={ref} id="workflow" style={{position:'relative',display:'flex',width:420,gap:6,userSelect:'none',touchAction:'none'}}>
 {ids.map(id=><div key={id} data-fixture-chip={id} onClick={()=>window.rowClicks++} style={{width:90,height:30,flexShrink:0,cursor:'pointer',background:'#464'}}>{id}</div>)}
 </div>
}
window.rowCommits=0;window.rowClicks=0;const rowRoot=createRoot(document.getElementById('row-root'));rowRoot.render(<Row/>);window.unmountRow=()=>rowRoot.unmount();
` }, bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'} });
await fs.writeFile(path.join(dir,'row.js'),rowSource.outputFiles[0].text);
await fs.writeFile(path.join(dir, 'main.cjs'), `
const {app, BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(dir, 'user-data'))});
app.setActivationPolicy?.('accessory');
app.disableHardwareAcceleration();
app.whenReady().then(()=>{
 app.dock?.hide();
 const win=new BrowserWindow({width:1000,height:700,show:false,
   webPreferences:{offscreen:true,backgroundThrottling:false}});
 global.fixture=win; global.cursorEvents=[];
 win.webContents.on('cursor-changed',(_e,type)=>global.cursorEvents.push(type));
 win.webContents.on('paint',()=>{});
 win.webContents.setFrameRate(60);
 win.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});
});
app.on('window-all-closed',()=>app.quit());
`);
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<style>
body{margin:0;background:#181818;color:#ddd;font:14px sans-serif}
#handle{position:absolute;left:100px;top:50px;width:20px;height:100px;background:#8b5cf6;cursor:col-resize;user-select:none;touch-action:none}
#outside{position:absolute;left:400px;top:50px;width:400px;height:130px;cursor:text;background:#224;user-select:text}
.pane{position:absolute;width:700px;height:500px;left:0;top:200px;opacity:0;pointer-events:none;overflow:hidden}
.row{display:flex;padding:3px;line-height:18px;color:#888}
.row span{cursor:text} .row button{cursor:pointer}
</style><div id="retained"></div><div id="handle"><span>↔</span></div>
<div id="outside" contenteditable>selectable outside text</div><div id="row-root" style="position:absolute;left:50px;top:230px"></div>
<script src="cursor.js"></script><script>
const retained=document.getElementById('retained');
retained.innerHTML=Array.from({length:100},(_,i)=>'<section class="pane">'+
 Array.from({length:125},(_,j)=>'<div class="row"><span>history '+i+' '+j+'</span><button>action</button><span>text</span></div>').join('')+'</section>').join('');
window.results=[]; window.mode='legacy'; window.gestures=[]; window.frames=0;
requestAnimationFrame(function tick(){window.frames++;requestAnimationFrame(tick)});
let release=null, active=null;
function legacy(cursor){const style=document.createElement('style');style.textContent=':root,:root *{cursor:'+cursor+'!important}';document.head.appendChild(style);return()=>style.remove()}
const handle=document.getElementById('handle');
handle.addEventListener('dblclick',e=>window.gestures.push({type:'dblclick',trusted:e.isTrusted}));
handle.addEventListener('pointerdown',e=>{
 e.preventDefault(); const t=performance.now();
 active={mode:window.mode,inputDelay:t-e.timeStamp,started:t,moves:0,firstMove:null};
 if(window.mode==='legacy'){release=legacy('col-resize');document.body.style.userSelect='none'}
 else if(window.mode==='capture'){handle.setPointerCapture(e.pointerId);release=()=>{if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId)}}
 else {release=cursorModule.acquireInteractionCursor('grabbing',{target:handle,pointerId:e.pointerId});
   window.overlap=()=>{const old=release;release=cursorModule.acquireInteractionCursor('row-resize',{target:handle,pointerId:e.pointerId});old();old();return cursorModule.getInteractionCursor()};}
 active.setup=performance.now()-t;
 requestAnimationFrame(()=>{const f1=performance.now()-t;requestAnimationFrame(()=>window.results.push({phase:'grab',mode:window.mode,f1,f2:performance.now()-t}))});
});
window.addEventListener('pointermove',e=>{
 if(!active)return;active.moves++;active.firstMove??=performance.now()-active.started;
 window.gestures.push({type:'move',target:e.target.id,trusted:e.isTrusted});
});
window.addEventListener('pointerup',e=>{
 if(!active)return; const t=performance.now(); const data=active;active=null;
 release?.();release=null;if(data.mode==='legacy')document.body.style.userSelect='';
 const styleStart=performance.now();getComputedStyle(document.querySelector('.row span')).cursor;
 const styleMs=performance.now()-styleStart;
 requestAnimationFrame(()=>requestAnimationFrame(()=>window.results.push({...data,phase:'release',styleMs,total:performance.now()-t})));
});
window.styleBench=async(mode)=>{
 const start=performance.now();let stop;
 if(mode==='legacy')stop=legacy('col-resize');
 else if(mode==='body'){document.body.style.userSelect='none';stop=()=>document.body.style.userSelect=''}
 else {handle.style.cursor='row-resize';stop=()=>handle.style.cursor='col-resize'}
 getComputedStyle(document.querySelector('.row span')).cursor;
 const addMs=performance.now()-start;const removing=performance.now();stop();
 getComputedStyle(document.querySelector('.row span')).cursor;
 return {mode,addMs,removeMs:performance.now()-removing};
};
</script><script src="row.js"></script>`);
let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow(); await page.waitForFunction(() => window.styleBench);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const rowLogs=[];page.on('console',message=>{if(message.text().startsWith('[HorizontalRowDnd:'))rowLogs.push(message.text())});
  const meta = await app.evaluate(() => ({ electron:process.versions.electron,chrome:process.versions.chrome,pid:process.pid }));
  const styles=[];for(let i=0;i<3;i++)for(const mode of ['legacy','body','local'])styles.push(await page.evaluate(m=>window.styleBench(m),mode));
  const cursor=[];
  for(const mode of ['legacy','capture',...(process.argv.includes('--source')?['source']:[])]) {
    await page.evaluate(m=>{window.mode=m;window.gestures=[];window.results=[]},mode);
    await app.evaluate(()=>{global.cursorEvents=[]});
    for(let i=0;i<3;i++) {
      await page.mouse.move(110,100);await page.mouse.down();
      await page.mouse.move(550,110,{steps:4});await page.mouse.up();
      await page.waitForFunction(n=>window.results.filter(r=>r.phase==='release').length>=n,i+1,{timeout:5000});
      await page.mouse.move(551,110);
    }
    cursor.push({mode,...await page.evaluate(()=>({results:window.results,gestures:window.gestures,frames:window.frames,visibility:document.visibilityState})),
      nativeTypes:await app.evaluate(()=>global.cursorEvents)});
  }
  let behaviour=null;
  let workflow=null;
  if(process.argv.includes('--source')) {
    await page.evaluate(()=>{window.mode='source';window.gestures=[];document.getElementById('handle').style.setProperty('cursor','col-resize','important')});
    await page.mouse.dblclick(105,58); // inner span, not only the outer empty hitbox
    behaviour=await page.evaluate(()=>({doubleClicks:window.gestures.filter(e=>e.type==='dblclick'),
      owner:cursorModule.getInteractionCursor(),bodyStyle:document.body.getAttribute('style'),
      selection:getSelection().toString(),handleStyle:document.getElementById('handle').getAttribute('style'),
      cursorPriority:document.getElementById('handle').style.getPropertyPriority('cursor')}));
    assert.equal(behaviour.doubleClicks.length,1,'capture must preserve divider double-click reset');
    assert.equal(behaviour.owner,'','released gesture leaves no cursor owner');
    assert.equal(behaviour.selection,'','gesture must not select editor text');
    assert.equal(behaviour.cursorPriority,'important','authored inline priority is restored exactly');
    const fixed=cursor.find(c=>c.mode==='source');
    assert.ok(fixed.gestures.every(e=>e.type!=='move'||(e.target==='handle'&&e.trusted)));
    assert.ok(fixed.nativeTypes.includes('grabbing'),'Electron resolves the held cursor on the capture target');
    assert.ok(fixed.nativeTypes.includes('text'),'cursor returns to the editor after release');
    const oldStyle=Math.min(...cursor.find(c=>c.mode==='legacy').results.filter(r=>r.phase==='release').map(r=>r.styleMs));
    assert.ok(fixed.results.filter(r=>r.phase==='release').every(r=>r.styleMs<oldStyle/3),'global style debt is removed');
    await page.mouse.move(110,100);await page.mouse.down();
    assert.equal(await page.evaluate(()=>window.overlap()),'row-resize','old cleanup cannot cancel newer capture');
    await page.mouse.move(555,110);await page.mouse.up();
    assert.equal(await page.evaluate(()=>cursorModule.getInteractionCursor()),'');
    await page.mouse.move(406,58);await page.mouse.down();await page.mouse.move(530,58,{steps:5});await page.mouse.up();
    behaviour.selectionAfterRelease=await page.evaluate(()=>getSelection().toString());
    assert.ok(behaviour.selectionAfterRelease.length>0,'ordinary text selection works after release');

    await page.waitForFunction(()=>window.rowIds?.length===4);
    await page.mouse.move(70,245);await page.mouse.down();await page.mouse.move(411,580,{steps:12});
    await page.waitForFunction(()=>document.querySelector('[data-horizontal-row-cursor-chip]'));
    await page.mouse.up();
    await page.waitForFunction(()=>window.rowCommits===1);
    assert.deepEqual(await page.evaluate(()=>window.rowIds),['b','c','d','a']);
    const before=await page.evaluate(()=>window.rowClicks);
    await page.mouse.click(65,245);
    assert.equal(await page.evaluate(()=>window.rowClicks),before+1,'first ordinary click after drag is preserved');
    await page.mouse.move(70,245);await page.mouse.down();await page.mouse.move(310,580,{steps:6});
    await page.keyboard.press('Escape');await page.mouse.up();
    workflow=await page.evaluate(()=>({ids:window.rowIds,commits:window.rowCommits,clicks:window.rowClicks,
      priority:window.rowPriority(),ghosts:document.querySelectorAll('[data-horizontal-row-cursor-chip]').length,
      dragging:document.querySelector('#workflow').hasAttribute('data-horizontal-row-dragging')}));
    assert.equal(workflow.commits,1,'Escape does not commit');assert.equal(workflow.priority,0);
    assert.equal(workflow.ghosts,0);assert.equal(workflow.dragging,false);
    assert.equal(await page.evaluate(()=>window.rowCursor()),'');
    for(const cancel of ['blur','unmount']) {
      await page.mouse.move(70,245);await page.mouse.down();await page.mouse.move(310,580,{steps:6});
      if(cancel==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
      else await page.evaluate(()=>window.unmountRow());
      await page.mouse.up();
      assert.equal(await page.evaluate(()=>window.rowCursor()),'',cancel+' releases the cursor');
      assert.equal(await page.evaluate(()=>window.rowPriority()),0,cancel+' releases background priority');
      assert.equal(await page.evaluate(()=>window.rowCommits),1,cancel+' never commits');
    }
    workflow.cancelChecked=['Escape','blur','unmount'];
  }
  const output={dir,meta,styles,cursor,behaviour,workflow,rowLogs,errors};
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(output,null,2));
  console.log(JSON.stringify({dir,meta,styles,cursor:cursor.map(c=>({mode:c.mode,nativeTypes:c.nativeTypes,
    results:c.results,visibility:c.visibility})),behaviour,workflow,rowLogs,errors}));
} finally {await app?.close(); console.log('ARTIFACTS '+dir);}
