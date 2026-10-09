'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { WorkspaceSwitcherReadProjection, WORKSPACE_SWITCHER_CAPABILITY, frameKey: switcherFrameKey } = require('./workspace-switcher-api');
const { switcherRequestFromQuery } = require('../shared/workspace-switcher-contract.cjs');
let createSnapshot, captureInputs, selectRows, workflowLookup, emptyLayout;
test.before(async()=>{
  ({createWorkspaceSwitcherSnapshot:createSnapshot}=await import('../renderer/utils/workspaceSwitcherSnapshot.mjs'));
  ({captureSwitcherInputs:captureInputs,selectSwitcherRows:selectRows,buildSwitcherWorkflowLookup:workflowLookup}=await import('../renderer/utils/tabSwitcherSelector.mjs'));
  ({emptySpaceLayout:emptyLayout}=await import('../renderer/utils/workspaceSpacesModel.mjs'));
});
const read = name => fs.readFileSync(path.join(__dirname,name),'utf8');
const web=read('web-server.js'), main=read('main.js'), app=read('../renderer/App.tsx'), overlay=read('../renderer/components/Workspace/TabSwitcherOverlay.tsx');
const tree=(name,text)=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,name.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.JS);
const webTree=tree('web.js',web), mainTree=tree('main.js',main), overlayTree=tree('overlay.tsx',overlay), appTree=tree('app.tsx',app);
function declaration(ast,name) {const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node,name);return node.getText(ast)}
function find(ast,predicate) {
  let result; const visit=node=>{if(result)return;if(predicate(node)){result=node;return;}ts.forEachChild(node,visit)};
  visit(ast);assert.ok(result);return result;
}
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const quiet={log(){},warn(){},error(){}};
function evidence(name,value) {
  const dir=process.env.NOTED_SWITCHER_TEST_ARTIFACT_DIR;
  if(dir) fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value,null,2)+'\n');
}

function data() {
  const tab=(id,extra={})=>({id,name:id,tabType:'terminal',commandType:'codex',notes:'SECRET_BODY',historyPrompt:'SECRET_PROMPT',...extra});
  const tabs=[tab('a'),tab('a2'),tab('b'),tab('bVisible'),tab('child',{parentTabId:'a'}),
    tab('file',{tabType:'file',commandType:null,filePath:'/private-fixture/readme.md'}),tab('unplaced')];
  const ws={isRestoring:false,openProjects:new Map([['P',{projectPath:'/fixture/P',activeTabId:'a',tabs:new Map(tabs.map(t=>[t.id,t]))}]]),
    projectHistory:['P'],globalTabMru:['b','a2','file','a','child','unplaced','closed'].map(tabId=>({projectId:'P',tabId})),
    activeProjectId:'P',activeSpaceId:'A',splitFocusedIndex:0,
    splitPanes:[{projectId:'P',tabId:'a',tabs:[{projectId:'P',tabId:'a'},{projectId:'P',tabId:'a2'},{projectId:'P',tabId:'file'}]}],
    centerStrips:{},spaces:[]};
  ws.spaces=[{id:'A',name:'Workflow A',icon:null,projectIds:['P'],layout:emptyLayout()},
    {id:'B',name:'Workflow B',icon:'data:image/svg+xml,WORKFLOW_B',projectIds:['P'],
      layout:{...emptyLayout(),splitPanes:[{projectId:'P',tabId:'b',tabs:[{projectId:'P',tabId:'b'},{projectId:'P',tabId:'bVisible'}]}]}}];
  return {ws,projects:{P:{name:'Directory project',icon:'PROJECT_ICON'}},files:new Map([['/private-fixture/readme.md',true]])};
}
async function harness(t) {
  const model=data(), wakeups=[], probes=[], sideEffects=[];
  const readEntered=deferred(),probeEntered=deferred();
  const sender=new EventEmitter();sender.id=71;sender.mainFrame={processId:1,routingId:1};sender.isDestroyed=()=>false;
  let preferred=sender,producer,hold=null,probeHold=null,serial=0;
  const broker=new WorkspaceSwitcherReadProjection({preferredRenderer:()=>preferred,uuid:()=> 'private-lease-'+(++serial),
    onChanged:()=>wakeups.push(broker.wake()),
    bridgeRead:async payload=>{
      sideEffects.push('readWorkspaceSwitcher');const result=await producer.read(payload);
      readEntered.resolve();if(hold) await hold.promise;return result;
    }});
  const event=()=>({sender,senderFrame:sender.mainFrame});
  const register=()=>{
    producer?.dispose(); const lease=broker.register(event());
    producer=createSnapshot({epoch:lease.epoch,readWorkspace:()=>model.ws,readProjects:()=>model.projects,
      fileVerdict:p=>model.files.get(p),probeFiles:async paths=>{probes.push(paths);probeEntered.resolve();if(probeHold)await probeHold.promise},
      onChanged:clock=>broker.changed(event(),clock)});
    producer.refresh();return lease;
  };
  register();
  const ctx=vm.createContext({console:quiet,Date,JSON,Map,Set,WORKSPACE_SWITCHER_CAPABILITY,switcherRequestFromQuery,
    getWorkspaceSwitcherApi:()=>broker,workspaceSwitcherWake:()=>broker.wake(),
    sendJson:(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}});
  const api=webTree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleApi');
  const route=api.body.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(webTree).includes("'/api/workspace/switcher'"));
  assert.ok(route);vm.runInContext('async function route(req,res,parsed){'+route.getText(webTree)+'}',ctx);
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://private');ctx.route(req,res,{pathname:url.pathname,query:Object.fromEntries(url.searchParams)})
      .catch(error=>{res.writeHead(500);res.end(JSON.stringify({error:error.stack}))});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{hold?.resolve();probeHold?.resolve();producer.dispose();broker.retire();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  const get=async params=>{
    const start=performance.now(),response=await fetch('http://127.0.0.1:'+server.address().port+'/api/workspace/switcher?'+new URLSearchParams(params));
    const body=await response.text();return {status:response.status,value:JSON.parse(body),bytes:Buffer.byteLength(body),ms:performance.now()-start};
  };
  return {...model,broker,sender,event,register,wakeups,probes,sideEffects,get,readEntered:readEntered.promise,probeEntered:probeEntered.promise,producer:()=>producer,
    refresh:()=>producer.refresh(),lose:()=>{preferred=null;sender.emit('destroyed')},
    holdReply:()=>hold=deferred(),holdProbe:()=>probeHold=deferred()};
}
const ids=result=>result.rows.filter(row=>row.kind==='tab').map(row=>row.tabId);

