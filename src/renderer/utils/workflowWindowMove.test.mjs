import test from 'node:test';
import assert from 'node:assert/strict';
import {moveWorkflowWindow} from './workflowWindowMove.mjs';
import {applyWindowDisplay,reconcileWindowDisplay,splitWindowPane} from './windowDisplayLayouts.mjs';
import {paneSlots,paneTabs} from './splitPanesModel.mjs';
const ref=tabId=>({projectId:'P',tabId});
const pane=(id,extra={})=>({windowId:id,...ref(id),tabs:[ref(id)],...extra});
const layout=panes=>({splitPanes:panes,splitFocusedIndex:0,centerStrips:{},splitSizes:null,windowDisplayLayouts:{}});
const laptop={key:'laptop',internal:true},desktop={key:'desktop',internal:false};
const freeze=value=>{if(value && typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};

test('explicit alongside chooses the requested hidden window, preserving the visible one and other hidden inventory',()=>{
  const original=[pane('a'),pane('b',{displayHidden:true}),pane('c',{displayHidden:true})];
  const moved=splitWindowPane(freeze(original),0,null,0,'right','c');
  assert.deepEqual(moved.panes.filter(p=>!p.displayHidden).map(p=>p.windowId),['a','c']);
  assert.equal(moved.panes.find(p=>p.windowId==='b').displayHidden,true);
  assert.equal(splitWindowPane(original,0,null,0,'right','absent'),null);
  assert.equal(splitWindowPane(original,0,null,0,'right','a'),null);
});
test('whole window move preserves tabs, chooser, shown selection, history and detached history',()=>{
  const original=pane('a',{tabs:[ref('a'),ref('a2'),{slotId:'choose',projectId:'P'}],selectedSlotId:'choose',tabId:'',
    history:[ref('previous')],detachedTabs:[{...ref('removed'),closedOrder:7}],custom:{value:1}});
  const source=layout([original,pane('b',{column:1})]),target=layout([pane('c')]);
  const moved=moveWorkflowWindow({sourceLayout:freeze(source),targetLayout:freeze(target),windowId:'a'});
  const incoming=moved.targetLayout.splitPanes.find(p=>p.windowId==='a');
  for(const key of ['tabs','selectedSlotId','tabId','history','detachedTabs','custom'])assert.deepEqual(incoming[key],original[key]);
  assert.deepEqual(moved.entries,[ref('a'),ref('a2')]);assert.equal(moved.sourceLayout.splitPanes.some(p=>p.windowId==='a'),false);
  assert.equal(moved.targetLayout.splitPanes.find(p=>p.windowId==='c').tabId,'c');
});
test('moving last visible window leaves a distinct vacant slot; old monitor profiles cannot resurrect it',()=>{
  let source=applyWindowDisplay(layout([pane('a'),pane('b',{column:1})]),desktop);
  source=applyWindowDisplay(source,laptop);
  source.splitPanes[1]={...source.splitPanes[1],displayHidden:true};source=reconcileWindowDisplay(source,laptop);
  const moved=moveWorkflowWindow({sourceLayout:freeze(source),targetLayout:layout([]),windowId:'a',display:laptop});
  const visible=moved.sourceLayout.splitPanes.filter(p=>!p.displayHidden);
  assert.equal(visible.length,1);assert.equal(visible[0].tabId,'');assert.notEqual(visible[0].windowId,'a');
  assert.equal(JSON.stringify(moved.sourceLayout.windowDisplayLayouts).includes('"windowId":"a"'),false);
  assert.equal(applyWindowDisplay(moved.sourceLayout,desktop).splitPanes.some(p=>p.windowId==='a'),false);
});
test('explicit move edits the laptop target layout while preserving the saved desktop layout',()=>{
  const target=applyWindowDisplay(layout([pane('b'),pane('c',{column:1}),pane('d',{column:2})]),desktop);
  const desktopBefore=structuredClone(target.windowDisplayLayouts.desktop);
  const moved=moveWorkflowWindow({sourceLayout:layout([pane('a')]),targetLayout:freeze(target),windowId:'a',display:laptop});
  assert.equal(moved.targetLayout.windowDisplayKey,'laptop');
  assert.deepEqual(moved.targetLayout.splitPanes.filter(p=>!p.displayHidden).map(p=>p.windowId),['b','a','c']);
  assert.deepEqual(moved.targetLayout.windowDisplayLayouts.desktop,desktopBefore);
  const roundTrip=applyWindowDisplay(applyWindowDisplay(moved.targetLayout,desktop),laptop);
  assert.deepEqual(roundTrip.splitPanes.filter(p=>!p.displayHidden).map(p=>p.windowId),['b','a','c']);
});
test('legacy single centre moves its complete strip to an empty workflow',()=>{
  const source={...layout([]),activeProjectId:'P',activeSpaceTab:ref('a'),centerStrips:{P:[ref('a'),ref('b')]}};
  const moved=moveWorkflowWindow({sourceLayout:freeze(source),targetLayout:layout([]),windowId:null});
  assert.deepEqual(paneTabs(moved.targetLayout.splitPanes[0]),[ref('a'),ref('b')]);
  assert.equal(paneSlots(moved.sourceLayout.splitPanes[0]).length,0);
  assert.deepEqual(moved.sourceLayout.centerStrips,{});
});
test('unknown or conflicting window identity refuses without replacing another window',()=>{
  const source=freeze(layout([pane('a')])),target=freeze(layout([pane('a')]));
  assert.equal(moveWorkflowWindow({sourceLayout:source,targetLayout:target,windowId:'missing'}),null);
  assert.equal(moveWorkflowWindow({sourceLayout:source,targetLayout:target,windowId:'a'}),null);
});
