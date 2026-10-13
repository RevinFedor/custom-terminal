import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowGroupExpansionQueue} from './workflowGroupExpansion.mjs';

test('cancel before expansion ACK waits, then writes the baseline with the ACK revision',async()=>{
  let state={revision:4,groups:[{id:'g',revision:2,collapsed:true}]},release,started;
  const began=new Promise(resolve=>started=resolve);
  const pending=new Promise(resolve=>release=resolve),requests=[];
  const change=createWorkflowGroupExpansionQueue({read:()=>state,mutationId:()=>String(requests.length),mutate:async request=>{
    requests.push(request);if(requests.length===1){started();await pending;}
    assert.equal(request.expectedRevision,state.revision);assert.equal(request.expectedGroupRevision,state.groups[0].revision);
    state={revision:state.revision+1,groups:[{...state.groups[0],revision:state.groups[0].revision+1,collapsed:request.collapsed}]};
    return{success:true};
  }});
  const expand=change('g',true),cancel=change('g',false);
  await began;assert.equal(requests.length,1);release();
  assert.deepEqual(await Promise.all([expand,cancel]),[true,true]);assert.equal(state.groups[0].collapsed,true);
  assert.deepEqual(requests.map(request=>[request.expectedRevision,request.expectedGroupRevision,request.collapsed]),[[4,2,false],[5,3,true]]);
});
test('a failed or missing group never yields an affirmative expansion ACK',async()=>{
  const state={revision:1,groups:[{id:'g',revision:1,collapsed:true}]};
  const change=createWorkflowGroupExpansionQueue({read:()=>state,mutationId:()=> 'same',mutate:async()=>({success:false})});
  assert.equal(await change('g',true),false);assert.equal(await change('absent',true),false);
});