test('actual desktop wrapper and HTTP use one selector; native context preserves A,B,A headers and all candidates',async t=>{
  const h=await harness(t);
  const context=vm.createContext({useWorkspaceStore:{getState:()=>h.ws},useProjectsStore:{getState:()=>({projects:h.projects})},
    captureSwitcherInputs:captureInputs,selectSwitcherRows:selectRows,isFileMissing:p=>h.files.get(p)===false,INBOX_PROJECT_NAME:'Inbox'});
  vm.runInContext(compile(declaration(overlayTree,'computeRowsFromStores')),context);
  const actual=context.computeRowsFromStores('',true);
  const desktop=await h.get({scope:'desktop'});assert.equal(desktop.status,200,JSON.stringify(desktop.value));
  assert.deepEqual(ids(desktop.value),Array.from(actual.filter(row=>row.kind==='tab'),row=>row.tab.id));
  assert.equal(desktop.value.view.anchorTabId,'a');assert.equal(desktop.value.initialTabId,'b');
  assert.equal(ids(desktop.value).includes('a2'),false,'other chips on the Mac screen are excluded');
  const before=JSON.stringify({mru:h.ws.globalTabMru,panes:h.ws.splitPanes});
  const native=await h.get({scope:'native',anchorTabId:'a',visibleTabIds:'["a"]'});
  assert.equal(native.status,200);assert.deepEqual(ids(native.value).slice(0,4),['a','b','a2','file']);
  assert.deepEqual(native.value.rows.filter(row=>row.kind==='workflow').slice(0,3).map(row=>row.workflowId),['A','B','A']);
  assert.equal(native.value.icons[native.value.rows.find(row=>row.workflowId==='B'&&row.kind==='workflow').iconId],'data:image/svg+xml,WORKFLOW_B');
  const visuals=await import('../renderer/utils/workflowVisuals.mjs');
  assert.deepEqual(native.value.rows.find(row=>row.workflowId==='A'&&row.kind==='workflow').iconFallback,
    {text:visuals.workflowInitial('Workflow A'),color:visuals.workflowFallbackColor('A')});
  assert.equal(ids(native.value).includes('child'),false);assert.equal(ids(native.value).includes('closed'),false);
  assert.equal(native.value.rows.find(row=>row.kind==='workflow'&&row.unplaced)?.workflowId,'__workflow_unplaced__');
  assert.equal(native.value.truncated,false);assert.ok(native.value.totalTabs>5);
  assert.equal(JSON.stringify(native.value).includes('SECRET'),false);
  assert.equal(JSON.stringify({mru:h.ws.globalTabMru,panes:h.ws.splitPanes}),before);
  assert.ok(h.sideEffects.every(x=>x==='readWorkspaceSwitcher'));
  evidence('wire-examples',{capability:WORKSPACE_SWITCHER_CAPABILITY,desktop:desktop.value,native:native.value,
    wake:h.broker.wake(),measurement:{bytes:native.bytes,ms:native.ms},sideEffects:h.sideEffects});
  console.log('[SwitcherTest] rows='+native.value.rows.length+' bytes='+native.bytes+' ms='+native.ms.toFixed(2));
});

