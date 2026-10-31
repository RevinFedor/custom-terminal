'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {runtimeSnapshotCompletionFixture}=require('./test-helpers/runtime-snapshot-completion');
function fixture(options={}){
 const h=runtimeSnapshotCompletionFixture();let historyReads=0;
 if(process.env.INPUT_RUNTIME_MAIN_SOURCE){
  const source=fs.readFileSync(process.env.INPUT_RUNTIME_MAIN_SOURCE,'utf8');
  const ast=ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true);
  const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='readMainPublicRuntimeSnapshot');
  vm.runInContext(node.getText(ast),h.context);
 }
 h.context.getCodexRuntimeSessionSnapshot=async()=>{
  historyReads++;
  options.onPublicRead?.();
  return {status:h.state.busy?'busy':'active',sessionStatus:h.state.busy?'busy':'active',busy:h.state.busy,
   liveLifecycle:true,inputReady:true,sessionId:null,
   savedSessionId:'S',writerConfirmed:false,writerUsableForMutation:false};
 };
 return {...h,historyReads:()=>historyReads,input:()=>h.context.readMainPublicRuntimeSnapshot('T',{inputOnly:true})};
}
test('actual Main automatic input snapshot does not perform writer/History recovery for a provisional ready Resume',async()=>{
 const h=fixture(),result=await h.input();
 assert.equal(h.historyReads(),0,'input admission must not wait on full public History materialization');
 assert.equal(result.inputReady,true);assert.equal(result.processStatus,'found');assert.equal(result.coherent,true);
 assert.equal(result.sessionId,null,'saved SID is never promoted to writer');
 assert.equal(result.writerConfirmed,false);assert.equal(h.state.lookups,1);
});

