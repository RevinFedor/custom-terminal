#!/usr/bin/env node
// Real external-presentation layout effect + viewport gate callbacks from
// HistoryPanel, in React/Electron. No transcript/API/PTY or production window.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'noted-retained-paint-'));
const source=await fs.readFile(path.join(repo,'src/renderer/components/Workspace/HistoryPanel.tsx'),'utf8');
const start=source.indexOf('  useLayoutEffect(() => {\n    if (!presentationExternallyManaged || !presentationChannel)');
const end=source.indexOf('  // Cancels a warm-return verify pass',start);
assert.ok(start>=0&&end>start);
const effect=source.slice(start,end);
const gates=source.slice(source.indexOf('  const armHistoryViewportPaintProof = useCallback('),source.indexOf('  // Virtuoso now renders display UNITS.'));
assert.ok(gates.includes('resolveHistoryViewportPaintProof'));
await fs.writeFile(path.join(dir,'source-effect.ts'),effect);
const entry=`
import React,{useRef,useState,useMemo,useCallback,useLayoutEffect}from'react';
import{createRoot}from'react-dom/client';
import{createHistoryViewportPaintProbe}from'./src/renderer/utils/historyViewportPaintProbe';
import{advanceHistoryPresentationProof,createHistoryPresentationProof,historyPresentationOwnsWrite,resolveHistoryViewportPaintProof}from'./src/renderer/utils/historyPresentationOwnership.mjs';
import{recordHistorySurfacePresented}from'./src/renderer/utils/timelineTranscriptRefresh.mjs';
const HISTORY_SURFACE_PRESENTATION_EVENT='history-panel:external-presentation';
const historyOwnerDigest=x=>x;const historySnapshotCache={peek:()=>({})};const dropHistoryMeasuredLayout=()=>{};
window.diag=[];window.published=[];const historyDiag=x=>window.diag.push(x);
window.addEventListener('history-panel:surface-presented',e=>window.published.push(e.detail));
function Fixture(){
 const tabId='tab-fixture',sessionId='s',toolType='claude',agentSidePanel=false,mainSurface=true;
 const presentationExternallyManaged=true,presentationChannel='fixture';
 const historySnapshotOwner=useMemo(()=>({sessionId}),[]);
 const[owner,setOwner]=useState('owner-one'),[visible,setVisible]=useState(false),[kind,setKind]=useState('none');
 const historyOwnerDomId=owner;const historyOwnerKeyRef=useRef(owner);historyOwnerKeyRef.current=owner;
 const historyOwnerGenerationRef=useRef(1);const historyPresentationProofRef=useRef(createHistoryPresentationProof(false));
 const appliedHistoryPresentationRef=useRef({presented:false,visit:0});const panelRef=useRef(null);
 const initialLoadDoneRef=useRef(true),scrollRestoreGenRef=useRef(0),scrollSaveTimerRef=useRef(null);
 const isAtBottomRef=useRef(true);
 const historyTailPinScheduler=useMemo(()=>({cancel(){}}),[]);
 const historyPresentationHideCleanupRef=useRef(()=>{}),terminalPreviewPresentationWakeRef=useRef(()=>{});
 const globalHotkeysSuppressedRef=useRef(false),displayEntriesRef=useRef([{}]);
 const historyResizeRef=useRef({active:()=>false,cancel(){},claimRemount:()=>true});
 const viewportPaintProbeRef=useRef(createHistoryViewportPaintProbe()),surfacePresentedProbeRef=useRef(createHistoryViewportPaintProbe());
 const viewportReadyOwnerKeyRef=useRef(owner),surfacePresentedOwnerRef=useRef('');
 const[viewportReadyOwnerKey,setViewportReadyOwnerKey]=useState(owner);
 const[,setViewportProofRequired]=useState(false);const[,setPresentationRestoreTick]=useState(0);
 const visibleSurfaceLoading=viewportReadyOwnerKey!==owner;
 const visibleSurfaceLoadingRef=useRef(visibleSurfaceLoading);visibleSurfaceLoadingRef.current=visibleSurfaceLoading;
 ${gates}
 ${effect}
 useLayoutEffect(()=>{window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT,{detail:{channel:presentationChannel,presented:visible,geometryStable:true,focused:true}}));},[visible]);
 window.fixture={setKind,setVisible,changeOwner:()=>{historyOwnerGenerationRef.current++;setOwner('owner-two');},
 resize:value=>{historyResizeRef.current.active=()=>value},proof:()=>({...historyPresentationProofRef.current,ready:viewportReadyOwnerKeyRef.current})};
 return <><button id="show" onClick={()=>setVisible(true)}>Show</button><button id="hide" onClick={()=>setVisible(false)}>Hide</button>
 <section ref={panelRef} data-panel style={{position:'relative',marginTop:20,opacity:visible?1:0,height:300}}>
 {visibleSurfaceLoading&&<div data-loader>Loading</div>}
 {(kind==='real'||kind==='mixed')&&<div data-history-row-real data-history-row-owner={owner} style={{height:90}}>Existing retained row</div>}
 {kind==='foreign'&&<div data-history-row-real data-history-row-owner="foreign" style={{height:90}}>Foreign row</div>}
 {kind==='shell'&&<div data-history-row-owner={owner} style={{height:90}}>Mount shell</div>}
 {kind==='zero'&&<div data-history-row-real data-history-row-owner={owner} style={{height:0}}/>}
 {(kind==='empty'||kind==='mixed')&&<div data-history-empty-state style={{height:90}}>No history</div>}
 </section></>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({stdin:{contents:entry,resolveDir:repo,loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'bundle.js'),
 define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
await fs.writeFile(path.join(dir,'index.html'),'<div id="root"></div><script src="bundle.js"></script>');
await fs.writeFile(path.join(dir,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();global.fixture=new BrowserWindow({show:false,focusable:false,width:1000,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});global.fixture.webContents.on('paint',()=>{});global.fixture.loadFile(${JSON.stringify(path.join(dir,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
const expectStuck=process.env.NOTED_PROOF_EXPECT_STUCK==='1';
const result={artifacts:dir,expectStuck,sourceHash:createHash('sha256').update(source).digest('hex'),checks:[],errors:[]};let app;
try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[path.join(dir,'main.cjs')],cwd:dir,env});const page=await app.firstWindow();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>result.errors.push(e.message));await page.waitForFunction(()=>!!window.fixture);
 const frames=async(n=5)=>page.evaluate(n=>new Promise(resolve=>{const step=()=>--n<=0?resolve():requestAnimationFrame(step);requestAnimationFrame(step)}),n);
 const reload=async()=>{await page.reload();await page.waitForFunction(()=>!!window.fixture)};
 await page.locator('#show').click();await frames();assert.equal(await page.locator('[data-loader]').count(),1);
 await page.evaluate(()=>window.fixture.setKind('real'));await frames(12);
 const first=await page.evaluate(()=>({loader:!!document.querySelector('[data-loader]'),proof:window.fixture.proof(),diag:window.diag,published:window.published.length}));
 assert.equal(first.loader,expectStuck,'first show must finish without another rangeChanged or navigation');
 result.checks.push({firstDelayedRow:first});
 await page.locator('#hide').click();await page.locator('#show').click();await frames();
 assert.equal(await page.locator('[data-loader]').count(),0);result.checks.push({secondShowClears:true});
 if(!expectStuck){
  for(const kind of ['shell','foreign','zero']){
   await reload();await page.locator('#show').click();await page.evaluate(k=>window.fixture.setKind(k),kind);await frames();
   assert.equal(await page.locator('[data-loader]').count(),1);assert.equal(await page.evaluate(()=>window.published.length),0);
   await page.evaluate(()=>window.fixture.setKind('real'));await frames();assert.equal(await page.locator('[data-loader]').count(),0);
   result.checks.push({rejected:kind});
  }
  await reload();await page.locator('#show').click();await page.locator('#hide').click();
  await page.evaluate(()=>window.fixture.setKind('real'));await frames();assert.equal(await page.evaluate(()=>window.published.length),0);
  await page.locator('#show').click();await frames();assert.equal(await page.locator('[data-loader]').count(),0);result.checks.push({hiddenVisitCancelled:true});
  await reload();await page.locator('#show').click();await page.evaluate(()=>window.fixture.changeOwner());await page.evaluate(()=>window.fixture.setKind('foreign'));await frames();
  assert.equal(await page.evaluate(()=>window.published.length),0);await page.locator('#hide').click();await page.locator('#show').click();await page.evaluate(()=>window.fixture.setKind('real'));await frames();
  assert.equal(await page.locator('[data-loader]').count(),0);assert.ok(await page.evaluate(()=>window.published.every(p=>p.owner==='owner-two')));result.checks.push({ownerChangeGuard:true});
  await reload();await page.evaluate(()=>window.fixture.resize(true));await page.locator('#show').click();await page.evaluate(()=>window.fixture.setKind('real'));await frames();
  assert.equal(await page.locator('[data-loader]').count(),1);await page.evaluate(()=>window.fixture.resize(false));await frames();
  assert.equal(await page.locator('[data-loader]').count(),0);result.checks.push({resizeGuard:true});
  await reload();await page.locator('#show').click();await page.evaluate(()=>window.fixture.setKind('empty'));await frames();
  assert.equal(await page.locator('[data-loader]').count(),0);assert.equal(await page.evaluate(()=>window.published[0].proof),'painted-empty-state');result.checks.push({emptyProof:true});
  await reload();await page.evaluate(()=>window.fixture.setKind('zero'));await frames();await page.locator('#show').click();await frames(12);
  assert.equal(await page.locator('[data-loader]').count(),1);
  assert.equal(await page.evaluate(()=>window.diag.filter(s=>s.startsWith('PRESENTATION_UNPAINTED_REARM')).length),1);
  await page.evaluate(()=>window.fixture.setKind('real'));await frames();assert.equal(await page.locator('[data-loader]').count(),0);result.checks.push({postPaintRearmOnce:true});
  await reload();await page.locator('#show').click();await page.evaluate(()=>window.fixture.setKind('mixed'));await frames();
  assert.equal(await page.locator('[data-loader]').count(),0);assert.equal(await page.evaluate(()=>window.published[0].proof),'mounted-painted-row');result.checks.push({realRowWinsOverOldEmptyNode:true});
  await reload();await page.locator('#show').click();await page.evaluate(()=>window.fixture.setKind('real'));
  await page.evaluate(()=>new Promise(resolve=>{let left=12;const tick=()=>{window.dispatchEvent(new CustomEvent('history-panel:external-presentation',{detail:{channel:'fixture',presented:true,geometryStable:true}}));if(--left)requestAnimationFrame(tick);else resolve()};requestAnimationFrame(tick)}));
  assert.equal(await page.locator('[data-loader]').count(),0);assert.equal(await page.evaluate(()=>window.published.length),1);result.checks.push({sameVisitNotificationsCoalesced:true});
 }
 assert.deepEqual(result.errors,[]);assert.equal(await app.evaluate(()=>global.fixture.isFocused()),false);result.status='pass';
}catch(e){result.status='fail';result.error=e.stack;process.exitCode=1;}
finally{await app?.close();await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