test('explicit scope and exact native catalog validation: no hidden desktop default',async t=>{
  const h=await harness(t);
  for(const query of [{},{scope:'typo'},{scope:'native'},{scope:'desktop',anchorTabId:'a'},
    {scope:'native',anchorTabId:'a',visibleTabIds:'[]'},{scope:'native',anchorTabId:'a',visibleTabIds:'{}'}]) {
    assert.equal((await h.get(query)).status,400,JSON.stringify(query));
  }
  assert.equal(h.sideEffects.length,0,'bad syntax fails before bridge or file probe');
  for(const id of ['closed','child','not-here']) {
    const response=await h.get({scope:'native',anchorTabId:id,visibleTabIds:JSON.stringify([id])});
    assert.equal(response.status,409);assert.equal(response.value.error,'switcher_context_stale');
  }
  const noAnchor=await h.get({scope:'native',anchorTabId:'',visibleTabIds:'[]'});
  assert.equal(noAnchor.status,200);assert.equal(noAnchor.value.view.anchorTabId,null);
});

test('missing files stay visible, disabled and skipped; unknown availability is not fabricated missing',async t=>{
  const h=await harness(t);h.ws.globalTabMru=[{projectId:'P',tabId:'file'},{projectId:'P',tabId:'b'}];
  h.files.set('/private-fixture/readme.md',false);h.refresh();
  const query={scope:'native',anchorTabId:'a',visibleTabIds:'["a"]'};
  const r=(await h.get(query)).value,file=r.rows.find(row=>row.tabId==='file');
  assert.equal(file.availability,'missing');assert.equal(file.selectable,false);assert.equal(r.initialTabId,'b');
  h.files.delete('/private-fixture/readme.md');h.refresh();
  const unknown=(await h.get(query)).value.rows.find(row=>row.tabId==='file');
  assert.equal(unknown.availability,'unknown');assert.equal(unknown.selectable,true,'same desktop predicate until an exact missing verdict');
});

test('only anchor has no target; native visibility is independent of Mac panes',async t=>{
  const h=await harness(t);const all=[...h.ws.openProjects.get('P').tabs.keys()].filter(id=>id!=='child');
  const r=(await h.get({scope:'native',anchorTabId:'b',visibleTabIds:JSON.stringify(all)})).value;
  assert.deepEqual(ids(r),['b']);assert.equal(r.initialIndex,-1);assert.equal(r.initialTabId,null);
});

test('revision covers MRU, anchor, placement, title/icon and file verdict, not body/own busy',async t=>{
  const h=await harness(t);const clock=()=>h.broker.wake().revision;
  for(const [name,change] of [['MRU',()=>h.ws.globalTabMru.reverse()],
    ['placement',()=>h.ws.splitPanes.push({projectId:'P',tabId:'b'})],['focus',()=>h.ws.splitFocusedIndex=1],
    ['tab title',()=>h.ws.openProjects.get('P').tabs.get('a2').name='renamed'],
    ['workflow title',()=>h.ws.spaces[1].name='new workflow'],['workflow icon',()=>h.ws.spaces[1].icon='ICON_NEW'],
    ['file verdict',()=>h.files.set('/private-fixture/readme.md',false)]]) {
    const prior=clock();change();h.refresh();assert.ok(clock()>prior,name);
  }
  const prior=clock();h.ws.openProjects.get('P').tabs.get('a').notes='another SECRET';
  h.ws.openProjects.get('P').tabs.get('a').aiBusy=true;h.refresh();assert.equal(clock(),prior);
});

test('late captured reply after newer wake is rejected, not stamped with newer revision',async t=>{
  const h=await harness(t),hold=h.holdReply();
  const request=h.get({scope:'desktop'});await h.readEntered;
  h.ws.openProjects.get('P').tabs.get('b').name='newer';h.refresh();hold.resolve();
  const r=await request;assert.equal(r.status,409,JSON.stringify(r.value));assert.equal(r.value.error,'switcher_snapshot_superseded');
});

test('closed native anchor during a batch file probe returns context-stale',async t=>{
  const h=await harness(t),hold=h.holdProbe();
  const request=h.get({scope:'native',anchorTabId:'a2',visibleTabIds:'["a2"]'});
  await h.probeEntered;
  h.ws.openProjects.get('P').tabs.delete('a2');h.refresh();hold.resolve();
  assert.equal((await request).status,409);
});

