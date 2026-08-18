const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveForkMarkerBoundary,
  selectDirectForkMarker,
} = require('./fork-marker-boundary.cjs');

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
