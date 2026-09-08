import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isVisibleForkMarker,
  normalizeForkMarkerEntryUuids,
  normalizeForkMarkers,
} from './forkMarkerSnapshot.mjs';

test('saved-history rewrites keep lineage metadata without drawing a blue Fork stripe', () => {
  assert.equal(isVisibleForkMarker({ fork_mode: 'full' }), true);
  assert.equal(isVisibleForkMarker({ fork_mode: 'history_delete' }), false);
  assert.equal(isVisibleForkMarker({ forkMode: 'history_edit' }), false);
  assert.equal(isVisibleForkMarker({ fork_mode: 'history_rewind' }), false);
  assert.equal(isVisibleForkMarker({ fork_mode: 'full', hidden: true }), false);
});

test('only a confirmed user Fork is visible, independently of physical provider mode', () => {
  assert.equal(isVisibleForkMarker({ fork_mode: 'direct-virtual', operation_kind: 'fork' }), true);
  assert.equal(isVisibleForkMarker({ fork_mode: 'direct-virtual', operation_kind: 'rewind' }), false);
  assert.equal(isVisibleForkMarker({ fork_mode: 'full', operation_kind: 'edit' }), false);
  assert.equal(isVisibleForkMarker({ fork_mode: 'direct-virtual' }), false);
  assert.equal(isVisibleForkMarker({ fork_mode: 'future-provider-branch' }), false);
  assert.equal(isVisibleForkMarker({ fork_mode: 'full', origin: 'transcript' }), false);
});

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
