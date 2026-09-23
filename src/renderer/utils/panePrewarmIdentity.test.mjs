import assert from 'node:assert/strict';
import test from 'node:test';

import {
  panePrewarmRequirements,
  panePrewarmSignalMatches,
  panePrewarmSourceKeys,
  reconcilePanePrewarmTracker,
} from './panePrewarmIdentity.mjs';

const config = (suffix, overrides = {}) => ({
  sessionId: 'same-session',
  historyOwnerKey: 'history-' + suffix,
  timelineOwnerKey: 'timeline-' + suffix,
  historyRequired: true,
  timelineRequired: true,
  timelineLoadRequired: true,
  timelineSubscribeRequired: true,
  ...overrides,
});

const tracker = current => ({
  sessionId: current.sessionId,
  sourceKeys: panePrewarmSourceKeys(current),
  requirements: panePrewarmRequirements(current),
  settled: new Set(),
});

test('same-session owner change revokes the old source facts before admission advances', () => {
  const a = config('a');
  const b = config('b');
  const active = tracker(a);
  active.settled.add('history:load');

  const result = reconcilePanePrewarmTracker(active, b);
  assert.deepEqual([...result.changedSources].sort(), ['history', 'timeline']);
  assert.equal(active.settled.has('history:load'), false);
  assert.equal(result.historyPending, true);
  assert.equal(panePrewarmSignalMatches(b, 'history:subscribe', a.historyOwnerKey), false);
  assert.equal(panePrewarmSignalMatches(b, 'history:subscribe', b.historyOwnerKey), true);

  active.settled.add('history:subscribe');
  assert.equal(
    [...active.requirements].some(item => item.startsWith('history:') && !active.settled.has(item)),
    true,
    'subscribe B cannot combine with the already revoked load A',
  );
});

test('a Timeline-only owner change preserves settled History facts', () => {
  const a = config('a');
  const active = tracker(a);
  active.settled.add('history:load');
  active.settled.add('history:subscribe');
  active.settled.add('timeline:load');

  const next = { ...a, timelineOwnerKey: 'timeline-b' };
  const result = reconcilePanePrewarmTracker(active, next);
  assert.deepEqual([...result.changedSources], ['timeline']);
  assert.equal(active.settled.has('history:load'), true);
  assert.equal(active.settled.has('history:subscribe'), true);
  assert.equal(active.settled.has('timeline:load'), false);
  assert.equal(result.historyPending, false);
  assert.equal(result.timelinePending, true);
});

test('the unchanged hidden owner keeps the normal history to timeline to ready path', () => {
  const current = config('a');
  const active = tracker(current);
  for (const requirement of active.requirements) {
    assert.equal(
      panePrewarmSignalMatches(
        current,
        requirement,
        requirement.startsWith('history:') ? current.historyOwnerKey : current.timelineOwnerKey,
      ),
      true,
    );
    active.settled.add(requirement);
  }
  const result = reconcilePanePrewarmTracker(active, current);
  assert.equal(result.changed, false);
  assert.deepEqual(result.pending, []);
});
