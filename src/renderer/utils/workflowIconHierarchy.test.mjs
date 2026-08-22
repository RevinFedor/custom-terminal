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
    workflowIcon: 'terminal-color',
    projectIcon: 'terminal-gray',
  },
  {
    key: 'uav',
    projectPaths: ['/uav'],
    projectNames: ['agrotech'],
    workflowNames: ['uav repo'],
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
});

test('explicit workflow reset and existing icon survive migration', () => {
  const result = planWorkflowIconHierarchyMigration({
    presets,
    projects,
    spaces: [
      { id: 's1', name: 'main', icon: null, projectIds: ['p-main'], layout: {} },
      { id: 's2', name: 'other', icon: 'custom-color', projectIds: ['p-other'], layout: {} },
    ],
  });
  assert.deepEqual(result.spaceUpdates, [], 'metadata already explicit; project icons are a separate plan');
  assert.equal(result.projectUpdates.length, 2);
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
  assert.ok(!result.projectUpdates.some((update) => update.id === 'p-other'));
});

