import test from 'node:test';import assert from 'node:assert/strict';
import {canRetainPointerPublication,freezeOutlineData,readonlyDragSnapshot} from './pointerPublication.js';
function f(){
 const outline=[{id:'a',children:[]}];freezeOutlineData(outline);
 const current={phase:'dragging',ownerEpoch:4,sessionId:'s',sourceId:'a',pointerId:1,externalOwnerKey:'owner',
  sourceContext:Object.freeze({gestureId:'gesture'}),sourceIds:['a'],sourceRootIds:['a'],prepared:{},
  slot:{parentId:null,index:0,depth:0,boundary:0},boundary:0,pointerBoundary:0,renderRevision:7,
  pendingExpansionIds:new Set(),edgeGesture:{active:false,zone:null},pointerX:10,pointerY:20};
 return{current,next:{...current,pointerX:12,pointerY:22,horizontalBaseX:12,horizontalBaseY:22},
  painted:{ownerEpoch:4,sessionId:'s',revision:7,outline,drag:current},outline,previousOutline:outline,
  validatedImmutableOutline:outline,lease:null,previousLease:null,controlledOutline:outline,revision:7,ownerEpoch:4,inside:true};
}
test('ordinary processed coordinates may advance, acknowledged receipt must remain unchanged',()=>{
 const v=f();v.current.lastControlledOutline=v.controlledOutline;
 assert.equal(canRetainPointerPublication(v),true);assert.deepEqual(v.painted.drag.pointerX,10);
 v.current.edgeGesture={zone:'top',active:false,anchorY:20};v.next.edgeGesture={zone:'top',active:false,anchorY:22};
 assert.equal(canRetainPointerPublication(v),true,'an already acknowledged inactive zone still advances its live anchor');
 assert.equal(canRetainPointerPublication({...v,next:{...v.next,edgeGesture:{zone:'bottom',active:false}}}),false);
 const pending={...v,current:{...v.current,renderRevision:8},next:{...v.next,renderRevision:8},revision:8};
 assert.equal(canRetainPointerPublication(pending),false,'a submitted but unacknowledged view cannot retain a newer pointer');
});
test('same slot is insufficient across owner, mode, feedback, edge or control changes',()=>{
 const v=f();v.current.lastControlledOutline=v.controlledOutline;
 for(const patch of [{hierarchyMode:true},{navigationMode:true},{feedback:{direction:'right'}},{navigationDwell:{targetId:'folder'}},
  {externalTarget:{id:'pane'}},{folderHoverTargetId:'folder'},{edgeGesture:{active:true,zone:'bottom'}},
  {pendingExpansionIds:new Set(['folder'])},{externalReleasePending:{}},{sourceContext:{gestureId:'replacement'}},
  {ownerEpoch:5},{slot:{...v.next.slot,index:1}},{scrollReserve:20}])
  assert.equal(canRetainPointerPublication({...v,next:{...v.next,...patch}}),false,JSON.stringify(patch));
 assert.equal(canRetainPointerPublication({...v,controlledOutline:[]}),false);
 assert.equal(canRetainPointerPublication({...v,inside:false}),false);
 assert.equal(canRetainPointerPublication({...v,pendingLayout:{}}),false);
});
test('unsupported objects are not frozen or silently accepted as an immutable forest',()=>{
 const node={id:'a',children:[],data:new Map()};assert.equal(freezeOutlineData([node]),false);
 assert.equal(Object.isFrozen(node),false);
 let reads=0;const accessor={id:'b',get data(){reads++;return 1;}};
 assert.equal(freezeOutlineData([accessor]),false);assert.equal(reads,0);assert.equal(Object.isFrozen(accessor),false);
});
test('snapshot mutation cannot change live engine state or an acknowledged target',()=>{
 const v=f(),target={zone:'body',at:2,debug:{x:10},previewOutline:v.outline};
 const dto=readonlyDragSnapshot(v.current,{slot:v.current.slot,sourceIds:v.current.sourceIds,sourceContext:v.current.sourceContext,externalTarget:target});
 assert.equal(dto.gestureId,'gesture');assert.equal(dto.sourceContext,undefined);assert.equal(dto.externalTarget.previewOutline,undefined);
 assert.throws(()=>{dto.slot.index=8;});assert.throws(()=>{dto.externalTarget.debug.x=30;});
 assert.equal(v.current.slot.index,0);assert.equal(target.debug.x,10);
});
