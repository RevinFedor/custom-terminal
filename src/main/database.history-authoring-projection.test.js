'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');
const ts = require('typescript');
const typedFixture = require('./fixtures/structured-authoring-37de-confirmed.json');
const nativeCaptured = require('./fixtures/codex-ios-native-image-20260916.json');
const { backfillConfirmedCanonicalAuthoringPresentations, backfillConfirmedSystemPromptPresentations,
  decorateHistoryPromptPresentations, cloneCodexPromptPresentationsForProvenChild } = require('./history-prompt-presentations');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { SessionTranscriptService } = require('./session-transcript-service');
const { applyHistoryEntryWindow } = require('./history-entry-window');
const { PublicHistoryRevisions } = require('./public-history-read');
const clone = value => JSON.parse(JSON.stringify(value));

for (const fixture of [typedFixture, { ...nativeCaptured, native: true, entries: [nativeCaptured.entry,
  { uuid: 'native-final', role: 'assistant', sessionId: nativeCaptured.record.sessionId,
    timestamp: '2026-09-16T07:51:16.683Z', content: '15:20', textPhase: 'final_answer' }],
  timing: { startTs: 1789545073828, endTs: 1789545077129 } }])
test((fixture.native ? 'native slots: ' : 'typed path: ') + 'actual audit caller -> SQLite -> HTTP delta; TTL/reopen/child copy', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-authoring-db-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const electron=require.resolve('electron'), previous=require.cache[electron];
  require.cache[electron]={id:electron,filename:electron,loaded:true,exports:{app:{isPackaged:false,getPath:()=>dir}}};
  const databaseModule=require.resolve('./database'),previousDatabase=require.cache[databaseModule];
  delete require.cache[databaseModule];
  const DatabaseManager=require('./database');
  if(previousDatabase)require.cache[databaseModule]=previousDatabase;else delete require.cache[databaseModule];
  if(previous)require.cache[electron]=previous;else delete require.cache[electron];
  let db;
  try { db=new DatabaseManager(); } catch(error) {
    if(error.code==='ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error.message)) { t.skip('run with Electron ABI');return; }
    throw error;
  }
  t.after(()=>db?.close());
  const originalRows=clone(fixture.entries), filePath=path.join(dir,'read-witness.jsonl');
  fs.writeFileSync(filePath,'{"type":"session_meta"}\n');
  const service=new SessionTranscriptService({getMainWindow:()=>null,promptPresentationStore:db,
    codexData:{_api:{findCodexSessionFile:async()=>({filePath}),loadSessionRecords:async()=>{
      const stat=fs.statSync(filePath);return {success:true,records:[],filePath,
        sourceSnapshot:{filePath,size:stat.size,mtimeMs:stat.mtimeMs,sessionId:fixture.record.sessionId,linkKind:'end'}};
    },buildCodexFullHistory:()=>clone(originalRows)}}});
  const web=fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8');
  const sendJson=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const routeStart=web.indexOf('  // Load JSONL session history.'),routeEnd=web.indexOf("  return sendJson(res, 404, { error: 'not found' });",routeStart);
  const route=vm.runInNewContext('(async(req,res,parsed)=>{let m;'+web.slice(routeStart,routeEnd)+'})',{
    console:{log(){},warn(){}},crypto,sendJson,decId:decodeURIComponent,applyHistoryEntryWindow,
    publicHistoryRevisions:new PublicHistoryRevisions(),transcriptService:service,publishTabTiming(){},
    conversationOwners:null,finishConversationOwnerRead:()=>({}),
    resolveHistorySessionInfo:async()=>({toolType:'codex',sessionId:fixture.record.sessionId,cwd:dir,writerConfirmed:true}),
    bridgeRequest:()=>{throw Error('no renderer fallback');},
  });
  const server=http.createServer((req,res)=>route(req,res,url.parse(req.url,true)).catch(e=>sendJson(res,500,{error:e.message})));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
  const read=async revision=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/terminal-tabs/'+fixture.record.tabId+'/history?view=history&delta=1&last=80'+(revision?'&ifRevision='+revision:''));
    const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;
  };
  const expectedText=fixture.native ? nativeCaptured.entry.content
    :fixture.record.receipt.promptText.replace(/\[imagePath:[^\]]+\]/,'[Image #1]');
  const before=await read();assert.equal(before.entries.find(e=>e.role==='user').content,
    fixture.native ? nativeCaptured.entry.content :fixture.record.receipt.transportText);
  const receiptStore=createAgentSendReceiptStore(db.db,{randomUUID:()=>fixture.record.attemptId});
  const identity={...fixture.record,surface:'project-api',requestFingerprint:'captured37DEimmutable',runId:null};
  const started=receiptStore.beginAttempt(identity);assert.equal(started.attemptId,fixture.record.attemptId);
  assert.equal(receiptStore.stageAttemptContext(identity.operationKey,started.attemptId,fixture.record.receipt).ok,true);
  receiptStore.markAttemptState(identity.operationKey,started.attemptId,'enter-armed');
  const ast=ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='notifyAgentPromptAuditResult').getText(ast);
  const notify=vm.runInNewContext('('+fn+')',{
    console:{log(){},warn(){}},path,srcMainDir:__dirname,
    cleanOptionalString:(s,f='')=>typeof s==='string'?s.trim():f,shortId:s=>s,
    agentSendReceiptStore:receiptStore,agentSendReceiptRegistry:{promoteFromAudit:()=>({matched:false})},
    backfillConfirmedCanonicalAuthoringPresentations,tabWorkContext:null,
    getOrchestrationRunStore:()=>({}),orchestrationTargetRunIdFromAudit:()=>null,orchestrationCompletionRunIdFromAudit:()=>null,
    require:id=>{assert.equal(id,path.join(__dirname,'project-manager'));return {db};},
  });
  const audit={...fixture.record.receipt,success:true,tabId:identity.tabId,handoffId:identity.handoffId,toolType:'codex',
    expectedHash:identity.promptHash,expectedLen:identity.promptLength,
    sendOperationKey:identity.operationKey,sendAttemptId:started.attemptId};
  const accepted=await notify(audit);assert.equal(accepted.confirmed,true,JSON.stringify(accepted));
  const canonical=db.getHistoryPromptPresentations('codex',identity.sessionId);
  assert.equal(canonical.length,1);assert.equal(canonical[0].schemaVersion,4);
  const interval=db.saveActivityInterval({tabId:identity.tabId,engine:'codex',sessionId:identity.sessionId,
    startTs:fixture.timing.startTs,endTs:fixture.timing.endTs});
  db.savePendingHistoryResponseTiming({intervalId:interval.id,toolType:'codex',tabId:identity.tabId,sessionId:identity.sessionId});
  const delta=await read(before.historyRevision);
  assert.equal(delta.delta,true);assert.deepEqual(delta.changedEntries.map(e=>e.uuid),[originalRows.find(e=>e.role==='user').uuid,originalRows.at(-1).uuid]);
  assert.equal(delta.changedEntries[0].content,expectedText);
  if(fixture.native) assert.equal(delta.changedEntries[0].imagePaths[0].path,fixture.record.receipt.expectedImageRefs[0].path);
  assert.equal(delta.changedEntries[1].responseTiming.durationMs,interval.durationMs);
  assert.equal(db.getLatestPendingHistoryResponseTimingForTab(identity.tabId,'codex'),null);
  assert.equal((await read(delta.historyRevision)).unchanged,true);
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db,[receiptStore.get(identity.operationKey)]),0);
  const pruned=receiptStore.prune(Date.now()+8*24*60*60*1000);
  assert.equal(pruned.deleted,1);assert.equal(receiptStore.get(identity.operationKey),null);
  db.close();db=new DatabaseManager();service.promptPresentationStore=db;
  const reopened=await read();
  assert.equal(reopened.entries.find(e=>e.role==='user').content,expectedText);
  if(fixture.native) assert.equal(reopened.entries.find(e=>e.role==='user').imagePaths[0].sourcePath,
    fixture.record.receipt.expectedImageRefs[0].path);
  assert.equal(reopened.entries.at(-1).responseTiming.durationMs,interval.durationMs);
  const childSessionId='child-proven-copy';
  const makeRecord=line=>({type:'event_msg',__line:line,timestamp:fixture.record.auditIdentity.auditTimestamp,
    payload:{type:'user_message',message:fixture.native ? nativeCaptured.entry.content :fixture.record.receipt.transportText}});
  const copy=cloneCodexPromptPresentationsForProvenChild(db,{sourceSessionId:identity.sessionId,childSessionId,
    sourceRecords:[makeRecord(13)],childRecords:[makeRecord(5)]});
  assert.equal(copy.cloned,1,JSON.stringify(copy));
  const childEntry={...clone(originalRows.find(e=>e.role==='user')),uuid:'codex-user-'+childSessionId+'-5',
    sessionId:childSessionId,sourceIdentity:'child-byte-address',sourceIdentityAliases:[]};
  const child=decorateHistoryPromptPresentations(db,{toolType:'codex',sessionId:childSessionId,entries:[childEntry]})[0];
  assert.equal(child.content,expectedText);
  if(fixture.native) assert.equal(child.imagePaths[0].path,fixture.record.receipt.expectedImageRefs[0].path);
  assert.equal(cloneCodexPromptPresentationsForProvenChild(db,{sourceSessionId:identity.sessionId,childSessionId,
    sourceRecords:[makeRecord(13)],childRecords:[makeRecord(5)]}).unchanged,1);
  assert.deepEqual(originalRows,fixture.entries);
});
