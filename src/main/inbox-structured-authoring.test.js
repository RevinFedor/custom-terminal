'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const vm=require('node:vm'),ts=require('typescript'),http=require('node:http'),crypto=require('node:crypto');
const structured=require('./structured-authoring');
const registry=require('./agent-send-receipt-registry');
const {classifyAgentSendReceipt}=require('./orchestration-runs');
const {resolveOrchestrationSendOptions}=require('./orchestration-request-plan');
const {agentSendTargetPreconditionFailure}=require('./agent-send-target-precondition');
const {withPromptOriginPresentation}=require('./history-prompt-presentations');
const {promptAuditFingerprint}=require('./prompt-audit-fingerprint');
const {buildCodexImagePastePlan}=require('./codex-image-transport');
const source=fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8');
const tree=ts.createSourceFile('web.js',source,ts.ScriptTarget.Latest,true);
const fn=name=>{const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node,name);return node.getText(tree);};

async function harness(t,{durable=false,unknown=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'inbox-authoring-'));
 const image=path.join(root,'one.png');fs.writeFileSync(image,Buffer.from('89504e470d0a1a0a','hex'));
 let sql=null,store=null;
 if(durable){
   const Sqlite=require('better-sqlite3');try{sql=new Sqlite(path.join(root,'db'));}
   catch(e){fs.rmSync(root,{recursive:true,force:true});if(e.code==='ERR_DLOPEN_FAILED'){t.skip('Electron ABI');return null;}throw e;}
   store=new(require('./agent-send-receipt-store').AgentSendReceiptStore)(sql);
 }
 const calls=[],runs=new Map();let changed=false;
 const descriptor=()=>({tabId:'T',toolType:'codex',tabType:'terminal',projectId:'__noted_inbox__',sessionId:changed?'OTHER':'S'});
 const cleanOptionalString=(v,f='')=>typeof v==='string'?v.trim()||f:f;
 const sendJson=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 const ctx={...structured,...registry,AGENT_SEND_RECEIPT_STATES:registry.RECEIPT_STATES,classifyAgentSendReceipt,resolveOrchestrationSendOptions,
   agentSendTargetPreconditionFailure,withPromptOriginPresentation,promptAuditFingerprint,crypto,console:{log(){},warn(){}},shortId:x=>x,
   agentSendReceiptStartupReady:Promise.resolve(),agentSendReceiptStore:store,agentSendReceiptRegistry:registry.createAgentSendReceiptRegistry(),agentSendBridgeTimeoutMs:1000,
   externalRuns:runs,externalRunByTabId:new Map(),externalRunByConversationKey:new Map(),INBOX_PROJECT_ID:'__noted_inbox__',
   inboxSavedHistoryOperations:{assertAvailable:()=>{if(ctx.held)throw Object.assign(Error('inbox_history_operation_pending'),{statusCode:409});}},
   cleanOptionalString,clampAutoStopMs:v=>v??30000,clampAutoCloseMs:v=>v??900000,assertAgentProviderModel(){},
   reservedInboxTabId:()=> 'T',clearExternalRunTimer(){},setExternalRunMeta(){},webBroadcast(){},findOrchestrationTabDescriptor:descriptor,
   tabWorkContext:{prepare:async(_tab,_id,prompt)=>{calls.push(['context']);return{prompt:'<saved_prompt name="Pending" context-update-id="pending">context</saved_prompt>\n\n'+prompt};},activate(){},settle(){},release(){}},
   normalizeSendAttachments:input=>{calls.push(['legacy-attachments']);return input||[];},
   resolveInboxAttachmentPrompt:async(prompt,attachments)=>({prompt,attachments,contextFiles:[]}),inboxAttachmentPresentationSnapshot:()=>({promptChips:[],imagePaths:[]}),
   readAgentReadyStatus:async()=>({status:'active',...descriptor()}),prepareReusedInboxTab:async()=>{calls.push(['reuse']);return {status:{status:'active'},resumed:false};},
   waitForAgentReady:async()=>({status:'active',...descriptor()}),codexSessionIdFromAuthoritativeStatus:s=>s.sessionId,
   bridgeRequest:async(action,payload)=>{
     if(action==='ensureInboxProject')return{};
     if(action!=='sendAgentPromptScenario')throw Error('unexpected '+action);
     calls.push(['send',payload]);assert.equal(payload.returnDraftOnConflict,true);assert.equal(payload.workContextPrepared,true);
     const staged=[];
     buildCodexImagePastePlan(payload.prompt,p=>{staged.push(p);return{success:true,path:p,inputPath:'/staged/'+path.basename(p)};},{authoringTransport:payload.presentationSnapshot?.authoringTransport});
     calls.push(['staged',staged]);
     if(unknown)throw Object.assign(Error('reply lost'),{code:'bridge_timeout'});
     const audit={success:true,operationKey:payload.sendOperationKey,attemptId:payload.sendAttemptId,provider:'codex',sessionId:'S',entryUuid:'U',
       sourceIdentity:'US',actualHash:promptAuditFingerprint(payload.prompt),expectedHash:promptAuditFingerprint(payload.prompt),actualText:payload.prompt};
     if(store){const promoted=store.promoteFromAudit(audit);assert.equal(promoted.record.state,'confirmed',JSON.stringify(promoted));}
     return{success:true,submitted:true,status:'sent',exactAuditConfirmed:true,codexAudit:audit,pasteAudit:audit};
   },sendJson,readBody:req=>new Promise((resolve,reject)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});}),
   sendTerminalBridgeError:(res,e)=>sendJson(res,e.statusCode||500,{code:e.code,error:e.message}),
 };
 const names=['runAgentSendScenario','runPreparedAgentSendScenario','externalRunResponseFields','replayExternalRunResponse',
  'sendSendFailure','sendDeliveryUnknown','sendAuditPending','durableAgentSendReplay','durableAgentSendFailure',
  'durableRecordHasProviderQueueAcceptance','externalRunStatusFromDurableRecord',
  'inboxSetupOutcome','inboxSetupRetryable','assertInboxSetupOwner','settleInboxSetupBeforeSend'];
 const start=source.indexOf("  if (parsed.pathname === '/api/inbox/runs' && req.method === 'POST')");
 const end=source.indexOf("  if (parsed.pathname === '/api/inbox/sessions/resume'",start);
 vm.createContext(ctx);vm.runInContext(names.map(fn).join('\n'),ctx);
 const handle=vm.runInContext('(async(req,res,parsed)=>{'+source.slice(start,end)+'})',ctx);
 const server=http.createServer((req,res)=>handle(req,res,{pathname:'/api/inbox/runs'}).catch(e=>sendJson(res,500,{error:e.message})));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>{server.closeAllConnections?.();server.close(r);});sql?.close();fs.rmSync(root,{recursive:true,force:true});});
 const request={runId:'new-explicit-run',provider:'codex',conversationKey:'chat',expectedSessionId:'S',authoring:{version:1,
   parts:[{kind:'text',text:'typed '+image+' before '},{kind:'image',imageId:7},{kind:'paste',chipId:'p'}],
   chips:[{id:'rules',kind:'prompt',label:'Rules',text:'rules',sourceKey:'library:exact',contextUpdateId:'update',inheritanceDepth:1,inheritanceParentLabel:'Parent'},
    {id:'file',kind:'prompt',attachmentKind:'file',label:'Spec',text:'plan',filePath:'/not-read/spec.txt',role:'source',bytes:4,sha256:crypto.createHash('sha256').update('plan').digest('hex')},
    {id:'p',kind:'paste',text:'paste '+image}],imagePaths:[{id:7,path:image}]} };
 return{calls,runs,ctx,store,request,changeTarget:()=>{changed=true;},post:async(body=request)=>{const r=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify(body)});return{...await r.json(),status:r.status};}};
}

