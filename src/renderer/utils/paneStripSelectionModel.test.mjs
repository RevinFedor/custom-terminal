import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPaneStripTab,prunePaneStripSelection,paneStripSelectionEntries,
  classifyPaneStripColorSelection,editPaneStripColorGroups,paneStripOutlineGap,
  paneStripGroupDragBoundary,clampPaneStripGroupInsertion} from './paneStripSelectionModel.mjs';
const entries=['a','b','c','d','e'].map((tabId,i)=>({tabId,projectId:i%2?'N2':'N1'}));
test('plain click, Cmd toggles and Shift range use full strip order across wrapped rows, not namespace buckets',()=>{
  let s=selectPaneStripTab(null,entries,'b');assert.equal(s.activate,true);
  s=selectPaneStripTab(s.selection,entries,'e',{metaKey:true});assert.deepEqual(s.selection.tabIds,['b','e']);assert.equal(s.activate,false);
  s=selectPaneStripTab(s.selection,entries,'b',{metaKey:true});assert.deepEqual(s.selection.tabIds,['e']);
  s=selectPaneStripTab(s.selection,entries,'b',{shiftKey:true});assert.deepEqual(s.selection.tabIds,['b']);
  s=selectPaneStripTab(s.selection,entries,'e',{shiftKey:true});assert.deepEqual(s.selection.tabIds,['b','c','d','e']);
  s=selectPaneStripTab(s.selection,entries,'d');assert.deepEqual(s.selection.tabIds,['d']);assert.equal(s.activate,true);
});
test('removed members/anchors are pruned; drag of unselected tab never carries another selection',()=>{
  const s={tabIds:['a','c','e'],anchor:'c'};
  assert.deepEqual(prunePaneStripSelection(s,[entries[0],entries[4]]),{tabIds:['a','e'],anchor:null});
  assert.deepEqual(paneStripSelectionEntries(s,entries,'c'),[entries[0],entries[2],entries[4]]);
  assert.deepEqual(paneStripSelectionEntries(s,entries,'b'),[entries[1]]);
});
test('only free selection creates; exact whole group recolors; mixed/subset never merges or changes membership/order',()=>{
  const groups=[{id:'g1',color:'#aa00bb',tabIds:['a','b'],revision:2},{id:'g2',color:'#ffffff',tabIds:['d','e'],revision:1}];
  assert.equal(classifyPaneStripColorSelection(groups,['c']).kind,'create');
  assert.equal(classifyPaneStripColorSelection(groups,['b','a']).kind,'recolor');
  for(const ids of [['a'],['a','c'],['a','d'],['a','b','c'],[]]){
    assert.equal(classifyPaneStripColorSelection(groups,ids).kind,'disabled');
    assert.throws(()=>editPaneStripColorGroups(groups,ids,'#123456','new'));
  }
  const recolored=editPaneStripColorGroups(groups,['b','a'],'#ABCDEF');
  assert.deepEqual(recolored[0],{...groups[0],color:'#abcdef',revision:3});assert.equal(recolored[1],groups[1]);
  assert.equal(editPaneStripColorGroups(groups,['a','b'],'#aa00bb')[0],groups[0]);
  assert.deepEqual(groups[0].tabIds,['a','b']);
  const created=editPaneStripColorGroups(groups,['c'],'#123456','new');assert.deepEqual(created[2].tabIds,['c']);
});
test('membership candidate keeps exact selected IDs; CREATE gathers layout separately in the same transaction',()=>{
  const next=editPaneStripColorGroups([],['a','c'],'#111111','g');assert.deepEqual(next[0].tabIds,['a','c']);
  assert.deepEqual(entries.map(e=>e.tabId),['a','b','c','d','e']);
});
test('vertical clearance only adds missing pixels and never depends on group on/off',()=>{
  assert.equal(paneStripOutlineGap(6,4),6);assert.equal(paneStripOutlineGap(6,6),8);
  assert.equal(paneStripOutlineGap(9,4),9);
});
test('captured group drag stays between first/last member even across rows and never unwraps or changes membership',()=>{
  const groups=[{id:'g',color:'#123456',tabIds:['b','c','d'],revision:7}];
  const boundary=paneStripGroupDragBoundary(groups,{sourceIds:['d'],order:entries});
  assert.deepEqual(boundary,{kind:'group',groupId:'g',groupRevision:7,memberIds:['b','c','d'],sourceIds:['d'],start:1,end:3,wholeGroup:false,allowIndividualExternal:false});
  assert.equal(clampPaneStripGroupInsertion(boundary,-10),1);assert.equal(clampPaneStripGroupInsertion(boundary,99),3);
  assert.equal(clampPaneStripGroupInsertion(boundary,2),2);assert.deepEqual(groups[0].tabIds,['b','c','d']);
  assert.equal(paneStripGroupDragBoundary(groups,{sourceIds:['b','c','d'],order:entries}).wholeGroup,true);
  assert.equal(paneStripGroupDragBoundary(groups,{sourceIds:['a','b'],order:entries}).kind,'blocked');
  assert.equal(paneStripGroupDragBoundary(groups,{sourceIds:['a'],order:entries}).kind,'free');
});
test('DnD bounds use post-removal slots for single/multiple/whole-group source and never step past a foreign neighbor',()=>{
  const order=['x','a','b','c','y'],groups=[{id:'g',color:'#123456',tabIds:['a','b','c'],revision:9}];
  for(const sourceIds of [['b'],['a','c'],['a','b','c']]) {
    const boundary=paneStripGroupDragBoundary(groups,{sourceIds,order}),rest=order.filter(id=>!sourceIds.includes(id));
    assert.equal(boundary.start,1);assert.equal(boundary.end,4-sourceIds.length);
    assert.equal(boundary.wholeGroup,sourceIds.length===3);
    for(const candidate of [-1,0,1,2,3,4,99]) {
      const at=clampPaneStripGroupInsertion(boundary,candidate),next=[...rest.slice(0,at),...sourceIds,...rest.slice(at)];
      assert.equal(next[0],'x');assert.equal(next.at(-1),'y');
    }
  }
});
test('legacy noncontiguous group retains its original no-op slot; recolor never compacts the strip',()=>{
  const order=['a','x','b'],groups=[{id:'g',tabIds:['a','b'],revision:4,color:'#123456'}];
  const boundary=paneStripGroupDragBoundary(groups,{sourceIds:['b'],order});
  assert.equal(boundary.start,0);assert.equal(boundary.end,2);
  const rest=['a','x'],at=clampPaneStripGroupInsertion(boundary,2);
  assert.deepEqual([...rest.slice(0,at),'b',...rest.slice(at)],order);
  assert.deepEqual(editPaneStripColorGroups(groups,['a','b'],'#abcdef')[0].tabIds,['a','b']);
  const multiple=paneStripGroupDragBoundary([{...groups[0],tabIds:['a','b','c']}],{sourceIds:['a','c'],order:['L','a','x','b','y','c','R']});
  assert.equal(multiple.start,1);assert.equal(multiple.end,4);
  assert.equal(clampPaneStripGroupInsertion(multiple,99),4);
});
