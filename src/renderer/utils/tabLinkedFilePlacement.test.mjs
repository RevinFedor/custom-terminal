import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedFileWindowState, linkedFileWindowSnapshot } from './tabLinkedFilePlacement.mjs';

const file = { id: 'file', projectId: 'p', ownerTabId: 'owner', path: '/fixture/a.md' };
const entry = { projectId: 'p', tabId: 'file' };
function fixture() {
  return { activeSpaceId: 'one', view: 'workspace', activeProjectId: 'p',
    splitPanes: [{ windowId: 'owner-window', projectId: 'p', tabId: 'owner' }], splitFocusedIndex: 0,
    spaces: [{ id: 'one', layout: {} }, { id: 'two', layout: {} }],
    openProjects: new Map([['p', { activeTabId: 'owner', tabs: new Map([
      ['owner', { id: 'owner' }], ['file', { id: 'file', tabType: 'file', filePath: file.path }],
    ]) }]]) };
}

test('a separately shown file is marked even when its window is not focused', () => {
  const state = fixture(); state.splitPanes.push({ windowId: 'file-window', ...entry });
  assert.equal(linkedFileWindowState(state, file), 'shown');
  const snapshot = linkedFileWindowSnapshot(state, [file]);
  state.splitFocusedIndex = 1;
  assert.equal(linkedFileWindowSnapshot(state, [file]), snapshot);
  state.splitPanes[1].tabId = 'other'; state.splitPanes[1].tabs = [entry, { projectId: 'p', tabId: 'other' }];
  assert.equal(linkedFileWindowState(state, file), 'parked');
});

test('hidden, dormant and saved-profile placements never claim visible reader state', () => {
  const state = fixture(); state.splitPanes.push({ ...entry, displayHidden: true });
  assert.equal(linkedFileWindowState(state, file), 'parked');
  state.splitPanes.pop(); state.spaces[1].layout = { splitPanes: [{ ...entry }] };
  assert.equal(linkedFileWindowState(state, file), 'parked');
  state.spaces[1].layout = { windowDisplayLayouts: { laptop: { splitPanes: [{ ...entry }] } } };
  assert.equal(linkedFileWindowState(state, file), 'parked');
});

test('removing a placement clears the mark without unlinking; matching paths are not identity', () => {
  const state = fixture(); state.splitPanes.push({ ...entry });
  state.splitPanes.pop();
  assert.equal(linkedFileWindowState(state, file), null);
  assert.ok(state.openProjects.get('p').tabs.has(file.id));
  state.splitPanes.push({ projectId: 'p', tabId: 'same-path-different-id' });
  assert.equal(linkedFileWindowState(state, file), null);
  state.splitPanes[1] = { ...entry };
  state.openProjects.get('p').tabs.get(file.id).filePath = '/renamed.md';
  assert.equal(linkedFileWindowState(state, file), null);
});

test('the single centre and Home use actual presentation, not stale namespace active tab', () => {
  const state = fixture(); state.splitPanes = []; state.centerStrips = { one: [entry] };
  state.activeSpaceTab = entry;
  assert.equal(linkedFileWindowState(state, file), 'shown');
  state.view = 'dashboard';
  assert.equal(linkedFileWindowState(state, file), 'parked');
  state.view = 'workspace'; state.activeSpaceTab = { projectId: 'p', tabId: 'owner' };
  state.openProjects.get('p').activeTabId = 'file';
  assert.equal(linkedFileWindowState(state, file), 'parked');
});
