'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { fixture } = require('./fixtures/continuation-first-input-flow.cjs');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const installLateWait = h => {
  let changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return;
    changed = true; h.clock.advance(23047); h.control.ready = false;
  };
};
const releaseLateWait = h => { h.controls.beforeDestination = null; h.control.ready = true; h.queue.notifyRuntime('T'); };
const noInput = h => { assert.equal(h.calls.bridge, 0); assert.deepEqual(h.writes, []); assert.equal(h.record().attemptId, null); };
const installActualWriterProof = (h, writer) => {
  writer.valid = true; h.control.writer = writer;
  h.c.codexKnownSessions = new Map([['T', writer.sessionId]]);
  h.c.codexWriterProofs = new Map([['T', writer]]);
  vm.runInContext(h.actual('getCodexWriterProofSnapshot') + '\n' + h.actual('isCodexWriterUsableForMutation'), h.c);
};

test('late transient readiness at 23s parks the same 60s HEAD and re-proves before one input', async t => {
  const h = await fixture(t);
  let changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return;
    changed = true;
    h.clock.advance(23047);
    h.control.ready = false;
  };
  await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key), record = h.record();
  assert.equal(changed, true);
  assert.equal(item.state, 'waiting', JSON.stringify({ item, record, target: h.target() }));
  assert.equal(record.attemptId, null);
  assert.equal(record.receipt.activeHeadPreparation.startedAt, 1000);
  assert.equal(record.receipt.activeHeadPreparation.deadlineAt, 61000);
  assert.equal(h.calls.bridge, 0);
  assert.deepEqual(h.writes, []);
  h.controls.beforeDestination = null;
  h.control.ready = true;
  h.queue.notifyRuntime('T');
  await flush();
  await h.operation.reconcile('first-continue-operation');
  const after = h.record();
  assert.equal(h.queue.item(key).id, item.id);
  assert.equal(h.queue.item(key).request_hash, item.request_hash);
  assert.equal(after.handoffId, record.handoffId);
  assert.equal(after.operationKey, record.operationKey);
  assert.equal(after.receipt.preflightScope.preparation.startedAt, 1000);
  assert.equal(after.receipt.preflightScope.preparation.deadlineAt, 61000);
  assert.equal(h.calls.bridge, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
  assert.equal(after.state, 'confirmed');
});

for (const agent of [false, true]) for (const change of ['input', 'stop', 'terminal', 'conversation-owner']) {
  test((agent ? 'agent' : 'Build') + ' late hard ' + change + ' refuses before attempt', async t => {
    const h = await fixture(t, { agent }); let once = false;
    h.controls.beforeDestination = async () => {
      if (once) return; once = true;
      if (change === 'terminal') h.change('owner');
      else if (change === 'conversation-owner') h.owner.ownerToken = 'foreign-owner';
      else h.change(change);
    };
    await h.activate(); noInput(h);
    assert.equal(h.record().receipt.code, 'agent_send_continuation_input_changed');
    assert.equal(h.record().receipt.continuationInputClass, 'hard');
    assert.ok(h.logs.some(line => line.includes('stage=post-await class=hard reason=')));
    h.queue.notifyRuntime('T'); await flush(); noInput(h);
  });
}

for (const change of ['input', 'stop', 'terminal', 'conversation-owner']) {
  test('retained late fence does not repin after parked ' + change, async t => {
    const h = await fixture(t); installLateWait(h); await h.activate();
    const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
    assert.equal(item.state, 'waiting'); assert.ok(hold); noInput(h);
    if (change === 'terminal') h.change('owner');
    else if (change === 'conversation-owner') h.owner.ownerToken = 'foreign-owner';
    else h.change(change);
    releaseLateWait(h); await flush(); await h.operation.reconcile('first-continue-operation');
    noInput(h); assert.equal(h.queue.item(key).id, item.id);
    assert.equal(h.queue.item(key).request_hash, item.request_hash);
    assert.deepEqual(h.record().receipt.continuationInputHold, hold);
  });
}

for (const transition of ['frame', 'draft', 'input-control', 'observation']) {
  test('late ' + transition + ' is pending and requires a fresh Main proof', async t => {
    const h = await fixture(t); let changed = false;
    h.controls.beforeDestination = async () => {
      if (changed) return; changed = true;
      if (transition === 'frame') h.control.frame = false;
      if (transition === 'draft') h.frame(true);
      if (transition === 'input-control') h.control.inputControl = { kind: 'goal' };
      if (transition === 'observation') h.c.codexProvisionalSourceObservations.set('T', Object.freeze({ ...h.observation }));
    };
    await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
    assert.equal(item.state, 'waiting'); noInput(h);
    assert.ok(h.logs.some(line => line.includes('stage=post-await class=pending reason=')));
    h.controls.beforeDestination = null; h.control.frame = true; h.control.inputControl = null; h.frame(false);
    h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
    assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
    assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1); assert.equal(h.record().state, 'confirmed');
  });
}

