// Recovered Pro source-activity probe 88, with explicit recorded edits 128/162.
// Baseline mode reproduces old failures. Default requires coherent current results.
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const path=require('node:path'),ts=require('typescript');
const root=process.env.CODEX_POLICY_PROBE_ROOT||path.resolve(__dirname,'..');
const baseline=process.env.CODEX_POLICY_EXPECT_BASELINE==='1';
const stripTypeScriptTypes=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const contract=require(root+'/src/main/codex-runtime-contract.js');
const {resolveCodexWriterInspection}=require(root+'/src/main/codex-runtime-observation.js');
const {projectCodexPolicyRuntime}=require(root+'/src/main/codex-runtime-policies.js');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const source=fs.readFileSync(root+'/src/main/main.js','utf8');
const tree=ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true);
const queryNode=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getCodexRuntimeSessionSnapshot');
const helperNode=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='captureCodexRuntimeReadCheckpoint');
const mainText=[helperNode?.getText(tree),queryNode.getText(tree)].filter(Boolean).join('\n');
async function oneCase(action){
 const entered=deferred(), release=deferred(); const oldTerm={fixture:'A'},newTerm={fixture:'B'};
 let generation='epoch-A:1', currentSid='writer-A', inputRevision=1, providerRunning=true, inspections=0, publications=0;
 const trace=[];
 const proof={valid:true,sessionId:currentSid,terminalToken:oldTerm,runSeq:1,lifecycleGeneration:generation,kind:'process-open-rollout',filePath:'/FAKE/rollout-A',pids:[111],launchId:'launch-A'};
 const c={console:{log:(...x)=>trace.push(x.join(' ')),warn:(...x)=>trace.push(x.join(' '))},Date,Map,Set,Number,String,Object,...contract,resolveCodexWriterInspection,projectCodexPolicyRuntime,
  terminals:new Map([['tab',oldTerm]]), terminalCommandState:new Map([['tab',{isRunning:true,runSeq:1}]]),
  terminalProjects:new Map([['tab','/FAKE/project']]),codexLastRunCommandPayload:new Map(),codexWatchers:new Map(),
  codexLaunchObservationPending:new Map(),codexLaunchAcceptancePending:new Map(),codexStartupNoStateTimeoutTabs:new Map(),
  codexWriterProofs:new Map([['tab',proof]]),codexKnownSessions:new Map([['tab','writer-A']]),
  codexTurnWatchers:new Map([['tab',{sessionId:'writer-A',busy:false,hasWatcher:true,catchUpPending:false,outcomeKnown:true}]]),
  aiStoppingTabs:new Map(),codexLateMcpProofPending:new Set(),aiProcessLookupCache:new Map(),codexConversationMaterializationCache:new Map(),
  codexSessionDiscoveryIntents:new Map(),codexReadIdentitySubmitPending:new Map(),codexManualActionRequired:new Map(),
  codexTuiReadyLastNotReady:new Map(),codexLifecycleWarnings:new Map(),
  getCodexTuiReadyState:async()=>({inputReady:true}),hasEstablishedCodexLifecycleIndicators:()=>true,
  getTerminalLifecycleGeneration:()=>generation,
  getTerminalInputRevision:()=>inputRevision,mainWindow:null,
  getCodexWriterProofSnapshot:()=>c.codexWriterProofs.get('tab')||null,
  invalidateCodexWriterProof:()=>{assert.equal(providerRunning,false);c.codexWriterProofs.delete('tab');},
  reconcileCodexWriterFromProcess:async()=>{
    if(action==='adopt'){c.codexWriterProofs.set('tab',proof);return {status:'adopted',sessionId:currentSid};}
    if(action==='unknown') return {status:'unknown',preserveWriterProof:true};
    assert.equal(providerRunning,false);return {status:'absent'};
  },
  codexTurnStateSnapshot:t=>t||{},isCodexWriterUsableForMutation:()=>c.terminals.has('tab'),
  hasCodexEstablishedWriterUiLifecycle:()=>true,isCodexTuiEffectivelyReady:()=>c.terminals.has('tab'),
  hasCodexEstablishedComposerLifecycle:()=>true,getCodexLiveInputControl:()=>null,
  resolveAuthoritativeTabProjectId:()=> 'project',codexSessionIdFromDb:()=>currentSid,
  projectManager:{db:{getTabCodexSettingsState:()=>({})}},
  codexDataModule:{_api:{inspectConversationMaterializationFromFile:async()=>{inspections++;
    if(action==='churn') {const turn=c.codexTurnWatchers.get('tab');turn.busy=!turn.busy;}
    entered.resolve();await release.promise;return {materialized:action!=='churn',userTurns:2,reason:'user-history-present'};}}},
  getCodexResumeSourceLeaseForTab:()=>null,getCodexResumeReadIdentityLeaseForTab:()=>null,
  hasCodexPromptOrTurnInFlight:()=>false,getCodexStartupNoStateTimeout:()=>null,maybeSurfaceCodexStartupNoStateTimeout:()=>{},
  getCodexMcpStartupStatus:()=>null,getCodexProvisionalSettingsSnapshot:()=>null,
  publishCodexRuntimeProjection:()=>{publications++;},codexLiveSettingsObserver:{read:()=>null},codexRuntimePolicies:{read:()=>null},
  readAgentSendDestinationAtWriteBoundary:()=>({sessionId:currentSid,lifecycleGeneration:generation}),
 };
 if(action==='adopt'||action==='unknown') c.codexWriterProofs.delete('tab');
 const context=vm.createContext(c);vm.runInContext(mainText,context);
 const request=context.getCodexRuntimeSessionSnapshot('tab');
 if(action==='stop-before-proof') {providerRunning=false;c.terminalCommandState.set('tab',{isRunning:false,runSeq:1});c.codexWriterProofs.delete('tab');c.codexTurnWatchers.delete('tab');}
 await entered.promise;
 if(action==='replace'){
  generation='epoch-B:2';currentSid='writer-B';
  c.terminals.set('tab',newTerm);c.terminalCommandState.set('tab',{isRunning:true,runSeq:2});
  c.codexKnownSessions.set('tab',currentSid);c.codexWriterProofs.set('tab',{...proof,sessionId:currentSid,terminalToken:newTerm,runSeq:2,lifecycleGeneration:generation,launchId:'launch-B',filePath:'/FAKE/rollout-B',pids:[222]});
  c.codexTurnWatchers.set('tab',{sessionId:currentSid,busy:true});
 }else if(action==='stop'||action==='close'){
  providerRunning=false;
  if(action==='close'){generation=null;c.terminals.delete('tab');}c.terminalCommandState.set('tab',{isRunning:false,runSeq:1});
  c.codexWriterProofs.delete('tab');c.codexTurnWatchers.delete('tab');
 }else if(action==='turn'){
  Object.assign(c.codexTurnWatchers.get('tab'),{busy:true,currentTurnId:'turn-B'});
 }else if(action==='input'){
  inputRevision++;
 }
 release.resolve();let snapshot;
 try {snapshot=await request;} catch(error) {return {action,errorCode:error.code,inspections,publications,trace};}
 let persisted=currentSid; const storeCalls=[];
 const presence=await import(root+'/src/renderer/utils/codexPtyPresence.mjs');
 const writerSource=fs.readFileSync(root+'/src/renderer/utils/codexWriterIdentity.ts','utf8');
 // Remove imports only; production function bodies unchanged, TypeScript types erased by Node.
 const writerJs=stripTypeScriptTypes(writerSource.split('\n').slice(7).join('\n')).replace(/^export /gm,'');
 const renderer=vm.createContext({console:c.console,...presence,window:{require:()=>({ipcRenderer:{invoke:async()=>snapshot}})},
  useWorkspaceStore:{getState:()=>({getCodexSessionId:()=>persisted,setCodexSessionId:(...args)=>{persisted=args[1];storeCalls.push(args);}})},
 });
 vm.runInContext(writerJs+'\nglobalThis.resolveSurface = resolveCodexSurfaceSession;',renderer);
 const resolved=await renderer.resolveSurface({tabId:'tab',operation:'audit read-only fixture'});
 return {action,inspections,publications,trace,actual:{sessionId:currentSid,lifecycleGeneration:generation,hasTerm:c.terminals.has('tab'),isRunning:c.terminalCommandState.get('tab')?.isRunning===true,providerRunning},
  snapshot:{sessionId:snapshot.sessionId,liveLifecycle:snapshot.liveLifecycle,hasTerm:snapshot.hasTerm,sessionStatus:snapshot.sessionStatus,inputReady:snapshot.inputReady,busy:snapshot.busy,writerConfirmed:snapshot.writerConfirmed,writerUsableForMutation:snapshot.writerUsableForMutation,lifecycleGeneration:snapshot.lifecycleGeneration,readSessionId:snapshot.readSessionId,readIdentitySource:snapshot.readIdentitySource,sendTarget:snapshot.sendTarget},
  consumer:{resolvedSession:resolved.sessionId,persisted,storeCalls}};
}
(async()=>{const stable=await oneCase('stable'),replaced=await oneCase('replace'),stopped=await oneCase('stop'),closed=await oneCase('close'),
  turned=await oneCase('turn'),input=await oneCase('input'),earlyStop=await oneCase('stop-before-proof'),churn=await oneCase('churn'),
  adopted=await oneCase('adopt'),unknown=await oneCase('unknown');
 assert.equal(stable.snapshot.sessionId,stable.actual.sessionId);assert.equal(stable.consumer.storeCalls.length,0);
 assert.equal(replaced.snapshot.sessionId,baseline?'writer-A':'writer-B');assert.equal(replaced.snapshot.lifecycleGeneration,'epoch-B:2');
 assert.equal(replaced.consumer.persisted,baseline?'writer-A':'writer-B');assert.equal(replaced.consumer.storeCalls.length,baseline?1:0);
 assert.equal(stopped.snapshot.writerConfirmed,baseline);assert.equal(stopped.snapshot.liveLifecycle,baseline);
 assert.equal(stopped.snapshot.hasTerm,true);assert.equal(closed.snapshot.hasTerm,false);assert.equal(stopped.snapshot.inputReady,baseline);
 assert.equal(turned.snapshot.busy,!baseline);
 assert.equal(earlyStop.actual.isRunning,baseline,'a stale cached proof must not resurrect command-running after Stop');
 if(!baseline) {assert.equal(input.trace.filter(x=>x.includes('[CodexRuntimeRead] retry')).length,1);
   assert.equal(input.inspections,1,'a coherent retry may reuse valid materialization cache');
   assert.equal(churn.errorCode,'codex_runtime_snapshot_unstable');assert.equal(churn.publications,0);}
 assert.equal(adopted.snapshot.writerConfirmed,true);assert.equal(adopted.snapshot.sessionId,'writer-A');assert.equal(adopted.trace.length,0,'own reconciliation can strengthen a writer without a retry');
 assert.equal(unknown.snapshot.liveLifecycle,null);assert.equal(unknown.snapshot.sessionId,null);assert.equal(unknown.snapshot.writerConfirmed,false);
 const report={kind:'actual source query and consumer, fake I/O and store; not physical/E2E',root,baseline,node:process.version,
  querySlice:{file:'src/main/main.js',start:source.slice(0,queryNode.getStart(tree)).split('\n').length,
    end:source.slice(0,queryNode.end).split('\n').length,sha256:crypto.createHash('sha256').update(mainText).digest('hex')},
  cases:[stable,replaced,stopped,closed,turned,input,earlyStop,churn,adopted,unknown]};
 if(process.env.CODEX_POLICY_PROBE_OUTPUT) fs.writeFileSync(process.env.CODEX_POLICY_PROBE_OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
