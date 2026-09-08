const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cjsBoundary = require('./fork-marker-boundary.cjs');
const {
  resolveForkMarkerBoundary,
  selectDirectForkMarker,
} = cjsBoundary;

test('renderer ESM implementation does not import local CJS through Vite dev', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fork-marker-boundary.mjs'), 'utf8');
  assert.doesNotMatch(
    source,
    /from ['"].*fork-marker-boundary\.cjs['"]/,
    'Vite dev serves local .cjs as an empty ESM namespace and leaves react-root blank',
  );
});

test('renderer ESM and main CJS implementations stay behaviorally identical', async () => {
  const esmBoundary = await import('./fork-marker-boundary.mjs');
  const entries = [{ uuid: 'a' }, { uuid: 'replacement' }, { uuid: 'b' }];
  const markers = [{
    source_session_id: 'parent',
    fork_session_id: 'child',
    entry_uuids: ['a', 'removed', 'b'],
    created_at: 11,
    is_direct: true,
  }];

  assert.deepEqual(
    esmBoundary.normalizeForkMarkerEntryUuids(['a', '', 'a', 'b']),
    cjsBoundary.normalizeForkMarkerEntryUuids(['a', '', 'a', 'b']),
  );
  assert.deepEqual(
    esmBoundary.resolveForkMarkerBoundary(entries, markers[0]),
    cjsBoundary.resolveForkMarkerBoundary(entries, markers[0]),
  );
  assert.deepEqual(
    esmBoundary.selectDirectForkMarker(markers, 'child', entries),
    cjsBoundary.selectDirectForkMarker(markers, 'child', entries),
  );
});

test('a sparse fork snapshot resolves to its highest surviving timeline position', () => {
  const entries = ['a', 'replacement', 'b', 'new-child-turn'].map((uuid) => ({ uuid }));
  const marker = { entry_uuids: ['a', 'removed', 'b'] };

  assert.deepEqual(resolveForkMarkerBoundary(entries, marker), {
    atBeginning: false,
    boundaryIndex: 2,
    boundaryUuid: 'b',
    matchedCount: 2,
    snapshotCount: 3,
  });
});

test('an empty snapshot is one fork boundary before the first timeline row', () => {
  assert.deepEqual(resolveForkMarkerBoundary([{ uuid: 'child' }], { entry_uuids: [] }), {
    atBeginning: true,
    boundaryIndex: -1,
    boundaryUuid: null,
    matchedCount: 0,
    snapshotCount: 0,
  });
});

test('a proven direct marker wins over a larger inherited legacy snapshot', () => {
  const markers = [
    {
      source_session_id: 'grandparent',
      fork_session_id: 'child',
      entry_uuids: ['a', 'b', 'c'],
      created_at: 10,
    },
    {
      source_session_id: 'parent',
      fork_session_id: 'child',
      entry_uuids: ['b'],
      created_at: 11,
      is_direct: true,
    },
  ];

  assert.equal(
    selectDirectForkMarker(markers, 'child', [{ uuid: 'a' }, { uuid: 'b' }]).source_session_id,
    'parent',
  );
});

test('app origin is presented across technical children without rewriting the original event identity', async () => {
  const cjs = require('./fork-marker-boundary.cjs');
  const esm = await import('./fork-marker-boundary.mjs');
  const origin = { source_session_id: 'original-source', fork_session_id: 'app-child',
    view_session_id: 'technical-child', operation_kind: 'fork', is_direct: false,
    entry_uuids: ['mapped-edge'], boundary_entry_uuid: 'mapped-edge', snapshot_complete: true };
  const technical = { source_session_id: 'app-child', fork_session_id: 'technical-child',
    operation_kind: 'rewind', is_direct: true, entry_uuids: ['before', 'mapped-edge'] };
  for (const api of [cjs, esm]) {
    const markers = [technical, origin];
    assert.equal(api.selectDirectForkMarker(markers, 'technical-child'), technical);
    assert.equal(api.selectAppForkMarker(markers, 'technical-child', ['before', 'mapped-edge']), origin);
    assert.equal(origin.fork_session_id, 'app-child', 'hide/open actions retain the actual original Fork');
    assert.equal(api.selectAppForkMarker(markers, 'technical-child', ['before']), null, 'removed origin is not moved to another row');
    assert.equal(api.selectAppForkMarker([technical, { ...origin, hidden: true }], 'technical-child', ['mapped-edge']), null);
    const empty = { ...origin, entry_uuids: [], boundary_entry_uuid: null };
    assert.equal(api.selectAppForkMarker([technical, empty], 'technical-child', []), empty);
    const newFork = { ...technical, operation_kind: 'fork' };
    assert.equal(api.selectAppForkMarker([origin, newFork], 'technical-child', ['mapped-edge']), newFork);
  }
});