function actualSendHandler(t,{stop=false}={}) {
 let now=100000,sendCalls=0;
 const h=fixture({onPublicRead:()=>{now+=15000;}}),c=h.context;
 const main=fs.readFileSync(process.env.INPUT_RUNTIME_MAIN_SOURCE||require.resolve('./main'),'utf8');
 const ast=ts.createSourceFile('main.js',main,ts.ScriptTarget.Latest,true);
 const declaration=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
 const registration=ast.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)
  &&n.expression.expression.getText(ast)==='ipcMain.handle'&&n.expression.arguments[0]?.text==='codex:send-command');
 const Database=require('better-sqlite3'),db=new Database(':memory:');t.after(()=>db.close());
 const store=require('./agent-send-receipt-store').createAgentSendReceiptStore(db);
 const prep=require('./agent-send-preparation');
 const identity={operationKey:'history:T:input-only',tabId:'T',handoffId:'input-only',provider:'codex',
  surface:'desktop-history',requestFingerprint:'frozen-request',promptHash:'frozen-hash',promptLength:6};
 const begun=store.beginAttempt(identity);
 const scope=prep.createSendPreparationScope({...identity,attemptId:begun.attemptId},now-55000);
 store.stageAttemptContext(identity.operationKey,begun.attemptId,{preflightScope:scope});
 const webSource=fs.readFileSync(process.env.INPUT_RUNTIME_WEB_SOURCE||require.resolve('./web-server'),'utf8');
 const webAst=ts.createSourceFile('web.js',webSource,ts.ScriptTarget.Latest,true);
 const request={tabId:'T',handoffId:'input-only',provider:'codex',source:'prompt-queue',
  promptQueueIntent:{version:1,kind:'queue',itemId:'item',armedAt:1,triggerTabId:'T',conditionKey:'-',triggerKey:'null'}};
 const web=vm.createContext({require,path,srcMainDir:__dirname,console:c.console,
  ...require('../shared/prompt-queue-send-intent.cjs'),...require('./prompt-queue-source'),
  getBuildContinueOperations:()=>({capturing:()=>false}),buildInstallAutomationBlocked:()=>false,
  historyMutationInput:null,automaticSendAdmissionDiagnostics:new Map(),captureTabInspection:null,
  bridgeRequest:async()=>({ready:true}),
  readAgentInputRuntimeSnapshot:()=>h.input(),coherentPublicRuntimeSnapshot:()=>c.getCodexRuntimeSessionSnapshot('T'),
  readAutomaticSendFrame:()=>({ready:true})});
 vm.runInContext(['readQueuedContinuationHardFence','admitQueuedAgentSend']
  .map(name=>webAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(webAst)).join('\n'),web);
 const api={buildInstallAutomationBlocked:()=>false,readAutomaticSendAdmission:()=>web.admitQueuedAgentSend(request),
  certifyAutomaticReadinessWait:(_id,value)=>value};
 const mirror={generation:'mirror-G'};
 Object.assign(c,{require:id=>id===path.join(__dirname,'web-server')?api:require(id),path,srcMainDir:__dirname,
  ...require('./prompt-queue-source'),getHeadlessTerminalMirror:()=>mirror,
  ipcMain:{handle:(_channel,fn)=>{c.sendHandler=fn;}},agentSendReceiptStore:store,
  aiStoppingTabs:new Map(),
  agentSendCancellations:{isCancelled:()=>false},captureCodexSendStartupFrameWait:()=>null,
  readAgentSendPreparation:(s,tab,opts,startup)=>prep.readAgentSendPreparation(s,tab,opts,startup,()=>now),
  prepareCodexMainComposerForSend:async()=>({success:true,inputWritten:false}),
  isCodexOperationalInputReady:()=>true,agentSendRequestTargetFailure:()=>null,
  CODEX_PASTE_AUDIT_TIMEOUT_MS:8000,
  safePasteAndSubmit:async(_term,prompt,options)=>{
   assert.equal(prompt,'frozen');assert.equal(options.sendAttemptId,begun.attemptId);
   assert.equal(prep.readAgentSendPreparation(store,'T',options,null,()=>now).failure(),null);
   sendCalls++;return {success:true,submitted:true};
  }});
 vm.runInContext(['captureAgentInputIdentity','agentSendExecutionFailure'].map(declaration).join('\n'),c);
 vm.runInContext(registration.getText(ast),c);
 if(stop){let changed=false;h.state.onLookup=()=>{if(!changed){changed=true;h.state.stop++;}};}
 return {...h,now:()=>now,sendCalls:()=>sendCalls,run:()=>c.sendHandler({sender:{}},'T','frozen',{
  source:'prompt-queue',handoffId:identity.handoffId,sendOperationKey:identity.operationKey,sendAttemptId:begun.attemptId,statusAtSend:'active'})};
}
test('actual Main IPC -> actual Web automatic HEAD uses input-only producer and reaches the same sender before unchanged deadline',async t=>{
 const h=actualSendHandler(t),result=await h.run();
 assert.equal(result.submitted,true,JSON.stringify(result));assert.equal(h.sendCalls(),1);
 assert.equal(h.historyReads(),0);assert.equal(h.now(),100000);
});
test('Stop during the same private process proof still revokes actual Main IPC before sender',async t=>{
 const h=actualSendHandler(t,{stop:true}),result=await h.run();
 assert.equal(result.submitted,false);assert.equal(h.sendCalls(),0);assert.equal(h.historyReads(),0);
});
test('ordinary public status retains canonical writer recovery',async()=>{
 const h=fixture();await h.snapshot();assert.equal(h.historyReads(),1);
});
for(const process of ['unknown','absent'])test('input-only does not turn '+process+' physical state into ready',async()=>{
 const h=fixture();h.state.process=process;
 if(process==='absent')h.command.isRunning=false;
 const result=await h.input();assert.equal(result.inputReady,false);
 assert.equal(h.historyReads(),0);assert.equal(result.processStatus,process);
});
test('input-only owner/input replacement during every process await remains unavailable',async()=>{
 const h=fixture();h.state.onLookup=()=>{h.state.input++;};
 await assert.rejects(h.input,{code:'runtime_snapshot_unstable'});
 assert.equal(h.historyReads(),0);assert.equal(h.state.lookups,2);
});
test('input-only rejects a found foreign provider behind stale Codex event readiness',async()=>{
 const h=fixture();
 h.context.getProcessTreeSnapshot=async()=>({children:new Map([[100,[{pid:200,ppid:100,cmd:'claude'}]]]),
  source:'controlled',createdAt:performance.now(),psMs:0,parseMs:0,linesCount:1});
 h.context.commandLooksLikeAiProcess=()=>true;
 h.context.getAiProcessNameFromCommand=()=> 'claude';
 const result=await h.input();
 assert.equal(result.processStatus,'found');assert.equal(result.processName,'claude');
 assert.equal(result.inputReady,false);assert.equal(h.historyReads(),0);
});
test('input-only keeps busy and native Goal metadata independent of input availability',async()=>{
 const h=fixture();h.state.busy=true;
 const original=h.context.projectCodexRuntimeSnapshotFromEvents;
 h.context.projectCodexRuntimeSnapshotFromEvents=()=>({...original(),goalWork:{version:1,pending:true}});
 const result=await h.input();assert.equal(result.busy,true);assert.equal(result.goalWork.pending,true);
 assert.equal(h.historyReads(),0);
});
