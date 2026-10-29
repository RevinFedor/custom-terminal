'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { capacityRecoveryDeferredReceipt } = require('../shared/run-after-capacity-recovery.cjs');
const { isAutomaticPromptQueueRequest } = require('../shared/prompt-queue-send-intent.cjs');
const registry = require('./agent-send-receipt-registry');

function functions(source, names) {
  const tree = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true);
  return names.map(name => { const found = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(found, name); return found.getText(tree); }).join('\n');
}
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const webCode = functions(web, ['runAfterCapacityBlocksNewSend','deferRunAfterCapacityHead','readRunAfterCapacityRecoveryRelease','admitQueuedAgentSend']);
const mainCode = functions(main, ['codexOutcomeTimestampMs','applyCodexWatcherAbnormalOutcome','applyCodexWatcherOutcome','codexTurnStateSnapshot','emitCodexBusy']);
const webTree=ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true);
let joinCode;
(function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(webTree)==='joinAutomaticAgentPrompt')joinCode=node.initializer.getText(webTree);ts.forEachChild(node,visit)})(webTree);
assert.ok(joinCode);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const db = new NodeSqlite(), receipts = createAgentSendReceiptStore(db), writes = [];
  let ready = false, held = true, inspection = { known: true, toolType: 'codex', sessionId: 'S', busy: false,
    transitioning: false, revision: 'capacity-A', runtime: { lifecycleGeneration: 'G', writerConfirmed: true, liveLifecycle: true },
    turn: { turnId: 'A', outcome: 'model_capacity', outcomeTs: 100 } };
  const c = vm.createContext({ captureTabInspection: () => inspection });
  vm.runInContext(webCode, c);
  const queue = new AgentSendQueue({ store: receipts, ready: () => ready,
    captureRecoveryOwner: () => inspection,
    readRecoveryRelease: proof => c.readRunAfterCapacityRecoveryRelease(proof),
    admit: request => request.source === 'codex-capacity-retry' || !held,
    execute: async request => {
      writes.push(request.handoffId);
      const old = receipts.get(request.sendOperationKey), attempt = receipts.beginAttempt({
        operationKey: old.operationKey, tabId: old.tabId, handoffId: old.handoffId, provider: old.provider,
        sessionId: old.sessionId, requestFingerprint: old.requestFingerprint, promptHash: old.promptHash, promptLength: old.promptLength, surface: old.surface,
      });
      assert.ok(attempt.ok);const id = attempt.attemptId;
      receipts.markAttemptState(old.operationKey, id, 'enter-armed');
      receipts.settleAttempt(old.operationKey, id, { success: true, submitted: true, status: 'audit-pending', auditPending: true });
      receipts.promoteFromAudit({ success: true, operationKey: old.operationKey, attemptId: id, provider: 'codex',sessionId:'S',
        promptHash:old.promptHash, expectedHash:old.promptHash,actualHash:old.promptHash,entryUuid:'user-'+request.handoffId,
        sourceIdentity:'source-'+request.handoffId,auditTimestamp:'2026-10-26T07:05:25.000Z' });
      return {success:true,submitted:true};
    } });
  c.agentSendQueue = queue;
  Object.assign(c,{...registry,require,path,srcMainDir:__dirname,agentSendReceiptStore:receipts,isAutomaticPromptQueueRequest,fingerprintAgentSendRequest,
    getBuildContinueOperations:()=>({capturing:()=>false,staleLoopAdmission:()=>null}),
    buildInstallAutomationBlocked:()=>false,historyMutationInput:null,
    isPromptLoopAutomationSource:require('./prompt-queue-source').isPromptLoopAutomationSource,
    AGENT_SEND_RECEIPT_STATES:registry.RECEIPT_STATES});
  vm.runInContext(functions(web,['durableAgentSendReplay','durableRecordHasProviderQueueAcceptance','readBuildContinueDeferredReceipt','readMessageLoopDeferredReceipt'])
    +'\nglobalThis.join='+joinCode+';',c);
  function enqueue(handoffId, extra = {}) {
    const request={tabId:'T',provider:'codex',prompt:'same authored card',source:'prompt-queue',handoffId,
      sendOperationKey:'history:T:'+handoffId,sendSurface:'desktop-history',
      expectedTarget:{toolType:'codex',sessionId:'S',lifecycleGeneration:'G'},
      promptQueueIntent:{version:1,kind:'queue',itemId:'card',baseHandoffId:handoffId,armedAt:10,triggerTabId:'T',conditionKey:'',triggerKey:'null'},...extra};
    const plain=JSON.parse(JSON.stringify(request));
    const identity={operationKey:request.sendOperationKey,tabId:'T',provider:'codex',sessionId:'S',handoffId,
      surface:request.sendSurface,requestFingerprint:fingerprintAgentSendRequest(plain),promptHash:promptAuditFingerprint(request.prompt),promptLength:request.prompt.length};
    return {request,identity,...queue.enqueue({identity,request:plain})};
  }
  function capacity(patch={}) {
    c.deferRunAfterCapacityHead('T',{type:'done',reason:'model_capacity',busy:false,sessionId:'S',lifecycleGeneration:'G',turnId:'A',...patch});
  }
  t.after(async()=>{queue.dispose();await tick();db.close()});
  return {db,receipts,queue,writes,enqueue,capacity,c,
    inspection:()=>inspection,patch:value=>inspection={...inspection,...value},
    ready:()=>{ready=true;queue.resume()},release:()=>held=false,
  };
}

