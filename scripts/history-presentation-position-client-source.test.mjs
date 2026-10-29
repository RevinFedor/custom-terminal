// Finite Source control: actual paged store/plane/shared client and renderer
// read transport. Synthetic boundary: an in-process channel router, bounded
// imported rows, delayed receipts and an unavailable canonical producer. This
// does not execute Electron/worker scheduling or claim native memory/latency.
// node --max-old-space-size=64 --max-semi-space-size=8 scripts/history-presentation-position-client-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { openHistoryPresentationPosition } from '../src/shared/history-root-read-client.mjs';
import { readHistoryThroughIpc } from '../src/renderer/utils/historyReadTransport.mjs';
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery } from '../src/renderer/utils/historyPresentationPosition.mjs';
const require = createRequire(import.meta.url);
const { HistoryPagedStore } = require('../src/main/history-root-engine/main/history-paged-store');
const { HistoryRootReadPlane } = require('../src/main/history-root-engine/main/history-root-read-plane');
const Database = require('./test-support/history-node-sqlite.cjs');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite V8 TOTAL <=128MiB; use documented command');
const PROFILE='history-presentation-position-v1', ENCODING='history-presentation-position-query-v2';
const OPEN='agent-transcript:get-history',PAGE='agent-transcript:read-page';
const FORK='agent-transcript:fork-read-leaf', RELEASE='agent-transcript:release-read-root';
const CANCEL='agent-transcript:cancel-read';
const fail=code=>Object.assign(new Error(code),{code});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const control={assertCurrent(){},async checkpoint(){await tick();}};
const identity=value=>Object.fromEntries(['leaseId','ownerKey','revision','generation'].map(key=>[key,value[key]]));
function fixture(t,{maxRoots=64}={}){
  const store=new HistoryPagedStore({Database,pageBytes:256,indexBytes:512,residentPages:3,diskBytes:12*1024**2});
  let sourceCalls=0;
  const plane=new HistoryRootReadPlane({store,maxRoots,projectHistory:async()=>{sourceCalls++;throw fail('CANONICAL_SOURCE_UNAVAILABLE');}});
  const consumerKey='finite-position-client',calls=[];
  const f={store,plane,calls,consumerKey,hook:null,sourceCalls:()=>sourceCalls};
  const route=(channel,payload)=>{
    const options={consumerKey,control};
    if(channel===OPEN)return plane.openPosition(payload,options);
    if(channel===PAGE)return plane.readPage(payload,options);
    if(channel===FORK)return plane.forkPositionQuery(payload,options);
    if(channel===RELEASE)return plane.release(payload,options);
    if(channel===CANCEL)return {success:true,cancelled:true};
    throw fail('UNEXPECTED_SYNTHETIC_CHANNEL');
  };
  f.invoke=(channel,payload)=>{calls.push({channel,payload});return f.hook?f.hook(channel,payload,route):route(channel,payload);};
  f.open=(records,options={})=>openHistoryPresentationPosition(f.invoke,{projectionId:'finite-client',unitCount:records.length,records,...options});
  t.after(()=>{plane.close();plane.owner.close();assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n,0);store.close();});
  return f;
}
const entry=(uuid,index)=>({uuid,index,memberIndex:-1,memberCount:1});
const releases=(f,cap)=>f.calls.filter(call=>call.channel===RELEASE&&call.payload.leaseId===cap.leaseId).length;

