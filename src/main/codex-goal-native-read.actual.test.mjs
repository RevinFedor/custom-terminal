import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const native = require(process.env.GOAL_MODULE_UNDER_TEST || './codex-goal-work.js');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome.js');
const mainText = fs.readFileSync(process.env.GOAL_MAIN_UNDER_TEST || new URL('./main.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.js', mainText, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name)?.getText(ast);
const S = 'fad90439-c47c-4c0f-96c5-a3fa66d0bf9f';
const T = '01a154a8-2fd1-7b41-be01-c656f2791eb7';
const ev = (type, fields, off, timestamp = '2026-10-19T14:54:30.870Z') => ({ type: 'event_msg',
  payload: { type, ...fields }, __byteOffset: off, timestamp });
const completed = () => ev('task_complete', { turn_id: T, last_agent_message: 'fixture final' }, 279777,
  '2026-10-19T14:54:40.665Z');
const start = (turn = T, off = 258778) => ev('task_started', { turn_id: turn,
  turn_attribution: { turn_trigger: 'goal' } }, off);
const update = (status = 'active', off = 258143) => ev('thread_goal_updated', { threadId: S,
  goal: { threadId: S, status, createdAt: 1792420350, updatedAt: 1792421670 } }, off);
const response = patch => ({ goal: { threadId: S, status: 'complete', createdAt: 1792420350,
  updatedAt: 1792421677, tokensUsed: 1512, tokenBudget: 512, ...patch } });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject }; };
function setup() {
  const tracker = { sessionId: S };
  classifyCodexTurnRecord(tracker, update());
  classifyCodexTurnRecord(tracker, start());
  const record = completed();
  const outcome = classifyCodexTurnRecord(tracker, record);
  return { tracker, record, outcome, isCurrent: () => true };
}
// The preimage fallback lets the RED run exercise its real pending projection;
// it fails on missing repair behavior, not missing exports/imports.
const reconcile = native.reconcileCodexGoalCompletion || (async args => args.outcome);

test('incident: native complete without rollout status update releases the exact Goal at turn end', async () => {
  const h = setup(); assert.equal(h.outcome.goalWork.pending, true);
  const result = await reconcile({ ...h, readGoal: async ({sessionId}) => {
    assert.equal(sessionId, S); return response(); } });
  assert.equal(result.goalWork.pending, false);
  assert.equal(result.goalWork.origin, 'native-goal-read');
  assert.equal(result.turnId, T); assert.equal(result.reason, 'task_complete');
  assert.equal(result.hasFinalResult, true);
});

