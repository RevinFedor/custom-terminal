'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises;
const path=require('node:path'),os=require('node:os'),http=require('node:http'),zlib=require('node:zlib'),vm=require('node:vm');
const {EventEmitter,errorMonitor}=require('node:events'),{Worker}=require('node:worker_threads');
const {createRequire}=require('node:module'),{performance}=require('node:perf_hooks'),{createHash}=require('node:crypto');
const {createHttpReadDiagnostics,beginHttpReadDependency}=require('./http-read-diagnostics');
const ts=require('typescript');
const sourceDirectory=process.env.HTTP_READ_SOURCE_DIR || __dirname;
const web=fs.readFileSync(path.join(sourceDirectory,'web-server.js'),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gate=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),release:()=>resolve()};};
const unpack=x=>JSON.parse(JSON.stringify(x));
function diagnostics(options={}){const records=[];const diag=createHttpReadDiagnostics({serviceId:'fixture-service',
  detailPerMinute:10000,terminalPerMinute:1000,log:line=>records.push(JSON.parse(line.slice('[HttpRead] '.length))),...options});return{diag,records};}
function sendJson(diag,zip=zlib){const start=web.indexOf('function sendJson('),end=web.indexOf('\nfunction sendTerminalBridgeError',start);
 const ctx={httpReadDiagnostics:diag,readPerformance:performance,zlib:zip,GZIP_THRESHOLD:4096,Buffer,console:{log(){}}};
 vm.runInNewContext(web.slice(start,end)+'\nthis.send=sendJson',ctx);return ctx.send;}
async function server(t,handler,diag){const sockets=new Set();let active=0,max=0;
 const s=http.createServer((req,res)=>{active++;max=Math.max(active,max);assert.ok(max<=2,'at most two GETs');res.once('close',()=>active--);
  diag?diag.run(req,res,()=>handler(req,res)):handler(req,res);});
 s.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>s.close(resolve));});
 return{port:s.address().port,max:()=>max};}
function get(port,pathname='/api/terminal-tabs/private-tab/history',headers={}){return new Promise((resolve,reject)=>{
 const req=http.get({hostname:'127.0.0.1',port,path:pathname,headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));
  res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);});}
