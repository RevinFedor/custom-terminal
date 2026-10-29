// Finite SOURCE checks: actual paged producer/model, private Node SQLite and
// in-process IPC. No Electron, application data, providers or native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
const require=createRequire(import.meta.url);
const {createPrimaryAddressFixture}=require('./test-support/history-primary-address-fixture.cjs');
const {createPrimaryHistoryPresentation}=require('../src/main/history-root-engine/main/history-primary-presentation');
const {materializeHistoryCursorSync:materialize}=require('../src/main/history-root-engine/main/history-paged-store');
globalThis.window={require};
globalThis.localStorage={getItem(){return null;},setItem(){},removeItem(){}};
assert(getHeapStatistics().heap_size_limit<=96*1024**2);
const row={uuid:'owned-row',role:'user',sessionId:'s',content:'FULL Ω\0\ud800😀',timestamp:'2026-10-28T00:00:00.000Z'};
const presentation=()=>({localEntries:[],liveEntries:[],liveToolResults:[],settingsPresentationKeys:[],
  grouping:{enabled:false,threshold:2,responseWork:true,expandedKeys:[]},captionSelections:[]});
const control={assertCurrent(){},async checkpoint(){await new Promise(resolve=>setImmediate(resolve));}};
const args=f=>({service:{},payload:{...f.payload,...presentation()},control});
function sequential(phases){
 assert(phases.length>3&&phases.length<=20);
 let last=-Infinity;
 for(const p of phases){assert(p.startAbs>=last-0.001);assert(p.endAbs>=p.startAbs);
  assert(p.elapsedMs>=0);last=p.endAbs;}
}
function capture(t){
 const original=console.log,records=[];
 console.log=(...args)=>{
  const line=args[0];
  if(typeof line==='string'&&line.startsWith('[HistoryPrimary] ')){
   const at=line.indexOf(' {');if(at>=0){try{records.push({event:line.slice(17,at),...JSON.parse(line.slice(at+1))});}catch{}}
  } else original(...args);
 };
 t.after(()=>{console.log=original;});
 return records;
}
test('actual producer attributes a known pause to its stage without changing full data or lease cleanup',async t=>{
 const f=await createPrimaryAddressFixture(t,{entries:[row]});let summary,ends=0;
 const result=await createPrimaryHistoryPresentation(f.store,f.source,{...args(f),diagnostics:{
  beginPhase(name){if(name==='primary-canonical-stubs')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,8);
   return()=>{ends++;};},complete(s){summary=s;}}});
 try{
  assert.equal(summary.outcome,'success');sequential(summary.phases);
  assert(summary.phases.find(p=>p.stage==='canonical-stubs').elapsedMs>=7);
  assert.equal(summary.phases.length,ends);
  assert(summary.processCpuUserMs>=0);assert(summary.processCpuSystemMs>=0);
  assert.equal(JSON.stringify(summary).includes(row.content),false);
  assert(Buffer.byteLength(JSON.stringify(summary))<6000);
  const prepared=materialize(result.sourceMetadataCursor);
  assert.equal(prepared.length,1);assert.equal(prepared[0].uuid,row.uuid);
  const units=materialize(result.view.root.cursor().field('units'));
  assert.equal(units.find(x=>x.kind==='entry').entry.content,row.content);
 }finally{result.close();}
 assert.equal(f.store.stats().activeBuilders,0);
});
test('throwing phase/end/summary observers cannot change successful producer values',async t=>{
 const f=await createPrimaryAddressFixture(t,{entries:[row]});let starts=0,completed=0;
 const result=await createPrimaryHistoryPresentation(f.store,f.source,{...args(f),diagnostics:{
  beginPhase(){if(++starts%2)throw Error('observer-start');return()=>{throw Error('observer-end');};},
  complete(){completed++;throw Error('observer-summary');}}});
 try{assert.equal(materialize(result.view.root.cursor().field('units'))[0].entry.content,row.content);
  assert(starts>3);assert.equal(completed,1);}finally{result.close();}
});
test('producer failure keeps exact error, identifies failed stage and completes cleanup despite observer failure',async t=>{
 const f=await createPrimaryAddressFixture(t,{entries:[row]});let stage,summary;
 const original=Object.assign(Error('owned injected control refusal'),{code:'OWN_DIAGNOSTIC_CONTROL'});
 const base=f.store.stats().leases;
 await assert.rejects(createPrimaryHistoryPresentation(f.store,f.source,{...args(f),
  control:{assertCurrent(){if(stage==='primary-indexes')throw original;},async checkpoint(){this.assertCurrent();}},
  diagnostics:{beginPhase(name){stage=name;return()=>{};},complete(s){summary=s;throw Error('observer-summary');}}}),
  error=>error===original);
 assert.equal(summary.failedStage,'indexes');assert.equal(summary.outcome,'error');
 assert.equal(summary.phases.at(-1).stage,'cleanup');sequential(summary.phases);
 assert.equal(f.store.stats().activeBuilders,0);assert.equal(f.store.stats().leases,base);
 assert.equal(materialize(f.source.entries)[0].content,row.content);
});
test('actual renderer model separates canonical/prepared/decode/settings/adoption and preserves selected body',async t=>{
 const records=capture(t),f=await createPrimaryAddressFixture(null,{entries:[row]});
 const model=new HistoryPrimaryRootReadModel(f.invoke,f.transport);
 t.after(async()=>{await model.close();f.close();});
 await model.open({...f.payload,primaryPresentation:presentation()});
 const summary=records.find(r=>r.event==='OPEN_PHASES');
 assert(summary);assert.equal(summary.outcome,'adopted');sequential(summary.phases);
 for(const phase of ['root-open','canonical-validation','prepared-validation','compatibility-decode','effective-settings','prompt-adoption','publication','provisional-cleanup'])
  assert(summary.phases.some(p=>p.stage===phase),phase);
 assert.equal(summary.leaseId,model.header.leaseId);
 await model.readWindow(0,0);
 assert.equal(model.window.get(0).entry.content,row.content);
});
test('renderer root rejection is reported and the same error escapes without another read',async t=>{
 const records=capture(t),original=Object.assign(Error('owned root refusal'),{code:'OWN_ROOT_REFUSAL'});
 let calls=0;
 const model=new HistoryPrimaryRootReadModel(async()=>{calls++;throw original;},{
  openHistoryRootThroughIpc:async invoke=>invoke('agent-transcript:get-history',{})});
 t.after(()=>model.close());
 await assert.rejects(model.open({toolType:'codex',sessionId:'s',cwd:'/finite',tabId:'t',
  primaryPresentation:presentation()}),error=>error===original);
 assert.equal(calls,1);
 const summary=records.find(r=>r.event==='OPEN_PHASES');
 assert(summary);assert.equal(summary.outcome,'error');assert.deepEqual(summary.phases.map(p=>p.stage),['root-open','provisional-cleanup']);
 assert.equal(model.header,null);
});

