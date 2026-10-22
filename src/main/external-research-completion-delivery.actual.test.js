'use strict';
// Actual JSON RunStore, SQLite content/receipts/FIFO, AST-extracted web functions.
// Controlled leaves: SC HTTP result, source runtime, physical input and audit.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),vm=require('node:vm'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const ts=require('typescript'),Database=require('better-sqlite3');
const runApi=require('./orchestration-runs'),contentApi=require('./orchestration-completion-content'),local=require('./external-research-completion-delivery');
const {ExternalResearchCoordinator}=require('./external-research-coordinator');
const {ScExternalResearchClient,isScResearchTerminalStatus}=require('./sc-external-research-client');
const {AgentSendQueue}=require('./agent-send-queue'),{createAgentSendReceiptStore}=require('./agent-send-receipt-store');
const registry=require('./agent-send-receipt-registry'),{promptAuditFingerprint}=require('./prompt-audit-fingerprint');
const {agentPromptAuditMatchesHash}=require('./agent-prompt-audit-identity'),{isResponseObservation}=require('./orchestration-response-observation');
const {resolveOrchestrationSourceNotificationSendOptions}=require('./orchestration-request-plan');
const {createOperationalDelivery,resolveOperationalRequest}=require('./external-research-operational-delivery');
const webFile=path.join(__dirname,'web-server.js'),ast=ts.createSourceFile(webFile,fs.readFileSync(webFile,'utf8'),ts.ScriptTarget.Latest,true);
const names=['prepareExternalCompletionRequest','prepareOrchestrationCompletionContent','readExternalResearchResult','reconcileExternalResearchRun',
'externalResearchAnswerText','boundedExternalResearchResult','orchestrationUrls','withOrchestrationUrls','orchestrationNotificationText',
'orchestrationPresentationSnapshot','sendOrchestrationCompletionNotification','orchestrationSourceReceiptProof','reconcileOrchestrationSourceFollowup',
'startOrchestrationStartupRecovery','stopOrchestrationStartupRecovery','reconcileActiveOrchestrations','reconcileOrchestrationSourceReceiptPins','releaseOrchestrationSourceProof','revokeExternalOperationalDelivery','revokeExternalCompletionDelivery','externalResearchCancellationReceipt','performOrchestrationAction','cancelPendingOrchestrationContinuation','promptFingerprint','shortId'];
const actual=names.map(name=>{const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert(n,name);return n.getText(ast);}).join('\n');
let cancelRouteBody;
(function visit(node){if(ts.isIfStatement(node)&&node.expression.getText(ast)==="orchestrationCancelMatch && req.method === 'POST'")cancelRouteBody=node.thenStatement.getText(ast);ts.forEachChild(node,visit);})(ast);
assert(cancelRouteBody,'actual public cancellation route');
const bounded=async p=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned test deadline')),8000);})]);}finally{clearTimeout(timer);}};
const target={toolType:'codex',sessionId:'source-S'};
async function fixture(t,options={}){
 const sourceTarget=options.sourceTarget||target;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-local-delivery-')),file=path.join(root,'runs.json'),sql=path.join(root,'delivery.sqlite');
 let runs,db,receipts,contents,queue,service,coordinator,op;
 const effects={inputs:[],reads:0,starts:0,delays:[],wakes:0,sends:0,human:[],errors:[]};
 const hooks={failures:options.failures||0,body:options.body||'FULL exact expert result',source:{...sourceTarget,status:'busy',...options.source},
 ready:options.ready!==false,audit:options.audit!==false,beforeContent:null,beforeInfo:null,beforeEnqueue:null,afterEnqueue:null,beforeInput:null,failFreeze:0};
 const snapshot=()=>({id:'noted_R',status:'done',provider:'chatgpt',result:{text:hooks.body},conversationId:'same-CID',conversationUrl:'https://chatgpt.com/c/same-CID'});
 const server=http.createServer((req,res)=>{if(req.method!=='GET'||!req.url.startsWith('/research-status?')){effects.starts++;res.writeHead(409);return res.end('{}');}
 effects.reads++;if(hooks.failures-->0){res.writeHead(503,{'content-type':'application/json'});return res.end(JSON.stringify({code:'owned_final_read_unavailable',error:'owned read unavailable'}));}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(snapshot()));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=new ScExternalResearchClient({baseUrl:'http://127.0.0.1:'+server.address().port});
 const context=vm.createContext({...runApi,...contentApi,crypto,path,srcMainDir:__dirname,require:createRequire(webFile),console:{log(){},warn(){}},
 promptAuditFingerprint,agentPromptAuditMatchesHash,isResponseObservation,isScResearchTerminalStatus,
 isAgentSendProviderQueueAccepted:registry.isAgentSendProviderQueueAccepted,AGENT_SEND_RECEIPT_STATES:registry.RECEIPT_STATES,
 resolvedPort:7878,tabWorkContext:null,setTimeout,clearTimeout,orchestrationStartupRecovery:null,orchestrationNotificationInflight:new Set(),agentSendReceiptStartupReady:Promise.resolve({ready:true}),
 getOrchestrationRunStore:()=>runs,getCompletionContentStore:()=>contents,getScExternalResearchClient:()=>client,getExternalResearchCoordinator:()=>coordinator,
 getExternalCompletionDelivery:()=>service,resolveOrchestrationSourceNotificationSendOptions,
 readScenarioDestination:async()=>({...hooks.source}),
 resolveAgentSessionInfo:async()=>{if(hooks.beforeInfo)await hooks.beforeInfo();return hooks.source;},armOrchestrationSourceProof:async()=>({success:true}),
 orchestrationSourceProofCoordinator:{release:async()=>true},emitOrchestrationChanges(){},emitOrchestrationRun(){},finalizeSettledOrchestrations:async()=>{},getAgentTurnResult:null,getAgentResponseState:null,readAgentObservedResponse:null,
 processDueOrchestrationPolicies:async()=>{},scheduleOrchestrationPolicyTimer:async()=>{},dispatchNextDeferredOrchestrationForTarget:async()=>{},
 decId:decodeURIComponent,readBody:async req=>req.body,sendJson:(_res,status,body)=>({status,body})});
 vm.runInContext(actual,context);
 vm.runInContext(`async function cancelViaPublicRoute(body={}) { const req={method:'POST',body},res={},orchestrationCancelMatch=[null,'R']; ${cancelRouteBody} }`,context);
 const identity=request=>({operationKey:request.sendOperationKey,surface:'desktop-history',tabId:request.tabId,provider:request.provider,sessionId:request.sessionId,
 handoffId:request.handoffId,requestFingerprint:registry.fingerprintAgentSendRequest(request),promptHash:promptAuditFingerprint(request.prompt),promptLength:request.prompt.length});
 const promote=record=>receipts.promoteFromAudit({success:true,operationKey:record.operationKey,attemptId:record.attemptId,provider:sourceTarget.toolType,sessionId:record.sessionId||options.materializedSessionId||hooks.source.sessionId||'source-S',
 promptHash:record.promptHash,actualHash:record.promptHash,expectedHash:record.promptHash,entryUuid:'input:'+record.handoffId,sourceIdentity:'source:'+record.handoffId,auditTimestamp:new Date().toISOString()});
 async function open(initial=false){
 db=new Database(sql);receipts=createAgentSendReceiptStore(db);contents=new contentApi.CompletionContentStore({db});
 const freeze=contents.freeze.bind(contents);contents.freeze=value=>{if(hooks.failFreeze-->0)throw Object.assign(Error('owned content write'),{code:'SQLITE_IOERR'});return freeze(value);};
 runs=new runApi.OrchestrationRunStore(file,{onOperationalRevoked:context.revokeExternalOperationalDelivery,onCompletionRevoked:context.revokeExternalCompletionDelivery});
 queue=new AgentSendQueue({store:receipts,ready:()=>hooks.ready,execute:async(request,scope)=>{
 try {
 if(hooks.beforeInput)await hooks.beforeInput(request);if(request.completionDeliveryRef)await local.resolveCompletionRequest(runs,request);
 if(request.operationalNoticeRef)await resolveOperationalRequest(runs,request);
 const pinFailure=require('../shared/agent-send-target-precondition.cjs').agentSendTargetPreconditionFailure(request.expectedTarget,hooks.source);
 if(pinFailure)throw Object.assign(Error(pinFailure.error),pinFailure);
 const key={...identity(request),requestFingerprint:scope.requestFingerprint},begun=receipts.beginAttempt(key);assert.equal(begun.action,'attempt-started');
 if(hooks.source.sessionId)assert.equal(receipts.stageAttemptContext(key.operationKey,begun.attemptId,{sessionId:hooks.source.sessionId}).applied,true);
 receipts.markAttemptState(key.operationKey,begun.attemptId,'enter-armed');effects.inputs.push(request);
 if(!hooks.source.sessionId&&options.materializedSessionId)hooks.source.sessionId=options.materializedSessionId;
 receipts.settleAttempt(key.operationKey,begun.attemptId,{submitted:true,auditPending:true,status:'audit-pending'});
 if(hooks.audit)assert.equal(promote(receipts.get(key.operationKey)).promoted,true);return receipts.get(key.operationKey).receipt;
 } finally { hooks.inputAttemptFinished?.(); }
 },publish:record=>{if(record.handoffId.startsWith('orchestration-complete:'))coordinator?.wakeDelivery('R','receipt');}});
 Object.assign(context,{agentSendReceiptStore:receipts,agentSendQueue:queue});
 // Configure only the first fixture owner. Reopening must exercise the real
 // startup/load retry path, including its deliberately injected read errors.
 if(initial){await runs.updateSettings({externalResearchOperationalPrompts:options.operationalPrompts!==false});
 if(options.maintenance)await runs.transitionResearchMaintenance({action:'begin',operationId:'install:actual-full-final'});}
 op=createOperationalDelivery({store:runs,classify:runApi.classifyAgentSendReceipt,logger:{warn(){}},
 prepare:async(_run,n)=>({prompt:n.body,sendOptions:{provider:'codex',queue:true,statusAtSend:'busy'}}),pin:n=>receipts.pinForOwner(n.operationKey,'research-operational'),
 lookup:async n=>({result:receipts.get(n.operationKey)?.receipt||null}),send:async request=>hooks.blockNotice?{submitted:false,status:'not-submitted',code:'owned_notice_blocked'}:queue.enqueue({identity:identity(request),request}).receipt,
 onBlocked:async(_run,n)=>effects.human.push(n.id)});
 // Most existing outage tests exercise the post-grace decision with accelerated
 // retry timers. The production-default grace is verified separately below.
 service=local.createExternalCompletionDelivery({store:runs,receipts,queueItem:key=>queue.item(key),waitReady:async()=>{},
 ...(options.productionGrace?{}:{notificationGraceMs:0}),
 prepare:async(run,guard)=>{if(hooks.beforeContent)await hooks.beforeContent();return context.prepareExternalCompletionRequest(run,guard);},
 send:async(request,control)=>{effects.sends++;if(hooks.beforeEnqueue)await hooks.beforeEnqueue(request);await local.resolveCompletionRequest(runs,request);
 const value=queue.enqueue({identity:identity(request),request,retryCompletionNoInput:control.retryCompletionNoInput});assert.equal(value.ok,true);if(hooks.afterEnqueue)await hooks.afterEnqueue(request);
 return(await queue.result(request.sendOperationKey)).receipt;},reconcile:run=>context.reconcileOrchestrationSourceFollowup(run),
 notifyOperational:(id,detail={})=>{effects.wakes++;op.schedule(id);if(detail.blocked)void op.reportBlocked(id);},logger:{warn(text){effects.errors.push(text);}},retryBaseMs:2,retryMaxMs:8});
 coordinator=new ExternalResearchCoordinator({store:runs,client,finalizeSettled:run=>context.sendOrchestrationCompletionNotification(run),notifyOperational:id=>op.schedule(id),
 retryBaseMs:2,retryMaxMs:8,setTimer:(fn,ms)=>{effects.delays.push(ms);return setTimeout(fn,ms);},logger:{warn(text){effects.errors.push(text);}}});await runs.initialize();
 }
 await open(true);await runs.reserveOrGet({runId:'R',runKind:'external-research',requestFingerprint:'same-original-partial-options',sourceTabId:'source',sourceProjectId:'P',
 sourceSessionId:sourceTarget.sessionId||null,sourceToolType:sourceTarget.toolType,sourceSendTarget:sourceTarget,externalResearchJobId:'noted_R',externalResearchIntent:{provider:'chatgpt',prompt:'same prompt',options:{effort:'xhigh'},files:[]},notifySource:true});
 if(options.terminal!==false)await runs.applyExternalResearchSnapshot('R',snapshot());
 async function close(){context.stopOrchestrationStartupRecovery();await coordinator.stop();service.stop();op.stop();await op.drain();queue.dispose();await runs.flush();db.close();}
 t.after(async()=>{await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true});});
 return{effects,hooks,context,file,sql,root,get runs(){return runs;},get receipts(){return receipts;},get contents(){return contents;},get queue(){return queue;},get service(){return service;},get coordinator(){return coordinator;},get op(){return op;},
 run:()=>bounded(coordinator.watch('R')),reopen:async edit=>{await close();if(edit)edit(file);await open();},promote:()=>promote(receipts.get('history:source:orchestration-complete:R'))};
}
for(const toolType of ['codex','claude'])test(`provisional ${toolType} source keeps the launch pin and receives its full final after first SID materialization`,async t=>{
 const pin={toolType,terminalInstanceId:'terminal-A',launchId:'launch-A'};
 const h=await fixture(t,{sourceTarget:pin,materializedSessionId:'materialized-S',operationalPrompts:false});
 const birth=structuredClone((await h.runs.getInternal('R')).externalResearchDeliveryBirth);
 await h.service.deliver('R');
 const r=await h.runs.getInternal('R');
 assert.equal(h.effects.inputs.filter(x=>x.completionDeliveryRef).length,1,JSON.stringify(h.effects.errors));
 assert.deepEqual(r.externalResearchDeliveryBirth,birth);assert.deepEqual(r.sourceSendTarget,pin);
 assert.deepEqual(r.externalResearchDelivery.sourceTarget,pin);assert.deepEqual(r.externalResearchDelivery.request.expectedTarget,pin);
 assert.equal(r.externalResearchDelivery.request.sessionId,null,'writer SID is not retroactively frozen into the birth pin');
 assert.equal(r.externalResearchDelivery.phase,'delivered');assert.equal(r.sourceFollowupSessionId,'materialized-S');
 await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,1);assert.equal(h.effects.starts,0);
});
test('provisional completion rejects a replacement launch even when its public SID looks usable',async t=>{
 const pin={toolType:'codex',terminalInstanceId:'terminal-A',launchId:'launch-A'};
 const h=await fixture(t,{sourceTarget:pin,operationalPrompts:false,source:{sessionId:'materialized-S',terminalInstanceId:'terminal-B',launchId:'launch-B'}});
 await h.service.deliver('R');const r=await h.runs.getInternal('R');
 assert.equal(h.effects.inputs.length,0);assert.equal(r.externalResearchDelivery.lastError,'external_completion_source_changed');
 assert.deepEqual(r.externalResearchDelivery.sourceTarget,pin);
});
test('already materialized provisional source keeps its launch pin through preparation and physical input',async t=>{
 const pin={toolType:'codex',terminalInstanceId:'terminal-A',launchId:'launch-A'};
 const h=await fixture(t,{sourceTarget:pin,source:{sessionId:'materialized-S'},operationalPrompts:false});
 await h.service.deliver('R');const r=await h.runs.getInternal('R');
 assert.equal(r.externalResearchDelivery.phase,'delivered');assert.equal(h.effects.inputs.length,1);
 assert.equal(r.externalResearchDelivery.request.sessionId,null);assert.deepEqual(h.effects.inputs[0].expectedTarget,pin);
 const record=h.receipts.get('history:source:orchestration-complete:R'),item=h.queue.item(record.operationKey);
 assert.equal(local.receiptSourceSessionId(r.externalResearchDelivery,record,item),'materialized-S');
 const changed=JSON.parse(item.request_json);changed.expectedTarget.launchId='foreign-launch';
 assert.equal(local.receiptMatchesDelivery(r.externalResearchDelivery,record,{...item,
   request_json:JSON.stringify(changed),request_hash:registry.fingerprintAgentSendRequest(changed)}),false);
 assert.equal(local.receiptMatchesDelivery(r.externalResearchDelivery,record,null),false,'a missing launch witness is not inferred from SID');
});
test('provisional launch replacement after preparation is refused at the physical boundary without input',async t=>{
 const pin={toolType:'codex',terminalInstanceId:'terminal-A',launchId:'launch-A'};
 const h=await fixture(t,{sourceTarget:pin,source:{sessionId:'materialized-S'},operationalPrompts:false});
 h.hooks.beforeInput=async()=>{h.hooks.source={...h.hooks.source,terminalInstanceId:'terminal-B',launchId:'launch-B'};};
 await h.service.deliver('R');const r=await h.runs.getInternal('R');
 assert.equal(h.effects.inputs.length,0);assert.equal(h.effects.starts,0);
 assert.equal(r.externalResearchDelivery.phase,'waiting-for-input');
 assert.deepEqual(r.externalResearchDelivery.request.expectedTarget,pin);
 const record=h.receipts.get('history:source:orchestration-complete:R');
 assert.equal(record.receipt.submitted,false);assert.equal(record.receipt.pasteWritten,false);assert.equal(record.receipt.enterWritten,false);
});
test('provisional delivery lost ACK survives restart and consumes only its original late canonical receipt',async t=>{
 const pin={toolType:'codex',terminalInstanceId:'terminal-A',launchId:'launch-A'};
 const h=await fixture(t,{sourceTarget:pin,materializedSessionId:'materialized-S',audit:false,operationalPrompts:false});
 h.hooks.afterEnqueue=async()=>{throw Error('lost original provisional input ACK');};
 await h.service.deliver('R');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.effects.inputs.length,1,JSON.stringify(h.effects.errors));
 const original=await h.runs.getInternal('R'),receipt=h.receipts.get('history:source:orchestration-complete:R');
 assert.equal(original.notificationStatus,'unconfirmed');
 await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,1);
 assert.equal(h.receipts.get(receipt.operationKey).attemptId,receipt.attemptId);
 h.hooks.source={...h.hooks.source,sessionId:'new-S',terminalInstanceId:'new-terminal',launchId:'new-launch'};
 assert.equal(h.promote().promoted,true);await h.service.deliver('R');
 const final=await h.runs.getInternal('R');assert.equal(final.externalResearchDelivery.phase,'delivered');
 assert.equal(final.externalResearchDelivery.requestHash,original.externalResearchDelivery.requestHash);
 assert.deepEqual(final.externalResearchDeliveryBirth,original.externalResearchDeliveryBirth);assert.equal(h.effects.starts,0);
});
for(const failures of[1,6])test(`${failures} final-body HTTP 503 failures recover automatically with no provider start`,async t=>{
 const h=await fixture(t,{failures});await h.run();await h.op.drain();assert.equal(h.effects.starts,0);assert.equal(h.effects.reads,failures+1);
 const finals=h.effects.inputs.filter(r=>r.completionDeliveryRef);assert.equal(finals.length,1);assert(finals[0].prompt.endsWith('FULL exact expert result'));
 const r=await h.runs.getInternal('R');assert.equal(r.status,'completed');assert(r.sourceFollowupStartedAt);assert.equal(r.externalResearchDelivery.phase,'delivered');
 assert.equal(r.externalResearchDelivery.failures,failures);assert(h.effects.delays.every(ms=>ms>0));
 assert.equal(new Set(Object.values(r.externalResearchOperational.notices).filter(n=>n.origin==='noted-delivery').map(n=>n.localEpisodeId)).size,1);
 assert.equal(r.requestFingerprint,'same-original-partial-options');assert.deepEqual(r.externalResearchIntent.options,{effort:'xhigh'});
});
test('production grace keeps transient final-body HTTP failures quiet and delivers the full result once',async t=>{
 const h=await fixture(t,{failures:3,productionGrace:true});await h.run();await h.op.drain();
 const r=await h.runs.getInternal('R');assert.equal(r.externalResearchDelivery.phase,'delivered');
 assert.equal(h.effects.starts,0);assert.equal(h.effects.reads,4);
 assert.equal(h.effects.inputs.filter(x=>x.completionDeliveryRef).length,1);
 assert.equal(h.effects.inputs.filter(x=>x.operationalNoticeRef).length,0);
 assert.equal(Object.keys(r.externalResearchOperational?.notices||{}).length,0);
 assert.equal(h.effects.human.length,0);
});
test('restart before freeze resumes local delivery only',async t=>{const h=await fixture(t,{failures:1});await h.service.deliver('R');assert.equal(h.contents.get('R'),null);
 await h.reopen();await h.run();assert.equal(h.effects.reads,2);assert.equal(h.effects.starts,0);assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);});
