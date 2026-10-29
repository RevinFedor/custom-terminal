'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),ts=require('typescript'),Module=require('node:module');
const assert=require('node:assert/strict');
const {fixture:mainFixture}=require('./continuation-first-input.cjs');
const {AgentSendQueue}=require('../agent-send-queue');
const registry=require('../agent-send-receipt-registry');
const {OrchestrationRunStore,classifyAgentSendReceipt}=require('../orchestration-runs');
const Database=require('better-sqlite3'),{createAgentSendReceiptStore}=require('../agent-send-receipt-store');
const {promptAuditFingerprint}=require('../prompt-audit-fingerprint');
const product=path.join(__dirname,'..');
function productModule(name,cache=new Map()){
 if(cache.has(name))return cache.get(name).exports;
 const source=fs.readFileSync(path.join(process.env.FIRST_CONTINUE_PRODUCT_ROOT||product,name+'.js'),'utf8');
 const filename=path.join(product,name+'.js'),mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;cache.set(name,mod);
 const load=mod.require.bind(mod);mod.require=id=>id==='./orchestration-continuation-input'?productModule('orchestration-continuation-input',cache):load(id);
 mod._compile(source,filename);return mod.exports;
}
function webDeclarations(names){const source=fs.readFileSync(path.join(process.env.FIRST_CONTINUE_PRODUCT_ROOT||product,'web-server.js'),'utf8');
 const ast=ts.createSourceFile('web.js',source,ts.ScriptTarget.Latest,true);return names.map(name=>{
 const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
 if(!n&&name==='prepareQueuedBuildContinueInput'){
  // Counterfactual PRE uses the exact older inline production callback,
  // not a hand-written approximation of its admission order.
  let callback;
  function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='prepareSend'
    &&node.initializer.getText(ast).includes('getBuildContinueOperations().admit(request)'))callback=node.initializer;
   ts.forEachChild(node,visit);}
  visit(ast);assert.ok(callback,'actual legacy Build prepareSend');
  return 'async function prepareQueuedBuildContinueInput(request,buildContinueId){return ('+callback.getText(ast)+')();}';
 }
 assert.ok(n,name);return n.getText(ast);}).join('\n');}