test('renderer unavailable, foreign frame and new registration retire old snapshot/clock',async t=>{
  const h=await harness(t),old=h.broker.wake(),hold=h.holdReply();
  assert.equal(h.broker.changed({sender:h.sender,senderFrame:{processId:9,routingId:9}},
    {...old,revision:old.revision+1,available:true}),false);
  const request=h.get({scope:'desktop'});
  await h.readEntered;
  h.register();hold.resolve();
  assert.equal((await request).status,409);assert.notEqual(h.broker.wake().epoch,old.epoch);
  assert.equal(h.broker.changed(h.event(),{...old,revision:9999,available:true}),false);
  h.lose();const unavailable=await h.get({scope:'desktop'});
  assert.equal(unavailable.status,503);assert.equal(unavailable.value.known,false);assert.equal(unavailable.value.workspaceSwitcher.available,false);
});

test('existing Main scheduler coalesces switcher changes and SSE sends only a lightweight wake',async t=>{
  const h=await harness(t),timers=[],frames=[];
  const ctx=vm.createContext({path,srcMainDir:__dirname,projectActivityBroadcastTimer:null,projectLayoutChangedIds:new Set(),projectOrderChanged:false,projectCardSignals:null,
    setTimeout:fn=>{timers.push(fn);return fn},require:()=>({invalidateTabActivity(){},broadcastProjectActivity:reason=>frames.push(reason)})});
  vm.runInContext(declaration(mainTree,'scheduleProjectActivityBroadcast'),ctx);
  h.broker.onChanged=()=>ctx.scheduleProjectActivityBroadcast('workspace-switcher');
  h.ws.globalTabMru.reverse();h.refresh();h.ws.openProjects.get('P').tabs.get('a').name='second';h.refresh();
  assert.equal(timers.length,1);timers.shift()();assert.equal(frames.length,1);
  const sse=vm.createContext({computeProjectActivity:()=>({projects:[]}),publicTabActivity:null,
    stampPublicRuntimeSnapshot:(_id,value)=>value,workspaceSwitcherWake:()=>h.broker.wake(),
    runAfterWake:()=>({version:1,epoch:null,sequence:0,revalidate:true}),Date,console:quiet});
  vm.runInContext(declaration(webTree,'projectActivitySnapshot'),sse);
  const payload=sse.projectActivitySnapshot();
  assert.equal(payload.workspaceSwitcher.revision,h.broker.wake().revision);
  assert.ok(Buffer.byteLength(JSON.stringify(payload.workspaceSwitcher))<250);
  assert.equal(JSON.stringify(payload).includes('second'),false);
});

