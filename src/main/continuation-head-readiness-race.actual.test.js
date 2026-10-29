'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/continuation-first-input-flow.cjs');
const flush = async () => { for (let i=0;i<20;i++) await new Promise(resolve=>setImmediate(resolve)); };

for (const agent of [false, true]) {
  test((agent ? 'agent' : 'Build') + ': transient proof AFTER FIFO admission keeps the same unattempted HEAD', async t => {
    const h = await fixture(t, {agent});
    let changed = false;
    h.controls.beforePrepare = async () => {
      if (changed) return;
      changed = true;
      h.controls.originalUnknown = true;
    };
    await h.activate();
    const key = h.target().operationKey, item = h.queue.item(key);
    assert.equal(item.state, 'waiting', JSON.stringify({record:h.record(),target:h.target()}));
    assert.equal(h.record().attemptId, null);
    assert.equal(h.record().state, 'preparing');
    assert.equal(h.writes.length, 0);
    const fingerprint = item.request_hash;
    const count = h.calls.preparation;
    await flush();
    assert.equal(h.calls.preparation, count, 'publication must not self-pump a pending proof');
    h.controls.originalUnknown = false;
    h.queue.notifyRuntime('T');
    await flush();
    if (agent) await h.continuation.reconcile('R');
    await h.operation.reconcile('first-continue-operation');
    assert.equal(h.queue.item(key).id, item.id);
    assert.equal(h.queue.item(key).request_hash, fingerprint);
    assert.equal(h.calls.bridge, 1);
    assert.equal(h.writes.filter(bytes=>bytes==='\r').length, 1);
    assert.equal(h.record().state, 'confirmed');
  });
}

for (const stop of [false, true]) {
  test('Build deferred HEAD never revives after ' + (stop ? 'Stop' : 'a later natural result'), async t => {
    const h = await fixture(t);
    h.controls.beforePrepare = async () => { h.controls.originalUnknown = true; };
    await h.activate();
    assert.equal(h.queue.item(h.target().operationKey).state, 'waiting');
    h.controls.beforePrepare = null;
    h.controls.originalUnknown = false;
    if (stop) h.change('stop'); else h.controls.originalComplete = true;
    h.queue.notifyRuntime('T'); await flush();
    await h.operation.reconcile('first-continue-operation');
    assert.equal(h.calls.bridge, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.record().attemptId, null);
  });
}

test('deferred no-attempt Build survives actual SQLite reopen and starts only its original H/O',async t=>{
 const h=await fixture(t);let once=false;
 h.controls.beforePrepare=async()=>{if(!once){once=true;h.controls.originalUnknown=true;}};
 await h.activate();const key=h.target().operationKey,item=h.queue.item(key);
 assert.equal(item.state,'waiting');assert.equal(h.record().attemptId,null);
 await h.reopen();assert.equal(h.record().attemptId,null);assert.equal(h.writes.length,0);
 h.controls.originalUnknown=false;h.queue.resume();await flush();
 await h.operation.reconcile('first-continue-operation');
 assert.equal(h.queue.item(key).id,item.id);assert.equal(h.calls.bridge,1);
 assert.equal(h.writes.filter(bytes=>bytes==='\r').length,1);assert.equal(h.target().state,'confirmed');
});

for(const kind of ['source-replaced','provider-replaced','cancelled'])test('agent HEAD after history await: '+kind+' is not a transient readiness wait',async t=>{
 const h=await fixture(t,{agent:true});let changed=false;
 h.controls.beforePrepare=async()=>{
  h.controls.beforeLatest=async()=>{
   if(changed)return;changed=true;h.controls.beforeLatest=null;
   if(kind==='source-replaced')h.controls.parentSession='foreign-source';
   else if(kind==='provider-replaced')h.control.provider='claude';
   else {const r=h.store.get((await h.runs.getInternal('R')).continuationIntent.operationKey);assert.equal(h.store.cancelDelivery({operationKey:r.operationKey,
    tabId:r.tabId,handoffId:r.handoffId,attemptId:null,reason:'manual-stop'}).ok,true);}
  };
 };
 await h.activate();await flush();
 assert.equal(changed,true);assert.equal(h.calls.bridge,0);assert.equal(h.writes.length,0);
 assert.equal(h.record().attemptId,null);assert.equal(h.record().state,'not-submitted');
 assert.notEqual(h.queue.item(h.target().operationKey).state,'waiting');
});

for(const field of ['submitted','pasteWritten','enterWritten','deliveryUnknown'])test('pre-attempt expiry cannot overwrite later '+field+' uncertainty',async t=>{
 const h=await fixture(t);h.controls.beforePrepare=async()=>{h.controls.originalUnknown=true;};
 await h.activate();const key=h.target().operationKey;
 assert.equal(h.record().attemptId,null);assert.equal(h.record().state,'preparing');
 assert.equal(h.store.stageQueuedRequest(key,{[field]:true}).ok,true);
 h.clock.advance(120000);await flush();
 assert.equal(h.record().state,'preparing');assert.equal(h.record().receipt[field],true);
 assert.equal(h.calls.bridge,0);assert.equal(h.writes.length,0);
});
