import test from 'node:test';
import assert from 'node:assert/strict';
import { contextCreatedTabPlacement } from './contextCreatedTabPlacement.mjs';
import { addTabToPane, reorderPaneTab, paneTabs } from './splitPanesModel.mjs';

const origin = {spaceId:'workflow',navigationRevision:4};
function state() {
  return {activeSpaceId:'workflow',navigationRevision:4,activeProjectId:'p',
    openProjects:new Map([['p',{activeTabId:'source'}]]),centerStrips:{},
    splitPanes:[{windowId:'window',projectId:'p',tabId:'source',tabs:[
      {projectId:'p',tabId:'source'},{projectId:'q',tabId:'neighbor'}]},
      {windowId:'other',projectId:'q',tabId:'independent'}]};
}
test('durable creation placement equals former append/select/reorder without exposing the intermediate strip', () => {
  const s=state(),surface={kind:'pane',paneIndex:0};
  const appended=addTabToPane(s.splitPanes,0,'p','child');
  const old=reorderPaneTab(appended.panes,0,'child',1);
  const placed=contextCreatedTabPlacement(s,surface,'p','source','child',origin);
  assert.deepEqual(placed.patch.splitPanes,old.panes);
  assert.equal(placed.patch.splitPanes[1],s.splitPanes[1]);
  assert.deepEqual(paneTabs(s.splitPanes[0]).map(x=>x.tabId),['source','neighbor']);
});
test('exact hidden-window identity survives an index move; stale workflow/navigation/source never steals placement', () => {
  const s=state(),surface={kind:'window',windowId:'window',spaceId:'workflow'};
  s.splitPanes.reverse();
  assert.equal(contextCreatedTabPlacement(s,surface,'p','source','child',origin).paneIndex,1);
  for(const change of [{activeSpaceId:'away'},{navigationRevision:5},
    {splitPanes:[{windowId:'window',projectId:'p',tabId:'replacement'}]}]) {
    assert.equal(contextCreatedTabPlacement({...s,...change},surface,'p','source','child',origin),null);
  }
});
test('sidebar remains reserve-only and a lone pane preserves its existing collapse rule', () => {
  const s=state();
  assert.equal(contextCreatedTabPlacement(s,null,'p','source','child',origin),null);
  s.splitPanes=s.splitPanes.slice(0,1);
  // A multi-chip pane remains a real window; adding cannot discard its neighbors.
  const placed=contextCreatedTabPlacement(s,{kind:'pane',paneIndex:0},'p','source','child',origin);
  assert.equal(placed.patch.splitPanes.length,1);
  assert.deepEqual(paneTabs(placed.patch.splitPanes[0]).map(x=>x.tabId),['source','child','neighbor']);
});
test('center inserts after the captured source and preserves foreign chips and the current workspace key', () => {
  const s=state();s.splitPanes=[];s.centerStrips={p:[{projectId:'p',tabId:'source'},{projectId:'q',tabId:'neighbor'}]};
  const placed=contextCreatedTabPlacement(s,{kind:'center'},'p','source','child',origin);
  assert.deepEqual(placed.patch.centerStrips.p.map(x=>x.tabId),['source','child','neighbor']);
  assert.equal(contextCreatedTabPlacement(s,{kind:'center'},'p','gone','child',origin),null);
});