const ids={'X-Noted-Action-Id':'action-1','X-Noted-Read-Id':'read-1','X-Noted-Read-Attempt':'attempt-1','X-Noted-Ingress-Id':'ingress-1'};
test('real HTTP/zlib: exact Unicode bytes/hash, one stringify, original gzip policy and one terminal',async t=>{
 const f=diagnostics(),send=sendJson(f.diag);let serializations=0;
 const value={entries:Array.from({length:1000},(_,i)=>({uuid:'row-'+i,text:('Привет🌍-'+i).repeat(160)}))};
 const s=await server(t,(_req,res)=>send(res,200,{toJSON(){serializations++;return value;}}),f.diag);
 const response=await get(s.port,undefined,{...ids,'Accept-Encoding':'gzip'});
 const bytes=Buffer.from(JSON.stringify(value));assert.equal(serializations,1);assert.equal(response.status,200);
 assert.deepEqual(zlib.gunzipSync(response.body),bytes);assert.equal(hash(response.body),hash(zlib.gzipSync(bytes,{level:6})));
 assert.equal(Number(response.headers['content-length']),response.body.length);
 assert.equal(response.headers['x-noted-read-attempt'],'attempt-1');
 assert.equal(response.headers['access-control-allow-origin'],'*');
 assert.equal(response.headers['access-control-allow-headers'],'Authorization, Content-Type');
 assert.equal(response.headers.vary,'Accept-Encoding');
 const events=f.records.map(x=>x.event);for(const event of ['http-enter','stringify-begin','stringify-end','gzip-begin','gzip-end','headers-begin','headers-queued','end-call','end-return','http-finish'])assert.ok(events.includes(event),event);
 assert.equal(f.records.filter(x=>x.terminal).length,1);assert.equal(f.diag.snapshot().active.length,0);
 assert.ok(f.records.every(x=>x.attemptId==='attempt-1'&&x.readId==='read-1'));assert.ok(!JSON.stringify(f.records).includes('Привет'));
});
test('small/missing/malformed IDs and normal503 retain business bytes; GET excludes POST/SSE',async t=>{
 const f=diagnostics(),send=sendJson(f.diag);const s=await server(t,(_req,res)=>send(res,503,{error:'fixture'}),f.diag);
 for(const headers of [{},{'X-Noted-Read-Attempt':'BAD_ID'},{'X-Noted-Read-Attempt':'a'.repeat(91)}]){
  const result=await get(s.port,'/api/me?token=PRIVATE_SECRET',headers);assert.equal(result.status,503);assert.equal(result.body.toString(),'{"error":"fixture"}');assert.equal(result.headers['content-encoding'],undefined);}
 assert.equal(f.records.filter(x=>x.event==='http-enter').length,3);assert.ok(f.records.every(x=>x.attemptId===null));assert.ok(!JSON.stringify(f.records).includes('PRIVATE_SECRET'));
 for(const [method,url] of [['POST','/api/terminal-tabs/t/send'],['POST','/api/log'],['GET','/api/events'],['GET','/api/terminal-tabs/t/history/stream']]){
  const req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{method,url,headers:{}});let calls=0;
  assert.equal(f.diag.run(req,res,()=>{calls++;return 17;}),17);assert.equal(calls,1);assert.equal(res.listenerCount('finish'),0);}
});
test('disabled, exhausted and failed observers never repeat/swallow a throwing business operation',()=>{
 for(const options of [{enabled:false},{enabled(){throw Error('observer');}},{activeLimit:0},{log(){throw Error('sink');}}]){
  const {diag}=diagnostics(options),req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/me',headers:{}});res.setHeader=()=>{};
  let calls=0;assert.throws(()=>diag.run(req,res,()=>{calls++;throw null;}),value=>value===null);assert.equal(calls,1);}
});
test('loss and missing terminal are explicit; terminal admission is reserved and records bounded',()=>{
 const f=diagnostics({eventLimit:1,detailPerMinute:1,terminalPerMinute:1,completedLimit:1});
 const req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/me',headers:ids});Object.assign(res,{setHeader(){},statusCode:200});
 let fields=0;f.diag.run(req,res,()=>f.diag.phase(res,'omitted',()=>{fields++;return{};}));assert.equal(fields,0);
 assert.equal(f.diag.snapshot().active[0].httpTerminal,null);res.emit('finish');res.emit('close');
 const snapshot=f.diag.snapshot();assert.ok(snapshot.losses.eventLimit>0);assert.ok(snapshot.lossRanges.length);assert.equal(snapshot.completed[0].httpTerminal,'response-finished');
 assert.equal(f.records.filter(x=>x.terminal).length,1);assert.ok(f.records.every(x=>Buffer.byteLength(JSON.stringify(x))<2048));
 const bad=diagnostics({log(){throw Error('sink');}});const r=new EventEmitter();r.setHeader=()=>{};bad.diag.run(req,r,()=>{});assert.equal(bad.diag.snapshot().losses.sinkError,1);
});
test('response errorMonitor keeps original error semantics and unusual stringify/gzip throws',()=>{
 const f=diagnostics(),req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/me',headers:{}});res.setHeader=()=>{};f.diag.run(req,res,()=>{});
 const error=Error('fixture');assert.throws(()=>res.emit('error',error),x=>x===error);assert.equal(res.listenerCount('error'),0);assert.equal(res.listenerCount(errorMonitor),0);
 for(const gzip of [false,true]){const response=new EventEmitter();Object.assign(response,{req,writableEnded:false,destroyed:false,setHeader(){}});
  req.headers['accept-encoding']=gzip?'gzip':'';
  const send=sendJson(f.diag,gzip?{gzipSync(){throw null;}}:zlib);let caught=false;
  try{f.diag.run(req,response,()=>send(response,200,gzip?{text:'x'.repeat(5000)}:{toJSON(){throw null;}}));}catch(e){caught=true;assert.equal(e,null);}assert.ok(caught);assert.equal(response.headersSent,undefined);}
});
test('before headers: no finish until barrier; close discards late actual sendJson',async t=>{
 const f=diagnostics(),send=sendJson(f.diag),admitted=gate(),release=gate(),closed=gate();let sends=0;
 const s=await server(t,async(_req,res)=>{admitted.release();res.once('close',closed.release);await release.promise;send(res,200,{ok:true});sends++;},f.diag);
 const req=http.get({hostname:'127.0.0.1',port:s.port,path:'/api/me'});req.on('error',()=>{});await admitted.promise;
 assert.equal(f.diag.snapshot().active[0].lastPhase,'http-enter');assert.ok(!f.records.some(x=>x.event==='headers-queued'));
 req.destroy();await closed.promise;release.release();await new Promise(setImmediate);assert.equal(sends,1);
 assert.equal(f.diag.snapshot().completed[0].httpTerminal,'response-closed-incomplete');assert.equal(f.records.at(-1).event,'response-discarded');
});
test('two real16KiB body chunks then barrier; abrupt downstream close is incomplete',async t=>{
 const f=diagnostics(),release=gate(),closed=gate(),partial=gate(),chunks=[];let received=0;
 const s=await server(t,async(_req,res)=>{res.once('close',closed.release);res.writeHead(200,{'Content-Type':'application/octet-stream'});f.diag.phase(res,'headers-queued');
  res.write(Buffer.alloc(16384,1));res.write(Buffer.alloc(16384,2));await release.promise;if(!res.destroyed)res.end(Buffer.alloc(16));},f.diag);
 const req=http.get({hostname:'127.0.0.1',port:s.port,path:'/api/me'},res=>{res.on('error',()=>{});res.on('data',b=>{chunks.push(b);received+=b.length;if(received===32768)partial.release();});});req.on('error',()=>{});
 await partial.promise;assert.equal(received,32768);assert.equal(f.diag.snapshot().active[0].httpTerminal,null);req.destroy();await closed.promise;release.release();
 assert.equal(hash(Buffer.concat(chunks)),hash(Buffer.concat([Buffer.alloc(16384,1),Buffer.alloc(16384,2)])));
 assert.equal(f.diag.snapshot().completed[0].httpTerminal,'response-closed-incomplete');assert.ok(!f.records.some(x=>x.event==='http-finish'));
});
test('held local forwarding before route has no invented Main admission',async t=>{
 const f=diagnostics(),send=sendJson(f.diag),admitted=gate(),release=gate();const target=await server(t,(_req,res)=>send(res,200,{ok:true}),f.diag);
 const proxy=await server(t,async(req,res)=>{admitted.release();await release.promise;const upstream=await get(target.port,req.url,req.headers);res.writeHead(upstream.status,upstream.headers);res.end(upstream.body);});
 const pending=get(proxy.port,'/api/me');await admitted.promise;assert.equal(f.records.length,0);release.release();assert.equal((await pending).status,200);assert.ok(f.records.some(x=>x.event==='http-enter'));
});
test('actual server callback traces before instance guards and handler; rejection status unchanged',async t=>{
 const f=diagnostics(),send=sendJson(f.diag),begin=web.indexOf('httpServer = http.createServer('),end=web.indexOf('\n\n  attachWebSocket',begin);
 const expression=web.slice(begin,end).replace(/^httpServer = /,'').trim().replace(/;$/,'');let handled=0;
 const callback=vm.runInNewContext(expression,{http:{createServer:fn=>fn},httpReadDiagnostics:f.diag,process,url:require('node:url'),
  webServerInstanceId:'fixture-service',sendJson:send,sdkSessions:null,console,serveStatic(){throw Error('unexpected static');},
  webServerLastRequestAt:null,webServerLastRequest:null,webServerRequestCount:0,handleApi:async(req,res)=>{handled++;f.diag.phase(res,'handler-enter');send(res,200,{ok:true});}});
 const s=await server(t,callback);const denied=await get(s.port,'/api/me',{'X-Noted-Main-Pid':'wrong'});
 assert.equal(denied.status,409);assert.equal(handled,0);assert.equal(f.records[0].event,'http-enter');
 const accepted=await get(s.port,'/api/me');assert.equal(accepted.status,200);assert.equal(handled,1);
 assert.ok(f.records.some(x=>x.event==='route-enter'));assert.ok(f.records.some(x=>x.event==='handler-return'));
});
test('actual bridge queue/reply/late duplicate are correlated without another send',async t=>{
 const f=diagnostics(),send=sendJson(f.diag),dispatched=gate();let message;
 const ast=ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true);
 const declarations=['bridgeRequest','registerBridgeReplyHandler'].map(name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast)).join('\n');
 const pending=new Map(),ipc=new EventEmitter();const ctx=vm.createContext({httpReadDiagnostics:f.diag,beginHttpReadDependency,
  pendingBridge:pending,ipcMain:ipc,crypto:require('node:crypto'),BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send(_channel,m){message=m;dispatched.release();}}}]},
  bridgePayloadLabel:()=>'',LATE_BRIDGE_REPLY_RETENTION_MS:30000,e2eBoundaryTestGate:null,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}}});
 vm.runInContext(declarations+'\nthis.bridge=bridgeRequest;registerBridgeReplyHandler();',ctx);
 const s=await server(t,async(_req,res)=>{const result=await ctx.bridge('getClaudeTabStatus',{tabId:'private'});send(res,200,result);},f.diag);
 const response=get(s.port,'/api/me',ids);await dispatched.promise;
 assert.ok(f.records.some(x=>x.event==='dependency-begin'&&x.stage==='renderer-bridge'));assert.ok(!f.records.some(x=>x.event==='http-finish'));
 ipc.emit('web:bridge-reply',{}, {requestId:message.requestId,ok:true,data:{ok:true}});assert.equal((await response).status,200);
 ipc.emit('web:bridge-reply',{}, {requestId:message.requestId,ok:true,data:{duplicate:true}});
 assert.equal(pending.size,0);assert.equal(f.records.filter(x=>x.event==='bridge-reply').length,1);assert.equal(f.records.filter(x=>x.terminal).length,1);
});
test('diagnostic close before headers cannot cause a late writeHead or end',()=>{
 let heads=0,ends=0;const req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/me',headers:{}});
 Object.assign(res,{setHeader(){},writeHead(){heads++;},end(){ends++;}});
 const f=diagnostics({log(line){if(JSON.parse(line.slice(11)).event==='headers-begin')res.destroyed=true;}});
 f.diag.run(req,res,()=>sendJson(f.diag)(res,200,{ok:true}));assert.equal(heads,0);assert.equal(ends,0);
});
test('actual catalog capture preserves one shared flight, fingerprint and frozen DTO',async()=>{
 const current=fs.readFileSync(path.join(__dirname,'workflow-organization-api.js'),'utf8');
 const before=fs.readFileSync(path.join(__dirname,'fixtures/http-catalog-capture-preimage.cjs'),'utf8');
 const load=source=>{const ast=ts.createSourceFile('workflow.js',source,ts.ScriptTarget.Latest,true);let declaration;
  const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='readCapture')declaration=n.getText(ast);ts.forEachChild(n,visit);};visit(ast);assert.ok(declaration);
  let captures=0;const ctx=vm.createContext({setImmediate,beginHttpReadDependency,
   service:{read:fn=>{captures++;return fn();}},read:()=>({tabs:[]}),database:{getAppState:()=>({openProjects:[]})},
   legacyNamespaceIds:()=>[],namespaceIds:()=>[],db:{prepare:()=>({all:()=>[]})},
   projectWorkflowCatalog:()=>({rows:[],executionRefs:[],provenance:[],workflows:[],clocks:{}}),fingerprint:value=>hash(JSON.stringify(value))});
  vm.runInContext('let catalogFlight=null;const '+declaration+';this.capture=readCapture;',ctx);return{capture:ctx.capture,count:()=>captures};};
 const old=load(before),next=load(current),f=diagnostics(),req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/workflow-organization',headers:{}});res.setHeader=()=>{};
 const prior=await old.capture();let actual;
 await f.diag.run(req,res,async()=>{const one=next.capture(),two=next.capture();assert.equal(one,two);actual=await one;});
 assert.equal(next.count(),1);assert.equal(JSON.stringify(actual),JSON.stringify(prior));assert.ok(Object.isFrozen(actual)&&Object.isFrozen(actual.dto));
 for(const stage of ['catalog-scheduler','catalog-capture','catalog-projection','catalog-fingerprint','catalog-freeze'])assert.ok(f.records.some(x=>x.event==='dependency-begin'&&x.stage===stage),stage);
 await next.capture();assert.equal(next.count(),2,'a settled capture is not reused');res.emit('finish');
});