for (const patch of [ {threadId:'foreign'}, {createdAt:1792420351}, {createdAt:null},
  {updatedAt:1792421669}, {updatedAt:1792421681}, {updatedAt:null},
  ...['active','paused','blocked','usageLimited','budgetLimited','future'].map(status => ({status})) ]) {
  test('non-authority stays pending: ' + JSON.stringify(patch), async () => {
    const h = setup(); const result = await reconcile({...h, readGoal: async () => response(patch)});
    assert.equal(result.goalWork.pending, true);
    assert.equal(h.tracker.codexGoalThreadState.status, 'active');
  });
}
for (const value of [null, {}, {goal:null}, {result:response()}, {goal:{status:'complete'}}]) {
  test('malformed/null native read never releases: ' + JSON.stringify(value), async () => {
    const h = setup(); assert.equal((await reconcile({...h, readGoal: async () => value})).goalWork.pending, true);
  });
}
test('native read rejection stays pending; does not invent completion or retry', async () => {
  let calls=0; const h=setup(); const result=await reconcile({...h, readGoal:async()=>{ calls++; throw Error('timeout'); }});
  assert.equal(result.goalWork.pending,true); assert.equal(calls,1);
});
for (const change of [ h => {h.tracker.sessionId='other';},
  h => classifyCodexTurnRecord(h.tracker,start('NEXT',280000)),
  h => classifyCodexTurnRecord(h.tracker,update('paused',280000)),
  h => classifyCodexTurnRecord(h.tracker,ev('thread_rolled_back',{},280000)),
  h => {h.current=false;} ]) {
  test('late native reply cannot overwrite changed owner/turn/status/rollback',async()=>{
    const h=setup(), d=deferred(); h.current=true;
    const p=reconcile({...h,isCurrent:()=>h.current,readGoal:()=>d.promise});
    await Promise.resolve(); change(h); d.resolve(response());
    assert.equal(await p,null);
  });
}
test('ordinary turn, missing Goal incarnation/offset, and already-complete never issue native reads',async()=>{
  for (const modify of [ h=>{h.tracker.codexGoalForTurn.createdAt=null;},
    h=>{h.record.__byteOffset=null;}, h=>{h.record.__byteOffset=258000;},
    h=>{h.outcome.goalWork=undefined;}, h=>{h.outcome.goalWork.pending=false;},
    h=>{h.outcome.reason='provider_error';}, h=>{h.outcome.hasFinalResult=false;} ]) {
    const h=setup();modify(h);let calls=0;
    await reconcile({...h,readGoal:async()=>{calls++;return response();}});assert.equal(calls,0);
  }
});
test('unchanged Goal across successor stays pending even with final, prose, tool JSON and exhausted budget',async()=>{
  const h=setup();
  for (const record of [ {type:'response_item',payload:{type:'function_call_output',call_id:'fake',output:JSON.stringify(response())}},
    {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'exec',output:JSON.stringify(response())}},
    ev('user_message',{message:'Goal achieved, complete'},270000) ]) classifyCodexTurnRecord(h.tracker,record);
  const result=await reconcile({...h,readGoal:async()=>response({status:'active',tokensUsed:9999,tokenBudget:1})});
  assert.equal(result.goalWork.pending,true);
  classifyCodexTurnRecord(h.tracker,start('NEXT',280000));
  assert.equal(classifyCodexTurnRecord(h.tracker,ev('task_complete',{turn_id:'NEXT',last_agent_message:'final'},290000)).goalWork.pending,true);
});
test('same boundary concurrent/repeated read is coalesced before the first await',async()=>{
  const h=setup(),d=deferred();let calls=0;const args={...h,readGoal:()=>{calls++;return d.promise;}};
  const a=reconcile(args),b=reconcile(args);assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);
  d.resolve(response());await a;await reconcile(args);assert.equal(calls,1);
});

