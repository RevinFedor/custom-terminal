'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const vm=require('node:vm'),zlib=require('node:zlib'),url=require('node:url'),{performance}=require('node:perf_hooks');
const {directoryFixture}=require('./fixtures/workflow-directory-sqlite.cjs');
const {host}=require('./fixtures/workflow-publication-main.cjs');
const {createWorkflowPublicationWake}=require('./workflow-publication-wake');
const {createWorkflowOrganizationHttp}=require('./workflow-organization-http');
const {createHttpReadDiagnostics}=require('./http-read-diagnostics');
const plain=x=>JSON.parse(JSON.stringify(x));
const gate=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),resolve};};
async function fixture(t,options={}){const f=await directoryFixture(t);f.add('chat');
 if(process.env.WORKFLOW_WAKE_MAIN_PREIMAGE)options.mainSource=fs.readFileSync(process.env.WORKFLOW_WAKE_MAIN_PREIMAGE,'utf8');
 if(process.env.WORKFLOW_WAKE_WEB_PREIMAGE)options.webSource=fs.readFileSync(process.env.WORKFLOW_WAKE_WEB_PREIMAGE,'utf8');
 return{f,h:host(f.database,options)};}
const layout=(profile='display:one')=>({version:1,windowDisplayKey:profile,splitPanes:[{windowId:'window',column:0,tabId:'chat',projectId:'__tab_catalog_v2__'}]});
test('actual Main window-only publication reaches projects event without pretending project order/runtime changed',async t=>{
 const {f,h}=await fixture(t);h.bind();h.sinks.add({send(){}});h.flush();h.frames.length=0;
 const sessions=f.database.getAppState('workspace-session'),before=h.publication(),idleBefore=h.idleRefreshes();
 const publication=h.commit(layout());assert.ok(publication.revision>before.revision);assert.equal(h.idleRefreshes(),idleBefore+1);h.flush();
 const event=h.frames.at(-1);assert.ok(event,'the actual Main publication must wake the existing projects channel');
 assert.deepEqual(plain(event.workflowPublication),{version:1,source:'workflow-organization-publication',epoch:'fixture-main-epoch',generation:publication.generation,revision:publication.revision});
 assert.deepEqual(event.projects,[]);assert.deepEqual(event.layoutChangedProjectIds,[]);assert.equal(event.projectOrderChanged,false);
 assert.equal(event.cardSignals,undefined);assert.equal(f.database.getAppState('workspace-session'),sessions);
 assert.equal(h.browserFrames.at(-1)[0],'workflow:changed');assert.equal(h.idleRefreshes(),idleBefore+2);
});

test('duplicate/replayed/coalesced publications retain one latest clock and one existing broadcast timer',async t=>{
 const {h}=await fixture(t);h.bind();h.sinks.add({send(){}});h.flush();h.frames.length=0;
 const a=h.commit(layout('A')),b=h.commit(layout('B')),c=h.commit(layout('C'));
 assert.ok(a.revision<b.revision&&b.revision<c.revision);assert.equal(h.timers.length,1);assert.equal(h.frames.length,0);
 assert.equal(h.helper.observe(c),false);assert.equal(h.helper.observe(a),false);assert.equal(h.timers.length,1);
 h.flush();assert.equal(h.frames.length,1);assert.equal(h.frames[0].workflowPublication.revision,c.revision);
 const seed=[];h.web.sendProjectActivitySnapshot({send:text=>seed.push(JSON.parse(text))});
 assert.equal(seed[0].workflowPublication.revision,c.revision);assert.equal(h.timers.length,0,'reading a seed never schedules');
 const read=h.publication(),w=h.scope.api.service.getWorkflow('main');
 const request={mutationId:'replay-owned-same-id',expectedRevision:read.revision,workflowId:'main',expectedWorkflowRevision:w.revision,layout:layout('D')};
 const first=h.scope.api.service.saveLayout(request);h.flush();const count=h.frames.length;
 assert.equal(h.scope.api.service.saveLayout(request).revision,first.revision);h.flush();assert.equal(h.frames.length,count);
 h.bind();assert.equal(h.timers.length,0,'late binding is idempotent');
});

