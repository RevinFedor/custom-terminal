'use strict';
// Finite Source control. Full actual controller/store/plane/client; private
// SQLite and synthetic channel/consumer/ACK boundary. Worker routing, enqueue
// and freshness are bounded verbatim CURRENT blocks, never a worker process.
// node --max-old-space-size=64 --max-semi-space-size=8 scripts/history-presentation-position-controller-source.test.cjs
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),v8=require('node:v8');
const {HistoryPagedStore}=require('../src/main/history-root-engine/main/history-paged-store');
const {HistoryRootController}=require('../src/main/history-root-engine/main/history-root-controller');
const {createReadControl,createReadAdmission}=require('../src/main/history-root-engine/main/history-read-control');
const {HISTORY_PRESENTATION_POSITION_PROFILE:PROFILE,HISTORY_PRESENTATION_POSITION_QUERY_ENCODING:ENCODING}
  =require('../src/main/history-root-engine/main/history-presentation-position');
const Database=require('./test-support/history-node-sqlite.cjs');
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2,'finite V8 TOTAL <=128MiB; use documented command');
const tick=()=>new Promise(resolve=>setImmediate(resolve)),fail=code=>Object.assign(new Error(code),{code});
const root=path.resolve(__dirname,'..'),workerFile=path.join(root,'src/main/history-root-engine/main/history-read-worker.js');
const worker=fs.readFileSync(workerFile,'utf8');
function block(start,end){const from=worker.indexOf(start),to=worker.indexOf(end,from);assert(from>=0&&to>from);
  assert.equal(worker.indexOf(start,from+1),-1,'unique exact Source block start');return worker.slice(from,to);}
const routing=block('  const leaseKey = rootController.installedCapabilityLane(method, payload);','  const correlation = {');
const routeKeys=new Function('rootController','method','payload','sourceKey',routing+'\nreturn {leaseKey,key,keys};');
const enqueueBlock=block('  const enqueue = executionControl => {','  // Register actual identical-request consumers BEFORE');
const queueFor=new Function('keys','chains','work',enqueueBlock+'\nreturn enqueue;');
const coldLine="if (method === 'openHistoryRoot' || method === 'openHistoryPayload') await enterCold();";
assert.equal(worker.split(coldLine).length,2,'original cold admission remains an unconditional open boundary');
const coldAdmission=new Function('method','enterCold','return (async()=>{'+coldLine+'})();');
const row=(uuid,index)=>({uuid,index,memberIndex:-1,memberCount:1});
function fixture(t,{routed=false}={}){
  const store=new HistoryPagedStore({Database,pageBytes:256,indexBytes:512,residentPages:3,diskBytes:12*1024**2});
  let sourceCalls=0;
  const controller=new HistoryRootController({store,Database,cache:{maxBytes:24*1024**2},service:{},
    api:{projectCodexFullHistoryFromFile(){sourceCalls++;throw fail('FINITE_CANONICAL_UNAVAILABLE');}},
    rootDiskBudgetBytes:12*1024**2,sourceSchema:'finite-position-v51',diagnosticsDisabled:true});
  // Negative boundary: this task must not inspect a provider/source/file. The
  // actual early position dispatch is tested against a throwing source gate.
  controller.physicalScope=()=>{sourceCalls++;throw fail('FINITE_PHYSICAL_SCOPE_POISON');};
  const control=createReadControl(),consumerKey='finite-controller-position',calls=[],retained=[];
  const f={store,controller,control,consumerKey,calls,retained,queryMetrics:null,sourceCalls:()=>sourceCalls,
    chains:new Map(),cold:createReadAdmission(),demands:new Map()};
  const methods={'agent-transcript:get-history':'openHistoryRoot','agent-transcript:read-page':'readHistoryRootPage',
    'agent-transcript:fork-read-leaf':'forkHistoryRootLeaf','agent-transcript:release-read-root':'releaseHistoryRoot'};
  f.run=(method,payload,options={})=>{
    const request={...payload,_historyRootConsumerKey:consumerKey},current=options.control||f.control;
    const execute=async()=>{
      let releaseCold;
      try{
        if(routed)await coldAdmission(method,async()=>{releaseCold=await f.cold.acquire(current);});
        return await controller.dispatch(method,request,{control:current,retain:cleanup=>retained.push(cleanup),...options});
      }finally{releaseCold?.();}
    };
    if(!routed)return execute();
    const sourceKey=JSON.stringify([request.sessionId,request.cwd]),routing=routeKeys(controller,method,request,sourceKey);
    return queueFor(routing.keys,f.chains,async original=>{original.assertCurrent();return execute();})(current);
  };
  f.invoke=async(channel,payload)=>{
    if(channel==='agent-transcript:cancel-read'){
      f.demands.get(payload.readDemandId)?.abort();return {success:true,cancelled:true};
    }
    const method=methods[channel];assert(method);calls.push({method,payload});
    const demand=payload.readDemandId?new AbortController():null;
    const requestControl=demand?createReadControl({signal:demand.signal,assertSourceCurrent(){f.control.assertCurrent();},
      schedule:()=>f.control.checkpoint()}):null;
    if(demand)f.demands.set(payload.readDemandId,demand);
    f.observeRequest?.('start',method);
    try{
    const value=await f.run(method,payload,{control:requestControl||(method==='releaseHistoryRoot'?control:f.control)});
    if(method==='readHistoryRootPage'&&payload.operation==='target'){
      const query=controller.plane.state(payload,consumerKey).positionQuery;
      f.queryMetrics={...query.metrics};
    }
    return value;
    }finally{f.observeRequest?.('end',method);if(demand)f.demands.delete(payload.readDemandId);requestControl?.finish();}
  };
  f.open=async(records,extra={})=>{const {openHistoryPresentationPosition}=await import('../src/shared/history-root-read-client.mjs');
    return openHistoryPresentationPosition(f.invoke,{projectionId:'finite-controller',unitCount:records.length,records,...extra});};
  t.after(()=>{controller.close();control.finish();f.control!==control&&f.control.finish();
    assert.equal(f.demands.size,0);
    assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n,0);store.close();});
  return f;
}

