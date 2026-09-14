'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { inboxHistoryAudit, InboxSavedHistoryOperations } = require('./inbox-saved-history-operation');
const { SavedHistoryOperations } = require('./saved-history-operation');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const tree = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const functions = names => names.map(name => {
  const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node,name);return node.getText(tree);
}).join('\n');

function cleanupHarness({ closed=false }={}) {
  const events=[],callbacks=[];
  const run={runId:'current-run',tabId:'T',provider:'codex',conversationKey:'chat',sessionId:'source',auditSessionId:'source',
    status:'done',completionStamp:'old-attempt:turn',activityRevision:1,autoStopMs:30000,autoCloseMs:900000,stopTimer:1,closeTimer:2};
  const ctx={externalRuns:new Map(closed?[]:[['current-run',run]]),externalRunByTabId:new Map(closed?[]:[['T','current-run']]),
    externalRunByConversationKey:new Map(closed?[]:[['chat','current-run']]),INBOX_PROJECT_ID:'__noted_inbox__',
    inboxSavedHistoryOperations:{holds:()=>ctx.held},held:true,
    clearTimeout:id=>events.push(['cancel',id]),setTimeout:fn=>{callbacks.push(fn);return callbacks.length;},
    clampAutoStopMs:v=>v,clampAutoCloseMs:v=>v,Date,
    setExternalRunMeta:(_t,meta)=>events.push(['metadata',meta]),
    runAgentStopScenario:async()=>events.push(['stop']),bridgeRequest:async()=>events.push(['close']),
    cleanupExternalRun:()=>events.push(['cleanup']),console};
  vm.createContext(ctx);vm.runInContext(functions(['clearExternalRunTimer','scheduleExternalRunStop','scheduleExternalRunClose',
    'scheduleExternalRunCompletionTimers','claimInboxHistoryCleanup']),ctx);
  const claim=()=>ctx.claimInboxHistoryCleanup({tabId:'T',conversationKey:'chat',descriptor:{projectId:'__noted_inbox__',toolType:'codex',sessionId:'source',externalRun:{...run}}});
  return{ctx,events,callbacks,claim,run};
}

for(const closed of [false,true])test('actual cleanup owns same chat, preserves policy/audit, closed restore='+closed,()=>{
  const h=cleanupHarness({closed});const owner=h.claim();
  assert.equal(owner.runId,'current-run');assert.doesNotThrow(owner.validate);
  const run=h.ctx.externalRuns.get('current-run');
  assert.equal(run.cleanupCancelled,true);assert.equal(run.stopTimer,null);assert.equal(run.closeTimer,null);
  h.ctx.held=false;owner.release({success:true,activeSessionId:'child',operationId:'one-history-op'});
  assert.equal(run.sessionId,'child');assert.equal(run.auditSessionId,'source');
  assert.equal(run.autoStopMs,30000);assert.equal(h.callbacks.length,2);
  assert.equal(h.events.some(e=>e[0]==='stop'||e[0]==='close'),false,'arming existing cleanup is not a control write');
});

test('queued actual cleanup callbacks cannot Stop/Close an owned saved-history operation',async()=>{
  const h=cleanupHarness();h.ctx.held=false;h.ctx.scheduleExternalRunCompletionTimers(h.run);
  h.ctx.held=true;await Promise.all(h.callbacks.map(fn=>fn()));
  assert.equal(h.events.some(e=>e[0]==='stop'||e[0]==='close'),false);
});

test('newer conversation owner and explicit desktop open are not overwritten by settlement',()=>{
  const h=cleanupHarness();const owner=h.claim();h.ctx.held=false;
  h.ctx.externalRunByTabId.set('T','new-run');assert.throws(owner.validate,/owner_changed/);
  owner.release({success:true,activeSessionId:'child'});assert.equal(h.run.sessionId,'source');assert.equal(h.callbacks.length,0);
  const h2=cleanupHarness();const second=h2.claim();h2.ctx.held=false;h2.run.openedInTerminalAt=1;
  second.release({success:true,activeSessionId:'child'});assert.equal(h2.callbacks.length,0);
});