async function fixture(t,{agent=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-first-continue-'));
 const filename=path.join(root,'receipts.sqlite');
 const h=mainFixture(t,{receiptFilename:filename}),c=h.c;let store=h.store;
 let runs=new OrchestrationRunStore(path.join(root,'runs.json'));await runs.initialize();
 const old={provider:'codex',sessionId:'source',turnId:'captured-task',generation:1,processId:'old-7',startedAt:100};
 const next={...old,turnId:'continued-task',generation:2,processId:'7',startedAt:Date.now()+10000};
 const controls={queueReady:true,revision:'restored',parentRevision:'parent',parentSession:'parent-source',responseBusy:null,transitioning:true,background:0,goal:null,
  originalComplete:false,originalUnknown:false,latest:old,intervalUnknown:false,audit:true,loseAck:false,
  beforeOriginal:null,beforeLatest:null,beforeAdmit:null,beforePrepare:null,beforeBridge:null,returns:null};
 const calls={bridge:0,preparation:0,original:0,latest:0,requests:[],releases:0};
 const response=()=>({known:true,exists:true,toolType:h.control.provider,sessionId:'source',cwd:'/fixture',
  revision:JSON.stringify([controls.revision,controls.responseBusy,controls.transitioning,controls.background,controls.goal]),
  busy:controls.responseBusy,transitioning:controls.transitioning,processStatus:h.control.process,error:'response_busy_unknown',
  backgroundWorkCount:controls.background,...(controls.goal?{goalWork:controls.goal}:{}),
  ...(controls.responseBusy===true?{executionContext:next}:{})});
 const {createContinuationInputReader}=productModule('orchestration-continuation-input');
 const readState=createContinuationInputReader({readResponseState:async()=>response(),
  readInputAdmission:(tab,expected)=>c.readAgentContinuationInputAdmission(tab,expected),
  readRuntimeSnapshot:async()=>({coherent:true,toolType:'codex',processStatus:'found',status:'active',busy:false,inputReady:true,
   writerConfirmed:false,lifecycleGeneration:'L1',sendTarget:{toolType:'codex',sessionId:null,terminalInstanceId:'physical-T',launchId:'launch-T',lifecycleGeneration:'L1'}}),
  readSendDestination:(...args)=>c.readAgentSendDestinationAtWriteBoundary(...args)});
 const readOriginal=async()=>{calls.original++;await controls.beforeOriginal?.();return {found:!controls.originalUnknown,
  sourceVerified:!controls.originalUnknown,complete:controls.originalComplete,
  ...(controls.originalComplete?{terminalEvent:'task_complete'}:{}),userUuid:'original-user',executionContext:old};};
 const historyReader=productModule('agent-response-observation-reader').createAgentResponseObservationReader({
  captureState:()=>response(),readLifecycle:async()=>({processStatus:h.control.process,processName:h.control.provider,processPid:'7'}),
  readInputAdmission:(...args)=>c.readAgentContinuationInputAdmission(...args),
  readLatestCodexExecution:async()=>{calls.latest++;await controls.beforeLatest?.();return {success:true,
   sourceVerified:!controls.intervalUnknown,executionContext:{...controls.latest,generation:null,processId:null},
   userUuid:'original-user',errorCode:controls.intervalUnknown?'controlled-history-unknown':null};},
 });
 const readLatest=()=>historyReader.readAgentObservedResponse({tabId:'T',expectedSessionId:'source',purpose:'continuation-history',maxChars:500});
 const sendWithPreparation=(request,build=false)=>{
  const next={...request,prepareSend:async()=>{calls.preparation++;await controls.beforePrepare?.();return request.prepareSend?.();}};
  return build?c.sendBuild(next):c.runAgentSendScenario(next);
 };
 let saved,operation,queue,continuation;
 if(agent){await runs.create({runId:'R',sourceTabId:'parent',targetTabId:'T',sourceToolType:'codex',targetToolType:'codex',
  sourceSendTarget:{toolType:'codex',sessionId:'parent-source'},targetExecutionContext:old,targetCwd:'/fixture',promptHash:'original'});
  await runs.markDelivery('R',{sessionId:'source',lifecycleGeneration:'old-launch'});
  await runs.patch('R',{status:'running',targetPromptProofAt:100,targetPromptProofUserUuid:'original-user'});}
 const audit=record=>store.promoteFromAudit({success:true,operationKey:record.operationKey,attemptId:record.attemptId,provider:'codex',
  sessionId:'source',promptHash:record.promptHash,actualHash:record.promptHash,expectedHash:record.promptHash,
  entryUuid:'one-continue-user',sourceIdentity:'source-offset-100',auditTimestamp:new Date(next.startedAt).toISOString(),
  transcriptBoundary:{byteOffset:100},executionContext:next});
 Object.assign(c,{path,require:id=>require(id.startsWith('.')?path.resolve(product,id):id),srcMainDir:product,...registry,AGENT_SEND_RECEIPT_STATES:registry.RECEIPT_STATES,
  claudeLaunchGenerationByTab:new Map(),
  agentSendReceiptRegistry:registry.createAgentSendReceiptRegistry(),agentSendReceiptStartupReady:Promise.resolve(),
  agentSendBridgeTimeoutMs:1000,promptAuditFingerprint,classifyAgentSendReceipt,shortId:value=>value,loopDependencies:null,
  compactSendReceiptPresentation:require('../compact-send-settlement').compactSendReceiptPresentation,
  bindStructuredAuthoringPresentation:require('../structured-authoring').bindStructuredAuthoringPresentation,
  withPromptOriginPresentation:value=>value,tabWorkContext:null,
  findOrchestrationTabDescriptor:()=>({tabType:'terminal',projectId:'project-T',toolType:'codex',sessionId:'source',cwd:'/fixture'}),
  readAgentRuntimeSnapshot:async()=>({coherent:true,toolType:'codex',processStatus:'found',status:'active',liveLifecycle:true,
   inputReady:true,writerConfirmed:false,sendTarget:{toolType:'codex',sessionId:null,terminalInstanceId:'physical-T',launchId:'launch-T',lifecycleGeneration:'L1'}}),
  scenarioDestination:require('../agent-message-identity').scenarioDestination,
  isLocalSlashCommandPrompt:require('../agent-history-send-receipt').isLocalSlashCommandPrompt,
  agentSendTargetPreconditionFailure:require('../../shared/agent-send-target-precondition.cjs').agentSendTargetPreconditionFailure,
  bridgeRequest:async(action,request)=>{assert.equal(action,'sendAgentPromptScenario');calls.bridge++;calls.requests.push(request);
   await controls.beforeBridge?.(request);let result;try{result=await h.write(request);}catch(error){h.logs.push(error.stack||error.message);throw error;}
   if(result.submitted===true&&controls.audit){assert.equal(audit(store.get(request.sendOperationKey)).promoted,true);
    controls.responseBusy=true;controls.transitioning=false;controls.revision='continued';}
   if(controls.loseAck&&result.submitted===true)throw Object.assign(Error('controlled lost bridge ACK'),{dispatched:true});
   return result;},
 });
 vm.runInContext(webDeclarations(['COMPLETION_ADMISSION','BUILD_CONTINUE_ADMISSION','readScenarioDestination','durableRecordHasProviderQueueAcceptance',
  'durableAgentSendReplay','durableAgentSendFailure','runAgentSendScenario','runPreparedAgentSendScenario','wakeLoopDependencies',
  'prepareQueuedBuildContinueInput']),c);
 const make=pid=>productModule('build-continue-operation').createBuildContinueOperations({pid,instanceId:'instance-'+pid,now:h.clock.now,
  read:()=>fs.existsSync(path.join(root,'build.json'))?JSON.parse(fs.readFileSync(path.join(root,'build.json'),'utf8')):null,
  write:value=>{saved=JSON.parse(JSON.stringify(value));fs.writeFileSync(path.join(root,'build.json'),JSON.stringify(saved));},
  captureTabs:()=>[{tabId:'T',known:true,toolType:'codex',sessionId:'source',projectId:'project-T',cwd:'/fixture',busy:true,revision:'pre-cut',
   executionContext:old,subject:{kind:'codex-execution',targetExecutionContext:old}}],
  readRuns:()=>runs.installSnapshot(),readStartup:()=>({source:'exact-shutdown-snapshot',shutdownPid:11,capturedAt:1001,
   targets:[{tabId:'T',provider:'codex',sessionId:'source'}]}),readState,
  readInputFence:()=>({terminalInstanceId:c.terminalLifecycleEpochs.get(c.terminals.get('T')),stopRevision:c.getTerminalStopRevision('T')}),
  readOriginal,readLatest,readInputInterval:async()=>({known:false,reason:'controlled-unknown-interval'}),
  readReceipt:key=>store.get(key),readQueued:key=>queue?.item(key),readPrepared:()=>null,
  prepareReturns:async()=>{await controls.returns?.();return {ready:true};},
  getRun:id=>runs.getInternal(id),continueRun:(id,options)=>continuation.continueRequest(id,options),
  reconcileRunContinuation:id=>continuation.reconcile(id),
  released:()=>calls.releases++,send:request=>sendWithPreparation(request,true),
 });
 // The production private symbol is lexical; expose the normal internal
 // Build entry, not a forged caller boolean. No public endpoint is called.
 vm.runInContext('globalThis.sendBuild = request => runAgentSendScenario({...request,[BUILD_CONTINUE_ADMISSION]:true});',c);
 operation=make(11);await operation.capture('first-continue-operation',11);
 if(agent)await runs.beginRecovery('R','interrupted','turn_aborted');
 operation.dispose();operation=make(22);c.buildContinueOperations=operation;c.getBuildContinueOperations=()=>operation;
 continuation=productModule('orchestration-continuation').createOrchestrationContinuationService({store:runs,receipts:store,now:h.clock.now,readState:async id=>id==='parent'
  ?{known:true,exists:true,toolType:'codex',sessionId:controls.parentSession,revision:controls.parentRevision,busy:false,transitioning:false,processStatus:'found',backgroundWorkCount:0}:readState(id),
  readOriginal,readLatest,readRestartHistoryProof:request=>operation.restartHistoryForRun(request),
  readInfo:async()=>({sessionId:'source',lifecycleGeneration:'L1'}),send:request=>sendWithPreparation(request),
  reconcile:async()=>{},deliver:async()=>{},log:{warn(){}}});
 const openQueue=()=>new AgentSendQueue({store,ready:()=>controls.queueReady,now:h.clock.now,
  setTimer:h.clock.setTimer,clearTimer:h.clock.clearTimer,
  admit:async request=>{await controls.beforeAdmit?.();
   if(String(request.source||'').startsWith('build-install-continue:'))return operation.admit(request);
   try{await continuation.prepareRequest('R',(await runs.getInternal('R')).continuationIntent.operationId);return true;}
   catch(error){if(/runtime_unknown|target_not_idle|state_changed/.test(error.message))return false;throw error;}},
  execute:async(request,scope)=>c.runPreparedAgentSendScenario({...request,applicationQueueExecution:true,sendRequestFingerprint:scope.requestFingerprint,
   prepareSend:async()=>{calls.preparation++;await controls.beforePrepare?.();
    return String(request.source||'').startsWith('build-install-continue:')?c.prepareQueuedBuildContinueInput(request,'first-continue-operation')
     :continuation.prepareRequest('R',(await runs.getInternal('R')).continuationIntent.operationId);}})});
 queue=openQueue();
 c.agentSendQueue=queue;
 t.after(async()=>{operation.dispose();queue.dispose();await runs.flush();if(store.db.open)store.db.close();fs.rmSync(root,{recursive:true,force:true});});
 return {...h,controls,calls,old,next,get queue(){return queue;},get runs(){return runs;},get store(){return store;},readState,readLatest,audit,get operation(){return operation;},get continuation(){return continuation;},
  activate:async()=>{operation.activate('first-continue-operation');await operation.reconcile('first-continue-operation');
   for(let i=0;i<16;i++)await new Promise(resolve=>setImmediate(resolve));
   if(agent)await continuation.reconcile('R'); // Controlled delivery of the real receipt owner's audit event.
   await operation.reconcile('first-continue-operation');},
  target:()=>operation.get('first-continue-operation').targets[0],
  rawResponse:response,
  async readinessEvent(){c.wakeLoopDependencies('T');for(let i=0;i<16;i++)await new Promise(resolve=>setImmediate(resolve));
   if(agent)await continuation.reconcile('R');await operation.reconcile('first-continue-operation');},
  async reopen(){operation.dispose();queue.dispose();await runs.flush();store.db.close();
   runs=new OrchestrationRunStore(path.join(root,'runs.json'));await runs.initialize();
   store=createAgentSendReceiptStore(new Database(filename));c.agentSendReceiptStore=store;
   queue=openQueue();c.agentSendQueue=queue;store.reconcileStartup();
   operation=make(33);c.buildContinueOperations=operation;
   // The pending run's existing service reads this same receipt owner; its
   // replacement below retains original run IDs and return recipient.
   if(agent)continuation=productModule('orchestration-continuation').createOrchestrationContinuationService({store:runs,receipts:store,now:h.clock.now,
    readState:async id=>id==='parent'?{known:true,exists:true,toolType:'codex',sessionId:'parent-source',revision:'parent',busy:false,processStatus:'found'}:readState(id),
    readOriginal,readLatest,readInfo:async()=>({sessionId:'source',lifecycleGeneration:'L1'}),
    readRestartHistoryProof:request=>operation.restartHistoryForRun(request),send:request=>sendWithPreparation(request),
    reconcile:async()=>{},deliver:async()=>{},log:{warn(){}}});
   operation.restore();await operation.reconcile('first-continue-operation');
   for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  },
  record:()=>store.get(operation.get('first-continue-operation').targets[0].operationKey),
 };
}
module.exports={fixture,productModule};
