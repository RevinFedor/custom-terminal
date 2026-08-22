'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateForceCleanupTabIds } = require('./save-tabs-precondition');

test('ordinary snapshots do not require a destructive precondition', () => {
  assert.deepEqual(validateForceCleanupTabIds({ forceCleanup: false }), { ok: true });
  assert.equal(validateForceCleanupTabIds({
    forceCleanup: false,
    expectedTabIds: ['renderer'],
    actualTabIds: ['database'],
  }).error, 'force_cleanup_tab_snapshot_conflict');
});

test('force cleanup requires the exact current DB tab identity set', () => {
  assert.equal(validateForceCleanupTabIds({
    forceCleanup: true,
    actualTabIds: ['a'],
  }).error, 'force_cleanup_expected_tab_ids_required');
  assert.deepEqual(validateForceCleanupTabIds({
    forceCleanup: true,
    expectedTabIds: ['b', 'a'],
    actualTabIds: ['a', 'b'],
  }), { ok: true });
  assert.deepEqual(validateForceCleanupTabIds({
    forceCleanup: true,
    expectedTabIds: ['only-renderer-tab'],
    actualTabIds: ['a', 'b'],
  }), {
    ok: false,
    error: 'force_cleanup_tab_snapshot_conflict',
    expectedTabIds: ['only-renderer-tab'],
    actualTabIds: ['a', 'b'],
  });
});