test('a cleanup control already started or unproven archived policy refuses admission',()=>{
  for(const status of ['stopping','closing','rewinding']){const h=cleanupHarness();h.run.status=status;assert.throws(h.claim,/owner_changed/);}
  const h=cleanupHarness({closed:true});h.run.conversationKey='other';assert.throws(h.claim,/owner_changed/);
});

const receipt=()=>({surface:'inbox',runId:'R',operationKey:'inbox:R',handoffId:'external-run:R',provider:'codex',state:'confirmed',
  tabId:'T',attemptId:'A',auditIdentity:{provider:'codex',attemptId:'A',sessionId:'source',entryUuid:'U'}});
test('audit gate rejects wrong conversation, attempt, provider and non-confirmed sends',()=>{
  const reserved=(_run,conversation)=>conversation==='chat'?'T':'OTHER';
  assert.equal(inboxHistoryAudit(receipt(),'R','chat',reserved).entryUuid,'U');
  for(const patch of [{state:'audit-pending'},{provider:'claude'},{runId:'other'},{attemptId:'B'},{handoffId:'other'}]){
    assert.throws(()=>inboxHistoryAudit({...receipt(),...patch},'R','chat',reserved),/audit_unproven/);
  }
  assert.throws(()=>inboxHistoryAudit(receipt(),'R','other',reserved),/audit_unproven/);
});

test('real SQLite atomic ingress+execution receipt reopens unknown, never a new dispatch',async t=>{
  const Sqlite=require('better-sqlite3');const Database=require('./database');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inbox-history-db-'));let sql;
  try{sql=new Sqlite(path.join(dir,'db'));}catch(e){fs.rmSync(dir,{recursive:true,force:true});if(e.code==='ERR_DLOPEN_FAILED'){t.skip('Electron ABI');return;}throw e;}
  t.after(()=>{if(sql.open)sql.close();fs.rmSync(dir,{recursive:true,force:true});});
  sql.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const db=Object.create(Database.prototype);db.db=sql;
  const args={db,executor:new SavedHistoryOperations({db,dispatch:async()=>{}}),getReceipt:receipt,reservedTabId:()=> 'T',
    readNativeState:()=>({pending:false}),ensureOpen:async()=>({descriptor:{}}),resolveSession:async()=>({toolType:'codex',sessionId:'source'}),
    transcript:{getTimeline:async()=>({success:true,entries:[{uuid:'U',type:'user',content:'text'}]})},
    cleanup:{claim:()=>({runId:'R',validate(){},release(){}})}};
  const wrapper=new InboxSavedHistoryOperations(args);
  const request={operationId:'one',kind:'rewind',expectedSessionId:'source',conversationKey:'chat',targetEntryUuid:'U'};
  const accepted=await wrapper.accept('R',request);assert.equal(accepted.operation.phase,'accepted');
  sql.close();sql=new Sqlite(path.join(dir,'db'));db.db=sql;
  const reopened=new InboxSavedHistoryOperations({...args,getReceipt:()=>null,executor:new SavedHistoryOperations({db,dispatch:()=>assert.fail('blind retry')})});
  assert.equal(reopened.read('R','one').operation.state,'outcome-unknown');assert.equal(reopened.holds('T'),true);
  assert.equal((await reopened.accept('R',request)).idempotent,true);
  await assert.rejects(reopened.accept('R',{...request,operationId:'two'}),/operation_pending/);
  const record=reopened.executor.read('T',accepted.operation.executorOperationId);
  assert.equal(record.origin.audit.entryUuid,'U');
  db.setAppState(reopened.executor.key('T',accepted.operation.executorOperationId),{
    ...record,state:'completed',phase:'completed',pending:false,success:true,historyMutated:true,bindingCommitted:true,activeSessionId:'child'});
  assert.equal(reopened.holds('T'),false,'post-completion/pre-cleanup crash cannot keep a permanent lock');
  assert.equal(reopened.read('R','one').cleanup.state,'released-recovered');
});
