import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const test = (name, ...args) => {
  if (!process.env.RUN_AFTER_CAPACITY_CORE_ONLY || /^(incident:|capacity surface is)/.test(name)) return nodeTest(name, ...args);
};
const actualCapacityProducer = require('../../main/fixtures/run-after-capacity.cjs');
const renderer = path.resolve(import.meta.dirname, '..');
const runnerPath = path.join(renderer, 'hooks/usePromptQueueRunner.ts');
const preimage = process.env.RUN_AFTER_SOURCE_PREIMAGE;
const runnerSource = fs.readFileSync(preimage ? path.join(preimage, 'usePromptQueueRunner.ts') : runnerPath, 'utf8');
const tree = ts.createSourceFile('runner.ts', runnerSource, ts.ScriptTarget.Latest, true);
function declaration(name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) found = 'const ' + node.getText(tree) + ';';
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(found, name); return found;
}
const controlled = {
  useWorkspaceStore: 'export const useWorkspaceStore={getState:()=>ports.workspace,subscribe:fn=>{ports.workspaceListeners.add(fn);return()=>ports.workspaceListeners.delete(fn)}};',
  useUIStore: 'export const useUIStore={getState:()=>ports.ui};',
  useOrchestrationStore: `export const useOrchestrationStore={getState:()=>({initialized:true,activeRuns:new Map()}),subscribe:()=>()=>{}};
    export const initializeOrchestrationStore=async()=>{};
    export const isOrchestrationCompletionBlocked=id=>ports.workHolds.has(id);
    export const isLoopOrchestrationBlocked=id=>ports.workHolds.has(id);
    export const subscribeOrchestrationRunChanges=()=>()=>{};`,
  historyAgentRuntimes: 'export const getHistoryAgentRuntime=id=>({toolType:"codex",getPresence:async()=>ports.presence(id)});',
  agentSendPreparation: `export const prepareAgentRuntimeForSend=async o=>{o.assertAdmissionCurrent?.();return {status:'active',submitCapability:'direct',presence:await ports.presence(o.tabId)}};
    export const createAgentReadyWait=()=>({wait:async()=>{}});
    export const proveAgentComposerForSend=async()=>({complete:false});
    export const prepareAgentRecordContext=async()=>({restartPerformed:false,historyContextResult:null});`,
  tabWorkContext: `export const prepareTabWorkContext=async(_t,_p,prompt)=>({prompt,prefix:''});
    export const settleTabWorkContext=async()=>{};export const activateTabWorkContext=async()=>{};`,
  historyRewriteRewind: 'export const executeHistoryRewriteRewindScenario=async()=>{};export class HistoryRewriteRewindError extends Error {}',
  claudePtyActions: 'export const applyClaudePtySettings=async()=>({success:true});',
};
const built = await esbuild.build({ stdin: { contents: `export * from './store/usePromptQueueStore';export * from './hooks/usePromptQueueRunner';`, resolveDir: renderer, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
  plugins: [{ name: 'explicit-controlled-os-provider-ports', setup(build) {
    build.onLoad({ filter: /\.(ts|tsx)$/ }, args => {
      const name = path.basename(args.path).replace(/\.tsx?$/, '');
      if (controlled[name]) return { contents: controlled[name], loader: 'ts' };
      if (args.path === runnerPath) return { loader: 'ts', contents: runnerSource + `
        export { applyAbnormalQueueOutcome, beginConditionAwareQueueSend, beginValidatedQueueSend, handleQueueAgentStopping };
        export const capacityTestBlocked=(id,item,kind)=>isTabWorkflowBlocked(id,item,kind);
        export const capacityTestPending=()=>queueSendInflight.size+queueConditionChecks.size;
        export const capacityTestRestore=value=>workflowRestoreReconciled=value;
        export const capacityTestCoordinator=value=>autoCompactCoordinator=value;
        export const capacityTestShutdown=value=>queueShutdownPending=value;
        export const capacityTestBusy=id=>prevBusyRef.get(id);
        export const capacityTestInit=async()=>{await initializeLoopDependencies();await initializeMessageLoopWaits();};
        export function capacityTestLive(channel='codex') {
          const coordinator={intercept:()=>false,wake(){},cancel(){}};
          ${['findOwnersWaitingOn','fireQueueOwner','fireLoopOwner','getReadyTriggerForOwner','releaseDeferredPivotOwners','processSuccessfulWorkflowOutcome','handleBusyState','applyCodexTurnStateSnapshot'].map(declaration).join('\n')}
          ${declaration('continuationReleaseListener')}
          continuationReleaseListeners.add(continuationReleaseListener);
          const handler=handleBusyState(channel);
          return {handler,snapshot:applyCodexTurnStateSnapshot,success:processSuccessfulWorkflowOutcome};
        }
        export function capacityTestScheduler() {
          let firing=false;const pendingTimers=new Map();
          ${['clearTimer','fireHead','scheduleFirstDelayTimer','startFirstDelayCountdown','verifyCodexTriggerIdleThenFire','evaluateQueues'].map(declaration).join('\n')}
          return {evaluate:()=>{const s=usePromptQueueStore.getState();evaluateQueues(s,s,{forceRuntimeArms:true,forceAppRestartTriggers:true})},deadline:scheduleFirstDelayTimer,
            subscribe:()=>{${declaration('unsubscribeQueue')}return unsubscribeQueue;}};
        }
      ` };
    });
  } }] });
const bundle = built.outputFiles[0].text;
const turns = async () => { for (let i=0;i<140;i++) await Promise.resolve(); };

async function fixture(t, persisted = null) {
  const events=new EventEmitter(), timers=new Map(), sends=[], stops=[], toasts=[], writes=[], cancels=[], workspaceListeners=new Set();
  let serial=0, delivery={success:true,submitted:true}, receipts=[], current={sessionId:'S',lifecycleGeneration:'G',turnId:'A'}, snapshot={hasWatcher:true,busy:false,outcomeKnown:true};
  const tabs=new Map(['T','B','P'].map(id=>[id,{id,tabType:'terminal',commandType:'codex',codexSessionId:id==='T'?'S':id+'-S',cwd:'/controlled-fixture'}]));
  const ports={workspaceListeners,workHolds:new Set(),
    workspace:{isRestoring:false,openProjects:new Map([['project',{projectPath:'/controlled-fixture',tabs}]])},
    ui:{showToast:(...a)=>toasts.push(a),codexSettings:{models:[]},claudeCodeSettings:{models:[]}},
    presence:async id=>({status:'active',isBusy:false,inputReady:true,sessionId:tabs.get(id)?.codexSessionId}),
  };
  const ipc={on:(...a)=>events.on(...a),removeListener:(...a)=>events.removeListener(...a),sendSync(){},
    invoke:async(channel,input)=>{
      if(channel==='app:getState') return input==='promptQueueByTab'&&persisted?JSON.stringify(persisted):null;
      if(channel==='app:setState'){writes.push(input);return {success:true}};
      if(channel==='ai-prompts:get')return {success:true,data:[]};
      if(channel==='loop-dependencies:list'||channel==='message-loop-waits:list')return {version:1,known:true,revision:1,entries:[]};
      if(channel==='agent:join-automatic-send')return {found:false};
      if(channel==='agent:begin-launch-intent')return {success:true,protocolVersion:1,launchIntent:{...input,token:'fixture-'+serial,launchFence:{terminalInstanceId:'terminal',stopRevision:0}}};
      if(channel==='agent:finish-launch-intent')return {success:true};
      if(channel==='agent:inspect-launch-intent')return {success:false,protocolVersion:1,launchIntent:input.launchIntent,joined:false};
      if(channel==='agent:cancel-launch-intent')return {success:true};
      if(channel==='agent:enqueue-prompt'){sends.push(input);return ports.enqueue?ports.enqueue(input):delivery};
      if(channel==='agent:cancel-send'){cancels.push(input);return {cancelled:false}};
      if(channel==='agent:list-send-receipts')return {success:true,records:receipts};
      if(channel==='codex:get-turn-state')return snapshot;
      if(channel==='tab:get-context-pct')return {exact:true,provider:input.provider,sessionId:input.sessionId,pct:90};
      if(channel==='prompt-queue:materialize-image-refs')return {refs:input.refs};
      if(channel==='terminal:stop-ai-process'){stops.push(input);return {success:true}};
      throw new Error('unexpected controlled IPC '+channel);
    }};
  const module={exports:{}};
  const c=vm.createContext({module,exports:module.exports,require,ports,process,Date,Buffer,AbortController,structuredClone,queueMicrotask,
    console:{log(){},warn(){},error(){}},crypto:{randomUUID:()=>`capacity-private-${++serial}`},
    window:{require:name=>name==='node:crypto'?require(name):({ipcRenderer:ipc}),addEventListener(){},removeEventListener(){}},document:{},
    setTimeout:fn=>{const id=Symbol();timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(bundle,c);
  const a=module.exports;
  await a.hydratePromptQueueStore();a.capacityTestRestore(true);
  const store=()=>a.usePromptQueueStore.getState(), queue=id=>store().getQueue(id||'T');
  let id;
  if(!persisted){id=store().addPrompt('T','USER CARD',0);store().setAutoRun('T',true)}else id=queue().items[0]?.id;
  const live=a.capacityTestLive(), scheduler=a.capacityTestScheduler();
  const at=()=>Math.max(Date.now()+100,Number(queue().workflowArmedAt||0)+100);
  const emit=(busy,reason,patch={})=>live.handler(null,{tabId:'T',busy,reason,...current,outcomeTs:at(),...patch});
  t.after(()=>timers.clear());
  return {a,c,ports,tabs,store,queue,id,sends,stops,toasts,writes,cancels,timers,live,scheduler,at,emit,
    current:value=>{current={...current,...value};tabs.get('T').codexSessionId=current.sessionId},
    snapshot:value=>snapshot=value,result:value=>delivery=value,
    receipt:value=>receipts=[value],
    drain:async()=>{await turns();assert.equal(a.capacityTestPending(),0,'selected async send boundaries settled')},
    serialized:()=>JSON.parse(JSON.stringify(Object.fromEntries(store().queues))),
  };
}

test('incident: actual model_capacity consumer preserves one authored card and ON, then exactly one next step',async t=>{
  const f=await fixture(t), before=f.queue();
  f.emit(true,'task_started');
  const failedAt=f.at();f.emit(false,'model_capacity',{outcomeTs:failedAt});
  assert.equal(f.queue(),before,'capacity must not rewrite authoring/arm');
  assert.equal(f.queue().autoRun,true);assert.equal(f.queue().items[0].id,f.id);
  assert.equal(f.sends.length,0);assert.equal(f.stops.length,0);assert.equal(f.toasts.length,0);
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started',{outcomeTs:failedAt+1});
  f.emit(false,'task_complete',{outcomeTs:failedAt+2});await f.drain();
  assert.equal(f.sends.length,1);assert.equal(f.queue().items.length,0);
  f.emit(false,'task_complete',{outcomeTs:failedAt+2});await f.drain();assert.equal(f.sends.length,1);
});

test('capacity surface is non-turn: no disarm, no busy-edge poisoning, no next input',async t=>{
  const f=await fixture(t), before=f.queue();f.emit(true,'task_started');
  f.emit(false,'model_capacity',{capacitySurfaceOnly:true});
  assert.equal(f.queue(),before);assert.equal(f.a.capacityTestBusy('T'),true);
  assert.equal(f.sends.length,0);assert.equal(f.toasts.length,0);
});

for(const phase of ['immediate','delayed','disabled','exhausted','not-submitted','unknown'])
test('renderer capacity wait stays unchanged for recovery disposition '+phase+' without claiming Send authority',async t=>{
  const f=await fixture(t);f.store().setLoopPromptEnabled('T',true);
  const before=f.queue(), failedAt=f.at();
  f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:failedAt,recoveryDisposition:phase});
  f.emit(false,'model_capacity',{outcomeTs:failedAt});
  f.scheduler.evaluate();await f.drain();
  assert.equal(f.queue(),before);assert.equal(f.queue().loopPromptEnabled,true);
  assert.equal(f.sends.length,0);assert.equal(f.stops.length,0);assert.equal(f.toasts.length,0);
  assert.equal(f.a.capacityTestBlocked('T'),true,'known idle/due/receipt is not post-capacity natural completion');
});

test('elapsed deadline is retained across capacity, then the original item advances once after natural proof',async t=>{
  const f=await fixture(t), q=f.queue();
  f.a.usePromptQueueStore.setState({queues:new Map(f.store().queues).set('T',{...q,firstDelayCountdownAt:Date.now()-1000,firstDelaySeconds:0})});
  const original=f.queue().firstDelayCountdownAt, at=f.at();
  f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.scheduler.deadline('T');await f.drain();
  assert.equal(f.queue().firstDelayCountdownAt,original);assert.equal(f.sends.length,0);
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:at+10});
  f.scheduler.deadline('T');await f.drain();assert.equal(f.sends.length,1);
});

