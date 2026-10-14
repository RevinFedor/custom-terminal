import test from 'node:test';
import assert from 'node:assert/strict';
import {commandNavigationMode,rebaseHierarchyModifier,usesFolderHover,folderApproachBlocksSlot} from './hierarchyModifier.js';

test('folder approach does not swap the header away in a gap; passing it keeps before/after slots',()=>{
  const rows=[{id:'folder',collapsible:true,hasChildren:true,top:30,bottom:58},{id:'leaf',top:62,bottom:94}];
  assert.equal(folderApproachBlocksSlot({from:1,to:0,pointerY:60,rows}),true);
  assert.equal(folderApproachBlocksSlot({from:1,to:0,pointerY:29,rows}),false);
  assert.equal(folderApproachBlocksSlot({from:0,to:1,pointerY:28,rows}),true);
  assert.equal(folderApproachBlocksSlot({from:0,to:1,pointerY:59,rows}),false);
  assert.equal(folderApproachBlocksSlot({from:1,to:0,pointerY:44,rows,protectedIds:['folder']}),false);
  assert.equal(folderApproachBlocksSlot({from:2,to:1,pointerY:90,rows}),false);
});

test('legacy callers keep Cmd navigation; opt-in hover never pauses Y or Cmd-X',()=>{
  assert.equal(commandNavigationMode(undefined,true,null),true);
  assert.equal(commandNavigationMode('meta',true,null),false);
  assert.equal(commandNavigationMode('meta',true,{targetId:'folder'},['source']),false);
  assert.equal(commandNavigationMode('meta',true,{targetId:'source',blocked:true},['source']),false);
  assert.equal(commandNavigationMode('meta',false,{targetId:'folder'}),false);
  assert.equal(usesFolderHover('meta',{navigationMode:false}),true);
  assert.equal(usesFolderHover(undefined,{navigationMode:false}),false);
  assert.equal(usesFolderHover(undefined,{navigationMode:true}),true);
});
test('modifier edges rebase X at current pointer, never replay distance travelled without Cmd',()=>{
  const drag={hierarchyMode:false,pointerX:350,pointerY:90,horizontalBaseX:15,horizontalBaseY:20,feedback:{direction:'right'},axisLock:'horizontal'};
  const entered=rebaseHierarchyModifier(drag,true,'meta');
  assert.equal(entered.horizontalBaseX,350);assert.equal(entered.horizontalBaseY,90);
  assert.equal(entered.axisLock,null);assert.equal(entered.feedback,null);
  assert.equal(rebaseHierarchyModifier(entered,true,'meta'),entered);
  const released=rebaseHierarchyModifier({...entered,pointerX:405},false,'meta');
  assert.equal(released.horizontalBaseX,405);assert.equal(released.hierarchyMode,false);
  assert.equal(rebaseHierarchyModifier(drag,true,undefined),drag);
});
