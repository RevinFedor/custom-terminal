'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createSendPreparationScope } = require('./agent-send-preparation');
const { actualFunction, createCodexDraftRequestHarness, createFakeClock, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');

function fixture(t, { now = 1000 } = {}) {
  let proof = { success: true, hasDraft: null, preview: '', source: 'headless-main:open',
    frameBlocker: 'synchronized-output-open' };
  const h = createCodexDraftRequestHarness({ rendererAvailable: false, getDraft: () => proof,
    clock: createFakeClock(now) });
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', surface: 'desktop-history',
    provider: 'codex', requestFingerprint: 'frozen', promptHash: 'hash', promptLength: 6 };
  const begun = store.beginAttempt(identity);
  const scope = createSendPreparationScope({ ...identity, attemptId: begun.attemptId }, h.clock.now());
  assert.equal(store.stageAttemptContext(identity.operationKey, begun.attemptId, { preflightScope: scope,
    authoring: { text: 'frozen', images: ['same-owned-asset'] } }).ok, true);
  h.context.agentSendReceiptStore = store;
  // Both the actual Main request and the real durable owner use this clock.
  const readPreparation = h.context.readAgentSendPreparation;
  h.context.readAgentSendPreparation = (s, tab, options, startup) => readPreparation(s, tab, options, startup, h.clock.now);
  const options = { waitFor: false, waitOnUnknownOnly: true, waitTimeoutMs: 2500,
    handoffId: 'H', attemptId: begun.attemptId };
  const read = extra => h.read('agent-send-preflight:history-panel', { ...options, ...extra });
  const frame = (hasDraft = false) => {
    proof = { success: true, hasDraft, preview: hasDraft ? 'foreign' : '', source: 'headless-main:cursor:10',
      frameIdentity: { generation: 'G1', writeSeq: 32 } }; h.notifyFrame();
  };
  t.after(async () => { h.setOwner({ terminalStopRevision: 9 }); h.notifyFrame();
    await drainMicrotasks(40); db.close(); });
  return { ...h, db, store, identity, begun, scope, read, frame };
}

// The public readiness signal is controlled; the startup projector, retained
// receipt, accepted HEAD scope, SQLite owner and Main frame reader are actual.
function installNearlyExpiredLaunch(h) {
  const terminal = {}, launchId = 'previous-launch';
  let ready = false, established = false;
  h.context.terminals.set('T', terminal);
  h.context.terminalCommandState.set('T', { runSeq: 1, isRunning: true });
  h.context.codexLastRunCommandPayload.set('T', { launchId, terminalToken: terminal,
    lifecycleGeneration: 'L1', runSeq: 1, startedAt: h.clock.now() - 59752 });
  h.context.getTerminalStopRevision = () => 0;
  h.context.isCodexOperationalInputReady = () => ready;
  h.context.hasCodexEstablishedComposerLifecycle = () => established;
  const pinned = h.context.captureCodexSendStartupFrameWait('T');
  assert.equal(pinned.deadlineAt, h.clock.now() + 248);
  return { launchId, pinned, ready(inputReady = true) { established = true; ready = inputReady; } };
}

test('a later picker cannot reattach a new warm HEAD to a retained startup clock', async t => {
  const h = fixture(t, { now: 60000 }), launch = installNearlyExpiredLaunch(h);
  launch.ready(false); // initialized same lifecycle, current input temporarily unavailable
  const pending = h.read(); await drainMicrotasks(40);
  h.clock.advance(350); h.frame(); const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.observation.budgetMs, 60000);
  assert.equal(h.context.captureCodexSendStartupFrameWait('T', launch.launchId), launch.pinned);
});

for (const retainedPayload of [false, true]) {
  test('new warm HEAD does not borrow the preceding launch deadline; payload retained=' + retainedPayload, async t => {
    const h = fixture(t, { now: 60000 }), launch = installNearlyExpiredLaunch(h);
    launch.ready();
    if (!retainedPayload) h.context.codexLastRunCommandPayload.delete('T');
    const pending = h.read(); await drainMicrotasks(40);
    h.clock.advance(350); h.frame();
    const result = await pending;
    assert.equal(result.hasDraft, false, 'a fresh empty frame after the OLD expiry belongs to the new warm HEAD');
    assert.equal(result.observation.budgetMs, 60000);
    assert.equal(h.store.get(h.identity.operationKey).receipt.preflightScope.id, h.scope.id);
    assert.equal(h.context.codexSendStartupFrameWaitIsCurrent('T', launch.pinned), true,
      'warm admission must not revoke a pinned cold caller');
  });

  test('pinned cold HEAD retains its original deadline after ready; payload retained=' + retainedPayload, async t => {
    const h = fixture(t, { now: 60000 }), launch = installNearlyExpiredLaunch(h);
    launch.ready();
    if (!retainedPayload) h.context.codexLastRunCommandPayload.delete('T');
    const pending = h.read({ codexStartupFrameWaitId: launch.launchId });
    await drainMicrotasks(40); h.clock.advance(350);
    const result = await pending;
    assert.equal(result.hasDraft, null);
    assert.equal(result.preparationFailure?.code, 'agent_send_preparation_expired');
    assert.equal(result.observation.budgetMs, 248);
    h.frame();
    const late = await h.read({ codexStartupFrameWaitId: launch.launchId });
    assert.equal(late.hasDraft, null, 'ready or a late empty frame cannot renew the pinned cold operation');
  });
}

