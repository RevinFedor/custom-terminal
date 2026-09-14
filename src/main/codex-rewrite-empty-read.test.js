'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { isProvenEmptyCodexHistoryRewrite } = require('./session-history-events');
const { validateCodexProvisionalSourceObservation, resolveCodexReadIdentity } = require('./codex-runtime-contract');
const { createCodexRuntimeProjectionStore } = require('./codex-runtime-projection-store');
const { SessionTranscriptService } = require('./session-transcript-service');

const event = () => ({ eventType:'fork',provider:'codex',forkMode:'history_delete',operationKind:'delete',
  sourceSessionId:'source',childSessionId:'child',origin:'app',isDirect:true,snapshotComplete:true,
  lineageManifest:null,entryUuids:[],boundaryEntryUuid:null });
const meta = () => ({id:'child',session_id:'child',forked_from_id:'source',history_mode:'legacy'});

test('empty app rewrite proof is exact; native/ambiguous/nonempty/corrupt contracts remain closed', () => {
  assert.equal(isProvenEmptyCodexHistoryRewrite(event(),meta()),true);
  assert.equal(isProvenEmptyCodexHistoryRewrite({...event(),operationKind:'rewind'},meta()),true);
  for (const patch of [{origin:'transcript'},{forkMode:'unknown'},{forkMode:'direct-virtual'},
    {forkMode:'full'},{operationKind:'fork'},{snapshotComplete:false},{isDirect:false},
    {lineageManifest:{}},{entryUuids:['lost-row']},{entryUuids:null},{boundaryEntryUuid:'lost'},
    {sourceSessionId:'other'},{childSessionId:'other'},{provider:'claude'}]) {
    assert.equal(isProvenEmptyCodexHistoryRewrite({...event(),...patch},meta()),false,JSON.stringify(patch));
  }
  for (const patch of [{id:'other'},{session_id:'source'},{forked_from_id:'other'},
    {history_mode:'paginated'},{history_mode:undefined},{history_base:{}},{forked_from_ordinal_exclusive:0}]) {
    assert.equal(isProvenEmptyCodexHistoryRewrite(event(),{...meta(),...patch}),false,JSON.stringify(patch));
  }
});

test('empty zero-row History, Timeline and search use the same materialized proof', async () => {
  const projected={success:true,entries:[],sessionMeta:meta(),filePath:'/fixture/child',
    sourceSnapshot:{filePath:'/fixture/child',size:10,mtimeMs:1,sessionId:'child'}};
  const service = new SessionTranscriptService({ getMainWindow:()=>null,
    codexData:{_api:{projectCodexTimelineFromFile:async()=>projected,projectCodexFullHistoryFromFile:async()=>projected}},
    sessionHistoryStore:{getSessionHistoryEvents:()=>[event()]} });
  // No file discovery/DB recovery exists in this bounded projection fixture;
  // the public read checks below still consume the real common lineage guard.
  service.ensureCodexProviderForkLineage=async()=>({required:false});
  const scope={toolType:'codex',sessionId:'child',cwd:'/fixture'};
  assert.equal((await service.getTimeline(scope)).success,true);
  assert.equal((await service.getHistory({...scope,dehydrate:true})).success,true);
  assert.equal((await service.searchHistory({...scope,query:'abc'})).success,true);
  projected.sessionMeta={...meta(),history_mode:'paginated'};
  assert.equal((await service.getTimeline(scope)).lineageReason,'legacy-fork-event-without-raw-manifest');
  assert.equal((await service.getHistory({...scope,dehydrate:true})).lineageReason,'legacy-fork-event-without-raw-manifest');
  assert.equal((await service.searchHistory({...scope,query:'abc'})).lineageReason,'legacy-fork-event-without-raw-manifest');
});