test('actual plane/client preserves full typed position with bounded packets and no canonical source',async t=>{
  const f=fixture(t),long='hidden \0\ud800😀 '+'ж\udc00'.repeat(2100);
  const rows=[entry('current-local',0),{uuid:'first',index:1,memberIndex:0,memberCount:3},
    {uuid:long,index:1,memberIndex:1,memberCount:3},{uuid:long,index:1,memberIndex:2,memberCount:3},
    entry(1,2),entry('1',3),entry(true,4),entry('true',5),entry(1n,6),entry('last',7),entry('last',8)];
  const client=await f.open(rows,{unitCount:9,readThroughIpc:readHistoryThroughIpc});
  assert.equal(long.length,4212);
  assert.deepEqual(await client.resolve(long),{kind:'found',index:1,memberIndex:1});
  assert.deepEqual(await client.resolve('current-local'),{kind:'found',index:0,memberIndex:-1});
  assert.deepEqual(await client.resolve('last'),{kind:'found',index:8,memberIndex:-1});
  for(const [key,index]of [[1,2],['1',3],[true,4],['true',5],[1n,6]])assert.deepEqual(await client.resolve(key),{kind:'found',index,memberIndex:-1});
  assert.deepEqual(await client.resolve('canonical-only'),{kind:'missing'});
  assert.equal(f.sourceCalls(),0);assert.equal(client.stats().nativeCoordinateEntries,0);
  assert.equal(client.stats().recordVisits,rows.length);assert(client.stats().maxBufferedEvents<=3);
  for(const call of f.calls.filter(call=>[OPEN,PAGE,FORK].includes(call.channel))){
    assert.match(call.payload.readDemandId,/^hr-/);assert.equal(call.payload.diagnosticReadId,call.payload.readDemandId);
    assert(Buffer.byteLength(JSON.stringify(call.payload))<=64*1024);
    if(call.payload.events){assert(call.payload.events.length<=3);for(const event of call.payload.events)assert(event.text.length<=128);}
  }
  assert(f.plane.stats().maxPacketBytes<=16*1024);assert.equal(f.plane.stats().roots,1);
  await client.close();await client.close();assert.equal(releases(f,client.identity),1);
});

test('plane query holds its own pin after coordinate parent is released',async t=>{
  const f=fixture(t),client=await f.open([entry('retained',0)]),parent=client.identity;
  const child=await f.invoke(FORK,{...parent,encoding:ENCODING,projectionId:'finite-client'});
  assert.notEqual(child.leaseId,parent.leaseId);await client.close();
  const packet=await f.invoke(PAGE,{...identity(child),kind:PROFILE,projectionId:'finite-client',operation:'target',sequence:0,pass:0,
    events:[{type:'string',text:'retained',offset:0,done:true}],creditBytes:16384});
  assert.equal(packet.phase,'replay');assert.equal(packet.pass,1);
  const result=await f.invoke(PAGE,{...identity(child),kind:PROFILE,projectionId:'finite-client',operation:'target',sequence:1,pass:1,
    events:[{type:'string',text:'retained',offset:0,done:true}],creditBytes:16384});
  assert.deepEqual(result.result,{kind:'found',index:0,memberIndex:-1});
  await f.invoke(RELEASE,identity(child));assert.equal(f.plane.stats().roots,0);
});

test('existing renderer demand cancellation releases a late open ACK exactly once',async t=>{
  const f=fixture(t),abort=new AbortController();let ack,deliver;
  f.hook=(channel,payload,route)=>{if(channel===OPEN){ack=route(channel,payload);return new Promise(resolve=>{deliver=resolve;});}return route(channel,payload);};
  const opened=f.open([entry('x',0)],{signal:abort.signal,readThroughIpc:readHistoryThroughIpc});
  assert(ack);abort.abort();await assert.rejects(opened,{code:'HISTORY_READ_CANCELLED'});
  assert.equal(f.calls.filter(call=>call.channel===CANCEL).length,1);
  const request=f.calls.find(call=>call.channel===OPEN).payload;
  assert.equal(f.calls.find(call=>call.channel===CANCEL).payload.readDemandId,request.readDemandId);
  deliver(ack);await tick();assert.equal(releases(f,ack),1);assert.equal(f.plane.stats().roots,0);
});

test('cancelled late query fork cleans only its child and leaves parent independently usable',async t=>{
  const f=fixture(t),client=await f.open([entry('kept',0)],{readThroughIpc:readHistoryThroughIpc});
  const abort=new AbortController();let ack,deliver;
  f.hook=(channel,payload,route)=>{if(channel===FORK){ack=route(channel,payload);return new Promise(resolve=>{deliver=resolve;});}return route(channel,payload);};
  const query=client.resolve('kept',{signal:abort.signal});assert(ack);abort.abort();
  await assert.rejects(query,{code:'HISTORY_READ_CANCELLED'});deliver(ack);await tick();
  assert.equal(releases(f,ack),1);assert.equal(releases(f,client.identity),0);assert.equal(f.plane.stats().roots,1);
  f.hook=null;assert.deepEqual(await client.resolve('kept'),{kind:'found',index:0,memberIndex:-1});await client.close();
});

