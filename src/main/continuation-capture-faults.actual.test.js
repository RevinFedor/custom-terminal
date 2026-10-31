'use strict';

// Finite private SQLite fixtures execute the actual Main continuation authorizer,
// Web sender and FIFO/receipt owners. No live terminal or provider is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/continuation-first-input-flow.cjs');
const { deferSendPreparation } = require('./agent-send-preparation');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const noInput = h => { assert.equal(h.calls.bridge, 0); assert.deepEqual(h.writes, []); assert.equal(h.record().attemptId, null); };
const oneEnter = h => { assert.equal(h.calls.bridge, 1); assert.equal(h.writes.filter(value => value === '\r').length, 1); };
const wake = async h => { h.queue.notifyRuntime('T'); await flush(); };

function faultFirstStage(h, field, afterCommit = false) {
  const stage = h.store.stageQueuedRequest.bind(h.store);
  let captured = null;
  h.store.stageQueuedRequest = (...args) => {
    if (args[1]?.[field] && !captured) {
      captured = JSON.parse(JSON.stringify(args[1][field]));
      if (afterCommit) assert.equal(stage(...args).ok, true);
      throw Object.assign(Error('controlled SQLite boundary'), { code: 'SQLITE_BUSY' });
    }
    return stage(...args);
  };
  return () => captured;
}

