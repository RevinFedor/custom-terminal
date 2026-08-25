import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeWorkspaceWindowTargets,
  encodeWorkspaceWindowRef,
  resolveWorkspaceCreationContext,
  resolveWorkspaceWindowTarget,
  workspacePlacementsForTab,
} from './workspaceWindowTarget.mjs';

const tab = (projectId, tabId, cwd = `/${projectId}`) => ({ projectId, tabId, cwd, name: tabId });
const pane = (projectId, tabId, tabs, column) => ({
  projectId,
  tabId,
  ...(tabs ? { tabs } : {}),
  ...(column === undefined ? {} : { column }),
});

const sourceTabId = 'source-tab';
const tabRows = new Map([
  ['custom:source-tab', tab('custom', sourceTabId, '/repo/custom/subdir')],
  ['custom:peer-tab', tab('custom', 'peer-tab', '/repo/custom')],
  ['sc:active-a', tab('sc', 'active-a', '/repo/sc')],
  ['sc:active-b', tab('sc', 'active-b', '/repo/sc')],
]);
const tabInfo = (projectId, tabId) => tabRows.get(`${projectId}:${tabId}`) || null;

const materializedSpaces = [
  {
    id: 'main',
    name: 'main',
    projectIds: ['custom'],
    layout: {
      splitPanes: [
        pane('custom', 'peer-tab'),
        pane('custom', sourceTabId, [
          { projectId: 'custom', tabId: 'peer-tab' },
          { projectId: 'custom', tabId: sourceTabId },
        ], 1),
      ],
      splitFocusedIndex: 0,
      activeSpaceTab: { projectId: 'custom', tabId: 'peer-tab' },
    },
  },
  {
    id: 'sc-desk',
    name: 'sc-desk',
    projectIds: ['sc'],
    layout: {
      splitPanes: [pane('sc', 'active-a'), pane('sc', 'active-b')],
      splitFocusedIndex: 1,
      activeSpaceTab: { projectId: 'sc', tabId: 'active-b' },
    },
  },
];

const describe = () => describeWorkspaceWindowTargets({
  spaces: materializedSpaces,
  activeSpaceId: 'sc-desk',
  fingerprint: 'fp-1',
  tabInfo,
});

test('source window wins over the unrelated UI-focused workflow', () => {
  const spaces = describe();
  const target = resolveWorkspaceWindowTarget({
    describedSpaces: spaces,
    activeSpaceId: 'sc-desk',
    sourceTabId,
    fingerprint: 'fp-1',
  });

  assert.equal(target.ok, true);
  assert.equal(target.spaceId, 'main');
  assert.equal(target.window.tabs[1].tabId, sourceTabId);
  assert.equal(target.insertIndex, 2);
});

test('explicit workflow without a window uses its saved focused window', () => {
  const target = resolveWorkspaceWindowTarget({
    describedSpaces: describe(),
    activeSpaceId: 'sc-desk',
    sourceTabId,
    fingerprint: 'fp-1',
    target: { spaceId: 'sc-desk' },
  });

  assert.equal(target.ok, true);
  assert.equal(target.spaceId, 'sc-desk');
  assert.equal(target.window.shownTabId, 'active-b');
});

test('an unplaced source falls back to the active workflow focused window', () => {
  const target = resolveWorkspaceWindowTarget({
    describedSpaces: describe(),
    activeSpaceId: 'sc-desk',
    sourceTabId: 'unplaced',
    fingerprint: 'fp-1',
  });

  assert.equal(target.ok, true);
  assert.equal(target.spaceId, 'sc-desk');
  assert.equal(target.window.shownTabId, 'active-b');
});

test('window refs fail closed after any workspace layout change', () => {
  const spaces = describe();
  const ref = spaces[0].windows[0].windowRef;
  const target = resolveWorkspaceWindowTarget({
    describedSpaces: spaces,
    activeSpaceId: 'sc-desk',
    sourceTabId,
    fingerprint: 'fp-2',
    target: { spaceId: 'main', windowRef: ref },
  });

  assert.equal(target.ok, false);
  assert.equal(target.reason, 'stale_layout');
});