test('owner replacement after response is discarded without recapture or parent release',async t=>{
  const f=fixture(t),client=await f.open([entry('old-frame',0)]);let owns=true,targets=0;
  f.hook=async(channel,payload,route)=>{const result=await route(channel,payload);if(channel===PAGE&&payload.operation==='target'){targets++;owns=false;}return result;};
  await assert.rejects(client.resolve('old-frame',{owns:()=>owns}),{code:'HISTORY_READ_CANCELLED'});
  assert.equal(targets,1);assert.equal(releases(f,client.identity),0);assert.equal(f.plane.stats().roots,1);
  f.hook=null;assert.deepEqual(await client.resolve('old-frame'),{kind:'found',index:0,memberIndex:-1});await client.close();
});

test('UNKNOWN registration and point reads do not retry, invent missing, or close another cap',async t=>{
  const f=fixture(t);let appends=0;
  f.hook=async(channel,payload,route)=>{const result=await route(channel,payload);if(channel===PAGE&&payload.operation==='append'){appends++;throw fail('HISTORY_READER_TRANSPORT_UNKNOWN');}return result;};
  await assert.rejects(f.open([entry('unknown',0)]),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  assert.equal(appends,1);assert.equal(f.plane.stats().roots,0);
  f.hook=null;const client=await f.open([entry('kept',0)]);let targets=0;
  f.hook=async(channel,payload,route)=>{const result=await route(channel,payload);if(channel===PAGE&&payload.operation==='target'){targets++;throw fail('HISTORY_READER_TRANSPORT_UNKNOWN');}return result;};
  await assert.rejects(client.resolve('kept'),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  assert.equal(targets,1);assert.equal(releases(f,client.identity),0);assert.equal(f.plane.stats().roots,1);
  f.hook=null;await client.close();
});

test('malformed fork identity cannot release parent; corrupt credit cannot become success',async t=>{
  const f=fixture(t),client=await f.open([entry('kept',0)]);
  f.hook=(channel,payload,route)=>channel===FORK?{success:true,__notedHistoryTransport:'root-v1',...client.identity,
    readProfile:PROFILE,projectionId:'finite-client',unitCount:1,phase:'querying',sequence:0}:route(channel,payload);
  await assert.rejects(client.resolve('kept'),{code:'HISTORY_POSITION_HEADER'});
  assert.equal(releases(f,client.identity),0);assert.equal(f.plane.stats().roots,1);
  f.hook=async(channel,payload,route)=>{const result=await route(channel,payload);if(channel===PAGE&&payload.operation==='target')result.creditBytesUsed++;return result;};
  await assert.rejects(client.resolve('kept'),{code:'HISTORY_POSITION_PAGE'});
  assert.equal(releases(f,client.identity),0);assert.equal(f.plane.stats().roots,1);f.hook=null;await client.close();
});

test('capacity/type/consumer/byte-credit refusals preserve a held position lease',async t=>{
  const f=fixture(t,{maxRoots:1}),client=await f.open([entry('kept',0)]);
  const before=f.calls.length;await assert.rejects(client.resolve({}),{code:'HISTORY_POSITION_QUERY_TYPE'});assert.equal(f.calls.length,before);
  await assert.rejects(client.resolve('kept'),{code:'HISTORY_ROOT_LEASE_LIMIT'});assert.equal(releases(f,client.identity),0);
  assert.throws(()=>f.plane.state(client.identity,'other-consumer'),{code:'HISTORY_ROOT_OWNER_MISMATCH'});
  await assert.rejects(f.plane.readPage({...client.identity,kind:PROFILE,projectionId:'finite-client',operation:'seal',sequence:1,creditBytes:65537},
    {consumerKey:f.consumerKey,control}),{code:'HISTORY_ROOT_CREDIT'});
  assert.equal(f.plane.stats().roots,1);await client.close();
});

// New r3 controls. Input 24 is only a supplied SQLite-path adapter, not an
// executable lifecycle counter body; these are equivalent new API regressions.
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function finiteSettle(promise){
  let state='pending',value;
  promise.then(result=>{state='fulfilled';value=result;},error=>{state='rejected';value=error;});
  for(let i=0;i<20&&state==='pending';i++)await tick();
  assert.notEqual(state,'pending','consumer must settle within the finite event-loop fixture, without cleanup ACK');
  if(state==='rejected')throw value;return value;
}

test('r3 checked point settles independently of held raw cleanup ACK; four exact slots stay bounded',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0),entry('B',1)]),held=[];
  f.hook=(channel,payload,route)=>{
    if(channel===RELEASE&&payload.leaseId!==client.identity.leaseId){
      const ack=route(channel,payload),gate=deferred();held.push({ack,gate,cap:payload});return gate.promise;
    }
    return route(channel,payload);
  };
  const owners=Array.from({length:4},()=>({})),abort=new AbortController();
  const first=await finiteSettle(client.resolve('A',{queryOwner:owners[0],signal:abort.signal}));
  assert.deepEqual(first,{kind:'found',index:0,memberIndex:-1});
  assert.equal(f.plane.stats().roots,1,'real server released the child before its raw ACK');
  assert.equal(client.stats().cleanupSlots,1);abort.abort();
  assert.deepEqual(first,{kind:'found',index:0,memberIndex:-1},'later abort does not retroactively cancel settled data');
  const forks=f.calls.filter(call=>call.channel===FORK).length;
  await assert.rejects(finiteSettle(client.resolve('B',{queryOwner:owners[0]})),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  assert.equal(f.calls.filter(call=>call.channel===FORK).length,forks,'same uncertain slot cannot fork again');
  for(let i=1;i<4;i++)assert.deepEqual(await finiteSettle(client.resolve('B',{queryOwner:owners[i]})),{kind:'found',index:1,memberIndex:-1});
  assert.equal(client.stats().cleanupSlots,4);
  await assert.rejects(finiteSettle(client.resolve('B')),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  assert.equal(held.length,4);held[0].gate.resolve(held[0].ack);await tick();
  assert.equal(client.stats().cleanupSlots,3);
  assert.deepEqual(await finiteSettle(client.resolve('B',{queryOwner:owners[0]})),{kind:'found',index:1,memberIndex:-1});
  assert.equal(held.length,5);assert.equal(client.stats().cleanupSlots,4);
  for(const item of held)item.gate.resolve(item.ack);await tick();
  assert.equal(client.stats().cleanupSlots,0);
  for(const item of held)assert.equal(releases(f,item.cap),1);
  await client.close();await client.retirement().promise;
});