for (const agent of [false, true]) {
  const label = agent ? 'agent' : 'Build';
  for (const change of ['input', 'stop', 'terminal', 'conversation-owner']) {
    test(`${label} first-hold BUSY retains the original fence across ${change}`, async t => {
      const h = await fixture(t, { agent }), first = faultFirstStage(h, 'continuationInputHold');
      await h.activate(); const key = h.target().operationKey, item = h.queue.item(key), before = h.record();
      assert.ok(first()); assert.equal(item.state, 'waiting'); assert.ok(before.receipt.continuationInputCapture);
      assert.equal(before.receipt.continuationInputHold, undefined); noInput(h);
      if (change === 'terminal') h.change('owner');
      else if (change === 'conversation-owner') h.owner.ownerToken = 'foreign-owner';
      else h.change(change);
      await wake(h); noInput(h);
      const after = h.record();
      assert.deepEqual(after.receipt.continuationInputHold, first());
      assert.equal(h.queue.item(key).id, item.id); assert.equal(h.queue.item(key).request_hash, item.request_hash);
      assert.equal(after.receipt.activeHeadPreparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
      assert.notEqual(after.state, 'confirmed');
    });
  }

  test(`${label} first-hold BUSY with unchanged input retries the same fence and sends once`, async t => {
    const h = await fixture(t, { agent }), first = faultFirstStage(h, 'continuationInputHold');
    await h.activate(); const item = h.queue.item(h.target().operationKey), before = h.record();
    assert.ok(first()); noInput(h); await wake(h); oneEnter(h);
    const after = h.record();
    assert.equal(h.queue.item(item.operation_key).id, item.id);
    assert.deepEqual(after.receipt.preflightScope.continuationInputOriginalFence, first().fence);
    assert.equal(after.receipt.preflightScope.preparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
    assert.equal(h.store.continuationCaptures.size, 0);
  });

  test(`${label} transient before a returned fence clears only its completed marker and retries`, async t => {
    const h = await fixture(t, { agent }); let once = false;
    h.controls.beforePrepare = async () => { if (!once) { once = true; throw deferSendPreparation('controlled_before_fence'); } };
    await h.activate(); const key = h.target().operationKey, before = h.record();
    assert.equal(h.queue.item(key).state, 'waiting'); noInput(h);
    assert.equal(before.receipt.continuationInputCapture, undefined);
    assert.equal(before.receipt.continuationInputHold, undefined);
    assert.equal(h.store.continuationCaptures.size, 0);
    h.controls.beforePrepare = null; await wake(h); oneEnter(h);
    assert.equal(h.record().receipt.preflightScope.preparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
  });
}

for (const afterCommit of [false, true]) {
  test(`marker write ${afterCommit ? 'lost ACK after commit' : 'BUSY before commit'} never starts prepare before proof`, async t => {
    const h = await fixture(t), marker = faultFirstStage(h, 'continuationInputCapture', afterCommit);
    await h.activate(); const key = h.target().operationKey, before = h.record();
    assert.ok(marker()); assert.equal(h.calls.preparation, 0); noInput(h);
    assert.equal(!!before.receipt.continuationInputCapture, afterCommit);
    assert.equal(h.queue.item(key).state, 'waiting'); await wake(h); oneEnter(h);
    assert.equal(h.record().receipt.preflightScope.preparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
    assert.equal(h.store.continuationCaptures.size, 0);
  });
}

test('marker lost ACK followed by reopen parks instead of guessing whether capture started', async t => {
  const h = await fixture(t), marker = faultFirstStage(h, 'continuationInputCapture', true);
  await h.activate(); assert.ok(marker()); assert.equal(h.calls.preparation, 0); noInput(h);
  const key = h.target().operationKey, before = h.record(); h.controls.queueReady = false;
  let admissions = 0; h.controls.beforeAdmit = async () => { admissions++; };
  await h.reopen(); h.controls.queueReady = true; h.queue.resume(); await flush();
  assert.equal(h.calls.preparation, 0); assert.equal(admissions, 0); noInput(h);
  assert.equal(h.queue.item(key).state, 'waiting');
  assert.deepEqual(h.record().receipt.continuationInputCapture, marker());
  assert.equal(h.record().receipt.activeHeadPreparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
  h.clock.advance(60000); await flush();
  assert.equal(h.record().receipt.code, 'agent_send_preparation_expired'); noInput(h);
});

test('marker BUSY before commit and before any proof can retry after reopen', async t => {
  const h = await fixture(t), marker = faultFirstStage(h, 'continuationInputCapture');
  await h.activate(); assert.ok(marker()); assert.equal(h.calls.preparation, 0); noInput(h);
  const before = h.record(); assert.equal(before.receipt.continuationInputCapture, undefined);
  h.controls.queueReady = false; await h.reopen(); h.controls.queueReady = true; h.queue.resume(); await flush();
  oneEnter(h);
  assert.equal(h.record().receipt.preflightScope.preparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
});

test('first-hold BUSY and reopen with unchanged input cannot invent the lost fence', async t => {
  const h = await fixture(t), first = faultFirstStage(h, 'continuationInputHold');
  await h.activate(); assert.ok(first()); const before = h.record(), key = h.target().operationKey;
  assert.equal(before.receipt.continuationInputHold, undefined); noInput(h);
  h.controls.queueReady = false; await h.reopen(); h.controls.queueReady = true; h.queue.resume(); await flush();
  assert.equal(h.queue.item(key).state, 'waiting'); noInput(h);
  assert.equal(h.record().receipt.continuationInputHold, undefined);
  assert.equal(h.record().receipt.activeHeadPreparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
});

test('BUSY retains a detached first fence when a live nested owner object changes', async t => {
  const h = await fixture(t), first = faultFirstStage(h, 'continuationInputHold');
  await h.activate(); assert.ok(first()); noInput(h);
  h.owner.currentBinding.sessionId = 'different-session';
  await wake(h); noInput(h);
  assert.deepEqual(h.record().receipt.continuationInputHold, first());
  assert.equal(h.record().receipt.continuationInputHold.fence.ownerBinding.sessionId, 'source');
});

for (const field of ['submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test(`UNKNOWN ${field} defeats marker-only cancellation during queued admission`, async t => {
    const h = await fixture(t), marker = faultFirstStage(h, 'continuationInputCapture', true);
    await h.activate(); const key = h.target().operationKey; assert.ok(marker()); noInput(h);
    h.change('stop'); let injected = false;
    h.controls.afterAdmit = async decision => {
      if (injected || decision?.cancel !== true) return;
      injected = true; assert.equal(h.store.stageQueuedRequest(key, { [field]: true }).ok, true);
    };
    await wake(h);
    assert.equal(injected, true); assert.equal(h.record().receipt[field], true);
    assert.equal(h.record().deliveryControl?.cancelledAt, undefined);
    assert.notEqual(h.record().state, 'not-submitted'); noInput(h);
  });
}

for (const unknown of [false, true]) {
  test(`marker-only queued admission exception ${unknown ? 'parks concurrent UNKNOWN' : 'settles only an exact no-write head'}`, async t => {
    const h = await fixture(t); faultFirstStage(h, 'continuationInputCapture', true);
    await h.activate(); const key = h.target().operationKey; noInput(h);
    h.controls.beforeAdmit = async () => {
      if (unknown) assert.equal(h.store.stageQueuedRequest(key, { deliveryUnknown: true }).ok, true);
      throw Object.assign(Error('controlled admission failure'), { code: 'controlled_admission_failure' });
    };
    await wake(h); noInput(h);
    if (unknown) {
      assert.equal(h.record().receipt.deliveryUnknown, true); assert.notEqual(h.record().state, 'not-submitted');
      assert.equal(h.queue.item(key).state, 'waiting');
    } else {
      assert.equal(h.record().state, 'not-submitted');
      assert.equal(h.record().receipt.code, 'controlled_admission_failure');
      assert.equal(h.store.continuationCaptures.size, 0);
    }
  });
}

for (const field of ['submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test(`UNKNOWN ${field} immediately before beginAttempt defeats its retained hold CAS`, async t => {
    const h = await fixture(t); let injected = false;
    const begin = h.store.beginAttempt.bind(h.store);
    h.store.beginAttempt = (identity, guard) => {
      if (!injected && guard?.hold) {
        injected = true; assert.equal(h.store.stageQueuedRequest(identity.operationKey, { [field]: true }).ok, true);
      }
      return begin(identity, guard);
    };
    await h.activate();
    assert.equal(injected, true); assert.equal(h.record().receipt[field], true);
    assert.notEqual(h.record().state, 'not-submitted'); noInput(h);
  });
}

test('cancellation while the initial proof await is held cannot revive or retain its capture', async t => {
  const h = await fixture(t);
  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  t.after(() => resume());
  h.controls.beforePrepare = async () => { entered(); await gate; };
  const activating = h.activate(); await started;
  const key = h.target().operationKey, record = h.record();
  assert.ok(record.receipt.continuationInputCapture); assert.equal(record.receipt.continuationInputHold, undefined);
  assert.equal(h.store.cancelDelivery({ operationKey: key, tabId: 'T', handoffId: record.handoffId,
    attemptId: null, reason: 'manual-stop' }).ok, true);
  resume(); await activating; await flush();
  assert.ok(h.record().deliveryControl?.cancelledAt); assert.equal(h.store.continuationCaptures.size, 0); noInput(h);
  await wake(h); noInput(h);
});

test('silent durable cancellation also clears the captured in-memory fence', async t => {
  const h = await fixture(t), first = faultFirstStage(h, 'continuationInputHold');
  await h.activate(); assert.ok(first()); const record = h.record();
  assert.equal(h.store.continuationCaptures.size, 1);
  assert.equal(h.store.cancelDelivery({ operationKey: record.operationKey, tabId: record.tabId,
    handoffId: record.handoffId, attemptId: null, reason: 'manual-stop', notify: false }).ok, true);
  assert.equal(h.store.continuationCaptures.size, 0); noInput(h);
  await wake(h); noInput(h);
});

for (const field of ['submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test(`cancellation during the proof await cannot erase ${field}`, async t => {
    const h = await fixture(t);
    let entered, resume;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    t.after(() => resume());
    h.controls.beforePrepare = async () => { entered(); await gate; };
    const activating = h.activate(); await started;
    const key = h.target().operationKey, record = h.record();
    assert.equal(h.store.stageQueuedRequest(key, { [field]: true }).ok, true);
    assert.equal(h.store.cancelDelivery({ operationKey: key, tabId: 'T', handoffId: record.handoffId,
      attemptId: null, reason: 'manual-stop' }).ok, true);
    resume(); await activating; await flush();
    assert.equal(h.record().receipt[field], true); assert.notEqual(h.record().state, 'not-submitted');
    assert.notEqual(h.queue.item(key).state, 'failed'); noInput(h);
    await wake(h); assert.equal(h.record().receipt[field], true); noInput(h);
  });
}

test('clearing a completed no-proof marker can retry after SQLite BUSY in the same owner', async t => {
  const h = await fixture(t); let first = true, clearFailed = false;
  h.controls.beforePrepare = async () => { if (first) { first = false; throw deferSendPreparation('controlled_before_fence'); } };
  const clear = h.store.clearContinuationInputCapture.bind(h.store);
  h.store.clearContinuationInputCapture = (...args) => {
    if (!clearFailed) { clearFailed = true; throw Object.assign(Error('controlled clear failure'), { code: 'SQLITE_BUSY' }); }
    return clear(...args);
  };
  await h.activate(); const before = h.record(); assert.equal(clearFailed, true); noInput(h);
  assert.ok(before.receipt.continuationInputCapture); h.controls.beforePrepare = null;
  await wake(h); oneEnter(h);
  assert.equal(h.record().receipt.preflightScope.preparation.deadlineAt, before.receipt.activeHeadPreparation.deadlineAt);
  assert.equal(h.store.continuationCaptures.size, 0);
});

for (const reopened of [false, true]) for (const changed of [false, true]) {
  test(`committed hold with lost ACK ${reopened ? 'after reopen' : 'in same Main'} ${changed ? 'rejects new input' : 'resumes same input'}`, async t => {
    const h = await fixture(t), first = faultFirstStage(h, 'continuationInputHold', true);
    await h.activate(); const key = h.target().operationKey, before = h.record();
    assert.ok(first()); assert.deepEqual(before.receipt.continuationInputHold, first()); noInput(h);
    if (changed) h.change('input');
    if (reopened) { h.controls.queueReady = false; await h.reopen(); h.controls.queueReady = true; h.queue.resume(); await flush(); }
    else await wake(h);
    if (changed) { noInput(h); assert.notEqual(h.record().state, 'confirmed'); }
    else { oneEnter(h); assert.deepEqual(h.record().receipt.preflightScope.continuationInputOriginalFence, first().fence); }
    assert.equal(h.queue.item(key).id, 1);
  });
}

for (const agent of [false, true]) for (const field of ['submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test(`${agent ? 'agent' : 'Build'} foreign destination cannot overwrite concurrent ${field}`, async t => {
    const h = await fixture(t, { agent }); let once = false;
    h.controls.beforeDestination = async () => {
      if (once) return; once = true;
      const owner = h.queue.db.prepare("SELECT operation_key FROM agent_send_queue WHERE tab_id='T' AND state='dispatching'").get();
      assert.ok(owner); assert.equal(h.store.stageQueuedRequest(owner.operation_key, { [field]: true }).ok, true);
      h.controls.destinationResult = { coherent: true, toolType: 'codex', status: 'active', sendTarget: {
        toolType: 'codex', sessionId: 'source', terminalInstanceId: 'foreign-terminal',
        launchId: 'launch-T', lifecycleGeneration: 'L1' } };
    };
    await h.activate(); const record = h.record(), item = h.queue.item(h.target().operationKey);
    assert.equal(record.receipt[field], true); assert.notEqual(record.state, 'not-submitted');
    assert.notEqual(item.state, 'failed'); noInput(h);
    await wake(h); assert.equal(h.record().receipt[field], true); noInput(h);
  });
}

test('replacement of the retained hold during destination await cannot settle a stale refusal', async t => {
  const h = await fixture(t); let once = false;
  h.controls.beforeDestination = async () => {
    if (once) return; once = true;
    const hold = h.record().receipt.continuationInputHold;
    assert.equal(h.store.stageQueuedRequest(h.target().operationKey,
      { continuationInputHold: { ...hold, fence: { ...hold.fence, inputRevision: 999 } } }).ok, true);
    h.controls.destinationResult = { coherent: true, toolType: 'codex', status: 'active', sendTarget: {
      toolType: 'codex', sessionId: 'source', terminalInstanceId: 'foreign-terminal',
      launchId: 'launch-T', lifecycleGeneration: 'L1' } };
  };
  await h.activate(); noInput(h);
  assert.equal(h.record().receipt.continuationInputHold.fence.inputRevision, 999);
  assert.notEqual(h.record().state, 'not-submitted');
});

for (const field of [null, 'submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test(`cancel result distinguishes future-intent cancellation from ${field || 'proven unwritten delivery'}`, async t => {
    const h = await fixture(t); let once = false;
    h.controls.beforeDestination = async () => { if (!once) { once = true; h.control.ready = false; } };
    await h.activate();
    const before = h.record(), key = h.target().operationKey;
    assert.ok(before.receipt.continuationInputHold);
    if (field) assert.equal(h.store.stageQueuedRequest(key, { [field]: true }).ok, true);
    const result = h.queue.cancelDelivery('T', before.handoffId, { dismiss: false, reason: 'manual-stop' });
    assert.equal(result.deliveryIntentCancelled, true);
    assert.equal(h.calls.bridge, 0);
    assert.equal(result.deliveryCancelled, !field);
    assert.equal(result.deliveryOutcome, field ? 'delivery-unknown' : 'not-submitted');
    assert.equal(result.complete, !field);
    if (field) assert.equal(h.record().receipt[field], true);
  });
}
