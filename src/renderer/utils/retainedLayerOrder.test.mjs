import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedTabLayers } from './retainedLayerOrder.mjs';

const workspace = (...ids) => ({ tabs: new Map(ids.map((id) => [id, { id }])) });
const ids = (projects) => retainedTabLayers(projects).map(({ tab }) => tab.id);

test('navigation reorder preserves the relative order and identity of every retained tab', () => {
  const a = workspace('tab-c', 'tab-a');
  const b = workspace('tab-d', 'tab-b');
  const before = new Map([['project-a', a], ['project-b', b]]);
  const after = new Map([['project-b', b], ['project-a', a]]);
  assert.deepEqual(ids(after), ids(before));
  const original = retainedTabLayers(before);
  retainedTabLayers(after).forEach((layer, index) => assert.equal(layer.tab, original[index].tab));
  assert.deepEqual([...a.tabs.keys()], ['tab-c', 'tab-a'], 'sidebar order is not mutated');
});

test('sidebar reorder and cross-project transfer cannot move a surviving content layer', () => {
  const a = workspace('tab-c', 'tab-a');
  const b = workspace('tab-d', 'tab-b');
  const projects = new Map([['project-a', a], ['project-b', b]]);
  const baseline = ids(projects);
  a.tabs = new Map([...a.tabs].reverse());
  assert.deepEqual(ids(projects), baseline);
  const tab = a.tabs.get('tab-a');
  a.tabs.delete('tab-a');
  b.tabs.set('tab-a', tab);
  assert.deepEqual(ids(projects), baseline);
  const moved = retainedTabLayers(projects).find((layer) => layer.tab.id === 'tab-a');
  assert.equal(moved.projectId, 'project-b');
  assert.equal(moved.workspace, b);
  assert.equal(moved.tab, tab);
});

test('insertion and deletion change membership without reordering surviving layers', () => {
  const projects = new Map([['project-a', workspace('tab-c', 'tab-a')]]);
  const baseline = ids(projects);
  projects.set('project-b', workspace('tab-0', 'tab-b', 'tab-z'));
  assert.deepEqual(ids(projects).filter((id) => baseline.includes(id)), baseline);
  projects.delete('project-b');
  assert.deepEqual(ids(projects), baseline);
});