test('late error replay after a newer exact natural final cannot poison the next card',async t=>{
  const f=await fixture(t), at=f.at();f.store().addPrompt('T','SECOND CARD',0);
  f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:at+10});await f.drain();
  assert.equal(f.sends.length,1);
  f.emit(false,'model_capacity',{turnId:'A',outcomeTs:at});
  assert.equal(f.queue().autoRun,true);assert.equal(f.a.capacityTestBlocked('T'),false);
  assert.equal(f.queue().items.length,1);assert.equal(f.sends.length,1);
});

for(const patch of [
  {turnId:'A',outcomeTs:0}, {turnId:'CONTINUE',outcomeTs:0},
  {sessionId:'OLD',turnId:'CONTINUE'}, {lifecycleGeneration:'OLD',turnId:'CONTINUE'},
  {turnId:null}, {outcomeTs:null,turnId:'CONTINUE'},
]) test('stale/partial final does not release a protected capacity wait '+JSON.stringify(patch),async t=>{
  const f=await fixture(t), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.emit(false,'task_complete',{outcomeTs:at+10,...patch});await f.drain();
  assert.equal(f.sends.length,0);assert.equal(f.queue().autoRun,true);assert.equal(f.queue().items.length,1);
});

test('Pause is never undone by the continuation final',async t=>{
  const f=await fixture(t), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.store().setAutoRun('T',false);f.store().setLoopPromptEnabled('T',false);
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:at+10});await f.drain();
  assert.equal(f.queue().autoRun,false);assert.equal(f.queue().loopPromptEnabled,false);assert.equal(f.sends.length,0);
});