test('actual FIFO: same unattempted H/O parks without cancelling receipt, Continue passes, exact natural re-admits original card once',async t=>{
  const h=fixture(t), original=h.enqueue('CARD'), key=original.request.sendOperationKey;
  const before=h.receipts.get(key), frozen=h.queue.item(key).request_json, rowId=h.queue.item(key).id;
  if(process.env.RUN_AFTER_CAPACITY_NO_DEFER_REPRO!=='1') h.capacity();
  h.enqueue('CONTINUE',{source:'codex-capacity-retry',prompt:'continue',sendSurface:'project-api',promptQueueIntent:null});
  h.ready();await tick();await tick();
  assert.deepEqual(h.writes,['CONTINUE'],'a parked automatic HEAD must not deadlock the existing Continue');
  assert.equal(h.queue.item(key).state,'recovery-deferred');
  const after=h.receipts.get(key);
  assert.equal(after.state,before.state);assert.equal(after.attemptId,null);assert.equal(after.deliveryControl?.cancelledAt,undefined);
  assert.equal(after.requestFingerprint,before.requestFingerprint);assert.equal(h.queue.item(key).request_json,frozen);
  assert.equal(h.queue.receipt(key).deferred,true);
  const early=h.enqueue('CARD');assert.equal(early.item.state,'recovery-deferred');assert.equal(h.writes.length,1);
  h.patch({busy:false,revision:'natural-B',turn:{turnId:'B',outcome:'task_complete',outcomeTs:120}});
  h.queue.observeRecoveryRelease('T');h.release();
  const resumed=h.enqueue('CARD');assert.equal(resumed.item.state,'waiting');await h.queue.result(key);
  assert.deepEqual(h.writes,['CONTINUE','CARD']);assert.equal(h.queue.item(key).id,rowId);
  assert.equal(h.queue.item(key).request_json,frozen);assert.equal(h.receipts.get(key).state,'confirmed');
  h.enqueue('CARD');await tick();assert.equal(h.writes.length,2);
});

for(const type of ['attempted','enter-armed','unknown','manual','wrong-session','wrong-generation','surface','stale-owner'])
test('capacity FIFO never skips '+type,async t=>{
  const h=fixture(t), added=h.enqueue('HEAD', type==='manual'?{source:'history-panel',promptQueueIntent:null}:{}), key=added.request.sendOperationKey;
  if(['attempted','enter-armed','unknown'].includes(type)) {
    const a=h.receipts.beginAttempt(added.identity);assert.ok(a.ok);
    if(type==='enter-armed')h.receipts.markAttemptState(key,a.attemptId,'enter-armed');
    if(type==='unknown')h.receipts.settleAttempt(key,a.attemptId,{success:null,submitted:null,deliveryUnknown:true});
  }
  if(type==='wrong-session')h.patch({sessionId:'OTHER'});
  if(type==='wrong-generation')h.patch({runtime:{...h.inspection().runtime,lifecycleGeneration:'OTHER'}});
  if(type==='stale-owner')h.patch({known:false});
  h.capacity(type==='surface'?{capacitySurfaceOnly:true}:{});
  assert.equal(h.queue.item(key).state,'waiting');assert.equal(h.queue.receipt(key)?.deferred,undefined);
});