for (const change of ['launch', 'run', 'stop']) {
  test('retained startup receipt cannot cross ' + change, async t => {
    const h = fixture(t, { now: 60000 }), launch = installNearlyExpiredLaunch(h);
    launch.ready();
    if (change === 'launch') h.context.codexLastRunCommandPayload.get('T').launchId = 'replacement';
    if (change === 'run') h.context.terminalCommandState.get('T').runSeq++;
    if (change === 'stop') h.context.getTerminalStopRevision = () => 1;
    assert.equal(h.context.codexSendStartupFrameWaitIsCurrent('T', launch.pinned), false);
    h.frame();
    const result = await h.read({ codexStartupFrameWaitId: launch.launchId });
    assert.equal(result.hasDraft, null);
    assert.equal(result.observation.status, 'superseded');
  });
}

test('actual Main warm preflight keeps the SAME accepted H/O/A and authoring after 2.5s', async t => {
  const h = fixture(t), before = h.store.get(h.identity.operationKey);
  let settled = false;
  const pending = h.read().then(value => { settled = true; return value; });
  await drainMicrotasks(30); h.clock.advance(3100); await drainMicrotasks(30);
  assert.equal(settled, false, 'one short observation must not finalize an accepted preparation');
  assert.equal(h.store.get(h.identity.operationKey).attemptId, before.attemptId);
  assert.deepEqual(h.store.get(h.identity.operationKey).receipt.authoring, before.receipt.authoring);
  h.frame(); const result = await pending;
  assert.equal(result.hasDraft, false); assert.equal(result.observation.status, 'settled');
  assert.equal(h.clock.now(), 4100); assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
});

test('actual Main current empty proof returns immediately, without spending the 60s ceiling', async t => {
  const h = fixture(t); h.frame(); const at = h.clock.now(); const result = await h.read();
  assert.equal(result.hasDraft, false); assert.equal(h.clock.now(), at);
});

test('actual Main expiry cannot be renewed by another read or a late empty frame', async t => {
  const h = fixture(t); const pending = h.read(); await drainMicrotasks(30);
  h.clock.advance(60000); await drainMicrotasks(30);
  const result = await pending;
  assert.equal(result.observation.status, 'expired');
  h.frame(); const late = await h.read();
  assert.notEqual(late.hasDraft, false, 'an expired accepted intent cannot regain future input');
  assert.equal(h.store.get(h.identity.operationKey).attemptId, h.begun.attemptId);
});

for (const change of ['input', 'stop', 'cancel', 'owner']) test('actual Main preparation revokes on ' + change, async t => {
  const h = fixture(t); let settled = false;
  const pending = h.read().then(value => { settled = true; return value; });
  await drainMicrotasks(30); h.clock.advance(3100); await drainMicrotasks(30);
  assert.equal(settled, false);
  if (change === 'input') h.setOwner({ inputRevision: 2 });
  if (change === 'stop') h.setOwner({ terminalStopRevision: 1 });
  if (change === 'owner') h.setOwner({ terminalLifecycleGeneration: 'foreign' });
  if (change === 'cancel') h.store.cancelDelivery({ ...h.identity, attemptId: h.begun.attemptId, reason: 'manual-stop' });
  h.frame(); const result = await pending;
  assert.notEqual(result.hasDraft, false); assert.notEqual(result.observation.status, 'settled');
  if (change !== 'cancel') assert.equal(result.preparationFailure, undefined,
    'owner/input changes alone are not a durable cancellation');
});

test('actual Main fresh foreign draft ends preparation without waiting for expiry', async t => {
  const h = fixture(t); const pending = h.read(); await drainMicrotasks(30);
  h.clock.advance(3100); await drainMicrotasks(30); h.frame(true);
  const result = await pending; assert.equal(result.hasDraft, true);
  assert.equal(h.clock.now(), 4100);
});

for (const kind of ['cancel', 'stop-after-cancel', 'expiry']) test('actual Main retains preparation refusal through final frame publication: ' + kind, async t => {
  const h = fixture(t);
  if (kind === 'stop-after-cancel') {
    // Execute the real final publication guard too: a Stop legitimately
    // invalidates frame identity, but must not erase its exact cancellation.
    h.context.captureAgentInputIdentity = () => ({ ...h.context.publishedOwner });
    h.context.agentInputObservationOwner = (_tabId, value) => value;
    h.context.publishedOwner = { terminalRunSeq: 1, inputRevision: 1,
      terminalLifecycleGeneration: 'L1', mirrorGeneration: 'G1', terminalStopRevision: 0 };
    require('node:vm').runInContext(actualFunction('decorateAgentDraftProofIdentity'), h.context);
  }
  const pending = h.readPublic('agent-send-preflight:history-panel', {
    waitFor: false, waitOnUnknownOnly: true, handoffId: 'H', attemptId: h.begun.attemptId,
  }); await drainMicrotasks(30);
  if (kind === 'expiry') h.clock.advance(60000);
  else {
    h.store.cancelDelivery({ ...h.identity, attemptId: h.begun.attemptId, reason: 'manual-stop' });
    if (kind === 'stop-after-cancel') {
      h.context.publishedOwner.terminalStopRevision = 1;
      h.setOwner({ terminalStopRevision: 1 });
    }
    h.notifyFrame();
  }
  const result = await pending;
  assert.equal(result.hasDraft, null, 'refusal never fabricates an empty frame');
  assert.equal(result.preparationFailure?.code,
    kind === 'expiry' ? 'agent_send_preparation_expired' : 'agent_send_cancelled');
  assert.notEqual(result.observation.status, 'settled');
  if (kind === 'stop-after-cancel') assert.equal(result.source, 'headless-main:observation-owner-changed-before-publication');
});