test('a tab can expose every placement while active placement remains preferred', () => {
  const duplicated = describeWorkspaceWindowTargets({
    spaces: materializedSpaces.map((space) => (
      space.id === 'sc-desk'
        ? {
          ...space,
          layout: {
            ...space.layout,
            splitPanes: [pane('custom', sourceTabId), ...space.layout.splitPanes],
            splitFocusedIndex: 0,
          },
        }
        : space
    )),
    activeSpaceId: 'sc-desk',
    fingerprint: 'fp-1',
    tabInfo,
  });
  const placements = workspacePlacementsForTab(duplicated, sourceTabId);
  const target = resolveWorkspaceWindowTarget({
    describedSpaces: duplicated,
    activeSpaceId: 'sc-desk',
    sourceTabId,
    fingerprint: 'fp-1',
  });

  assert.equal(placements.length, 2);
  assert.equal(target.spaceId, 'sc-desk');
});

test('creation context follows explicit, window, workflow, then source evidence', () => {
  const projects = [
    { id: 'custom', path: '/repo/custom' },
    { id: 'sc', path: '/repo/sc' },
  ];
  const spaces = describe();
  const mainWindow = spaces[0].windows[1];

  assert.deepEqual(resolveWorkspaceCreationContext({
    explicitProjectId: 'sc',
    explicitCwd: '/repo/sc/pkg',
    projects,
  }), {
    ok: true,
    projectId: 'sc',
    cwd: '/repo/sc/pkg',
    reason: 'explicit-project-cwd',
  });
  assert.equal(resolveWorkspaceCreationContext({
    targetSpace: spaces[0],
    targetWindow: mainWindow,
    sourceTabId,
    tabInfo,
    projects,
  }).cwd, '/repo/custom/subdir');
  assert.equal(resolveWorkspaceCreationContext({
    targetSpace: { projectIds: ['sc'] },
    targetWindow: { tabs: [], shownTabId: null },
    tabInfo,
    projects,
  }).projectId, 'sc');
});

test('cwd routing uses longest project prefix and rejects equal-path ambiguity', () => {
  assert.equal(resolveWorkspaceCreationContext({
    explicitCwd: '/repo/custom/pkg/src',
    projects: [
      { id: 'root', path: '/repo' },
      { id: 'custom', path: '/repo/custom' },
    ],
  }).projectId, 'custom');

  const ambiguous = resolveWorkspaceCreationContext({
    explicitCwd: '/repo/custom/pkg',
    projects: [
      { id: 'a', path: '/repo/custom' },
      { id: 'b', path: '/repo/custom' },
    ],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'project_ambiguous_for_cwd');
});

test('window ref keeps centre and pane identities distinct', () => {
  assert.notEqual(
    encodeWorkspaceWindowRef({ spaceId: 'main', paneIndex: null, fingerprint: 'fp' }),
    encodeWorkspaceWindowRef({ spaceId: 'main', paneIndex: 0, fingerprint: 'fp' }),
  );
});

test('single-mode read projection keeps the complete centre strip', () => {
  const spaces = describeWorkspaceWindowTargets({
    spaces: [{
      id: 'single',
      name: 'single',
      projectIds: ['custom'],
      layout: {
        splitPanes: [],
        activeProjectId: 'custom',
        activeSpaceTab: { projectId: 'custom', tabId: 'source-tab' },
        centerStrips: {
          custom: [
            { projectId: 'custom', tabId: 'source-tab' },
            { projectId: 'custom', tabId: 'new-tab' },
            { projectId: 'custom', tabId: 'tail-tab' },
          ],
        },
      },
    }],
    activeSpaceId: 'single',
    fingerprint: 'fp',
    tabInfo,
  });

  assert.deepEqual(spaces[0].windows[0].tabs.map((item) => item.tabId), [
    'source-tab',
    'new-tab',
    'tail-tab',
  ]);
});
