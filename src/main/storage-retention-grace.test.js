'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeStorageRetentionSettings } = require('./storage-inventory');
const {
  HOUR_MS, reconcileStorageGrace, MemoryStorageGraceStore,
} = require('./storage-retention-grace');

const start = 1_800_000_000_000;
const settings = normalizeStorageRetentionSettings({});
const oldSession = {
  id: 'old', section: 'sessions', provider: 'codex', group: 'outside',
  sessionId: 's', path: '/fixture/old.jsonl', sizeBytes: 100, fileIdentity: '1:2',
  modifiedAt: 1000, deleteAfter: 1000 + 24 * HOUR_MS, protected: false, deletable: true,
};

test('a years-old unprotected file gets a new full 24h clock on first observation', () => {
  const result = reconcileStorageGrace([oldSession], settings, start);
  assert.equal(result.items[0].eligible, false);
  assert.equal(result.items[0].unprotectedSince, start);
  assert.equal(result.items[0].deleteAfter, start + 24 * HOUR_MS);
  assert.equal(reconcileStorageGrace([oldSession], settings, start + 24 * HOUR_MS - 1, result.clocks).items[0].eligible, false);
  assert.equal(reconcileStorageGrace([oldSession], settings, start + 24 * HOUR_MS, result.clocks).items[0].eligible, true);
  assert.equal(oldSession.unprotectedSince, undefined, 'do not mutate the cached raw scan');
});

test('protection cancels the clock and losing it again grants the whole wait', () => {
  const first = reconcileStorageGrace([oldSession], settings, start);
  const protectedItem = { ...oldSession, protected: true, deletable: false, deleteAfter: null };
  const protectedResult = reconcileStorageGrace([protectedItem], settings, start + 23 * HOUR_MS, first.clocks);
  assert.equal(protectedResult.clocks.size, 0);
  assert.equal(protectedResult.items[0].unprotectedSince, null);
  const closed = reconcileStorageGrace([oldSession], settings, start + 25 * HOUR_MS, protectedResult.clocks);
  assert.equal(closed.items[0].deleteAfter, start + 49 * HOUR_MS);
  assert.equal(closed.items[0].eligible, false);
});

test('new activity, another close and physical replacement each start a new clock', () => {
  const first = reconcileStorageGrace([oldSession], settings, start);
  for (const patch of [
    { modifiedAt: start + HOUR_MS }, { sizeBytes: 101 },
    { closedAt: start + HOUR_MS }, { fileIdentity: '1:3' },
  ]) {
    const result = reconcileStorageGrace([{ ...oldSession, ...patch }], settings, start + 25 * HOUR_MS, first.clocks);
    assert.equal(result.items[0].unprotectedSince, start + 25 * HOUR_MS);
    assert.equal(result.items[0].eligible, false);
  }
});

test('longer group retention and Never remain independent of the minimum wait', () => {
  const first = reconcileStorageGrace([oldSession], settings, start);
  const longRetention = { ...oldSession, deleteAfter: start + 7 * 24 * HOUR_MS };
  const later = reconcileStorageGrace([longRetention], settings, start + 25 * HOUR_MS, first.clocks);
  assert.equal(later.items[0].deleteAfter, longRetention.deleteAfter);
  assert.equal(later.items[0].eligible, false);
  const never = reconcileStorageGrace([{ ...oldSession, deleteAfter: null }], settings, start + 25 * HOUR_MS, first.clocks);
  assert.equal(never.items[0].eligible, false);
  assert.equal(never.clocks.size, 0);
});

test('hours change the deadline without changing since; disabled prevents auto-delete', () => {
  const first = reconcileStorageGrace([oldSession], settings, start);
  const changed = normalizeStorageRetentionSettings({ gracePeriodHours: 48 });
  assert.equal(reconcileStorageGrace([oldSession], changed, start + 25 * HOUR_MS, first.clocks).items[0].eligible, false);
  const off = reconcileStorageGrace([oldSession], { ...settings, enabled: false }, start + 25 * HOUR_MS, first.clocks);
  assert.equal(off.items[0].eligible, false);
  assert.equal(off.items[0].unprotectedSince, start);
});

test('missing/corrupt/future clock state never grants an early deletion', () => {
  const first = reconcileStorageGrace([oldSession], settings, start);
  for (const since of [null, -1, NaN, '100', start + 2 * HOUR_MS]) {
    const previous = new Map([['old', { ...first.clocks.get('old'), since }]]);
    assert.equal(reconcileStorageGrace([oldSession], settings, start + HOUR_MS, previous).items[0].unprotectedSince, start + HOUR_MS);
  }
});

test('manual-only builds are unchanged; missing files drop their obsolete clocks', () => {
  const store = new MemoryStorageGraceStore();
  store.reconcile((previous) => reconcileStorageGrace([oldSession], settings, start, previous));
  assert.ok(store.get('old'));
  const build = { ...oldSession, section: 'builds', group: 'build', eligible: true };
  assert.deepEqual(store.reconcile((previous) => reconcileStorageGrace([build], settings, start, previous)), [build]);
  assert.equal(store.get('old'), undefined);
});

test('settings keep old group preferences, default to 24h and forbid immediate grace', () => {
  assert.equal(normalizeStorageRetentionSettings({ retentionDays: { fork: null } }).gracePeriodHours, 24);
  for (const hours of [0, -5]) assert.equal(normalizeStorageRetentionSettings({ gracePeriodHours: hours }).gracePeriodHours, 1);
  assert.equal(normalizeStorageRetentionSettings({ gracePeriodHours: 2 }).gracePeriodHours, 2);
  assert.equal(normalizeStorageRetentionSettings({ gracePeriodHours: 'bad' }).gracePeriodHours, 24);
  assert.equal(normalizeStorageRetentionSettings({ gracePeriodHours: 100000 }).gracePeriodHours, 87600);
});