test('a newer explicit arm survives stale capacity replay and cannot consume an older restored natural outcome',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=await fixture(t);f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:1000001});
  t.mock.timers.tick(20);f.store().setAutoRun('T',false);f.store().setAutoRun('T',true);
  const armed=f.queue();
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy:false,currentTurnId:'B',
    lastAbnormalOutcomeReason:'model_capacity',lastAbnormalOutcomeTurnId:'A',lastAbnormalOutcomeTs:1000001,
    outcomeKnown:true,lastOutcomeReason:'task_complete',lastOutcomeTurnId:'B',lastOutcomeTs:1000002},'old-restored-final');
  await f.drain();assert.equal(f.queue(),armed);assert.equal(f.sends.length,0);
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy:false,currentTurnId:'C',
    outcomeKnown:true,lastOutcomeReason:'task_complete',lastOutcomeTurnId:'C',lastOutcomeTs:1000030},'new-current-final');
  await f.drain();assert.equal(f.sends.length,1);
});

test('absence of a Main timestamp cannot be replaced by renderer wall time to release capacity',async t=>{
  const f=await fixture(t), at=Date.now()-10000;f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:null});await f.drain();
  assert.equal(f.sends.length,0);assert.equal(f.queue().autoRun,true);assert.equal(f.a.capacityTestBlocked('T'),true);
});