test('r3 cancellation before a late fork settles consumer and keeps only that original cleanup slot',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0)]),owner={},abort=new AbortController(),gate=deferred();let ack;
  f.hook=(channel,payload,route)=>{
    if(channel===FORK&&!ack){ack=route(channel,payload);return gate.promise;}
    return route(channel,payload);
  };
  const first=client.resolve('A',{queryOwner:owner,signal:abort.signal});assert(ack);abort.abort();
  await assert.rejects(finiteSettle(first),{code:'HISTORY_READ_CANCELLED'});
  await assert.rejects(finiteSettle(client.resolve('A',{queryOwner:owner})),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  assert.deepEqual(await finiteSettle(client.resolve('A',{queryOwner:{}})),{kind:'found',index:0,memberIndex:-1});
  assert.equal(releases(f,client.identity),0);gate.resolve(ack);await tick();
  assert.equal(releases(f,ack),1);assert.equal(client.stats().cleanupSlots,0);
  assert.deepEqual(await client.resolve('A',{queryOwner:owner}),{kind:'found',index:0,memberIndex:-1});await client.close();
});

test('r3 original client close and original signal abort inside final owns cannot return a found result',async t=>{
  for(const action of ['close','abort'])await t.test(action,async sub=>{
    const f=fixture(sub),client=await f.open([entry('A',0)]),abort=new AbortController();let afterRelease=false;
    f.hook=(channel,payload,route)=>{
      const response=route(channel,payload);
      if(channel===RELEASE&&payload.leaseId!==client.identity.leaseId)afterRelease=true;
      return response;
    };
    await assert.rejects(client.resolve('A',{signal:abort.signal,owns:()=>{
      if(afterRelease){afterRelease=false;if(action==='close')client.close();else abort.abort();}return true;
    }}),{code:'HISTORY_READ_CANCELLED'});
    await tick();assert.equal(f.calls.filter(call=>call.channel===FORK).length,1);
    assert.equal(f.calls.filter(call=>call.channel===RELEASE&&call.payload.leaseId!==client.identity.leaseId).length,1);
    if(action==='close')assert.equal(client.closed,true);await client.close();
  });
});

test('r3 cleanup invoke reentry closes original client before point publication',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0)]);let closed=false;
  f.hook=(channel,payload,route)=>{
    if(channel===RELEASE&&payload.leaseId!==client.identity.leaseId&&!closed){closed=true;client.close();}
    return route(channel,payload);
  };
  await assert.rejects(client.resolve('A'),{code:'HISTORY_READ_CANCELLED'});
  await tick();assert.equal(client.closed,true);assert.equal(f.plane.stats().roots,0);
  assert.equal(releases(f,client.identity),1);await client.retirement().promise;
});

