import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOME_ROW_ID,
  buildWorkflowSwitcherRows,
  initialWorkflowIndex,
  stepWorkflowIndex,
} from './workflowSwitcherModel.mjs';

const spaces = [
  { id: 'w1', name: 'main', icon: 'main.png' },
  { id: 'w2', name: 'uav repo', icon: 'uav.png' },
  { id: 'w3', name: 'ios-dev', icon: null },
];
const ids = (rows) => rows.map((row) => row.id);

test('active workflow is row 1, then strip order continues and wraps', () => {
  const rows = buildWorkflowSwitcherRows({ spaces, activeSpaceId: 'w2' });
  assert.deepEqual(ids(rows), ['w2', 'w3', 'w1', '__noted_inbox__', HOME_ROW_ID]);
  assert.equal(rows[0].current, true);
  assert.equal(rows[0].icon, 'uav.png');
});

test('Home is a top-level destination and can be the anchor', () => {
  const rows = buildWorkflowSwitcherRows({ spaces, activeSpaceId: 'w2', onDashboard: true });
  assert.equal(rows[0].id, HOME_ROW_ID);
  assert.equal(rows[0].current, true);
  assert.equal(rows[initialWorkflowIndex(rows)].id, 'w2');
});

test('Inbox is a top-level destination, not a fake workflow', () => {
  const rows = buildWorkflowSwitcherRows({
    spaces,
    activeSpaceId: 'w1',
    onInbox: true,
    inboxId: 'inbox',
    inboxName: 'Inbox',
    inboxIcon: 'inbox.png',
  });
  assert.equal(rows[0].id, 'inbox');
  assert.equal(rows[0].kind, 'inbox');
  assert.equal(rows[0].icon, 'inbox.png');
  assert.equal(rows[initialWorkflowIndex(rows)].id, 'w1');
});

test('without workflows the two real special surfaces remain navigable', () => {
  const rows = buildWorkflowSwitcherRows({ spaces: [], onDashboard: true });
  assert.deepEqual(ids(rows), [HOME_ROW_ID, '__noted_inbox__']);
  assert.equal(initialWorkflowIndex(rows), 1);
});

test('stepping wraps in both directions', () => {
  const rows = buildWorkflowSwitcherRows({ spaces, activeSpaceId: 'w1' });
  assert.equal(stepWorkflowIndex(rows, rows.length - 1, +1), 0);
  assert.equal(stepWorkflowIndex(rows, 0, -1), rows.length - 1);
});