test('restart after freeze and metadata rename failure preserves exact body',async t=>{
 const h=await fixture(t);let failed=false;const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{if(to===h.file&&!failed&&h.contents.get('R')){failed=true;throw Object.assign(Error('owned rename'),{code:'EACCES'});}return rename(from,to);};
 try{await h.service.deliver('R');}finally{fs.promises.rename=rename;}assert(failed);const frozen=h.contents.get('R');assert(frozen);assert.equal(h.effects.inputs.length,0);
 await h.reopen();await h.run();assert.equal(h.effects.reads,1);assert.equal(h.contents.get('R').hash,frozen.hash);assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);
});
test('content SQL failure retries without acknowledging RAM body',async t=>{const h=await fixture(t);h.hooks.failFreeze=1;await h.run();assert.equal(h.effects.reads,2);assert.equal(h.effects.starts,0);assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);});
test('lost ACK before admission retries same frozen request',async t=>{const h=await fixture(t);let first=true;h.hooks.beforeEnqueue=async()=>{if(first){first=false;throw Object.assign(Error('owned before FIFO'),{code:'EIO'});}};
 await h.run();assert.equal(h.effects.sends,2);assert.equal(h.effects.reads,1);assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);});
test('restart after Enter before audit preserves UNKNOWN; late receipt finishes without enqueue',async t=>{
 const h=await fixture(t,{audit:false});h.hooks.afterEnqueue=async()=>{throw Error('lost admission ACK');};await h.run();await new Promise(resolve=>setImmediate(resolve));await h.op.drain();
 assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);assert.equal((await h.runs.getInternal('R')).notificationStatus,'unconfirmed');
 const id=h.receipts.get('history:source:orchestration-complete:R').attemptId;await h.reopen();await h.run();assert.equal(h.effects.sends,1);assert.equal(h.effects.reads,1);
 assert.equal(h.receipts.get('history:source:orchestration-complete:R').attemptId,id);assert.equal(h.promote().promoted,true);await h.run();
 assert((await h.runs.getInternal('R')).sourceFollowupStartedAt);assert.equal(h.effects.sends,1);
});
for(const gate of['beforeContent','beforeInfo','beforeEnqueue'])for(const change of['suppress','replace'])test(`${change} across ${gate} fences input`,async t=>{
 const h=await fixture(t);h.hooks[gate]=async()=>{h.hooks[gate]=null;if(change==='suppress')await h.runs.markNotification('R','suppressed');else{await h.runs.patch('R',{sourceSendTarget:{toolType:'codex',sessionId:'replacement'}});await h.runs.persistStrict();}};
 await h.run();assert.equal(h.effects.inputs.length,0);assert.equal(h.effects.starts,0);if(change==='suppress')assert.equal((await h.runs.get('R')).notificationStatus,'suppressed');
});
for(const surface of ['api','action'])for(const gate of ['beforeContent','beforeEnqueue','beforeInput'])test(`public ${surface} cancel after SC done at ${gate} revokes delivery, retaining the final and birth across restart`,async t=>{
 const h=await fixture(t,{operationalPrompts:false});const birth=structuredClone((await h.runs.getInternal('R')).externalResearchDeliveryBirth);
 const inputAttemptFinished=new Promise(resolve=>{h.hooks.inputAttemptFinished=resolve;});
 let result;h.hooks[gate]=async()=>{h.hooks[gate]=null;result=surface==='api'?(await h.context.cancelViaPublicRoute()).body:await h.context.performOrchestrationAction('R','cancel');};
 await h.service.deliver('R');if(gate==='beforeInput')await bounded(inputAttemptFinished);assert.equal(result?.ok,true);assert.equal(h.effects.inputs.length,0);
 const r=await h.runs.getInternal('R');assert.equal(r.status,'completed');assert.equal(r.resultComplete,true);assert.equal(r.notificationSuppressed,true);assert.equal(local.authorized(r),false);
 assert.deepEqual(r.externalResearchDeliveryBirth,birth);await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,0);assert.equal(h.effects.starts,0);
});
test('public cancellation after done retires ACTIVE FIFO HEAD with a strict durable fence',async t=>{
 const h=await fixture(t,{ready:false,operationalPrompts:false});let admit;const admitted=new Promise(r=>admit=r);h.hooks.afterEnqueue=async()=>admit();
 const work=h.service.deliver('R');await bounded(admitted);const result=await h.context.cancelViaPublicRoute();
 h.hooks.ready=true;h.queue.resume();await bounded(work);assert.equal(result.body.ok,true);assert.equal(h.effects.inputs.length,0);
 assert.equal(h.queue.item('history:source:orchestration-complete:R').state,'cancelled');assert.equal(h.receipts.isDeliveryCancelled('history:source:orchestration-complete:R'),true);
 await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,0);
});
test('settled UI detach revokes proven-no-input waiting delivery and does not resume it on readiness',async t=>{
 const h=await fixture(t,{operationalPrompts:false});h.hooks.beforeInput=async()=>{throw Object.assign(Error('draft occupied'),{code:'source_draft_not_empty'});};
 await h.service.deliver('R');assert.equal((await h.runs.get('R')).notificationStatus,'waiting-for-input');
 const result=await h.context.performOrchestrationAction('R','detach');assert.equal(result.ok,true);h.hooks.beforeInput=null;
 await h.context.sendOrchestrationCompletionNotification(await h.runs.getInternal('R'),{sourceReady:true});assert.equal(h.effects.inputs.length,0);
 await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,0);
});
test('cancel after lost completion ACK preserves UNKNOWN receipt and never claims that the past input was undone',async t=>{
 const h=await fixture(t,{audit:false,operationalPrompts:false});h.hooks.afterEnqueue=async()=>{throw Error('lost ACK');};
 await h.service.deliver('R');await new Promise(resolve=>setImmediate(resolve));assert.equal(h.effects.inputs.length,1);
 const key='history:source:orchestration-complete:R',before=h.receipts.get(key);assert.equal((await h.runs.get('R')).notificationStatus,'unconfirmed');
 const result=await h.context.cancelViaPublicRoute();assert.equal(result.body.ok,true);assert.equal(result.body.cancellation.deliveryIntentCancelled,true);
 assert.equal(result.body.cancellation.sourceInput,'unknown');assert.equal(result.body.cancellation.tooLate,false);
 const after=h.receipts.get(key);assert.equal(after.attemptId,before.attemptId);assert.equal(after.state,before.state);assert.deepEqual(after.receipt,before.receipt);
 await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,1);assert.equal(h.promote().promoted,true);
 const again=await h.context.cancelViaPublicRoute();assert.equal(again.body.cancellation.sourceInput,'confirmed');assert.equal(again.body.cancellation.tooLate,true);
 await h.service.deliver('R');assert.equal(h.effects.inputs.length,1);
});
test('public cancel reports tooLate for a confirmed source input while retaining completed result',async t=>{
 const h=await fixture(t,{operationalPrompts:false});await h.service.deliver('R');assert.equal(h.effects.inputs.length,1);
 const result=await h.context.cancelViaPublicRoute();assert.equal(result.body.ok,true);assert.equal(result.body.cancellation.tooLate,true);
 assert.equal(result.body.cancellation.sourceInput,'confirmed');assert.equal(result.body.run.status,'completed');assert.equal(result.body.run.resultComplete,true);
});
test('cancellation strict write failure has no success ACK, and same cancel retry preserves suppression',async t=>{
 const h=await fixture(t,{operationalPrompts:false});const rename=fs.promises.rename;let fail=true;
 fs.promises.rename=async(from,to)=>{if(to===h.file&&fail){fail=false;throw Object.assign(Error('cancel rename failed'),{code:'EIO'});}return rename(from,to);};
 try{await assert.rejects(h.context.cancelViaPublicRoute(),/cancel rename failed/);}finally{fs.promises.rename=rename;}
 assert.equal((await h.runs.get('R')).notificationSuppressed,true);assert.equal((await h.context.cancelViaPublicRoute()).body.ok,true);
 await h.reopen();await h.service.deliver('R');assert.equal(h.effects.inputs.length,0);
});
test('ACTIVE FIFO HEAD suppression cancels original admission',async t=>{const h=await fixture(t,{ready:false});let admit;const admitted=new Promise(r=>admit=r);h.hooks.afterEnqueue=async()=>admit();
 const pending=h.run();await bounded(admitted);await h.runs.markNotification('R','suppressed');h.hooks.ready=true;h.queue.resume();await pending;assert.equal(h.effects.inputs.length,0);assert.equal(h.queue.item('history:source:orchestration-complete:R').state,'cancelled');});
