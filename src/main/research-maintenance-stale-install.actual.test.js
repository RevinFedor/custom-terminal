'use strict';

// Scar 01Nov: a Noted install died after quitting the app and left its
// maintenance window `active`. Every later Noted startup handover then failed
// `begin` with research_maintenance_busy, so the orchestration store never
// gained authority: AutoResume, Resume, Sends and even the operator `complete`
// that should clear it all failed with "Another planned maintenance operation
// is active". The user's own reinstall could not recover it.
//
// These cases run the REAL OrchestrationRunStore over a private JSON file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OrchestrationRunStore } = require('./orchestration-runs');
const policy = require('./external-research-maintenance');

const DEAD = 'install:noted:continue:3b09b59d-7dcd-44ed-82f9-88521c2c44e7';
const REINSTALL = 'install:noted:432ed5e8-a2c8-417a-9701-58d434a443f5';
const SC = 'install:sc-abort-control:20261021-753-ZkoVWb';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-maintenance-stale-'));
  const file = path.join(root, 'orchestration-runs.json');
  const stores = [];
  const open = (options = {}) => {
    const store = new OrchestrationRunStore(file, options);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) { try { await store.flush(); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { open };
}

// The dead installer's begin, exactly as the live app recorded it before Quit.
async function leaveActive(f, operationId) {
  const seed = f.open();
  await seed.transitionResearchMaintenance({ action: 'begin', operationId });
  await seed.flush();
}

test('a reinstall after a dead Noted install gains store authority (01Nov incident)', async t => {
  const f = fixture(t);
  await leaveActive(f, DEAD);

  const reinstall = f.open({ startupMaintenance: { version: 1, operationId: REINSTALL } });
  await reinstall.initialize({ requireAuthority: true });

  const state = await reinstall.getResearchMaintenance();
  assert.equal(state.activeOperationId, REINSTALL, 'the new install owns the window');
  assert.equal(state.startup.operationId, REINSTALL);
  assert.equal(state.startup.durable, true);
  assert.equal(state.startup.beforeRestore, true);
  const dead = state.operations.find(o => o.operationId === DEAD);
  assert.equal(dead.state, 'completed', 'the dead window is closed, not deleted');
  assert.ok(dead.completedAt >= dead.startedAt);

  // The installer can now finish its own operation through the normal path.
  await reinstall.transitionResearchMaintenance({ action: 'complete', operationId: REINSTALL });
  assert.equal((await reinstall.getResearchMaintenance()).activeOperationId, null);
});

test('the closed dead window survives restart and an old begin cannot reopen it', async t => {
  const f = fixture(t);
  await leaveActive(f, DEAD);
  const reinstall = f.open({ startupMaintenance: { version: 1, operationId: REINSTALL } });
  await reinstall.initialize({ requireAuthority: true });
  await reinstall.transitionResearchMaintenance({ action: 'complete', operationId: REINSTALL });
  await reinstall.flush();

  const normal = f.open();
  const reread = await normal.getResearchMaintenance();
  assert.equal(reread.activeOperationId, null);
  assert.equal(reread.operations.find(o => o.operationId === DEAD).state, 'completed');

  const replay = await normal.transitionResearchMaintenance({ action: 'begin', operationId: DEAD });
  assert.equal(replay.repeated, true);
  assert.equal(replay.operation.state, 'completed');
  assert.equal((await normal.getResearchMaintenance()).activeOperationId, null, 'old begin does not reopen');
});

test('another app maintenance window keeps its busy guard', async t => {
  const f = fixture(t);
  await leaveActive(f, SC);
  const reinstall = f.open({ startupMaintenance: { version: 1, operationId: REINSTALL } });
  await assert.rejects(() => reinstall.initialize({ requireAuthority: true }),
    error => error.code === 'research_maintenance_busy');
});

test('the same install handover is unchanged (repeated begin, no supersede)', async t => {
  const f = fixture(t);
  await leaveActive(f, REINSTALL);
  const same = f.open({ startupMaintenance: { version: 1, operationId: REINSTALL } });
  await same.initialize({ requireAuthority: true });
  const state = await same.getResearchMaintenance();
  assert.equal(state.activeOperationId, REINSTALL);
  assert.equal(state.operations.filter(o => o.state === 'completed').length, 0);
});

test('policy: only a different active Noted install is superseded', () => {
  const base = { version: 1, operations: [{ operationId: DEAD, kind: 'build-install', state: 'active', startedAt: 10 }] };
  const hit = policy.supersedeStaleNotedInstall(base, REINSTALL, 50);
  assert.equal(hit.superseded, DEAD);
  assert.equal(policy.activeId(hit.value), null);
  assert.equal(hit.value.operations[0].completedAt, 50);
  assert.equal(base.operations[0].state, 'active', 'input value is not mutated');

  assert.equal(policy.supersedeStaleNotedInstall(base, DEAD).superseded, null, 'own operation');
  assert.equal(policy.supersedeStaleNotedInstall(base, 'install:sc-x:1').superseded, null, 'non-Noted startup');
  const sc = { version: 1, operations: [{ operationId: SC, kind: 'build-install', state: 'active', startedAt: 10 }] };
  assert.equal(policy.supersedeStaleNotedInstall(sc, REINSTALL).superseded, null, 'non-Noted active window');
  assert.equal(policy.supersedeStaleNotedInstall({ version: 1, operations: [] }, REINSTALL).superseded, null);

  const clock = policy.supersedeStaleNotedInstall(base, REINSTALL, 5);
  assert.equal(clock.value.operations[0].completedAt, 10, 'completedAt never precedes startedAt');
});