test('startup publication inside Main initializer TDZ is harmless; late bind seeds durable current owner',async t=>{
 const {h}=await fixture(t,{duringConstruction:api=>api.service.saveLayout({mutationId:'during-main-const-initialization',
  expectedRevision:api.service.getPublication().revision,workflowId:'main',expectedWorkflowRevision:api.service.getWorkflow('main').revision,
  layout:layout('early-constructor')})});
 assert.equal(h.publication().revision,h.browserFrames[0][1].revision);assert.equal(h.helper.snapshot(),null);assert.equal(h.timers.length,0);
 const before=h.commit(layout('early-later'));assert.equal(h.timers.length,0);
 h.bind();assert.equal(h.bootBound(),true);assert.equal(h.helper.snapshot().revision,before.revision);assert.equal(h.timers.length,1);
 h.flush();assert.equal(h.frames.length,0,'no subscribers is not delivery');
 const messages=[];h.web.sendProjectActivitySnapshot({send:text=>messages.push(JSON.parse(text))});
 assert.equal(messages[0].workflowPublication.revision,before.revision);
});

test('renderer absent and missing channel do not revoke commit, browser/idle behavior, or retained seed',async t=>{
 const {h}=await fixture(t);h.bind();h.flush();h.renderer(false);h.channel(false);
 const before=h.publication(),publication=h.commit(layout('channel-unavailable'));
 assert.equal(h.publication().revision,publication.revision);assert.ok(publication.revision>before.revision);
 assert.ok(h.errors.some(line=>line.includes('channel-unavailable')));assert.equal(h.timers.length,0);
 const last=h.helper.snapshot();assert.equal(last.revision,publication.revision);
 assert.equal(h.helper.observe(publication),false,'no timer retry loop on duplicate');
 h.channel(true);const messages=[];h.web.sendProjectActivitySnapshot({send:text=>messages.push(JSON.parse(text))});
 assert.equal(messages[0].workflowPublication.revision,publication.revision);
 h.sinks.add({send(){}});const next=h.commit(layout('renderer-still-absent'));h.flush();
 assert.equal(h.frames.at(-1).workflowPublication.revision,next.revision);
});

test('observer exception never suppresses existing browser event/idle refresh or durable publication',async t=>{
 const {h}=await fixture(t);h.bind();h.flush();const idle=h.idleRefreshes(),count=h.browserFrames.length;
 h.helper.observe=()=>{throw Error('controlled observer failure');};const p=h.commit(layout('observer-failed'));
 assert.equal(h.publication().revision,p.revision);assert.equal(h.idleRefreshes(),idle+1);
 assert.equal(h.browserFrames.length,count+1);assert.equal(h.browserFrames.at(-1)[1].revision,p.revision);
 assert.ok(h.errors.some(x=>x.includes('observer-failed')));
});

test('old/replaced API owner cannot publish or seed native from its retained clock',async t=>{
 const {h}=await fixture(t);h.bind();h.sinks.add({send(){}});h.flush();const count=h.frames.length;
 h.replaceOwner();assert.equal(h.helper.snapshot(),null);h.commit(layout('old-api'));h.flush();assert.equal(h.frames.length,count);
 assert.equal(h.web.projectActivitySnapshot().workflowPublication,undefined);
});

test('failed seed/future/malformed/stale publication never fabricates a newer healthy clock',()=>{
 const errors=[],timers=[],wake=createWorkflowPublicationWake({onError:reason=>errors.push(reason)});
 assert.equal(wake.observe({version:1,generation:9,revision:9}),false);assert.equal(wake.snapshot(),null);
 wake.start({epoch:'main',isCurrent:()=>true,readPublication:()=>{throw Error('no db');},schedule:reason=>timers.push(reason)});
 assert.equal(wake.snapshot(),null);assert.ok(errors.includes('publication-unavailable'));
 for(const p of [{},{version:2,generation:1,revision:1},{version:1,generation:Infinity,revision:1},{version:1,generation:1,revision:-1}])assert.equal(wake.observe(p),false);
 assert.equal(wake.observe({version:1,generation:3,revision:5}),true);assert.equal(timers.length,1);
 for(const p of [{version:1,generation:2,revision:6},{version:1,generation:4,revision:4},{version:1,generation:3,revision:5}])assert.equal(wake.observe(p),false);
 const copy=wake.snapshot();copy.revision=999;assert.equal(wake.snapshot().revision,5);assert.equal(timers.length,1);
});