test('full final overtakes queued local warning and no obsolete wake follows',async t=>{const h=await fixture(t,{failures:1,ready:false});let admit;const admitted=new Promise(r=>admit=r);h.hooks.afterEnqueue=async()=>admit();
 const pending=h.run();await bounded(admitted);await h.op.drain();const r=await h.runs.getInternal('R'),n=Object.values(r.externalResearchOperational.notices).find(n=>n.origin==='noted-delivery');
 assert.equal(n.delivery,'suppressed');assert(n.cancellationConfirmed);h.hooks.ready=true;h.queue.resume();await pending;assert.equal(h.effects.inputs.length,1);assert(h.effects.inputs[0].completionDeliveryRef);
 h.op.schedule('R');await h.op.drain();assert.equal(h.effects.inputs.length,1);});
test('oversized reference remains exact job/session, never partial final',async t=>{const h=await fixture(t,{body:'Q'.repeat(250100)});await h.run();const c=h.contents.get('R');assert.equal(c.mode,'reference');assert.equal(c.metadata.jobId,'noted_R');assert.equal(c.metadata.sourceSessionId,'source-S');assert(!c.prompt.includes('Q'.repeat(100)));assert.equal(h.effects.reads,1);await h.reopen();await h.run();assert.equal(h.effects.reads,1);});
test('legacy absence and unconfirmed never authorize automatic input',async t=>{const h=await fixture(t);await h.runs.patch('R',{externalResearchDelivery:null,notificationStatus:'unconfirmed',notificationAttemptedAt:1});await h.runs.persistStrict();await h.reopen();await h.run();assert.equal(h.effects.sends,0);assert.equal(h.effects.reads,0);});

