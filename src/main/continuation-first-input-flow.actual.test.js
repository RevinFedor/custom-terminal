'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/continuation-first-input-flow.cjs');

for(const agent of [false,true])for(const stage of ['pre-enqueue','HEAD','bridge','during-prepare']){
 for(const change of ['input','stop','owner'])test((agent?'agent':'Build')+' '+stage+' '+change+' never writes a late Continue',async t=>{
  const h=await fixture(t,{agent});let fired=false;
  const mutate=async()=>{if(fired)return;fired=true;h.change(change);h.controls.revision+='changed';
   if(change==='input')h.controls.latest={...h.old,turnId:'manual-new-task'};};
  if(stage==='pre-enqueue')h.controls.beforeOriginal=mutate;
  if(stage==='HEAD')h.controls.beforePrepare=mutate;
  if(stage==='bridge')h.controls.beforeBridge=mutate;
  if(stage==='during-prepare')h.controls.beforePrepare=async()=>{h.control.processRead=mutate;};
  await h.activate();assert.equal(fired,true);
  assert.equal(h.writes.length,0,JSON.stringify({target:h.target(),logs:h.logs}));
  if(stage==='pre-enqueue')assert.equal(h.calls.bridge,0);
  if(stage==='bridge')assert.equal(h.calls.bridge,1);
 });
}
for(const kind of ['draft','frame','Goal','background','unknown-process','unknown-original','unknown-latest','foreign-source']){
 test('Build preserves pending/foreign '+kind+' without an attempted Continue',async t=>{
  const h=await fixture(t);
  if(kind==='draft')h.frame(true);
  if(kind==='frame')h.control.frame=false;
  if(kind==='Goal')h.controls.goal={pending:true,status:'active'};
  if(kind==='background')h.controls.background=1;
  if(kind==='unknown-process')h.control.process='unknown';
  if(kind==='unknown-original')h.controls.originalUnknown=true;
  if(kind==='unknown-latest')h.controls.intervalUnknown=true;
  if(kind==='foreign-source')h.intent.sourceSessionId='foreign';
  await h.activate();assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,0);
  assert.ok(!h.record()?.attemptId);assert.equal(h.target().state,'pending');
 });
}
for(const agent of [false,true])test((agent?'agent':'Build')+' original natural final consumes no input',async t=>{
 const h=await fixture(t,{agent});h.controls.originalComplete=true;await h.activate();
 assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,0);assert.equal(h.target().state,'result-ready');
});
for(const agent of [false,true])test((agent?'agent':'Build')+' canonical/source latest proof changes during await: no automatic input',async t=>{
 const h=await fixture(t,{agent});let fired=false;h.controls.beforeLatest=async()=>{if(fired)return;fired=true;
  h.controls.revision+='later';h.controls.latest={...h.old,turnId:'independent-natural-final'};};
 await h.activate();assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,0);
});
test('agent source party changes during original proof: no target input',async t=>{
 const h=await fixture(t,{agent:true});h.controls.beforeOriginal=async()=>{h.controls.parentSession='foreign-parent';h.controls.parentRevision='new';};
 await h.activate();assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,0);
});
test('actual reserved input revision is allowed only for this writer, not a later manual input during drain',async t=>{
 const h=await fixture(t);let changed=false;
 h.c.drainPtyData=async()=>{if(changed)return;changed=true;h.change('input');};
 await h.activate();assert.equal(changed,true);assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,1);
});
test('user cancellation before admission is durable and does not revive at activation',async t=>{
 const h=await fixture(t);const target=h.target();
 await h.operation.cancelTarget('first-continue-operation',{tabId:'T',handoffId:target.handoffId,operationKey:target.operationKey,requestId:'cancel-before-activate'});
 await h.activate();assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,0);assert.equal(h.target().state,'cancelled');
});
test('cancel while HEAD is preparing stops current and every later wake without a second H/O',async t=>{
 const h=await fixture(t);let cancelled=false;h.controls.beforePrepare=async()=>{if(cancelled)return;cancelled=true;const target=h.target();
  await h.operation.cancelTarget('first-continue-operation',{tabId:'T',handoffId:target.handoffId,operationKey:target.operationKey,requestId:'cancel-during-head'});};
 await h.activate();assert.equal(h.writes.length,0);assert.equal(h.calls.bridge,0);
 await h.operation.reconcile('first-continue-operation');assert.equal(h.writes.length,0);
});
for(const agent of [false,true])test((agent?'agent':'Build')+' lost ACK retains same attempted H/O; exact late audit, not another Enter, closes it',async t=>{
 const h=await fixture(t,{agent});h.controls.audit=false;h.controls.loseAck=true;
 await h.activate();const record=h.record();assert.equal(h.writes.filter(x=>x==='\r').length,1,JSON.stringify(h.logs));
 assert.ok(record.attemptId);assert.notEqual(record.state,'confirmed');
 await h.operation.reconcile('first-continue-operation');assert.equal(h.calls.bridge,1);
 assert.equal(h.record().attemptId,record.attemptId);assert.equal(h.audit(record).promoted,true);
 if(agent)await h.continuation.reconcile('R');await h.operation.reconcile('first-continue-operation');
 assert.equal(h.target().state,'confirmed');assert.equal(h.calls.bridge,1);
});
test('unresolved predecessor retains FIFO; new continuation has ONE waiting immutable item and no attempt',async t=>{
 const h=await fixture(t);
 const request={tabId:'T',provider:'codex',handoffId:'old-unknown',source:'history-panel',prompt:'older immutable',
  expectedTarget:{toolType:'codex',sessionId:'source'}};
 const identity={operationKey:'history:T:old-unknown',surface:'desktop-history',tabId:'T',provider:'codex',sessionId:'source',
  handoffId:request.handoffId,requestFingerprint:'old-fingerprint',promptHash:'older-hash',promptLength:15};
 h.queue.enqueue({identity,request});const begun=h.store.beginAttempt(identity);
 h.store.settleAttempt(identity.operationKey,begun.attemptId,{submitted:true,deliveryUnknown:true});
 h.queue.db.prepare("UPDATE agent_send_queue SET state='awaiting-receipt' WHERE operation_key=?").run(identity.operationKey);
 await h.activate();assert.equal(h.calls.bridge,0);assert.equal(h.writes.length,0);
 assert.equal(h.queue.item(h.target().operationKey).state,'waiting');assert.ok(!h.record().attemptId);
 assert.equal(h.store.get(identity.operationKey).attemptId,begun.attemptId);
});

