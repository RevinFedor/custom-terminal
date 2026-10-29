'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/continuation-first-input-flow.cjs');
// PRE consumers receive the SAME actual Main proof facts. Their old gates
// reject before the sender; no alternate ready:true/canSubmit fake is used.
for(const agent of [false,true])test((agent?'agent':'local Build')+': provisional ready/unconfirmed writer crosses existing FIFO, Main authority and ONE guarded input',async t=>{
 const h=await fixture(t,{agent});
 const before=h.rawResponse();assert.equal(before.busy,null);assert.equal(before.transitioning,true);
 const input=await h.readState('T');assert.equal(input.busy,null);assert.equal(input.transitioning,true);
 await h.activate();
 assert.equal(h.writes.filter(s=>s==='\r').length,1,JSON.stringify({target:h.target(),calls:h.calls,logs:h.logs}));
 assert.equal(h.calls.bridge,1);assert.equal(h.calls.preparation,1);
 const record=h.record();assert.equal(record.state,'confirmed');assert.equal(record.receipt.exactAuditConfirmed,true);
 assert.equal(record.attemptId,h.calls.requests[0].sendAttemptId);assert.equal(record.handoffId,h.calls.requests[0].handoffId);
 assert.equal(record.receipt.preflightScope.continuationInputFence.mode,'provisional-resume');
 assert.equal(h.target().state,'confirmed',JSON.stringify(h.target()));
 assert.equal(h.control.writer,null,'read-only admission never adopted a writer');
 await h.operation.reconcile('first-continue-operation');assert.equal(h.calls.bridge,1);
 if(agent)assert.equal((await h.runs.getInternal('R')).targetExecutionContext.turnId,h.next.turnId);
});
test('actual latest-execution history gate accepts the SAME private input proof but never publishes response idle',async t=>{
 const h=await fixture(t),result=await h.readLatest();
 assert.equal(result.result?.sourceVerified,true,JSON.stringify(result));
 assert.equal(result.subject.targetExecutionContext.turnId,h.old.turnId);
 assert.equal(h.rawResponse().busy,null);assert.equal(h.rawResponse().transitioning,true);
 assert.equal(h.writes.length,0);
});