test('full controller keeps registration maintenance and authenticates independent Source-null position reads',async t=>{
  const f=fixture(t),client=await f.open([row('retained-local',0)]),state=f.controller.plane.state(client.identity,f.consumerKey);
  assert.equal(f.sourceCalls(),0);assert.equal(state.source,null);assert.equal(state.canonicalSource,null);assert.equal(state.primaryPresentation,null);
  assert.equal(f.controller.initializedBacking,true);assert.equal(f.controller.maintenanceAdmission.active,false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM hp_root_cache_owners').get().n,0,'position creates no canonical cache owner');
  assert.deepEqual(await client.resolve('retained-local'),{kind:'found',index:0,memberIndex:-1});
  assert.equal(f.retained.length,2,'exact registration and independent query both enter actual delivery retention');
  const parentLease=client.identity.leaseId;
  assert.equal(f.calls.filter(x=>x.method==='releaseHistoryRoot'&&x.payload.leaseId===parentLease).length,0);
  assert.equal(f.controller.allocates('readHistoryRootPage',{kind:PROFILE,operation:'append'}),true);
  assert.equal(f.controller.allocates('readHistoryRootPage',{kind:PROFILE,operation:'target'}),true);
  assert.equal(f.controller.installedTextPinFork('forkHistoryRootLeaf',{...client.identity,encoding:ENCODING,
    _historyRootConsumerKey:f.consumerKey}),false,'coordinate capability never claims the different text-pin fast path');
  assert.equal(f.controller.allocates('forkHistoryRootLeaf',{...client.identity,encoding:ENCODING,
    projectionId:'finite-controller',_historyRootConsumerKey:f.consumerKey}),false,'only actual installed sealed read avoids allocation');
  await client.close();assert.equal(f.controller.plane.stats().roots,0);assert.equal(f.sourceCalls(),0);
});

test('actual controller post-allocation cancellation releases exact retained candidate without source fallback',async t=>{
  const f=fixture(t),abort=new AbortController(),control=createReadControl({signal:abort.signal});let retained;
  const payload={toolType:'codex',readTransport:'root-v1',readProfile:PROFILE,projectionId:'cancelled-candidate',unitCount:0,
    _historyRootConsumerKey:f.consumerKey};
  await assert.rejects(f.controller.dispatch('openHistoryRoot',payload,{control,retain:cleanup=>{retained=cleanup;abort.abort();}}),
    {code:'HISTORY_READ_CONSUMER_REVOKED'});
  assert.equal(typeof retained,'function');retained();assert.equal(f.controller.plane.stats().roots,0);
  assert.equal(f.sourceCalls(),0);assert.equal(f.controller.maintenanceAdmission.active,false);control.finish();
});

test('read-only fork preserves original post-await cancellation cleanup and leaves parent owned',async t=>{
  const f=fixture(t),client=await f.open([row('held',0)]),abort=new AbortController();
  const control=createReadControl({signal:abort.signal});
  try{
    await assert.rejects(f.controller.dispatch('forkHistoryRootLeaf',{...client.identity,encoding:ENCODING,
      projectionId:'finite-controller',_historyRootConsumerKey:f.consumerKey},{control,
      retain(){queueMicrotask(()=>abort.abort());}}),{code:'HISTORY_READ_CONSUMER_REVOKED'});
    assert.equal(f.controller.plane.stats().roots,1);assert.equal(f.store.stats().leases,1);
  }finally{control.finish();await client.close();}
});

test('verbatim worker routing keeps source/null plus original lease predecessors and cold admission',async t=>{
  const f=fixture(t),client=await f.open([row('x',0)]),payload={...client.identity,kind:PROFILE,
    projectionId:'finite-controller',operation:'target',_historyRootConsumerKey:f.consumerKey};
  const sourceKey=JSON.stringify([payload.sessionId,payload.cwd]),route=routeKeys(f.controller,'readHistoryRootPage',payload,sourceKey);
  assert.equal(sourceKey,'[null,null]');assert.equal(route.keys.length,2);assert.equal(route.keys[0],sourceKey);
  assert.equal(route.keys[1],JSON.stringify(['history-root-lease',f.controller.plane.generation,f.consumerKey,client.identity.leaseId]));
  assert.deepEqual(routeKeys(f.controller,'releaseHistoryRoot',payload,sourceKey).keys,[route.leaseKey]);
  assert.deepEqual(routeKeys(f.controller,'readHistoryRootPage',{...payload,ownerKey:'forged'},sourceKey).keys,[sourceKey]);
  assert.deepEqual(routeKeys(f.controller,'openHistoryRoot',{readProfile:PROFILE},sourceKey).keys,[sourceKey]);
  const fork={...client.identity,encoding:ENCODING,projectionId:'finite-controller',_historyRootConsumerKey:f.consumerKey};
  assert.deepEqual(routeKeys(f.controller,'forkHistoryRootLeaf',fork,sourceKey).keys,[route.leaseKey]);
  const child=await f.run('forkHistoryRootLeaf',fork),target={...child,kind:PROFILE,operation:'target',pass:0,
    projectionId:'finite-controller',_historyRootConsumerKey:f.consumerKey};
  const childRoute=routeKeys(f.controller,'readHistoryRootPage',target,sourceKey);
  assert.deepEqual(childRoute.keys,[childRoute.leaseKey]);
  assert.deepEqual(routeKeys(f.controller,'readHistoryRootPage',{...target,sessionId:'explicit'},'["explicit",null]').keys,
    ['["explicit",null]',childRoute.leaseKey],'explicit source scope retains joined ordering');
  await f.run('releaseHistoryRoot',child);
  const cold=createReadAdmission(),first=await cold.acquire(f.control);let admitted=false;
  const second=coldAdmission('openHistoryRoot',async()=>{const release=await cold.acquire(f.control);admitted=true;release();});
  await tick();assert.equal(admitted,false);assert.equal(cold.waiting,1);first();await second;assert.equal(admitted,true);
  await client.close();
});

test('verbatim worker enqueue preserves joined FIFO, failed predecessor and cancelled queued consumer',async()=>{
  const chains=new Map(),source='[null,null]',lease='held-lease',events=[];let releaseSource,releaseA;
  chains.set(source,new Promise(resolve=>{releaseSource=resolve;}));
  const control=createReadControl();
  const a=queueFor([source,lease],chains,async current=>{current.assertCurrent();events.push('a');await new Promise(resolve=>{releaseA=resolve;});})(control);
  const b=queueFor([lease],chains,async current=>{current.assertCurrent();events.push('b');})(control);
  const unrelated=queueFor(['other-lease'],chains,async current=>{current.assertCurrent();events.push('other');})(control);
  await unrelated;assert.deepEqual(events,['other']);releaseSource();await tick();assert.deepEqual(events,['other','a']);
  assert.equal(chains.get(lease),b,'old tail cannot erase the newer joined tail');releaseA();await Promise.all([a,b]);
  assert.deepEqual(events,['other','a','b']);await tick();assert.equal(chains.size,0);
  const rejected=Promise.reject(fail('HISTORY_READER_TRANSPORT_UNKNOWN'));rejected.catch(()=>{});chains.set(source,rejected);
  const abort=new AbortController(),cancelled=createReadControl({signal:abort.signal});
  const c=queueFor([source,lease],chains,async current=>{current.assertCurrent();events.push('cancelled-must-not-run');})(cancelled);
  abort.abort();await assert.rejects(c,{code:'HISTORY_READ_CONSUMER_REVOKED'});
  const d=queueFor([source,lease],chains,async current=>{current.assertCurrent();events.push('after-cancel');})(control);
  await d;await tick();assert.equal(events.at(-1),'after-cancel');assert.equal(chains.size,0);control.finish();cancelled.finish();
});

test('actual eager controller/plane module participates in unchanged worker implementation-byte freshness',()=>{
  const position=require.resolve('../src/main/history-root-engine/main/history-presentation-position');
  assert(Object.hasOwn(require.cache,position),'actual full controller require eagerly loaded position interpreter');
  const from=worker.indexOf("const schemaHash = crypto.createHash('sha256');"),tail="const sourceSchemaSHA256=schemaHash.digest('hex');";
  const to=worker.indexOf(tail,from);assert(from>=0&&to>from);const source=worker.slice(from,to+tail.length);
  const run=change=>{
    const scopedRequire=id=>require(id);scopedRequire.cache={...require.cache,[workerFile]:{}};
    const sourceFs={readFileSync(name,...args){const value=fs.readFileSync(name,...args);return change&&name===position
      ?Buffer.concat([Buffer.from(value),Buffer.from('\n// finite changed interpretation bytes\n')]):value;}};
    return new Function('crypto','fs','require','process','__dirname','__filename',source+
      '\nreturn {sourceSchemaSHA256,sourceModuleCount,workerSourceSHA256};')(crypto,sourceFs,scopedRequire,process,path.dirname(workerFile),workerFile);
  };
  const before=run(false),after=run(true);assert.notEqual(after.sourceSchemaSHA256,before.sourceSchemaSHA256);
  assert.equal(after.sourceModuleCount,before.sourceModuleCount);assert.equal(after.workerSourceSHA256,before.workerSourceSHA256);
});

function instrument(store){
  const fields=['sqlExecutions','sqlRunCalls','pageReads','pageWrites','vectorGets','vectorSets','transactions'];
  const zero=()=>Object.fromEntries(fields.map(key=>[key,0]));let total=zero(),interval=zero(),max=zero(),request=zero(),maxRequest=zero(),checkpoints=0,requests=0;
  const byMethod=Object.fromEntries(['forkHistoryRootLeaf','readHistoryRootPage','releaseHistoryRoot'].map(method=>
    [method,{requests:0,total:zero(),maxPerRequest:zero()}]));
  const originals={};const count=key=>{total[key]++;interval[key]++;request[key]++;};
  for(const [method,key]of [['read','pageReads'],['put','pageWrites'],['vectorGet','vectorGets'],['vectorSet','vectorSets'],['transaction','transactions']]){
    originals[method]=store[method];store[method]=function(...args){count(key);return originals[method].apply(this,args);};
  }
  originals.sql=store.sql;store.sql=function(...args){const statement=originals.sql.apply(this,args),wrapped={};
    for(const method of ['run','get','all','iterate'])if(typeof statement[method]==='function')wrapped[method]=(...values)=>{
      count('sqlExecutions');if(method==='run')count('sqlRunCalls');return statement[method](...values);};
    return wrapped;};
  const checkpoint=()=>{for(const key of fields)max[key]=Math.max(max[key],interval[key]);interval=zero();checkpoints++;};
  return {checkpoint,observeRequest(event,method){if(event==='start'){request=zero();requests++;}
    else {const group=byMethod[method];assert(group);group.requests++;
      for(const key of fields){maxRequest[key]=Math.max(maxRequest[key],request[key]);
        group.total[key]+=request[key];group.maxPerRequest[key]=Math.max(group.maxPerRequest[key],request[key]);}}},
    finish(){checkpoint();for(const key of Object.keys(originals))store[key]=originals[key];
    return {total,maxPerInProcessControlCheckpointOrSettlement:max,maxPerRequest:maxRequest,byMethod,requests,checkpoints:checkpoints-1};}};
}
test('actual full caller counters separate logical64 work from paged vector/read/SQL work',async t=>{
  const observations=[];
  for(const count of [8,80]){
    const f=fixture(t),key='q'.repeat(9000),rows=Array.from({length:count},(_,index)=>row(index===count-1?key:'finite-'+index,index));
    const client=await f.open(rows),visits=client.stats().recordVisits,metrics=instrument(f.store);
    f.observeRequest=metrics.observeRequest;
    f.control=createReadControl({schedule:async()=>{metrics.checkpoint();await tick();}});
    assert.deepEqual(await client.resolve(key),{kind:'found',index:count-1,memberIndex:-1});
    await tick(); // Counter boundary observes this fixture's completed raw cleanup ACK, not a product wait/retry.
    const work=metrics.finish();f.observeRequest=null;assert.equal(client.stats().recordVisits,visits,'a point query never re-enumerates imported rows');
    assert(f.queryMetrics.maxWorkPerTurn<=64);assert(f.queryMetrics.workCheckpoints>=1);
    assert.equal(work.total.pageWrites,0);assert.equal(work.total.vectorSets,0);
    assert.equal(f.queryMetrics.targetPageWrites,0);assert.equal(f.queryMetrics.nativeTargetChars,0);
    for(const method of ['forkHistoryRootLeaf','readHistoryRootPage']){
      assert.equal(work.byMethod[method].total.sqlRunCalls,0);assert.equal(work.byMethod[method].total.transactions,0);
    }
    assert(work.total.sqlExecutions>64,'64 logical work is not a64SQL or CPU claim');
    observations.push({units:count,uuidUTF16:key.length,query:f.queryMetrics,actualCaller:work});await client.close();
  }
  // The in-process router does not execute worker pre/post-request checkpoints;
  // per-request maxima bound this fixture's actual controller/store work. SQL
  // and page counters are invocation counts, neither CPU nor process/native
  // memory. Registration is a separate N traversal, retained as OPEN cost.
  t.diagnostic('POSITION_ACTUAL_WORK '+JSON.stringify(observations));
});

function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function finite(promise,label){let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>{
  timer=setTimeout(()=>reject(fail('FINITE_'+label+'_DEADLINE')),3000);})]);}finally{clearTimeout(timer);}}

