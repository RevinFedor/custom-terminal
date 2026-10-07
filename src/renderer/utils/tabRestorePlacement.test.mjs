import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTabRestorePlacement, restoreSidebarTab, tabsAfterClose, restoreArchivedTabWindow } from './tabRestorePlacement.mjs';
import { emptyPaneByClosedTab, rememberPaneDetachedTab, restorePaneDetachedTab, paneSlots } from './splitPanesModel.mjs';

const tab = (id, parent, groupId = 'g') => ({ id, visualParentTabId: parent, groupId });
const chip = tabId => ({ projectId: 'p', tabId });
function fixture() {
  const workspace = { projectId: 'p', tabs: new Map([
    tab('left'), tab('parent'), tab('child', 'parent'), tab('grandchild', 'child'), tab('sibling', 'parent'), tab('right'),
  ].map(t => [t.id, t])), tabGroups: [{ id: 'g' }] };
  const state = { activeSpaceId: 'main', spaces: [{ id: 'main' }],
    splitPanes: [{ ...chip('child'), windowId: 'original', tabs: [chip('left'), chip('child'), { slotId: 'chooser', projectId: 'p' }, chip('right')] }] };
  return { workspace, state };
}
function close(f, id) {
  const value = captureTabRestorePlacement(f.state, f.workspace, id);
  f.workspace.tabs = tabsAfterClose(f.workspace.tabs, id);
  return value;
}
function restore(f, id, placement) {
  f.workspace.tabs.set(id, tab(id));
  f.workspace.tabs = restoreSidebarTab(f.workspace.tabs, id, placement, f.workspace.tabGroups);
}

test('child returns to its parent and before its own descendants, after another neighbour closes', () => {
  const f = fixture(), placement = close(f, 'child');
  close(f, 'left');
  assert.equal(f.workspace.tabs.get('grandchild').visualParentTabId, undefined);
  restore(f, 'child', placement);
  assert.deepEqual([...f.workspace.tabs.keys()], ['parent', 'child', 'grandchild', 'sibling', 'right']);
  assert.equal(f.workspace.tabs.get('child').visualParentTabId, 'parent');
  assert.equal(f.workspace.tabs.get('grandchild').visualParentTabId, 'child');
});

for (const order of [['child', 'parent'], ['parent', 'child']]) {
  test('closed parent/child restore in either order: ' + order.join(' → '), () => {
    const f = fixture();
    const parent = close(f, 'parent'), child = close(f, 'child');
    // Simulated persistence roundtrip, no process-local mapping.
    f.workspace.tabs = new Map(JSON.parse(JSON.stringify([...f.workspace.tabs])));
    for (const id of order) restore(f, id, id === 'parent' ? parent : child);
    assert.equal(f.workspace.tabs.get('child').visualParentTabId, 'parent');
    assert.equal(f.workspace.tabs.get('grandchild').visualParentTabId, 'child');
    assert.equal(f.workspace.tabs.get('sibling').visualParentTabId, 'parent');
    assert.deepEqual([...f.workspace.tabs.keys()], ['left', 'parent', 'child', 'grandchild', 'sibling', 'right']);
  });
}

test('restore does not mutate the pre-close snapshot or take a manually reparented child', () => {
  const f = fixture(), before = f.workspace.tabs, placement = close(f, 'parent');
  assert.equal(before.get('child').visualParentTabId, 'parent', 'failed durable close can keep old map');
  f.workspace.tabs.set('child', { ...f.workspace.tabs.get('child'), visualParentTabId: 'right', closedVisualParentTabId: undefined });
  restore(f, 'parent', placement);
  assert.equal(f.workspace.tabs.get('child').visualParentTabId, 'right');
});

test('a visual file subtree closes with its owner, but never traverses a surviving session', () => {
  const original = new Map([
    ['owner', tab('owner')],
    ['file', { ...tab('file', 'owner'), tabType: 'file' }],
    ['nested-file', { ...tab('nested-file', 'file'), tabType: 'file' }],
    ['session', { ...tab('session', 'file'), tabType: 'terminal' }],
    ['session-file', { ...tab('session-file', 'session'), tabType: 'file' }],
  ]);
  const next = tabsAfterClose(original, 'owner');
  assert.deepEqual([...next.keys()], ['session', 'session-file']);
  assert.equal(next.get('session').visualParentTabId, undefined);
  assert.equal(next.get('session-file').visualParentTabId, 'session');
  assert.equal(original.get('session').visualParentTabId, 'file');
});

test('removed group is not recreated; absent parent leaves the restored tab accessible', () => {
  const f = fixture(), p = close(f, 'child');
  close(f, 'parent'); f.workspace.tabGroups = [];
  restore(f, 'child', p);
  assert.equal(f.workspace.tabs.get('child').visualParentTabId, undefined);
  assert.equal(f.workspace.tabs.get('child').groupId, undefined);
  assert.equal(f.workspace.tabGroups.length, 0);
});

test('saved ancestor cannot create a cycle after other hierarchy edits', () => {
  const f = fixture(), p = close(f, 'child');
  f.workspace.tabs.get('parent').visualParentTabId = 'child';
  restore(f, 'child', p);
  assert.equal(f.workspace.tabs.get('child').visualParentTabId, undefined);
});

test('local remove/undo preserves exact chip position relative to chooser and cross-project tabs', () => {
  const f = fixture(), before = f.state.splitPanes;
  const empty = emptyPaneByClosedTab(before, 0, 'child');
  const removed = rememberPaneDetachedTab(empty.panes, 0, chip('child'), before[0]);
  const restored = restorePaneDetachedTab(removed.panes, 0);
  assert.deepEqual(paneSlots(restored.panes[0]), paneSlots(before[0]));
  assert.equal(restored.panes[0].tabId, 'child');
  assert.equal(restored.panes[0].detachedTabs, undefined);
});

test('archive restore finds the original window after reorder; background insertion keeps shown tab', () => {
  const f = fixture(), p = captureTabRestorePlacement(f.state, f.workspace, 'child');
  f.state.splitPanes = [chip('unrelated'), { ...chip('right'), windowId: 'original', tabs: [chip('left'), { slotId: 'chooser', projectId: 'p' }, chip('right')] }];
  const r = restoreArchivedTabWindow(f.state, p, 'p', 'child');
  assert.equal(r.patch.splitPanes[1].tabId, 'right');
  assert.deepEqual(paneSlots(r.patch.splitPanes[1]).map(s => s.tabId || s.slotId), ['left', 'child', 'chooser', 'right']);
  assert.equal(r.patch.splitPanes[0].tabId, 'unrelated');
});

test('archive restore preserves hidden workflow and never reuses a deleted window index', () => {
  const f = fixture(), p = captureTabRestorePlacement(f.state, f.workspace, 'child');
  const original = emptyPaneByClosedTab(f.state.splitPanes, 0, 'child').panes;
  f.state.activeSpaceId = 'other'; f.state.splitPanes = [chip('other')];
  f.state.spaces = [{ id: 'main', layout: { splitPanes: original } }, { id: 'other' }];
  const r = restoreArchivedTabWindow(f.state, p, 'p', 'child');
  assert.equal(r.patch.splitPanes, undefined);
  assert.equal(r.patch.spaces[0].layout.splitPanes[0].tabId, '');
  assert.ok(paneSlots(r.patch.spaces[0].layout.splitPanes[0]).some(s => s.tabId === 'child'));
  f.state.spaces[0].layout.splitPanes = [{ ...chip('new'), windowId: 'replacement' }];
  assert.equal(restoreArchivedTabWindow(f.state, p, 'p', 'child'), null);
});