test('r3 parent release ACK cannot retire an independently unresolved child cleanup',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0)]),held=deferred();let ack;
  f.hook=(channel,payload,route)=>{
    const result=route(channel,payload);
    if(channel===RELEASE&&payload.leaseId!==client.identity.leaseId){ack=result;return held.promise;}return result;
  };
  assert.equal((await finiteSettle(client.resolve('A'))).kind,'found');
  await client.close();assert.equal(f.plane.stats().roots,0);
  assert.equal(client.retirement().status,'pending');let retired=false;client.retirement().promise.then(()=>{retired=true;});await tick();
  assert.equal(retired,false);assert.equal(client.stats().cleanupSlots,1);
  held.resolve(ack);await client.retirement().promise;assert.equal(client.retirement().status,'released');
});

test('r3 rejected cleanup is observable UNKNOWN and cannot be erased by parent close or successor',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0)]),owner={};
  f.hook=(channel,payload,route)=>{
    const response=route(channel,payload);
    if(channel===RELEASE&&payload.leaseId!==client.identity.leaseId)return Promise.reject(fail('HISTORY_READER_TRANSPORT_UNKNOWN'));
    return response;
  };
  assert.equal((await finiteSettle(client.resolve('A',{queryOwner:owner}))).kind,'found');await tick();
  assert.equal(client.stats().cleanupUnknown,1);const count=f.calls.length;
  await assert.rejects(client.resolve('A',{queryOwner:owner}),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});assert.equal(f.calls.length,count);
  await client.close();await assert.rejects(client.retirement().promise,{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  assert.equal(client.retirement().status,'unknown');assert.equal(client.stats().cleanupSlots,1);
});

test('r3 wrapped uncertain allocation responses retain exact UNKNOWN slot and never imply absence',async t=>{
  for(const code of ['HISTORY_READER_TRANSPORT_UNKNOWN','HISTORY_READER_PROCESS_EXITED','HISTORY_READER_FENCE_UNAVAILABLE'])await t.test(code,async sub=>{
    const f=fixture(sub),client=await f.open([entry('A',0)]),owner={};let hidden;
    f.hook=(channel,payload,route)=>{
      if(channel===FORK){hidden=route(channel,payload);return {success:false,error:code};}return route(channel,payload);
    };
    await assert.rejects(client.resolve('A',{queryOwner:owner}),{code});assert(hidden);
    assert.equal(client.stats().cleanupUnknown,1);const count=f.calls.length;
    await assert.rejects(client.resolve('A',{queryOwner:owner}),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});assert.equal(f.calls.length,count);
    await client.close();assert.equal(f.plane.stats().roots,1,'unknown independent child is not claimed closed by parent ACK');
    await assert.rejects(client.retirement().promise,{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
    assert.equal(releases(f,hidden),0,'an unreceived identity is never guessed for cleanup');
  });
});

test('r3 proven preallocation capacity refusal frees its empty slot without reopening the parent',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0)]),owner={};let first=true;
  f.hook=(channel,payload,route)=>{if(channel===FORK&&first){first=false;return {success:false,error:'HISTORY_ROOT_LEASE_LIMIT'};}return route(channel,payload);};
  await assert.rejects(client.resolve('A',{queryOwner:owner}),{code:'HISTORY_ROOT_LEASE_LIMIT'});
  assert.equal(client.stats().cleanupSlots,0);assert.deepEqual(await client.resolve('A',{queryOwner:owner}),{kind:'found',index:0,memberIndex:-1});
  assert.equal(f.calls.filter(call=>call.channel===OPEN).length,1);await client.close();
});

test('r3 replay response must advance exactly one pass and cannot authorize a new target or fork',async t=>{
  const f=fixture(t),client=await f.open([entry('A',0)]);let pages=0;
  f.hook=async(channel,payload,route)=>{
    const response=await route(channel,payload);
    if(channel===PAGE&&payload.operation==='target'){
      pages++;if(response.phase==='replay'){response.pass+=1;response.creditBytesUsed=0;
        for(let i=0;i<10;i++){const n=Buffer.byteLength(JSON.stringify(response));if(n===response.creditBytesUsed)break;response.creditBytesUsed=n;}}
    }return response;
  };
  await assert.rejects(client.resolve('A'),{code:'HISTORY_POSITION_PAGE'});assert.equal(pages,1);
  assert.equal(f.calls.filter(call=>call.channel===FORK).length,1);await client.close();
});

