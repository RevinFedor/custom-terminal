#!/usr/bin/env node
// Mounted actual PaneTabChip/TabCard/ConnectedWorkflowSidebar/shared hook.
// Workspace persistence and IPC are controlled; final full DEV is separate.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {build} from 'esbuild';import {_electron as electron} from 'playwright';
const repo=fileURLToPath(new URL('..',import.meta.url)),artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-navbar-control-'));
const result={artifact,pass:false,checks:[],measurements:[],errors:[],inputs:{}};let app,page;
const shim=`window.require=(id)=>id==='electron'?{ipcRenderer:{on(){},removeListener(){},send(){},sendSync(){return{};},invoke:async()=>({success:true,states:[],sessions:[],items:[],tabs:[]})},clipboard:{readText:()=>'',writeText(){}}}:id==='crypto'?{randomUUID:()=>crypto.randomUUID()}:{};`;
try {
 await build({entryPoints:[path.join(repo,'scripts/fixtures/navbar-sidebar-performance.tsx')],outfile:path.join(artifact,'bundle.js'),bundle:true,
  platform:'browser',format:'iife',jsx:'automatic',target:'chrome120',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},
  alias:{'@noted/structured-dnd':path.resolve(repo,'vendor/noted-shared/packages/structured-dnd/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
  plugins:[{name:'explicit-controls-and-counters',setup(b){
   b.onResolve({filter:/\/useWorkspaceStore$/},()=>({path:path.join(repo,'scripts/fixtures/workflow-reserve-dnd-store.ts')}));
   b.onResolve({filter:/\/(TabBar|WorkflowGroupMenu|tabLinkedFilePreview)$/},args=>({path:args.path.split('/').at(-1),namespace:'controlled'}));
   b.onLoad({filter:/.*/,namespace:'controlled'},args=>({loader:'tsx',contents:args.path==='TabBar'?`export const TAB_RENAME_REQUEST_EVENT='fixture-rename';export const openTabContextMenuAt=()=>{};`:
    args.path==='tabLinkedFilePreview'?`export const openTabLinkedFile=()=>{};export const openSidebarLinkedFile=()=>{};export const dismissTabLinkedFile=()=>{};export const closeTabLinkedFile=()=>{};`: `export default function(){return null;}`}));
   b.onLoad({filter:/(useOutlineDnd\.js|WorkflowTabSidebar\.tsx|TabCard\.tsx)$/},async args=>{
    let contents=await fs.readFile(args.path,'utf8');result.inputs[args.path]=createHash('sha256').update(contents).digest('hex');
    const add=(needle,injected)=>{assert.equal(contents.split(needle).length-1,1,needle);contents=contents.replace(needle,injected);};
    if(args.path.endsWith('useOutlineDnd.js')){
     if(contents.includes('pointerReadPhase) => {'))contents=contents.replace('    const previousOutline = previewOutlineRef.current;',`    const previousOutline = previewOutlineRef.current;
    if(window.__dndPerf?.active && pointerReadPhase){const c=dragRef.current,p=paintedPreviewRef.current;window.__dndPerf.gate={policy:configRef.current.pointerPublication,inside:pointerReadPhase.inside,pending:!!pendingLayoutFirstRef.current,immutable:immutableOutlineRef.current===resolvedOutline,paintEpoch:p?.ownerEpoch,currentEpoch:c?.ownerEpoch,epoch:ownerEpochRef.current,paintRevision:p?.revision,revision:revisionRef.current,renderRevision:c?.renderRevision,controlSame:c?.lastControlledOutline===controlledOutlineRef.current,outlineSame:p?.outline===resolvedOutline,mode:lastBoundaryMeasurementRef.current?.mode,different:['sourceContext','sourceIds','sourceRootIds','prepared','boundary','pointerBoundary','preferredDepth','resolvedDepth','currentParentId','navigationMode','hierarchyMode','layoutChangeAxis','scrollReserve','scrollCeiling','naturalScrollMax','lastAnchor'].filter(k=>c?.[k]!==nextDrag?.[k]||c?.[k]!==p?.drag?.[k]),current:{folder:c?.folderHoverTargetId,dwell:c?.navigationDwell,feedback:c?.feedback,blocked:c?.blockedDirection,edge:c?.edge,edgeGesture:c?.edgeGesture}};}`);
     add('  return {\n    previewOutline: view.previewOutline,\n    rows,',`  if(window.__dndPerf)window.__dndPerf.debug={capture(){const f=window.__dndPerf,d=dragRef.current;f.startSession=d?.sessionId;f.startOwner=d?.externalOwnerKey;f.startSource=d?.sourceId;f.startPointer=d?.pointerId;f.startContext=d?.sourceContext;f.startOutline=previewOutlineRef.current;f.startSlot=JSON.stringify(d?.slot);},read(){const f=window.__dndPerf,d=dragRef.current,p=paintedPreviewRef.current;return {phase:d?.phase,session:d?.sessionId,source:d?.sourceId,pointerId:d?.pointerId,owner:d?.externalOwnerKey,slot:d?.slot,point:d?{x:d.pointerX,y:d.pointerY}:null,painted:p?{session:p.sessionId,revision:p.revision,point:{x:p.drag.pointerX,y:p.drag.pointerY},slot:p.drag.slot}:null,sameSession:d?.sessionId===f.startSession,sameOwner:d?.externalOwnerKey===f.startOwner,sameSource:d?.sourceId===f.startSource,samePointer:d?.pointerId===f.startPointer,sameContext:d?.sourceContext===f.startContext,sameOutline:previewOutlineRef.current===f.startOutline,sameSlot:JSON.stringify(d?.slot)===f.startSlot};}};
  return {
    previewOutline: view.previewOutline,
    rows,`);
     add('    setView({','    if(window.__dndPerf?.active)window.__dndPerf.publishes++;\n    setView({');
     if(contents.includes('  const measureBoundary =')){
      add('  const measureBoundary = useCallback((drag, clientY) => {','  const measureBoundary = useCallback((drag, clientY) => {\n    if(window.__dndPerf?.active)window.__dndPerf.boundaries++;');
      add('      const rowRect = element ? snapRect(element, { compensateTransform: true }) : null;','      if(element&&window.__dndPerf?.active)window.__dndPerf.rowReads++;\n      const rowRect = element ? snapRect(element, { compensateTransform: true }) : null;');
     }else{
      add('  const calculateBoundary = useCallback((drag, clientY) => {','  const calculateBoundary = useCallback((drag, clientY) => {\n    if(window.__dndPerf?.active)window.__dndPerf.boundaries++;');
      add('      const rowRect = snapRect(element, { compensateTransform: true });','      if(window.__dndPerf?.active)window.__dndPerf.rowReads++;\n      const rowRect = snapRect(element, { compensateTransform: true });');
      add('        const rect = element ? snapRect(element,{compensateTransform:true}) : null;','        if(element&&window.__dndPerf?.active)window.__dndPerf.folderReads++;\n        const rect = element ? snapRect(element,{compensateTransform:true}) : null;');
     }
    }else if(args.path.endsWith('WorkflowTabSidebar.tsx')){
     if(process.argv.includes('--default-policy'))contents=contents.replace("pointerPublication:externalPointer?.source?.owner==='pane' && projectedOutline.current.immutable ? 'semantic':'frame',",'');
     add('export default function WorkflowTabSidebar(props: WorkflowTabSidebarProps) {','export default function WorkflowTabSidebar(props: WorkflowTabSidebarProps) {\n if(window.__dndPerf?.active)window.__dndPerf.hostRenders++;');
    }else contents=contents.replaceAll('  const [hovered, setHovered] = useState(false);','  if(window.__dndPerf?.active)window.__dndPerf.cardRenders++;\n  const [hovered, setHovered] = useState(false);');
    return{contents,loader:args.path.endsWith('.js')?'js':'tsx',resolveDir:path.dirname(args.path)};
   });
  }}]});
 await fs.writeFile(path.join(artifact,'index.html'),`<meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;background:#171717;color:#ccc;font:14px Arial}.workflow-tab-sidebar{height:480px!important}</style><script>${shim}</script><div id="root"></div><script src="bundle.js"></script>`);
 await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy('accessory');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:950,height:650,webPreferences:{offscreen:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});result.pid=app.process().pid;
 page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.setDefaultTimeout(6000);
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.locator('[data-split-pane-tab-chip]').waitFor();
 for(const count of [10,200]){
  await page.evaluate(n=>window.navbarFixture.reset(n),count);await frames();
  const chip=await page.locator('[data-split-pane-tab-chip]').boundingBox();assert.ok(chip);
  await page.mouse.move(chip.x+40,chip.y+12);await page.mouse.down();await page.mouse.move(chip.x+46,chip.y+12);await frames();
  await page.mouse.move(130,160,{steps:12});await frames();
  await page.waitForFunction(()=>document.querySelector('[data-outline-dnd-source="true"]'));
  await page.evaluate(()=>window.navbarFixture.begin());
  const transforms=new Set();
  for(let i=0;i<12;i++){await page.mouse.move(130+(i%2),160+(i%2));await frames();
    const oracle=await page.evaluate(()=>window.__dndPerf.debug.read());
    assert.equal(oracle.phase,'dragging');assert.equal(oracle.source,'reserve-tab:B');assert.ok(oracle.painted);
    for(const field of ['sameSession','sameOwner','sameSource','samePointer','sameContext','sameOutline','sameSlot'])assert.equal(oracle[field],true,field);
    transforms.add(await page.locator('[data-pane-tab-pointer-drag-preview]').evaluate(el=>el.style.transform));}
  assert.equal(transforms.size,2,'imperative clone advances while semantic slot is stable');
  const motion=await page.evaluate(()=>window.navbarFixture.end());
  assert.equal(motion.attempts.length,0);assert.equal(motion.commits.length,0);
  await page.evaluate(()=>window.navbarFixture.begin());
  await page.mouse.move(130,285,{steps:8});await frames();
  const crossing=await page.evaluate(()=>window.navbarFixture.end());assert.equal(crossing.oracle.sameSlot,false);
  await page.evaluate(()=>window.navbarFixture.begin());await page.evaluate(()=>window.navbarFixture.rename());await frames();
  const rename=await page.evaluate(()=>window.navbarFixture.end());
  assert.match(await page.locator('[data-workflow-reserve-tab="R0"]').innerText(),/LIVE R0/);
  result.measurements.push({count,motion,crossing,rename});
  await page.keyboard.press('Escape');await page.mouse.up();await frames();
  assert.equal(await page.locator('[data-pane-tab-pointer-drag-preview]').count(),0);
  result.checks.push(`${count} actual rows: mounted Navbar→sidebar adoption, same-slot movement counts, rename advances before cancellation`);
  await page.evaluate(n=>window.navbarFixture.reset(n),count);await frames();
  const fresh=await page.locator('[data-split-pane-tab-chip]').boundingBox();await page.mouse.move(fresh.x+40,fresh.y+12);await page.mouse.down();await page.mouse.move(fresh.x+46,fresh.y+12);await frames();
  await page.mouse.move(130,170,{steps:12});await frames();
  const painted=await page.evaluate(()=>window.__dndPerf.debug.read().painted);assert.ok(painted);
  await page.mouse.up();await page.waitForFunction(()=>window.fixture.commits.length===1);
  const written=await page.evaluate(()=>({attempts:window.fixture.attempts,commits:window.fixture.commits}));
  assert.equal(written.attempts.length,1);assert.equal(written.commits.length,1);
  assert.equal(written.commits[0].request.mutationId,'workflow-drag:'+written.commits[0].request.gestureId);
  assert.deepEqual(written.commits[0].request.sourceRootTabIds,['B']);
  result.checks.push(`${count} rows: successful painted Navbar drop has one actual controlled writer attempt/commit`);
 }
 const reset=async()=>{await page.evaluate(()=>window.navbarFixture.reset(10));await frames();};
 const start=async()=>{const b=await page.locator('[data-split-pane-tab-chip]').boundingBox();
  await page.mouse.move(b.x+40,b.y+12);await page.mouse.down();await page.mouse.move(b.x+46,b.y+12);};
 const endGate=async()=>{await page.evaluate(()=>window.navbarFixture.gateFrames(false));await frames();};
 // Controlled RAF delivery is a replacement scheduler, not native-input proof.
 await reset();await page.evaluate(()=>window.navbarFixture.gateFrames(true));await start();
 await page.mouse.move(130,160);await page.mouse.move(140,290);await endGate();
 let cold=await page.evaluate(()=>window.__dndPerf.debug.read());
 assert.deepEqual(cold.point,{x:140,y:290});
 await page.keyboard.press('Escape');await page.mouse.up();await frames();
 result.checks.push('cold adoption reads the current physical bridge input instead of its first entry packet');

 await reset();await page.evaluate(()=>window.navbarFixture.gateFrames(true));await start();
 await page.mouse.move(130,160);await page.mouse.up();await endGate();
 assert.equal(await page.locator('[data-outline-dnd-source="true"]').count(),0);
 assert.equal(await page.evaluate(()=>window.fixture.attempts.length),0);
 assert.equal(await page.locator('[data-pane-tab-pointer-drag-preview]').count(),0);
 result.checks.push('release before cold adoption leaves no late owner or writer');

 await reset();await start();await frames();await page.mouse.move(130,160);await frames();
 const acknowledged=await page.evaluate(()=>({paint:window.__dndPerf.debug.read().painted,
  order:[...document.querySelectorAll('[data-node-id]')].map(el=>el.getAttribute('data-node-id'))}));
 assert.ok(acknowledged.paint);
 await page.evaluate(()=>window.navbarFixture.gateFrames(true));
 await page.mouse.move(130,360);await page.mouse.up();await endGate();
 const queuedRelease=await page.evaluate(()=>({attempts:window.fixture.attempts,commits:window.fixture.commits}));
 assert.equal(queuedRelease.attempts.length,1);assert.equal(queuedRelease.commits.length,1);
 assert.deepEqual(queuedRelease.commits[0].painted,acknowledged.order);
 result.checks.push('release discards queued movement and commits exactly the prior acknowledged preview');

 for(const mutation of ['subject','hidden-placement','new-child']){
  await reset();await start();await frames();await page.mouse.move(130,160);await frames();
  await page.evaluate(kind=>{const s=window.fixture.store.getState();
    if(kind==='subject')window.fixture.store.setState({tabCatalog:{...s.tabCatalog,B:{...s.tabCatalog.B,
      executionSubject:{...s.tabCatalog.B.executionSubject,subjectId:'foreign'}}}});
    else if(kind==='hidden-placement')window.fixture.store.setState({spaces:s.spaces.map(w=>w.id!=='w2'?w:{...w,layout:{...w.layout,
      windowDisplayLayouts:{hidden:{splitPanes:[{windowId:'hidden',displayHidden:true,projectId:'P',tabId:'B',tabs:[{projectId:'P',tabId:'B'}]}]}}}})});
    else {const ws=s.openProjects.get('P'),tabs=new Map(ws.tabs);tabs.set('R0',{...tabs.get('R0'),visualParentTabId:'B'});
      window.fixture.store.setState({openProjects:new Map([['P',{...ws,tabs}]])});}
  },mutation);
  await page.mouse.up();await frames();assert.equal(await page.evaluate(()=>window.fixture.attempts.length),0);
  assert.equal(await page.locator('[data-pane-tab-pointer-drag-preview]').count(),0);
  result.checks.push('stationary '+mutation+' invalidates original admission without another movement');
 }
 await page.screenshot({path:path.join(artifact,'final.png')});assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.errors.push(error.stack||String(error));process.exitCode=1;if(page)await page.screenshot({path:path.join(artifact,'failure.png')});}
finally{if(app){await app.close();try{process.kill(result.pid,0);result.pidStopped=false;}catch(e){result.pidStopped=e.code==='ESRCH';}}
 await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({artifact,pass:result.pass,pid:result.pid,pidStopped:result.pidStopped,checks:result.checks,errors:result.errors,
  measurements:result.measurements.map(({count,motion,rename})=>({count,motion:Object.fromEntries(Object.entries(motion).filter(([key])=>!['frames','pointer'].includes(key))),rename:Object.fromEntries(Object.entries(rename).filter(([key])=>!['frames','pointer'].includes(key)))}))},null,2));}
