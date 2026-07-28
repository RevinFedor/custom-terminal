import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDockBusyBadgeState } from './dockBusyBadgeState.mjs';

test('uses a purple inherited badge when only orchestration parents remain', () => {
  assert.deepEqual(resolveDockBusyBadgeState([], ['parent']), {
    count: 1,
    kind: 'inherited',
  });
});

test('uses the green badge and counts normal plus inherited activity', () => {
  assert.deepEqual(resolveDockBusyBadgeState(['worker-a', 'worker-b'], ['parent']), {
    count: 3,
    kind: 'active',
  });
});

test('does not count one tab twice when it owns and inherits activity', () => {
  assert.deepEqual(resolveDockBusyBadgeState(['parent'], ['parent']), {
    count: 1,
    kind: 'active',
  });
});