for (const failure of ['throw', 'incomplete']) {
  test('unavailable late destination ' + failure + ' stays on the same unattempted HEAD', async t => {
    const h = await fixture(t); let changed = false;
    h.controls.beforeDestination = async () => {
      if (changed) return; changed = true; h.clock.advance(23047);
      if (failure === 'throw') throw Object.assign(new Error('controlled lookup unavailable'), { code: 'runtime_snapshot_unstable' });
      h.controls.destinationResult = { coherent: true, sendTarget: { toolType: 'codex', sessionId: null } };
    };
    await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
    assert.equal(item.state, 'waiting'); noInput(h);
    assert.equal(h.record().receipt.activeHeadPreparation.deadlineAt, 61000);
    assert.ok(h.logs.some(line => line.includes('stage=destination class=pending reason=destination_unavailable')));
    h.controls.beforeDestination = null; h.controls.destinationResult = null; h.queue.notifyRuntime('T');
    await flush(); await h.operation.reconcile('first-continue-operation');
    assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
    assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
  });
}

test('hard input change concurrent with an unavailable destination remains a refusal', async t => {
  const h = await fixture(t);
  h.controls.beforeDestination = async () => { h.change('input'); throw Error('controlled destination unavailable'); };
  await h.activate(); noInput(h);
  assert.equal(h.record().receipt.code, 'agent_send_continuation_input_changed');
  assert.equal(h.record().receipt.continuationInputReason, 'input_changed');
});