test('PUBLIC held position settles through actual worker routing while named and null canonical gates remain held',async t=>{
  for(const named of [true,false]){
    const f=fixture(t,{routed:true}),key='hidden \0\ud800😀 '+'ж\udc00'.repeat(2100),client=await f.open([row(key,0)]);
    const entered=gate(),blocked=gate();let canonical,registration;
    f.controller.physicalScope=async()=>{entered.resolve();await blocked.promise;return {success:false,error:'FINITE_CANONICAL_UNAVAILABLE'};};
    try{
      canonical=f.run('openHistoryRoot',{toolType:'codex',readProfile:'history-primary-v1',...(named?{sessionId:'finite-source',cwd:'/finite'}:{})});
      await finite(entered.promise,'CANONICAL_GATE');assert.equal(f.controller.maintenanceAdmission.active,true);
      let registrationDone=false;
      registration=f.open([row('future-position',0)],{projectionId:'future-position'}).then(value=>{registrationDone=true;return value;});
      for(let n=0;n<4;n++)await tick();assert.equal(registrationDone,false,'first registration preserves cold/allocation admission');
      const answer=await finite(client.resolve(key),'PUBLIC_POSITION_WHILE_GATE_HELD');
      assert.deepEqual(answer,{kind:'found',index:0,memberIndex:-1});
      assert.equal(f.controller.maintenanceAdmission.active,true,'unrelated canonical gate is still held at public settlement');
      assert.equal(registrationDone,false);assert.equal(f.controller.maintenanceAdmission.waiting,0,'held read never joins maintenance');
      assert.equal(f.sourceCalls(),0);assert.equal(f.store.stats().activeBuilders,0);
      t.diagnostic('HELD_POSITION_GATE '+JSON.stringify({canonicalScope:named?'named':'null',heldQuery:'found',
        gateStillHeld:true,registrationStillPending:true,maintenanceReadWaiters:0,uuidUTF16:key.length}));
    }finally{
      blocked.resolve();const unavailable=await canonical;
      assert.equal(unavailable.success,false);assert.equal(unavailable.error,'FINITE_CANONICAL_UNAVAILABLE');
      const next=await registration;
      assert.deepEqual(await next.resolve('future-position'),{kind:'found',index:0,memberIndex:-1},
        'first registration completes after explicit canonical UNAVAILABLE without a future ready Root');
      assert.equal(f.sourceCalls(),0);await next.close();await client.close();
    }
  }
});

