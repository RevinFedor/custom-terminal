'use strict';
// Actual Main input authorizer, action authority and physical sender. Only
// current OS/provider/frame endpoints are controlled; no native process runs.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {fixture:writeFixture,drainMicrotasks}=require('./send-preparation-write.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const ast=ts.createSourceFile('main.js',main,ts.ScriptTarget.Latest,true);
function actual(name,optional=false){const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name
 ||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
 if(!n&&!optional)throw Error('missing actual '+name);return n?.getText(ast)||'';}
function fixture(t,options={}){
 const h=writeFixture(t,{open:false,...options}),c=h.ctx,term=h.term;
 const control={busy:false,ready:true,provider:'codex',process:'found',processRead:null,writer:null,lease:true,cwd:'/fixture',frame:true};
 const owner={ownerToken:'owner-T',ownerOrder:{epoch:'epoch',revision:1},currentBinding:{provider:'codex',sessionId:'source'}};
 const intent={sourceMode:'resume',sourceSessionId:'source',launchId:'launch-T',startedAt:h.clock.now()};
 const discovery={...intent,provisionalSubmitReservation:null};
 const observation=Object.freeze({status:'provisional-source',sessionId:'source',sourceSessionId:'source',launchId:'launch-T',
  terminalToken:term,runSeq:1,lifecycleGeneration:'L1',pids:[7]});
 const scope=()=>({terminal:c.terminals.get('T'),generation:c.getTerminalLifecycleGeneration('T'),
  runSeq:c.terminalCommandState.get('T').runSeq,provider:control.provider});
 Object.assign(c,{path,...require('../codex-writer-ownership'),...require('../codex-action-authority'),
  terminalLifecycleEpochs:new WeakMap([[term,'physical-T']]),
  codexProvisionalSourceObservations:new Map([['T',observation]]),codexSessionDiscoveryIntents:new Map([['T',intent]]),
  codexWatchers:new Map([['T',discovery]]),codexTurnWatchers:new Map([['T',{sessionId:'source',sourceObservationLaunchId:'launch-T'}]]),
  codexLastRunCommandPayload:new Map([['T',{command:'codex-c',sessionId:'source',launchId:'launch-T',terminalToken:term,
   runSeq:1,lifecycleGeneration:'L1',startedAt:h.clock.now()}]]),
  codexLateMcpProofPending:new Map(),terminalProjects:new Map([['T','/fixture']]),
  conversationOwners:{current:()=>owner,noteInput(){}},getCodexWriterProofSnapshot:()=>control.writer,
  isCodexWriterUsableForMutation:()=>!!control.writer,resolveAiToolTypeForTab:()=>control.provider,
  getTerminalLifecycleGeneration:()=>c.terminals.get('T')===term?'L1':'L2',
  codexSessionIdFromDb:()=> 'source',getCodexResumeSourceLeaseForTab:()=>control.lease?{tabId:'T',sourceSessionId:'source',launchId:'launch-T'}:null,
  isCodexTuiEffectivelyReady:()=>control.ready,getCodexLiveInputControl:()=>null,
  hasCodexPromptOrTurnInFlight:()=>control.busy,
  captureAiProcessLookupScope:scope,aiProcessLookupScopeCurrent:(_tab,s)=>Object.keys(scope()).every(k=>scope()[k]===s[k]),
  AI_PROCESS_LOOKUP_STATUS:{FOUND:'found',ABSENT:'absent',UNKNOWN:'unknown'},
  inspectAiDescendantProcessesByTab:async()=>{await control.processRead?.();return {status:control.process,matches:control.process==='found'?[{pid:7}]:[]};},
  getCodexResumeReadIdentityLeaseForTab:()=>null,currentCodexAcceptedResumeSourceProof:()=>null,
  resolveAuthoritativeTabProjectId:()=> 'project-T',codexActionAuthorities:new Map(),codexActionAuthoritySeq:0,
  codexActionAuthorityTestWaiters:new Map(),codexActionAuthorityTestHoldEnabled:()=>false,
  CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT:'resumed-active-submit',
  validateAgentInputIdentity:undefined,
  captureCodexPromptAuditBoundary:()=>({sessionId:'source',offset:100}),
  captureCodexPtySubmitAdmission:(_id,_term,input)=>c.createCodexPtySubmitAdmission({processRunning:true,
   hasLiveCodexEvidence:true,runSeq:1,inputRevision:input}),
  revalidateCodexPtySubmitAdmission:token=>c.validateCodexPtySubmitAdmission(token,{processRunning:true,
   hasLiveCodexEvidence:true,runSeq:1,inputRevision:c.getTerminalInputRevision('T'),stopping:c.aiStoppingTabs.has('T')}),
  releaseCodexProvisionalSubmitReservation:(_tab,reservation)=>{if(discovery.provisionalSubmitReservation===reservation)discovery.provisionalSubmitReservation=null;},
  markCodexProvisionalSubmitReservationWritten:(_tab,reservation)=>{reservation.enterWritten=true;reservation.submitted=true;},
  finishCodexPasteAuditAfterWrite:async()=>({success:null,submitted:true,accepted:true,auditPending:true,status:'audit-pending'}),
  reconcileCodexWriterFromProcess:async()=>({status:'provisional-source',sessionId:'source',pids:[7]}),
 });
 const names=['captureAgentInputIdentity','validateAgentInputIdentity','validatePromptQueueImageMarkers','getCurrentCodexProvisionalSourceObservation',
  'getCodexSubmissionObservationContext','readAgentSendDestinationAtWriteBoundary','armCodexSubmissionObservationWithoutProof',
  'ensureCodexSubmissionWatcher','codexActionAuthorityKey','currentCodexActionAuthorityIdentity','publishCodexActionAuthorityState',
  'createMainCodexActionAuthority','transitionMainCodexActionAuthority','validateMainCodexActionAuthority',
  'readAgentContinuationInputAdmission','agentSendContinuationInputFailure'];
 vm.runInContext(names.map(n=>actual(n)).join('\n'),c);
 const rawDraft=c.getHeadlessCodexDraftState;
 c.getHeadlessCodexDraftState=(...args)=>control.frame?rawDraft(...args):{success:true,hasDraft:null,frameBlocker:'synchronized-output-open'};
 return {...h,c,control,discovery,intent,observation,owner,
  readAdmission:()=>c.readAgentContinuationInputAdmission('T',{toolType:'codex',sessionId:'source',cwd:'/fixture'}),
  actual,
  async write(request){return c.safePasteAndSubmit(term,request.prompt,{...h.opts,codexSubmissionPreflight:true,
   source:'codex-history-panel',handoffId:request.handoffId,sendOperationKey:request.sendOperationKey,sendAttemptId:request.sendAttemptId,
   expectedTarget:request.expectedTarget,expectedInputRevision:c.getTerminalInputRevision('T')});},
 };
}
module.exports={fixture,actual,drainMicrotasks};