for(const type of ['same-turn','no-final','unknown','new-owner','new-generation','no-timestamp','surface'])
test('same-ID recovery admission rejects '+type,async t=>{
  const h=fixture(t);h.enqueue('CARD');h.capacity();
  const natural={turnId:'B',outcome:'task_complete',outcomeTs:120};
  h.patch({revision:type,turn:natural});
  if(type==='same-turn')natural.turnId='A';
  if(type==='no-final')natural.outcome='codex-no-final-result';
  if(type==='unknown')h.patch({known:false});
  if(type==='new-owner')h.patch({sessionId:'NEW'});
  if(type==='new-generation')h.patch({runtime:{...h.inspection().runtime,lifecycleGeneration:'NEW'}});
  if(type==='no-timestamp')natural.outcomeTs=null;
  if(type==='surface')natural.capacitySurfaceOnly=true;
  assert.equal(h.enqueue('CARD').item.state,'recovery-deferred');assert.equal(h.writes.length,0);
});

test('Stop cancels parked intent durably; later natural proof cannot undo cancellation or rearm it',async t=>{
  const h=fixture(t);const old=h.enqueue('CARD');h.capacity();
  assert.equal(h.queue.cancelWaiting('T',null,{reason:'manual-stop'}).cancelled,true);
  h.patch({revision:'natural-B',turn:{turnId:'B',outcome:'task_complete',outcomeTs:120}});
  const after=h.enqueue('CARD');assert.equal(after.item.state,'cancelled');
  assert.ok(h.receipts.get(old.request.sendOperationKey).deliveryControl.cancelledAt);assert.equal(h.writes.length,0);
});

test('natural proof alone never auto-rearms a parked request; a current same-ID Root demand is required',async t=>{
  const h=fixture(t);h.enqueue('CARD');h.capacity();h.ready();
  h.patch({revision:'natural-B',turn:{turnId:'B',outcome:'task_complete',outcomeTs:120}});h.release();
  h.queue.observeRecoveryRelease('T');h.queue.resume();await tick();await tick();
  assert.deepEqual(h.writes,[]);assert.equal(h.queue.item('history:T:CARD').state,'recovery-deferred');
});

test('warm session-only expectations use their immutable admission-time Main physical pin, not a later owner guess',async t=>{
  const h=fixture(t), old=h.enqueue('WARM',{expectedTarget:{toolType:'codex',sessionId:'S'}});
  assert.ok(h.queue.item(old.request.sendOperationKey).recovery_owner_json);
  h.capacity();assert.equal(h.queue.item(old.request.sendOperationKey).state,'recovery-deferred');
});

test('the real joinAutomatic caller re-admits the frozen queue H/O only after Main natural proof',async t=>{
  const h=fixture(t), old=h.enqueue('CARD');h.capacity();
  const input={tabId:'T',handoffId:'CARD',promptQueueIntent:old.request.promptQueueIntent};
  const before=await h.c.join(input);assert.equal(before.found,true);assert.equal(before.receipt.deferred,true);
  assert.equal(h.queue.item('history:T:CARD').state,'recovery-deferred');
  h.patch({revision:'natural-B',turn:{turnId:'B',outcome:'task_complete',outcomeTs:100}});h.release();h.ready();
  const resumed=await h.c.join(input);assert.equal(resumed.receipt.submitted,true);assert.deepEqual(h.writes,['CARD']);
  assert.equal(h.queue.item('history:T:CARD').request_json,JSON.stringify(old.request));
});

test('legacy missing physical pin remains unknown; a fresh failure cannot invent its original generation',async t=>{
  const h=fixture(t);h.queue.captureRecoveryOwner=null;
  const old=h.enqueue('LEGACY',{expectedTarget:{toolType:'codex',sessionId:'S'}});h.capacity();
  assert.equal(h.queue.item(old.request.sendOperationKey).state,'waiting');assert.equal(h.receipts.get(old.request.sendOperationKey).attemptId,null);
});

test('the original row and recovery-order proof survive a private queue-owner reopen, without replay authority',async t=>{
  const h=fixture(t), old=h.enqueue('CARD');h.capacity();h.queue.dispose();
  const reopened=new AgentSendQueue({store:h.receipts,readRecoveryRelease:p=>h.c.readRunAfterCapacityRecoveryRelease(p),execute:()=>assert.fail('no automatic execution')});
  t.after(()=>reopened.dispose());
  assert.equal(reopened.item(old.request.sendOperationKey).state,'recovery-deferred');
  assert.equal(reopened.receipt(old.request.sendOperationKey).deferred,true);
  assert.equal(reopened.enqueue({identity:old.identity,request:old.request}).item.state,'recovery-deferred');
  assert.equal(h.receipts.get(old.request.sendOperationKey).attemptId,null);
});

