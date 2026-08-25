import assert from 'node:assert/strict';
import test from 'node:test';

import { describeWorkspace, paneTabs } from './splitPanesModel.mjs';
import {
  applyWorkspaceWindowMutation,
  dropTabsFromWorkspaceLayout,
} from './workspaceWindowMutation.mjs';

const entry = (tabId, projectId = 'p') => ({ projectId, tabId });
const target = (overrides = {}) => ({
  ok: true,
  paneIndex: 0,
  insertIndex: 1,
  mode: 'same-window',
  side: 'right',
  ...overrides,
});

test('same-window creation inserts directly after the source without stealing shown focus', () => {
  const result = applyWorkspaceWindowMutation({
    layout: {
      splitPanes: [{
        projectId: 'p',
        tabId: 'source',
        tabs: [entry('source'), entry('tail')],
      }],
      splitFocusedIndex: 0,
      activeSpaceTab: entry('source'),
    },
    target: target(),
    entries: [entry('new')],
    show: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.layout.centerStrips.p.map((item) => item.tabId), ['source', 'new', 'tail']);
  assert.equal(result.shownTabId, 'source');
});

test('show=true makes the inserted tab the visible owner', () => {
  const result = applyWorkspaceWindowMutation({
    layout: {
      splitPanes: [
        { projectId: 'p', tabId: 'source', tabs: [entry('source'), entry('tail')] },
        { projectId: 'p', tabId: 'other' },
      ],
      splitFocusedIndex: 1,
      activeSpaceTab: entry('other'),
    },
    target: target(),
    entries: [entry('new')],
    show: true,
    focus: true,
  });

  assert.equal(result.layout.splitFocusedIndex, 0);
  assert.equal(result.layout.splitPanes[0].tabId, 'new');
  assert.deepEqual(paneTabs(result.layout.splitPanes[0]).map((item) => item.tabId), ['source', 'new', 'tail']);
});

test('below opens a new row in the source column and right opens a new column', () => {
  const layout = {
    splitPanes: [
      { projectId: 'p', tabId: 'source', column: 0 },
      { projectId: 'p', tabId: 'right', column: 1 },
    ],
    splitFocusedIndex: 0,
    activeSpaceTab: entry('source'),
  };
  const below = applyWorkspaceWindowMutation({
    layout,
    target: target({ mode: 'new-window', side: 'below' }),
    entries: [entry('new-below')],
  });
  const right = applyWorkspaceWindowMutation({
    layout,
    target: target({ mode: 'new-window', side: 'right' }),
    entries: [entry('new-right')],
  });

  const belowView = describeWorkspace(below.layout.splitPanes, below.layout.splitFocusedIndex, null);
  const rightView = describeWorkspace(right.layout.splitPanes, right.layout.splitFocusedIndex, null);
  assert.equal(
    belowView.windows.find((window) => window.shownTabId === 'new-below').column,
    belowView.windows.find((window) => window.shownTabId === 'source').column,
  );
  assert.equal(rightView.windows.find((window) => window.shownTabId === 'new-right').column, 1);
  assert.equal(rightView.windows.find((window) => window.shownTabId === 'right').column, 2);
});

test('explicit empty window uses the same directional geometry', () => {
  const result = applyWorkspaceWindowMutation({
    layout: {
      splitPanes: [{ projectId: 'p', tabId: 'source' }],
      splitFocusedIndex: 0,
      activeSpaceTab: entry('source'),
    },
    target: target({ mode: 'new-window', side: 'below' }),
    createEmptyWindow: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.layout.splitPanes.length, 2);
  assert.equal(result.layout.splitPanes[1].tabId, '');
  assert.equal(result.layout.splitPanes[0].column, result.layout.splitPanes[1].column);
});

test('a second empty placeholder is rejected instead of multiplying unreachable windows', () => {
  const result = applyWorkspaceWindowMutation({
    layout: {
      splitPanes: [
        { projectId: 'p', tabId: 'source' },
        { projectId: '', tabId: '' },
      ],
      splitFocusedIndex: 0,
      activeSpaceTab: entry('source'),
    },
    target: target({ mode: 'new-window', side: 'right' }),
    createEmptyWindow: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_window_exists');
});

test('moving the shown tab away leaves the source workflow on its surviving neighbour', () => {
  const dropped = dropTabsFromWorkspaceLayout({
    splitPanes: [{
      projectId: 'p',
      tabId: 'moving',
      tabs: [entry('moving'), entry('survivor')],
    }],
    splitFocusedIndex: 0,
    activeProjectId: 'p',
    focusedProjectId: 'p',
    activeSpaceTab: entry('moving'),
  }, ['moving']);

  assert.equal(dropped.splitPanes[0].tabId, 'survivor');
  assert.equal(dropped.activeSpaceTab.tabId, 'survivor');
});

test('creating a row from single mode promotes the complete centre strip', () => {
  const result = applyWorkspaceWindowMutation({
    layout: {
      splitPanes: [],
      splitFocusedIndex: 0,
      activeProjectId: 'p',
      focusedProjectId: 'p',
      activeSpaceTab: entry('source'),
      centerStrips: {
        p: [entry('source'), entry('new'), entry('tail')],
      },
    },
    target: target({ paneIndex: null, mode: 'new-window', side: 'below' }),
    createEmptyWindow: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(paneTabs(result.layout.splitPanes[0]).map((item) => item.tabId), [
    'source',
    'new',
    'tail',
  ]);
  assert.equal(Object.hasOwn(result.layout.centerStrips, 'p'), false);
});