test('exact no-input refusal resumes on source readiness with same FIFO/handoff and frozen options',async t=>{
 const h=await fixture(t);let first=true;h.hooks.beforeInput=async()=>{if(first){first=false;throw Object.assign(Error('owned prepare unavailable'),{code:'EIO'});}};
 await h.run();assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,0);
 const before=h.queue.item('history:source:orchestration-complete:R');assert.equal(before.state,'failed');
 await h.context.sendOrchestrationCompletionNotification(await h.runs.getInternal('R'),{sourceReady:true});
 assert.equal(h.queue.item(before.operation_key).id,before.id);assert.equal(h.effects.reads,1);
 assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);
});
for(const change of['replace','notify-off'])test(`ACTIVE HEAD ${change} preserves original owner and forbids input`,async t=>{
 const h=await fixture(t,{ready:false});let admit;const admitted=new Promise(r=>admit=r);h.hooks.afterEnqueue=async()=>admit();
 const pending=h.run();await bounded(admitted);
 await h.runs.patch('R',change==='replace'?{sourceSendTarget:{toolType:'codex',sessionId:'foreign'}}:{notifySource:false});await h.runs.persistStrict();
 h.hooks.ready=true;h.queue.resume();await pending;assert.equal(h.effects.inputs.length,0);
 assert.equal(h.receipts.get('history:source:orchestration-complete:R').deliveryControl.reason,'external-completion-revoked');
});
test('actual startup function restores local preparation; does not mark it UNKNOWN as attempted input',async t=>{
 const h=await fixture(t,{failures:1});await h.service.deliver('R');await h.reopen();
 await h.context.reconcileActiveOrchestrations();await h.run();
 assert.equal(h.effects.reads,2);assert.equal(h.effects.starts,0);assert((await h.runs.getInternal('R')).sourceFollowupStartedAt);
});
test('long local outage retains one durable DELIVERING notice without automatic Telegram when source input is blocked',async t=>{
 const h=await fixture(t,{failures:10});h.hooks.blockNotice=true;
 await h.service.deliver('R');await h.op.drain();
 const run=await h.runs.getInternal('R');assert.equal(run.status,'completed');assert.equal(run.externalResearchOperational.delivery.phase,'delivering');
 const notice=Object.values(run.externalResearchOperational.notices).find(n=>n.origin==='noted-delivery');
 assert.equal(notice.delivery,'waiting_for_input');assert.deepEqual(h.effects.human,[]);
 assert.equal(run.sourceFollowupStartedAt,null);assert.equal(h.effects.starts,0);
});
for(const maintenance of [false,true])test((maintenance?'planned maintenance':'UI-only operational policy')+' keeps delivery state, quiet Telegram and exactly one automatic full final input',async t=>{
 const h=await fixture(t,{failures:1,operationalPrompts:maintenance,maintenance});
 await h.service.deliver('R');await h.op.drain();
 const pending=await h.runs.getInternal('R');
 const notice=Object.values(pending.externalResearchOperational.notices).find(n=>n.origin==='noted-delivery');
 assert.equal(notice.delivery,'suppressed');assert.equal(notice.suppressionReason,maintenance?'planned_maintenance':'operational_prompts_disabled');
 assert.equal(h.effects.inputs.length,0);assert.equal(h.effects.human.length,0);
 await h.reopen();await h.run();
 const after=await h.runs.getInternal('R');
 assert.equal(after.externalResearchOperationalPrompts,maintenance);assert.equal(after.notifySource,true);
 assert.equal(after.externalResearchDelivery.phase,'delivered');
 assert.equal(h.effects.inputs.length,1);assert(h.effects.inputs[0].completionDeliveryRef);
 assert.equal(h.effects.starts,0);assert.equal(h.effects.reads,2);
});

