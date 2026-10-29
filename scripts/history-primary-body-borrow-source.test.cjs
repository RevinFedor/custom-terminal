'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const {createPrimaryAddressFixture}=require('./test-support/history-primary-address-fixture.cjs');
const {HistoryRootController}=require('../src/main/history-root-engine/main/history-root-controller');
const {HistoryProjectionArena}=require('../src/main/history-root-engine/main/history-projection-arena');
const {createReadControl}=require('../src/main/history-root-engine/main/history-read-control');
const E='history-entry-body-borrow-v1', main=require('node:path').resolve(__dirname,'../src/main/history-root-engine/main')+'/';
const turn=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const entry=(uuid='u')=>({uuid,role:'user',sessionId:'s',timestamp:'2026-10-28T00:00:00.000Z',content:'body '+uuid+'🙂\ud800\0'+'z'.repeat(2048),recordTime:1});
async function fixture(t,entries=[entry()]){
 const f=await createPrimaryAddressFixture(t,{entries});
 const {HistoryRootClient}=await import('../src/shared/history-root-read-client.mjs');
 const {readHistoryPrimaryEntryBody}=await import('../src/renderer/utils/historyPrimaryEntryBody.mjs');
 const releases=[],requests=[];let wireBytes=0;
 const invoke=async(channel,payload)=>{
  assert(requests.length<4096,'finite request work cap');
  const bytes=Buffer.byteLength(JSON.stringify(payload));assert(bytes<=65536,'wire request cap');
  wireBytes+=bytes;assert(wireBytes<=28*1024**2,'aggregate request cap');
  requests.push({channel,payload});if(channel==='agent-transcript:release-read-root')releases.push(payload);
  if(channel==='agent-transcript:fork-read-leaf'&&payload.encoding===E)return f.plane.forkBodyBorrow(payload,{consumerKey:f.consumerKey});
  return f.invoke(channel,payload);
 };
 const opened=await f.open(),reader=new HistoryRootClient(invoke,opened.root,{pageBytes:65536,pageItems:3});
 const nodes=[];for(let i=0;i<opened.root.length;i++)nodes.push((await reader.range(opened.root,{offset:i,limit:1})).items[0].value);
 const request=(node=nodes[0])=>({...reader.identity,nodeToken:node.nodeToken,encoding:E,bodyRequestId:randomUUID()});
 const count=()=>({leases:f.store.stats().leases,roots:f.plane.roots.size,pins:f.store.db.prepare('SELECT count(*) n FROM hp_pins').get().n});
 return {...f,opened,reader,nodes,invoke,requests,releases,request,count,HistoryRootClient,readHistoryPrimaryEntryBody};
}
async function oldUnit(f,node){
 global.window={require};
 const {readHistoryPrimaryUnitDocument}=await import('../src/renderer/utils/historyPrimaryRootReadModel.mjs');
 return readHistoryPrimaryUnitDocument(await f.reader.forkViewUnit(node));
}
function controller(f){
 const ctl=new HistoryRootController({store:f.store,cache:{maxBytes:28*1024**2},service:{},api:{projectCodexFullHistoryFromFile:async()=>{throw Error('unexpected producer');}}});
 ctl.plane=f.plane;ctl.initializedBacking=true;return ctl;
}
test('actual producer / old V8 / shared pages / renderer forkUnit: full values, aliases, grammar, zero new pages',async t=>{
 const alias=Object.assign(Object.create(null),{negative:-0,inf:Infinity,nan:NaN,undef:undefined,big:BigInt('7'.repeat(128))});alias.self=alias;
 alias.map=new Map([[alias,alias],['a',undefined]]);alias.map.ignored='old V8 drops custom fields';alias.set=new Set([alias,3]);
 const sparse=new Array(100000);sparse[99999]=alias;sparse.extra=alias;
 const rows=[{...entry(),alias,alias2:alias,sparse}, {...entry('a'),role:'assistant',textPhase:'final_answer',alias,alias2:alias},
 require(main+'codex-settings-history').codexSettingsHistoryEntry({type:'turn_context',__line:3,__byteOffset:100,timestamp:'2026-10-28T00:00:00.000Z'},'s','model','gpt-test')];
 const f=await fixture(t,rows),{HistoryPrimaryRootReadModel}=await import('../src/renderer/utils/historyPrimaryRootReadModel.mjs');
 for(const node of f.nodes){
  const expected=await oldUnit(f,node),before=f.count(),pages=f.store.metrics.pagesWritten;
  const actual=await HistoryPrimaryRootReadModel.prototype.forkUnit.call({}, {reader:f.reader},node,null,()=>true);
  assert.deepStrictEqual(actual,expected);assert.equal(f.store.metrics.pagesWritten,pages);assert.deepEqual(f.count(),before);
  assert.equal(actual.entry.content,rows.find(r=>r.uuid===actual.entry.uuid).content);
  if(actual.entry.alias){assert.equal(actual.entry.alias,actual.entry.alias2);assert.equal(actual.entry.alias.self,actual.entry.alias);assert.equal(actual.entry.alias.map.get(actual.entry.alias),actual.entry.alias);}
 }
 assert(f.requests.some(r=>r.payload.kind==='body-pairs'));
 const arena=new HistoryProjectionArena(f.store);
 try{assert.throws(()=>arena.step(()=>arena.publish({date:new Date(0)})),{code:'history_projection_input_prototype'});}finally{arena.close();}
 assert.throws(()=>f.store.captureLegacy({date:new Date(0)}),{code:'history_legacy_capture_prototype'});
 // Frozen old producer has no Date atom. Preserve refusal, not JSON coercion.
});
test('true old group path: actual renderer fallback only on authenticated unsupported',async t=>{
 const f=await fixture(t,[{uuid:'a',role:'assistant',textPhase:'commentary',content:'one',recordTime:1,turnId:'T'},
 {uuid:'b',role:'assistant',textPhase:'final_answer',content:'two',recordTime:2,turnId:'T'}]);
 // Use actual grouping preparation with a collapsed response-work chapter.
 const opened=await f.open({grouping:{enabled:true,responseWork:true,threshold:2,expandedKeys:[]}});
 const state=f.plane.state(opened.header,f.consumerKey);
 let group;
 for(let i=0;i<opened.root.length;i++){
  const u=state.primaryPresentation.unitAt(i);if([...u.field('kind').textChunks()].join('')==='group')group=f.plane.describe(state,state.primaryPresentation.headerAt(i),{inline:false});
 }
 assert(group,'fixture must produce a true group');
 const reader=new f.HistoryRootClient(f.invoke,opened.root,{pageBytes:65536,pageItems:3});
 const before=f.count();assert.equal(await reader.borrowEntryBody(group),null);assert.deepEqual(f.count(),before);
 global.window={require};const {HistoryPrimaryRootReadModel,readHistoryPrimaryUnitDocument}=await import('../src/renderer/utils/historyPrimaryRootReadModel.mjs');
 const old=await readHistoryPrimaryUnitDocument(await reader.forkViewUnit(group));
 const actual=await HistoryPrimaryRootReadModel.prototype.forkUnit.call({}, {reader},group,null,()=>true);
 assert.deepStrictEqual(actual,old);assert.equal(actual.kind,'group');await reader.close();
});
test('child survives parent close; stale/forged source, HMAC, generation and foreign consumer refuse',async t=>{
 const f=await fixture(t),opts={consumerKey:f.consumerKey};const req=f.request();
 for(const bad of [{...req,nodeToken:req.nodeToken+'x'},{...req,ownerKey:'bad'},{...req,generation:'bad'},
 {...req,sourceSnapshot:{}},{...req,sessionId:'foreign',cwd:'/finite',tabId:'t'}])assert.throws(()=>f.plane.forkBodyBorrow(bad,opts));
 assert.throws(()=>f.plane.forkBodyBorrow(req,{consumerKey:'foreign'}));
 const child=await f.reader.borrowEntryBody(f.nodes[0]),before=f.count();
 await f.reader.close();assert.equal(f.count().roots,before.roots-1);
 assert.equal((await f.readHistoryPrimaryEntryBody(child)).entry.content,entry().content);
 assert.throws(()=>f.plane.forkBodyBorrow(req,opts),{code:'HISTORY_ROOT_RELEASED'});
});
test('pin/commit/quota/capacity failures leave no child or pin; cancellation after pin cleans only candidate',async t=>{
 const f=await fixture(t),req=f.request(),opts={consumerKey:f.consumerKey},before=f.count();
 const transaction=f.store.transaction.bind(f.store);
 for(const code of ['PIN_FAILED','HISTORY_BACKING_FULL']){
  f.store.transaction=fn=>transaction(()=>{fn();throw Object.assign(Error(code),{code});});
  assert.throws(()=>f.plane.forkBodyBorrow(req,opts),{code});f.store.transaction=transaction;assert.deepEqual(f.count(),before);
 }
 const diskBudget=f.store.diskBudget;f.store.diskBudget=f.store.diskUsage();
 assert.throws(()=>f.plane.forkBodyBorrow(req,opts),{code:'HISTORY_BACKING_FULL'});f.store.diskBudget=diskBudget;assert.deepEqual(f.count(),before);
 const max=f.plane.maxRoots;f.plane.maxRoots=f.plane.roots.size;assert.throws(()=>f.plane.forkBodyBorrow(req,opts),{code:'HISTORY_ROOT_LEASE_LIMIT'});f.plane.maxRoots=max;
 let checks=0;assert.throws(()=>f.plane.forkBodyBorrow(req,{...opts,control:{assertCurrent(){if(++checks===2)throw Object.assign(Error('cancel'),{code:'HISTORY_READ_CANCELLED'});}}}),{code:'HISTORY_READ_CANCELLED'});
 assert.deepEqual(f.count(),before);
 const sibling=f.plane.forkBodyBorrow(f.request(),opts),n=f.count();
 assert.throws(()=>f.plane.release({...sibling,bodyRequestId:req.bodyRequestId},opts),{code:'HISTORY_BODY_BINDING'});assert.deepEqual(f.count(),n);
 f.plane.release(sibling,opts);assert.deepEqual(f.count(),before);
});
test('late/aborted/wrong-ID/malformed replies never release sibling; unknown remains unknown',async t=>{
 const f=await fixture(t),before=f.count();
 const gate=deferred(),started=deferred();
 const delayed=new f.HistoryRootClient(async(c,p)=>{
  if(c==='agent-transcript:fork-read-leaf'){const value=await f.invoke(c,p);started.resolve();await gate.promise;return value;}
  return f.invoke(c,p);
 },f.opened.root,{pageBytes:65536});
 const abort=new AbortController(),task=delayed.borrowEntryBody(f.nodes[0],{signal:abort.signal});await started.promise;abort.abort();
 await assert.rejects(task,{code:'HISTORY_READ_CANCELLED'});gate.resolve();await turn();await turn();assert.deepEqual(f.count(),before);
 const sibling=await f.reader.borrowEntryBody(f.nodes[0]);const siblingState=f.plane.state(sibling.identity,f.consumerKey);
 const malformed=new f.HistoryRootClient(async(c,p)=>{
  if(c==='agent-transcript:fork-read-leaf')return{success:true,kind:'entry-body',encoding:E,__notedHistoryTransport:'root-v1',
   ...sibling.identity,root:sibling.root,bodyRequestId:siblingState.bodyRequestId};
  return f.invoke(c,p);
 },f.opened.root,{pageBytes:65536});
 await assert.rejects(malformed.borrowEntryBody(f.nodes[0]),{code:'HISTORY_BODY_BINDING'});await turn();assert(!siblingState.released);
 assert.equal((await f.readHistoryPrimaryEntryBody(sibling)).entry.uuid,'u');assert.deepEqual(f.count(),before);
 for(const mutate of [r=>({...r,bodyRequestId:randomUUID()}),r=>({...r,root:{...r.root,nodeToken:5}})]){
  const r=new f.HistoryRootClient(async(c,p)=>c==='agent-transcript:fork-read-leaf'?mutate(await f.invoke(c,p)):f.invoke(c,p),f.opened.root,{pageBytes:65536});
  await assert.rejects(r.borrowEntryBody(f.nodes[0]));await turn();assert.deepEqual(f.count(),before);await r.abandon();
 }
 const unknown=new f.HistoryRootClient(async(c,p)=>{if(c==='agent-transcript:fork-read-leaf')throw Object.assign(Error('UNKNOWN'),{code:'UNKNOWN'});return f.invoke(c,p);},f.opened.root);
 await assert.rejects(unknown.borrowEntryBody(f.nodes[0]),{code:'UNKNOWN'});assert.deepEqual(f.count(),before);
 await delayed.abandon();await malformed.abandon();await unknown.abandon();
});
test('bad page IDs/content digest/cancel close independent child only',async t=>{
 const f=await fixture(t),before=f.count();
 for(const mode of ['id','text','cancel']){
  let child,abort=new AbortController();
  const r=new f.HistoryRootClient(async(c,p)=>{
   const v=await f.invoke(c,p);
   if(c==='agent-transcript:read-page'&&child){
    if(mode==='id')return{...v,bodyRequestId:'bad'};
    if(mode==='cancel')abort.abort();
    if(mode==='text'&&p.kind==='leaf'&&v.text){v.text='q'+v.text.slice(1);let prior;do{prior=v.creditBytesUsed;v.creditBytesUsed=Buffer.byteLength(JSON.stringify(v));}while(prior!==v.creditBytesUsed);}
   }return v;
  },f.opened.root,{pageBytes:65536});
  child=await r.borrowEntryBody(f.nodes[0]);await assert.rejects(f.readHistoryPrimaryEntryBody(child,{signal:abort.signal}));await turn();assert.deepEqual(f.count(),before);await r.abandon();
 }
 assert.equal((await f.readHistoryPrimaryEntryBody(await f.reader.borrowEntryBody(f.nodes[0]))).entry.uuid,'u');
});
// Execute the exact worker key construction and FIFO publication snippets.
// No old controller extraction: all classifier/dispatch/GC methods are real.
function scheduler(ctl,legacy=false){
 const old=legacy?require('./test-support/history-body-routing-before.cjs'):null;
 const source=legacy?'':fs.readFileSync(main+'history-read-worker.js','utf8');
 const routing=old?.routing??source.slice(source.indexOf('  const leaseKey = rootController.installedCapabilityLane'),source.indexOf('  const correlation = { requestId: id'));
 const enqueue=old?.enqueue??source.slice(source.indexOf('  const enqueue = executionControl => {'),source.indexOf('  // Register actual identical-request consumers'));
 assert.equal(routing.includes('installedBodyPinFork'),!legacy);assert(enqueue.includes('chains.set(key, queued)'));
 const chains=new Map(),started=[];
 const run=(method,payload,{gate,control=createReadControl(),retain}={})=>{
  const context={rootController:ctl,method,payload,sourceKey:JSON.stringify([payload.sessionId,payload.cwd]),chains,Promise,
   work:async c=>{started.push(payload.tag);if(gate){gate.entered.resolve();await gate.exit.promise;c.assertCurrent();}
    return ctl.dispatch(method,payload,{control:c,retain,installedBodyPinRoute:context.pin});}};
  vm.createContext(context);const route=vm.runInContext(routing+'\n({keys,bodyPin:typeof bodyPin===\'undefined\'?false:bodyPin})',context);context.pin=!!route.bodyPin;
  vm.runInContext(enqueue+'\nglobalThis.enqueueTest=enqueue;',context);
  return context.enqueueTest(control);
 };
 return{run,started,chains};
}
const gate=()=>({entered:deferred(),exit:deferred()});
test('actual worker FIFO + actual controller: held sibling maintenance does not delay installed entry; explicit source/parent/child order retained',async t=>{
 const f=await fixture(t),ctl=controller(f),s=scheduler(ctl),key=f.consumerKey;
 const second=await f.open({tabId:'second'}),state=f.plane.state(second.header,key);
 const bNode=f.plane.describe(state,state.primaryPresentation.headerAt(0),{inline:false});
 const req=extra=>({...f.request(),_historyRootConsumerKey:key,...extra});
 const before=f.count(),unlock=await ctl.maintenanceAdmission.acquire(createReadControl());
 let oldDone=false;
 const old=s.run('forkHistoryRootLeaf',{...second.header,nodeToken:bNode.nodeToken,encoding:'history-display-unit-v8-v1',_historyRootConsumerKey:key,tag:'old-B'}).then(r=>{oldDone=true;return r;});
 await turn();assert.equal(ctl.maintenanceAdmission.waiting,1);
 const body=await s.run('forkHistoryRootLeaf',req({tag:'foreground-A'}));assert.equal(body.kind,'entry-body');assert.equal(oldDone,false);
 assert.equal(ctl.allocates('forkHistoryRootLeaf',req()),true,'pin remains an allocation');
 const read=await s.run('readHistoryRootPage',{...body.root,bodyRequestId:body.bodyRequestId,kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key,tag:'child-read'});
 assert.equal(read.success,true);assert.equal(oldDone,false);
 unlock();const oldCap=await old;f.plane.release(oldCap,{consumerKey:key});f.plane.release(body,{consumerKey:key});
 assert.deepEqual(f.count(),before);
 // Same parent FIFO even when the follower would be pin-only.
 const g=gate(),first=s.run('readHistoryRootPage',{...f.nodes[0],kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key,tag:'parent-before'},{gate:g});
 await g.entered.promise;let done=false;const after=s.run('forkHistoryRootLeaf',req({tag:'parent-after'})).then(r=>{done=true;return r;});await turn();assert(!done);g.exit.resolve();await first;const cap=await after;
 // Child read/release exact FIFO; release cannot invalidate its earlier read.
 const cg=gate(),cr=s.run('readHistoryRootPage',{...cap.root,bodyRequestId:cap.bodyRequestId,kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key,tag:'child-before'},{gate:cg});await cg.entered.promise;
 let released=false;const close=s.run('releaseHistoryRoot',{...cap,_historyRootConsumerKey:key,tag:'child-after'}).then(r=>{released=true;return r;});await turn();assert(!released);cg.exit.resolve();await cr;await close;
 // Explicit source address keeps its original predecessor, including BOTH
 // edges. An authenticated borrow never erases that source queue.
 const sg=gate(),scoped={sessionId:'s',cwd:'/finite',tabId:'t'};
 const source=s.run('readHistoryRootPage',{...bNode,...scoped,tabId:'second',kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key,tag:'source-before'},{gate:sg});await sg.entered.promise;
 let sourceDone=false;const srcAfter=s.run('forkHistoryRootLeaf',req({...scoped,tag:'source-after'})).then(r=>{sourceDone=true;return r;});await turn();assert(!sourceDone);sg.exit.resolve();await source;f.plane.release(await srcAfter,{consumerKey:key});
 // Routing classification is never a dispatch permit. A GC state change
 // while queued refuses the narrow path; it cannot turn into unqueued allocation.
 const fresh=gate(),p=s.run('readHistoryRootPage',{...f.nodes[0],kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key,tag:'fresh-before'},{gate:fresh});await fresh.entered.promise;
 const q=s.run('forkHistoryRootLeaf',req({tag:'fresh-after'}));const rejected=assert.rejects(q,{code:'HISTORY_BODY_ROUTE_CHANGED'});
 ctl.fullCollectionDepth++;fresh.exit.resolve();await p;await rejected;ctl.fullCollectionDepth--;
 assert.deepEqual(f.count(),before);
});
test('controller retains exact candidate cleanup on late cancellation and retainer failure',async t=>{
 const f=await fixture(t),ctl=controller(f),before=f.count(),request={...f.request(),_historyRootConsumerKey:f.consumerKey};
 await assert.rejects(ctl.dispatch('forkHistoryRootLeaf',request,{control:createReadControl(),retain(cleanup){cleanup();}}),{code:'HISTORY_ROOT_RELEASED'});assert.deepEqual(f.count(),before);
 await assert.rejects(ctl.dispatch('forkHistoryRootLeaf',{...request,bodyRequestId:randomUUID()},{control:createReadControl(),retain(){throw Object.assign(Error('retainer'),{code:'RETAINER'});}}),{code:'RETAINER'});assert.deepEqual(f.count(),before);
 const c=new AbortController();await assert.rejects(ctl.dispatch('forkHistoryRootLeaf',{...request,bodyRequestId:randomUUID()},{control:createReadControl({signal:c.signal}),retain(){c.abort();}}));assert.deepEqual(f.count(),before);
});
test('actual IPC bridges capture original body ID across demand rejection; unsupported never releases parent',async t=>{
 const f=await fixture(t),{EventEmitter}=require('node:events');
 const {createHistoryIpcDemands}=require(main+'history-ipc-demand');
 for(const location of [require('node:path').resolve(__dirname,'../src/main/history-root-ipc.js'),main+'history-root-ipc.js']){
  const {createHistoryRootIpcBridge}=require(location),demands=createHistoryIpcDemands();
  const sender=new EventEmitter();sender.isDestroyed=()=>false;const event={sender};
  const events=[];let mode='capture',liveConsumer,reply;
  const bridge=createHistoryRootIpcBridge({demands,reader:{
   async call(method,payload){
    liveConsumer=payload._historyRootConsumerKey;
    if(mode==='capture')return{success:false,error:'capture'};
    // Real plane ownership is transferred only in the finite fixture setup;
    // the bridge still overwrites a forged public _historyRootConsumerKey.
    const result=mode==='unsupported' ? {success:true,kind:'unsupported',encoding:E,...f.reader.identity,bodyRequestId:payload.bodyRequestId}
      : f.plane.forkBodyBorrow(payload,{consumerKey:liveConsumer});reply=result;
    if(mode==='unsupported')demands.cancel(event,{readDemandId:'cancel-body'});
    if(mode==='cancel')demands.cancel(event,{readDemandId:'cancel-body'});
    if(mode==='wrong-reply'){
      demands.cancel(event,{readDemandId:'cancel-body'});return {...result,bodyRequestId:randomUUID(),inputDocument:{documentId:'foreign'}};
    }
    return result;
   },postWorkerEvent(e){events.push(e);if(e.event==='release-root-result')f.plane.release(e.capability,{consumerKey:e.consumerKey});}
  }});
  await bridge.run(event,{},'readHistoryRootPage');
  const original=f.plane.state(f.opened.header,f.consumerKey),oldKey=original.consumerKey;
  original.consumerKey=liveConsumer;
  try{
   for(const variant of ['cancel','wrong-reply']){
    const before=f.count();mode=variant;const request={...f.request(),readDemandId:'cancel-body',_historyRootConsumerKey:'forged'};
    await assert.rejects(bridge.run(event,request,'forkHistoryRootLeaf'));
    const receipt=events.at(-1);assert.equal(receipt.capability.bodyRequestId,request.bodyRequestId);assert.equal(receipt.capability.leaseId,reply.leaseId);
    assert.deepEqual(f.count(),before);assert(!original.released);
   }
   mode='unsupported';const count=events.length;await assert.rejects(bridge.run(event,{...f.request(),readDemandId:'cancel-body'},'forkHistoryRootLeaf'));
   assert.equal(events.length,count);assert(!original.released);
  }finally{original.consumerKey=oldKey;bridge.close();}
 }
});
test('new body pin shares existing unit diagnostic without claiming serialization or page writes',async t=>{
 const f=await fixture(t),summaries=[],ctl=controller(f);
 const cap=await ctl.dispatch('forkHistoryRootLeaf',{...f.request(),_historyRootConsumerKey:f.consumerKey},
  {control:createReadControl(),onUnitDiagnostic:s=>summaries.push(s)});
 const s=summaries[0];assert.equal(s.outcome,'success');assert.equal(s.memo,'installed-body-pin');assert.equal(s.kind,'entry');
 assert.equal(s.serializedBytes,null);assert.equal(s.writeStartUs,null);assert.equal(s.serializeStartUs,null);assert.equal(s.incomplete,false);
 f.plane.release(cap,{consumerKey:f.consumerKey});
});
test('queued cancellation and parent retirement cannot promote routing proof into an allocation',async t=>{
 const f=await fixture(t),ctl=controller(f),s=scheduler(ctl),key=f.consumerKey;
 const g=gate(),first=s.run('readHistoryRootPage',{...f.nodes[0],kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key},{gate:g});
 await g.entered.promise;const before=f.count(),abort=new AbortController();
 const second=s.run('forkHistoryRootLeaf',{...f.request(),_historyRootConsumerKey:key},{control:createReadControl({signal:abort.signal})});
 const declined=assert.rejects(second);abort.abort();g.exit.resolve();await first;await declined;assert.deepEqual(f.count(),before);
 const h=gate(),held=s.run('readHistoryRootPage',{...f.nodes[0],kind:'fields',offset:0,limit:3,creditBytes:65536,_historyRootConsumerKey:key},{gate:h});await h.entered.promise;
 const borrow=s.run('forkHistoryRootLeaf',{...f.request(),_historyRootConsumerKey:key});
 const heldFail=assert.rejects(held),borrowFail=assert.rejects(borrow,{code:'HISTORY_BODY_ROUTE_CHANGED'});
 f.plane.releaseConsumer(key);h.exit.resolve();await heldFail;await borrowFail;assert.equal(f.plane.roots.size,0);
});
test.after(()=>{
 const v8=require('node:v8'),r=process.resourceUsage(),m=process.memoryUsage();
 const receipt={node:process.version,oldSpaceMiB:64,semiSpaceMiB:2,heapLimitBytes:v8.getHeapStatistics().heap_size_limit,
  peakRssBytes:r.maxRSS*1024,finalRssBytes:m.rss,heapUsedBytes:m.heapUsed,heapCapBytes:96*1024**2,rssCapBytes:128*1024**2};
 console.log('RESOURCE_RECEIPT '+JSON.stringify(receipt));
 assert(receipt.heapLimitBytes<=receipt.heapCapBytes);assert(receipt.peakRssBytes<=receipt.rssCapBytes);
});
test('negative control: exact Source97 worker routing traps the new borrow behind unrelated allocating null predecessor',async t=>{
 const f=await fixture(t),ctl=controller(f),s=scheduler(ctl,true),key=f.consumerKey;
 const second=await f.open({tabId:'B'}),state=f.plane.state(second.header,key);
 const bNode=f.plane.describe(state,state.primaryPresentation.headerAt(0),{inline:false});
 const unlock=await ctl.maintenanceAdmission.acquire(createReadControl());
 const old=s.run('forkHistoryRootLeaf',{...second.header,nodeToken:bNode.nodeToken,encoding:'history-display-unit-v8-v1',_historyRootConsumerKey:key,tag:'negative-old'});
 await turn();assert.equal(ctl.maintenanceAdmission.waiting,1);
 let done=false;const borrowed=s.run('forkHistoryRootLeaf',{...f.request(),_historyRootConsumerKey:key,tag:'negative-new'}).then(r=>{done=true;return r;});
 await turn();assert.equal(done,false);assert(!s.started.includes('negative-new'));
 unlock();f.plane.release(await old,{consumerKey:key});f.plane.release(await borrowed,{consumerKey:key});
});
