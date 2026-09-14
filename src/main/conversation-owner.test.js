'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationOwners } = require('./conversation-owner');
const { SavedHistoryOperations } = require('./saved-history-operation');
const { validateStructuredSendEnvelope } = require('./structured-authoring');
const clone = x => JSON.parse(JSON.stringify(x));

function fixture(provider = 'claude', sessionId = 'S') {
  const rows = new Map(), events = [];
  const state = { known: true, provider, sessionId, projectId: 'P', cwd: '/fixture',
    instanceId: 'main-1', terminalId: 'pty-1', launchId: null };
  const db = { getAppState: key => rows.has(key) ? clone(rows.get(key)) : null,
    setAppState: (key, value) => rows.set(key, clone(value)), db: { transaction: fn => () => {
      const before = new Map(rows);
      try { return fn(); } catch (error) { rows.clear(); for (const [key, value] of before) rows.set(key, value); throw error; }
    } } };
  const owner = new ConversationOwners({ db, capture: () => state, instanceId: 'main-1', publish: (_tab, proof) => events.push(proof) });
  function commit(operationId = 'O', cleared = false) {
    state.sessionId = cleared ? null : 'S';
    const operation = { operationId, toolType: provider, revision: 11, state: 'completed', success: true,
      bindingCommitted: true, activeSessionId: state.sessionId, fileDeleted: cleared,
      ...(cleared ? { binding: { applied: true, mode: 'cleared', sessionId: null } } : {}) };
    operation.ownerCheckpoint = owner.checkpoint('T', operation, state);
    return operation;
  }
  return { state, rows, db, events, owner, commit };
}

for (const provider of ['claude', 'codex']) {
  test(provider + ': O -> own Resume carries checkpoint, B on SAME SID/process supersedes immutable O', () => {
    const f = fixture(provider), operation = f.commit(), bytes = JSON.stringify(operation);
    assert.equal(f.owner.applicability('T', operation, 11).applicability.verdict, 'applicable');
    f.owner.prepareResume('T', 'O', operation.ownerCheckpoint);
    f.state.launchId = 'own-L';
    assert.equal(f.owner.current('T').currentBinding.state, 'unknown');
    f.owner.carryResume('T', 'O', operation.ownerCheckpoint, f.state);
    assert.equal(f.owner.applicability('T', operation).applicability.verdict, 'applicable');
    const beforeB = f.owner.current('T');
    f.owner.noteInput('T');
    const afterB = f.owner.applicability('T', operation).applicability;
    assert.equal(afterB.verdict, 'superseded');
    assert.equal(afterB.currentBinding.sessionId, 'S');
    assert.equal(afterB.ownerOrder.epoch, beforeB.ownerOrder.epoch);
    assert.ok(afterB.ownerOrder.revision > beforeB.ownerOrder.revision);
    assert.notEqual(afterB.ownerToken, beforeB.ownerToken);
    assert.equal(JSON.stringify(operation), bytes);
  });
}

for (const field of ['sessionId', 'provider', 'projectId', 'cwd', 'launchId', 'terminalId', 'runSeq']) {
  test('foreign ' + field + ' supersedes O', () => {
    const f = fixture(); f.state.launchId = 'L'; const operation = f.commit();
    f.state[field] = field === 'provider' ? 'codex' : 'other';
    assert.equal(f.owner.applicability('T', operation).applicability.verdict, 'superseded');
  });
}

test('unknown observation is not empty or superseded; a later known snapshot restores the same checkpoint', () => {
  const f = fixture(), operation = f.commit();
  const before = f.owner.current('T'); f.state.known = false;
  const unknown = f.owner.applicability('T', operation).applicability;
  assert.equal(unknown.verdict, 'unknown'); assert.equal(unknown.currentBinding.state, 'unknown');
  assert.equal(unknown.ownerToken, before.ownerToken);
  f.state.known = true;
  const after = f.owner.applicability('T', operation).applicability;
  assert.equal(after.verdict, 'applicable'); assert.ok(after.ownerOrder.revision > unknown.ownerOrder.revision);
});