test('ordered native start/final, not a millisecond delay, proves a same-timestamp continuation',async t=>{
  const f=await fixture(t), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started',{outcomeTs:at});f.emit(false,'task_complete',{outcomeTs:at});await f.drain();
  assert.equal(f.sends.length,1);
});

test('fresh Main current-turn snapshot proves same-timestamp continuation after renderer reload',async t=>{
  const f=await fixture(t), at=f.at();
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy:false,currentTurnId:'B',
    lastAbnormalOutcomeReason:'model_capacity',lastAbnormalOutcomeTurnId:'A',lastAbnormalOutcomeTs:at,
    outcomeKnown:true,lastOutcomeReason:'task_complete',lastOutcomeTurnId:'B',lastOutcomeTs:at},'fresh-main');
  await f.drain();assert.equal(f.sends.length,1);
});

test('typed current failure is not hidden by the older presentation-only abnormal cache',async t=>{
  const f=await fixture(t), at=f.at();
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy:false,currentTurnId:'B',
    lastAbnormalOutcomeReason:'model_capacity',lastAbnormalOutcomeTurnId:'A',lastAbnormalOutcomeTs:at+10,lastAbnormalOutcomeCapacitySurfaceOnly:true,
    outcomeKnown:true,lastOutcomeReason:'provider_error',lastOutcomeTurnId:'B',lastOutcomeTs:at},'typed-error');
  await f.drain();assert.equal(f.queue().autoRun,false);assert.equal(f.toasts.length,1);assert.equal(f.sends.length,0);
});