test('cancelled first registration removes its actual cold admission waiter while held positions remain usable',async t=>{
  const {readHistoryThroughIpc}=await import('../src/renderer/utils/historyReadTransport.mjs');
  const f=fixture(t,{routed:true}),client=await f.open([row('retained',0)]),entered=gate(),blocked=gate();let canonical;
  f.controller.physicalScope=async()=>{entered.resolve();await blocked.promise;return {success:false,error:'FINITE_CANONICAL_UNAVAILABLE'};};
  try{
    canonical=f.run('openHistoryRoot',{toolType:'codex',sessionId:'held-cold',cwd:'/finite',readProfile:'history-primary-v1'});
    await finite(entered.promise,'COLD_GATE');const abort=new AbortController();
    const queued=f.open([row('never-admitted',0)],{projectionId:'cancel-first-registration',signal:abort.signal,readThroughIpc:readHistoryThroughIpc});
    for(let n=0;n<4;n++)await tick();assert.equal(f.cold.waiting,1);
    abort.abort();await assert.rejects(finite(queued,'COLD_CANCEL'),{code:'HISTORY_READ_CANCELLED'});await tick();
    assert.equal(f.cold.waiting,0);assert.equal(f.controller.maintenanceAdmission.waiting,0);
    assert.equal(f.controller.plane.stats().roots,1);assert.equal(f.store.stats().leases,1);assert.equal(f.store.stats().activeBuilders,0);
    assert.equal(f.demands.size,0);assert.equal(f.controller.maintenanceAdmission.active,true);
    assert.deepEqual(await client.resolve('retained'),{kind:'found',index:0,memberIndex:-1});
    assert.equal(f.controller.maintenanceAdmission.active,true);
  }finally{blocked.resolve();const result=await canonical;assert.equal(result.error,'FINITE_CANONICAL_UNAVAILABLE');await client.close();}
});

