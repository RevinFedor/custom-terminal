import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTabLinkNavigation, seedTabWorkflowMemory, normalizeTabWorkflowMemory } from './tabLinkNavigation.mjs';
import { buildSessionSnapshot } from './sessionSnapshot.mjs';

const pane = (id, ids = [id]) => ({ projectId: 'p', tabId: id,
  tabs: ids.map(tabId => ({ projectId: 'p', tabId })) });
const fixture = () => ({ activeSpaceId: 'b', splitPanes: [pane('b-current')], splitFocusedIndex: 0,
  activeProjectId: 'p', centerStrips: {}, activeSpaceTab: { projectId: 'p', tabId: 'b-current' },
  openProjects: new Map([['p', { projectId: 'p', projectPath: '/fixture',
    activeTabId: 'b-current', tabs: new Map(['b-current','a-current','target'].map(id => [id, {id}])) }]]),
  spaces: [{ id: 'a', projectIds: ['p'], layout: { splitPanes: [pane('a-left'),pane('a-current')], splitFocusedIndex: 1 } },
    { id: 'b', projectIds: [], layout: {} }], tabLastWorkflowIds: {target:'a'} });

test('existing non-selected chip wins over memory and preserves both windows', () => {
  const state=fixture();state.spaces[0].layout.splitPanes[0]=pane('a-left',['a-left','target']);
  state.tabLastWorkflowIds.target='b';const before=JSON.stringify(state.spaces);
  assert.deepEqual(resolveTabLinkNavigation(state,'target'),{kind:'reveal',spaceId:'a',paneIndex:0});
  assert.equal(JSON.stringify(state.spaces),before);assert.equal(state.splitPanes[0].tabId,'b-current');
});
test('unplaced link appends in remembered workflow focus rather than current foreign workflow', () => {
  const state=fixture();assert.deepEqual(resolveTabLinkNavigation(state,'target'),{kind:'append',spaceId:'a',paneIndex:1});
});
test('hidden windows are placed, not reserve', () => {
  const state=fixture();state.spaces[0].layout.splitPanes[1]={...pane('target'),displayHidden:true};
  assert.deepEqual(resolveTabLinkNavigation(state,'target'),{kind:'reveal',spaceId:'a',paneIndex:1});
});
test('single centre is placed even without a one-item strip', () => {
  const state=fixture();state.spaces[0].layout={splitPanes:[],activeSpaceTab:{projectId:'p',tabId:'target'}};
  assert.deepEqual(resolveTabLinkNavigation(state,'target'),{kind:'reveal',spaceId:'a',paneIndex:-1});
});
test('canonical membership wins over older navigation memory after explicit move', () => {
  const state=fixture();state.tabWorkflowMembership={target:{workflowId:'b'}};
  assert.deepEqual(resolveTabLinkNavigation(state,'target'),{kind:'append',spaceId:'b',paneIndex:0});
});
test('durable detached entry recovers last workflow for legacy tabs', () => {
  const state=fixture();state.tabLastWorkflowIds={};
  state.spaces[0].layout.splitPanes[0].detachedTabs=[{projectId:'p',tabId:'target',closedOrder:12345}];
  assert.deepEqual(resolveTabLinkNavigation(state,'target'),{kind:'append',spaceId:'a',paneIndex:1});
});
test('startup seed imports legacy association once and session save carries exact memory', () => {
  const state=fixture();state.tabLastWorkflowIds=seedTabWorkflowMemory(state,{});
  assert.equal(state.tabLastWorkflowIds.target,'a');
  assert.deepEqual(buildSessionSnapshot(state).tabLastWorkflowIds,state.tabLastWorkflowIds);
  state.spaces[0].projectIds=[];assert.equal(resolveTabLinkNavigation(state,'target').spaceId,'a');
});
test('malformed memory does not masquerade as destinations', () => {
  assert.deepEqual(normalizeTabWorkflowMemory('wrong'),{});
  assert.deepEqual(normalizeTabWorkflowMemory(['a']),{});
  assert.deepEqual(normalizeTabWorkflowMemory({target:'a',bad:12}),{target:'a'});
});
