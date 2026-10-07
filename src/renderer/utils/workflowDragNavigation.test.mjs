import test from 'node:test';
import assert from 'node:assert/strict';
import {applyWorkflowDragLayout} from './workflowDragNavigation.mjs';
const ref=tabId=>({projectId:'P',tabId});
const pane=(tabId,ids=['A','B','C'])=>({windowId:'W',...ref(tabId),tabs:ids.map(ref)});
const layout=tabId=>({splitPanes:[pane(tabId)],splitFocusedIndex:0,activeSpaceTab:ref(tabId),activeProjectId:'P',focusedProjectId:'P'});

test('away/back keeps the new navigation intent even when the location equals pickup',()=>{
  const before=layout('A'),after=layout('B');
  assert.deepEqual(applyWorkflowDragLayout(before,{beforeLayout:before,layout:after},{reveal:false}),before);
  assert.deepEqual(applyWorkflowDragLayout(before,{beforeLayout:before,layout:after}),after);
});
test('background completion keeps a newer shown tab while adding the moved chip',()=>{
  const before={...layout('A'),splitPanes:[pane('A',['A','C'])]},after=layout('B');
  const current={...before,splitPanes:[pane('C',['A','C'])],activeSpaceTab:ref('C')};
  const applied=applyWorkflowDragLayout(current,{beforeLayout:before,layout:after},{reveal:false});
  assert.deepEqual(applied.splitPanes[0].tabs.map(t=>t.tabId),['A','B','C']);
  assert.equal(applied.splitPanes[0].tabId,'C');assert.deepEqual(applied.activeSpaceTab,ref('C'));
});
test('removing the previous selection does not resurrect an invalid source chip',()=>{
  const before=layout('A'),after={...layout('C'),splitPanes:[pane('C',['B','C'])]};
  const applied=applyWorkflowDragLayout(before,{beforeLayout:before,layout:after},{reveal:false});
  assert.deepEqual(applied.splitPanes[0].tabs.map(t=>t.tabId),['B','C']);assert.equal(applied.activeSpaceTab.tabId,'C');
});
