'use strict';
// Executes exact read Main declarations, the complete actual compact helper,
// and the exact existing pending-settlement branch. Not a native acceptance.
// Controlled leaves: physical state/proof snapshots, registry storage/events,
// first post-paste probe, fd/PTY, clock, stash capture/restore endpoints.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const main=fs.readFileSync(require.resolve('./main'),'utf8');
const picker=fs.readFileSync(require.resolve('./codex-model-picker'),'utf8');
function declarations(text,names){
  const ast=ts.createSourceFile('source.js',text,ts.ScriptTarget.Latest,true);
  return names.map(name=>{const n=ast.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name?.text===name);
    assert.ok(n,name);return n.getText(ast);}).join('\n');
}
const source=declarations(main,['readCodexCompactSubmitOwnership','observeCodexCompactPostEnter',
  'submitCodexCompactSlashCommandWithProof','sendCodexSlashCommand','inspectCodexOwnedSlashDraft',
  'rollbackCodexOwnedSlashDraft','sendCodexLiveSlashCommand'])+'\n'+declarations(picker,['decideCodexOwnedSlashDraft']);
const helpers=require('./codex-compact-slash-submit');
const start=main.indexOf('        if (compactPendingOperation\n          && result?.success !== true');
const end=main.indexOf('        if (compactPendingOperation && result &&',start);
assert.ok(start>=0&&end>start,'actual post-result settlement');
const settlement=main.slice(start,end);
const {createCodexSlashInputDiagnostic}=require('./codex-slash-input-diagnostics');
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