test('publication getter failure is isolated from the existing project/runtime event',async t=>{
 const {h}=await fixture(t);h.bind();h.flush();h.web.computeProjectActivity=()=>({projects:[{projectId:'real-namespace',count:2,tabs:[]}],
  projectOrderChanged:true,layoutChangedProjectIds:['real-namespace']});
 h.web.readWorkflowPublication=()=>{throw Error('controlled getter failure');};const event=h.web.projectActivitySnapshot();
 assert.equal(event.projects[0].count,2);assert.equal(event.projectOrderChanged,true);assert.deepEqual(plain(event.layoutChangedProjectIds),['real-namespace']);
 assert.equal(event.workflowPublication,undefined);assert.equal(event.error,undefined);
});

test('publication still wakes projects when an existing renderer listener throws after durable commit',async t=>{
 const {h}=await fixture(t);h.bind();h.sinks.add({send(){}});h.flush();h.frames.length=0;
 h.scope.BrowserWindow.getAllWindows=()=>{throw Error('renderer unavailable');};
 const p=h.commit(layout('renderer-listener-failed'));assert.equal(h.publication().revision,p.revision);h.flush();
 assert.equal(h.frames.at(-1).workflowPublication.revision,p.revision);
});

test('actual Main startup injection and Web start/stop wiring retain the owner-pinned optional reader',()=>{
 const main=fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),web=fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8');
 const start=main.indexOf('workflowPublicationWake.start('),serverStart=main.indexOf('    webServer.start({');
 assert.ok(start>main.indexOf('const appRuntimeIdentity ='));assert.ok(start>main.indexOf('let projectActivityBroadcastTimer ='));
 assert.ok(start<serverStart);assert.match(main.slice(start,serverStart),/projectManager\.workflowOrganization === workflowOrganization/);
 assert.match(main.slice(serverStart,serverStart+1600),/readWorkflowPublication: \(\) => workflowPublicationWake\.snapshot\(\)/);
 assert.match(web,/readWorkflowPublication: readWorkflowPublicationFn/);
 assert.match(web,/readWorkflowPublication = typeof readWorkflowPublicationFn === 'function' \? readWorkflowPublicationFn : null/);
 const stop=web.indexOf('\nfunction stop(');assert.ok(stop>0);assert.match(web.slice(stop),/readWorkflowPublication = null/);
});

async function privateHTTP(t,f,h,{beforeCatalogReturn}={}){
 const records=[],diag=createHttpReadDiagnostics({serviceId:'private-wake-service',detailPerMinute:10000,
  log:line=>records.push(JSON.parse(line.slice('[HttpRead] '.length)))});
 const raw=fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8'),a=raw.indexOf('function sendJson('),b=raw.indexOf('\nfunction sendTerminalBridgeError',a);
 const sendJson=vm.runInNewContext(raw.slice(a,b)+'\nsendJson',{httpReadDiagnostics:diag,readPerformance:performance,zlib,Buffer,GZIP_THRESHOLD:4096,console:{log(){}}});
 const original=h.scope.api.readCatalogV2;
 const api={...h.scope.api,readCatalogV2:async()=>{const result=await original();await beforeCatalogReturn?.(result);return result;}};
 const route=createWorkflowOrganizationHttp({getProjectManager:()=>({db:f.database,workflowOrganization:api}),checkAuth:req=>req.headers.authorization==='Bearer wake-fixture',
  readBody:async()=>({}),sendJson});
 let active=0,peak=0;const sockets=new Set();
 const server=http.createServer((req,res)=>{active++;peak=Math.max(peak,active);assert.ok(peak<=2);res.once('close',()=>active--);
  if(req.url==='/api/events?scope=projects'){
   if(req.headers.authorization!=='Bearer wake-fixture'){res.writeHead(401).end();return;}
   res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});
   const sink={send:text=>res.write('data: '+text+'\n\n')};h.sinks.add(sink);h.web.sendProjectActivitySnapshot(sink,'connect');
   req.once('close',()=>h.sinks.delete(sink));return;
  }
  diag.run(req,res,()=>{if(req.url==='/api/project-activity'){sendJson(res,200,h.web.projectActivitySnapshot('rest'));return;}
    return route(req,res,url.parse(req.url,true)).then(handled=>{if(!handled)sendJson(res,404,{error:'not_found'});});});
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.close(resolve);}));
 const get=route=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:route,
   headers:{authorization:'Bearer wake-fixture','Accept-Encoding':'gzip','X-Noted-Read-Attempt':'wake-read'}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const wire=Buffer.concat(chunks),body=res.headers['content-encoding']==='gzip'?zlib.gunzipSync(wire):wire;
    assert.equal(wire.length,Number(res.headers['content-length']));resolve(JSON.parse(body));});});req.on('error',reject);});
 const stream=onEvent=>{let buffer='';const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/events?scope=projects',
  headers:{authorization:'Bearer wake-fixture'}},res=>{assert.equal(res.headers['content-type'],'text/event-stream');res.setEncoding('utf8');
   res.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);
    if(frame.startsWith('data: '))onEvent(JSON.parse(frame.slice(6)));}});res.on('error',()=>{});});req.on('error',()=>{});return req;};
 return{get,stream,records,diag,peak:()=>peak};
}