async function workerFixture(t,stage=null){
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'http-worker-host-')),sessionId='source-one';
 const source=path.join(directory,'rollout-'+sessionId+'.jsonl');
 await fsp.writeFile(source,Array.from({length:80},(_,i)=>JSON.stringify({type:'response_item',timestamp:new Date(1700000000000+i).toISOString(),
  payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'synthetic 🌍 '+i}]}})+'\n').join(''));
 const noCache=path.join(directory,'disabled-cache');await fsp.writeFile(noCache,'deliberately disabled disposable SQLite cache');
 const events=[],waiters=[];let worker;const latch=new SharedArrayBuffer(4);let epochReply;
 const publish=e=>{events.push(e);for(const w of [...waiters])if(w.p(e)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(e);}};
 const wait=p=>{const found=events.find(p);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{
  const item={p,resolve,timer:setTimeout(()=>reject(Error('fixture observation deadline; tail='+JSON.stringify(events.slice(-8)))),5000)};waiters.push(item);});};
 class ActualWorker extends Worker{
  constructor(_file,options){super(path.join(__dirname,'fixtures/http-read-worker-host.cjs'),{...options,workerData:{...options.workerData,
   hostFixture:{stage,latch,source,entry:path.join(__dirname,'history-read-worker.js'),sourceCode:path.join(sourceDirectory,'history-read-worker.js')}}});worker=this;
   this.on('message',m=>{if(m.event==='fixture-barrier')publish(m);});}
  postMessage(message,...args){if(stage==='epoch'&&message.event==='source-epoch'&&!epochReply){epochReply=()=>super.postMessage(message,...args);publish({event:'fixture-barrier',stage:'epoch'});return;}return super.postMessage(message,...args);}
 }
 const module={exports:{}},req=createRequire(path.join(__dirname,'history-read-client.js'));
 vm.runInNewContext(fs.readFileSync(path.join(sourceDirectory,'history-read-client.js'),'utf8'),{module,exports:module.exports,
  require:name=>name==='node:worker_threads'?{Worker:ActualWorker}:req(name),__dirname,__filename:path.join(__dirname,'history-read-client.js'),
  console:{log(){},warn(){},error(){}},Buffer,SharedArrayBuffer,Int32Array,Atomics,setTimeout,clearTimeout},{filename:'actual-history-read-client.js'});
 const client=new module.exports.HistoryReadClient({cacheDirectory:noCache,sessionsDir:directory,memoryBudgetMb:64,
  diagnosticReadPhases:true,diagnosticSlowMs:0,onDiagnostic:publish});
 t.after(async()=>{for(const w of waiters)clearTimeout(w.timer);await client.close();
  if(worker)assert.equal(worker.threadId,-1,'owned Worker exited');await fsp.rm(directory,{recursive:true});});
 return{directory,source,sessionId,client,events,wait,get worker(){return worker;},payload:{toolType:'codex',sessionId,cwd:directory,tabId:'private-tab',dehydrate:false},
  release(){if(stage==='imports'||stage==='database'){Atomics.store(new Int32Array(latch),0,1);Atomics.notify(new Int32Array(latch),0);}else if(epochReply){const f=epochReply;epochReply=()=>{};f();}else worker.postMessage({event:'fixture-release'});}};
}
for(const stage of ['receive','imports','database','epoch'])test('actual Worker exposes held '+stage+' boundary before reply',async t=>{
 const f=await workerFixture(t,stage);const pending=f.client.call('getHistory',f.payload);await f.wait(e=>e.event==='fixture-barrier'&&e.stage===stage);
 assert.ok(!f.events.some(e=>e.event==='rpc-received'));if(stage==='imports')assert.ok(f.events.some(e=>e.event==='imports-begin'));
 if(stage==='database')assert.ok(f.events.some(e=>e.event==='database-ready-begin'));if(stage==='epoch')assert.ok(f.events.some(e=>e.event==='source-epoch-request'));
 f.release();const result=await pending;assert.equal(result.success,true,result.error);assert.equal(result.entries.length,80);assert.equal(f.client.pending.size,0);
 assert.ok(f.events.some(e=>e.event==='reply-ready'));assert.ok(f.events.some(e=>e.event==='rpc-received'));
});
test('same-session and cold-lane queues are distinguished with one real worker',async t=>{
 for(const separate of [false,true]){const f=await workerFixture(t,'cold');
  f.payload.dehydrate=true;
  if(separate)await fsp.copyFile(f.source,path.join(f.directory,'rollout-source-two.jsonl'));
  const first=f.client.call('getHistory',f.payload);await f.wait(e=>e.event==='fixture-barrier'&&e.stage==='cold');
  const next=f.client.call('getHistory',{...f.payload,sessionId:separate?'source-two':f.sessionId});
  const queued=await f.wait(e=>separate?e.event==='cold-queued'&&e.queueDepth>=1:e.event==='request-received'&&e.sessionQueueDepth>=1);
  assert.ok(queued);f.release();assert.equal((await first).entries.length,80);assert.equal((await next).entries.length,80);await f.client.close();}
});
test('two HTTP contexts keep distinct logical/physical IDs through actual Worker; payload is immutable',async t=>{
 const f=await workerFixture(t),d=diagnostics(),send=sendJson(d.diag),payload=Object.freeze({...f.payload});const before=JSON.stringify(payload);
 const s=await server(t,async(_req,res)=>{const result=await f.client.call('getHistory',payload);send(res,200,result);},d.diag);
 const replies=await Promise.all([get(s.port,undefined,ids),get(s.port,undefined,{...ids,'X-Noted-Read-Id':'read-2','X-Noted-Read-Attempt':'attempt-2'})]);
 assert.ok(replies.every(r=>r.status===200));assert.equal(hash(replies[0].body),hash(replies[1].body));assert.equal(JSON.stringify(payload),before);
 assert.doesNotMatch(replies[0].body.toString(),/serverRequestId|httpRead|attempt-1|read-1/,'trace never enters the public History DTO');
 const read=f.events.filter(e=>e.event==='request-received');assert.deepEqual(read.map(x=>x.httpRead.attemptId).sort(),['attempt-1','attempt-2']);
 assert.deepEqual(read.map(x=>x.httpRead.readId).sort(),['read-1','read-2']);for(const event of read){const posted=f.events.find(x=>x.event==='rpc-post'&&x.requestId===event.requestId);
  assert.equal(posted.httpRead.serverRequestId,event.httpRead.serverRequestId);assert.equal(event.clientId,posted.clientId);}
});
test('HTTP cancellation leaves shared worker work alive; another admitted GET completes',async t=>{
 const f=await workerFixture(t,'epoch'),d=diagnostics(),send=sendJson(d.diag),closed=gate(),done=gate();let completed=0;
 const s=await server(t,async(req,res)=>{res.once('close',()=>{if(req.headers['x-noted-read-attempt']==='attempt-1')closed.release();});
  const result=await f.client.call('getHistory',f.payload);send(res,200,result);if(++completed===2)done.release();},d.diag);
 const req=http.get({hostname:'127.0.0.1',port:s.port,path:'/api/me',headers:ids});req.on('error',()=>{});
 await f.wait(e=>e.event==='fixture-barrier'&&e.stage==='epoch');req.destroy();await closed.promise;
 assert.equal(f.client.pending.size,1);assert.equal(f.client.diagnosticCounters.cancellations,0);
 const second=get(s.port,'/api/me',{...ids,'X-Noted-Read-Attempt':'attempt-2'});
 await f.wait(e=>e.event==='rpc-post'&&e.httpRead?.attemptId==='attempt-2');f.release();assert.equal((await second).status,200);await done.promise;
 assert.equal(f.client.diagnosticCounters.cancellations,0);assert.equal(f.client.pending.size,0);
 const completedReads=d.diag.snapshot().completed;assert.equal(completedReads.find(x=>x.attemptId==='attempt-1').httpTerminal,'response-closed-incomplete');
 assert.equal(completedReads.find(x=>x.attemptId==='attempt-2').httpTerminal,'response-finished');
});
test('actual binary Worker transport retains the original DTO and proof without diagnostic fields',async t=>{
 const f=await workerFixture(t);const plain=await f.client.call('getHistory',f.payload);
 const binary=await f.client.call('getHistory',f.payload,true);const decoded=require('node:v8').deserialize(Buffer.from(binary.data));
 assert.deepEqual(decoded,plain);assert.equal(binary.__notedHistoryTransport,'v8-1');
 assert.doesNotMatch(JSON.stringify(binary.proof),/httpRead|serverRequestId|producerBoot/);
});
test('diagnostic callback source revocation still defeats final admission with existing three attempts',async t=>{
 const f=await workerFixture(t);const original=f.client.onDiagnostic;f.client.onDiagnostic=e=>{original(e);if(e.event==='call-complete'&&e.admission==='pending-final-check')f.client.invalidate({});};
 const result=await f.client.call('getHistory',f.payload);assert.equal(result.success,false);assert.equal(result.error,'history_source_changed_during_preparation');
 assert.equal(f.events.filter(e=>e.event==='rpc-post').length,3);
});
test('source invalidation from worker reply diagnostic is rejected by Main final proof',async t=>{
 const f=await workerFixture(t,'invalidate-reply');const result=await f.client.call('getHistory',f.payload);
 assert.equal(result.success,false);assert.equal(result.error,'history_source_changed_during_preparation');
 assert.equal(f.events.filter(e=>e.event==='rpc-post').length,3);
});
test('actual client post throw releases pending/ref once and ignores a late old-worker reply',async t=>{
 const f=await workerFixture(t);await f.client.call('stats');const worker=f.worker;let posts=0,unrefs=0;const unref=worker.unref.bind(worker);
 worker.unref=()=>{unrefs++;return unref();};worker.postMessage=()=>{posts++;throw Object.assign(Error('clone fixture'),{code:'DataCloneError'});};
 await assert.rejects(f.client.call('getHistory',f.payload),/clone fixture/);assert.equal(posts,1);assert.equal(unrefs,1);assert.equal(f.client.pending.size,0);
 await f.client.close();worker.emit('message',{id:1,result:{success:true},readProof:[]});assert.equal(f.client.pending.size,0);
});
