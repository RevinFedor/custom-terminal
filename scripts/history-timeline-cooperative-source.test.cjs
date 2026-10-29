'use strict';
// Actual paged geometry on finite owned SQLite. Event-loop input substitutes
// an incoming page request; this is responsiveness evidence, not native UI.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {performance}=require('node:perf_hooks');
const Database=require('./test-support/history-node-sqlite.cjs');
const main='../src/main/history-root-engine/main/';
const {HistoryPagedStore}=require(main+'history-paged-store');
const {createTimelineRootLayout}=require(main+'timeline-root-layout');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('work budget yields on elapsed work or count, resets after await, and respects cancellation',async()=>{
 const {createReadWorkBudget,createReadControl}=require(main+'history-read-control');
 let time=0,yields=0;const events=[];
 const work=createReadWorkBudget({assertCurrent(){events.push('assert');},async checkpoint(){yields++;time+=100;}},
  {now:()=>time,maxUnits:3,maxSliceMs:8});
 await work();assert.equal(yields,0);time=8;await work();assert.equal(yields,1);
 await work();await work();assert.equal(yields,1);await work();assert.equal(yields,2);
 assert(events.length>=7);
 const ac=new AbortController();const c=createReadControl({signal:ac.signal,schedule:async()=>ac.abort()});
 const cancelled=createReadWorkBudget(c,{maxUnits:1});
 await assert.rejects(cancelled(),{code:'HISTORY_READ_CONSUMER_REVOKED'});c.finish();
 for(const options of [{maxUnits:0},{maxUnits:1.5},{maxSliceMs:0},{maxSliceMs:Infinity}])
  assert.throws(()=>createReadWorkBudget(null,options),/cooperative budget/);
});
test('a sub-32-row Timeline build serves pending event-loop work before completing',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noted-timeline-cooperative-'));
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database,diskBytes:28*1024**2,
  pageBytes:1024,indexBytes:128*1024,residentPages:128,sqlCacheKiB:1024});
 let source,layout;let served=false,checkpoints=0,completed=0;
 try{
  const atoms=Array.from({length:16},(_,i)=>({key:'finite:'+i,identity:'finite:'+i,
   baseExtent:24+i,flexWeight:i%2,estimated:true,intrinsic:false}));
  source=store.captureLegacy(atoms);
  const pending=turn().then(()=>{served=true;completed=checkpoints;});
  const start=performance.now();
  layout=await createTimelineRootLayout({store,atomsCursor:source.cursor(),layoutFingerprint:'finite',
   mode:'compact',viewportExtent:800,control:{assertCurrent(){},async checkpoint(){
    assert.equal(store.depth,0);assert.equal(store.db.inTransaction,false);checkpoints++;await turn();}}});
  const elapsedMs=performance.now()-start;
  const servedBeforeCompletion=served;await pending;
  console.log('[TimelineCooperativeControl] '+JSON.stringify({elapsedMs,checkpoints,servedBeforeCompletion,completed}));
  assert.equal(layout.info().count,16);assert.equal(layout.info().totalExtent,800);
  for(let i=0;i<16;i++){assert.equal(layout.rect(i).identity,'finite:'+i);assert.equal(layout.lookup('finite:'+i).ordinal,i);}
  assert.equal(servedBeforeCompletion,true,'pending read must not wait for the entire small Timeline build');
 }finally{layout?.release();source?.release();assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);store.close();fs.rmSync(dir,{recursive:true});}
});
