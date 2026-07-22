'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TabHistoryRestoreLeases } = require('./tab-history-restore-leases');

function createFixture() {
  const rows = new Map([
    [11, { id: 11, project_id: 'project-a', name: 'older' }],
    [12, { id: 12, project_id: 'project-a', name: 'latest' }],
    [21, { id: 21, project_id: 'project-b', name: 'other project' }],
  ]);
  let tokenSequence = 0;

  const manager = new TabHistoryRestoreLeases({
    getLatest: (projectId) => Array.from(rows.values())
      .filter((row) => row.project_id === projectId)
      .sort((left, right) => right.id - left.id)[0] || null,
    getById: (id) => rows.get(id) || null,
    deleteById: (id) => rows.delete(id),
    token: () => `lease-${++tokenSequence}`,
  });

  return { manager, rows };
}

test('failed restore releases its lease and retains the history entry', () => {
  const { manager, rows } = createFixture();
  const lease = manager.begin({ projectId: 'project-a' });

  assert.equal(lease.ok, true);
  assert.equal(lease.id, 12);
  assert.equal(rows.has(12), true, 'begin must be non-destructive');

  assert.deepEqual(manager.finish({
    projectId: 'project-a',
    id: lease.id,
    token: lease.token,
    commit: false,
  }), { ok: true, committed: false, id: 12 });
  assert.equal(rows.has(12), true);
});

test('successful restore deletes the history entry only on commit', () => {
  const { manager, rows } = createFixture();
  const lease = manager.begin({ projectId: 'project-a', id: 11 });

  assert.equal(lease.ok, true);
  assert.equal(rows.has(11), true);

  assert.deepEqual(manager.finish({
    projectId: 'project-a',
    id: lease.id,
    token: lease.token,
    commit: true,
  }), { ok: true, committed: true, id: 11 });
  assert.equal(rows.has(11), false);
});

test('a failed commit releases the lease but reports that history was not consumed', () => {
  const row = { id: 31, project_id: 'project-a', name: 'kept' };
  const manager = new TabHistoryRestoreLeases({
    getLatest: () => row,
    getById: () => row,
    deleteById: () => false,
    token: () => 'lease-delete-failed',
  });
  const lease = manager.begin({ projectId: 'project-a', id: 31 });

  assert.deepEqual(manager.finish({
    projectId: 'project-a',
    id: 31,
    token: lease.token,
    commit: true,
  }), { ok: false, reason: 'delete_failed', committed: false, id: 31 });

  assert.equal(manager.begin({ projectId: 'project-a', id: 31 }).ok, true);
});

test('concurrent begin for the same history entry is rejected as busy', () => {
  const { manager, rows } = createFixture();
  const first = manager.begin({ projectId: 'project-a' });
  const second = manager.begin({ projectId: 'project-a' });

  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'busy', id: 12 });
  assert.equal(rows.has(12), true);
});

test('a cancelled restore can be retried with a new lease token', () => {
  const { manager } = createFixture();
  const first = manager.begin({ projectId: 'project-a' });
  manager.finish({
    projectId: 'project-a',
    id: first.id,
    token: first.token,
    commit: false,
  });

  const retry = manager.begin({ projectId: 'project-a' });
  assert.equal(retry.ok, true);
  assert.equal(retry.id, first.id);
  assert.notEqual(retry.token, first.token);
});

test('wrong project or token cannot finish or release another lease', () => {
  const { manager, rows } = createFixture();
  const lease = manager.begin({ projectId: 'project-a', id: 12 });

  assert.deepEqual(manager.finish({
    projectId: 'project-b',
    id: lease.id,
    token: lease.token,
    commit: true,
  }), { ok: false, reason: 'project_mismatch' });
  assert.deepEqual(manager.finish({
    projectId: 'project-a',
    id: lease.id,
    token: 'wrong-token',
    commit: true,
  }), { ok: false, reason: 'token_mismatch' });
  assert.equal(rows.has(12), true);

  assert.deepEqual(manager.begin({ projectId: 'project-a', id: 12 }), {
    ok: false,
    reason: 'busy',
    id: 12,
  });
  assert.equal(manager.finish({
    projectId: 'project-a',
    id: lease.id,
    token: lease.token,
    commit: false,
  }).ok, true);
});

test('begin by id rejects a history entry owned by another project', () => {
  const { manager, rows } = createFixture();

  assert.deepEqual(manager.begin({ projectId: 'project-a', id: 21 }), {
    ok: false,
    reason: 'project_mismatch',
    id: 21,
  });
  assert.equal(rows.has(21), true);
});

test('an abandoned lease expires so renderer reload cannot block history forever', () => {
  let now = 1_000;
  const row = { id: 41, project_id: 'project-a', name: 'retry after reload' };
  const manager = new TabHistoryRestoreLeases({
    getLatest: () => row,
    getById: () => row,
    deleteById: () => true,
    token: () => `lease-${now}`,
    now: () => now,
    leaseTtlMs: 100,
  });

  const abandoned = manager.begin({ projectId: 'project-a', id: 41 });
  now += 100;
  const retry = manager.begin({ projectId: 'project-a', id: 41 });

  assert.equal(retry.ok, true);
  assert.notEqual(retry.token, abandoned.token);
  assert.deepEqual(manager.finish({
    projectId: 'project-a',
    id: 41,
    token: abandoned.token,
    commit: false,
  }), { ok: false, reason: 'token_mismatch' });
});
