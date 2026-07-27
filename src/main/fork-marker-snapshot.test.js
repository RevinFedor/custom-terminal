'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeForkMarkerEntryUuids,
  parseForkMarkerEntryUuidsJson,
} = require('./fork-marker-snapshot');

test('normalizes a UUID snapshot to unique non-empty strings', () => {
  assert.deepEqual(
    normalizeForkMarkerEntryUuids([' a ', '', null, 'b', 'a', 7]),
    ['a', 'b'],
  );
});

test('rejects unresolved async values and non-array objects', () => {
  assert.deepEqual(normalizeForkMarkerEntryUuids(Promise.resolve(['a'])), []);
  assert.deepEqual(normalizeForkMarkerEntryUuids({ 0: 'a' }), []);
});

test('parses only JSON arrays and recovers from legacy malformed rows', () => {
  assert.deepEqual(parseForkMarkerEntryUuidsJson('["a","b","a"]'), ['a', 'b']);
  assert.deepEqual(parseForkMarkerEntryUuidsJson('{}'), []);
  assert.deepEqual(parseForkMarkerEntryUuidsJson('{broken'), []);
  assert.deepEqual(parseForkMarkerEntryUuidsJson(null), []);
});
