import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchWorkflowIconPreset,
  planWorkflowIconHierarchyMigration,
} from './workflowIconHierarchy.mjs';

const presets = [
  {
    key: 'terminal',
    projectPaths: ['/terminal'],
    projectNames: ['terminal'],
    workflowNames: ['main'],
    canonicalWorkflowName: 'main',
    workflowIcon: 'terminal-color',
    projectIcon: 'terminal-gray',
  },
  {
    key: 'uav',
    projectPaths: ['/uav'],
    projectNames: ['agrotech'],
    workflowNames: ['uav repo'],
    canonicalWorkflowName: 'uav repo',
    workflowIcon: 'uav-color',
    projectIcon: 'uav-gray',
  },
];

const projects = [
  { id: 'p-main', name: 'custom-terminal', path: '/terminal', icon: 'old-terminal' },
  { id: 'p-uav', name: 'agrotech', path: '/uav', icon: 'old-uav' },
  { id: 'p-other', name: 'other', path: '/other', icon: 'old-other' },
];

test('preset matches exact path first and normalized name as fallback', () => {
  assert.equal(matchWorkflowIconPreset(projects[0], presets)?.key, 'terminal');
  assert.equal(matchWorkflowIconPreset({ name: ' AGROTECH ', path: '/moved' }, presets)?.key, 'uav');
  assert.equal(matchWorkflowIconPreset(projects[2], presets), null);
});

test('named workflow reserves its project before cross-project layout inference', () => {
  const result = planWorkflowIconHierarchyMigration({
    presets,
    projects,
    spaces: [
      {
        id: 's-main',
        name: 'main',
        icon: undefined,
        projectIds: ['p-main', 'p-uav', 'p-other'],
        layout: { activeProjectId: 'p-main' },
      },
      {
        id: 's-uav',
        name: 'uav repo',
        icon: undefined,
        projectIds: ['p-uav'],
        layout: { activeProjectId: 'p-uav' },
      },
    ],
  });
  assert.deepEqual(result.spaceUpdates, [
    { id: 's-main', icon: 'terminal-color', projectIds: ['p-main', 'p-other'] },
    { id: 's-uav', icon: 'uav-color', projectIds: ['p-uav'] },
  ]);
  assert.deepEqual(result.projectUpdates, [
    { id: 'p-main', icon: 'terminal-gray', presetKey: 'terminal' },
    { id: 'p-uav', icon: 'uav-gray', presetKey: 'uav' },
  ]);
  assert.deepEqual(result.spaceCreates, []);
});

test('known built-in workflow returns to exact catalog icon; unknown custom icon survives', () => {
  const result = planWorkflowIconHierarchyMigration({
    presets,
    projects,
    spaces: [
      { id: 's1', name: 'main', icon: null, projectIds: ['p-main'], layout: {} },
      { id: 's2', name: 'other', icon: 'custom-color', projectIds: ['p-other'], layout: {} },
    ],
  });
  assert.deepEqual(result.spaceUpdates, [
    { id: 's1', icon: 'terminal-color', projectIds: ['p-main'] },
  ]);
  assert.equal(result.projectUpdates.length, 2);
});

test('missing explicitly ensured workflow is created and reserves its project', () => {
  const ensured = {
    key: 'gt',
    projectPaths: ['/gt'],
    projectNames: ['gt-editor'],
    workflowNames: ['gt-editor'],
    canonicalWorkflowName: 'gt-editor',
    ensureWorkflow: true,
    workflowIcon: 'gt-color',
    projectIcon: 'gt-original',
  };
  const result = planWorkflowIconHierarchyMigration({
    presets: [...presets, ensured],
    projects: [...projects, { id: 'p-gt', name: 'gt-editor', path: '/gt', icon: 'old-gt' }],
    spaces: [{
      id: 's-main',
      name: 'main',
      icon: 'terminal-color',
      projectIds: ['p-main', 'p-gt'],
      layout: {},
    }],
  });
  assert.deepEqual(result.spaceUpdates, [
    { id: 's-main', icon: 'terminal-color', projectIds: ['p-main'] },
  ]);
  assert.deepEqual(result.spaceCreates, [{
    presetKey: 'gt',
    name: 'gt-editor',
    icon: 'gt-color',
    projectIds: ['p-gt'],
  }]);
});

test('legacy unknown workflow copies its project icon and never rewrites unknown project icon', () => {
  const result = planWorkflowIconHierarchyMigration({
    presets,
    projects,
    spaces: [{
      id: 's-other',
      name: 'other',
      icon: undefined,
      projectIds: [],
      layout: { activeProjectId: 'p-other' },
    }],
  });
  assert.deepEqual(result.spaceUpdates, [
    { id: 's-other', icon: 'old-other', projectIds: ['p-other'] },
  ]);
  assert.deepEqual(result.spaceCreates, []);
  assert.ok(!result.projectUpdates.some((update) => update.id === 'p-other'));
});

test('system Inbox is never claimed by a workflow even when legacy layout points at it', () => {
  const result = planWorkflowIconHierarchyMigration({
    presets,
    projects: [
      ...projects,
      { id: '__noted_inbox__', name: 'Inbox', path: '~', icon: null },
    ],
    spaces: [{
      id: 'space-1',
      name: 'main',
      icon: 'terminal-color',
      projectIds: ['p-main', '__noted_inbox__'],
      layout: {
        activeProjectId: 'p-main',
        focusedProjectId: '__noted_inbox__',
        splitPanes: [{ projectId: '__noted_inbox__', tabId: 'inbox-tab' }],
      },
    }],
  });

  assert.deepEqual(result.spaceUpdates, [{
    id: 'space-1',
    icon: 'terminal-color',
    projectIds: ['p-main'],
  }]);
  assert.ok(!result.projectUpdates.some((update) => update.id === '__noted_inbox__'));
});