test('actual App subscriptions, Main registration IPC and exact web bridge compose without navigation',async t=>{
  const model=data(),calls=[],wakes=[],handlers=new Map(),mainEvents=new Map(),rendererEvents=new EventEmitter();
  const subscribers={workspace:new Set(),projects:new Set(),files:new Set(),startup:new Set()},published=deferred();
  let startup={blocking:true,phase:'projects'};
  const sender=new EventEmitter();sender.id=81;sender.mainFrame={processId:31,routingId:41};sender.isDestroyed=()=>false;
  const event=()=>({sender,senderFrame:sender.mainFrame});
  let replyHold=null;
  const ipcRenderer={
    invoke:async(name,...args)=>{calls.push(name);assert.ok(handlers.has(name),name);return handlers.get(name)(event(),...args)},
    send:(name,value)=>{
      calls.push(name);
      if(name==='web:bridge-reply'&&replyHold){replyHold.value=value;replyHold.entered.resolve();return;}
      assert.ok(mainEvents.has(name),name);mainEvents.get(name)(event(),value);
      if(name==='workspace-switcher:changed')published.resolve();
    },
    on:(...args)=>rendererEvents.on(...args),removeListener:(...args)=>rendererEvents.removeListener(...args),
  };
  const ref={current:null};
  const renderer=vm.createContext({console:quiet,ipcRenderer,createWorkspaceSwitcherSnapshot:createSnapshot,
    workspaceSwitcherRef:ref,INBOX_PROJECT_NAME:'Inbox',fileExistsVerdict:p=>model.files.get(p),
    getStartupRestoreProgress:()=>startup,
    subscribeStartupRestoreProgress:fn=>{subscribers.startup.add(fn);return()=>subscribers.startup.delete(fn)},
    probeFiles:async paths=>{calls.push('file:exists-batch');assert.deepEqual(Array.from(paths),['/private-fixture/readme.md']);},
    subscribeMissingFiles:fn=>{subscribers.files.add(fn);return()=>subscribers.files.delete(fn)},
    useWorkspaceStore:{getState:()=>model.ws,subscribe:fn=>{subscribers.workspace.add(fn);return()=>subscribers.workspace.delete(fn)}},
    useProjectsStore:{getState:()=>({projects:model.projects}),subscribe:fn=>{subscribers.projects.add(fn);return()=>subscribers.projects.delete(fn)}},
  });
  const hook=find(appTree,node=>ts.isCallExpression(node)&&node.expression.getText(appTree)==='useEffect'
    &&node.arguments[0]?.getText(appTree).includes("'workspace-switcher:register'"));
  vm.runInContext(compile('globalThis.effect='+hook.arguments[0].getText(appTree)),renderer);
  const branch=find(appTree,node=>ts.isIfStatement(node)&&node.expression.getText(appTree)==="action === 'readWorkspaceSwitcher'");
  vm.runInContext(compile("async function receive({requestId,action,payload}) { const reply=(ok,data,error)=>ipcRenderer.send('web:bridge-reply',{requestId,ok,data,error});"
    +branch.getText(appTree)+'}'),renderer);
  sender.send=(name,value)=>{assert.equal(name,'web:bridge-request');void renderer.receive(value)};
  const webContext=vm.createContext({console:quiet,Date,Promise,Map,Set,crypto:require('node:crypto'),setTimeout,clearTimeout,
    workspaceSwitcherApi:null,WorkspaceSwitcherReadProjection,switcherFrameKey,
    scheduleTabActivityBroadcast:reason=>wakes.push(reason),BrowserWindow:{getAllWindows:()=>[{webContents:sender,isDestroyed:()=>false}]},
    pendingBridge:new Map(),LATE_BRIDGE_REPLY_RETENTION_MS:1000,e2eBoundaryTestGate:null,bridgePayloadLabel:()=>'',
    ipcMain:{on:(name,fn)=>mainEvents.set(name,fn)},
  });
  for(const name of ['getWorkspaceSwitcherApi','bridgeRequest','registerBridgeReplyHandler'])vm.runInContext(declaration(webTree,name),webContext);
  webContext.registerBridgeReplyHandler();
  const mainContext=vm.createContext({path,srcMainDir:__dirname,
    ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on:(name,fn)=>mainEvents.set(name,fn)},
    require:name=>{assert.equal(name,path.join(__dirname,'web-server'));return {
      registerWorkspaceSwitcher:ev=>webContext.getWorkspaceSwitcherApi().register(ev),
      noteWorkspaceSwitcherChanged:(ev,v)=>webContext.getWorkspaceSwitcherApi().changed(ev,v),
      unregisterWorkspaceSwitcher:(ev,v)=>webContext.getWorkspaceSwitcherApi().unregister(ev,v),
    }},
  });
  for(const node of mainTree.statements.filter(n=>/^ipcMain\.(handle|on)\('workspace-switcher:/.test(n.getText(mainTree))))vm.runInContext(node.getText(mainTree),mainContext);
  const cleanup=renderer.effect();t.after(()=>{cleanup();webContext.getWorkspaceSwitcherApi().retire()});await published.promise;
  const broker=webContext.getWorkspaceSwitcherApi();
  assert.equal(broker.wake().available,false,'pre-restore bootstrap is not a known empty catalog');
  startup={blocking:true,phase:'agents'};subscribers.startup.forEach(fn=>fn());
  const old=broker.wake();assert.equal(old.available,true,'metadata does not wait for provider startup');
  const snapshot=await broker.read({scope:'desktop'});
  assert.equal(snapshot.view.anchorTabId,'a');assert.equal(snapshot.rendererOwner.frame,'31:41');
  model.ws.openProjects.get('P').tabs.get('a2').name='changed';subscribers.workspace.forEach(fn=>fn());
  assert.ok(broker.wake().revision>old.revision);
  const current=broker.wake().revision;model.ws.openProjects.get('P').tabs.get('a').notes='SECRET_NEW';subscribers.workspace.forEach(fn=>fn());
  assert.equal(broker.wake().revision,current);
  replyHold={entered:deferred()};const pending=broker.read({scope:'desktop'});await replyHold.entered.promise;
  mainEvents.get('web:bridge-reply')({sender,senderFrame:{processId:31,routingId:99}},replyHold.value);
  assert.equal(webContext.pendingBridge.size,1,'same webContents, foreign frame must not complete the read');
  mainEvents.get('web:bridge-reply')({sender:{},senderFrame:sender.mainFrame},replyHold.value);
  assert.equal(webContext.pendingBridge.size,1,'foreign renderer must not complete the read');
  mainEvents.get('web:bridge-reply')(event(),replyHold.value);await pending;replyHold=null;
  assert.equal(webContext.pendingBridge.size,0);
  model.ws.isRestoring=true;subscribers.workspace.forEach(fn=>fn());assert.equal(broker.wake().available,false);
  await assert.rejects(broker.read({scope:'desktop'}),e=>e.code==='switcher_renderer_unavailable');
  model.ws.isRestoring=false;subscribers.workspace.forEach(fn=>fn());assert.equal(broker.wake().available,true);
  assert.ok(wakes.every(reason=>reason==='workspace-switcher'));
  assert.ok(calls.every(name=>['workspace-switcher:register','workspace-switcher:changed','workspace-switcher:unregister',
    'file:exists-batch','web:bridge-reply'].includes(name)),JSON.stringify(calls));
  cleanup();assert.equal(ref.current,null);assert.ok(Object.values(subscribers).every(set=>set.size===0));
  assert.equal(broker.wake().available,false);
});

test('actual /me advertises both explicit scopes, no navigation capability or availability fiction',async()=>{
  const api=webTree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleApi');
  const route=api.body.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(webTree).includes("'/api/me'"));
  const context=vm.createContext({WORKSPACE_SWITCHER_CAPABILITY,RUN_AFTER_CAPABILITY:require('../shared/run-after-api.cjs').RUN_AFTER_CAPABILITY,checkAuth:()=>true,getLanIp:()=>null,
    require:name=>{assert.equal(name,'./project-manager');return {workflowOrganization:{ready:()=>false}}},
    getRunAfterApi:()=>({journal:{epoch:'private-run-after-epoch'}}),savedPromptService:null,
    getAgentResponseState:null,readAgentObservedResponse:null,
    webServerServiceHealth:()=>({instanceId:'private-instance'}),sendJson:(_res,status,value)=>({status,value}),
    projectCardSignals:null,publicTabActivity:null,publicHistoryFreshness:null,completionNotificationCapability:{version:1},
    agentSendQueue:null,systemPromptService:null,transcriptService:null,MAX_EVENT_TABS:128,readAgentTabTiming:null,
    readAgentUsage:null,readAgentParams:null,readAgentRuntimeSnapshot:null,codexGoalActions:null,readCodexAuthProfile:null,
    savedHistoryOperations:null,conversationOwners:null,inboxSavedHistoryOperations:null,agentSendReceiptStore:null,
    STRUCTURED_AUTHORING_LIMITS:{bytes:1000},MAX_CONTEXT_FILES:8,MAX_CONTEXT_FILE_BYTES:1000,MAX_CONTEXT_TOTAL_BYTES:8000,
  });
  vm.runInContext('async function route(req,res,parsed){'+route.getText(webTree)+'}',context);
  const result=await context.route({method:'GET'},null,{pathname:'/api/me'});
  assert.equal(result.status,200);assert.deepEqual(result.value.capabilities.workspaceSwitcher,WORKSPACE_SWITCHER_CAPABILITY);
  assert.equal(result.value.capabilities.workspaceSwitcher.available,undefined);
  assert.equal(result.value.capabilities.runAfter.version,1);
  assert.ok(result.value.capabilities.runAfter.queueOperations.includes('replay'));
  assert.ok(result.value.capabilities.runAfter.autoCompactOperations.includes('requestNow'));
  assert.equal(result.value.capabilities.runAfter.perPromptThinkingFast,false);
});

test('blocked external navigation keeps the live switcher and its pending HTTP read',async t=>{
  const h=await harness(t),before=h.broker.wake(),opened=[];
  const handler=find(mainTree,node=>ts.isCallExpression(node)
    &&node.expression.getText(mainTree)==='mainWindow.webContents.on'
    &&node.arguments[0]?.text==='will-navigate');
  const ctx=vm.createContext({console:quiet,isRendererUrl:()=>false,shell:{openExternal:url=>opened.push(url)}});
  vm.runInContext('globalThis.blockNavigation='+handler.arguments[1].getText(mainTree),ctx);
  const hold=h.holdReply(),pending=h.get({scope:'desktop'});await h.readEntered;
  const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};
  const url='https://external.invalid/example';
  // The installed log records this order: did-start-navigation, then the
  // existing will-navigate policy cancels it. The App/document never remounts.
  h.sender.emit('did-start-navigation',{},url,false,true);
  ctx.blockNavigation(event,url);
  assert.equal(event.defaultPrevented,true);assert.deepEqual(opened,[url]);
  hold.resolve();const result=await pending;
  assert.equal((await h.get({scope:'desktop'})).status,200,'reopening after cancellation must not stay unavailable');
  assert.equal(result.status,200,'cancelled navigation must not retire the still-live App');
  assert.equal(result.value.epoch,before.epoch);
  h.ws.openProjects.get('P').tabs.get('b').name='updated after external link';h.refresh();
  const next=await h.get({scope:'desktop'});
  assert.equal(next.status,200);assert.ok(next.value.revision>before.revision);
  assert.equal(next.value.rows.find(row=>row.tabId==='b').title,'updated after external link');
  assert.ok(h.sideEffects.every(action=>action==='readWorkspaceSwitcher'));
});