for(const agent of [false,true])test((agent?'agent':'Build')+' real SQLite/service reopen after unknown ACK cannot allocate another input attempt',async t=>{
 const h=await fixture(t,{agent});h.controls.audit=false;h.controls.loseAck=true;await h.activate();
 const original=h.record();assert.ok(original.attemptId);assert.equal(h.calls.bridge,1);
 await h.reopen();assert.equal(h.calls.bridge,1);assert.equal(h.record().attemptId,original.attemptId);
 assert.equal(h.audit(h.record()).promoted,true);
 if(agent)await h.continuation.reconcile('R');await h.operation.reconcile('first-continue-operation');
 assert.equal(h.target().state,'confirmed');assert.equal(h.calls.bridge,1);
});
test('ready-return await reserves original callback in the existing FIFO before the automatic continuation',async t=>{
 const h=await fixture(t);let reserved=false;h.controls.queueReady=false;
 h.controls.returns=async()=>{await Promise.resolve();if(reserved)return;reserved=true;
  const request={tabId:'T',provider:'codex',handoffId:'old-callback',source:'history-panel',prompt:'original callback'};
  h.queue.enqueue({identity:{operationKey:'history:T:old-callback',surface:'desktop-history',tabId:'T',provider:'codex',
   handoffId:'old-callback',requestFingerprint:'callback',promptHash:'callback',promptLength:17},request});};
 await h.activate();assert.equal(reserved,true);assert.equal(h.calls.bridge,0);
 const rows=h.queue.db.prepare('SELECT operation_key,state FROM agent_send_queue ORDER BY id').all();
 assert.equal(rows[0].operation_key,'history:T:old-callback');assert.equal(rows[1].operation_key,h.target().operationKey);
 assert.equal(h.writes.length,0);
});
for(const agent of [false,true])for(const unknown of ['original','latest'])test((agent?'agent':'Build')+' unknown '+unknown+' proof retains pending without creating an input',async t=>{
 const h=await fixture(t,{agent});h.controls[unknown==='original'?'originalUnknown':'intervalUnknown']=true;
 await h.activate();assert.equal(h.calls.bridge,0);assert.equal(h.writes.length,0);
 assert.equal(h.target().state,'pending');assert.ok(!h.record()?.attemptId);
});
for(const agent of [false,true])test((agent?'agent':'Build')+' HEAD unknown proof parks the SAME FIFO item; later proof uses ONE H/O',async t=>{
 const h=await fixture(t,{agent});let once=false;
 h.controls.beforeAdmit=async()=>{if(once)return;once=true;h.controls.originalUnknown=true;};
 await h.activate();const key=h.target().operationKey,item=h.queue.item(key);
 assert.equal(item.state,'waiting');assert.ok(!h.record().attemptId);assert.equal(h.writes.length,0);
 h.controls.originalUnknown=false;h.queue.wake('T');
 for(let i=0;i<16;i++)await new Promise(resolve=>setImmediate(resolve));
 if(agent)await h.continuation.reconcile('R');await h.operation.reconcile('first-continue-operation');
 assert.equal(h.queue.item(key).id,item.id);assert.equal(h.calls.bridge,1,JSON.stringify({target:h.target(),logs:h.logs}));
 assert.equal(h.writes.filter(x=>x==='\r').length,1);assert.equal(h.target().state,'confirmed');
});
for(const agent of [false,true])test((agent?'agent':'Build')+' existing readiness event wakes pending provisional input, not a retry timer',async t=>{
 const h=await fixture(t,{agent});h.control.ready=false;await h.activate();assert.equal(h.calls.bridge,0);
 h.control.ready=true;await h.readinessEvent();assert.equal(h.calls.bridge,1,JSON.stringify(h.target()));
 assert.equal(h.writes.filter(x=>x==='\r').length,1);assert.equal(h.target().state,'confirmed');
});
for(const agent of [false,true])test((agent?'agent':'Build')+' natural final appearing on HEAD is not revived as Continue',async t=>{
 const h=await fixture(t,{agent});h.controls.beforePrepare=async()=>{h.controls.originalComplete=true;};
 await h.activate();assert.equal(h.calls.bridge,0);assert.equal(h.writes.length,0);
 await h.operation.reconcile('first-continue-operation');assert.equal(h.writes.length,0);
});
for(const manual of [false,true])test('provisional -> confirmed writer at HEAD retains the pinned input fence; manual='+manual,async t=>{
 const h=await fixture(t);h.controls.beforePrepare=async()=>{
  h.control.writer={sessionId:'source',launchId:'launch-T',terminalToken:h.term,runSeq:1,lifecycleGeneration:'L1',pids:[7]};
  h.controls.responseBusy=false;h.controls.transitioning=false;h.controls.revision='writer-confirmed';};
 if(manual)h.controls.beforeBridge=async()=>h.change('input');
 await h.activate();assert.equal(h.calls.bridge,1,JSON.stringify({target:h.target(),logs:h.logs}));
 assert.equal(h.writes.filter(x=>x==='\r').length,manual?0:1);
 assert.equal(h.record().receipt.preflightScope.continuationInputFence.mode,'writer');
});