function fixture({throwAt=0,autocomplete=false,confirm=true,foreign=false,deny=null,changeAfterPaste=null}={}) {
  const writes=[],timers=new Map(),listeners=new Set(),logs=[],publications=[],incidents=[];
  let id=0, seq=10, text='', entered=0, current=true, active=null;
  let pending={operationId:'codex:api:H'},receipt=null,restoreCalls=0;
  const mirror={generation:'M',synchronizedFrameWaiters:new Set()};
  const identity={tabId:'T',terminalRunSeq:2,terminalLifecycleGeneration:'G:2',inputRevision:4};
  const captured={text:'ORIGINAL AUTHOR',capturedText:'ORIGINAL AUTHOR',images:1,
    imagePaths:[{assetId:'A',path:'/fixture/A.png'}],captureOperationId:'capture-A'};
  const frame=()=>({success:true,authoritativeFrameCommitted:true,synchronizedOutputOpen:false,
    writeSeq:seq,flushedSeq:seq,committedFrameGeneration:seq-9});
  const draft=()=>({success:true,hasDraft:!!text,preview:text,source:'headless-main:cursor:3'});
  const start=()=>{if(!pending||!current)return;active={...pending,tabId:'T',provider:'codex',active:true,
    causalStartConfirmed:true,causalStartProof:'controlled-causal-start'};pending=null;
    for(const l of [...listeners])l(active);};
  const term={write(data){
    writes.push(data);
    if(data.includes('\x1b[200~')){text=data.match(/\x1b\[200~(.*?)\x1b\[201~/s)[1];seq++;return;}
    if(data==='\x03'||data==='\x01\x0b'){text='';seq++;return;}
    if(data==='\r'){
      entered++;
      if(entered===throwAt)throw new Error('CONTROLLED_WRITE_THROW_AFTER_CALL');
      // onData happens later, not synchronously inside write in a real PTY.
      queueMicrotask(()=>{
        if(autocomplete&&entered===1){seq++;for(const l of [...mirror.synchronizedFrameWaiters])l();}
        else if(confirm)start();
      });
    }
  }};
  const ctx=vm.createContext({...helpers,createCodexSlashInputDiagnostic,console:{log(...a){logs.push(a.join(' '));},warn(...a){logs.push(a.join(' '));}},
    agentSendReceiptStore: null,
    historySendReturnControl: () => ({ isReturned: () => false }),
    writeHistorySendPayload: (term, data) => term.write(data), // no registered History return in this control
    writeHistorySendEnter: (term, data) => term.write(data), // same controlled throw endpoint, timing has its own tests
    setTimeout(fn,ms){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);},
    getHeadlessTerminalMirror:()=>mirror,getHeadlessVisibleBufferSnapshot:frame,getHeadlessCodexDraftState:draft,
    flushHeadlessTerminalMirror:async()=>({success:true}),
    validateCodexOwnedSlashDraftIdentity:()=>({valid:current,reason:current?'same-owner':changeAfterPaste||'owner-changed'}),
    sameCodexManualCompactOwner:()=>current,readCodexManualInputOwner:()=>identity,
    compactOperations:{getActive:()=>active,getPending:()=>pending},
    subscribeCompactOperationChanges(l){listeners.add(l);return()=>listeners.delete(l);},
    recordComposerForensicPtyInput(){},
    readCodexPickerWriteRefusal(guard,phase){const r=guard?.(phase);return r?.allowed===false?{success:false,error:r.reason}:null;},
    codexSettingsMutationQueue:{getUnsubmittedInput:()=>receipt},
    retainCodexOwnedModelInput(_term,identity,command){
      assert.equal(receipt,null);const diagnostic=createCodexSlashInputDiagnostic({tabId:'T',command,log:r=>publications.push(r)});
      receipt={identity,command,diagnostic,requestRecovery(){receipt.recoveryPending=true;}};return receipt;
    },
    releaseCodexOwnedModelInput(_term,r){assert.equal(receipt,r);receipt=null;},
    captureCodexOwnedSlashDraftIdentity:()=>identity,
    validateCodexOwnedModelInputIdentity:()=>({valid:current}),
    async waitForCodexOwnedModelPaste(){if(changeAfterPaste)current=false;if(foreign)text='REAL FOREIGN';
      return {timedOut:foreign,ownerChanged:!current};},
    settleCodexOwnedModelInput:async()=>({success:false,serviceInputPending:true}),
    codexLateMcpProofPending:new Map(),codexTurnWatchers:new Map(),
    captureCodexFrame:async()=>({timedOut:false,clean:'Service tier set to priority',raw:''}),
    parseCodexServiceTierFeedback:()=>({serviceTier:'priority'}),
    PASTE_START:'\x1b[200~',PASTE_END:'\x1b[201~',CODEX_SYNC_MARKER:'\x1b[?2026l',
    async stashCodexDraftForPicker(){return {success:true,draftSnapshot:captured};},
    async restoreCodexDraftAfterPicker(){restoreCalls++;writes.push('CONTROLLED_NATIVE_RESTORE');return {success:true};},
    codexNativeDraftTransfer:(_tab,snapshot)=>snapshot,
    cancelCodexManualCompactPending(){pending=null;},
    reportTerminalIncident(key, payload){ incidents.push({key,payload,writesAtDetection:writes.length}); return Promise.resolve({}); },
  });
  vm.runInContext(source,ctx);
  const request=(command='/compact',withDraft=false)=>ctx.sendCodexLiveSlashCommand(term,{tabId:'T',command,
    hasDraft:withDraft,compactOperationId:command==='/compact'?'codex:api:H':null,
    readDraftState:async()=>draft(),writeGuard:phase=>({allowed:phase!==deny,reason:'guard-refused'})});
  return {ctx,term,writes,mirror,listeners,timers,logs,incidents,request,
    get pending(){return pending;},get receipt(){return receipt;},get restoreCalls(){return restoreCalls;},captured,
    async expire(){await tick();for(const [id,fn]of [...timers]){timers.delete(id);fn();}await tick();},
    settle(result){Object.assign(ctx,{result,compactPendingOperation:{operationId:'codex:api:H'},tabId:'T'});vm.runInContext(settlement,ctx);},
    lateStart:start,
    change(){current=false;pending=null;seq++;for(const l of [...mirror.synchronizedFrameWaiters])l();},
  };
}

test('first Enter throw must not become a definite not-submitted receipt',async()=>{
  const h=fixture({throwAt:1});const r=await h.request();
  assert.equal(r.submitted,null);assert.equal(r.deliveryUnknown,true);assert.equal(r.deliveryUnconfirmed,true);
  assert.equal(r.enterWritten,null);assert.equal(r.compactEnterCount,0);assert.equal(r.enterWriteUnknown,true);
});

test('first Enter throw must not re-authorize Ctrl+C rollback or replay',async()=>{
  const h=fixture({throwAt:1});await h.request();
  assert.deepEqual(h.writes,['\x01\x0b\x1b[200~/compact\x1b[201~','\r']);
  assert.equal(h.receipt,null);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});

test('existing caller must retain exact pending compact after unknown Enter for a later causal start',async()=>{
  const h=fixture({throwAt:1});const r=await h.request();h.settle(r);
  assert.equal(h.pending?.operationId,'codex:api:H');h.lateStart();
  assert.equal(h.ctx.compactOperations.getActive()?.causalStartConfirmed,true);
  assert.equal(h.writes.filter(x=>x==='\r').length,1);
});

test('first Enter throw with captured author+attachment must not perform native draft restore',async()=>{
  const h=fixture({throwAt:1});const r=await h.request('/compact',true);
  assert.equal(h.restoreCalls,0);assert.equal(r.draftTransfer,h.captured);
  assert.equal(r.draftTransfer.imagePaths[0].assetId,'A');assert.equal(r.deliveryUnknown,true);
  assert.equal(r.applied,null);
});

test('second autocomplete Enter throw retains unknown delivery and never restores author over it',async()=>{
  const h=fixture({throwAt:2,autocomplete:true});const r=await h.request('/compact',true);h.settle(r);
  assert.equal(h.writes.filter(x=>x==='\r').length,2);assert.equal(r.compactEnterCount,1);
  assert.equal(r.submitted,true);assert.equal(r.enterWritten,true);assert.equal(r.enterWriteUnknown,true);
  assert.equal(h.restoreCalls,0);assert.equal(h.pending?.operationId,'codex:api:H');
});

test('normal exact causal start remains successful, one Enter and no retained insertion',async()=>{
  const h=fixture();const r=await h.request();h.settle(r);
  assert.equal(r.success,true);assert.equal(r.compactStartConfirmed,true);assert.equal(r.compactEnterCount,1);
  assert.equal(h.writes.filter(x=>x==='\r').length,1);assert.equal(h.receipt,null);
  assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});

test('exact newer autocomplete frame retains the existing authorized second-Enter route',async()=>{
  const h=fixture({autocomplete:true});const r=await h.request();
  assert.equal(r.success,true);assert.equal(r.compactEnterCount,2);
  assert.equal(h.writes.filter(x=>x==='\r').length,2);assert.equal(r.enterWriteUnknown,undefined);
});

test('returned Enter without any new frame or causal start is unknown, not permission for a second Enter',async()=>{
  const h=fixture({confirm:false});const p=h.request();await h.expire();const r=await p;h.settle(r);
  assert.equal(r.success,false);assert.equal(r.submitted,true);assert.equal(r.deliveryUnconfirmed,true);
  assert.equal(h.writes.filter(x=>x==='\r').length,1);assert.ok(h.pending);h.lateStart();
  assert.equal(h.writes.filter(x=>x==='\r').length,1);
});

test('guard refusal before Enter remains definite no-Enter and cancels the unused pending compact',async()=>{
  const h=fixture({deny:'slash-command-enter-final'});const r=await h.request();h.settle(r);
  assert.equal(r.submitted,false);assert.equal(r.enterWritten,false);assert.equal(r.enterWriteUnknown,undefined);
  assert.equal(h.writes.filter(x=>x==='\r').length,0);assert.equal(h.pending,null);
});

for(const reason of ['Stop','input','mirror','launch','terminal','run'])test('controlled owner revocation before first Enter: '+reason,async()=>{
  const h=fixture({changeAfterPaste:reason});const r=await h.request();h.settle(r);
  assert.equal(h.writes.filter(x=>x==='\r').length,0);assert.equal(r.submitted,false);
  assert.equal(h.pending,null);
});

test('foreign post-paste draft never receives Enter or destructive fallback clear',async()=>{
  const h=fixture({foreign:true});const r=await h.request();
  assert.equal(r.submitted,false);assert.equal(h.writes.length,1);assert.ok(h.receipt);
});

test('short-control timeout freezes raw evidence before cleanup without changing its no-Enter outcome',async()=>{
  const h=fixture({foreign:true});const r=await h.request();
  assert.equal(h.incidents.length,1);assert.equal(h.incidents[0].writesAtDetection,1);
  assert.equal(h.incidents[0].payload.incidentReason,'slash-input-frame-timeout');
  assert.equal(h.incidents[0].payload.silent,true);
  assert.equal(h.incidents[0].payload.context.compactOperationId,'codex:api:H');
  assert.equal(r.submitted,false);assert.deepEqual(h.writes,['\x01\x0b\x1b[200~/compact\x1b[201~']);
});

for(const command of ['/model','/fast'])test('unchanged normal neighboring control: '+command,async()=>{
  const h=fixture();const r=await h.request(command);
  assert.equal(r.success,true);assert.equal(h.writes.filter(x=>x==='\r').length,1);assert.equal(h.receipt,null);
});

test('Stop after unknown revokes later synthetic causal proof without another input',async()=>{
  const h=fixture({throwAt:1});const r=await h.request();h.settle(r);h.change();h.lateStart();
  assert.equal(h.ctx.compactOperations.getActive(),null);assert.equal(h.pending,null);
  assert.equal(h.writes.filter(x=>x==='\r').length,1);
});