test('committed main navigation rejects a pending old read even when frame IDs are reused',async t=>{
  const h=await harness(t),old=h.broker.wake(),hold=h.holdReply();
  const pending=h.get({scope:'desktop'});await h.readEntered;
  h.sender.emit('did-start-navigation',{},'file:///private-fixture/reload.html',false,true);
  h.sender.emit('did-navigate',{},'file:///private-fixture/reload.html',-1,'');
  hold.resolve();const stale=await pending;
  assert.equal(stale.status,409);assert.equal(stale.value.error,'switcher_snapshot_superseded');
  assert.notEqual(h.broker.wake().epoch,old.epoch);assert.equal(h.broker.wake().available,false);
  assert.equal(h.broker.changed(h.event(),{...old,revision:old.revision+1,available:true}),false);
  h.register();
  assert.equal((await h.get({scope:'desktop'})).status,200);
  h.broker.unregister(h.event(),old);assert.equal(h.broker.wake().available,true);
  h.broker.retire();
  for(const name of ['did-start-navigation','did-navigate','render-process-gone','destroyed'])
    assert.equal(h.sender.listenerCount(name),0,'retired listener: '+name);
});

test('uncommitted failure, in-page and subframe navigation preserve the document; process loss does not',async t=>{
  const h=await harness(t),before=h.broker.wake();
  h.sender.emit('did-start-navigation',{},'http://private.invalid/failed',false,true);
  h.sender.emit('did-fail-provisional-load',{},-3,'ERR_ABORTED','http://private.invalid/failed',true,1,1);
  h.sender.emit('did-start-navigation',{},'http://private.invalid/#anchor',true,true);
  h.sender.emit('did-navigate-in-page',{},'http://private.invalid/#anchor',true,1,1);
  h.sender.emit('did-start-navigation',{},'http://private.invalid/child',false,false);
  h.sender.emit('did-frame-navigate',{},'http://private.invalid/child',200,'OK',false,2,2);
  assert.deepEqual(h.broker.wake(),before);assert.equal((await h.get({scope:'desktop'})).status,200);
  h.sender.emit('render-process-gone',{}, {reason:'crashed'});
  assert.equal(h.broker.wake().available,false);assert.equal((await h.get({scope:'desktop'})).status,503);
});