test('null without exact clear never produces known-none; historical receipt without checkpoint stays unknown', () => {
  const f = fixture('claude', null);
  assert.equal(f.owner.current('T').currentBinding.state, 'unknown');
  assert.equal(f.owner.applicability('T', { operationId: 'old', revision: 8 }).applicability.verdict, 'unknown');
  assert.throws(() => f.owner.checkpoint('T', { operationId: 'O', toolType: 'claude', bindingCommitted: true }, f.state), /unproven/);
});

test('strict none envelope is explicit and opt-in; legacy null remains a wildcard, never a known-empty claim', () => {
  const body = { expectedToolType: 'claude', expectedSessionId: null, authoring: { version: 1, text: 'draft' } };
  assert.doesNotThrow(() => validateStructuredSendEnvelope(body));
  assert.doesNotThrow(() => validateStructuredSendEnvelope({ ...body, expectedBinding: 'none', ownerToken: 'token' }));
  for (const patch of [{ expectedBinding: 'none' }, { ownerToken: 'token' }, { expectedBinding: 'none', ownerToken: '' },
    { expectedBinding: 'none', ownerToken: 'token', expectedSessionId: 'S' },
    { expectedBinding: 'none', ownerToken: 'token', expectedToolType: 'codex' }]) {
    assert.throws(() => validateStructuredSendEnvelope({ ...body, ...patch }));
  }
});

test('exact clear persists across owner reopen; old launch is not reused as a new owner', () => {
  const f = fixture(), operation = f.commit('O', true);
  const before = f.owner.current('T');
  const reopened = new ConversationOwners({ db: f.db, capture: () => ({ ...f.state, instanceId: 'main-2', terminalId: 'pty-2' }), instanceId: 'main-2' });
  const after = reopened.applicability('T', operation).applicability;
  assert.equal(after.verdict, 'applicable'); assert.equal(after.currentBinding.state, 'none');
  assert.equal(after.ownerToken, before.ownerToken); assert.deepEqual(after.ownerOrder, before.ownerOrder);
});

test('missing current-owner storage is unknown, not evidence of B or permission to recreate the old clear', () => {
  const f = fixture(), operation = f.commit('O', true);
  for (const key of f.rows.keys()) if (key.startsWith('conversation-owner.')) f.rows.delete(key);
  const result = f.owner.applicability('T', operation).applicability;
  assert.equal(result.verdict, 'unknown'); assert.equal(result.currentBinding.state, 'unknown');
});

test('strict none Send claims once, inherits its own first launch/binding, later B and other attempts fail', () => {
  const f = fixture(), operation = f.commit('O', true);
  const expected = { expectedBinding: 'none', toolType: 'claude', ownerToken: f.owner.current('T').ownerToken };
  const request = { sendOperationKey: 'project:T:H', sendAttemptId: 'A' };
  f.owner.assertNone('T', expected);
  const claimed = f.owner.claimSend('T', expected, request);
  assert.equal(f.owner.applicability('T', operation).applicability.verdict, 'superseded');
  assert.deepEqual(f.owner.claimSend('T', expected, request), claimed);
  assert.throws(() => f.owner.claimSend('T', expected, { ...request, sendAttemptId: 'B' }), /binding_changed/);
  f.owner.beforeLaunch('T', expected, request); f.state.launchId = 'own-L';
  assert.equal(f.owner.current('T').currentBinding.state, 'unknown');
  f.owner.claimLaunch('T', expected, request, f.state);
  f.owner.launchWritten('T', expected, request, f.state);
  f.state.sessionId = 'fresh-real-provider-SID';
  f.owner.assertNone('T', expected, request);
  assert.equal(f.owner.current('T').currentBinding.sessionId, 'fresh-real-provider-SID');
  f.owner.noteInput('T', request); f.owner.assertNone('T', expected, request);
  assert.throws(() => f.owner.beforeLaunch('T', expected, request), /launch_changed/);
  f.owner.noteInput('T');
  assert.throws(() => f.owner.assertNone('T', expected, request), /binding_changed/);
});

