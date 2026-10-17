'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeSnapshotCompletionFixture } = require('./test-helpers/runtime-snapshot-completion');
const { messageRuntimeIdentity } = require('./agent-message-identity');

function fixture() {
  const h = runtimeSnapshotCompletionFixture({ tabId: 'follower', sessionId: 'saved-source' });
  h.state.busy = true;
  h.state.reconciles = 0;
  h.state.afterReconcile = null;
  h.state.publishWriter = true;
  h.context.getCodexRuntimeSessionSnapshot = async (_id, options) => {
    assert.equal(options.reason, 'public-runtime-unconfirmed-writer');
    h.state.reconciles++;
    if (h.state.publishWriter) h.adopt();
    await h.state.afterReconcile?.();
    return { sessionStatus: 'busy', liveLifecycle: true, inputReady: true,
      sessionId: null, savedSessionId: 'saved-source', writerConfirmed: false,
      writerError: 'older-canonical-observation', writerFilePath: null };
  };
  return h;
}

test('native-v2 same writer strengthens during reconcile without spending an owner retry on semantics', async () => {
  const h = fixture();
  h.state.onLookup = ordinal => { if (ordinal === 2) h.cleanupLaunch(); };
  const result = await h.snapshot();
  assert.equal(result.sessionId, 'saved-source');
  assert.equal(result.sendTarget.sessionId, 'saved-source');
  assert.equal(result.codexSessionId, 'saved-source');
  assert.equal(result.writerConfirmed, true);
  assert.equal(result.writerError, undefined, 'stale canonical error is not carried into the fresh readiness projection');
  assert.equal(result.coherent, true);
  assert.equal(h.state.lookups, 1, 'semantic publication must not trigger another process lookup');
  assert.equal(h.state.reconciles, 1);
  assert.ok(h.logs.some(line => line.includes('refresh-after-reconcile')));
});

test('cleanup inside canonical await still uses the existing second physical pass, not a third', async () => {
  const h = fixture();
  h.state.afterReconcile = () => h.cleanupLaunch();
  const result = await h.snapshot();
  assert.equal(result.sessionId, 'saved-source');
  assert.equal(h.state.lookups, 2);
  assert.equal(h.state.reconciles, 1);
  assert.ok(h.logs.some(line => line.includes('codexLaunchId')));
});

test('same-owner turn/settings/Goal semantic progress uses current event projection', async () => {
  const h = fixture();
  const projection = h.context.projectCodexRuntimeSnapshotFromEvents;
  h.context.projectCodexRuntimeSnapshotFromEvents = (...args) => ({ ...projection(...args),
    goalWork: { pending: true, phase: 'continuing' }, model: 'current-model', effort: 'current-effort' });
  h.state.afterReconcile = () => { h.state.turn = 'current-turn'; h.state.proofAt++; };
  const result = await h.snapshot();
  assert.equal(result.sendTarget.turnId, 'current-turn');
  assert.equal(result.goalWork.pending, true); assert.equal(result.goalWork.phase, 'continuing');
  assert.equal(result.model, 'current-model'); assert.equal(result.effort, 'current-effort');
  assert.equal(h.state.lookups, 1);
});

for (const axis of ['stop', 'input', 'terminal', 'run', 'lifecycle', 'launch', 'project', 'cwd', 'owner', 'binding']) {
  test(axis + ' change during canonical await cannot be relabelled as semantic strengthening', async () => {
    const h = fixture();
    h.state.onLookup = () => { h.state.writer = null; };
    h.state.afterReconcile = () => {
      if (axis === 'stop') h.state.stop++;
      if (axis === 'input') h.state.input++;
      if (axis === 'terminal') h.context.terminals.set('follower', { pid: 100 + h.state.reconciles });
      if (axis === 'run') h.command.runSeq++;
      if (axis === 'lifecycle') h.state.generation += 'x';
      if (axis === 'launch') h.context.codexLastRunCommandPayload.set('follower', { launchId: 'new-' + h.state.reconciles });
      if (axis === 'project') h.context.terminalProjectIds.set('follower', 'project-' + h.state.reconciles);
      if (axis === 'cwd') h.context.terminalProjects.set('follower', '/other-' + h.state.reconciles);
      if (axis === 'owner') h.state.owner++;
      if (axis === 'binding') h.state.sessionId += 'x';
    };
    await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
    assert.equal(h.state.lookups, 2); assert.equal(h.state.reconciles, 2);
  });
}

