import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDeleteCountdown,
  formatStorageBytes,
  selectStorageItems,
  summarizeStorageGroups,
} from './storageBrowserModel.mjs';

const items = [
  { id: 'a', section: 'sessions', group: 'open', provider: 'codex', title: 'Alpha', sizeBytes: 10, modifiedAt: 2, iterations: 3, eligible: false },
  { id: 'b', section: 'sessions', group: 'outside', provider: 'claude', title: 'Beta', sizeBytes: 30, modifiedAt: 1, iterations: 9, eligible: true, path: '/tmp/b' },
  { id: 'c', section: 'builds', group: 'build', provider: null, title: 'Cargo', sizeBytes: 20, modifiedAt: 3, iterations: null, eligible: true },
];

test('provider, section, group, query and sort compose deterministically', () => {
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', provider: 'all', sort: 'size' }).map((item) => item.id), ['b', 'a']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', provider: 'claude', group: 'outside' }).map((item) => item.id), ['b']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', query: '/tmp/b' }).map((item) => item.id), ['b']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', sort: 'iterations' }).map((item) => item.id), ['b', 'a']);
});

test('group summary never mixes providers or sections', () => {
  assert.deepEqual(summarizeStorageGroups(items, 'sessions', 'claude'), [
    { group: 'outside', items: 1, bytes: 30, eligibleBytes: 30 },
  ]);
});

test('byte and countdown labels use compact English UI text', () => {
  assert.equal(formatStorageBytes(1024 * 1024 * 5), '5.00 MB');
  assert.equal(formatDeleteCountdown(1_000, 2_000), 'ready to delete');
  assert.equal(formatDeleteCountdown(null, 2_000), 'kept forever');
});