test('foreign launch before strict claim and at write is rejected; restart cannot revive a pending Send claim', () => {
  for (const when of ['before-claim', 'after-claim', 'restart']) {
    const f = fixture(); f.commit('O', true);
    const expected = { expectedBinding: 'none', toolType: 'claude', ownerToken: f.owner.current('T').ownerToken };
    const request = { sendOperationKey: 'K', sendAttemptId: 'A' };
    if (when !== 'before-claim') f.owner.claimSend('T', expected, request);
    if (when !== 'restart') { f.state.launchId = 'foreign'; f.state.sessionId = 'B'; }
    const owner = when === 'restart' ? new ConversationOwners({ db: f.db, capture: () => f.state, instanceId: 'other-main' }) : f.owner;
    assert.throws(() => owner.beforeLaunch('T', expected, request), /binding_changed/);
  }
});

test('operation revision is checked and old receipt read never captures runtime or mutates the result', () => {
  const f = fixture(), operation = f.commit();
  const registry = new SavedHistoryOperations({ db: f.db, runtime: { owner: f.owner, capture: () => { throw Error('not needed for receipt'); } } });
  f.db.setAppState(registry.key('T', 'O'), operation);
  const before = JSON.stringify(registry.read('T', 'O')); f.owner.noteInput('T');
  assert.equal(JSON.stringify(registry.read('T', 'O')), before);
  assert.equal(registry.applicability('T', 'O', 11).applicability.verdict, 'superseded');
  assert.throws(() => registry.applicability('T', 'O', 10), /revision_changed/);
});

test('a different accepted saved operation supersedes the preceding result before its asynchronous work; same-ID replay does not', () => {
  const f = fixture('codex'), operation = f.commit();
  const registry = new SavedHistoryOperations({ db: f.db, runtime: { owner: f.owner }, dispatch: async () => {} });
  const request = { operationId: 'O', kind: 'rewind', expectedSessionId: 'S', targetUuid: 'U' };
  const { normalizeSavedHistoryRequest } = require('./saved-history-operation');
  f.db.setAppState(registry.key('T', 'O'), { ...operation, request: normalizeSavedHistoryRequest('T', request) });
  assert.equal(registry.accept('T', request).idempotent, true);
  assert.equal(f.owner.applicability('T', operation).applicability.verdict, 'applicable');
  registry.accept('T', { ...request, operationId: 'O2' });
  assert.equal(f.owner.applicability('T', operation).applicability.verdict, 'superseded');
});

test('actual registry save commits binding/checkpoint/receipt atomically, failed DB receipt cannot publish positive proof', () => {
  for (const failReceipt of [false, true]) {
    const f = fixture();
    const registry = new SavedHistoryOperations({ db: f.db, runtime: { owner: f.owner } });
    const record = { tabId: 'T', operationId: 'O', toolType: 'claude', state: 'running', revision: 4 };
    const lease = { key: registry.key('T', 'O'), record };
    const set = f.db.setAppState;
    f.db.setAppState = (key, value) => { if (key === lease.key && failReceipt) throw Error('disk failure'); set(key, value); };
    const commit = () => registry.save(lease, { phase: 'adopted', bindingCommitted: true, activeSessionId: 'S' },
      () => f.db.setAppState('fixture-binding', 'S'));
    if (failReceipt) {
      assert.throws(commit, /disk failure/);
      assert.equal(f.db.getAppState('fixture-binding'), null); assert.equal(f.owner.stored('T'), null); assert.deepEqual(f.events, []);
    } else {
      const result = commit(); assert.ok(result.ownerCheckpoint.token);
      assert.equal(f.db.getAppState('fixture-binding'), 'S'); assert.equal(f.events.length, 1);
      assert.equal(registry.applicability('T', 'O', 5).applicability.verdict, 'applicable');
    }
  }
});
