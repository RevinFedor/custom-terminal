import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createOrganizationCommitter} from './workflowOrganizationClient.mjs';
globalThis.crypto??=webcrypto;

function fixture(atSend=()=>{}) {
  const sent=[];
  const committer=createOrganizationCommitter({getPublication:()=>({revision:1}),
    invoke:async(channel,payload)=>{
      assert.equal(channel,'workflow:mutate');atSend();sent.push(structuredClone(payload));
      return {success:true,revision:2,mutationId:payload.request.mutationId};
    },applyPublication:async()=>{},onError:()=>{}});
  return {committer,sent};
}

test('a checked synchronous snapshot reaches admission before a queued navigation can revoke its UI authority',async()=>{
  let current=true,observed;
  const f=fixture(()=>{observed=current;});
  await f.committer.commit(()=>{
    assert.equal(current,true);
    queueMicrotask(()=>{current=false;});
    return {spaces:[],tabWorkflowMembership:{}};
  });
  assert.equal(current,false);assert.equal(observed,true);
  assert.equal(f.sent.length,1);
});

test('an actual asynchronous snapshot still resolves before admission',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;}),f=fixture();
  const run=f.committer.commit(()=>pending);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sent.length,0);
  release({spaces:[],tabWorkflowMembership:{},proof:'async-read-complete'});
  await run;
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].request.proof,'async-read-complete');
});
