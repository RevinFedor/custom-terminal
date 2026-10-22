'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createOscReadFixture } = require('./fixtures/codex-osc-read-revoke.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

test('same-owner materialized Resume reads actual private History without granting writer authority', async t => {
  const h = await createOscReadFixture(t), before = h.ctx.projectCodexRuntimeSnapshotFromEvents(h.tabId);
  assert.equal(before.readSessionId, h.sessionId, before.readIdentityReason);
  assert.equal(before.canCopySessionId, true); assert.equal(before.writerConfirmed, false);
  assert.equal(before.writerUsableForMutation, false);
  const result = await h.read(); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.readSessionId, h.sessionId); assert.equal(result.body.writerConfirmed, false);
  assert.match(JSON.stringify(result.body.entries), /PRIVATE IOS35 HISTORY TEXT/);
  assert.deepEqual(h.inputEffects, []);
});

test('D differentiating: OSC-B synchronously revokes cached positive History read before HTTP admission', async t => {
  const h = await createOscReadFixture(t);
  assert.equal((await h.read()).status, 200);
  const cached = h.ctx.codexRuntimeProjectionStore.read(h.tabId), reads = h.reads();
  h.boundary();
  assert.equal(h.ctx.terminalCommandState.get(h.tabId).runSeq, 8);
  const fresh = h.ctx.projectCodexRuntimeSnapshotFromEvents(h.tabId);
  assert.equal(fresh.readSessionId, null, 'canonical fresh read must already reject new generation');
  const result = await h.read();
  assert.equal(result.status, 409, 'batch cache retained the stale read owner although canonical owner was revoked');
  assert.equal(result.body.error, 'history_read_identity_unavailable');
  assert.equal(h.reads(), reads, 'unknown must fail before reading transcript');
  assert.notEqual(h.ctx.codexRuntimeProjectionStore.read(h.tabId), cached);
  assert.equal(h.ctx.codexRuntimeProjectionStore.read(h.tabId).runtimeProjectionReason, 'shell-command-generation-started');
  assert.deepEqual(h.inputEffects, []);
});

test('bare OSC-B with an existing Codex snapshot revokes it; renderer edge already sees the new level', async t => {
  const h = await createOscReadFixture(t);
  let publishedAtEdge;
  h.ctx.mainWindow.webContents.send = channel => {
    if (channel === 'terminal:command-started') publishedAtEdge = h.ctx.codexRuntimeProjectionStore.read(h.tabId);
  };
  h.boundary(null);
  assert.equal(publishedAtEdge.readSessionId, null);
  assert.equal((await h.read()).status, 409);
});

test('marked Codex creates a current unknown snapshot even without a previous batch; ordinary shell does not', async t => {
  const h = await createOscReadFixture(t);
  h.ctx.codexRuntimeProjectionStore.remove(h.tabId);
  h.boundary(null);
  assert.equal(h.ctx.codexRuntimeProjectionStore.read(h.tabId), null, 'ordinary shell with no Codex snapshot must not materialize one');
  h.boundary('codex');
  assert.ok(h.ctx.codexRuntimeProjectionStore.read(h.tabId));
  assert.equal(h.ctx.codexRuntimeProjectionStore.read(h.tabId).readSessionId, null);
});

test('owner loss during actual transcript IO is rejected by existing late HTTP recheck', async t => {
  const h = await createOscReadFixture(t);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { entered = resolve; });
  h.holdRead(async () => { entered(); await held; });
  const pending = h.read(); await observed; h.boundary(); release();
  const result = await pending;
  assert.equal(result.status, 409); assert.equal(result.body.error, 'history_read_identity_changed');
  assert.equal(result.body.previousReadSessionId, h.sessionId); assert.equal(result.body.readSessionId, null);
});

test('new exact Resume observation restores read only, not the old generation or a writer', async t => {
  const h = await createOscReadFixture(t); h.boundary();
  assert.equal((await h.read()).status, 409);
  const next = h.installReadOwner();
  assert.equal(next.lifecycleGeneration, 'G:8'); assert.equal(next.readSessionId, h.sessionId);
  const result = await h.read(); assert.equal(result.status, 200);
  assert.equal(result.body.writerConfirmed, false); assert.equal(result.body.writerSessionId, null);
  // Existing exact idle Resume has its own guarded native-Rewind capability;
  // a read verdict still must not upgrade destructive source rewrite/delete.
  assert.equal(next.canNativeRewind, true); assert.equal(next.canRewriteHistory, false);
  assert.equal(next.canDeleteHistory, false); assert.equal(next.writerUsableForMutation, false);
});

test('post-Enter UNKNOWN barrier remains authoritative even when matching source observation returns', async t => {
  const h = await createOscReadFixture(t);
  const barrier = h.ctx.armCodexReadIdentitySubmitBarrier(h.tabId, 'fixture-no-input');
  assert.ok(barrier); h.ctx.markCodexReadIdentitySubmitWritten(h.tabId, barrier, 'controlled-enter-proof');
  h.ctx.publishCodexRuntimeProjection(h.tabId, 'fixture-submit-barrier');
  assert.equal((await h.read()).status, 409);
  assert.equal(h.ctx.clearCodexReadIdentitySubmitBarrier(h.tabId, barrier), false);
  assert.equal(h.ctx.codexRuntimeProjectionStore.read(h.tabId).readIdentityReason, 'submit-resolution-pending');
  const status = await h.status();
  assert.equal(status.status, 200); assert.equal(status.body.readSessionId, null);
  assert.equal(status.body.writerConfirmed, false); assert.equal(status.body.writerUsableForMutation, false);
  assert.deepEqual(h.inputEffects, [], 'the control marker does not perform a physical Send');
});

