'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const main = fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
const panel = fs.readFileSync(path.join(__dirname,'../renderer/components/Workspace/HistoryPanel.tsx'),'utf8');
const handoffSource = fs.readFileSync(path.join(__dirname,'../renderer/utils/historyPromptHandoffs.ts'),'utf8');
let presentation, localCommand, planHistoryPromptPresentationDismissal;
test.before(async()=>{
  presentation=await import('../renderer/utils/historyPromptPresentation.mjs');
  localCommand=await import('../renderer/utils/agentLocalCommand.mjs');
  ({planHistoryPromptPresentationDismissal}=await import('../renderer/utils/historyPromptPresentationDismissal.mjs'));
});
const part=(source,first,next)=>{
  const start=source.indexOf(first),end=source.indexOf(next,start+first.length);
  assert.ok(start>=0&&end>start,first);return source.slice(start,end);
};
const compile=source=>ts.transpileModule(source.replace(/\bexport /g,''),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const quiet={log(){},warn(){},error(){}};
function handoffs() {
  const exports={};
  vm.runInNewContext(ts.transpileModule(handoffSource,{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText,{exports,console:quiet,setTimeout,clearTimeout,require:id=>{
    if(id==='./historyPromptPresentation.mjs')return presentation;
    if(id==='./agentLocalCommand.mjs')return localCommand;
    return require(id);
  }});
  return exports;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function harness(t,{provider='codex',surface='desktop-history',hydrated=false,partialIdentity=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dismiss-no-attempt-'));
  const filename=path.join(root,'private.sqlite');
  let db=new Database(filename),store=createAgentSendReceiptStore(db);
  const sends=[],calls=[],notices=[],persisted=[];
  const queue=new AgentSendQueue({store,ready:()=>false,execute:async request=>{sends.push(request);throw Error('physical send forbidden')}});
  const handoffId='orchestration-complete:study-queue-algorithm-astra6-20261004-v1';
  const request={tabId:'T',provider,handoffId,sendOperationKey:'history:T:'+handoffId,
    prompt:'private synthetic completion',source:'history-panel',
    authoringSnapshot:{editorText:'private synthetic completion',imagePaths:[{id:1,path:'/fixture/one.png',assetId:'asset-a'}]}};
  const identity={operationKey:request.sendOperationKey,surface,tabId:'T',handoffId,provider,sessionId:'private-SID',
    requestFingerprint:fingerprintAgentSendRequest(request),promptHash:fingerprintAgentSendRequest(request.prompt),promptLength:request.prompt.length};
  const admitted=queue.enqueue({identity,request});assert.equal(admitted.ok,true);
  store.settleQueuedNoWrite(identity.operationKey,{code:'agent_send_handoff_conflict',
    error:'The same handoffId was already used for a different send request.'});
  assert.equal(store.get(identity.operationKey).attemptId,null);
  assert.equal(queue.item(identity.operationKey).state,'failed');
  const before=store.get(identity.operationKey);
  const module=handoffs();
  if(hydrated) {
    assert.equal(module.hydrateHistoryPromptHandoffFromDurableReceipt(queue.projectRecord(before)).hydrated,true);
  } else module.beginHistoryPromptHandoff({tabId:'T',handoffId,toolType:provider,text:request.prompt,
    requiresAuditIdentity:true,source:'history-panel',
    ...(partialIdentity?{sendOperationKey:identity.operationKey}:{}),
    initialReceipt:{queueStatus:'failed',reason:'send-refused-before-submit'}});
  let rows=[{uuid:'local-prompt-'+handoffId,role:'queued',handoffId,content:request.prompt,
    queueStatus:'failed',statusReason:'send-refused-before-submit',requiresAuditIdentity:true},
    {uuid:'canonical-equal-text',role:'user',content:request.prompt}];
  const handlers=new Map();
  const web={releaseQueuedSendPresentation:key=>queue.releasePresentation(key),
    cancelQueuedAgentSends:(tab,id,options)=>queue.cancelWaiting(tab,id,options),
    dismissUnwrittenQueuedSend:(tab,id)=>queue.dismissUnwritten(tab,id)};
  const context=vm.createContext({...module,tabId:'T',toolType:provider,console:quiet,path,srcMainDir:__dirname,
    require:id=>{assert.equal(id,path.join(__dirname,'web-server'));return web},
    useCallback:fn=>fn,LOCAL_PROMPT_PREFIX:'local-prompt-',historySnapshotOwner:'owner',
    presentationEntriesRef:{current:rows},promptHandoffMetaRef:{current:new Map()},suppressedPromptsRef:{current:new Map()},
    planHistoryPromptPresentationDismissal,historyDiag(){},
    setEntries:update=>{rows=update(rows);context.presentationEntriesRef.current=rows},
    persistVolatileOverlay:(_owner,value)=>persisted.push(value),
    waitForHistoryPromptHandoffSendIdentity:async()=>{calls.push('wait-for-attempt');return null},
    showHistoryIncidentToast:(_tab,message)=>notices.push(message),
    agentSendReceiptStartupReady:Promise.resolve(),agentSendReceiptStore:store,DESKTOP_HISTORY_SEND_SURFACE:'desktop-history',
    ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},
    ipcRenderer:{invoke:async(name,payload)=>{calls.push(name);assert.ok(handlers.has(name),name);return handlers.get(name)({},payload)}},
  });
  vm.runInContext(part(main,"ipcMain.handle('agent:dismiss-send-receipt-presentation'","ipcMain.handle('agent:record-history-context'"),context);
  vm.runInContext(part(main,"ipcMain.handle('agent:cancel-queued-send'","ipcMain.handle('agent:cancel-send'"),context);
  vm.runInContext(compile(part(panel,'const isLocalPromptEntry =','const isLocalRewindEntry ='))
    +compile(part(panel,'  const removeLocalPromptEntry = useCallback(','  const acknowledgeMaterializedHistoryReceipt ='))
    +'\nglobalThis.dismiss = dismissPromptPresentation;',context);
  t.after(async()=>{queue.dispose();await tick();db.close();fs.rmSync(root,{recursive:true,force:true})});
  return {context,module,queue,store,identity,before,sends,calls,notices,persisted,rows:()=>rows,
    dismiss:()=>context.dismiss(rows[0]),
    reopen:async()=>{queue.dispose();await tick();db.close();db=new Database(filename);store=createAgentSendReceiptStore(db);return store.get(identity.operationKey)},
  };
}

for(const provider of ['codex','claude'])for(const surface of ['desktop-history','project-api']) {
  test(provider+'/'+surface+': actual old local card → Main → SQLite null attempt; reopen cannot resurrect it',async t=>{
    const h=await harness(t,{provider,surface});
    await h.dismiss();
    assert.deepEqual(h.notices,[]);
    assert.deepEqual(h.calls,['agent:dismiss-send-receipt-presentation']);
    assert.deepEqual(h.rows().map(row=>row.uuid),['canonical-equal-text']);
    assert.equal(h.persisted.length,1);
    const after=h.store.get(h.identity.operationKey);
    assert.equal(after.state,'not-submitted');assert.equal(after.attemptId,null);
    assert.equal(after.receipt.code,h.before.receipt.code);assert.equal(after.receipt.error,h.before.receipt.error);
    assert.equal(after.receipt.submitted,false);assert.equal(after.receipt.enterWritten,false);
    assert.equal(after.receipt.cancelled,h.before.receipt.cancelled);
    assert.equal(after.settledAt,h.before.settledAt);
    assert.equal(h.queue.referencedAssetIds().has('asset-a'),false);
    const restored=await h.reopen();
    const hydration=handoffs().hydrateHistoryPromptHandoffFromDurableReceipt({...restored,
      applicationQueue:{version:1,id:55,state:'failed'}});
    assert.equal(hydration.hydrated,false);assert.equal(hydration.reason,'durable-history-presentation-dismissed');
    assert.equal(h.sends.length,0);
  });
}

test('partial durable identity reads the terminal receipt immediately, without a fictional attempt wait',async t=>{
  const h=await harness(t,{partialIdentity:true});await h.dismiss();
  assert.deepEqual(h.calls,['agent:dismiss-send-receipt-presentation']);
  assert.deepEqual(h.notices,[]);assert.equal(h.rows().length,1);assert.equal(h.sends.length,0);
});

test('rehydrated failed FIFO row keeps the existing cancel/dismiss-unwritten path and no physical send',async t=>{
  const h=await harness(t,{hydrated:true});await h.dismiss();
  assert.deepEqual(h.calls,['agent:cancel-queued-send']);
  assert.deepEqual(h.notices,[]);assert.equal(h.rows().length,1);assert.equal(h.sends.length,0);
  assert.equal(h.store.get(h.identity.operationKey).state,'not-submitted');
});

test('foreign exact receipt ambiguity does not hide either row or release the queue owner',async t=>{
  const h=await harness(t);
  h.store.reserveOrGet({...h.identity,operationKey:'foreign-operation',surface:'project-api'});
  await h.dismiss();
  assert.equal(h.rows().length,2);assert.equal(h.notices.length,1);
  assert.equal(h.queue.referencedAssetIds().has('asset-a'),true);assert.equal(h.sends.length,0);
});
