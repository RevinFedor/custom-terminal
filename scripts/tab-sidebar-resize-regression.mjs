#!/usr/bin/env node
// Actual TabSidebar + shared resize/focus/anchor boundary, immutable fixture.
// Trusted CDP drag; no Noted app, user data, PTY, native focus or OS cursor.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-sidebar-freeze-'));
const mock = path.join(dir, 'stores.ts');
await fs.writeFile(mock, `
import {create} from ${JSON.stringify(path.join(root, 'node_modules/zustand/esm/index.mjs'))};
import {commitDisplayProfileChange} from ${JSON.stringify(path.join(root, 'src/renderer/utils/displayProfileCommit.mjs'))};
window.commits=[];
export const useUIStore=create((set,get)=>({tabSidebarWidth:200,activeDisplayKey:'A',activeArea:'workspace',
 setTabSidebarWidth:width=>commitDisplayProfileChange(()=>{window.commits.push({width,display:get().activeDisplayKey});set({tabSidebarWidth:width})}),
 setActiveArea:activeArea=>set({activeArea})}));
export const useWorkspaceStore=create(()=>({openProjects:new Map([['p',{activeTabId:'tab',projectPath:'/fixture'}]]),
 splitPanes:[{projectId:'p',tabId:'tab'}],splitFocusedIndex:0,focusedProjectId:'p',activeProjectId:'p',activeSpaceId:'one'}));
window.ui=useUIStore;window.workspace=useWorkspaceStore;
`);
const canonicalMock = await fs.realpath(mock);
const entry = `
import React,{useState,useLayoutEffect} from 'react';import{createRoot}from'react-dom/client';
import{PersistentTabSidebarStack}from'./src/renderer/components/Workspace/TabSidebar';
import{useUIStore}from${JSON.stringify(mock)};
import{getInteractionCursor}from'./src/renderer/utils/interactionCursor';
const maps=new Map();window.owner=getInteractionCursor;window.rectEvents=[];window.globalMutations=0;
new MutationObserver(m=>window.globalMutations+=m.length).observe(document.documentElement,{attributes:true,attributeFilter:['style','class']});
new MutationObserver(m=>window.globalMutations+=m.length).observe(document.body,{attributes:true,attributeFilter:['style','class']});
document.addEventListener('pointerdown',e=>window.lastPointerId=e.pointerId,true);
window.pointerTrace=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>window.pointerTrace.push({type,x:e.clientX,buttons:e.buttons}),true);
function Contents({single}){return Array.from({length:8},(_,i)=><section key={i}
 data-terminal-pane-wrapper={'tab'+i} data-pane-event-index={i<2?i:undefined}
 data-terminal-surface-presented={i<2?'1':'0'}
 style={{position:'absolute',top:0,bottom:0,left:single?0:(i%2?'50%':0),width:single?'100%':'50%',opacity:i<2?1:0,pointerEvents:i<2?'auto':'none'}}>
 <header style={{height:30}}>Window {i}</header><div data-terminal-pane-content style={{position:'absolute',left:2,right:2,top:30,bottom:0}}>
 <textarea defaultValue={'draft-'+i}/><div data-scroller style={{height:280,overflow:'auto',font:'14px monospace'}}>
 {Array.from({length:80},(_,j)=><p key={j}>Row {j}: exact retained text which wraps with the containing block. <b>Body {i}</b></p>)}
 </div></div></section>)}
function App(){const[mode,setMode]=useState('split'),[shown,setShown]=useState(true);const w=useUIStore(s=>s.tabSidebarWidth);
 window.setMode=setMode;window.showSidebar=setShown;
 useLayoutEffect(()=>{const nodes=[...document.querySelectorAll('[data-terminal-pane-content]')];
  const ro=new ResizeObserver(entries=>{for(const e of entries)window.rectEvents.push({owner:e.target.parentElement.getAttribute('data-terminal-pane-wrapper'),width:e.contentRect.width})});
  nodes.forEach(n=>ro.observe(n));window.nodes=nodes;return()=>ro.disconnect();},[mode]);
 return <><nav><div data-workspace-navigation-project-tools style={{width:w}}>Tools</div><span>Workflows</span></nav>
 <main>{shown&&<PersistentTabSidebarStack projectIds={['p']} presentedProjectId="p" processStatus={maps} busyTabs={maps} pasteBusyTabs={maps}/>}
 <div data-workspace-center style={{flex:1,minWidth:0,position:'relative'}}>
 {mode==='split'?<Contents single={false}/>:<div style={{height:'100%',display:'flex',flexDirection:'column',position:'relative'}}>
 <header style={{height:30,flexShrink:0}}>Single header</header><div data-single-center-resize-content style={{flex:1,position:'relative',minWidth:0}}><Contents single={true}/></div></div>}
 </div></main></>}
createRoot(document.getElementById('root')).render(<App/>);
window.measure=()=>({width:window.ui.getState().tabSidebarWidth,area:window.ui.getState().activeArea,
 stack:document.querySelector('[data-persistent-tab-sidebar-stack]')?.getBoundingClientRect().width,
 toolbar:document.querySelector('[data-workspace-navigation-project-tools]').getBoundingClientRect().width,
 boxes:window.nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})),
 frozen:document.querySelectorAll('[data-split-resize-content-frozen]').length,commits:window.commits.length,ro:window.rectEvents.length,
 cursor:window.owner(),globals:window.globalMutations});
`;
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife',
  outfile: path.join(dir, 'bundle.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-boundaries', setup(b) {
    b.onResolve({ filter: /\/store\/use(UI|Workspace)Store$/ }, () => ({ path: canonicalMock }));
    b.onResolve({ filter: /^\.\/TabBar$|^\.\/TabLocationLine$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root,
      contents: args.path.endsWith('TabBar') ? 'import React from "react";export default ()=> <div>Retained sidebar tabs</div>'
        : 'import React from "react";export const TabLocationLine=()=> <span>/fixture</span>' }));
  } }] });
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><style>
body{margin:0;background:#171717;color:#ccc}nav{height:30px;display:flex}nav>div{flex-shrink:0}
main{display:flex;height:650px;position:relative;overflow:hidden}[data-tab-sidebar]{position:relative;height:100%;display:flex;flex-direction:column}
textarea{height:50px;width:80%}p{margin:4px 0}header{background:#333}section{overflow:visible}
</style><div id="root"></div><script src="bundle.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const{app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();global.fixture=new BrowserWindow({show:false,focusable:false,width:1200,height:760,
webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});
global.fixture.webContents.on('paint',()=>{});global.fixture.loadFile(${JSON.stringify(path.join(dir, 'index.html'))})});
app.on('window-all-closed',()=>app.quit());`);
const result = { artifacts: dir, checks: [], errors: [] };let app;
try {
  const env = { ...process.env };delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow();page.setDefaultTimeout(10000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForFunction(() => window.nodes?.length === 8);
  const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r))));
  const measure = () => page.evaluate(() => window.measure());
  const grab = async () => {
    const r = await page.locator('[data-tab-sidebar-resize-handle]').boundingBox();
    const x=r.x+r.width/2,y=r.y+70;await page.mouse.move(x,y);await page.mouse.down();return{x,y};
  };
  for(const mode of ['split','single']) {
    await page.evaluate(mode=>{window.setMode(mode);window.rectEvents=[];},mode);await frames();
    await page.evaluate(()=>{document.querySelectorAll('[data-scroller]').forEach(n=>n.scrollTop=100);window.rectEvents=[];});
    const before=await measure();const p=await grab();await frames();await page.evaluate(()=>window.rectEvents=[]);
    await page.mouse.move(p.x+(mode==='split'?100:-70),p.y,{steps:8});await frames();
    const during=await measure();assert.deepEqual(during.boxes,before.boxes,'every retained heavy box stays fixed: '+mode);
    assert.equal(during.commits,before.commits);assert.equal(during.width,before.width);assert.equal(during.ro,0);
    assert.notEqual(during.stack,before.stack);assert.equal(during.toolbar,during.stack);assert.equal(during.area,'workspace');
    assert.equal(during.cursor,'col-resize');assert.ok(during.frozen>0);
    assert.ok(await page.evaluate(()=>window.nodes.every(n=>n.isConnected)&&[...document.querySelectorAll('[data-scroller]')].every(n=>n.scrollTop===100)));
    await page.mouse.up();await frames();const after=await measure();
    result.checks.push({mode,before,during,after,commits:await page.evaluate(()=>window.commits),trace:await page.evaluate(()=>window.pointerTrace)});
    assert.equal(after.commits,before.commits+1);assert.equal(after.width,during.stack);assert.equal(after.frozen,0);assert.equal(after.cursor,'');
    assert.notDeepEqual(after.boxes,before.boxes);assert.equal(after.ro,8,'each retained box resizes once on release');
    assert.deepEqual(await page.locator('textarea').evaluateAll(nodes=>nodes.map(n=>n.value)),Array.from({length:8},(_,i)=>'draft-'+i));
  }
  for(const reason of ['escape','blur','cancel','capture','workspace','display']) {
    const before=await measure(),p=await grab();await page.mouse.move(p.x+45,p.y,{steps:3});
    if(reason==='escape')await page.keyboard.press('Escape');
    else await page.evaluate(reason=>{
      if(reason==='blur')window.dispatchEvent(new Event('blur'));
      if(reason==='cancel')window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.lastPointerId}));
      if(reason==='capture')document.querySelector('textarea').setPointerCapture(window.lastPointerId);
      if(reason==='workspace')window.workspace.setState({activeSpaceId:'two'});
      if(reason==='display')window.ui.setState({activeDisplayKey:'B',tabSidebarWidth:275});
    },reason);
    if(reason==='capture')await page.mouse.move(p.x+46,p.y);
    await page.mouse.up();await frames();const after=await measure();
    assert.equal(after.commits,before.commits,reason+' must not save abandoned preview');assert.equal(after.frozen,0);assert.equal(after.cursor,'');
    assert.equal(after.stack,reason==='display'?275:before.width);
    result.checks.push({reason,passed:true});
  }
  for(const [x,width] of [[5,140],[900,400]]) {
    const before=await measure(),p=await grab();await page.mouse.move(x,p.y,{steps:3});await page.mouse.up();await frames();
    assert.equal((await measure()).width,width);assert.equal((await measure()).commits,before.commits+1);
  }
  result.checks.push({bounds:'140..400',passed:true});
  const p=await grab();await page.mouse.move(p.x-50,p.y);await page.evaluate(()=>window.showSidebar(false));await frames();
  assert.equal((await measure()).frozen,0);assert.equal((await measure()).cursor,'');await page.mouse.up();
  result.checks.push({unmount:true});
  assert.equal((await measure()).globals,0,'no global cursor/selection style writes');
  assert.deepEqual(result.errors,[]);assert.equal(await app.evaluate(()=>global.fixture.isFocused()),false);
  result.status='pass';
} catch(error) { result.status='fail';result.error=error.stack;process.exitCode=1; }
finally { await app?.close();await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result)); }