test('lost admission ACK while FIFO waits survives reopen without another enqueue',async t=>{
 const h=await fixture(t,{ready:false});h.hooks.afterEnqueue=async()=>{throw Error('owned lost ACK');};
 await h.run();assert.equal((await h.runs.getInternal('R')).externalResearchDelivery.phase,'queued');
 const key='history:source:orchestration-complete:R',id=h.queue.item(key).id;
 await h.reopen();await h.run();assert.equal(h.effects.sends,1);assert.equal(h.queue.item(key).id,id);
 h.hooks.ready=true;h.queue.resume();await bounded(h.queue.result(key));await h.run();
 assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);assert.equal(h.effects.sends,1);assert.equal(h.effects.reads,1);
});
test('frozen request rejects added settings and foreign source/hash; no-input proof requires explicit negative fields',async t=>{
 const h=await fixture(t,{ready:false});h.hooks.afterEnqueue=async()=>{throw Error('owned ACK loss');};await h.run();
 const run=await h.runs.getInternal('R'),request=local.frozenRequest(run.externalResearchDelivery);
 for(const patch of[{model:'changed'},{queue:!request.queue},{expectedTarget:{toolType:'codex',sessionId:'other'}},{prompt:request.prompt+'!'}])
   await assert.rejects(local.resolveCompletionRequest(h.runs,{...request,...patch}),/no longer authorized/);
 const predicate=require('../shared/agent-send-receipt-control.cjs').isExternalCompletionNoInputReceipt;
 const rec={...h.receipts.get(request.sendOperationKey),state:'not-submitted',receipt:{submitted:false}};
 assert.equal(predicate(rec,request),false);rec.receipt={submitted:false,pasteWritten:false,enterWritten:false};assert.equal(predicate(rec,request),true);
 rec.receipt.deliveryUnknown=true;assert.equal(predicate(rec,request),false);
});
test('prolonged metadata write outage cannot ACK RAM or input and cannot emit automatic Telegram',async t=>{
 const h=await fixture(t);const rename=fs.promises.rename;
 fs.promises.rename=async(from,to)=>{if(to===h.file)throw Object.assign(Error('owned persist outage'),{code:'EACCES'});return rename(from,to);};
 try{await assert.rejects(h.service.deliver('R'),/owned persist outage/);await h.op.drain();
 assert.equal(h.effects.inputs.length,0);assert.equal(h.effects.human.length,0);
 const disk=JSON.parse(fs.readFileSync(h.file)).runs.find(r=>r.runId==='R');assert.equal(disk.externalResearchDelivery.lastError,null);
 }finally{fs.promises.rename=rename;}
 await h.run();assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,1);assert.equal(h.effects.starts,0);
});
test('legacy failed completion is adopted for receipt-only recovery, never inferred as no-input',async t=>{
 const h=await fixture(t);h.hooks.blockNotice=true;
 await h.runs.patch('R',{externalResearchDelivery:null,notificationStatus:'failed'});await h.runs.persistStrict();await h.reopen();
 await h.context.reconcileActiveOrchestrations();await h.run();await h.op.drain();
 const r=await h.runs.getInternal('R');assert.equal(r.externalResearchDelivery.legacy,true);assert.equal(r.notificationStatus,'unconfirmed');
 assert.equal(h.effects.sends,0);assert.equal(h.effects.reads,0);assert.equal(h.effects.starts,0);assert.equal(r.status,'completed');
});
test('legacy canonical receipt remains recoverable without rebuilding payload or sending again',async t=>{
 const h=await fixture(t,{audit:false});await h.run();await h.coordinator.stop();
 assert.equal(h.promote().promoted,true);await h.runs.patch('R',{externalResearchDelivery:null,notificationStatus:'unconfirmed'});await h.runs.persistStrict();
 await h.reopen();await h.context.reconcileActiveOrchestrations();await h.run();
 assert((await h.runs.getInternal('R')).sourceFollowupStartedAt);assert.equal(h.effects.sends,1);assert.equal(h.effects.reads,1);
});
test('loaded active legacy row stays observational when SC later reports done',async t=>{
 const h=await fixture(t);
 await h.reopen(file=>{
   const disk=JSON.parse(fs.readFileSync(file)),old=disk.runs.find(r=>r.runId==='R');
   const keep=['runId','runKind','createdAt','sourceTabId','sourceProjectId','sourceSessionId','sourceToolType','sourceSendTarget',
     'externalResearchJobId','externalResearchIntent','externalResearchProvider','requestFingerprint','notifySource'];
   const legacy=Object.fromEntries(keep.filter(k=>Object.hasOwn(old,k)).map(k=>[k,old[k]]));
   Object.assign(legacy,{status:'running',externalResearchStatus:'running',resultComplete:false,notificationStatus:'pending'});
   disk.runs=[legacy];fs.writeFileSync(file,JSON.stringify(disk));
 });
 const before=await h.runs.getInternal('R');assert.equal(before.status,'running');assert(!before.externalResearchDelivery);
 await h.run();
 const after=await h.runs.getInternal('R');
 console.log('[OwnedLegacyActiveAcceptance] '+JSON.stringify({status:after.status,delivery:after.externalResearchDelivery?.phase,
   legacy:after.externalResearchDelivery?.legacy||false,finalInputs:h.effects.inputs.filter(r=>r.completionDeliveryRef).length,reads:h.effects.reads,starts:h.effects.starts}));
 assert.equal(h.effects.inputs.filter(r=>r.completionDeliveryRef).length,0,'absence of modern fields in a loaded active legacy row is not proof that source input never happened');
 await h.op.drain();
 assert.equal(after.externalResearchDelivery.legacy,true);assert.equal(after.notificationStatus,'unconfirmed');
 assert.equal(h.effects.reads,1,'only the original job status is read, no new final-body preparation');
 assert.equal(h.effects.starts,0);assert.equal(h.contents.get('R'),null);
 assert(Object.values(after.externalResearchOperational.notices).some(n=>n.origin==='noted-delivery'));
 assert(h.effects.inputs.every(r=>r.operationalNoticeRef),'only the separate operational notice may enter');
});