for(const durable of [false,true])test('actual Inbox POST -> common authoring/context/send, durable='+durable,async t=>{
 const h=await harness(t,{durable});if(!h)return;
 const r=await h.post();assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.runId,h.request.runId);assert.match(r.resultUrl,/inbox\/runs\/new-explicit-run\/result/);
 const sent=h.calls.find(c=>c[0]==='send')[1];assert.equal(sent.sendOperationKey,'inbox:new-explicit-run');assert.equal(sent.handoffId,'external-run:new-explicit-run');
 assert.equal(sent.expectedSessionId,'S');assert.equal(sent.authoringSnapshot.chips[0].sourceKey,'library:exact');
 assert.equal(sent.presentationSnapshot.promptChips[0].contextUpdateId,'update');assert.equal(sent.presentationSnapshot.promptChips[1].bytes,4);
 assert.deepEqual(h.calls.find(c=>c[0]==='staged')[1],[h.request.authoring.imagePaths[0].path]);
 assert.equal(h.calls.filter(c=>c[0]==='context').length,1);assert.equal(h.calls.some(c=>c[0]==='legacy-attachments'),false);
 if(durable){const record=h.store.get('inbox:new-explicit-run');assert.equal(record.state,'confirmed');assert.equal(record.auditIdentity.attemptId,sent.sendAttemptId);h.runs.clear();}
 assert.equal((await h.post()).status,200);assert.equal(h.calls.filter(c=>c[0]==='send').length,1);
 const altered=structuredClone(h.request);altered.authoring.chips[0].sourceKey='changed';assert.equal((await h.post(altered)).status,409);
});

for(const mutation of ['attachments','text','unknown','wrong-target','missing-session','mixed-resume','pending-history'])test('Inbox authoring refuses '+mutation+' without Send',async t=>{
 const h=await harness(t);const body=structuredClone(h.request);
 if(mutation==='attachments')body.attachments=[{kind:'image',path:'/other.png'}];
 if(mutation==='text')body.text='a second independent body';
 if(mutation==='unknown')body.authoring.version=99;
 if(mutation==='wrong-target')h.changeTarget();
 if(mutation==='missing-session')delete body.expectedSessionId;
 if(mutation==='mixed-resume')body.resumeSessionId='OTHER';
 if(mutation==='pending-history')h.ctx.held=true;
 const r=await h.post(body);assert.ok([400,409].includes(r.status),JSON.stringify(r));assert.equal(h.calls.some(c=>c[0]==='send'),false);
});

test('plain Inbox remains compatible and unknown structured Send is not replayed',async t=>{
 const h=await harness(t,{unknown:true});const r=await h.post();assert.equal(r.status,202,JSON.stringify(r));
 assert.equal((await h.post()).status,202);assert.equal(h.calls.filter(c=>c[0]==='send').length,1);
 const plain=await harness(t);assert.equal((await plain.post({provider:'codex',runId:'plain',conversationKey:'chat',prompt:'plain'})).status,200);
 assert.equal(plain.calls.find(c=>c[0]==='send')[1].authoringSnapshot,undefined);assert.equal(plain.calls.some(c=>c[0]==='legacy-attachments'),true);
});