function mainHarness(readGoal) {
  const h=setup(), term={};
  Object.assign(h.tracker,{tabId:'TAB',processGeneration:'GEN',sourceObservationTerminal:term,
    processGenerationBoundaryOffset:250000,filePath:'/owned/rollout',busy:false,
    lastEventTs:h.record.timestamp,lastOutcomeTurnId:T,lastOutcomeTs:Date.parse(h.record.timestamp),lastOutcomeGoalWork:h.outcome.goalWork});
  let generation='GEN',stop=0,draft='';
  const events=[],logs=[],web=[],inputEvents=[],writes=[];
  term.write=text=>writes.push(text);
  const c=vm.createContext({terminals:new Map([['TAB',term]]),codexTurnWatchers:new Map([['TAB',h.tracker]]),
    terminalCommandState:new Map([['TAB',{runSeq:1}]]),getTerminalLifecycleGeneration:()=>generation,
    getTerminalStopRevision:()=>stop,codexHomeDir:()=>'/owned/home',
    terminalInputRevisions:new Map(),codexWriterObservationGenerations:new Map(),
    codexProvisionalSourceObservations:new Map(),ipcMain:{emit:(...args)=>inputEvents.push(args)},
    path:{join:(...x)=>x.join('/')},srcMainDir:'/src',console:{log:x=>logs.push(x)},
    require:()=>({...native,reconcileCodexGoalCompletion:args=>reconcile({...args,readGoal})}),
    emitCodexBusy:(_tab,busy,reason,details)=>events.push({sessionId:S,lifecycleGeneration:'GEN',
      outcomeTs:Date.parse(h.record.timestamp),goalWork:details.outcome.goalWork,busy,reason,...details}),
    mainWindow:{isDestroyed:()=>false,webContents:{send:(channel,data)=>{
      assert.equal(channel,'codex:busy-state');events.push({...data,outcome:{...h.outcome,goalWork:data.goalWork}});
    }}},_webBroadcast:(_tab,data)=>web.push(data),
  });
  vm.runInContext(['getTerminalInputRevision','bumpTerminalInputRevision','getCodexWriterObservationGeneration',
    'invalidateCodexWriterObservations','codexTurnStateSnapshot','publishCodexGoalTurnCompletion'].map(fn).join('\n'),c);
  return {...h,c,events,logs,web,inputEvents,writes,getDraft:()=>draft,run:()=>c.publishCodexGoalTurnCompletion(h.tracker,h.record,h.outcome),
    setGeneration:x=>{generation=x;},stop:()=>stop++,
    input:text=>{draft=text??draft;return c.bumpTerminalInputRevision('TAB');},
    rewrite:()=>c.invalidateCodexWriterObservations('TAB','native-rewind-action-boundary')};
}
test('actual Main publishes turn idle immediately while native promise is unresolved, then metadata only',async()=>{
  const d=deferred(),h=mainHarness(()=>d.promise);h.run();h.run();
  assert.equal(h.tracker.busy,false);assert.equal(h.tracker.lastOutcomeGoalWork.pending,true);assert.equal(h.events.length,1);
  assert.equal(h.events[0].busy,false);assert.equal(h.events[0].goalWork.pending,true);
  assert.equal(h.events[0].goalMetadataOnly,undefined);
  d.resolve(response());await new Promise(setImmediate);
  assert.equal(h.events.length,2);assert.equal(h.events[1].goalWork.pending,false);
  assert.equal(h.events[1].goalMetadataOnly,true);assert.equal(h.events[1].turnId,T);
  assert.equal(h.events[1].outcomeTs,h.events[0].outcomeTs);assert.equal(h.events[1].busy,false);
  assert.equal(h.web.length,1);assert.equal(h.web[0].type,'snapshot');
  h.run();assert.equal(h.events.length,2,'no duplicate original end or metadata');
  assert.ok(h.logs.some(x=>x.includes('native-read-complete')));
  assert.doesNotMatch(h.logs.join('\n'),/objective|fixture final|tokenBudget/);
});
for(const mutate of [h=>h.stop(),h=>h.rewrite(),h=>h.setGeneration('NEW'),
  h=>h.c.terminals.set('TAB',{}),h=>h.c.codexTurnWatchers.set('TAB',{}),
  h=>h.c.terminalCommandState.set('TAB',{runSeq:2}),h=>{h.tracker.sessionId='OTHER';},
  h=>{h.tracker.lastOutcomeGoalWork={...h.outcome.goalWork};},
  h=>{h.tracker.filePath='/replaced';}, h=>{h.tracker.publicTurnStateSuppressed=true;},
  h=>{h.tracker.manualBindingConflict=true;},h=>{h.tracker.sourceObservationLaunchId='new';},
  h=>classifyCodexTurnRecord(h.tracker,start('NEXT',280000))]) {
  test('actual Main fences a late reply at physical/source/Stop/destructive boundary',async()=>{
    const d=deferred(),h=mainHarness(()=>d.promise);h.run();await Promise.resolve();mutate(h);d.resolve(response());
    await new Promise(setImmediate);assert.equal(h.events.length,1,'initial turn end survives');
    assert.equal(h.events[0].busy,false);assert.equal(h.events[0].goalWork.pending,true);
    assert.equal(h.tracker.lastOutcomeGoalWork.pending,true);assert.equal(h.web.length,0);
  });
}
test('actual Main pending native read survives harmless draft edits and publishes exact Goal complete once',async()=>{
  const d=deferred();let calls=0;
  const h=mainHarness(args=>{calls++;assert.equal(args.sessionId,S);return d.promise;});
  h.run();assert.equal(h.events.length,1);assert.equal(h.events[0].busy,false);
  assert.equal(h.events[0].goalWork.pending,true);await Promise.resolve();assert.equal(calls,1);
  const before=h.c.getTerminalInputRevision('TAB');
  h.input('unsent user draft');h.input('unsent user draft with edit');
  assert.equal(h.c.getTerminalInputRevision('TAB'),before+2);
  assert.equal(h.c.getCodexWriterObservationGeneration('TAB'),0);
  assert.equal(h.inputEvents.length,2);
  d.resolve(response());await new Promise(setImmediate);
  assert.equal(calls,1);assert.equal(h.events.length,2);assert.equal(h.events[1].goalMetadataOnly,true);
  assert.equal(h.events[1].goalWork.pending,false);assert.equal(h.events[1].goalWork.status,'complete');
  assert.equal(h.events[1].turnId,T);assert.equal(h.events[1].outcomeTs,h.events[0].outcomeTs);
  assert.equal(h.events[1].goalCompletionOffset,h.events[0].goalCompletionOffset);
  assert.equal(h.web.length,1);assert.equal(h.web[0].type,'snapshot');
  assert.equal(h.getDraft(),'unsent user draft with edit');assert.deepEqual(h.writes,[]);
  h.run();assert.equal(h.events.length,2,'no old turn-end replay or duplicate metadata');
});
test('actual Main transport UNKNOWN emits one pending edge; active/paused remain pending',async()=>{
  for (const read of [async()=>{throw Error('no API');},async()=>response({status:'active'}),async()=>response({status:'paused'})]) {
    const h=mainHarness(read);h.run();h.input('draft must survive UNKNOWN or active');await new Promise(setImmediate);
    assert.equal(h.events.length,1);assert.equal(h.events[0].outcome.goalWork.pending,true);
  }
});
test('actual processCodexTurnLine routes its completed outcome through the adapter',()=>{
  const body=fn('processCodexTurnLine');assert.match(body,/publishCodexGoalTurnCompletion\(state, record, turnOutcome/);
  assert.ok(body.indexOf('applyCodexWatcherOutcome(state, turnOutcome')<body.indexOf('publishCodexGoalTurnCompletion(state'));
});

test('actual Main prefers newer typed status during RPC over the late complete read',async()=>{
  for(const status of ['active','paused','complete']) {
    const d=deferred(),h=mainHarness(()=>d.promise);h.run();await Promise.resolve();
    classifyCodexTurnRecord(h.tracker,update(status,280000));d.resolve(response());
    await new Promise(setImmediate);assert.equal(h.events.length,2);
    assert.equal(h.events[1].goalWork.status,status);
    assert.equal(h.events[1].goalWork.pending,status!=='complete');
    assert.notEqual(h.events[1].goalWork.origin,'native-goal-read');
  }
});

test('actual native reader uses existing JSON-RPC handshake and only thread/goal/get; closes on success/error',async()=>{
  const {EventEmitter}=await import('node:events');
  const {PassThrough,Writable}=await import('node:stream');
  const {CodexAppServerClient}=require('./codex-account-profiles.js');
  for(const fail of [false,true]) {
    const sent=[];let kills=0;
    const spawnImpl=(command,args)=>{
      assert.equal(command,'codex');assert.deepEqual(args,['app-server']);
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>{kills++;};
      child.stdin=new Writable({write(chunk,_enc,cb){
        const msg=JSON.parse(String(chunk));sent.push(msg);
        if(msg.method==='initialize') {
          assert.equal(msg.params.capabilities.experimentalApi,true);
          child.stdout.write(JSON.stringify({id:msg.id,result:{userAgent:'codex/0.162.0'}})+'\n');
        } else if(msg.method==='thread/goal/get') {
          assert.deepEqual(msg.params,{threadId:S});
          // A response from another RPC cannot satisfy this exact native read.
          child.stdout.write(JSON.stringify({id:msg.id+10000,result:response({threadId:'FOREIGN'})})+'\n');
          child.stdout.write(JSON.stringify(fail?{id:msg.id,error:{code:-32601,message:'unsupported'}}
            :{id:msg.id,result:response()})+'\n');
        } else assert.equal(msg.method,'initialized');
        cb();
      }});
      queueMicrotask(()=>child.emit('spawn'));return child;
    };
    const module={exports:{}};
    const context=vm.createContext({module,exports:module.exports,require:spec=>{
      assert.equal(spec,'./codex-account-profiles');
      return {CodexAppServerClient:class extends CodexAppServerClient {
        constructor(options){super({...options,spawnImpl});}
      }};
    },Promise,WeakMap,Set,Date,Number});
    vm.runInContext(fs.readFileSync(new URL('./codex-goal-work.js',import.meta.url),'utf8'),context);
    const p=module.exports.readNativeCodexGoal({sessionId:S,codexHome:'/private/tmp'});
    if(fail) await assert.rejects(p,/unsupported/);
    else { const value=await p;assert.equal(value.goal.status,'complete');assert.equal(value.goal.threadId,S); }
    assert.deepEqual(sent.map(x=>x.method),['initialize','initialized','thread/goal/get']);
    assert.equal(kills,1);
  }
});

test('actual Main immediate end plus metadata releases deferred RestartAfter once; active never releases',async()=>{
  const {createRestartAfterCoordinator}=await import('../renderer/utils/restartAfterCoordinator.mjs');
  for(const status of ['complete','active']) {
    const writes=[];
    const coordinator=createRestartAfterCoordinator({id:()=> 'id',allowed:()=>true,blocked:()=>false,
      targets:()=>[{tabId:'target'}],prepare:async()=>({command:'fixture',finite:true}),
      launch:async(_r,_p,id,current)=>{if(current())writes.push(id);return {success:true};}});
    coordinator.busy({tabId:'TAB',busy:true});
    const d=deferred(),h=mainHarness(()=>d.promise);h.run();
    coordinator.busy({tabId:'TAB',...h.events[0]});await new Promise(setImmediate);
    assert.equal(writes.length,0);assert.equal(h.events[0].goalWork.pending,true);
    d.resolve(response({status}));await new Promise(setImmediate);
    assert.equal(h.events.length,status==='complete'?2:1);
    for(const event of h.events.slice(1))coordinator.busy({tabId:'TAB',...event});
    await new Promise(setImmediate);assert.equal(writes.length,status==='complete'?1:0);
    for(const event of h.events.slice(1))coordinator.busy({tabId:'TAB',...event});
    await new Promise(setImmediate);assert.equal(writes.length,status==='complete'?1:0);
  }
});

test('actual Main native-read edge settles the existing armed bell once; active/UNKNOWN keep it armed',async()=>{
  const {shouldDeferTabCompletionNotification}=await import('../renderer/utils/tabCompletionDeferral.mjs');
  const source=fs.readFileSync(new URL('../renderer/store/useWorkspaceStore.ts',import.meta.url),'utf8');
  const tree=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true);
  const declaration=name=>{
    let found;
    const walk=node=>{
      if(ts.isVariableDeclaration(node)&&node.name.getText(tree)===name)found='const '+node.getText(tree)+';';
      if(ts.isPropertyAssignment(node)&&node.name.getText(tree)===name&&ts.isArrowFunction(node.initializer))
        found='const '+name+' = '+node.initializer.getText(tree)+';';
      ts.forEachChild(node,walk);
    };walk(tree);assert.ok(found);return ts.transpile(found,{target:ts.ScriptTarget.ES2022});
  };
  for(const status of ['complete','active','unknown']) {
    const h=mainHarness(async()=>{if(status==='unknown')throw Error('unavailable');return response({status});});
    const tab={aiBusy:false,completionNotificationPersistent:true},sent=[];
    const state={openProjects:new Map([['P',{projectId:'P',tabs:new Map([['TAB',tab]])}]]),activeProjectId:null};
    const c=vm.createContext({get:()=>state,set(){},useWorkspaceStore:{getState:()=>state},Map,
      deferredTabCompletionReasons:new WeakMap(),shouldDeferTabCompletionNotification,
      isOrchestrationCompletionBlocked:()=>false,tabHasPendingQueueContinuation:()=>false,
      isNaturalAgentTurnEndReason:reason=>reason==='task_complete',console:{warn(){}},
      emitTabCompletionNotificationCleared(){},emitTabCompletionNotificationStateChanged(){},
      emitTabCompletionNotification:value=>sent.push(value),
    });
    vm.runInContext(declaration('settleTabCompletionNotification')+declaration('tabCompletionDeferralReason')+declaration('setAiBusy')+'\nglobalThis.busy=setAiBusy;',c);
    c.busy('TAB',true,'task_started');h.run();await new Promise(setImmediate);
    assert.equal(h.events[0].busy,false);assert.equal(h.events[0].goalWork.pending,true);
    for(const event of h.events)c.busy('TAB',event.busy,event.reason,event.goalWork);
    const event=h.events.at(-1);c.busy('TAB',event.busy,event.reason,event.goalWork);
    assert.equal(sent.length,status==='complete'?1:0);
    assert.equal(!!tab.completionNotificationArmed,status!=='complete');
  }
});