function oldRow(disk, status, patch = {}) {
  const old = disk.runs.find(r => r.runId === 'R');
  const keys = ['runId', 'runKind', 'createdAt', 'sourceTabId', 'sourceProjectId', 'sourceSessionId', 'sourceToolType',
    'sourceSendTarget', 'externalResearchJobId', 'externalResearchIntent', 'externalResearchProvider', 'requestFingerprint', 'notifySource'];
  const row = Object.fromEntries(keys.filter(k => Object.hasOwn(old, k)).map(k => [k, old[k]]));
  Object.assign(row, { status, externalResearchStatus: status === 'completed' ? 'done' : 'running',
    resultComplete: ['completed', 'failed'].includes(status), notificationStatus: 'pending' }, patch);
  disk.runs = [row];
  return row;
}
function editDisk(file, edit) {
  const disk = JSON.parse(fs.readFileSync(file)); edit(disk); fs.writeFileSync(file, JSON.stringify(disk));
}
for (const status of ['creating', 'running']) test('modern birth survives ' + status + ' restart and same-ID retry before terminal', async t => {
  const h = await fixture(t, { terminal: false });
  const original = await h.runs.getInternal('R'), birth = structuredClone(original.externalResearchDeliveryBirth);
  assert(local.hasBirth(original)); assert.equal(original.externalResearchDelivery, null);
  if (status === 'running') await h.runs.applyExternalResearchSnapshot('R', { id: 'noted_R', status: 'running' });
  await h.reopen(); const before = await h.runs.getInternal('R');
  assert.deepEqual(before.externalResearchDeliveryBirth, birth); assert.equal(before.status, status);
  const repeated = await h.runs.reserveOrGet({ ...before, externalResearchDeliveryBirth: { version: 999, id: 'caller' } });
  assert.equal(repeated.created, false); assert.equal(repeated.conflict, false);
  assert.deepEqual((await h.runs.getInternal('R')).externalResearchDeliveryBirth, birth);
  assert.equal(Object.hasOwn(repeated.run, 'externalResearchDeliveryBirth'), false, 'private acceptance proof is not caller authority');
  await h.run(); const after = await h.runs.getInternal('R');
  assert(local.canAdmit(after)); assert.equal(after.externalResearchDelivery.birthId, birth.id);
  assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 1);
  assert.equal(h.effects.reads, 2); assert.equal(h.effects.starts, 0);
});
for (const status of ['creating', 'completed', 'failed']) test('loaded legacy ' + status + ' stays receipt-only across same-ID retry and startup', async t => {
  const h = await fixture(t); h.hooks.blockNotice = true;
  await h.reopen(file => editDisk(file, disk => oldRow(disk, status)));
  const before = await h.runs.getInternal('R'); assert(!before.externalResearchDeliveryBirth);
  const retry = await h.runs.reserveOrGet({ ...before, externalResearchDeliveryBirth: local.createBirth(before) });
  assert.equal(retry.created, false); assert.equal(retry.conflict, false);
  assert(!(await h.runs.getInternal('R')).externalResearchDeliveryBirth);
  await h.context.reconcileActiveOrchestrations(); await h.run(); await h.op.drain();
  const after = await h.runs.getInternal('R');
  assert.equal(after.status, status === 'failed' ? 'failed' : 'completed');
  assert.equal(after.externalResearchDelivery.legacy, true); assert.equal(after.externalResearchDelivery.phase, 'unknown');
  assert.equal(h.effects.sends, 0); assert.equal(h.effects.reads, status === 'creating' ? 1 : 0); assert.equal(h.effects.starts, 0);
  assert.equal(h.effects.human.length, 0, 'ambiguous historical delivery remains in app state without automatic Telegram');
  assert(Object.values(after.externalResearchOperational.notices).some(n => n.origin === 'noted-delivery'));
  assert.equal(h.receipts.get('history:source:orchestration-complete:R'), null);
});
for (const state of ['cancelled', 'suppressed', 'cancel-requested', 'notify-off']) test('legacy ' + state + ' is not reopened by cohort adoption', async t => {
  const h = await fixture(t); await h.reopen(file => editDisk(file, disk => oldRow(disk, state === 'cancelled' ? 'cancelled' : 'completed',
    state === 'suppressed' ? { notificationStatus: 'suppressed', notificationSuppressed: true }
      : state === 'cancel-requested' ? { notificationCancelRequestedAt: 123 } : state === 'notify-off' ? { notifySource: false } : {})));
  const before = await h.runs.getInternal('R');
  await h.context.reconcileActiveOrchestrations(); await h.run(); await h.op.drain();
  const after = await h.runs.getInternal('R');
  for (const key of ['status', 'notificationStatus', 'notificationSuppressed', 'notificationCancelRequestedAt', 'notifySource']) assert.equal(after[key], before[key]);
  assert.equal(h.effects.inputs.length, 0); assert.equal(h.effects.reads, 0); assert.equal(h.effects.starts, 0);
  assert(!after.externalResearchDeliveryBirth);
});
for (const lostAck of [false, true]) test('external reservation ' + (lostAck ? 'lost strict ACK' : 'failed strict write') + ' keeps one birth and retries exact acceptance', async t => {
  const h = await fixture(t, { terminal: false }); const base = await h.runs.getInternal('R');
  const input = { ...base, runId: 'R2', externalResearchJobId: 'noted_R2', requestFingerprint: 'second-request',
    externalResearchDeliveryBirth: { id: 'caller-proof' }, externalResearchDelivery: { phase: 'admitting' } };
  const rename = fs.promises.rename; let failing = true;
  fs.promises.rename = async (from, to) => {
    if (to === h.file && failing) {
      if (lostAck) await rename(from, to);
      throw Object.assign(Error('owned reservation failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  let birth;
  try {
    await assert.rejects(h.runs.reserveOrGet(input), /owned reservation failure/);
    const pending = await h.runs.getInternal('R2'); birth = structuredClone(pending.externalResearchDeliveryBirth);
    assert(local.hasBirth(pending)); assert.notEqual(birth.id, 'caller-proof'); assert.equal(pending.externalResearchDelivery, null);
    assert.equal(JSON.parse(fs.readFileSync(h.file)).runs.some(r => r.runId === 'R2'), lostAck);
    await assert.rejects(h.runs.reserveOrGet(input), /owned reservation failure/, 'existing RAM reservation cannot ACK failed persistence');
    await assert.rejects(h.runs.applyExternalResearchSnapshot('R2', { id: 'noted_R2', status: 'done', result: { text: 'same' } }), /owned reservation failure/);
    assert.equal((await h.runs.getInternal('R2')).status, 'creating'); assert.equal(h.effects.inputs.length, 0);
    assert.equal((await h.runs.reserveOrGet({ ...input, requestFingerprint: 'different' })).conflict, true);
  } finally { failing = false; fs.promises.rename = rename; }
  const accepted = await h.runs.reserveOrGet(input); assert.equal(accepted.created, false); assert.equal(accepted.conflict, false);
  assert.deepEqual((await h.runs.getInternal('R2')).externalResearchDeliveryBirth, birth);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file)).runs.find(r => r.runId === 'R2').externalResearchDeliveryBirth, birth);
  await h.reopen(); assert.deepEqual((await h.runs.getInternal('R2')).externalResearchDeliveryBirth, birth);
});
test('lost reservation ACK followed by process reopen reads the original durable birth', async t => {
  const h = await fixture(t, { terminal: false }), input = { ...(await h.runs.getInternal('R')), runId: 'R2', externalResearchJobId: 'noted_R2' };
  const strict = h.runs.persistStrict.bind(h.runs);
  h.runs.persistStrict = async () => { await strict(); throw Error('owned lost ACK'); };
  await assert.rejects(h.runs.reserveOrGet(input), /owned lost ACK/);
  const birth = (await h.runs.getInternal('R2')).externalResearchDeliveryBirth;
  h.runs.persistStrict = strict; await h.reopen();
  const retried = await h.runs.reserveOrGet(input); assert.equal(retried.created, false);
  assert.deepEqual((await h.runs.getInternal('R2')).externalResearchDeliveryBirth, birth);
});
for (const afterRename of [false, true]) test('modern terminal commit failure ' + (afterRename ? 'after rename' : 'before rename and restart') + ' preserves local autonomy', async t => {
  const h = await fixture(t, { terminal: false }), birth = (await h.runs.getInternal('R')).externalResearchDeliveryBirth;
  const rename = fs.promises.rename; let failed = false;
  fs.promises.rename = async (from, to) => {
    if (to === h.file && !failed) { failed = true; if (afterRename) await rename(from, to); throw Error('owned terminal ACK/write failure'); }
    return rename(from, to);
  };
  try { await assert.rejects(h.runs.applyExternalResearchSnapshot('R', { id: 'noted_R', status: 'done', result: { text: 'FULL exact expert result' } }), /owned terminal/); }
  finally { fs.promises.rename = rename; }
  assert.equal(h.effects.inputs.length, 0);
  await h.reopen(); await h.run();
  assert.deepEqual((await h.runs.getInternal('R')).externalResearchDeliveryBirth, birth);
  assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 1); assert.equal(h.effects.starts, 0);
  assert.equal(h.effects.reads, afterRename ? 1 : 2);
});
test('old frozen delivery without birth remains receipt-only and preserves its existing FIFO identity', async t => {
  const h = await fixture(t, { ready: false }); h.hooks.afterEnqueue = async () => { throw Error('owned lost ACK'); };
  await h.run(); const original = structuredClone((await h.runs.getInternal('R')).externalResearchDelivery);
  await h.reopen(file => editDisk(file, disk => { const row = disk.runs[0]; delete row.externalResearchDeliveryBirth; delete row.externalResearchDelivery.birthId; }));
  await h.run(); assert.equal(h.effects.sends, 1); assert.equal(h.effects.reads, 1);
  const after = await h.runs.getInternal('R');
  assert.equal(after.externalResearchDelivery.id, original.id); assert.deepEqual(after.externalResearchDelivery.request, original.request);
  assert.equal(after.externalResearchDelivery.requestHash, original.requestHash); assert.equal(after.notificationStatus, 'unconfirmed');
  assert(h.receipts.listOwnerPins(local.PIN).includes(original.request.sendOperationKey));
  await assert.rejects(local.resolveCompletionRequest(h.runs, local.frozenRequest(after.externalResearchDelivery)), /no longer authorized/);
  h.hooks.ready = true; h.queue.resume(); await bounded(h.queue.result(original.request.sendOperationKey));
  assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 0);
});
test('old frozen birthless canonical receipt still settles without new body or input', async t => {
  const h = await fixture(t, { audit: false }); await h.run(); await h.coordinator.stop(); assert.equal(h.promote().promoted, true);
  await h.reopen(file => editDisk(file, disk => { delete disk.runs[0].externalResearchDeliveryBirth; delete disk.runs[0].externalResearchDelivery.birthId; }));
  await h.run(); assert((await h.runs.getInternal('R')).sourceFollowupStartedAt);
  assert.equal(h.effects.sends, 1); assert.equal(h.effects.reads, 1); assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 1);
});
test('birth is immutable and does not rebind a changed source before terminal', async t => {
  const h = await fixture(t, { terminal: false }); const before = await h.runs.getInternal('R');
  await assert.rejects(h.runs.patch('R', { externalResearchDeliveryBirth: local.createBirth(before) }), /birth_immutable/);
  await h.runs.patch('R', { sourceSendTarget: { toolType: 'codex', sessionId: 'foreign' } }); await h.runs.persistStrict();
  await h.reopen(); await h.run(); await h.op.drain();
  const after = await h.runs.getInternal('R'); assert.equal(local.hasBirth(after), false);
  assert.equal(after.externalResearchDelivery.sourceTarget.sessionId, 'source-S', 'original acceptance owner is retained');
  assert.equal(h.effects.inputs.length, 0); assert.equal(h.effects.sends, 0); assert.equal(h.effects.starts, 0);
});

