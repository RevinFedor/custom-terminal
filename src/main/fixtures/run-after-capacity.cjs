'use strict';
// Finite Source fixture. Main observer, classifier, policy/runtime, publication
// and Web Continue factory are actual; physical delivery and OS are ports.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {createCodexCapacityRetryRuntime,classifyCodexCapacityRetryRecord}=require('../codex-capacity-retry-runtime');
const {reduceCodexCapacityRetry}=require('../codex-capacity-retry-policy');
const {classifyCodexTurnRecord}=require('../codex-turn-outcome');
const {TaskCompletionIntentRegistry,taskCompletionOutcomeMeta}=require('../task-completion-intent');
const {CODEX_MODEL_CAPACITY_MESSAGE}=require('../codex-model-capacity-state');
function declarations(source,names){
  const tree=ts.createSourceFile('actual.js',source,ts.ScriptTarget.Latest,true);
  return names.map(name=>{const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    if(!node)throw Error('missing actual declaration '+name);return node.getText(tree)}).join('\n');
}
const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),web=fs.readFileSync(path.join(__dirname,'../web-server.js'),'utf8');
const code='let codexCapacityRetryRuntime=null;const codexCapacityRetryOwners=new Map();const codexCapacityContinuations=new Map();\n'
  +declarations(main,['codexOutcomeTimestampMs','applyCodexWatcherAbnormalOutcome','applyCodexWatcherOutcome','codexTurnStateSnapshot','emitCodexBusy','setCodexLifecycleWarning','getCodexCapacityRetryRuntime','observeCodexCapacityRetryRecord'])
  +declarations(web,['coordinateCodexCapacityContinuation','sendCodexCapacityContinuation']);
module.exports=function producer({onBusy,phase='immediate',at=1000}){
  const settings={codexCapacityRetryEnabled:phase!=='disabled',codexCapacityRetryLimit:1,codexCapacityRetryDelaysMs:phase==='delayed'?[60000]:[]};
  const watcher={tabId:'T',sessionId:'S',processGeneration:'G',lifecycleGeneration:'G',currentTurnId:'A',busy:true,capacityRetryLiveAfterOffset:10};
  let persisted=['delayed','exhausted'].includes(phase)
    ?reduceCodexCapacityRetry(null,{type:'capacity',scopeKey:JSON.stringify(['T','S']),errorId:'PRIOR',at:11},settings).state:null;
  const terminal={},calls=[],warnings=new Map(),timers=new Map();let serial=0;
  const c=vm.createContext({path,srcMainDir:path.join(__dirname,'..'),classifyCodexCapacityRetryRecord,CODEX_MODEL_CAPACITY_MESSAGE,
    captureLoopInputBoundary:()=>null,
    createCodexCapacityRetryRuntime:options=>createCodexCapacityRetryRuntime({...options,now:()=>1000,
      setTimer:(fn,ms)=>{const key=++serial;timers.set(key,{fn,ms});return key},clearTimer:key=>timers.delete(key)}),
    codexTurnWatchers:new Map([['T',watcher]]),terminals:new Map([['T',terminal]]),getTerminalLifecycleGeneration:()=> 'G',aiStoppingTabs:new Map(),
    projectManager:{db:{getAppState:()=>persisted,setAppState:(_key,value)=>persisted=JSON.parse(JSON.stringify(value)),getAllProjects:()=>[{id:'P',tabs:[{tabId:'T',name:'private fixture'}]}]}},
    agentSendCancellations:{cancel:(...a)=>calls.push({kind:'cancel',args:a})},codexLifecycleWarnings:warnings,
    publishCodexLifecycleWarning(){},clearCodexLifecycleWarning:id=>warnings.delete(id),
    resolveAuthoritativeTabProjectId:()=> 'P',aiBoundaryTestGate:{enabled:true},ipcMain:{emit:()=>{throw Error('real notification forbidden')}},
    require:()=>bridge,getOrchestrationRunStore:()=>({listForTab:async()=>[]}),
    findOrchestrationTabDescriptor:()=>({tabId:'T',projectId:'P',toolType:'codex',sessionId:'S'}),
    runAgentSendScenario:async options=>{await options.prepareSend();calls.push({kind:'continue',options});
      if(phase==='not-submitted')return {success:false,submitted:false,code:'controlled-draft-guard'};
      if(phase==='unknown')return {success:null,submitted:null,deliveryUnknown:true};
      return {success:true,submitted:true};},
    settleCodexProviderActivityFromWatcherOutcome(){},workingDirectoryOperations:null,terminalHistoryPreviewController:{finish(){}},
    codexRuntimePolicies:null,taskCompletionIntents:new TaskCompletionIntentRegistry(),taskCompletionOutcomeMeta,
    replayDeferredCodexPromptAuditExecutionContext(){},discardDeferredCodexPromptAuditExecutionContexts(){},
    clearCodexMcpStartupWatchdog(){},recordActivity(){},shouldCreateHistoryResponseTiming:()=>false,
    getCodexPublicRuntimeProjection:()=>({inputReady:true,sessionStatus:'active'}),emitAgentReadinessChanged(){},
    getCodexRuntimeSessionId:()=> 'S',getCombinedTabBackgroundWorkCount:()=>0,getCodexPublicWriterFields:()=>({}),_webBroadcast(){},
    console:{log(){},warn(){}},mainWindow:{isDestroyed:()=>false,webContents:{send:(channel,value)=>{
      if(channel==='codex:busy-state')onBusy(value);else calls.push({kind:'notification',value});
    }}},
  });
  const bridge={getOrchestrationSettings:async()=>settings,
    coordinateCodexCapacityContinuation:(...a)=>c.coordinateCodexCapacityContinuation(...a),
    sendCodexCapacityContinuation:args=>c.sendCodexCapacityContinuation(args)};
  vm.runInContext(code,c);
  function record(payload,offset,time){
    const raw={type:'event_msg',__byteOffset:offset,timestamp:new Date(time).toISOString(),payload};
    c.observeCodexCapacityRetryRecord(watcher,raw,false);
    const outcome=classifyCodexTurnRecord(watcher,raw);
    if(outcome){watcher.busy=outcome.busy;c.emitCodexBusy('T',outcome.busy,outcome.reason,{outcome,timestamp:raw.timestamp,turnId:payload.turn_id})}
    return raw;
  }
  return {calls,watcher,settings,warnings,timers,context:c,
    start:()=>record({type:'task_started',turn_id:'A'},12,at-1),
    fail:()=>record({type:'task_complete',turn_id:'A',error:{message:CODEX_MODEL_CAPACITY_MESSAGE,codex_error_info:'server_overloaded'}},20,at),
    duplicate:raw=>c.observeCodexCapacityRetryRecord(watcher,raw,false),
    finish:()=>{record({type:'task_started',turn_id:'B'},30,at+10);record({type:'task_complete',turn_id:'B',last_agent_message:'confirmed continuation final'},40,at+20)},
    fireDelay:()=>{for(const [id,timer]of timers){timers.delete(id);timer.fn()}},
    state:()=>persisted,
  };
};
