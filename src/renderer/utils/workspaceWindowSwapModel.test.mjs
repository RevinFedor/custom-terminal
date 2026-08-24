import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readWorkspaceLayoutWindow,
  swapWorkspaceLayoutWindows,
} from './workspaceWindowSwapModel.mjs';

const pane = (projectId, tabId, tabs, column, history = []) => ({
  projectId,
  tabId,
  ...(tabs ? { tabs } : {}),
  ...(column === undefined ? {} : { column }),
  ...(history.length ? { history } : {}),
});

test('cross-workflow swap exchanges full pane contents while each slot keeps its column', () => {
  const sourceLayout = {
    splitPanes: [
      pane('p-a', 'a-1', [{ projectId: 'p-a', tabId: 'a-1' }, { projectId: 'p-a', tabId: 'a-2' }], 0, [{ projectId: 'p-a', tabId: 'a-old' }]),
      pane('p-x', 'x', null, 1),
    ],
    splitFocusedIndex: 0,
  };
  const targetLayout = {
    splitPanes: [pane('p-b', 'b-1', [{ projectId: 'p-b', tabId: 'b-1' }, { projectId: 'p-b', tabId: 'b-2' }], 2)],
    splitFocusedIndex: 0,
  };
  const result = swapWorkspaceLayoutWindows({ sourceLayout, sourcePaneIndex: 0, targetLayout, targetPaneIndex: 0 });

  assert.equal(result.sourceLayout.splitPanes[0].tabId, 'b-1');
  assert.deepEqual(result.sourceLayout.splitPanes[0].tabs.map((entry) => entry.tabId), ['b-1', 'b-2']);
  assert.equal(result.sourceLayout.splitPanes[0].column, 0);
  assert.equal(result.targetLayout.splitPanes[0].tabId, 'a-1');
  assert.deepEqual(result.targetLayout.splitPanes[0].history, [{ projectId: 'p-a', tabId: 'a-old' }]);
  assert.equal(result.targetLayout.splitPanes[0].column, 2);
  assert.equal(sourceLayout.splitPanes[0].tabId, 'a-1', 'input layouts stay immutable');
});

test('single centre is materialized and can exchange a multi-tab strip with a split pane', () => {
  const sourceLayout = {
    splitPanes: [pane('p-a', 'a-1', [{ projectId: 'p-a', tabId: 'a-1' }, { projectId: 'p-a', tabId: 'a-2' }], 0)],
    splitFocusedIndex: 0,
  };
  const targetLayout = {
    splitPanes: [],
    splitFocusedIndex: 0,
    splitSizes: null,
    activeProjectId: 'p-b',
    focusedProjectId: 'p-b',
    activeSpaceTab: { projectId: 'p-b', tabId: 'b-2' },
    centerStrips: {
      'p-b': [{ projectId: 'p-b', tabId: 'b-1' }, { projectId: 'p-b', tabId: 'b-2' }],
    },
  };
  assert.deepEqual(
    readWorkspaceLayoutWindow(targetLayout, 0).tabs.map((entry) => entry.tabId),
    ['b-1', 'b-2'],
  );

  const result = swapWorkspaceLayoutWindows({ sourceLayout, sourcePaneIndex: 0, targetLayout, targetPaneIndex: 0 });
  assert.equal(result.sourceLayout.splitPanes[0].tabId, 'b-2');
  assert.deepEqual(result.sourceLayout.splitPanes[0].tabs.map((entry) => entry.tabId), ['b-1', 'b-2']);
  assert.deepEqual(result.targetLayout.activeSpaceTab, { projectId: 'p-a', tabId: 'a-1' });
  assert.deepEqual(result.targetLayout.centerStrips['p-a'].map((entry) => entry.tabId), ['a-1', 'a-2']);
  assert.equal(result.targetLayout.splitPanes.length, 0);
});

test('invalid pane address fails without partially changing either layout', () => {
  assert.equal(swapWorkspaceLayoutWindows({
    sourceLayout: { splitPanes: [pane('p-a', 'a')] },
    sourcePaneIndex: 4,
    targetLayout: { splitPanes: [pane('p-b', 'b')] },
    targetPaneIndex: 0,
  }), null);
});
