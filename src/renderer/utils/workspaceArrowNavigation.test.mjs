import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveSpatialPaneTarget,
  resolveWorkspaceArrowCommand,
  resolveWorkspaceCycleTarget,
  workspaceArrowNavigationBlocked,
} from './workspaceArrowNavigation.mjs';

const key = (overrides = {}) => ({
  code: 'ArrowRight',
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  ...overrides,
});

test('plain Cmd owns four-way pane navigation; Shift+Cmd owns horizontal workflows', () => {
  assert.deepEqual(resolveWorkspaceArrowCommand(key()), { kind: 'pane', direction: 'right' });
  assert.deepEqual(resolveWorkspaceArrowCommand(key({ code: 'ArrowDown' })), { kind: 'pane', direction: 'down' });
  assert.deepEqual(resolveWorkspaceArrowCommand(key({ code: 'ArrowLeft', shiftKey: true })), {
    kind: 'workflow',
    direction: 'previous',
  });
  assert.deepEqual(resolveWorkspaceArrowCommand(key({ code: 'ArrowRight', shiftKey: true })), {
    kind: 'workflow',
    direction: 'next',
  });
  assert.equal(resolveWorkspaceArrowCommand(key({ code: 'ArrowUp', shiftKey: true })), null);
  assert.equal(resolveWorkspaceArrowCommand(key({ altKey: true })), null);
  assert.equal(resolveWorkspaceArrowCommand(key({ metaKey: false })), null);
});

test('spatial navigation follows rendered columns and rows without wrapping', () => {
  const panes = [
    { projectId: 'p', tabId: 'left', column: 0 },
    { projectId: 'p', tabId: 'right-top', column: 1 },
    { projectId: '', tabId: '', column: 1 },
  ];
  const sizes = { cols: [0.42, 0.58], rows: [[1], [0.35, 0.65]] };

  assert.equal(resolveSpatialPaneTarget(panes, sizes, 0, 'right'), 1);
  assert.equal(resolveSpatialPaneTarget(panes, sizes, 1, 'left'), 0);
  assert.equal(resolveSpatialPaneTarget(panes, sizes, 1, 'down'), 2);
  assert.equal(resolveSpatialPaneTarget(panes, sizes, 2, 'up'), 1);
  assert.equal(resolveSpatialPaneTarget(panes, sizes, 2, 'right'), null);
});

test('row topology stays stable when divider sizes make another row visually closer', () => {
  const panes = [
    { projectId: 'p', tabId: 'left-top', column: 0 },
    { projectId: 'p', tabId: 'left-bottom', column: 0 },
    { projectId: 'p', tabId: 'right-top', column: 1 },
    { projectId: 'p', tabId: 'right-bottom', column: 1 },
  ];
  const sizes = { cols: [0.7, 0.3], rows: [[0.2, 0.8], [0.75, 0.25]] };

  assert.equal(resolveSpatialPaneTarget(panes, sizes, 1, 'right'), 3);
  assert.equal(resolveSpatialPaneTarget(panes, sizes, 2, 'left'), 0);
});

test('workflow navigation follows saved strip order and wraps', () => {
  const spaces = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveWorkspaceCycleTarget(spaces, 'b', 'previous'), 'a');
  assert.equal(resolveWorkspaceCycleTarget(spaces, 'b', 'next'), 'c');
  assert.equal(resolveWorkspaceCycleTarget(spaces, 'c', 'next'), 'a');
  assert.equal(resolveWorkspaceCycleTarget([{ id: 'only' }], 'only', 'next'), null);
});

test('modal/picker and single-line rename fields keep their arrows', () => {
  const noOverlay = { querySelector: () => null };
  assert.equal(workspaceArrowNavigationBlocked({ tagName: 'INPUT', closest: () => null }, noOverlay), true);
  assert.equal(workspaceArrowNavigationBlocked({ tagName: 'DIV', closest: () => null }, noOverlay), false);
  assert.equal(workspaceArrowNavigationBlocked(
    { tagName: 'DIV', closest: () => null },
    { querySelector: () => ({ role: 'dialog' }) },
  ), true);
});
