import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectHistoryMaterializedWindowUuids,
  historyHydrationCenterForRange,
  historyRowsSharePhysicalRevision,
  retainHistoryMaterializedWindow,
} from './historyMaterializedWindow.mjs';

const full = (uuid, revision = 'r1') => ({
  uuid,
  role: 'assistant',
  content: `full:${uuid}`,
  sourceIdentity: `source:${uuid}`,
  contentRevision: revision,
});
const stub = (uuid, revision = 'r1') => ({
  uuid,
  role: 'assistant',
  rowStub: true,
  sourceIdentity: `source:${uuid}`,
  contentRevision: revision,
});

test('a visible full row survives a moved hydration window under exact revision proof', () => {
  const previous = [full('a'), full('b'), full('c')];
  const incoming = [stub('a'), full('b'), stub('c')];
  const result = retainHistoryMaterializedWindow(previous, incoming, new Set(['a']));
  assert.equal(result.entries[0], previous[0]);
  assert.equal(result.entries[2], incoming[2]);
  assert.equal(result.retained, 1);
});

test('stale or unproven physical revisions fail closed to the incoming stub', () => {
  assert.equal(historyRowsSharePhysicalRevision(full('a', 'old'), stub('a', 'new')), false);
  assert.equal(historyRowsSharePhysicalRevision({ uuid: 'a', content: 'old' }, { uuid: 'a', rowStub: true }), false);
  const incoming = stub('a', 'new');
  const result = retainHistoryMaterializedWindow([full('a', 'old')], [incoming], new Set(['a']));
  assert.equal(result.entries[0], incoming);
  assert.equal(result.rejected, 1);
});

test('collapsed groups retain only their height-bearing caption, not every heavy member', () => {
  const units = [{
    kind: 'group',
    entries: Array.from({ length: 100 }, (_, index) => full(`tool-${index}`)),
    captionEntry: full('caption'),
  }];
  assert.deepEqual(
    [...collectHistoryMaterializedWindowUuids(units, { start: 0, end: 0 })],
    ['caption'],
  );
});

test('settled hydration uses one centre identity instead of alternating stub flanks', () => {
  const units = [
    { kind: 'entry', entry: stub('left') },
    { kind: 'entry', entry: full('centre') },
    { kind: 'entry', entry: stub('right') },
  ];
  assert.equal(historyHydrationCenterForRange(units, { start: 0, end: 2 }), 'centre');
  assert.equal(historyHydrationCenterForRange([], { start: 0, end: 0 }, 'fallback'), 'fallback');
});
