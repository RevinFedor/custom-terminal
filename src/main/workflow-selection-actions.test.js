'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWorkflowSelectionActions}=require('./workflow-selection-actions');
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(overrides={}) {
  const records=new Map(),members=new Map(['a','b','foreign'].map((tabId,index)=>[tabId,{tabId,active:true,namespace:index===1?'Q':'P',
    subject:{id:tabId},membership:{workflowId:'W',revision:2},owner:{generation:1,token:tabId}}]));
  const receipts=new Map(),calls=[],captures=[];
  const journal={read:id=>records.get(id),admit:value=>{records.set(value.mutationId,copy({...value,steps:{}}));},
    prepare:(value,member)=>({token:value.mutationId+':'+member.tabId}),
    start:(value,member)=>{const steps=records.get(value.mutationId).steps;
      if(steps[member.tabId]?.state==='started'||steps[member.tabId]?.state==='completed')return {acquired:false};
      steps[member.tabId]={state:'started'};return {acquired:true};},
    complete:(value,member,actual)=>{records.get(value.mutationId).steps[member.tabId]={state:'completed',actual:copy(actual)};}};
  const execute=async args=>{assert.equal(records.get(args.command.mutationId).steps[args.member.tabId].state,'started');
    assert.equal(args.guard(),true);calls.push([args.command.action,args.member.tabId]);
    receipts.set(args.member.tabId,{mutationId:args.command.mutationId,action:args.command.action,tabId:args.member.tabId,owner:args.member.owner});};
  const ports={journal,captureMember:tabId=>{captures.push(tabId);return members.get(tabId);},
    isMemberCurrent:member=>JSON.stringify(members.get(member.tabId))===JSON.stringify(member),observeStop:async()=>({known:true,found:true}),
    closeTarget:execute,stopTarget:execute,readReceipt:async(_value,member)=>receipts.get(member.tabId),
    verifyReceipt:(value,member,actual)=>actual.mutationId===value.mutationId&&actual.action===value.action
      && actual.tabId===member.tabId&&JSON.stringify(actual.owner)===JSON.stringify(member.owner),...overrides};
  // The capture port returns Main identity, not the duplicate address fields.
  ports.isMemberCurrent=overrides.isMemberCurrent || (member=>{
    const expected=members.get(member.tabId);return !!expected&&expected.namespace===member.projectId
      &&JSON.stringify(expected.subject)===JSON.stringify(member.subject)&&JSON.stringify(expected.membership)===JSON.stringify(member.membership)
      &&JSON.stringify(expected.owner)===JSON.stringify(member.owner);
  });
  const api=createWorkflowSelectionActions(ports),request={version:1,mutationId:'op',action:'stop',
    members:[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'}],origin:{workflowId:'W',windowId:'win'}};
  return {api,request,records,members,receipts,calls,captures,ports};
}
test('captures entire ordered cross-namespace selection before any await and never includes foreign workflow members',async()=>{
  const f=fixture();f.api.begin(f.request);assert.deepEqual(f.captures,['a','b']);
  await f.api.step({mutationId:'op',tabId:'a'});await f.api.step({mutationId:'op',tabId:'b'});
  assert.deepEqual(f.calls,[['stop','a'],['stop','b']]);assert.ok(f.api.receipt('op').completed);
  await assert.rejects(f.api.step({mutationId:'op',tabId:'foreign'}),/not_requested/);
});
test('same ID retries the original fingerprint and rejects expanded/reordered sets, namespace or caller-supplied owner proofs',()=>{
  const f=fixture();f.api.begin(f.request);f.members.get('a').owner.generation++;
  f.api.begin(copy(f.request));assert.equal(f.captures.length,2);
  assert.throws(()=>f.api.begin({...f.request,members:[...f.request.members].reverse()}),/id_conflict/);
  assert.throws(()=>f.api.begin({...f.request,owner:{token:'forged'}}),/invalid/);
  const second=fixture();assert.throws(()=>second.api.begin({...second.request,members:[{projectId:'Q',tabId:'a'}]}),/capture_unknown/);
});
test('owner/subject/membership change during Stop observation cannot signal the replacement owner',async()=>{
  for(const field of ['owner','subject','membership']) {
    let release;const hold=new Promise(resolve=>release=resolve),f=fixture({observeStop:()=>hold});
    f.api.begin(f.request);const result=f.api.step({mutationId:'op',tabId:'a'});
    f.members.get('a')[field]={replacement:true};release({known:true,found:true});
    assert.equal((await result).skipped,true);assert.deepEqual(f.calls,[]);
  }
});
test('started/UNKNOWN after lost ACK never retries Stop after restart, absent process or forged success; canonical original receipt recovers it',async()=>{
  const f=fixture({stopTarget:async()=>{throw Error('lost ACK');},readReceipt:async()=>null});
  f.api.begin(f.request);assert.equal((await f.api.step({mutationId:'op',tabId:'a'})).pending,true);
  let attempts=0;const restored=createWorkflowSelectionActions({...f.ports,stopTarget:async()=>attempts++,observeStop:async()=>({known:true,found:false})});
  assert.equal((await restored.step({mutationId:'op',tabId:'a'})).pending,true);assert.equal(attempts,0);
  const actual={mutationId:'op',action:'stop',tabId:'a',owner:{generation:1,token:'a'}};
  const recovered=createWorkflowSelectionActions({...f.ports,readReceipt:async()=>actual});
  assert.ok((await recovered.ack({mutationId:'op',tabId:'a',success:true})).completed);
});
test('executor success is not canonical receipt; unknown process never starts a physical operation',async()=>{
  const f=fixture({stopTarget:async()=>({success:true}),readReceipt:async()=>null});f.api.begin(f.request);
  assert.equal((await f.api.step({mutationId:'op',tabId:'a'})).completed,undefined);
  const unknown=fixture({observeStop:async()=>({known:false})});unknown.api.begin(unknown.request);
  assert.equal((await unknown.api.step({mutationId:'op',tabId:'a'})).error,'selection_stop_process_unknown');
  assert.deepEqual(unknown.calls,[]);assert.equal(unknown.records.get('op').steps.a,undefined);
});
test('close uses its injected existing executor and receipt, and duplicate concurrent step shares one physical call',async()=>{
  const f=fixture();f.request.action='close';f.api.begin(f.request);
  const first=f.api.step({mutationId:'op',tabId:'a'}),second=f.api.step({mutationId:'op',tabId:'a'});
  assert.equal(first,second);assert.ok((await first).completed);assert.deepEqual(f.calls,[['close','a']]);
});
test('two controllers share one journal start CAS; future phases and asynchronous journal ports cannot authorize an effect',async()=>{
  let release;const hold=new Promise(resolve=>release=resolve),f=fixture({observeStop:()=>hold});f.api.begin(f.request);
  const other=createWorkflowSelectionActions(f.ports),a=f.api.step({mutationId:'op',tabId:'a'}),b=other.step({mutationId:'op',tabId:'a'});
  release({known:true,found:true});await Promise.all([a,b]);assert.equal(f.calls.length,1);
  f.records.get('op').steps.b={state:'future-unknown'};
  await assert.rejects(f.api.step({mutationId:'op',tabId:'b'}),/phase_unknown/);
  const asyncJournal=createWorkflowSelectionActions({...f.ports,journal:{...f.ports.journal,read:()=>Promise.resolve(null)}});
  assert.throws(()=>asyncJournal.begin({...f.request,mutationId:'next'}),/synchronous/);
});