test('actual discovery publication wakes cached HTTP/SSE read without /status or promoting a writer', () => {
  const text=fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
  const ast=ts.createSourceFile('main.js',text,ts.ScriptTarget.Latest,true);
  const names=['rememberCodexProvisionalSourceObservation','getCurrentCodexProvisionalSourceObservation',
    'publishCodexRuntimeProjection','getCodexRuntimeProjectionBatch'];
  const code=names.map(name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast)).join('\n');
  const terminal={}, changes=[], observations=new Map(), store=createCodexRuntimeProjectionStore();
  const launch={command:'codex-c',tabId:'T',sessionId:'child',launchId:'launch',terminalToken:terminal,runSeq:2,lifecycleGeneration:'life:2'};
  const intent={sourceMode:'resume',sourceSessionId:'child',launchId:'launch',sourceRunSeq:2,sourceLifecycleGeneration:'life:2'};
  let submitResolutionPending=null;
  const scope=vm.createContext({ console:{log(){}},codexProvisionalSourceObservations:observations,
    codexRuntimeProjectionStore:store,codexSessionDiscoveryIntents:new Map([['T',intent]]),
    terminals:new Map([['T',terminal]]),terminalCommandState:new Map([['T',{runSeq:2,isRunning:true}]]),
    getTerminalLifecycleGeneration:()=> 'life:2',codexSessionIdFromDb:()=> 'child',validateCodexProvisionalSourceObservation,
    _webBroadcast:(tabId,payload)=>changes.push({tabId,payload}),
    projectCodexRuntimeSnapshotFromEvents:()=>{
      const observation=scope.getCurrentCodexProvisionalSourceObservation('T');
      const read=resolveCodexReadIdentity({tabId:'T',liveLifecycle:true,savedSessionId:'child',persistedSessionId:'child',
        writerConfirmed:false,writerUsableForMutation:false,writerStatus:observation?'provisional-source':'pending',
        observedWriterSessionId:observation?.sessionId,resumeSourceSessionId:'child',launch,intent,
        resumeLease:{tabId:'T',sourceSessionId:'child',launchId:'launch'},
        sourceTurn:{sessionId:'child',sourceObservationLaunchId:'launch',processGeneration:'life:2'},
        terminalToken:terminal,terminalRunSeq:2,terminalLifecycleGeneration:'life:2',processRunning:true,
        processPids:observation?.pids||[],submitResolutionPending});
      return {projectId:'P',sessionId:null,readSessionId:read.sessionId,writerConfirmed:false,writerUsableForMutation:false};
    } });
  vm.runInContext(code,scope);
  assert.equal(scope.getCodexRuntimeProjectionBatch([{tabId:'T'}],'P').T.readSessionId,null);
  const proof={status:'provisional-source',sessionId:'child',launchId:'launch',terminalToken:terminal,
    runSeq:2,lifecycleGeneration:'life:2',pids:[42]};
  scope.rememberCodexProvisionalSourceObservation('T',proof);
  const result=scope.getCodexRuntimeProjectionBatch([{tabId:'T'}],'P').T;
  assert.equal(result.readSessionId,'child');assert.equal(result.writerConfirmed,false);assert.equal(result.sessionId,null);
  assert.equal(changes.length,1);assert.equal(changes[0].payload.type,'snapshot');
  scope.rememberCodexProvisionalSourceObservation('T',{...proof,observedAt:2});assert.equal(changes.length,1);
  submitResolutionPending={tabId:'T',sourceSessionId:'child',launchId:'launch',terminalToken:terminal,runSeq:2,lifecycleGeneration:'life:2'};
  scope.rememberCodexProvisionalSourceObservation('T',proof);
  assert.equal(scope.getCodexRuntimeProjectionBatch([{tabId:'T'}],'P').T.readSessionId,null);
  submitResolutionPending=null;
  scope.rememberCodexProvisionalSourceObservation('T',{...proof,runSeq:1});
  assert.equal(scope.getCodexRuntimeProjectionBatch([{tabId:'T'}],'P').T.readSessionId,null);
  assert.equal(observations.size,0);
});