test('PUBLIC held position remains read-only during actual initial full collection without resetting its mark',async t=>{
  const f=fixture(t,{routed:true}),plane=f.controller.ensurePlane();
  const {openHistoryPresentationPosition}=await import('../src/shared/history-root-read-client.mjs');
  // Synthetic seed boundary: an injected already-owned store/plane holds its
  // sealed position before this controller's FIRST initializeBacking. All
  // subsequent demand/routing/GC/query paths are actual public components.
  let seeding=true;
  const invoke=(channel,payload)=>{
    if(!seeding)return f.invoke(channel,payload);
    const options={consumerKey:f.consumerKey,control:f.control};
    if(channel==='agent-transcript:get-history')return plane.openPosition(payload,options);
    if(channel==='agent-transcript:read-page')return plane.readPage(payload,options);
    if(channel==='agent-transcript:release-read-root')return plane.release(payload,options);
    throw fail('FINITE_SEED_CHANNEL');
  };
  const records=Array.from({length:80},(_,i)=>row('held-'+i,i));
  const client=await openHistoryPresentationPosition(invoke,{projectionId:'finite-controller',unitCount:80,records});seeding=false;
  assert.equal(f.controller.initializedBacking,false);assert.equal(f.store.stats().activeBuilders,0);
  const entered=gate(),blocked=gate();let held=false,canonical;
  const gcControl=createReadControl({schedule:async()=>{if(!held&&f.controller.fullCollectionDepth){held=true;entered.resolve();await blocked.promise;}else await tick();}});
  f.controller.physicalScope=async()=>({success:false,error:'FINITE_AFTER_INITIAL_GC'});
  try{
    canonical=f.run('openHistoryRoot',{toolType:'codex',sessionId:'initial-source',cwd:'/finite',readProfile:'history-primary-v1'},{control:gcControl});
    await finite(entered.promise,'INITIAL_GC');assert.equal(f.controller.initializedBacking,false);assert.equal(f.controller.fullCollectionDepth,1);
    const epoch=f.store.sql("SELECT value FROM hp_meta WHERE key='gc_epoch'").get().value;
    const pins=f.store.db.prepare('SELECT name,page FROM hp_pins ORDER BY name').all();
    assert.deepEqual(await finite(client.resolve('held-79'),'PUBLIC_POSITION_DURING_INITIAL_GC'),{kind:'found',index:79,memberIndex:-1});
    assert.equal(f.controller.initializedBacking,false);assert.equal(f.controller.fullCollectionDepth,1);
    assert.equal(f.store.sql("SELECT value FROM hp_meta WHERE key='gc_epoch'").get().value,epoch);
    assert.notEqual(f.store.sql("SELECT value FROM hp_meta WHERE key='gc_phase'").get().value,0);
    assert.deepEqual(f.store.db.prepare('SELECT name,page FROM hp_pins ORDER BY name').all(),pins);
    assert.equal(f.store.stats().activeBuilders,0);
  }finally{blocked.resolve();await canonical;gcControl.finish();await client.close();}
  assert.equal(f.controller.initializedBacking,true);
});