test('real private HTTP/SSE carries current scalar publication clock, no body/mutation identity or new transport',async t=>{
 const {f,h}=await fixture(t);h.bind();h.flush();const s=await privateHTTP(t,f,h),seed=gate(),event=gate();let initial;
 const req=s.stream(value=>{if(!initial){initial=value;seed.resolve();}else event.resolve(value);});await seed.promise;
 const result=h.commit(layout('http-profile'));h.flush();const changed=await event.promise;
 assert.equal(changed.workflowPublication.revision,result.revision);assert.equal(changed.projectOrderChanged,false);
 const rest=await s.get('/api/project-activity');assert.deepEqual(rest.workflowPublication,changed.workflowPublication);
 const catalog=await s.get('/api/workflow-organization?projection=catalog-v2');
 assert.equal(catalog.clocks.organization.revision,changed.workflowPublication.revision);assert.equal(catalog.windowLayout,undefined,'R2 policy still unapplied');
 assert.deepEqual(Object.keys(changed.workflowPublication).sort(),['epoch','generation','revision','source','version']);
 assert.equal(s.records.filter(e=>e.event==='http-enter').length,2,'SSE itself is not a finite read');
 assert.equal(s.diag.snapshot().active.length,0);assert.ok(s.peak()<=2);req.destroy();
 if(process.env.WORKFLOW_WAKE_WIRE_OUTPUT)fs.writeFileSync(process.env.WORKFLOW_WAKE_WIRE_OUTPUT,JSON.stringify({schema:1,synthetic:true,
  initialProjectEvent:initial,publicationProjectEvent:changed,restSnapshot:rest,catalogAfterPublication:catalog,
  peakHTTP:s.peak(),losses:s.diag.snapshot().losses},null,2)+'\n');
});

test('held actual catalog HTTP read plus repeated SSE wake has exactly one dirty successor (native coordinator port)',async t=>{
 const {f,h}=await fixture(t);h.bind();h.flush();const entered=gate(),release=gate(),done=gate(),seed=gate(),latestParsed=gate();let hold=true,targetRevision=null;
 const s=await privateHTTP(t,f,h,{beforeCatalogReturn:async()=>{if(hold){hold=false;entered.resolve();await release.promise;}}});
 // This is an explicitly controlled native coordinator PORT, not Swift/UIKit.
 // It exercises actual Main reads/socket events; parent implements typed adoption.
 let seen=null,generation=0,flight=null,dirty=false,reads=0,accepted=null,discards=0;
 const start=()=>{const ticket=generation;reads++;flight=s.get('/api/workflow-organization?projection=catalog-v2').then(reply=>{
   if(ticket===generation)accepted=reply;else discards++;flight=null;if(dirty){dirty=false;start();}else done.resolve();});};
 const observe=value=>{const wake=value.workflowPublication;if(!wake)return;
  if(seen&&wake.epoch===seen.epoch&&wake.revision<=seen.revision&&wake.generation<=seen.generation)return;
  seen=wake;generation++;if(flight)dirty=true;else start();};
 let first=true;const req=s.stream(value=>{if(first){first=false;seen=value.workflowPublication;seed.resolve();}else{
  observe(value);if(targetRevision!==null&&seen?.revision===targetRevision)latestParsed.resolve();}});
 await seed.promise;start();await entered.promise;
 h.commit(layout('held-one'));h.flush();const last=h.commit(layout('held-two'));targetRevision=last.revision;h.flush();
 // Only the actual client parser releases this barrier; a server sink write
 // alone is not delivery. No polling/sleep/extra target HTTP.
 await latestParsed.promise;const target=targetRevision;
 assert.equal(reads,1);assert.equal(dirty,true);observe(h.web.projectActivitySnapshot());assert.equal(reads,1);
 release.resolve();await done.promise;assert.equal(reads,2);assert.equal(discards,1);
 assert.equal(accepted.clocks.organization.revision,target);assert.equal(dirty,false);assert.ok(s.peak()<=2);req.destroy();
});