test('capacity parking during an awaited positive admission cannot resurrect the old head',async t=>{
  const h=fixture(t);let resolve,entered;const began=new Promise(r=>entered=r);
  h.queue.admit=()=>new Promise(r=>{resolve=r;entered()});
  h.enqueue('CARD');h.ready();await began;h.capacity();resolve(true);await tick();await tick();
  assert.deepEqual(h.writes,[]);assert.equal(h.queue.item('history:T:CARD').state,'recovery-deferred');
  assert.equal(h.receipts.get('history:T:CARD').attemptId,null);
});

test('SQLite refusal leaves receipt/head untouched; real admission retries the same deferral on its normal wake',async t=>{
  const h=fixture(t), old=h.enqueue('CARD'), before=h.receipts.get('history:T:CARD');
  const prepare=h.db.prepare.bind(h.db);let fail=true;
  h.db.prepare=sql=>{if(fail&&sql.includes("SET state='recovery-deferred'"))throw Object.assign(Error('controlled SQLite writer'),{code:'SQLITE_BUSY'});return prepare(sql)};
  assert.doesNotThrow(()=>h.capacity());assert.equal(h.queue.item('history:T:CARD').state,'waiting');
  assert.equal(h.receipts.get('history:T:CARD').state,before.state);assert.equal(h.receipts.get('history:T:CARD').attemptId,null);
  fail=false;h.queue.admit=request=>h.c.admitQueuedAgentSend(request);h.ready();await tick();await tick();
  assert.equal(h.queue.item('history:T:CARD').state,'recovery-deferred');assert.equal(h.writes.length,0);
  assert.equal(h.queue.item('history:T:CARD').request_json,JSON.stringify(old.request));
});

test('manual FIFO followers retain their normal order; capacity deferral cannot move them',async t=>{
  const h=fixture(t);h.enqueue('CARD');h.enqueue('MANUAL',{source:'history-panel',promptQueueIntent:null});h.capacity();
  h.enqueue('CONTINUE',{source:'codex-capacity-retry',promptQueueIntent:null});h.release();h.ready();
  await h.queue.result('history:T:CONTINUE');
  assert.deepEqual(h.writes,['MANUAL','CONTINUE']);
  assert.equal(h.queue.item('history:T:CARD').state,'recovery-deferred');
});

test('actual Main IPC and restored snapshots distinguish early surface from typed capacity',()=>{
  const state={tabId:'T',sessionId:'S',processGeneration:'G',lifecycleGeneration:'G',currentTurnId:'A',busy:true};
  const events=[], c=vm.createContext({
    codexTurnWatchers:new Map([['T',state]]),workingDirectoryOperations:null,
    settleCodexProviderActivityFromWatcherOutcome(){},terminalHistoryPreviewController:{finish(){}},
    getTerminalLifecycleGeneration:()=> 'G',codexRuntimePolicies:null,
    taskCompletionIntents:{beginTurn:()=>({turnId:'A'}),finishTurn:()=>({turn:{turnId:'A'}})},
    taskCompletionOutcomeMeta:()=>({}),replayDeferredCodexPromptAuditExecutionContext(){},discardDeferredCodexPromptAuditExecutionContexts(){},
    clearCodexMcpStartupWatchdog(){},recordActivity(){},shouldCreateHistoryResponseTiming:()=>false,
    getCodexPublicRuntimeProjection:()=>({inputReady:true,sessionStatus:'active'}),emitAgentReadinessChanged(){},
    getCodexRuntimeSessionId:()=> 'S',getCombinedTabBackgroundWorkCount:()=>0,getCodexPublicWriterFields:()=>({}),
    _webBroadcast(){},console:{log(){}},mainWindow:{isDestroyed:()=>false,webContents:{send:(_channel,value)=>events.push(value)}},
  });vm.runInContext(mainCode,c);
  const outcome={busy:false,reason:'model_capacity',hasFinalResult:false};
  state.busy=false;c.emitCodexBusy('T',false,'model_capacity',{capacitySurfaceOnly:true,outcome,timestamp:100,turnId:'A'});
  assert.equal(events[0].capacitySurfaceOnly,true);assert.equal(c.codexTurnStateSnapshot(state).lastOutcomeCapacitySurfaceOnly,true);
  c.emitCodexBusy('T',false,'model_capacity',{outcome,timestamp:101,turnId:'A'});
  const snapshot=c.codexTurnStateSnapshot(state);
  assert.equal(snapshot.lastOutcomeCapacitySurfaceOnly,false);assert.equal(snapshot.lastAbnormalOutcomeCapacitySurfaceOnly,false);
  assert.equal(snapshot.lastAbnormalOutcomeReason,'model_capacity');assert.equal(snapshot.lifecycleGeneration,'G');
});