test('the special capacity policy does not turn a Claude failure into a recoverable result',async t=>{
  const f=await fixture(t), tab=f.tabs.get('T');tab.commandType='claude';tab.codexSessionId=null;tab.claudeSessionId='CLAUDE';
  const live=f.a.capacityTestLive('claude');
  live.handler(null,{tabId:'T',busy:true});live.handler(null,{tabId:'T',busy:false,reason:'model_capacity',outcomeTs:f.at()});
  await f.drain();assert.equal(f.queue().autoRun,false);assert.equal(f.toasts.length,1);assert.equal(f.sends.length,0);
});

test('a later genuine failure or explicit manual Stop is not swallowed by a capacity wait',async t=>{
  for(const reason of ['provider_error','watchdog','manual-stop']){
    const f=await fixture(t);f.emit(true,'task_started');f.emit(false,'model_capacity');
    f.live.handler(null,{tabId:'T',busy:false,reason,outcomeTs:f.at()+10});await f.drain();
    assert.equal(f.queue().autoRun,reason==='manual-stop');assert.equal(f.sends.length,0);
    assert.equal(f.toasts.length,reason==='manual-stop'?0:1);
  }
});

for(const attempted of [false,true]) test('passive same-operation receipt reconciliation retains capacity card and distinguishes attempt='+attempted,async t=>{
  const f=await fixture(t), at=f.at(), pending={version:1,kind:'queue',itemId:f.id,handoffId:'H',baseHandoffId:'BASE',operationKey:'history:T:H',
    triggerTabId:'T',triggerKey:'null',conditionKey:'-',causeKey:null,createdAt:at};
  f.store().setPendingDelivery('T',pending);
  f.receipt({tabId:'T',handoffId:'H',operationKey:'history:T:H',state:'reserved',attemptId:attempted?'A':null,
    receipt:attempted?{submitted:null,deliveryUnknown:true}:{},applicationQueue:{state:'recovery-deferred',capacityRecovery:{version:1,kind:'model-capacity',
      tabId:'T',handoffId:'H',operationKey:'history:T:H',sessionId:'S',lifecycleGeneration:'G',failedTurnId:'A',failedAt:at,requestHash:'immutable-hash'}}});
  f.emit(false,'model_capacity',{outcomeTs:at});
  assert.equal(await f.a.reconcilePromptQueuePendingDelivery('T'),!attempted);
  assert.equal(f.queue().autoRun,true);assert.equal(f.queue().items[0].id,f.id);assert.equal(f.sends.length,0);
  assert.equal(!!f.queue().pendingDelivery,attempted);
});