test('Main retirement/navigation, stale unregister and invalid replies cannot revive a lease',async t=>{
  const h=await harness(t),old=h.broker.wake();
  h.register();h.broker.unregister(h.event(),old);assert.equal(h.broker.wake().available,true);
  h.broker.unregister({sender:h.sender,senderFrame:{processId:1,routingId:99}},h.broker.wake());
  assert.equal(h.broker.wake().available,true,'foreign-frame cleanup cannot retire a valid lease');
  const current=h.broker.wake();h.sender.emit('did-start-navigation',{},'http://private',true,true);
  assert.equal(h.broker.wake().epoch,current.epoch,'same-document navigation preserves owner');
  h.sender.emit('did-start-navigation',{},'http://private/new',false,true);
  assert.equal(h.broker.wake().epoch,current.epoch,'a navigation attempt is not document replacement');
  h.sender.emit('did-navigate',{},'http://private/new',200,'OK');
  assert.notEqual(h.broker.wake().epoch,current.epoch);assert.equal(h.broker.wake().available,false);
  h.register();
  for(const bad of [{},{version:1,known:true,epoch:old.epoch,rows:[],revision:999},
    {version:1,known:true,epoch:h.broker.wake().epoch,rows:[],revision:999,requestKey:'other scope'}]){
    h.broker.bridgeRead=async()=>bad;
    await assert.rejects(h.broker.read({scope:'desktop'}),e=>e.code==='switcher_snapshot_invalid');
  }
  const clock=h.broker.wake();assert.equal(h.broker.changed(h.event(),{...clock,revision:clock.revision-1,available:true}),false);
  assert.equal(h.broker.changed(h.event(),{...clock,revision:clock.revision+1,available:'yes'}),false);
});