test('temporarily unknown provider remains pending, but a known foreign provider is hard', async t => {
  const h = await fixture(t); let changed = false;
  h.controls.beforeDestination = async () => { if (!changed) { changed = true; h.control.provider = null; } };
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
  assert.equal(item.state, 'waiting'); noInput(h);
  assert.ok(h.logs.some(line => line.includes('class=pending reason=provider_unproven')));
  h.controls.beforeDestination = null; h.control.provider = 'codex'; h.queue.notifyRuntime('T');
  await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('known Claude replacing the prepared Codex provider is a hard late refusal', async t => {
  const h = await fixture(t); h.controls.beforeDestination = async () => { h.control.provider = 'claude'; };
  await h.activate(); noInput(h);
  assert.equal(h.record().receipt.code, 'agent_send_continuation_input_changed');
  assert.equal(h.record().receipt.continuationInputReason, 'provider_changed');
});

for (const condition of ['goal', 'original-history', 'latest-history']) {
  test('parked late HEAD rechecks ' + condition + ' before any input', async t => {
    const h = await fixture(t); installLateWait(h); await h.activate();
    const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
    if (condition === 'goal') h.controls.goal = { pending: true, status: 'active' };
    if (condition === 'original-history') h.controls.originalUnknown = true;
    if (condition === 'latest-history') h.controls.intervalUnknown = true;
    releaseLateWait(h); await flush(); noInput(h);
    assert.equal(h.queue.item(key).state, 'waiting'); assert.deepEqual(h.record().receipt.continuationInputHold, hold);
    h.controls.goal = null; h.controls.originalUnknown = false; h.controls.intervalUnknown = false;
    h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
    assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
    assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
  });
}

test('late no-attempt hold survives SQLite reopen with the original 60s deadline', async t => {
  const h = await fixture(t); installLateWait(h); await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
  await h.reopen(); noInput(h);
  assert.deepEqual(h.record().receipt.continuationInputHold, hold);
  assert.equal(h.record().receipt.activeHeadPreparation.startedAt, 1000);
  assert.equal(h.record().receipt.activeHeadPreparation.deadlineAt, 61000);
  releaseLateWait(h); h.queue.resume(); await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.record().receipt.preflightScope.preparation.deadlineAt, 61000);
  assert.equal(h.calls.bridge, 1); assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('late no-attempt hold expires at the original deadline even after SQLite reopen', async t => {
  const h = await fixture(t); installLateWait(h); await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
  await h.reopen(); h.queue.resume(); await flush(); h.clock.advance(36953); await flush();
  assert.equal(h.record().receipt.code, 'agent_send_preparation_expired');
  assert.equal(h.record().receipt.activeHeadPreparation.deadlineAt, 61000);
  assert.deepEqual(h.record().receipt.continuationInputHold, hold);
  assert.equal(h.queue.item(key).id, item.id); noInput(h);
  releaseLateWait(h); await flush(); noInput(h);
});

test('physical replacement after SQLite reopen cannot renew the retained late fence', async t => {
  const h = await fixture(t); installLateWait(h); await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
  await h.reopen(); h.change('owner'); releaseLateWait(h); h.queue.resume(); await flush();
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.queue.item(key).request_hash, item.request_hash);
  assert.deepEqual(h.record().receipt.continuationInputHold, hold); noInput(h);
});

test('known replacement before Main reopen is a hard fence mismatch, not a renewed pending owner', async t => {
  const h = await fixture(t); installLateWait(h); await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
  h.change('owner'); h.c.terminalLifecycleEpochs.set(h.c.terminals.get('T'), 'physical-new');
  await h.reopen(); releaseLateWait(h); h.queue.resume(); await flush();
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.queue.item(key).request_hash, item.request_hash);
  assert.deepEqual(h.record().receipt.continuationInputHold, hold); noInput(h);
  assert.notEqual(h.queue.item(key).state, 'waiting');
  assert.ok(h.record().deliveryControl?.cancelledAt || h.record().state === 'not-submitted');
});

test('ordinary and older no-fence continuation admission keep their old path', async t => {
  const h = await fixture(t); let reads = 0;
  h.c.readAgentContinuationInputAdmission = async () => { reads++; throw Error('must not inspect runtime'); };
  const originalGet = h.store.get.bind(h.store); let storeReads = 0;
  h.store.get = (...args) => { storeReads++; return originalGet(...args); };
  assert.equal(h.c.readQueuedContinuationHardFence({ source: 'history-panel', sendOperationKey: 'ordinary' }), true);
  assert.equal(storeReads, 0, 'ordinary Send does not incur the continuation receipt lookup');
  const request = { tabId: 'T', handoffId: 'ordinary', sendOperationKey: 'history:T:ordinary', source: 'build-install-continue:old' };
  assert.equal(h.store.reserveOrGet({ operationKey: request.sendOperationKey, tabId: 'T', handoffId: 'ordinary',
    surface: 'desktop-history', provider: 'codex', requestFingerprint: 'old-fingerprint', promptHash: 'old-hash', promptLength: 1 }).ok, true);
  assert.equal(h.c.readQueuedContinuationHardFence(request), true, 'an older no-fence item must not gain an await');
  assert.equal(reads, 0); assert.equal(h.store.get(request.sendOperationKey).attemptId, null);
});

test('retained hard precheck does not inspect processes or grant readiness', async t => {
  const h = await fixture(t); installLateWait(h); await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key); let reads = 0;
  h.control.processRead = async () => { reads++; };
  assert.equal(h.control.ready, false);
  assert.equal(await h.c.readQueuedContinuationHardFence(JSON.parse(item.request_json)), true);
  assert.equal(reads, 0); noInput(h);
});

