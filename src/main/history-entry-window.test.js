'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyHistoryEntryWindow } = require('./history-entry-window');

const entries = Array.from({ length: 10 }, (_unused, index) => ({ uuid: `u${index}` }));

test('unbounded history preserves the original entries', () => {
  const result = applyHistoryEntryWindow(entries);
  assert.equal(result.boundsApplied, false);
  assert.equal(result.entries, entries);
  assert.equal(result.total, 10);
});

test('last is applied before expensive presentation transport', () => {
  const result = applyHistoryEntryWindow(entries, { last: 3 });
  assert.deepEqual(result.entries.map((entry) => entry.uuid), ['u7', 'u8', 'u9']);
  assert.equal(result.total, 10);
  assert.equal(result.dropped, 7);
  assert.equal(result.truncated, true);
});

test('after, before and around use exact UUID identity', () => {
  assert.deepEqual(
    applyHistoryEntryWindow(entries, { afterUuid: 'u2', beforeUuid: 'u7' }).entries.map((entry) => entry.uuid),
    ['u3', 'u4', 'u5', 'u6'],
  );
  assert.deepEqual(
    applyHistoryEntryWindow(entries, { aroundUuid: 'u5', radius: 2 }).entries.map((entry) => entry.uuid),
    ['u3', 'u4', 'u5', 'u6', 'u7'],
  );
  assert.deepEqual(applyHistoryEntryWindow(entries, { aroundUuid: 'missing' }).entries, []);
});
