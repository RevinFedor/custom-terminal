import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STORAGE_GROUPS,
  formatDeleteCountdown,
  formatStorageBytes,
  selectStorageItems,
  storageSelectableIds,
  storageSelectionRangeIds,
  summarizeStorageGroups,
} from './storageBrowserModel.mjs';

const items = [
  { id: 'a', section: 'sessions', group: 'open', provider: 'codex', title: 'Alpha', sizeBytes: 10, modifiedAt: new Date(2026, 7, 16, 12).getTime(), iterations: 3, eligible: false, protected: true, deletable: false },
  { id: 'b', section: 'sessions', group: 'outside', provider: 'claude', title: 'Beta', sizeBytes: 30, modifiedAt: new Date(2026, 7, 17, 1).getTime(), iterations: 9, eligible: true, protected: false, deletable: true, path: '/tmp/b' },
  { id: 'd', section: 'sessions', group: 'outside', provider: 'codex', title: 'Delta', sizeBytes: 25, modifiedAt: new Date(2026, 7, 17, 23, 59).getTime(), iterations: 4, eligible: true, protected: false, deletable: true },
  { id: 'e', section: 'sessions', group: 'outside', provider: 'codex', title: 'Echo', sizeBytes: 5, modifiedAt: new Date(2026, 7, 18, 12).getTime(), iterations: 1, eligible: true, protected: false, deletable: true },
  { id: 'c', section: 'builds', group: 'build', provider: null, title: 'Cargo', sizeBytes: 20, modifiedAt: new Date(2026, 7, 19, 12).getTime(), iterations: null, eligible: true, protected: false, deletable: true },
];

test('provider, section, group, query, date range and sort compose deterministically', () => {
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', provider: 'all', sort: 'size' }).map((item) => item.id), ['b', 'd', 'a', 'e']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', provider: 'claude', group: 'outside' }).map((item) => item.id), ['b']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', query: '/tmp/b' }).map((item) => item.id), ['b']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', dateFrom: '2026-08-17', dateTo: '2026-08-17', sort: 'date' }).map((item) => item.id), ['d', 'b']);
  assert.deepEqual(selectStorageItems(items, { section: 'sessions', sort: 'iterations' }).map((item) => item.id), ['b', 'd', 'a', 'e']);
});

test('group summary never mixes providers or sections', () => {
  assert.deepEqual(summarizeStorageGroups(items, 'sessions', 'claude'), [
    { group: 'outside', items: 1, bytes: 30, eligibleBytes: 30 },
  ]);
});

test('selection uses the complete filtered array, not mounted virtual rows', () => {
  const visible = selectStorageItems(items, { section: 'sessions', sort: 'date' });
  assert.deepEqual(storageSelectableIds(visible), ['e', 'd', 'b']);
  assert.deepEqual(storageSelectionRangeIds(visible, 'e', 'b'), ['e', 'd', 'b']);
  assert.deepEqual(storageSelectionRangeIds(visible, 'a', 'd'), ['d', 'b']);
  assert.deepEqual(storageSelectionRangeIds(visible, 'missing', 'b'), ['b']);
});

test('byte and countdown labels use compact English UI text', () => {
  assert.equal(formatStorageBytes(1024 * 1024 * 5), '5.00 MB');
  assert.equal(formatDeleteCountdown(1_000, 2_000), 'ready to delete');
  assert.equal(formatDeleteCountdown(null, 2_000), 'kept forever');
  assert.equal(STORAGE_GROUPS.development.label, 'Dev sessions');
});
