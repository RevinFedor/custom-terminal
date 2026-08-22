import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recoverWorkspaceSpaces,
  workspaceSpacesFingerprint,
} from './workspaceSpaceRecovery.mjs';

const projectIds = new Set(['p-main', 'p-sc', 'p-gt']);
const tabs = new Set(['p-main:t1', 'p-main:t2', 'p-sc:s1', 'p-sc:s2', 'p-gt:g1']);
const callbacks = {
  projectExists: (projectId) => projectIds.has(projectId),
  tabExists: (projectId, tabId) => tabs.has(`${projectId}:${tabId}`),
  isSystemProject: (projectId) => projectId === '__noted_inbox__',
};

const current = [{
  id: 'space-1',
  name: 'main',
  icon: 'main-icon',
  projectIds: ['p-main'],
  layout: {},
}, {
  id: 'space-gt',
  name: 'gt',
  icon: 'gt-icon',
  projectIds: ['p-gt'],
  layout: { splitPanes: [{ projectId: 'p-gt', tabId: 'g1' }] },
}];

const liveState = {
  splitPanes: [{ projectId: 'p-gt', tabId: 'g1' }, { projectId: '', tabId: '' }],
  splitFocusedIndex: 0,
  splitSizes: null,
  centerStrips: {},
  activeProjectId: 'p-gt',
  focusedProjectId: 'p-gt',
  activeSpaceTab: { projectId: 'p-gt', tabId: 'g1' },
};

test('recovery replaces only named damaged ids and preserves newer workflows', () => {
  const expectedFingerprint = workspaceSpacesFingerprint(current, 'space-gt', liveState);
  const result = recoverWorkspaceSpaces({
    spaces: current,
    activeSpaceId: 'space-gt',
    liveState,
    expectedFingerprint,
    overwriteExistingIds: ['space-1'],
    candidates: [{
      id: 'space-1',
      name: 'main',
      projectIds: ['p-main', '__noted_inbox__'],
      layout: {
        splitPanes: [
          { projectId: 'p-main', tabId: 't1', column: 0 },
          { projectId: 'p-main', tabId: 't2', column: 1 },
        ],
        splitFocusedIndex: 1,
        activeProjectId: 'p-main',
        focusedProjectId: 'p-main',
        activeSpaceTab: { projectId: 'p-main', tabId: 't2' },
      },
    }, {
      id: 'space-sc',
      name: 'sc',
      icon: 'sc-icon',
      projectIds: ['p-sc'],
      layout: {
        splitPanes: [
          { projectId: 'p-sc', tabId: 's1', column: 0 },
          { projectId: 'p-sc', tabId: 's2', column: 1 },
        ],
        splitFocusedIndex: 0,
      },
    }],
    reassignProjects: true,
    ...callbacks,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.replacedIds, ['space-1']);
  assert.deepEqual(result.addedIds, ['space-sc']);
  assert.deepEqual(result.spaces.map((space) => space.id), ['space-1', 'space-sc', 'space-gt']);
  assert.equal(result.spaces.find((space) => space.id === 'space-gt').layout.splitPanes.length, 2);
  assert.deepEqual(result.spaces.find((space) => space.id === 'space-1').projectIds, ['p-main']);
  assert.equal(result.activeSpaceId, 'space-gt');
  assert.equal(result.activeLayout.splitPanes[0].tabId, 'g1');
});

test('stale fingerprint rejects recovery without producing a candidate state', () => {
  const result = recoverWorkspaceSpaces({
    spaces: current,
    activeSpaceId: 'space-gt',
    liveState,
    expectedFingerprint: 'stale',
    candidates: [],
    ...callbacks,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'workspace_changed',
    expectedFingerprint: 'stale',
    fingerprintBefore: workspaceSpacesFingerprint(current, 'space-gt', liveState),
  });
});

test('dead tabs are scrubbed and reported instead of being resurrected', () => {
  const result = recoverWorkspaceSpaces({
    spaces: current,
    activeSpaceId: 'space-gt',
    liveState,
    candidates: [{
      id: 'space-sc',
      name: 'sc',
      projectIds: ['p-sc'],
      layout: {
        splitPanes: [
          { projectId: 'p-sc', tabId: 's1', column: 0 },
          { projectId: 'p-sc', tabId: 'missing', column: 1 },
        ],
      },
    }],
    ...callbacks,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingTabs, [{ projectId: 'p-sc', tabId: 'missing', spaceId: 'space-sc' }]);
  assert.deepEqual(result.spaces.find((space) => space.id === 'space-sc').layout.splitPanes, []);
});