for(const kind of ['queue','loop']) test('exact Continue final before the old deferred Send ACK is retained and advances '+kind+' once',async t=>{
  const f=await fixture(t);await f.a.capacityTestInit();
  let release;f.ports.enqueue=()=>new Promise(r=>release=r);
  if(kind==='loop'){
    f.store().removePrompt('T',f.id);f.store().setLoopPromptEnabled('T',true);
    f.current({turnId:'ORIGINAL'});f.emit(true,'task_started');f.emit(false,'task_complete');
  }else f.a.beginConditionAwareQueueSend('T','T',f.queue().items[0],'cold-start');
  await turns();assert.equal(f.sends.length,1);assert.equal(typeof release,'function');
  const at=f.at()+100;f.current({turnId:'FAILED'});f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:at+10});
  await turns();assert.equal(f.sends.length,1,'no second request while the no-input disposition is unconfirmed');
  f.ports.enqueue=null;release({success:false,submitted:false,pasteWritten:false,enterWritten:false,deferred:true,status:'not-submitted',code:'run_after_capacity_wait'});
  await f.drain();
  assert.equal(f.sends.length,2,'one old proven-unwritten request plus exactly one eligible request');
  if(kind==='queue')assert.equal(f.queue().items.length,0);
  else {assert.equal(f.queue().loopPromptEnabled,true);assert.notEqual(f.sends[1].handoffId,f.sends[0].handoffId);assert.match(f.sends[1].handoffId,/CONTINUE/);}
});

test('a new exact Main owner retires only the old wait; its own natural final owns the next step',async t=>{
  const f=await fixture(t), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.current({sessionId:'NEW',lifecycleGeneration:'NEW-G',turnId:'NEW-TURN'});
  f.emit(true,'task_started',{outcomeTs:at+1});
  f.emit(false,'task_complete',{sessionId:'S',lifecycleGeneration:'G',turnId:'LATE',outcomeTs:at+2});
  await f.drain();
  assert.equal(f.sends.length,0);
  f.emit(true,'task_started',{outcomeTs:at+3});f.emit(false,'task_complete',{outcomeTs:at+4});await f.drain();
  assert.equal(f.sends.length,1);
});

for(const mode of ['all-work','own-turn']) test('Loop '+mode+' stays ON through capacity and fires once on the continuation, never on the error',async t=>{
  const f=await fixture(t);await f.a.capacityTestInit();f.store().removePrompt('T',f.id);
  f.store().setLoopPromptEnabled('T',true,mode);
  const before=f.queue(), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  assert.equal(f.queue(),before);assert.equal(f.sends.length,0);
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:at+10});await f.drain();
  assert.equal(f.queue().loopPromptEnabled,true);assert.equal(f.sends.length,1);
});

test('external onTab survives capacity and consumes only the next successful target outcome',async t=>{
  const f=await fixture(t);f.store().setAutoRun('T',false);
  const id=f.store().addPrompt('B','AFTER T',0);f.store().setRunAfterTab('B','T');
  const before=f.queue('B'), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  assert.equal(f.queue('B'),before);assert.equal(f.sends.length,0);
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');f.emit(false,'task_complete',{outcomeTs:at+10});await f.drain();
  assert.equal(f.sends.length,1);assert.equal(f.sends[0].tabId,'B');assert.equal(f.queue('B').items.some(x=>x.id===id),false);
});

for(const busy of [false,true]) test('actual restored snapshot preserves historical capacity while current continuation busy='+busy,async t=>{
  const first=await fixture(t), saved=first.serialized();const f=await fixture(t,saved), at=Date.now()+100;
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy,
    lastAbnormalOutcomeReason:'model_capacity',lastAbnormalOutcomeTurnId:'A',lastAbnormalOutcomeTs:at,
    outcomeKnown:!busy,lastOutcomeReason:busy?null:'model_capacity',lastOutcomeTurnId:'A',lastOutcomeTs:at},'restore');
  assert.equal(f.queue().autoRun,true);assert.equal(f.queue().items[0].id,first.id);
  f.scheduler.evaluate();await f.drain();assert.equal(f.sends.length,0);
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy:false,
    lastAbnormalOutcomeReason:'model_capacity',lastAbnormalOutcomeTurnId:'A',lastAbnormalOutcomeTs:at,
    outcomeKnown:true,lastOutcomeReason:'task_complete',lastOutcomeTurnId:'CONTINUE',lastOutcomeTs:at+20},'restore');
  await f.drain();assert.equal(f.sends.length,1);
});

