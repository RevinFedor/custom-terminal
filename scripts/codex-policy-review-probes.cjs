// Regression adapted from independent reviewer 3391a096 (six actual-source probes).
// Baseline mode must point to an immutable old corpus; default tests current source fixes.
'use strict';
// Isolated production-source probes. No Electron, PTY, provider, app DB or network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = process.env.CODEX_POLICY_PROBE_ROOT || path.resolve(__dirname, '..');
const expectBaseline = process.env.CODEX_POLICY_EXPECT_BASELINE === '1';
const contract = require(root + '/src/main/codex-runtime-contract.js');
const readinessLib = require(root + '/src/main/codex-tui-readiness.js');
const policyLib = require(root + '/src/main/codex-runtime-policies.js');
const liveLib = require(root + '/src/main/codex-live-settings.js');
const {createCodexSettingsSendRuntime} = require(root + '/src/main/codex-settings-send.js');
const ts = require('typescript');
const ranges = [];
const results = [];
function extract(file, start, end) {
  const text = fs.readFileSync(root + '/' + file, 'utf8');
  const a = text.indexOf(start); assert(a >= 0, start);
  const b = text.indexOf(end, a + start.length); assert(b > a, end);
  const code = text.slice(a, b);
  ranges.push({file, startLine:text.slice(0,a).split('\n').length, endLine:text.slice(0,b).split('\n').length-1, sha256:crypto.createHash('sha256').update(code).digest('hex')});
  return code;
}
const silentConsole = {log(){}, warn(){}, error(){}};
const ticks = async () => {for (let i=0;i<16;i++) await Promise.resolve();};
async function check(name, fn) {
  const evidence = await fn();
  results.push({name, evidence});
  process.stdout.write(JSON.stringify(results.at(-1))+'\n');
}
(async () => {
  await check('1 Resume task_started is publicly ready but real send caller times out without first composer', async () => {
    const tab='T'; const term={write(){throw Error('live writes forbidden');}};
    const handlers = new Map(); const timers = [];
    let pasteCalls=0;
    const publicState = contract.projectCodexPublicRuntimeProjection({liveLifecycle:true, turnBusy:true, tuiInputReady:false});
    assert.equal(publicState.inputReady,true); assert.equal(publicState.sessionStatus,'busy');
    const context = vm.createContext({
      console:silentConsole, nodePerformance:{now:()=>0}, Date,
      CODEX_EXTERNAL_PROMPT_READY_TIMEOUT_MS:90000,
      terminals:new Map([[tab,term]]), terminalCommandState:new Map([[tab,{isRunning:true,runSeq:1}]]),
      terminalProjectIds:new Map(), claudeLaunchGenerationByTab:new Map(), codexLastRunCommandPayload:new Map(),
      getTerminalLifecycleGeneration:()=> 'G',
      codexTuiReadyTabs:new Set(), codexLateMcpProofPending:new Set(), codexRuntimePolicies:null,
      getCodexLiveInputControl:()=>null,
      codexHasLivePtySubmitEvidence:()=>true, getTerminalInputRevision:()=>10,
      getCodexPublicRuntimeProjection:()=>publicState, aiStoppingTabs:new Map(),
      createCodexPtySubmitAdmission:contract.createCodexPtySubmitAdmission,
      validateCodexPtySubmitAdmission:contract.validateCodexPtySubmitAdmission,
      observeCurrentCodexStartupGoalFrame(){},codexManualActionRequired:new Map(),codexTuiReadyMeta:new Map(),codexLifecycleWarnings:new Map(),
      getCodexMcpStartupStatus:()=>null,codexTuiReadyLastNotReady:new Map(),getCodexStartupNoStateTimeout:()=>null,
      projectCodexPolicyRuntime:policyLib.projectCodexPolicyRuntime,
      probeCodexReadyFromVisibleBuffer:async()=>readinessLib.inspectCodexInputReadyTextCore('OpenAI Codex\nWorking\n›', '', {requireSyncMarker:false,requireInitializedComposer:true}),
      agentSendRequestTargetFailure:()=>null,CODEX_PASTE_AUDIT_TIMEOUT_MS:8000,
      codexStartupAutoEnter:new Map(), hasCodexEstablishedComposerLifecycle:()=>false,
      armCodexStartupAutoEnter(){}, getCodexRuntimeSessionId:()=> 'S', terminalProjects:new Map([[tab,'/fixture']]),
      probeCodexStartupFromRawBuffer:()=>({success:true,ready:false,reason:'no-composer-frame'}),
      markCodexTuiReadyFromRawProbe:async()=>false,
      setTimeout(fn,ms){const timer={fn,ms};timers.push(timer);return timer;},clearTimeout(){},
      ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){},removeListener(){}},
      isPromptQueueAutomationSource:()=>false,
      safePasteAndSubmit:async()=>{pasteCalls++;return {success:true};},
    });
    vm.runInContext(extract('src/main/main.js','function isCodexTuiEffectivelyReady(', '\nfunction observeCodexInputControlReadinessFrame'),context);
    vm.runInContext(extract('src/main/main.js','function captureAiProcessLookupScope(', '\nfunction invalidateAiProcessLookupCache'),context);
    vm.runInContext(extract('src/main/main.js','async function getCodexTuiReadyState(', '\nasync function markCodexTuiReadyAfterVerifiedComposer'),context);
    vm.runInContext(extract('src/main/main.js','async function ensureCodexInputReadyForExternalPrompt(', '\nfunction codexEventType'),context);
    vm.runInContext(extract('src/main/main.js',"ipcMain.handle('codex:send-command'", '\nasync function executeCodexSelectModelEffortRequest'),context);
    vm.runInContext(extract('src/main/main.js','function captureCodexPtySubmitAdmission(', '\nfunction captureClaudePromptQueuePtyAdmission'),context);
    let completed=false;
    const pending=handlers.get('codex:send-command')({sender:{}},tab,'fixture message',{queue:true,statusAtSend:'busy'}).then(v=>{completed=true;return v;});
    await ticks();
    if (expectBaseline) {
      assert.equal(completed,false); assert.equal(timers.length,1);
      await timers[0].fn(); const output=await pending;
      assert.equal(output.error,'codex_not_input_ready'); assert.equal(pasteCalls,0);
      const admission=context.captureCodexPtySubmitAdmission(tab,term,10);
      assert.equal(admission.available,false);
      return {expectBaseline,publicState,timerMs:timers[0].ms,output,pasteCalls,admission};
    }
    const output=await pending;
    assert.equal(output.success,true); assert.equal(pasteCalls,1); assert.equal(timers.length,0);
    const admission=context.captureCodexPtySubmitAdmission(tab,term,10);
    assert.equal(admission.available,true); assert.equal(context.revalidateCodexPtySubmitAdmission(admission).valid,true);
    const ready=await context.getCodexTuiReadyState(tab);
    assert.equal(ready.inputReady,true); assert.equal(ready.textReady,false); assert.equal(ready.operationalReady,true);
    // No active turn AND no initialized composer still waits and never writes.
    Object.assign(publicState,contract.projectCodexPublicRuntimeProjection({liveLifecycle:true,turnBusy:false,tuiInputReady:false}));
    const cold=handlers.get('codex:send-command')({sender:{}},tab,'fixture cold',{queue:false,statusAtSend:'starting'});
    await ticks(); assert.equal(timers.length,1); await timers[0].fn();
    const coldOutput=await cold; assert.equal(coldOutput.error,'codex_not_input_ready'); assert.equal(pasteCalls,1);
    assert.equal(context.captureCodexPtySubmitAdmission(tab,term,10).available,false);
    return {expectBaseline,output,pasteCalls,admission,ready,coldOutput};
  });
  await check('2 Same-process provider switch is hidden by remembered picker pair in settings+send', async () => {
    const term={};let scope={terminal:term,lifecycleGeneration:'G:1',runSeq:1,inputRevision:10,ownerId:'S',live:true,busy:false,settingsObservationKey:'A:100'};
    let pair={model:'gpt-6',effort:'high',ownerId:'S'};let reads=0;const selected=[];let pastes=0;
    const runtime=createCodexSettingsSendRuntime({readScope:()=>({...scope}),readSettings:async()=>{reads++;return {...pair};},
      withSettingsQueue:fn=>fn(),withWriteLock:(_term,fn)=>fn({active:true}),
      selectSettings:async(_sender,request)=>{selected.push({model:request.model,effort:request.effort});pair={model:request.model,effort:request.effort,ownerId:'S'};return {success:true,applied:true,...pair,applicationProofSource:'tui-model-ack'};},
      paste:async()=>{pastes++;return {success:true,submitted:true};}, sendLocalCommand:async()=>({success:true})});
    assert.equal(runtime.rememberApplied('T',{success:true,...pair,applicationProofSource:'tui-model-ack'},scope),true);
    // No keyboard input: native/provider policy changes the model in this run.
    pair={model:'gpt-reserve',effort:'high',ownerId:'S'}; scope.settingsObservationKey='B:150';
    const partial=await runtime.sendPrompt({tabId:'T',content:'fixture message',effort:'medium',pasteOptions:{}});
    assert.deepEqual(selected,[{model:expectBaseline?'gpt-6':'gpt-reserve',effort:'medium'}]); assert.equal(reads,expectBaseline?0:1);
    // A complete matching request on the busy fallback is also misclassified.
    pair={model:'gpt-reserve',effort:'high',ownerId:'S'};scope.busy=true;scope.settingsObservationKey='B:200';
    const queued=await runtime.sendPrompt({tabId:'T',content:'fixture queue',model:'gpt-reserve',effort:'high',queue:true,pasteOptions:{}});
    if(expectBaseline) assert.equal(queued.error,'codex_settings_change_requires_idle');
    else { assert.equal(queued.success,true); assert.equal(reads,2); assert.equal(pastes,2); }
    return {actualBefore:'gpt-reserve/high',requestedOnlyEffort:'medium',selected,reads,pastes,partial,queued};
  });
  await check('3 Process Stop publishes inactive HTTP snapshot with old live settings and PID', async () => {
    const http=vm.createContext({publicRuntimeSnapshots:new Map(),conversationOwners:null,
      fingerprintAgentSendRequest:JSON.stringify,Date});
    vm.runInContext(extract('src/main/web-server.js','function normalizePublicRuntimeStatus(', '\nconst orchestrationCompletionInflight'),http);
    const stamp=(tab,payload)=>http.stampPublicRuntimeSnapshot(tab,payload);
    const live={model:'gpt-reserve',effort:'high',ownerId:'S',proofAt:100};
    stamp('T',{coherent:true,type:'snapshot',sessionStatus:'busy',inputReady:true,toolType:'codex',commandType:'codex',sessionId:'S',lifecycleGeneration:'G:1',launchId:'L',processStatus:'found',processPid:123,terminalRunSeq:1,liveSettings:live,model:live.model,effort:live.effort});
    let emitted;let canonical;
    const context=vm.createContext({console:silentConsole,path,srcMainDir:'/fixture',
      terminalCommandState:new Map([['T',{isRunning:false,runSeq:1}]]),
      currentAiLifecycleIdentity:()=>({terminalLifecycleGeneration:'G:1',sessionId:null}),
      publishCodexRuntimeProjection:()=>{canonical={sessionStatus:'inactive',liveSettings:null,model:null,effort:null};return canonical;},
      require:()=>({webBroadcast:(_tab,payload)=>{emitted=stamp('T',payload);}}),
      scheduleProjectActivityBroadcast(){},getAiRuntimeSessionId:()=>null,
      projectManager:{db:{db:{prepare:()=>({get:()=>({project_id:'P',codex_session_id:'S'})})}}},
      getCodexWriterProofSnapshot:()=>null,isCodexWriterUsableForMutation:()=>false,
      codexLastRunCommandPayload:new Map(),codexConversationMaterializationCache:new Map(),scheduleProjectLayoutBroadcast(){},
    });
    vm.runInContext(extract('src/main/main.js','function _webBroadcast(', '\n// Event-driven hand-off'),context);
    vm.runInContext(extract('src/main/main.js','function broadcastAiRuntimeStatus(', '\nfunction restoreAiRuntimeStatusAfterFailedStop'),context);
    context.broadcastAiRuntimeStatus('T','codex','inactive','manual-stop');
    assert.equal(emitted.sessionStatus,'inactive');assert.equal(emitted.inputReady,false);
    if(expectBaseline) {
      assert.equal(emitted.model,'gpt-reserve');assert.equal(emitted.liveSettings.ownerId,'S');
      assert.equal(emitted.processStatus,'found');assert.equal(emitted.processPid,123);
    } else { assert.equal(emitted.model,null);assert.equal(emitted.liveSettings,null);
      assert.equal(emitted.processStatus,'absent');assert.equal(emitted.processPid,null);assert.equal(emitted.sessionId,'S');
      assert.equal(emitted.readSessionId,'S','process Stop preserves saved conversation read identity'); }
    return {canonical,wire:emitted};
  });
  await check('4 Older asynchronous native Ultra fallback publication overwrites a newer live observation', async () => {
    const {planCodexPickerStateApplication,projectCodexProvisionalSettingsOverlay,resolveCodexEffectiveSettings}=await import(root+'/src/renderer/utils/codexEffectiveSettings.mjs');
    const term={}; const owned={terminal:term,ownerId:'S',runSeq:1,lifecycleGeneration:'G:1',inputRevision:10};
    const tab={codexSessionId:'S',codexModel:'gpt-6',codexEffort:'high'};
    let dateNow=200;
    let state;
    const ui=vm.createContext({get:()=>state,set(){},saveTabs(){},console:silentConsole,
      Date:{now:()=>dateNow}, useWorkspaceStore:{getState:()=>state},
      planCodexPickerStateApplication,handleCodexModelEffortIntentDeferred(){}});
    const mutator=extract('src/renderer/store/useWorkspaceStore.ts','  updateCodexState: (tabId, state','\n  updateCodexLiveServiceTier:');
    vm.runInContext(ts.transpileModule('globalThis.mutators = {\n'+mutator+'\n};', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ui);
    state={openProjects:new Map([['P',{projectId:'P',tabs:new Map([['T',tab]])}]]),...ui.mutators};
    const handler=extract('src/renderer/App.tsx','    const handleCodexModelEffortIntentApplied =', '\n    const handleCodexLiveSettings =');
    vm.runInContext(ts.transpileModule(handler+'\nglobalThis.applyEvent=handleCodexModelEffortIntentApplied;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ui);
    const applied={success:true,applied:true,model:'gpt-6',effort:'ultra',applicationMode:'conversation-only',applicationProofSource:'tui-conversation-ack',codexSettingsProofSessionId:'S',proofAt:100};
    let resolveFallback;
    const fallback=new Promise(resolve=>{resolveFallback=resolve;});let publication;
    const context=vm.createContext({console:silentConsole,
      readCodexPersistentModelEffortProofForTab:()=>fallback,
      getCodexModelEffortIntentRecord:()=>({model:'gpt-6',effort:'ultra',revision:2,actionSequence:2,providerState:{}}),
      getCodexNativeSettingsIntentScope:()=>owned,codexNativeSettingsIntentTracker:{hasPending:()=>false},
      projectManager:{db:{db:{prepare:()=>({get:()=>({project_id:'P'})})},updateTabCodexSettings:()=>true}},
      mainWindow:{isDestroyed:()=>false,webContents:{send:(_channel,data)=>{publication=data;ui.applyEvent(null,data);}}},Date:{now:()=>dateNow},
    });
    vm.runInContext(extract('src/main/main.js','async function refreshCodexNativeConversationFallback(', '\nfunction retireCodexScopedModelEffortIntent'),context);
    const pending=context.refreshCodexNativeConversationFallback('T',{scope:owned},{revision:2,actionSequence:2,result:applied});
    // Main observes newer provider B while the persistent config read is pending.
    const observed={ownerId:'S',model:'gpt-reserve',effort:'high',proofAt:150,source:'committed-composer-footer'};
    const newPatch=projectCodexProvisionalSettingsOverlay({liveLifecycle:true,liveSettings:observed});
    ui.mutators.updateCodexLiveState('T',newPatch);assert.equal(tab.codexLiveModel,'gpt-reserve');
    resolveFallback({success:true,model:'gpt-6',effort:'high',codexSettingsProofSessionId:'S'});await pending;
    assert.equal(publication.result.proofAt,100);assert.equal(tab.codexLiveModel,expectBaseline?'gpt-6':'gpt-reserve');assert.equal(tab.codexLiveSettingsProofAt,expectBaseline?200:150);
    ui.mutators.updateCodexLiveState('T',newPatch);
    assert.equal(tab.codexLiveModel,expectBaseline?'gpt-6':'gpt-reserve');
    return {newObservation:observed,replayedProofAt:publication.result.proofAt,after:{...tab},effective:resolveCodexEffectiveSettings(tab),repeatNewObservationRejected:expectBaseline};
  });
  await check('5 Policy ownership replacement and handled are not delivery proof', async () => {
    const term={};let owner={terminal:term,lifecycleGeneration:'G:1',runSeq:1,live:true,inputRevision:10,ownerId:'S',turnId:'old'};
    const frames=[];const writes=[];const publications=[];const timers=[];
    const dialog={valid:true,seq:1,text:'Resume paused goal?\nGoal: fixture\n› 1. Resume goal\nMark it active and continue when idle\n2. Leave paused\nKeep it paused; use /goal resume later\nPress enter to confirm or esc to go back'};
    let currentFrame=dialog;
    const ctl=policyLib.createCodexRuntimePolicyController({capture:()=>({...owner}),readFrame:async()=>currentFrame,
      withWriteLock:async(_terminal,fn)=>fn({active:true}),sendKey:async(_tab,key)=>{writes.push(key);return {written:true};},
      readPolicy:()=>({resumeGoal:true}),isComposer:frame=>frame.text==='composer',stopAll:async()=>({success:true}),publish:(_tab,state)=>publications.push(state),
      setTimer:fn=>{const t={fn,unref(){}};timers.push(t);return t;},clearTimer(){}});
    ctl.observe('T',dialog);await ticks();assert.deepEqual(writes,['\r']);assert.equal(ctl.read('T').phase,'confirming');
    assert.equal(ctl.observeOperationalTurn('T','new'),true);assert.equal(ctl.read('T'),null);
    assert.equal(publications.some(p=>p.sent||p.submitted||p.deliveryStatus),false);
    // A delayed Stop must not target a replacement owner.
    owner={...owner,runSeq:2,lifecycleGeneration:'G:2'};
    let stopCalls=0;let captured=0;
    const stopResult=await policyLib.stopCodexPolicyTargets({tabIds:['T'],capture:()=>{captured++;return captured===1?{...owner}:{...owner,runSeq:3};},stop:async()=>{stopCalls++;return {success:true};}});
    assert.equal(stopCalls,0);assert.equal(stopResult.success,false);
    const obs=liveLib.createCodexLiveSettingsObserver({capture:()=>({...owner}),publish(){},now:()=>100});
    obs.observe('T',{valid:true,seq:1,text:'›\ngpt-6 high · Full Access'});assert.equal(obs.read('T').model,'gpt-6');
    owner={...owner,runSeq:3,lifecycleGeneration:'G:3'};assert.equal(obs.read('T'),null);
    return {writes,phases:publications.map(p=>p.phase),stopResult,stopCalls,replacementLiveProof:null};
  });
  await check('6 Native queue proof requires committed growth after Enter and preserves generation boundaries', async () => {
    const preview=require(process.env.CODEX_POLICY_QUEUE_PARSER || path.join(root, 'src/main/terminal-history-preview.js'));
    const promptAudit=require(root+'/src/main/codex-prompt-audit.js');
    const context=vm.createContext({module:{exports:{}},require:name=> {
      if(name==='crypto')return crypto;
      if(name==='./codex-prompt-audit')return promptAudit;
      if(name==='./terminal-history-preview')return preview;
      throw Error('Unexpected import '+name);
    }});
    vm.runInContext(fs.readFileSync(root+'/src/main/codex-queued-message-proof.js','utf8'),context);
    const queue=context.module.exports;
    const frame=(seq,children)=>({success:true,authoritativeFrameCommitted:true,mirrorGeneration:'M',committedFrameGeneration:seq,writeSeq:seq,
      lines:[{row:0,text:'Messages to be submitted after next tool call',hasDim:true},...children.map((text,index)=>({row:index+1,text:'  ↳ '+text,hasDim:true}))]});
    const audit={expectedText:'fixture message',queuedAtSubmit:true,submitWritten:true,enterRunSeq:1,enterLifecycleGeneration:'G:1',enterInputRevision:10};
    const baseline=queue.captureCodexQueuedMessageBaseline(frame(1,[]),audit);
    const identity={mirrorGeneration:'M',sameTerminal:true,runSeq:1,lifecycleGeneration:'G:1',inputRevision:10,writeQueueOwned:true};
    const snapshot=frame(2,['fixture message']);
    const accepted=queue.classifyCodexQueuedMessageFrame({baseline,snapshot,audit,identity});
    assert.equal(accepted.accepted,true);
    const preEnter=queue.classifyCodexQueuedMessageFrame({baseline,snapshot,audit:{...audit,submitWritten:false},identity});
    assert.equal(preEnter.accepted,false);
    const replacement=queue.classifyCodexQueuedMessageFrame({baseline,snapshot,audit,identity:{...identity,runSeq:2}});
    assert.equal(replacement.accepted,false);
    const repeatedBaseline=queue.captureCodexQueuedMessageBaseline(snapshot,audit);
    const noGrowth=queue.classifyCodexQueuedMessageFrame({baseline:repeatedBaseline,snapshot:frame(3,['fixture message']),audit,identity});
    assert.equal(noGrowth.accepted,false);
    const prefixAudit={...audit,expectedText:'fixture message hidden tail'};
    const prefix=queue.classifyCodexQueuedMessageFrame({baseline:queue.captureCodexQueuedMessageBaseline(frame(1,[]),prefixAudit),snapshot:frame(2,['fixture message…']),audit:prefixAudit,identity});
    assert.equal(prefix.accepted,true);assert.equal(prefix.reason,'codex_tui_queue_visible_prefix');
    return {accepted,preEnter,replacement,noGrowth,prefix,parserExtra:process.env.CODEX_POLICY_QUEUE_PARSER || path.join(root, 'src/main/terminal-history-preview.js')};
  });
  if(process.env.CODEX_POLICY_PROBE_OUTPUT) fs.writeFileSync(process.env.CODEX_POLICY_PROBE_OUTPUT,JSON.stringify({runtime:process.version,typescriptVersion:ts.version,root,expectBaseline,results,extractedRanges:ranges,loadedFrozenFiles:Object.keys(require.cache).filter(f=>f.startsWith(root))},null,2));
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