function renderer(f){
  let active=null;const errors=[];
  const owner=createHistoryPresentationPositionOwner({invoke:f.invoke,onError:error=>errors.push(error)});
  const publish=(...ids)=>{
    const frame=active={},witness={},units=ids.map(uuid=>({kind:'entry',entry:{uuid}})),itemKeys=ids.map((_id,i)=>'actual:'+i);
    return owner.publish({frame,witness,units,itemKeys,owns:()=>active===frame});
  };
  return {owner,publish,errors};
}
async function until(check){for(let i=0;i<30&&!check();i++)await tick();assert(check(),'finite fixture phase must be reached');}

test('r3 ordinary parent retirement automatically drains the same queued publication after its exact ACK',async t=>{
  const f=fixture(t),r=renderer(f),a=r.publish('A');await a.promise;
  const gate=deferred();let ack,parent;
  f.hook=(channel,payload,route)=>{
    if(channel===RELEASE&&!parent){parent=payload;ack=route(channel,payload);return gate.promise;}return route(channel,payload);
  };
  const b=r.publish('B'),lane=createHistoryPresentationPositionQuery(r.owner);
  assert.equal(a.frame,null);assert.equal(a.witness,null);assert.equal(b.status,'pending');
  assert.equal(r.owner.stats().retiring,1);assert.equal(r.owner.stats().registrations,1);
  const blocked=await finiteSettle(lane.resolve(b,'B'));
  assert.equal(blocked.status,'failed');assert.equal(blocked.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');
  assert.equal(f.calls.filter(call=>call.channel===FORK).length,0);
  gate.resolve(ack);assert.equal((await finiteSettle(b.promise)).status,'ready');
  assert.equal(r.owner.capture(),b);assert.equal(r.owner.stats().registrations,2);assert.equal(r.owner.stats().retiring,0);
  const selected=await finiteSettle(lane.resolve(b,'B'));
  assert.equal(selected.status,'ready');assert.equal(selected.address.index,0);
  assert.equal(f.calls.filter(call=>call.channel===FORK).length,1,'external read begins its first point only after registration readiness');
  assert.equal(releases(f,parent),1);lane.dispose();await r.owner.dispose();await tick();
});

test('r3 clear and dispose settle without a held parent ACK and cannot forget or bypass its barrier',async t=>{
  const f=fixture(t),r=renderer(f),a=r.publish('A');await a.promise;const gate=deferred();let ack,parent;
  f.hook=(channel,payload,route)=>{
    if(channel===RELEASE&&!parent){parent=payload;ack=route(channel,payload);return gate.promise;}return route(channel,payload);
  };
  await finiteSettle(r.owner.clear());assert.equal(a.frame,null);assert.equal(a.witness,null);
  let latest;const old=[];
  for(let i=0;i<100;i++){if(latest)old.push(latest);latest=r.publish('latest-'+i);}
  assert.equal(r.owner.stats().registrations,1);assert.equal(r.owner.stats().pending,1);assert.equal(r.owner.stats().retiring,1);
  assert.equal(r.owner.stats().unitVisits,1,'queued replacements never enumerate');
  for(const pub of old){assert.equal(pub.status,'superseded');assert.equal(pub.frame,null);assert.equal(pub.witness,null);}
  const lane=createHistoryPresentationPositionQuery(r.owner),result=await finiteSettle(lane.resolve(latest,'latest-99'));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');
  await finiteSettle(r.owner.dispose());assert.equal(latest.status,'superseded');assert.equal(latest.frame,null);
  assert.equal(r.owner.stats().retiring,1);assert.equal(r.owner.stats().current,0);assert.equal(r.owner.stats().pending,0);
  assert.throws(()=>r.publish('resurrection'),{code:'HISTORY_POSITION_OWNER_DISPOSED'});
  gate.resolve(ack);await tick();assert.equal(r.owner.stats().retiring,0);assert.equal(r.owner.stats().registrations,1);
  assert.equal(releases(f,parent),1);lane.dispose();
});

test('r3 latest unsent projection drains once after held cleanup without replaying superseded rows',async t=>{
  const f=fixture(t),r=renderer(f),a=r.publish('A');await a.promise;const gate=deferred();let ack,first=true;
  f.hook=(channel,payload,route)=>{if(channel===RELEASE&&first){first=false;ack=route(channel,payload);return gate.promise;}return route(channel,payload);};
  let latest;for(let i=0;i<100;i++)latest=r.publish('latest-'+i);
  assert.equal(r.owner.stats().registrations,1);assert.equal(r.owner.stats().pending,1);gate.resolve(ack);
  assert.equal((await finiteSettle(latest.promise)).status,'ready');assert.equal(r.owner.stats().registrations,2);
  assert.equal(r.owner.stats().unitVisits,2);assert.equal(r.owner.stats().memberVisits,2);
  assert.equal((await r.owner.query(latest,'latest-99')).index,0);assert.equal(await r.owner.query(latest,'latest-98'),null);
  await r.owner.dispose();await tick();
});

test('r3 real selected lane settles held-child cleanup UNKNOWN while its other three lanes finish',async t=>{
  const f=fixture(t),r=renderer(f),pub=r.publish('A','B');await pub.promise;
  const held=[];f.hook=(channel,payload,route)=>{
    if(channel===RELEASE){const ack=route(channel,payload),gate=deferred();held.push({ack,gate,cap:payload});return gate.promise;}return route(channel,payload);
  };
  const lanes=Array.from({length:4},()=>createHistoryPresentationPositionQuery(r.owner));
  assert.equal((await finiteSettle(lanes[0].resolve(pub,'A'))).status,'ready');
  const next=await finiteSettle(lanes[0].resolve(pub,'B'));
  assert.equal(next.status,'failed');assert.equal(next.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');await tick();
  assert.deepEqual(lanes[0].stats(),{selected:1,running:0,pending:0});
  for(let i=1;i<4;i++)assert.equal((await finiteSettle(lanes[i].resolve(pub,'A'))).status,'ready');
  assert.equal(held.length,4);assert.equal(f.calls.filter(call=>call.channel===FORK).length,4);
  for(const item of held)item.gate.resolve(item.ack);await tick();f.hook=null;
  assert.equal(await lanes[0].resolve(pub,'B'),next,'actual point UNKNOWN remains sticky; ACK does not self-replay it');
  lanes[0].clear();assert.equal((await lanes[0].resolve(pub,'B')).status,'ready');
  for(const item of held)assert.equal(releases(f,item.cap),1);
  lanes.forEach(lane=>lane.dispose());await r.owner.dispose();await tick();
});

test('r3 owner cannot start a new parent after parent ACK while an independent child cleanup is still uncertain',async t=>{
  const f=fixture(t),r=renderer(f),a=r.publish('A');await a.promise;
  const held=deferred();let child,ack;
  f.hook=(channel,payload,route)=>{
    const response=route(channel,payload);if(channel===FORK)child=response;
    if(channel===RELEASE&&payload.leaseId===child?.leaseId){ack=response;return held.promise;}return response;
  };
  const lane=createHistoryPresentationPositionQuery(r.owner);assert.equal((await finiteSettle(lane.resolve(a,'A'))).status,'ready');
  const b=r.publish('B');await tick();assert.equal(b.status,'pending');assert.equal(r.owner.stats().retiring,1);
  assert.equal(f.plane.stats().roots,0,'server already did both releases; client still owns the unknown child receipt');
  const blocked=await finiteSettle(lane.resolve(b,'B'));assert.equal(blocked.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');
  assert.equal(r.owner.stats().registrations,1);assert.equal(a.frame,null);assert.equal(a.witness,null);
  held.resolve(ack);assert.equal((await finiteSettle(b.promise)).status,'ready');assert.equal(r.owner.stats().registrations,2);
  assert.equal(releases(f,child),1);lane.dispose();await r.owner.dispose();await tick();
});

test('r3 rejected parent cleanup remains bounded UNKNOWN across clear and publication replacement',async t=>{
  const f=fixture(t),r=renderer(f),a=r.publish('A');await a.promise;let parent;
  f.hook=(channel,payload,route)=>{
    const result=route(channel,payload);if(channel===RELEASE){parent=payload;return Promise.reject(fail('HISTORY_READER_TRANSPORT_UNKNOWN'));}return result;
  };
  const b=r.publish('B');assert.equal((await finiteSettle(b.promise)).status,'failed');assert.equal(b.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');
  await r.owner.clear();const c=r.publish('C');assert.equal((await finiteSettle(c.promise)).status,'failed');
  assert.equal(c.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');assert.equal(r.owner.stats().retiring,1);
  assert.equal(r.owner.stats().registrations,1);assert.equal(f.calls.filter(call=>call.channel===OPEN).length,1);
  assert.equal(a.frame,null);assert.equal(b.frame,null);assert.equal(releases(f,parent),1);
  await finiteSettle(r.owner.dispose());assert.equal(c.frame,null);assert.equal(r.owner.stats().retiring,1);
});

test('r3 cancelled raw OPEN retains one exact retirement owner until its late receipt is released',async t=>{
  const f=fixture(t),r=renderer(f),held=deferred();let ack,first=true;
  f.hook=(channel,payload,route)=>{
    if(channel===OPEN&&first){first=false;ack=route(channel,payload);return held.promise;}return route(channel,payload);
  };
  const a=r.publish('A');await until(()=>ack);const b=r.publish('B');await until(()=>r.owner.stats().retiring===1);
  assert.equal(a.status,'superseded');assert.equal(a.frame,null);assert.equal(a.witness,null);
  assert.equal(b.status,'pending');assert.equal(r.owner.stats().registrations,1);
  const lane=createHistoryPresentationPositionQuery(r.owner),result=await finiteSettle(lane.resolve(b,'B'));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');
  assert.equal(f.calls.filter(call=>call.channel===OPEN).length,1);
  held.resolve(ack);assert.equal((await finiteSettle(b.promise)).status,'ready');assert.equal(releases(f,ack),1);
  assert.equal(r.owner.stats().registrations,2);lane.dispose();await r.owner.dispose();await tick();
});

test('r3 unknown OPEN cannot be forgotten by replacing the publication with another frame',async t=>{
  const f=fixture(t),r=renderer(f);let hidden;
  f.hook=(channel,payload,route)=>{if(channel===OPEN){hidden=route(channel,payload);return {success:false,error:'HISTORY_READER_TRANSPORT_UNKNOWN'};}return route(channel,payload);};
  const a=r.publish('A');assert.equal((await finiteSettle(a.promise)).status,'failed');assert(hidden);
  await r.owner.clear();const b=r.publish('B');assert.equal((await finiteSettle(b.promise)).status,'failed');
  assert.equal(b.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');assert.equal(r.owner.stats().retiring,1);
  assert.equal(f.calls.filter(call=>call.channel===OPEN).length,1);assert.equal(releases(f,hidden),0);
  await finiteSettle(r.owner.dispose());assert.equal(a.frame,null);assert.equal(b.frame,null);
});

test('r3 same-turn pending OPEN replacement settles original successor queries before retirement handoff',async t=>{
  const f=fixture(t),r=renderer(f),held=deferred();let ack,first=true;
  f.hook=(channel,payload,route)=>{
    if(channel===OPEN&&first){first=false;ack=route(channel,payload);return held.promise;}return route(channel,payload);
  };
  const a=r.publish('A');await until(()=>ack);
  const lane=createHistoryPresentationPositionQuery(r.owner),b=r.publish('B');
  assert.equal(r.owner.stats().retiring,0,'do not wait for the old async catch to install retirement');
  const direct=r.owner.query(b,'B'),selected=lane.resolve(b,'B');
  await assert.rejects(finiteSettle(direct),{code:'HISTORY_READER_TRANSPORT_UNKNOWN'});
  const blocked=await finiteSettle(selected);assert.equal(blocked.status,'failed');
  assert.equal(blocked.error.code,'HISTORY_READER_TRANSPORT_UNKNOWN');
  assert.equal(b.status,'pending');assert.equal(a.status,'superseded');
  assert.equal(f.calls.filter(call=>call.channel===OPEN).length,1);assert.equal(f.calls.filter(call=>call.channel===FORK).length,0);
  await tick();assert.equal(r.owner.stats().retiring,1);assert.equal(lane.stats().running,0);assert.equal(lane.stats().pending,0);
  held.resolve(ack);assert.equal((await finiteSettle(b.promise)).status,'ready');
  assert.equal(r.owner.capture(),b);assert.equal(releases(f,ack),1);
  assert.equal((await finiteSettle(lane.resolve(b,'B'))).status,'ready');
  assert.equal(f.calls.filter(call=>call.channel===OPEN).length,2);assert.equal(f.calls.filter(call=>call.channel===FORK).length,1);
  lane.dispose();await r.owner.dispose();await tick();
});
