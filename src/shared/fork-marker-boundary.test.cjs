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