test('native Goal and inherited/FIFO/install work retain their existing independent gates',async t=>{
  const f=await fixture(t), at=f.at();f.emit(true,'task_started');f.emit(false,'model_capacity',{outcomeTs:at});
  f.current({turnId:'CONTINUE'});f.emit(true,'task_started');
  f.tabs.get('T').codexGoalWork={version:1,pending:true,status:'active'};
  f.emit(false,'task_complete',{outcomeTs:at+10,goalWork:f.tabs.get('T').codexGoalWork});await f.drain();
  assert.equal(f.sends.length,0);assert.equal(f.queue().autoRun,true);
  f.tabs.get('T').codexGoalWork=null;f.ports.workHolds.add('T');
  f.live.snapshot('T',{hasWatcher:true,sessionId:'S',lifecycleGeneration:'G',busy:false,
    outcomeKnown:true,lastOutcomeReason:'task_complete',lastOutcomeTurnId:'CONTINUE',lastOutcomeTs:at+10},'held');
  await f.drain();assert.equal(f.sends.length,0);
});

for(const phase of ['immediate','delayed','disabled','exhausted','not-submitted','unknown'])
test('actual Main classifier/observer/runtime/Web Continue -> Root/store: '+phase,async t=>{
  const f=await fixture(t), before=f.queue(), p=actualCapacityProducer({onBusy:value=>f.live.handler(null,value),phase,at:f.at()});
  p.start();const error=p.fail();await turns();p.duplicate(error);await turns();
  assert.equal(f.queue(),before);assert.equal(f.sends.length,0);
  let continues=p.calls.filter(call=>call.kind==='continue');
  if(phase==='delayed'){
    assert.equal(continues.length,0);assert.equal(p.timers.size,1);p.fireDelay();await turns();
    continues=p.calls.filter(call=>call.kind==='continue');
  }
  assert.equal(continues.length,['disabled','exhausted'].includes(phase)?0:1);
  for(const call of continues){assert.equal(call.options.prompt,'continue');assert.equal(call.options.requireLive,true);
    assert.equal(call.options.expectedTarget.sessionId,'S');assert.equal(call.options.expectedTarget.turnId,'A');assert.equal(call.options.expectedTarget.lifecycleGeneration,'G');}
  if(['immediate','delayed'].includes(phase)){
    p.finish();await f.drain();assert.equal(f.sends.length,1);assert.equal(f.queue().items.length,0);
    p.duplicate(error);await f.drain();assert.equal(f.sends.length,1);assert.equal(p.calls.filter(call=>call.kind==='continue').length,1);
  }else{
    assert.equal(f.queue().autoRun,true);assert.equal(f.queue().items.length,1);assert.equal(f.sends.length,0);
    if(phase==='exhausted')assert.equal(p.warnings.get('T').code,'codex_capacity_retry_exhausted');
    if(phase==='not-submitted')assert.equal(p.warnings.get('T').code,'codex_capacity_retry_not_submitted');
    if(phase==='unknown')assert.ok(p.state().pendingEffectId);
  }
});

for(const reason of ['provider_error','codex-no-final-result','watchdog','error','unrecognized-error'])
test('genuine '+reason+' is still terminal for the queue, not a blanket recovery',async t=>{
  const f=await fixture(t);f.emit(true,'task_started');f.emit(false,reason);await f.drain();
  assert.equal(f.queue().autoRun,false);assert.equal(f.queue().items[0].id,f.id);assert.equal(f.sends.length,0);assert.equal(f.toasts.length,1);
});
