import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { applyAgentLaunchPreparationSnapshot as reduce } from './sessionStartingState.mjs';
const require = createRequire(import.meta.url);
const retry = require('../../main/codex-post-enter-retry');
const { createAgentLaunchPreparationRegistry } = require('../../main/agent-launch-preparation');
const mainSource = fs.readFileSync(new URL('../../main/main.js', import.meta.url), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const retryDeclaration = mainAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'retryCodexEnterAfterAuditTimeout');
assert.ok(retryDeclaration, 'execute the actual current Main retry, not a copied implementation');
// Actual registry/reducer/retry/canonical matcher. Receipt/copy/PTY ports remain
// controlled here; SQLite cancellation is covered by the companion Main suite.
const info = {tabId: 'NEW-test-tab', engine: 'codex'};
const snapshot = (token, attrs={}) => ({tabId: info.tabId, toolType: 'codex', token, since: 100, preparing: true, ...attrs});
function fixture() {
  const events=[]; let state=null;
  const registry=createAgentLaunchPreparationRegistry({now:()=>100,
    onChange(s) { events.push({...s}); state=reduce(state, info, s, 100); }});
  const identity={intentId:'launch:test-owner:1',tabId:info.tabId,toolType:'codex',senderId:31,
    launchFence:{terminalInstanceId:'term-new',stopRevision:0}};
  const intent=registry.beginIntent(identity).state;
  const begin = attempt => {
    const admitted=registry.beginIntentAttempt(intent.token,attempt,'same-immutable-payload',31);
    assert.equal(admitted.allowed,true);
    return registry.begin({tabId:info.tabId,toolType:'codex',launchIntent:intent,launchAttempt:attempt});
  };
  const refusal={success:false,accepted:false,launchWritten:false,error:'process_lookup_failed',reason:'process_lookup_unknown'};
  const finish = (prep,attempt,result=refusal) => {
    registry.finish(info.tabId,prep.token,{accepted:false,error:result.error});
    registry.settleIntentAttempt(intent.token,attempt,result);
  };
  return {registry,intent,identity,begin,finish,events,state:()=>state,refusal};
}
async function coupledRetry(change='none') {
  const writes=[];
  const term={write(bytes){writes.push(bytes);}};
  let record={attemptId:'A',state:'audit-pending'};
  if(change==='unknown-before') record.state='delivery-unknown';
  if(change==='cancel-before') record.deliveryControl={version:1,attemptId:'A',cancelledAt:100};
  let input=8, calls=0;
  const audit={sendOperationKey:'O',sendAttemptId:'A',handoffId:'H',submitWritten:true,
    expectedText:'Immutable text /new-test/one.png', enterInputRevision:8,
    enterRunSeq:3,enterLifecycleGeneration:'G'};
  const ctx={...retry,agentSendReceiptStore:{get(){return record;}},
    terminals:new Map([[info.tabId,term]]),terminalCommandState:new Map([[info.tabId,{runSeq:3}]]),
    codexTurnWatchers:new Map(),ptyLastQueuedWriteOperation:new Map(),
    getTerminalLifecycleGeneration:()=> 'G',getTerminalInputRevision:()=>input,
    async captureAgentInputAtWriteBoundary(tabId,mode,provider,opts,target) {
      calls++; assert.equal(target,term); assert.equal(mode,'copy'); assert.equal(provider,'codex');
      await Promise.resolve();
      if(change==='cancel-during') record={...record,deliveryControl:{version:1,attemptId:'A',cancelledAt:101}};
      if(change==='unknown-during') record={...record,state:'delivery-unknown'};
      if(change==='confirmed-during') record={...record,state:'confirmed'};
      if(change==='attempt-during') record={...record,attemptId:'A2'};
      if(change==='owner-during') ctx.terminals.set(info.tabId,{write(){throw Error('foreign write');}});
      input++;
      if(change==='manual-input') input++;
      return {success:change!=='capture-failed',terminalIdentityStable:true,
        terminalRunSeq:3,terminalLifecycleGeneration:'G',inputRevision:9,
        text:change==='empty-draft'?'':audit.expectedText,images:0};
    },
    recordComposerForensicPtyInput(){},codexSubmitDropTestFault:{consume:()=>false},
    markActivePtySubmit(){},console:{warn(){}},Date};
  vm.runInNewContext(retryDeclaration.getText(mainAst)+
    '\nthis.run = retryCodexEnterAfterAuditTimeout;',ctx);
  const result=await ctx.run({tabId:info.tabId,term,audit,
    timeoutResult:{error:'codex_user_message_audit_timeout'},logPrefix:'CONTROL'});
  return {result,writes,calls,record};
}
  for(const c of ['unknown-before','unknown-during','cancel-before','cancel-during']) {
    test('retry denies '+c,async()=>{const r=await coupledRetry(c);assert.equal(r.writes.length,0);});
  }
  test('ordinary pending exact draft retains existing narrow recovery',async()=>{
    const r=await coupledRetry();assert.equal(r.writes.length,1);assert.equal(r.calls,1);assert.equal(r.result.retried,true);
  });
  for(const c of ['confirmed-during','attempt-during','owner-during','manual-input','capture-failed','empty-draft']) {
    test('existing retry negative '+c,async()=>assert.equal((await coupledRetry(c)).writes.length,0));
  }
  test('same intent no-launch is not a terminal red error',()=>{
    const f=fixture(),p=f.begin(1);f.finish(p,1);
    assert.equal(f.registry.getIntent(f.intent.token).phase,'refused');
    assert.equal(f.events.some(e=>e.preparing===false&&e.accepted!==true&&!e.cleared),false);
    assert.equal(f.state().startupFailed,false);
    assert.equal(f.registry.beginIntentAttempt(f.intent.token,2,'same-immutable-payload',31).allowed,true);
  });
  test('only final fourth refusal is red; same intent and ordinary bounds preserved',()=>{
    const f=fixture();for(let n=1;n<=4;n++) f.finish(f.begin(n),n);
    assert.equal(f.events.filter(e=>e.preparing===false&&!e.accepted&&!e.cleared).length,1);
    assert.equal(f.state().startupFailed,true);
    assert.equal(f.registry.beginIntentAttempt(f.intent.token,5,'same-immutable-payload',31).allowed,false);
  });
  test('nonretryable real error stays visible without a timer',()=>{
    const f=fixture();f.finish(f.begin(1),1,{success:false,accepted:false,launchWritten:false,error:'terminal_has_unsent_input'});
    assert.equal(f.state().startupFailed,true);assert.equal(f.state().startupError,'terminal_has_unsent_input');
  });
  test('unknown launch outcome is terminal, never neutral retry',()=>{
    const f=fixture();f.finish(f.begin(1),1,{success:false,accepted:null,launchWritten:null,error:'write-unknown',launchOutcomeUnknown:true});
    assert.equal(f.state().startupFailed,true);
    assert.equal(f.registry.beginIntentAttempt(f.intent.token,2,'same-immutable-payload',31).allowed,false);
  });
  test('finish without another retry promotes the retained error',()=>{
    const f=fixture();f.finish(f.begin(1),1);f.registry.finishIntent({...f.identity,token:f.intent.token});
    assert.equal(f.state().startupFailed,true);
  });
  test('cancel during backoff clears exact preparation; no late resurrection',()=>{
    const f=fixture();const p=f.begin(1);f.finish(p,1);
    f.registry.cancelIntent({...f.identity,token:f.intent.token});
    assert.equal(f.state(),null);
    f.registry.finish(info.tabId,p.token,{accepted:false,error:'late'});assert.equal(f.state(),null);
    assert.equal(f.registry.beginIntentAttempt(f.intent.token,2,'same-immutable-payload',31).allowed,false);
  });
  test('cancel in flight clears without a red intermediate',()=>{
    const f=fixture();const p=f.begin(1);f.registry.cancelIntent({...f.identity,token:f.intent.token});f.finish(p,1);
    assert.equal(f.state(),null);
    assert.equal(f.events.some(e=>!e.preparing&&!e.accepted&&!e.cleared),false);
  });
  test('destroyed sender clears its pending presentation only',()=>{
    const f=fixture();f.begin(1);f.registry.clearIntentSender(31);assert.equal(f.state(),null);
  });
  test('superseding preparation is not cleared by old intent cancellation',()=>{
    const f=fixture();f.finish(f.begin(1),1);
    const p2=f.registry.begin({tabId:info.tabId,toolType:'codex'});
    f.registry.cancelIntent({...f.identity,token:f.intent.token});assert.equal(f.state().launchPreparationToken,p2.token);
  });
  test('success deletes pending Main preparation as before',()=>{
    const f=fixture(),p=f.begin(1);f.registry.markIntentWrite(f.intent.token,1);f.registry.markIntentWrite(f.intent.token,1,true);
    f.registry.finish(info.tabId,p.token,{accepted:true});
    f.registry.settleIntentAttempt(f.intent.token,1,{success:true,accepted:null,launchWritten:true,acceptancePending:true});
    assert.equal(f.registry.get(info.tabId),null);assert.equal(f.state().startupFailed,false);
  });
  test('unmanaged legacy refusal still displays immediately',()=>{
    const f=fixture(),p=f.registry.begin({tabId:info.tabId,toolType:'codex'});
    f.registry.finish(info.tabId,p.token,{error:'legacy-error'});assert.equal(f.state().startupFailed,true);
  });
  test('renderer older preparing cannot replace newer preparation',()=>{
    const current=reduce(null,info,snapshot(19));const stale=reduce(current,info,snapshot(18));
    assert.equal(stale.launchPreparationToken,19);
  });
  test('renderer newer final rejection is not discarded for a missing begin event',()=>{
    const current=reduce(null,info,snapshot(18));const next=reduce(current,info,snapshot(19,{preparing:false,error:'final'}));
    assert.equal(next.launchPreparationToken,19);assert.equal(next.startupFailed,true);
  });
  test('same token delayed preparing cannot undo settled rejection',()=>{
    const current=reduce(null,info,snapshot(19,{preparing:false,error:'final'}));
    assert.equal(reduce(current,info,snapshot(19)).startupFailed,true);
  });
  test('newer clear retires an older preparation even when begin was missed',()=>{
    const current=reduce(null,info,snapshot(18));
    assert.equal(reduce(current,info,snapshot(19,{preparing:false,cleared:true})),null);
  });
  test('different tab and old exact clear remain inert',()=>{
    const current=reduce(null,info,snapshot(19));
    assert.equal(reduce(current,info,{...snapshot(20),tabId:'foreign'}),current);
    assert.equal(reduce(current,info,snapshot(18,{cleared:true})),current);
  });