test('global rank spans projects, projectHistory orders the unranked tail, visual children remain full sessions',async t=>{
  const h=await harness(t);
  h.ws.openProjects.set('Q',{projectPath:'/fixture/Q',tabs:new Map([
    ['q',{id:'q',name:'Q',tabType:'terminal',commandType:'claude'}],['q-unranked',{id:'q-unranked',name:'Tail'}]])});
  h.ws.projectHistory=['P','Q'];h.ws.globalTabMru=[{projectId:'P',tabId:'b'},{projectId:'Q',tabId:'q'}];
  h.ws.openProjects.get('P').tabs.set('full-child',{id:'full-child',name:'Independent session',visualParentTabId:'a',commandType:'codex'});
  const result=(await h.get({scope:'native',anchorTabId:'',visibleTabIds:'[]'})).value;
  assert.deepEqual(ids(result).slice(0,4),['b','q','q-unranked','a']);
  assert.equal(result.rows.find(row=>row.tabId==='q').provider,'claude');
  assert.ok(ids(result).includes('full-child'));assert.ok(!ids(result).includes('child'));
  h.ws.spaces[1].layout.splitPanes[0].tabs.push({projectId:'P',tabId:'a'});
  const current=(await h.get({scope:'desktop'})).value;
  assert.equal(current.rows.find(row=>row.tabId==='a').workflowId,'A','active live layout wins over a duplicate saved placement');
});

test('opaque percent/Unicode ids stay exact and the complete large catalog carries metadata only',async t=>{
  const h=await harness(t),opaque='tab=процент%2F / #?';
  h.ws.openProjects.get('P').tabs.set(opaque,{id:opaque,name:'Opaque',tabType:'terminal',commandType:'codex'});
  const r=await h.get({scope:'native',anchorTabId:opaque,visibleTabIds:JSON.stringify([opaque])});
  assert.equal(r.status,200);assert.equal(r.value.view.anchorTabId,opaque);assert.equal(ids(r.value)[0],opaque);
  const tabs=h.ws.openProjects.get('P').tabs;
  for(let index=0;index<500;index++)tabs.set('synthetic-'+index,{id:'synthetic-'+index,name:'Synthetic '+index,
    tabType:'terminal',commandType:'codex',notes:'SECRET_BODY'.repeat(10000)});
  const large=await h.get({scope:'native',anchorTabId:'',visibleTabIds:'[]'});
  assert.equal(large.value.totalTabs,507);assert.equal(large.value.truncated,false);
  assert.equal(JSON.stringify(large.value).includes('SECRET_BODY'),false);assert.ok(large.bytes<250000,large.bytes);
  const start=performance.now(),prior=h.broker.wake().revision;
  for(let i=0;i<50;i++){tabs.get('a').aiBusy=i%2===0;h.refresh()}
  const refreshMs=performance.now()-start;
  assert.equal(h.broker.wake().revision,prior,'own work is not switcher metadata');
  assert.ok(h.probes.length<=2,'one bounded file batch per GET, never one per tab');
  assert.ok(h.sideEffects.every(x=>x==='readWorkspaceSwitcher'));
  evidence('large-catalog',{tabs:large.value.totalTabs,rows:large.value.rows.length,bytes:large.bytes,httpMs:large.ms,
    sameMetadataRefreshes:50,refreshMs,clockUnchanged:true,fileBatches:h.probes.length,noHistoryOrParamsOrLaunch:true});
  console.log('[SwitcherTest] tabs='+large.value.totalTabs+' bytes='+large.bytes+' ms='+large.ms.toFixed(2)+' refresh50Ms='+refreshMs.toFixed(2));
});

test('same workflow/project icon bytes occur once per response; no second asset request or old-marker opt-in',async t=>{
  const h=await harness(t),shared='data:image/png;base64,'+'A'.repeat(40000);
  h.projects.P.icon=shared;h.ws.spaces[0].icon=shared;h.ws.spaces[1].icon=shared;
  for(let i=0;i<50;i++)h.ws.openProjects.get('P').tabs.set('extra-'+i,{id:'extra-'+i,name:'Extra '+i,tabType:'terminal'});
  const r=await h.get({scope:'native',anchorTabId:'a',visibleTabIds:'["a"]'});
  assert.equal(r.status,200);assert.equal(r.value.iconCatalogVersion,1);
  assert.deepEqual(Object.values(r.value.icons),[shared]);
  for(const row of r.value.rows) {
    const ref=row.kind==='workflow'?row.iconId:row.projectIconId;
    if(ref)assert.equal(r.value.icons[ref],shared);
    assert.equal(row.icon,undefined);assert.equal(row.projectIcon,undefined);
  }
  assert.ok(r.bytes<70000,r.bytes);assert.equal(h.probes.length,1);
  const older={...r.value};delete older.iconCatalogVersion;
  h.broker.bridgeRead=async()=>older;
  await assert.rejects(h.broker.read({scope:'native',anchorTabId:'a',visibleTabIds:['a']}),e=>e.code==='switcher_snapshot_invalid');
  evidence('icon-catalog',{tabs:r.value.totalTabs,rows:r.value.rows.length,uniqueIcons:Object.keys(r.value.icons).length,
    singleIconBytes:Buffer.byteLength(shared),responseBytes:r.bytes,noExternalAssetRequest:true});
});
