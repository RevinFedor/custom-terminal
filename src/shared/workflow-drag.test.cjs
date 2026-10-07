const test=require('node:test'),assert=require('node:assert/strict');
const {applyDragLayout}=require('./workflow-drag.cjs');
const pane=tabId=>({windowId:'W',tabId,projectId:'P',tabs:['A','B','C'].map(tabId=>({projectId:'P',tabId}))});

test('late accepted drag preserves a newer shown tab and resize instead of stealing navigation',()=>{
  const before={splitPanes:[pane('A')],activeSpaceTab:{projectId:'P',tabId:'A'},splitSizes:[.4,.6]};
  const after={...before,splitPanes:[pane('B')],activeSpaceTab:{projectId:'P',tabId:'B'}};
  const current={...before,splitPanes:[pane('C')],activeSpaceTab:{projectId:'P',tabId:'C'},splitSizes:[.3,.7]};
  assert.deepEqual(applyDragLayout(current,before,after),current);
  assert.deepEqual(applyDragLayout(before,before,after),after);
});
test('a newer local order is not replaced by the older drag ACK',()=>{
  const before={splitPanes:[pane('A')]};
  const after={splitPanes:[{...pane('B'),tabs:[{projectId:'P',tabId:'B'},{projectId:'P',tabId:'A'},{projectId:'P',tabId:'C'}]}]};
  const current={splitPanes:[{...pane('C'),tabs:[{projectId:'P',tabId:'C'},{projectId:'P',tabId:'A'},{projectId:'P',tabId:'B'}]}]};
  assert.deepEqual(applyDragLayout(current,before,after),current);
});
