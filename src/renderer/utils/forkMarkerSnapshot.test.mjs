import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForkMarkerEntryUuids,
  normalizeForkMarkers,
} from './forkMarkerSnapshot.mjs';

test('normalizes a valid snapshot without duplicates', () => {
  assert.deepEqual(
    normalizeForkMarkerEntryUuids([' a ', 'b', 'a', null, 1]),
    ['a', 'b'],
  );
});

test('turns legacy object and unresolved Promise snapshots into empty arrays', () => {
  assert.deepEqual(normalizeForkMarkerEntryUuids({}), []);
  assert.deepEqual(normalizeForkMarkerEntryUuids(Promise.resolve(['a'])), []);
});

test('normalizes marker payloads at the IPC boundary', () => {
  assert.deepEqual(normalizeForkMarkers([
    { source_session_id: 'source', fork_session_id: 'child', entry_uuids: {} },
    null,
  ]), [{
    source_session_id: 'source',
    fork_session_id: 'child',
    entry_uuids: [],
  }]);
  assert.deepEqual(normalizeForkMarkers({ markers: [] }), []);
});