test('read-only held lookup preserves full-quota access and original source/cancellation control without collateral release',async t=>{
  const f=fixture(t,{routed:true}),key='q'.repeat(9000),client=await f.open([row(key,0)]),checkDisk=f.store.checkDisk;
  let quotaChecks=0;
  f.store.checkDisk=()=>{quotaChecks++;throw fail('HISTORY_BACKING_FULL');};
  try{assert.deepEqual(await client.resolve(key),{kind:'found',index:0,memberIndex:-1});}
  finally{f.store.checkDisk=checkDisk;}
  assert(quotaChecks<=1,'only original release cleanup may attempt its bounded collection/quota transaction');
  for(const errorCode of ['HISTORY_READ_CONSUMER_REVOKED','CODEX_SOURCE_READ_INVALIDATED']){
    let invalid=false,checkpoints=0;
    const original=f.control;f.control=createReadControl({assertSourceCurrent(){if(invalid)throw fail(errorCode);},
      async schedule(){checkpoints++;invalid=true;await tick();}});
    try{await assert.rejects(client.resolve(key),{code:errorCode});assert.equal(checkpoints,1);}
    finally{f.control.finish();f.control=original;}
    assert.equal(f.controller.plane.stats().roots,1);assert.equal(f.store.stats().leases,1);
    assert.deepEqual(await client.resolve(key),{kind:'found',index:0,memberIndex:-1});
  }
  await client.close();
});
