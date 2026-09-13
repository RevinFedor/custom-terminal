#!/usr/bin/env node
// Immutable, offscreen Electron fixture: actual outline + host cursor/resize
// hooks, trusted CDP input, no Noted storage/PTY or system cursor ownership.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-tab-cursor-'));
const outlineSource = path.resolve(root, '../noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js');
const bundle = await build({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
import React,{useRef,useState,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {useOutlineDnd} from ${JSON.stringify(outlineSource)};
import {useOutlineDragCursor} from './src/renderer/hooks/useOutlineDragCursor';
import {usePointerGesture} from './src/renderer/hooks/usePointerGesture';
import {getInteractionCursor} from './src/renderer/utils/interactionCursor';
const item=(id,children=[])=>({id,label:id,kind:'file',expanded:true,children});
window.commits=[];window.ends=[];window.clicks=0;window.doubleClicks=0;
window.state=null;window.owner=getInteractionCursor;
function Fixture(){
 const [outline,setOutline]=useState([item('a',[item('a1'),item('a2')]),item('b'),item('c'),item('d')]);
 const [width,setWidth]=useState(180);const [pane,setPane]=useState('empty');
 const [resizeVisible,setResizeVisible]=useState(true);window.hideResize=()=>setResizeVisible(false);
 const gesture=usePointerGesture();
 const dnd=useOutlineDnd({outline,outsidePointerPolicy:'horizontal-corridor',layoutAnimation:{duration:0},
   resolveExternalTarget:p=>p.metaKey && p.clientX>440?{key:'pane',zone:'body'}:null,
   onCommit:p=>{window.commits.push({kind:'outline',source:p.sourceId});setOutline(p.previewOutline);return true},
   onExternalCommit:p=>{window.commits.push({kind:'pane',source:p.sourceId});setPane(p.sourceId);return true},
   onLog:e=>{window.outlineLogs.push(e)} });
 useOutlineDragCursor(dnd.dragState,dnd.scrollerRef);
 useLayoutEffect(()=>{window.state=dnd.dragState;window.order=dnd.rows.map(r=>r.id);});
 window.stopResize=gesture.stop;
 return <>
 <div ref={dnd.scrollerRef} id="sidebar" style={{position:'absolute',left:20,top:20,width:310,height:350,overflow:'auto',userSelect:'none',touchAction:'none'}}>
 {dnd.rows.map(row=><div key={row.id} {...dnd.getRowProps(row)} data-row={row.id}
   onClick={()=>window.clicks++} style={{height:40,paddingLeft:row.depth*14,boxSizing:'border-box',border:'1px solid #575',cursor:'pointer',background:'#243e32'}}><span>{row.id}</span></div>)}
 <div {...dnd.scrollSpacerProps}/></div>
 <div id="pane" style={{position:'absolute',left:450,top:20,width:400,height:350,background:'#334',cursor:'text'}}>{pane}</div>
 {resizeVisible && <div id="resize" onDoubleClick={()=>window.doubleClicks++} style={{position:'absolute',left:20,top:410,width:20,height:60,cursor:'ew-resize',userSelect:'none',touchAction:'none',background:'#765'}}
  onPointerDown={e=>{window.resizePointerId=e.pointerId;let last=width;const x=e.clientX;const initial=width;
   gesture.start(e,{cursor:'ew-resize',onMove:m=>{last=initial+m.clientX-x;setWidth(last)},onEnd:r=>window.ends.push({reason:r,width:last})})}}><span>↔</span></div>}
 <div id="size" style={{position:'absolute',left:60,top:410,width,height:60,background:'#456'}}>{width}</div>
 <div id="editor" contentEditable suppressContentEditableWarning style={{position:'absolute',left:450,top:410,width:350,height:80,cursor:'text',userSelect:'text'}}>selectable editor text</div>
 </>
}
window.outlineLogs=[];
const host=createRoot(document.getElementById('root'));host.render(<React.StrictMode><Fixture/></React.StrictMode>);
window.unmountFixture=()=>host.unmount();
` }, bundle: true, write: false, format: 'iife',
  alias: { react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom') },
  define: { 'process.env.NODE_ENV': '"development"' },
});
await fs.writeFile(path.join(dir, 'fixture.js'), bundle.outputFiles[0].text);
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#181818;color:#eee;font:14px sans-serif}
.retained{position:absolute;left:0;top:700px;width:900px;height:400px;opacity:0;pointer-events:none;overflow:hidden}
.history-row{display:flex;padding:3px}.history-row span{cursor:text}.history-row button{cursor:pointer}
html[data-tabbar-drag-visual-lock="true"] [data-tab-item]{transition-property:transform,box-shadow,border-color!important}
</style><div id="retained"></div><div id="root"></div><script>
document.getElementById('retained').innerHTML=Array.from({length:100},()=>'<section class="retained">'+
 Array.from({length:125},()=>'<div class="history-row"><span>retained history</span><button>action</button><span>text</span></div>').join('')+'</section>').join('');
window.mutations=[];new MutationObserver(ms=>window.mutations.push(...ms.map(m=>({target:m.target.tagName,attribute:m.attributeName}))))
 .observe(document.documentElement,{attributes:true,subtree:false});
new MutationObserver(ms=>window.mutations.push(...ms.map(m=>({target:'BODY',attribute:m.attributeName}))))
 .observe(document.body,{attributes:true});
window.bench=mode=>{const t=performance.now();let release;
 if(mode==='old'){const s=document.createElement('style');s.textContent='html,html *,body,body *{cursor:grabbing!important}';document.head.appendChild(s);document.body.style.userSelect='none';release=()=>{s.remove();document.body.style.userSelect=''}}
 else{const row=document.querySelector('[data-row]');row.style.cursor='grabbing';document.documentElement.setAttribute('data-tabbar-drag-visual-lock','true');release=()=>{row.style.cursor='pointer';document.documentElement.removeAttribute('data-tabbar-drag-visual-lock')}}
 getComputedStyle(document.querySelector('.history-row span')).cursor;const add=performance.now()-t;const end=performance.now();release();
 getComputedStyle(document.querySelector('.history-row span')).cursor;return {mode,add,remove:performance.now()-end}};
</script><script src="fixture.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');app.disableHardwareAcceleration();
app.whenReady().then(()=>{app.dock?.hide();const win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});
 global.fixture=win;global.cursorTypes=[];win.webContents.on('cursor-changed',(_e,t)=>global.cursorTypes.push(t));
 win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);win.loadFile(${JSON.stringify(path.join(dir, 'index.html'))})});
app.on('window-all-closed',()=>app.quit());`);

let app;
const result = { dir, checks: [] };
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('[data-row="a"]');
  await page.screenshot({ path: path.join(dir, 'initial.png') });
  result.runtime = await app.evaluate(() => ({ electron:process.versions.electron, chromium:process.versions.chrome, pid:process.pid }));
  result.styles = [];
  for (let i=0;i<3;i++) for (const mode of ['old','local']) result.styles.push(await page.evaluate(m=>window.bench(m),mode));
  const old = Math.min(...result.styles.filter(x=>x.mode==='old').map(x=>x.remove));
  assert.ok(result.styles.filter(x=>x.mode==='local').every(x=>x.remove<old/3));
  await page.evaluate(()=>{window.mutations=[]});
  const cdp = await page.context().newCDPSession(page);
  const move = async (x,y,meta=false,down=true) => {
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:down?'left':'none',buttons:down?1:0,modifiers:meta?4:0});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  };
  const pickup = async (id='a') => {
    const box=await page.locator('[data-row="'+id+'"]').boundingBox();
    await page.mouse.move(box.x+100,box.y+20); await page.mouse.down();
    await move(box.x+106,box.y+27);
    await page.waitForFunction(()=>window.state?.phase==='dragging');
    assert.equal(await page.evaluate(()=>window.owner()),'grabbing');
  };
  await pickup();
  await page.keyboard.down('Meta'); await move(600,150,true);
  assert.equal(await page.evaluate(()=>window.state.externalTarget?.zone),'body');
  assert.equal(await page.evaluate(()=>window.owner()),'grabbing');
  await page.screenshot({path:path.join(dir,'cmd-pane.png')});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:600,y:150,button:'left',buttons:0,clickCount:1,modifiers:4});
  await page.keyboard.up('Meta');
  await page.waitForFunction(()=>document.getElementById('pane').textContent==='a');
  assert.deepEqual(await page.evaluate(()=>window.commits),[{kind:'pane',source:'a'}]);
  assert.equal(await page.evaluate(()=>window.owner()),'');
  result.checks.push('sidebar Cmd -> external pane commits once and releases cursor');

  await pickup('a'); await page.keyboard.down('Meta'); await move(600,150,true);
  await page.keyboard.up('Meta'); await move(126,290,false);
  await page.waitForFunction(()=>window.state?.navigationMode===false && window.order.at(-1)==='a2');
  await page.mouse.up(); await page.waitForFunction(()=>window.state===null);
  assert.deepEqual(await page.evaluate(()=>window.order),['b','c','d','a','a1','a2']);
  assert.equal(await page.evaluate(()=>window.commits.length),2);
  result.checks.push('Meta-up resumes the same outline drag, including complete subtree');

  await pickup(); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForFunction(()=>window.owner()==='');
  assert.equal(await page.evaluate(()=>window.commits.length),2);
  result.checks.push('Escape cancels without commit or cursor residue');

  await page.mouse.move(28,435);await page.mouse.down();await move(180,435);
  assert.equal(await page.evaluate(()=>window.owner()),'ew-resize');
  assert.equal(await page.locator('#size').textContent(),'332');
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.ends),[{reason:'up',width:332}]);
  await page.mouse.dblclick(25,417);
  assert.equal(await page.evaluate(()=>window.doubleClicks),1);
  result.checks.push('resize follows pointer outside handle, releases once and preserves child-span double click');

  await page.mouse.move(28,435);await page.mouse.down();await move(150,450);
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.ends.at(-1).reason),'escape');
  assert.equal(await page.evaluate(()=>window.owner()),'');
  result.checks.push('resize Escape cleans capture and listeners');

  await page.mouse.move(28,435);await page.mouse.down();await move(160,450);
  result.captureTransfer=await page.evaluate(()=>{
    const id=window.resizePointerId;const handle=document.getElementById('resize');const editor=document.getElementById('editor');
    const before=handle.hasPointerCapture(id);window.captureEvents=[];
    handle.addEventListener('lostpointercapture',e=>window.captureEvents.push({id:e.pointerId,type:e.type,trusted:e.isTrusted}));
    editor.setPointerCapture(id);return {id,before,after:editor.hasPointerCapture(id)};
  });
  await move(170,450);await page.mouse.up();
  result.captureEvents=await page.evaluate(()=>window.captureEvents);
  assert.equal(await page.evaluate(()=>window.ends.at(-1).reason),'lost-capture');
  assert.equal(await page.evaluate(()=>window.owner()),'');
  result.checks.push('capture transfer ends only the old resize owner');

  await page.locator('[data-row="c"]').click();
  assert.ok(await page.evaluate(()=>window.clicks>0));
  const textRect=await page.locator('#editor').evaluate(el=>{
    const range=document.createRange();range.selectNodeContents(el);const r=range.getBoundingClientRect();
    return {left:r.left,right:r.right,y:r.top+r.height/2};
  });
  await page.mouse.move(textRect.left+1,textRect.y);await page.mouse.down();
  await page.mouse.move(textRect.right-1,textRect.y,{steps:8});await page.mouse.up();
  assert.ok((await page.evaluate(()=>getSelection().toString())).length>0);
  result.checks.push('next click and editor text selection work after drag/resize');
  assert.deepEqual(await page.evaluate(()=>window.mutations),[],'no body/html gesture style mutations');

  await page.mouse.move(28,435);await page.mouse.down();await move(160,450);
  await page.evaluate(()=>window.hideResize());
  await page.waitForSelector('#resize',{state:'detached'});
  await move(170,450);await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.ends.at(-1).reason),'lost-capture');
  assert.equal(await page.evaluate(()=>window.owner()),'');
  result.checks.push('closing a retained popup releases its removed handle');

  await pickup(); await page.evaluate(()=>window.unmountFixture());await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.owner()),'');
  result.checks.push('outline unmount releases cursor owner');
  result.cursorTypes=await app.evaluate(()=>global.cursorTypes);
  assert.ok(result.cursorTypes.includes('grabbing'));
  assert.ok(result.cursorTypes.includes('text'));
  assert.deepEqual(errors,[]);result.errors=errors;result.pass=true;
} catch (error) {
  result.pass=false;result.failure=error.stack;
  if(app){const page=await app.firstWindow();result.state=await page.evaluate(()=>({state:window.state,order:window.order,commits:window.commits,ends:window.ends,owner:window.owner?.(),logs:window.outlineLogs?.slice(-12)})).catch(()=>null);}
  process.exitCode=1;
} finally {
  await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  await app?.close();
  console.log(JSON.stringify(result,null,2));
}
