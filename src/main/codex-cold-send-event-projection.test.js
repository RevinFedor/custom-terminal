'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const contract = require('./codex-runtime-contract');
const { projectCodexPolicyRuntime } = require('./codex-runtime-policies');
const targetContract = require('../shared/agent-send-target-precondition.cjs');
const manualActionContract = require('../shared/agent-manual-action.cjs');
const { createCodexRuntimeProjectionStore } = require('./codex-runtime-projection-store');
const main = fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
const tree = ts.createSourceFile('main.js',main,ts.ScriptTarget.Latest,true);
const declaration = name => { const n=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(n,name);return n.getText(tree); };
const readySource=fs.readFileSync(path.join(__dirname,'../renderer/utils/agentSendPreparation.ts'),'utf8');
const readyCode=ts.transpileModule(readySource.slice(readySource.indexOf('export function createAgentReadyWait('),
  readySource.indexOf('export async function proveAgentComposerForSend(')).replace(/\bexport /g,''),
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};

async function harness() {
  const { projectCodexPtyPresence }=await import('../renderer/utils/codexPtyPresence.mjs');
  const { runAgentSendFlow }=await import('../renderer/utils/agentSendFlow.mjs');
  let now=1000,ready=false,resumes=0;
  const term={},command={runSeq:1,isRunning:false},launch={command:'codex-c',sessionId:'S',launchId:'L',
    terminalToken:term,runSeq:1,lifecycleGeneration:'G:1',startedAt:1000};
  const ctx=vm.createContext({...contract,projectCodexPolicyRuntime,console:{log(){},warn(){},error(){}},
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS:60000,
    terminals:new Map([['T',term]]),terminalCommandState:new Map([['T',command]]),
    terminalLifecycleEpochs:new Map([[term,'I']]),getTerminalLifecycleGeneration:()=>launch.lifecycleGeneration,
    codexRuntimeProjectionStore:createCodexRuntimeProjectionStore(),
    codexLastRunCommandPayload:new Map(),codexKnownSessions:new Map([['T','S']]),
    codexConversationMaterializationCache:new Map([['S',{materialized:true,userTurns:10}]]),
    codexRuntimePolicies:null,codexLiveSettingsObserver:null,
    getCurrentCodexProvisionalSourceObservation:()=>null,
    getCodexResumeSourceLeaseForTab:()=>null,getCodexResumeReadIdentityLeaseForTab:()=>null,
    getCurrentCodexEmptyReadSource:()=>null,resolveAuthoritativeTabProjectId:()=> 'P',codexSessionIdFromDb:()=> 'S',
    isCodexTuiEffectivelyReady:()=>ready,hasCodexEstablishedComposerLifecycle:()=>ready,
    hasCodexEstablishedWriterUiLifecycle:()=>ready,hasEstablishedCodexLifecycleIndicators:()=>true,
    getCodexLiveInputControl:()=>null,hasCodexPromptOrTurnInFlight:()=>false,
    getCodexProvisionalSettingsSnapshot:()=>null,getCodexMcpStartupStatus:()=>null,
    codexTurnStateSnapshot:()=>({hasWatcher:true,busy:false,catchUpPending:false}),
  });
  for(const name of ['codexWriterProofs','codexWatchers','codexTurnWatchers','codexProviderSemanticSources',
    'aiStoppingTabs','codexSessionDiscoveryIntents','codexReadIdentitySubmitPending',
    'codexManualActionRequired','codexTuiReadyLastNotReady','codexLifecycleWarnings'])ctx[name]=new Map();
  for(const name of ['codexLateMcpProofPending','codexTuiReadyTabs','codexStartupNoStateTimeoutTabs'])ctx[name]=new Set();
  ctx.getCodexWriterProofSnapshot=()=>{
    const p=ctx.codexWriterProofs.get('T');return p?.terminalToken===ctx.terminals.get('T')
      &&p?.lifecycleGeneration===launch.lifecycleGeneration&&p?.runSeq===command.runSeq?p:null;
  };
  ctx.isCodexWriterUsableForMutation=()=>!!ctx.getCodexWriterProofSnapshot();
  vm.runInContext(['currentCodexAcceptedResumeSourceProof','readAgentSendDestinationAtWriteBoundary',
    'projectCodexRuntimeSnapshotFromEvents','publishCodexRuntimeProjection'].map(declaration).join('\n'),ctx);
  const ipcRenderer=new EventEmitter(),timers=new Map();let timerId=0;
  const runtime={toolType:'codex',label:'Codex',readyEvent:'codex:tui-ready',
    getPresence:async()=>{
      const snapshot=ctx.publishCodexRuntimeProjection('T','actual-IPC-test','P');
      const result=projectCodexPtyPresence(snapshot);assert.equal(result.complete,true,JSON.stringify(result));return result.presence;
    },resume:async()=>{resumes++;command.isRunning=true;ctx.codexLastRunCommandPayload.set('T',launch);return{success:true};}};
  const api=vm.runInNewContext(readyCode+'\n({prepareAgentRuntimeForSend})',{
    ...targetContract,manualActionContract,ipcRenderer,terminalRegistry:{get:()=>({})},
    console:{log(){},warn(){}},Date:{now:()=>now},
    setTimeout:(callback,ms)=>{const id=++timerId;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id),
    isCoordinatedAgentSendCancellationRequested:()=>false,
  });
  const providerContract={classifySubmitCapability:p=>p?.inputReady?'direct':'blocked',
    startupGateOwnsComposer:()=>false,waitForStartupGate:async()=>{}};
  const makeReady=(sessionId='S',sourceSessionId='S')=>{
    ready=true;ctx.codexKnownSessions.set('T',sessionId);
    ctx.codexWriterProofs.set('T',{valid:true,sessionId,sourceSessionId,kind:'process-open-rollout',
      terminalToken:ctx.terminals.get('T'),runSeq:command.runSeq,lifecycleGeneration:launch.lifecycleGeneration,launchId:launch.launchId});
  };
  return {ctx,launch,command,runtime,timers,runAgentSendFlow,makeReady,get resumes(){return resumes;},
    start:()=>api.prepareAgentRuntimeForSend({tabId:'T',runtime,providerContract,sessionId:'S',requestedStatusAtSend:'inactive'}),
    wake:()=>ipcRenderer.emit('agent:readiness-changed',null,{tabId:'T',toolType:'codex'}),
    expire:async()=>{now=61001;for(const timer of [...timers.values()])timer.callback();await tick();},
  };
}