for (const modern of [false, true]) test((modern ? 'modern' : 'birthless') + ' frozen request cannot infer no-input from a replacement empty receipt journal', async t => {
  const h = await fixture(t, { ready: false }); h.hooks.afterEnqueue = async () => { throw Error('owned admission ACK loss'); };
  await h.run(); const original = structuredClone((await h.runs.getInternal('R')).externalResearchDelivery);
  await h.reopen(file => {
    if (!modern) editDisk(file, disk => { delete disk.runs[0].externalResearchDeliveryBirth; delete disk.runs[0].externalResearchDelivery.birthId; });
    fs.unlinkSync(h.sql); // Only the closed, private fixture database: simulate missing coverage.
  });
  assert.equal(h.receipts.get(original.request.sendOperationKey), null);
  assert.equal(h.receipts.listOwnerPins(local.PIN).length, 0);
  await h.run(); const after = await h.runs.getInternal('R');
  assert.equal(after.notificationStatus, 'unconfirmed'); assert.equal(after.externalResearchDelivery.id, original.id);
  assert.equal(h.effects.sends, 1); assert.equal(h.effects.reads, 1);
  assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 0); assert.equal(h.effects.starts, 0);
});
test('direct fresh external create also awaits strict birth commit; caller proof cannot bypass it', async t => {
  const h = await fixture(t, { terminal: false }), input = { ...(await h.runs.getInternal('R')), runId: 'R2', externalResearchJobId: 'noted_R2' };
  const strict = h.runs.persistStrict.bind(h.runs);
  h.runs.persistStrict = async () => { throw Error('owned direct-create disk failure'); };
  await assert.rejects(h.runs.create(input), /owned direct-create disk failure/);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).runs.some(r => r.runId === 'R2'), false);
  assert.equal(h.effects.inputs.length, 0);
  h.runs.persistStrict = strict;
  const pending = await h.runs.getInternal('R2');
  await h.runs.reserveOrGet(input);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file)).runs.find(r => r.runId === 'R2').externalResearchDeliveryBirth, pending.externalResearchDeliveryBirth);
});