test('exact Resume source can refine to a proven writer after the late cut', async t => {
  const h = await fixture(t); let changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return; changed = true;
    installActualWriterProof(h, { sessionId: 'child', sourceSessionId: 'source', launchId: 'launch-T', terminalToken: h.term, runSeq: 1, lifecycleGeneration: 'L1', pids: [7] });
    h.owner.ownerOrder.revision++; h.owner.currentBinding = { state: 'bound', provider: 'codex', sessionId: 'child' };
    h.controls.responseBusy = false; h.controls.transitioning = false; h.controls.revision = 'writer-confirmed';
  };
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
  assert.equal(item.state, 'waiting'); assert.equal(h.record().receipt.continuationInputHold.fence.mode, 'provisional-resume'); noInput(h);
  h.controls.beforeDestination = null; h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1, JSON.stringify({ logs: h.logs, error: h.record()?.receipt?.error }));
  assert.equal(h.record().receipt.preflightScope.continuationInputFence.mode, 'writer');
  assert.equal(h.record().receipt.preflightScope.continuationInputOriginalFence.mode, 'provisional-resume');
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('writer proof arriving while the provisional observation remains is re-read before attempt', async t => {
  const h = await fixture(t); let changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return; changed = true;
    installActualWriterProof(h, { sessionId: 'source', sourceSessionId: 'source', launchId: 'launch-T',
      terminalToken: h.term, runSeq: 1, lifecycleGeneration: 'L1', pids: [7] });
    h.controls.responseBusy = false; h.controls.transitioning = false; h.controls.revision = 'writer-same-source';
  };
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
  assert.equal(item.state, 'waiting'); noInput(h);
  assert.ok(h.logs.some(line => line.includes('reason=writer_observation_refined')));
  h.controls.beforeDestination = null; h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
  assert.equal(h.record().receipt.preflightScope.continuationInputFence.mode, 'writer');
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('exact writer source survives legitimate discovery and launch-payload retirement', async t => {
  const h = await fixture(t); let changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return; changed = true;
    installActualWriterProof(h, { sessionId: 'child', sourceSessionId: 'source', launchId: 'launch-T',
      terminalToken: h.term, runSeq: 1, lifecycleGeneration: 'L1', pids: [7] });
    h.control.writer.acceptedResumeSource = h.c.currentCodexAcceptedResumeSourceProof('T', h.control.writer);
    assert.equal(h.control.writer.acceptedResumeSource.sessionId, 'source');
    h.c.codexSessionDiscoveryIntents.delete('T'); h.c.codexLastRunCommandPayload.delete('T');
    h.owner.ownerOrder.revision++; h.owner.currentBinding = { state: 'bound', provider: 'codex', sessionId: 'child' };
    h.controls.responseBusy = false; h.controls.transitioning = false; h.controls.revision = 'writer-retained';
  };
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
  assert.equal(item.state, 'waiting'); noInput(h);
  assert.ok(h.logs.some(line => line.includes('reason=launch_observation_refined')));
  h.controls.beforeDestination = null; h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1, JSON.stringify({ logs: h.logs, error: h.record()?.receipt?.error }));
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1); assert.equal(h.record().state, 'confirmed');
});

test('a different writer SID without current accepted-source proof is not a refinement', async t => {
  const h = await fixture(t); installLateWait(h); await h.activate();
  const key = h.target().operationKey, item = h.queue.item(key);
  installActualWriterProof(h, { sessionId: 'child', launchId: 'launch-T', terminalToken: h.term, runSeq: 1, lifecycleGeneration: 'L1', pids: [7] });
  h.owner.ownerOrder.revision++; h.owner.currentBinding = { state: 'bound', provider: 'codex', sessionId: 'child' };
  releaseLateWait(h); await flush(); noInput(h);
  assert.equal(h.queue.item(key).id, item.id); assert.notEqual(h.record().state, 'confirmed');
});

test('unknown owner observation waits for a fresh exact binding, without renewing the hold', async t => {
  const h = await fixture(t); const binding = { ...h.owner.currentBinding }; let changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return; changed = true; h.owner.ownerOrder.revision++;
    h.owner.currentBinding = { state: 'unknown' };
  };
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key), hold = h.record().receipt.continuationInputHold;
  assert.equal(item.state, 'waiting'); noInput(h);
  h.controls.beforeDestination = null; h.queue.notifyRuntime('T'); await flush(); noInput(h);
  assert.deepEqual(h.record().receipt.continuationInputHold, hold);
  h.owner.ownerOrder.revision++; h.owner.currentBinding = binding; h.queue.notifyRuntime('T');
  await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('cancellation while the destination await is held cannot revive the pinned H/O', async t => {
  const h = await fixture(t), entered = gate(), resume = gate();
  t.after(() => resume.resolve());
  h.controls.beforeDestination = async () => { entered.resolve(); await resume.promise; };
  const activating = h.activate(); await entered.promise;
  const key = h.target().operationKey, record = h.record(), item = h.queue.item(key);
  assert.ok(record.receipt.continuationInputHold, 'the original fence was durable before this await');
  assert.equal(h.store.cancelDelivery({ operationKey: key, tabId: 'T', handoffId: record.handoffId,
    attemptId: null, reason: 'manual-stop' }).ok, true);
  resume.resolve(); await activating; await flush();
  assert.ok(h.record().deliveryControl.cancelledAt); noInput(h);
  assert.equal(h.queue.item(key).id, item.id); h.queue.notifyRuntime('T'); await flush(); noInput(h);
});

