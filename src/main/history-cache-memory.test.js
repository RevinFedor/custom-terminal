'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historyCacheRamSnapshot } = require('./history-cache-memory');
const { historyDiskBudgetBytes } = require('./history-cache-policy');
const { normalizeHistoryDiskBudgetGiB } = require('../shared/history-cache-settings.cjs');
const GiB = 1024 ** 3;

test('RAM sum covers separate main/physical/virtual/index caches, not process RSS', () => {
  const value = historyCacheRamSnapshot({ approxBytes: 10, rss: 9000 },
    { status: 'ready', graphBytes: 20, virtualBytes: 30, indexBytes: 40, generation: 7 }, 200, 100);
  assert.equal(value.approxBytes, 100); assert.equal(value.budgetBytes, 200);
  assert.equal(value.workerGeneration, 7); assert.equal(value.approximate, true);
  assert.equal(value.status, 'ready');
  assert.equal(historyCacheRamSnapshot({ approxBytes: 1000 },
    { status: 'ready', graphBytes: 0, virtualBytes: 0, indexBytes: 0 }, 200).approxBytes, 1000,
  'active oversized retention is displayed truthfully, not clamped to a claimed allocation');
});
test('missing worker evidence is unknown, while confirmed empty caches are zero', () => {
  for (const worker of [null, { status: 'unknown' }, { status: 'ready', graphBytes: 1, virtualBytes: null, indexBytes: 0 }]) {
    assert.equal(historyCacheRamSnapshot({ approxBytes: 0 }, worker, 200).approxBytes, null);
  }
  assert.equal(historyCacheRamSnapshot({ approxBytes: 0 },
    { status: 'ready', graphBytes: 0, virtualBytes: 0, indexBytes: 0 }, 200).approxBytes, 0);
});
test('one setting normalizer controls SSD quota and capacity forecast with a20GiB default', () => {
  for (const value of [null, undefined, '', 'invalid', 0, -1, Infinity]) {
    assert.equal(normalizeHistoryDiskBudgetGiB(value), 20);
    assert.equal(historyDiskBudgetBytes(value), 20 * GiB);
  }
  assert.equal(historyDiskBudgetBytes('32'), 32 * GiB);
  assert.equal(historyDiskBudgetBytes('0.5'), GiB);
  assert.equal(normalizeHistoryDiskBudgetGiB(9999), 1024);
});
