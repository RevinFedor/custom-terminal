import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkflowReserve, workflowPlacedTabIds, workflowReserveOutline, workflowGroupKey,
  reservePaneEntries,projectReservePaneSource } from './workflowReserve.mjs';

function fixture() {
  const tabs = new Map(Array.from({ length: 6 }, (_, i) => [`t${i}`, { id: `t${i}`, name: `Tab ${i}`, groupId: 'g' }]));
  const state = { openProjects: new Map([['legacy', { tabs, tabGroups: [{ id: 'g', name: 'Group' }] }]]),
    tabWorkflowMembership: Object.fromEntries([...tabs.keys()].map(id => [id, { workflowId: 'w', revision: 2 }])),
    spaces: [{ id: 'w', kind: 'user', layout: {} }, { id: 'inbox', kind: 'inbox', layout: {} }],
    activeSpaceId: 'w', splitPanes: [], centerStrips: {}, activeSpaceTab: null };
  return state;
}
test('empty local workflow group participates in the same outline and does not leak to another workflow', () => {
  const state=fixture();
  state.globalGroups={groups:[{id:'empty',name:'Empty',reserveWorkflowId:'w',collapsed:false},
    {id:'foreign',name:'Foreign',reserveWorkflowId:'inbox'}],tabGroups:{}};
  let tree=workflowReserveOutline(selectWorkflowReserve(state));
  const empty=tree.find(node=>node.groupId==='empty');
  assert.ok(empty);assert.equal(empty.collapsible,true);assert.deepEqual(empty.children,[]);
  assert.equal(tree.some(node=>node.groupId==='foreign'),false);
  state.globalGroups.tabGroups.t0='empty';
  tree=workflowReserveOutline(selectWorkflowReserve(state));
  assert.equal(tree.filter(node=>node.groupId==='empty').length,1);
  assert.deepEqual(tree.find(node=>node.groupId==='empty').children.map(node=>node.tabId),['t0']);
});
test('cross-group parent remains a context reference without changing its relationship', () => {
  const state=fixture(),tabs=state.openProjects.get('legacy').tabs;
  tabs.get('t1').visualParentTabId='t0';tabs.get('t1').groupId='other';
  state.openProjects.get('legacy').tabGroups.push({id:'other',name:'Other'});
  const tree=workflowReserveOutline(selectWorkflowReserve(state));
  const child=tree.find(node=>node.groupId==='other').children[0];
  assert.equal(child.contextParent.tabId,'t0');
  assert.equal(tabs.get('t1').visualParentTabId,'t0');
});
test('pane adoption projects the exact family without mutating placement or catalog',()=>{
  const state=fixture(),tabs=state.openProjects.get('legacy').tabs;
  tabs.get('t1').visualParentTabId='t0';
  tabs.get('t2').tabType='file';tabs.get('t2').visualParentTabId='t0';
  state.splitPanes=[{tabs:[{projectId:'legacy',tabId:'t0'}]}];
  const before=structuredClone(state),model=selectWorkflowReserve(state),outline=workflowReserveOutline(model);
  const projected=projectReservePaneSource(model,outline,{owner:'pane',rootTabId:'t0',entries:[{projectId:'legacy',tabId:'t0'}]});
  assert.equal(projected.sourceId,'reserve-tab:t0');
  const root=projected.outline.at(-1);
  assert.deepEqual(root.children.map(node=>node.tabId),['t1','t2']);
  assert.deepEqual(projected.metadata.familyIds,['t0','t1','t2']);
  const ids=[];const walk=nodes=>nodes.forEach(node=>{if(node.tabId)ids.push(node.tabId);walk(node.children)});walk(projected.outline);
  assert.equal(new Set(ids).size,ids.length);assert.deepEqual(state,before);
  assert.equal(projectReservePaneSource(model,outline,{owner:'pane',rootTabId:'t0',entries:[{projectId:'foreign',tabId:'t0'}]}),null);
});
test('0/1/6 reserve uses canonical membership only and preserves manual order', () => {
  const state = fixture();
  assert.equal(selectWorkflowReserve(state).reserve.length, 6);
  state.splitPanes = [{ tabs: [...state.openProjects.get('legacy').tabs.keys()].map(tabId => ({ tabId })) }];
  assert.equal(selectWorkflowReserve(state).reserve.length, 0);
  state.splitPanes[0].tabs.pop();
  assert.deepEqual(selectWorkflowReserve(state).reserve.map(x => x.tabId), ['t5']);
  state.splitPanes = [];
  assert.deepEqual(selectWorkflowReserve(state, 'w', ['t5', 't2']).reserve.map(x => x.tabId), ['t5', 't2', 't0', 't1', 't3', 't4']);
  state.spaces[1].projectIds = ['legacy'];
  assert.equal(selectWorkflowReserve(state, 'inbox').reserve.length, 0);
});
test('hidden, parked, dormant, alternate profiles and singleton center are all placements', () => {
  const state = fixture();
  state.splitPanes = [{ tabId: 't0', displayHidden: true, tabs: [{ tabId: 't0' }, { tabId: 't1' }, { slotId: 't5' }] }];
  state.spaces[1].layout = { splitPanes: [{ tabId: 't2' }] };
  state.windowDisplayLayouts = { monitor: { splitPanes: [{ tabs: [{ tabId: 't3' }] }] } };
  state.activeSpaceTab = { tabId: 't4' };
  assert.deepEqual([...workflowPlacedTabIds(state)], ['t0', 't1', 't4', 't3', 't2']);
  assert.deepEqual(selectWorkflowReserve(state).reserve.map(x => x.tabId), ['t5']);
});
test('live layout replaces stale active snapshot, profile mirrors do not conflict', () => {
  const state = fixture();
  state.spaces[0].layout = { splitPanes: [{ tabId: 't0' }], windowDisplayLayouts: { a: { activeSpaceTab: { tabId: 't1' } } } };
  assert.equal(workflowPlacedTabIds(state).has('t0'), false);
  assert.equal(workflowPlacedTabIds(state).has('t1'), true);
  state.windowDisplayLayouts = { a: { activeSpaceTab: { tabId: 't2' } }, b: { splitPanes: [{ tabId: 't2' }] } };
  assert.deepEqual([...workflowPlacedTabIds(state)], ['t2']);
});
test('history, detached references and geometry-only profile do not consume reserve', () => {
  const state = fixture();
  state.splitPanes = [{ tabs: [{ slotId: 't0' }], history: [{ tabId: 't1' }], detachedTabs: [{ tabId: 't2' }] }];
  state.windowDisplayLayouts = { ext: { positions: [{ windowId: 't3' }], focusedWindowId: 't4' } };
  assert.equal(selectWorkflowReserve(state).reserve.length, 6);
});
test('partial group has two old members; full placement hides projection without deleting definition', () => {
  const state = fixture();
  state.splitPanes = [{ tabs: ['t0', 't1', 't2', 't3'] }];
  let model = selectWorkflowReserve(state), tree = workflowReserveOutline(model);
  assert.deepEqual(tree[0].children.map(x => x.tabId), ['t4', 't5']);
  assert.equal(tree[0].groupId, 'g');
  state.splitPanes[0].tabs.push('t4', 't5');
  model = selectWorkflowReserve(state);
  assert.equal(model.groups.size, 1); assert.equal(model.visibleGroups.size, 0);
  assert.deepEqual(workflowReserveOutline(model), []);
});
test('group identities include namespace, even with equal group IDs', () => {
  const state = fixture();
  state.openProjects.set('other', { tabs: new Map([['other', { id: 'other', groupId: 'g' }]]), tabGroups: [{ id: 'g', name: 'Other' }] });
  state.tabWorkflowMembership.other = { workflowId: 'w', revision: 1 };
  const model = selectWorkflowReserve(state), tree = workflowReserveOutline(model);
  assert.notEqual(workflowGroupKey('legacy', 'g'), workflowGroupKey('other', 'g'));
  assert.deepEqual(tree.map(x => x.label), ['Group', 'Other']);
});
test('files belong to exact owner, include placed/non-Markdown/cross-namespace files, not child attachments', () => {
  const state = fixture();
  state.openProjects.set('files', { tabs: new Map([
    ['f', { id: 'f', tabType: 'file', filePath: '/a.json', visualParentTabId: 't0' }],
    ['child', { id: 'child', parentTabId: 't0' }],
    ['cf', { id: 'cf', tabType: 'file', filePath: '/b.md', visualParentTabId: 'child' }],
  ]) });
  state.splitPanes = [{ tabId: 'f' }];
  const model = selectWorkflowReserve(state);
  assert.deepEqual(model.filesByOwner.get('t0').map(x => x.tabId), ['f']);
  assert.deepEqual(model.filesByOwner.get('child').map(x => x.tabId), ['cf']);
});
test('visual hierarchy survives filtering; placed parent becomes context, not duplicated card', () => {
  const state = fixture(), tabs = state.openProjects.get('legacy').tabs;
  tabs.get('t1').visualParentTabId = 't0';
  let tree = workflowReserveOutline(selectWorkflowReserve(state));
  assert.deepEqual(tree[0].children[0].children.map(x => x.tabId), ['t1']);
  state.splitPanes = [{ tabId: 't0' }];
  tree = workflowReserveOutline(selectWorkflowReserve(state));
  assert.equal(tree[0].children[0].contextParent.tabId, 't0');
  assert.equal(tree[0].children.some(x => x.tabId === 't0'), false);
});
test('cycles never discard reserve members or recurse forever', () => {
  const state = fixture(), tabs = state.openProjects.get('legacy').tabs;
  tabs.get('t0').visualParentTabId = 't1'; tabs.get('t1').visualParentTabId = 't0';
  assert.equal(workflowReserveOutline(selectWorkflowReserve(state))[0].children.length, 6);
});
test('pane payload uses selected visual roots and exact namespaces, not attachments', () => {
  const state = fixture(), tabs = state.openProjects.get('legacy').tabs;
  tabs.get('t1').visualParentTabId = 't0';
  const model = selectWorkflowReserve(state), tree = workflowReserveOutline(model);
  assert.deepEqual(reservePaneEntries(model, tree[0].children[0], ['t0', 't1', 't4']),
    [{ projectId: 'legacy', tabId: 't0' }, { projectId: 'legacy', tabId: 't4' }]);
});
test('archived and missing membership do not leak into reserve; input objects untouched', () => {
  const state = fixture();
  state.openProjects.get('legacy').tabs.get('t0').archivedAt = 1;
  delete state.tabWorkflowMembership.t1;
  const tabs = state.openProjects.get('legacy').tabs, old = tabs.get('t2');
  assert.equal(selectWorkflowReserve(state).reserve.length, 4);
  assert.equal(tabs.get('t2'), old); assert.equal(tabs.size, 6);
});