for(const prompt of ['ordinary cold prompt with an image','/compact'])test('actual event producer→presence→cold preparation waits for same launch: '+prompt,async()=>{
  const h=await harness();let failure=null,writes=0;
  const pending=h.runAgentSendFlow({prepareContext:async()=>({prompt}),ensureReady:()=>h.start(),
    proveComposer:async()=>{},runProviderOperation:async ctx=>{assert.equal(ctx.prompt,prompt);writes++;return{success:true};}})
    .catch(error=>{failure=error;return null;});
  await tick();
  assert.equal(failure,null,'cold startup must not reject its own launch: '+failure?.code);
  assert.equal(writes,0);assert.equal(h.resumes,1);
  const snapshot=h.ctx.projectCodexRuntimeSnapshotFromEvents('T','P');
  assert.equal(snapshot.sessionId,null,'saved/read SID is not a writer');
  assert.equal(snapshot.sendTarget.sessionId,null);assert.equal(snapshot.sendTarget.launchId,snapshot.startupWait.launchId);
  assert.equal(snapshot.inputReady,false);assert.equal(snapshot.writerConfirmed,false);
  h.makeReady();h.wake();await pending;
  assert.equal(failure,null);assert.equal(writes,1);assert.equal(h.timers.size,0);
});

for(const kind of ['launch','instance','foreign-session','stop','unknown-timeout'])test('same cold chain still refuses '+kind,async()=>{
  const h=await harness();let writes=0;
  const pending=h.runAgentSendFlow({prepareContext:async()=>({}),ensureReady:()=>h.start(),
    proveComposer:async()=>{writes++;},runProviderOperation:async()=>{writes++;}});
  const rejected=assert.rejects(pending,error=>error.code=== (kind==='stop'?'agent_send_cancelled':kind==='unknown-timeout'
    ?'agent_send_readiness_timeout':'agent_send_target_changed') && error.sendReceipt.pasteWritten===false);
  await tick();
  if(kind==='launch') { h.launch.launchId='OTHER';h.makeReady(); }
  if(kind==='instance') { h.ctx.terminals.set('T',{});h.ctx.terminalLifecycleEpochs.set(h.ctx.terminals.get('T'),'OTHER');h.makeReady(); }
  if(kind==='foreign-session') h.makeReady('OTHER','OTHER');
  if(kind==='stop') h.ctx.aiStoppingTabs.set('T',{toolType:'codex'});
  if(kind==='unknown-timeout') await h.expire(); else h.wake();
  await rejected;assert.equal(writes,0);assert.equal(h.resumes,1);assert.equal(h.timers.size,0);
});

test('event destination and physical write destination agree; exact Resume child still accepts the original source',async()=>{
  const h=await harness();await h.runtime.resume();h.makeReady('CHILD','S');
  const snapshot=h.ctx.projectCodexRuntimeSnapshotFromEvents('T','P');
  assert.deepEqual(snapshot.sendTarget,h.ctx.readAgentSendDestinationAtWriteBoundary('T','codex'));
  assert.equal(snapshot.sendTarget.acceptedResumeSourceSessionId,'S');
  const ready=await h.start();assert.equal(ready.expectedTarget.sessionId,'S');assert.equal(ready.expectedTarget.launchId,'L');
});