test('failed RunStore load is not an empty cohort and cannot mint birth over unreadable old rows', async t => {
  const h = await fixture(t, { terminal: false }), original = structuredClone(await h.runs.getInternal('R'));
  await h.reopen(file => fs.writeFileSync(file, '{owned broken JSON'));
  await assert.rejects(h.runs.getInternal('R'), { code: 'orchestration_store_unavailable', statusCode: 503 });
  await assert.rejects(h.runs.reserveOrGet(original), { code: 'external_research_birth_store_unavailable', statusCode: 503 });
  assert.equal(fs.readFileSync(h.file, 'utf8'), '{owned broken JSON');
  assert.equal(h.effects.inputs.length, 0); assert.equal(h.effects.starts, 0);
});

test('unrelated strict write recovers intact failed-load authority before an external retry', async t => {
  const h = await fixture(t, { terminal: false });
  await h.reopen(file => editDisk(file, disk => { delete disk.runs[0].externalResearchDeliveryBirth; }));
  const legacy = structuredClone(await h.runs.getInternal('R'));
  assert.equal(local.hasBirth(legacy), false);
  const originalBytes = fs.readFileSync(h.file), readFile = fs.promises.readFile;
  let failedRead = false;
  fs.promises.readFile = async (...args) => {
    if (args[0] === h.file && !failedRead) {
      failedRead = true;
      throw Object.assign(Error('owned transient RunStore read EIO'), { code: 'EIO' });
    }
    return readFile(...args);
  };
  try { await h.reopen(); } finally { fs.promises.readFile = readFile; }
  assert.equal(failedRead, true);
  assert.equal(h.runs.activityReadError, 'orchestration-load-failed');
  assert.equal(h.runs.runs.size, 0, 'failed read is unknown, not an authoritative empty store');
  assert.deepEqual(fs.readFileSync(h.file), originalBytes, 'transient read did not change the valid old store');
  await h.runs.create({ runId: 'owned-unrelated', runKind: 'agent', targetTabId: 'owned-target',
    sourceTabId: 'source', sourceProjectId: 'P', notifySource: false }, { persistStrict: true });
  const rewritten = JSON.parse(fs.readFileSync(h.file));
  assert.deepEqual(rewritten.runs.map(r => r.runId), ['R', 'owned-unrelated']);
  assert.equal(local.hasBirth(rewritten.runs[0]), false);
  await h.reopen();
  const accepted = await h.runs.reserveOrGet(legacy);
  assert.equal(accepted.created, false);
  assert.equal(accepted.conflict, false);
  await h.run();
  const after = await h.runs.getInternal('R');
  const finalInputs = h.effects.inputs.filter(r => r.completionDeliveryRef).length;
  console.log('[OwnedFailedLoadInterleavingAcceptance] ' + JSON.stringify({ unrelatedRewrite: false,
    recreated: accepted.created, birth: local.hasBirth(after), legacy: after.externalResearchDelivery?.legacy || false,
    finalInputs, reads: h.effects.reads, starts: h.effects.starts }));
  assert.equal(finalInputs, 0, 'another run type cannot turn failed old-store coverage into proof of fresh external intent');
  assert.equal(local.hasBirth(after), false); assert.equal(after.externalResearchDelivery.legacy, true);
  assert.equal(h.effects.reads, 1); assert.equal(h.effects.starts, 0);
  await h.op.drain(); assert.equal(h.effects.human.length, 0);
});

test('actual startup retries transient store reads then automatically completes the same modern job', async t => {
  const h = await fixture(t, { terminal: false }), before = structuredClone(await h.runs.getInternal('R'));
  const read = fs.promises.readFile; let failures = 3, attempts = 0;
  fs.promises.readFile = async (...args) => {
    if (args[0] === h.file) { attempts++; if (failures-- > 0) throw Object.assign(Error('owned startup EIO'), { code: 'EIO' }); }
    return read(...args);
  };
  try {
    await h.reopen(); await h.context.startOrchestrationStartupRecovery();
    assert.equal(h.effects.inputs.length, 0); assert.equal(h.effects.reads, 0);
    await bounded((async () => {
      while (!h.effects.inputs.some(r => r.completionDeliveryRef)) await new Promise(r => setTimeout(r, 10));
    })());
    await bounded(h.coordinator.watch('R')); // joins the original automatic watcher
  } finally { fs.promises.readFile = read; }
  const after = await h.runs.getInternal('R');
  assert.deepEqual(after.externalResearchDeliveryBirth, before.externalResearchDeliveryBirth);
  assert.deepEqual(after.externalResearchIntent, before.externalResearchIntent);
  assert.equal(attempts, 4); assert.equal(h.effects.starts, 0); assert.equal(h.effects.reads, 2);
  assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 1);
  assert.equal(after.externalResearchDelivery.phase, 'delivered');
});

for (const action of ['cancel', 'suppress']) test('recovered load then failed strict ' + action + ' ACK cannot release the existing FIFO HEAD', async t => {
  const h = await fixture(t, { ready: false });
  h.hooks.afterEnqueue = async () => { throw Error('owned queued ACK loss'); };
  await h.run(); const saved = structuredClone((await h.runs.getInternal('R')).externalResearchDelivery);
  const read = fs.promises.readFile, rename = fs.promises.rename; let failedRead = false, failWrite = true;
  fs.promises.readFile = async (...args) => {
    if (args[0] === h.file && !failedRead) { failedRead = true; throw Object.assign(Error('owned reopen EIO'), { code: 'EIO' }); }
    return read(...args);
  };
  try { await h.reopen(); } finally { fs.promises.readFile = read; }
  const mutate = () => action === 'suppress' ? h.runs.markNotification('R', 'suppressed')
    : h.runs.cancel('R', { suppressNotification: false });
  // Existing completed runs are suppressed through their existing attention
  // control; cancellation is exercised on an active row with the same queue.
  if (action === 'cancel') await h.runs.patch('R', { status: 'running', resultComplete: false });
  await h.runs.flush();
  fs.promises.rename = async (from, to) => {
    if (to === h.file && failWrite) throw Error('owned cancel write failure');
    return rename(from, to);
  };
  try {
    await assert.rejects(mutate(), /owned cancel write failure/); await h.runs.flush();
    h.hooks.ready = true; h.queue.resume(); await bounded(h.queue.result(saved.request.sendOperationKey));
    assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 0);
    failWrite = false; await mutate();
  } finally { fs.promises.rename = rename; }
  await h.reopen(); await h.run();
  const after = await h.runs.getInternal('R');
  assert.equal(after.externalResearchDelivery.id, saved.id);
  assert.equal(after.externalResearchDelivery.requestHash, saved.requestHash);
  assert.equal(h.effects.inputs.filter(r => r.completionDeliveryRef).length, 0);
  assert.equal(h.effects.starts, 0);
});
