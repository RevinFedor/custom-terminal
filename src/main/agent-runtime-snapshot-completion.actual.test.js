'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeSnapshotCompletionFixture } = require('./test-helpers/runtime-snapshot-completion');
const { scenarioDestination } = require('./agent-message-identity');

for (const process of ['found', 'unknown']) test('same-run writer adoption during ' + process + ' process read publishes current runtime without a second stale read', async () => {
  const h = runtimeSnapshotCompletionFixture();
  h.state.onLookup = ordinal => {
    if (ordinal === 1) { h.adopt(); h.state.process = process; }
    else h.cleanupLaunch();
  };
  const result = await h.snapshot();
  assert.equal(result.sessionId, 'S');
  assert.equal(scenarioDestination(result).sessionId, 'S');
  assert.equal(result.processStatus, process, 'unknown must not be promoted to found');
  assert.equal(result.canResume, false);
  assert.equal(h.state.lookups, 1, 'fresh event projection must not repeat the slow process read');
});

test('same-owner turn/settings progress during each OS read does not exhaust the owner retry limit', async () => {
  const h = runtimeSnapshotCompletionFixture(); h.adopt();
  h.state.onLookup = ordinal => { h.state.turn = 'turn-' + ordinal; h.state.proofAt++; h.state.busy = true; };
  const result = await h.snapshot();
  assert.equal(result.status, 'busy');
  assert.equal(result.sendTarget.turnId, 'turn-1');
  assert.equal(h.state.lookups, 1);
});

test('launch cleanup during the OS read still discards that process result and rereads once', async () => {
  const h = runtimeSnapshotCompletionFixture(); h.adopt();
  h.state.onLookup = ordinal => { if (ordinal === 1) h.cleanupLaunch(); };
  const result = await h.snapshot();
  assert.equal(h.state.lookups, 2); assert.equal(result.processStatus, 'found');
  assert.ok(h.logs.some(line => line.includes('process_scope_changed')));
});

for (const change of ['input', 'stop', 'terminal', 'run', 'lifecycle', 'cwd', 'owner', 'binding', 'launch']) {
  test('continual ' + change + ' changes during process reads remain bounded and cannot publish a mixed owner', async () => {
    const h = runtimeSnapshotCompletionFixture(); h.adopt();
    h.state.onLookup = ordinal => {
      if (change === 'input') h.state.input++;
      if (change === 'stop') h.state.stop++;
      if (change === 'terminal') h.context.terminals.set('T', { pid: 100 + ordinal });
      if (change === 'run') h.command.runSeq++;
      if (change === 'lifecycle') h.state.generation = 'G' + ordinal;
      if (change === 'cwd') h.context.terminalProjects.set('T', '/other-' + ordinal);
      if (change === 'owner') h.state.owner++;
      if (change === 'binding') { h.state.sessionId = 'OTHER-' + ordinal; h.state.owner++; }
      if (change === 'launch') h.context.codexLastRunCommandPayload.set('T', { launchId: 'L' + ordinal });
    };
    await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
    assert.equal(h.state.lookups, 2);
  });
}

test('one real binding replacement is reread as current; the old target is never substituted', async () => {
  const h = runtimeSnapshotCompletionFixture(); h.adopt();
  h.state.onLookup = ordinal => {
    if (ordinal === 1) { h.state.sessionId = 'OTHER'; h.state.owner++; h.adopt(); }
  };
  const result = await h.snapshot();
  assert.equal(h.state.lookups, 2);
  assert.equal(scenarioDestination(result).sessionId, 'OTHER');
});

test('progress after the final readiness read is still revalidated', async () => {
  const h = runtimeSnapshotCompletionFixture(); h.adopt(); h.state.ready = false;
  h.state.onTui = () => { h.state.input++; };
  await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
  assert.equal(h.state.lookups, 2);
});