test('single replacement is freshly observed; an original pinned conversation still refuses it', async () => {
  const h = fixture();
  h.state.afterReconcile = () => { h.state.sessionId = 'other-conversation'; h.state.owner++; h.adopt(); };
  const result = await h.snapshot();
  assert.equal(result.sessionId, 'other-conversation');
  assert.equal(h.state.lookups, 2);
  const target = messageRuntimeIdentity({ tabId: 'follower' }, result);
  assert.notEqual(target.sessionId, 'saved-source');
  assert.equal(require('./agent-send-target-precondition').agentSendTargetPreconditionFailure(
    { toolType: 'codex', sessionId: 'saved-source' }, result.sendTarget).code, 'agent_send_target_changed');
});

for (const process of ['unknown', 'found']) test(process + ' without writer never borrows saved SID', async () => {
  const h = fixture(); h.state.publishWriter = false; h.state.process = process;
  const result = await h.snapshot();
  assert.equal(result.writerConfirmed, false);
  assert.equal(result.sessionId, null); assert.equal(result.sendTarget.sessionId, null);
  assert.equal(result.canResume, false);
  assert.throws(() => messageRuntimeIdentity({ tabId: 'follower' }, result), { code: 'message_runtime_identity_unavailable' });
  assert.equal(h.state.reconciles, process === 'found' ? 1 : 0);
});

test('known but unusable writer is not accepted by semantic refresh', async () => {
  const h = fixture();
  h.context.isCodexWriterUsableForMutation = () => false;
  h.state.onLookup = ordinal => { if (ordinal === 2) h.state.input++; };
  await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
  assert.equal(h.state.lookups, 2);
});

for (const change of ['revoked', 'different-writer', 'mismatched-projection', 'negative-projection']) {
  test('refresh requires the current usable writer and matching projection: ' + change, async () => {
    const h = fixture(), projection = h.context.projectCodexRuntimeSnapshotFromEvents;
    h.state.onLookup = () => { h.state.writer = null; };
    h.context.projectCodexRuntimeSnapshotFromEvents = (...args) => {
      const value = projection(...args);
      if (h.state.writer) {
        if (change === 'revoked') h.state.writer = null;
        if (change === 'different-writer') h.state.writer = { ...h.state.writer, sessionId: 'foreign' };
        if (change === 'mismatched-projection') return { ...value, sessionId: 'foreign' };
        if (change === 'negative-projection') return { ...value, writerConfirmed: false };
      }
      return value;
    };
    await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
    assert.equal(h.state.lookups, 2);
    assert.ok(h.logs.some(line => line.includes('reconcile-writer-changed')));
  });
}

for (const axis of ['stop', 'input', 'binding']) test('final check remains after the refreshed projection: ' + axis, async () => {
  const h = fixture(); const projection = h.context.projectCodexRuntimeSnapshotFromEvents;
  h.state.onLookup = () => { h.state.writer = null; };
  h.context.projectCodexRuntimeSnapshotFromEvents = (...args) => {
    const value = projection(...args);
    if (h.state.writer) {
      if (axis === 'stop') h.state.stop++;
      if (axis === 'input') h.state.input++;
      if (axis === 'binding') h.state.sessionId += 'x';
    }
    return value;
  };
  await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
  assert.equal(h.state.lookups, 2);
});
