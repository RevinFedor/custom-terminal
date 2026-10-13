import test from 'node:test';import assert from 'node:assert/strict';
import {retainWorkflowOutline} from './workflowOutlineRetention.mjs';
const tree=()=>[{id:'group',groupId:'g',label:'Group',expanded:false,children:[{id:'a',label:'A',projectId:'p',contextParent:{tabId:'parent',name:'Parent'},children:[]}]}];
test('label updates retain a complete immutable tree; hidden relations, scope and order do not',()=>{
 const original=tree(),before=retainWorkflowOutline(null,'w',original),renamed=tree();renamed[0].label='Fresh';renamed[0].children[0].label='Live';
 assert.equal(retainWorkflowOutline(before,'w',renamed),before);
 const hidden=tree();hidden[0].children[0].contextParent.tabId='foreign';assert.notEqual(retainWorkflowOutline(before,'w',hidden),before);
 assert.notEqual(retainWorkflowOutline(before,'other',renamed),before);
 assert.notEqual(retainWorkflowOutline(before,'w',[...renamed,{id:'b',children:[]}]),before);
 assert.throws(()=>before.outline[0].children.push({id:'bad'}));
 original[0].children[0].contextParent.tabId='mutated';assert.equal(before.outline[0].children[0].contextParent.tabId,'parent');
});
test('only direct node.label is omitted; metadata labels, parent names, expansion and replacement markers invalidate',()=>{
 let current=retainWorkflowOutline(null,'w',tree());
 for(const change of [t=>t[0].expanded=true,t=>t[0].children[0].externalDragReplacement=true,
  t=>t[0].children[0].contextParent.name='changed',t=>t[0].externalPaneSource={entries:[{tabId:'a',projectId:'other'}]},
  t=>t[0].status={label:'status metadata'}]){
   const next=tree();change(next);assert.notEqual(retainWorkflowOutline(current,'w',next),current);
 }
});
test('unsupported data retains original behavior without freezing a mutable caller object',()=>{
 const candidate=[{id:'a',custom:new Map(),children:[]}],entry=retainWorkflowOutline(null,'w',candidate);
 assert.equal(entry.outline,candidate);assert.equal(entry.immutable,false);assert.equal(Object.isFrozen(candidate),false);
});
