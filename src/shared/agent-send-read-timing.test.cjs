'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAgentSendReadTiming,observeAgentSendReadTiming,normalizeReadTiming,MAX_READS,MAX_EVENTS}=require('./agent-send-read-timing.cjs');
const tuple={tabId:'tab-A',operationKey:'history:tab-A:handoff',attemptId:'attempt-A',handoffId:'handoff-A'};
test('known Main-body and reply-delay clocks stay distinct without changing a result or calling the operation twice',async()=>{
  let clock=100,calls=0,release;const rows=[],emit=row=>rows.push(row),now=()=>clock;
  const trace=createAgentSendReadTiming({...tuple,emit,now}),ctx=trace.start('final-presence');
  clock=120;
  const pending=new Promise(resolve=>release=resolve);
  const actual=observeAgentSendReadTiming(ctx,'tab-A',()=>{calls++;return pending;},{emit,now});
  assert.equal(actual,pending);clock=127;release({inputReady:true,content:'not diagnostic data'});await pending;
  clock=1470;trace.end(ctx,{inputReady:true});
  assert.deepEqual(rows.map(r=>[r.phase,r.abs]),[['renderer-invoke',100],['main-enter',120],['main-return',127],['renderer-resume',1470]]);
  assert.equal(calls,1);assert.ok(rows.every(r=>r.operationKey===tuple.operationKey&&r.attemptId===tuple.attemptId));
  assert.ok(rows.every(r=>!Object.hasOwn(r,'content')));
});
test('same synchronous throw and rejected promise retain their identity even with throwing clocks/loggers',async()=>{
  const error=Error('same error'),broken={emit(){throw Error('log');},now(){throw Error('clock');}};
  const trace=createAgentSendReadTiming({...tuple,...broken}),ctx=trace.start('composer-prepare');
  assert.throws(()=>observeAgentSendReadTiming(ctx,tuple.tabId,()=>{throw error;},broken),e=>e===error);
  const promise=Promise.reject(error);assert.equal(observeAgentSendReadTiming(ctx,tuple.tabId,()=>promise,broken),promise);
  await assert.rejects(promise,e=>e===error);trace.end(ctx,null,true);
});
test('malformed identity and cross-tab caller hints cannot label unrelated Main work or suppress it',()=>{
  const trace=createAgentSendReadTiming({...tuple,emit(){}}),good=trace.start('wait-presence');
  for(const bad of [null,{...good,tabId:'tab-B'},{...good,ordinal:13},{...good,stage:'prompt-text'},
    {...good,operationKey:'secret\nbody'},{...good,callerAbs:Infinity,attemptId:{toString(){throw Error('no');}}}]){
    let calls=0;const logs=[];const value={same:true};
    assert.equal(observeAgentSendReadTiming(bad,tuple.tabId,()=>{calls++;return value;},{emit:r=>logs.push(r)}),value);
    assert.equal(calls,1);assert.deepEqual(logs,[]);
  }
});
test('fixed attempt budgets survive repeated ready events and cap overlong retry loops without adding timers',()=>{
  const rows=[],trace=createAgentSendReadTiming({...tuple,emit:r=>rows.push(r),now:()=>1});
  for(let i=0;i<1000;i++){const c=trace.start('wait-presence');trace.end(c,{});trace.event('ready-handler',{eventTs:42});}
  assert.equal(rows.filter(r=>r.phase==='renderer-invoke').length,MAX_READS);
  assert.equal(rows.filter(r=>r.phase==='renderer-resume').length,MAX_READS);
  assert.equal(rows.filter(r=>r.phase==='ready-handler').length,MAX_EVENTS);
  assert.equal(rows.filter(r=>r.phase==='observation-omitted').length,1);
  assert.ok(rows.every(r=>Buffer.byteLength(JSON.stringify(r))<2048));
});
test('no admitted attempt means no allocation of a timing context and no logger calls',()=>{
  const rows=[],trace=createAgentSendReadTiming({tabId:'tab-A',emit:r=>rows.push(r)});
  assert.equal(trace.start('initial-presence'),null);trace.event('ready-handler',{});trace.end(null,{});
  assert.deepEqual(rows,[]);
});
test('late completion from another attempt cannot be published under this attempt',()=>{
  const rows=[],trace=createAgentSendReadTiming({...tuple,emit:r=>rows.push(r)});
  const foreign=createAgentSendReadTiming({...tuple,attemptId:'other',emit(){}}).start('final-presence');
  trace.end(foreign,{});assert.deepEqual(rows,[]);
});
test('duplicate, cloned and never-issued completion hints do not exceed one outcome per actual read',()=>{
  const rows=[],trace=createAgentSendReadTiming({...tuple,emit:r=>rows.push(r)}),context=trace.start('final-presence');
  trace.end({...context},{});trace.end({...context,ordinal:2},{});
  for(let i=0;i<1000;i++)trace.end(context,{},i%2===0);
  assert.equal(rows.length,2);assert.equal(rows[1].phase,'renderer-reject');
});
test('retirement suppresses all late callbacks without resolving, rejecting or renewing the original work',()=>{
  const rows=[],trace=createAgentSendReadTiming({...tuple,emit:r=>rows.push(r)}),context=trace.start('wait-presence');
  trace.close();trace.end(context,{});trace.event('ready-handler',{});
  assert.equal(trace.start('initial-presence'),null);assert.equal(rows.length,1);
});
test('an arbitrary thenable is not executed by the observer and retains the same business object',()=>{
  const rows=[],trace=createAgentSendReadTiming({...tuple,emit(){}}),context=trace.start('composer-prepare');
  let calls=0;const value={then(resolve,reject){calls++;resolve({inputWritten:false});reject(Error('late'));}};
  assert.equal(observeAgentSendReadTiming(context,tuple.tabId,()=>value,{emit:r=>rows.push(r)}),value);
  assert.equal(calls,0);assert.deepEqual(rows.map(r=>r.phase),['main-enter','main-return']);
});
test('only explicit scalar fields are observed; arbitrary result getters and hostile then getters never change business values',()=>{
  const trace=createAgentSendReadTiming({...tuple,emit(){}}),ctx=trace.start('composer-prepare');
  const value={get then(){throw Error('getter');},get inputWritten(){throw Error('getter');}};
  assert.equal(observeAgentSendReadTiming(ctx,tuple.tabId,()=>value,{emit(){throw Error('logger');}}),value);
  trace.end(ctx,value);assert.equal(normalizeReadTiming(ctx,tuple.tabId).stage,'composer-prepare');
});