for (const field of ['submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test('unproven ' + field + ' appearing during the late await cannot start an attempt', async t => {
    const h = await fixture(t); let changed = false;
    h.controls.beforeDestination = async () => {
      if (changed) return; changed = true;
      assert.equal(h.store.stageQueuedRequest(h.target().operationKey, { [field]: true }).ok, true);
    };
    await h.activate(); const key = h.target().operationKey, record = h.record(), item = h.queue.item(key);
    assert.equal(record.receipt[field], true); assert.equal(item.state, 'dispatching'); noInput(h);
    const calls = h.calls.preparation; await flush();
    assert.equal(h.calls.preparation, calls, 'unproven deferred head must not self-pump');
    h.clock.advance(60000); await flush();
    assert.equal(h.record().receipt[field], true); assert.equal(h.record().attemptId, null);
    h.queue.notifyRuntime('T'); await flush(); noInput(h); assert.equal(h.queue.item(key).id, item.id);
  });
}

for (const field of ['submitted', 'pasteWritten', 'enterWritten', 'deliveryUnknown']) {
  test('UNKNOWN ' + field + ' arriving after queued hard proof defeats cancellation CAS', async t => {
    const h = await fixture(t); installLateWait(h); await h.activate();
    const key = h.target().operationKey, item = h.queue.item(key); let injected = false;
    h.change('input');
    h.controls.afterAdmit = async decision => {
      if (injected || decision?.continuationFenceHard !== true) return;
      injected = true; assert.equal(h.store.stageQueuedRequest(key, { [field]: true }).ok, true);
    };
    releaseLateWait(h); await flush();
    assert.equal(injected, true); assert.equal(h.queue.item(key).state, 'waiting');
    assert.equal(h.queue.item(key).id, item.id); assert.equal(h.record().receipt[field], true);
    assert.equal(h.record().deliveryControl?.cancelledAt, undefined); noInput(h);
    const count = h.calls.preparation; await flush(); assert.equal(h.calls.preparation, count);
  });
}

test('a later wake resumes only after the exact frozen head snapshot is restored', async t => {
  const h = await fixture(t); let original, changed = false;
  h.controls.beforeDestination = async () => {
    if (changed) return; changed = true;
    const item = h.queue.item(h.target().operationKey); original = item.request_json;
    h.queue.db.prepare('UPDATE agent_send_queue SET request_json=? WHERE operation_key=?')
      .run(JSON.stringify({ ...JSON.parse(original), cwd: '/different' }), item.operation_key);
  };
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key), calls = h.calls.preparation;
  assert.equal(item.state, 'dispatching'); noInput(h); await flush();
  assert.equal(h.calls.preparation, calls, 'a mismatched snapshot must not self-pump');
  h.controls.beforeDestination = null;
  h.queue.db.prepare('UPDATE agent_send_queue SET request_json=? WHERE operation_key=?').run(original, key);
  h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('late deferred H/O followed by lost ACK, reopen and exact audit never writes a second Enter', async t => {
  const h = await fixture(t); installLateWait(h); h.controls.audit = false; h.controls.loseAck = true;
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key), handoff = h.record().handoffId;
  noInput(h); releaseLateWait(h); await flush();
  const unknown = h.record(); assert.ok(unknown.attemptId); assert.notEqual(unknown.state, 'confirmed');
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1); assert.equal(h.calls.bridge, 1);
  await h.reopen(); h.queue.notifyRuntime('T'); await flush();
  assert.equal(h.record().attemptId, unknown.attemptId); assert.equal(h.record().handoffId, handoff);
  assert.equal(h.queue.item(key).id, item.id); assert.equal(h.calls.bridge, 1);
  assert.equal(h.audit(h.record()).promoted, true); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.record().state, 'confirmed'); assert.equal(h.calls.bridge, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});

test('late renderer callback cannot replace exact audit or trigger a second input', async t => {
  const h = await fixture(t); installLateWait(h); h.controls.audit = false; h.controls.loseAck = true;
  await h.activate(); const key = h.target().operationKey, item = h.queue.item(key);
  noInput(h); releaseLateWait(h); await flush();
  const record = h.record(); assert.ok(record.attemptId); assert.equal(typeof h.controls.lateReply, 'function');
  assert.equal(h.audit(record).promoted, true); const exact = h.record();
  await h.controls.lateReply({ ok: false, data: { submitted: false, success: false,
    pasteWritten: false, enterWritten: false, code: 'controlled-stale-callback' } });
  h.queue.notifyRuntime('T'); await flush(); await h.operation.reconcile('first-continue-operation');
  assert.equal(h.record().state, 'confirmed'); assert.equal(h.record().attemptId, exact.attemptId);
  assert.equal(h.record().handoffId, exact.handoffId); assert.equal(h.queue.item(key).id, item.id);
  assert.equal(h.calls.bridge, 1); assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1);
});