for (const [label, change] of [
  ['terminal replacement', h => h.ctx.terminals.set(h.tabId, { pid: 10003 })],
  ['foreign Resume launch', h => { h.ctx.codexSessionDiscoveryIntents.get(h.tabId).launchId = 'foreign'; }],
  ['foreign persisted source', h => h.replaceSaved('foreign-source')],
  ['incompatible source lifecycle', h => { h.ctx.codexTurnWatchers.get(h.tabId).processGeneration = 'foreign:7'; }],
  ['missing process-open proof', h => { h.ctx.codexProvisionalSourceObservations.get(h.tabId).pids = []; }],
]) test(label + ' remains unavailable under the unchanged canonical read resolver', async t => {
  const h = await createOscReadFixture(t); change(h);
  const projected = h.ctx.publishCodexRuntimeProjection(h.tabId, 'fixture-owner-change');
  assert.equal(projected.readSessionId, null); assert.equal(projected.writerConfirmed, false);
  assert.equal((await h.read()).status, 409);
  const status = await h.status();
  assert.equal(status.status, 200); assert.equal(status.body.readSessionId, null);
  assert.equal(status.body.writerConfirmed, false); assert.equal(status.body.writerSessionId, null);
});

test('actual public status uses SAME Main canonical ctx, overrides stale renderer positives and does not read History', async t => {
  const h = await createOscReadFixture(t);
  h.web.bridgeRequest = async () => ({ toolType: 'codex', sessionId: 'foreign-writer', codexSessionId: 'foreign-writer',
    readSessionId: 'foreign-read', writerSessionId: 'foreign-writer', writerConfirmed: true,
    writerUsableForMutation: true, inputReady: true, status: 'busy' });
  const status = await h.status();
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.coherent, true); assert.equal(status.body.readSessionId, h.sessionId);
  assert.equal(status.body.sessionId, null); assert.equal(status.body.writerSessionId, null);
  assert.equal(status.body.writerConfirmed, false); assert.equal(status.body.writerUsableForMutation, false);
  assert.equal(status.body.sendTarget, null); assert.equal(h.reads(), 0);
  assert.deepEqual(h.inputEffects, []);
});

test('actual public status rechecks OSC owner loss during held process lookup before returning a read SID', async t => {
  const h = await createOscReadFixture(t);
  let entered, release, calls = 0;
  const observed = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  h.holdStatus(async () => { if (++calls === 1) { entered(); await held; } });
  const pending = h.status(); await observed; h.boundary(); release();
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.readSessionId, null); assert.equal(result.body.codexReadSessionId, null);
  assert.equal(result.body.writerConfirmed, false); assert.equal(result.body.lifecycleGeneration, 'G:8');
  assert.equal(result.body.terminalRunSeq, 8); assert.equal(calls, 2);
  assert.equal((await h.read()).status, 409); assert.equal(h.reads(), 0);
});

for (const fence of ['input', 'Stop', 'terminal']) test('actual status bounds repeated ' + fence + ' churn; no fallback positive', async t => {
  const h = await createOscReadFixture(t); let calls = 0;
  h.holdStatus(() => {
    calls++;
    if (fence === 'input') h.ctx.terminalInputRevisions.set(h.tabId, calls);
    else if (fence === 'Stop') h.ctx.terminalStopRevisions.set(h.term, calls);
    else h.ctx.terminals.set(h.tabId, { pid: 10003 + calls });
  });
  const status = await h.status();
  assert.equal(status.status, 503); assert.equal(status.body.error, 'runtime_snapshot_unstable');
  assert.equal(status.body.runtimeStateUnknown, true); assert.equal(calls, 2);
  assert.equal(h.reads(), 0); assert.deepEqual(h.inputEffects, []);
});

test('missing paired public Main reader refuses old base and saved SID', async t => {
  const h = await createOscReadFixture(t); h.web.readAgentRuntimeSnapshot = null;
  const status = await h.status();
  assert.equal(status.status, 503); assert.equal(status.body.error, 'runtime_snapshot_unavailable');
  assert.equal(status.body.runtimeStateUnknown, true); assert.equal(status.body.readSessionId, undefined);
  assert.equal(h.reads(), 0); assert.deepEqual(h.inputEffects, []);
});

test('batch remains O(1) after synchronous producer update, no fresh process lookup on each GET', async t => {
  const h = await createOscReadFixture(t); h.boundary();
  const frozen = h.ctx.codexRuntimeProjectionStore.read(h.tabId), before = plain(frozen);
  h.ctx.projectCodexRuntimeSnapshotFromEvents = () => { throw Error('no per-request recompute'); };
  for (let i = 0; i < 3; i++) {
    assert.equal(h.ctx.getCodexRuntimeProjectionBatch([{ tabId: h.tabId }], 'P')[h.tabId], frozen);
    assert.equal((await h.read()).status, 409);
  }
  assert.deepEqual(plain(frozen), before);
});
