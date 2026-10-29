// Exact readWindow/pump/owner code. Only page IO is substituted by finite
// scalar units; this does not claim native transport, payload memory or paint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryPrimaryRootReadModel} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
function rig(){
 const model=new HistoryPrimaryRootReadModel(()=>{throw Error('unexpected IPC');},{});
 model.windowDiagnostic=()=>{};
 model.view={header:{totalEntries:1000},unitAddresses:new WeakMap()};
 const reads=[];
 model.fillWindow=async(view,window,from,to,{signal,owns,addresses,publish})=>{
  for(let rank=from;rank<to;rank++){
   assert(!signal.aborted&&owns());
   if(window.has(rank))continue;
   const unit={kind:'entry',entry:{uuid:'u'+rank,content:'full '+rank}},address={index:rank};
   reads.push(rank);window.set(rank,unit);addresses.set(rank,address);view.unitAddresses.set(unit,address);publish();
  }
 };
 model.attachSurface({ownerKey:'own',generation:1,visit:1,presented:true});
 return {model,reads,visible:(a,b)=>model.readWindow(a,b,{ownerToken:model.surface,owns:()=>model.surface?.presented===true})};
}
test('nearby reverse scroll reuses loaded units and never reads speculative neighbors',async()=>{
 const x=rig();await x.visible(20,24);assert.deepEqual(x.reads,[20,21,22,23,24]);
 const original=x.model.window.get(20);await x.visible(21,25);assert.equal(x.model.window.get(20),original);
 assert.deepEqual(x.reads,[20,21,22,23,24,25]);await x.visible(20,24);assert.equal(x.reads.length,6);
 assert.deepEqual(x.model.requestedWindow,{start:20,end:24},'retention does not replace viewport coordinates');
 await x.model.close();assert.equal(x.model.window.size,0);assert.equal(x.model.addresses.size,0);
});
test('long traversal evicts distant bodies and addresses instead of retaining every visited page',async()=>{
 const x=rig();
 for(let start=0;start<200;start++){
  await x.visible(start,start+4);
  assert(x.model.window.size<=5+12);assert.equal(x.model.addresses.size,x.model.window.size);
  for(const rank of x.model.window.keys())assert(rank>=Math.max(0,start-6)&&rank<start+5+6);
 }
 assert.equal(x.model.window.has(0),false);const count=x.reads.filter(x=>x===0).length;
 await x.visible(0,4);assert.equal(x.reads.filter(x=>x===0).length,count+1,'evicted data is requested normally');
 assert(x.model.window.size<=17);await x.model.close();
});
test('nonvisual/manual reads keep their exact former retention and cannot expand another surface cache',async()=>{
 const x=rig();await x.visible(20,24);await x.model.readWindow(22,22);
 assert.deepEqual([...x.model.window.keys()],[22]);
 const old=x.model.surface;x.model.attachSurface({ownerKey:'own',generation:1,visit:2,presented:false});
 await x.model.readWindow(23,23,{ownerToken:old});
 assert.deepEqual([...x.model.window.keys()],[23]);
 await x.model.close();
});

