import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openProjectIdsFingerprint,
  tabSidebarProjectFingerprint,
} from './tabSidebarProjectFingerprint.mjs';

const workspace = () => ({
  projectId: 'project-a',
  activeTabId: 'tab-a',
  activeGroupId: null,
  currentView: 'terminal',
  viewingSubAgentTabId: null,
  selectedTabIds: [],
  tabGroups: [{ id: 'group-a', name: 'Group', collapsed: false }],
  tabs: new Map([
    ['tab-a', { id: 'tab-a', name: 'A', cwd: '/a', taskPlan: { id: 'p', items: [] } }],
    ['tab-b', { id: 'tab-b', name: 'B', cwd: '/b', groupId: 'group-a' }],
  ]),
});

test('in-place row changes wake only the owning project projection', () => {
  const value = workspace();
  const before = tabSidebarProjectFingerprint(value);
  value.tabs.get('tab-b').name = 'Renamed';
  const after = tabSidebarProjectFingerprint(value);
  assert.notEqual(after, before);
});

test('selection, hierarchy and task markers participate in the projection', () => {
  const value = workspace();
  const base = tabSidebarProjectFingerprint(value);
  value.selectedTabIds.push('tab-b');
  const selected = tabSidebarProjectFingerprint(value);
  assert.notEqual(selected, base);
  value.tabs.get('tab-b').visualParentTabId = 'tab-a';
  const nested = tabSidebarProjectFingerprint(value);
  assert.notEqual(nested, selected);
  value.tabs.get('tab-a').taskPlan.items.push({ id: 'i', title: 'Work', status: 'in_progress' });
  assert.notEqual(tabSidebarProjectFingerprint(value), nested);
});

test('large non-visual payload does not invalidate the sidebar', () => {
  const value = workspace();
  const before = tabSidebarProjectFingerprint(value);
  value.tabs.get('tab-a').notes = 'x'.repeat(100_000);
  value.tabs.get('tab-a').sdkMessages = [{ role: 'assistant', content: 'large transcript' }];
  assert.equal(tabSidebarProjectFingerprint(value), before);
});

test('open project identity is order-stable and independent from workspace mutation', () => {
  const projects = new Map([['a', {}], ['b', {}]]);
  const before = openProjectIdsFingerprint(projects);
  projects.get('a').changed = true;
  assert.equal(openProjectIdsFingerprint(projects), before);
  projects.set('c', {});
  assert.notEqual(openProjectIdsFingerprint(projects), before);
});
