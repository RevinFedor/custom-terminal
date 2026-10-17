'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {transformSync}=require('esbuild');
const native=require('./prompt-native-menu-owner');
const {buildPromptMenuTemplate}=require('./prompt-menu-template');
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
let menuCode,bridgeCode;
async function scoped(start,end) {
  const stream=fs.createReadStream(path.join(__dirname,'main.js'),{encoding:'utf8'}),reader=readline.createInterface({input:stream});
  const lines=[];let inside=false;
  try{for await(const line of reader){if(line.startsWith(start))inside=true;if(inside&&line.startsWith(end))break;if(inside)lines.push(line);}}
  finally{reader.close();stream.destroy();}
  assert.ok(lines.length);return lines.join('\n');
}
test.before(async()=>{
  menuCode=await scoped("ipcMain.on('show-terminal-context-menu'",'// ========== MCP HTTP SERVER');
  bridgeCode=await scoped('function rendererBridgeRequestForMcp(','// ─── MCP Hub');
});
function fixture({mode='sdk',legacy=false,read,probe=async()=>true}={}) {
  const sender=new EventEmitter(),window=new EventEmitter(),handlers=new Map(),popups=[],commands=[];
  sender.isDestroyed=()=>false;window.isDestroyed=()=>false;
  sender.send=(...args)=>commands.push(args);
  const terminals=new Map(),sdkSessions=new Map();let generation=1;
  const row={id:12,execution_archived:0};
  const scope={version:2,executionNamespace:'N',subjectId:'subject'};
  const context={require:name=>{assert.ok(name.endsWith('prompt-native-menu-owner'));return native;},path,srcMainDir:'/main',
    ipcMain:{on:(name,fn)=>handlers.set(name,fn)},BrowserWindow:{fromWebContents:s=>{assert.equal(s,sender);return window}},
    workflowOrganization:{ready:()=>true,execution:()=>({row,scope})},
    projectManager:{getPrompts:()=>[{id:1,title:'Global',position:0}],getPromptGroups:()=>[],getAIPrompts:()=>[],
      db:{db:{prepare:()=>({get:()=>({command_type:'generic'})})}}},
    projectPromptCatalog:{listTab:read||(()=>Promise.resolve({tabId:'T',sources:[],prompts:[{id:'project-prompt:N:1',title:'File',file_paths:['/prompt']}]}))},
    buildPromptMenuTemplate,getLiveAiRuntimeOwners:()=>[],terminals,sdkSessions,terminalCommandState:new Map(),getTerminalLifecycleGeneration:()=>generation,
    rendererBridgeRequestForMcp:async(...args)=>{assert.equal(args[0],'validatePromptNativeMenuIntent');assert.equal(args[3],sender);return probe(...args)},
    Menu:{buildFromTemplate:template=>({popup:options=>popups.push({template,options})})},console:{warn(){},error(){}}};
  vm.runInNewContext(menuCode,context);
  const payload={tabId:'T',projectId:'N',hasSelection:false,prompts:[{id:1,title:'Global',position:0}],
    ...(legacy?{}:{intent:{id:'opaque',tabId:'T',projectId:'N',kind:mode}})};
  return {sender,window,row,scope,popups,commands,terminals,sdkSessions,payload,
    generation:value=>generation=value,
    dispatch:payload=>handlers.get(mode==='sdk'?'show-sdk-context-menu':'show-terminal-context-menu')({sender},payload),
    run:()=>handlers.get(mode==='sdk'?'show-sdk-context-menu':'show-terminal-context-menu')({sender},payload)};
}

for(const mode of ['sdk','terminal'])test(`actual ${mode} handler awaits metadata, preserves globals on typed failure and binds command to T`,async()=>{
  const read=deferred(),f=fixture({mode,read:()=>read.promise});
  const pending=f.run();assert.equal(f.popups.length,0);
  read.reject(Object.assign(new Error('preparing'),{code:'prompt_catalog_preparing'}));await pending;
  assert.equal(f.popups.length,1);
  const insert=f.popups[0].template.find(r=>r.label==='Insert Prompt');assert.equal(insert.submenu[0].enabled,false);
  insert.submenu.at(-1).click();const payload=f.commands.at(-1)[2];
  assert.equal(payload.tabId,'T');assert.equal(payload.projectId,'N');assert.equal(payload.intent.id,'opaque');
  f.popups[0].options.callback();assert.equal(f.sender.listenerCount('before-input-event'),0);
});

test('request replacement, UI cancellation, deleted target and physical replacement each prevent late popup',async()=>{
  for(const kind of ['escape','blur','deleted','generation','instance','ui']){
    const read=deferred(),f=fixture({read:()=>read.promise,probe:async()=>kind!=='ui'});const pending=f.run();
    if(kind==='escape')f.sender.emit('before-input-event',{}, {type:'keyDown',key:'Escape'});
    if(kind==='blur')f.window.emit('blur');
    if(kind==='deleted')f.row.execution_archived=1;
    if(kind==='generation')f.generation(2);
    if(kind==='instance')f.sdkSessions.set('T',{});
    read.resolve({tabId:'T',sources:[],prompts:[]});await pending;
    assert.equal(f.popups.length,0,kind);
  }
  const first=deferred();let reads=0;const f=fixture({read:()=>++reads===1?first.promise:Promise.resolve({tabId:'T',sources:[],prompts:[]})});
  const old=f.run();await f.run();first.resolve({tabId:'T',sources:[],prompts:[]});await old;
  assert.equal(f.popups.length,1);f.popups[0].options.callback();
});

test('closing a cold native menu does not reopen it on later catalog publication; old payload compatibility needs no UI probe',async()=>{
  let probes=0;const f=fixture({legacy:true,probe:async()=>{probes++;return true;},read:async()=>{throw Object.assign(new Error('failed'),{code:'prompt_catalog_failed'});}});
  await f.run();assert.equal(probes,0);assert.equal(f.popups.length,1);f.popups[0].options.callback();
  f.sender.emit('project-prompts:changed',{});await tick();assert.equal(f.popups.length,1);
});

test('actual bridge selects exact sender, rejects another sender reply and preserves default mainWindow',async()=>{
  const ipcMain=new EventEmitter(),main=new EventEmitter(),exact=new EventEmitter();
  main.isDestroyed=exact.isDestroyed=()=>false;let sentMain,sentExact;
  main.send=(_channel,p)=>{sentMain=p};exact.send=(_channel,p)=>{sentExact=p};
  const context={ipcMain,mainWindow:{isDestroyed:()=>false,webContents:main},crypto:{randomBytes:()=>({toString:()=>Math.random().toString(16)})},setTimeout,clearTimeout};
  vm.runInNewContext(bridgeCode+'\nglobalThis.call=rendererBridgeRequestForMcp;',context);
  let settled=false;const pending=context.call('validatePromptNativeMenuIntent',{},1000,exact).then(v=>{settled=true;return v});
  assert.ok(sentExact);assert.equal(sentMain,undefined);
  ipcMain.emit('web:bridge-reply',{sender:main},{requestId:sentExact.requestId,ok:true,data:true});await tick();assert.equal(settled,false);
  ipcMain.emit('web:bridge-reply',{sender:exact},{requestId:sentExact.requestId,ok:true,data:false});assert.equal(await pending,false);
  const old=context.call('legacy',{});assert.ok(sentMain);ipcMain.emit('web:bridge-reply',{sender:main},{requestId:sentMain.requestId,ok:true,data:7});assert.equal(await old,7);
  assert.equal(ipcMain.listenerCount('web:bridge-reply'),0);
});

test('actual origin→exact bridge→popup→command→file-read chain keeps T while keyboard focus belongs to B',async t=>{
  const ui=await import('../renderer/utils/promptNativeMenuIntent.mjs');
  const readers=new Set(),events={addEventListener:(_n,f)=>readers.add(f),removeEventListener:(_n,f)=>readers.delete(f)};
  const previous=global.window;global.window=events;t.after(()=>{global.window=previous});
  const ipcMain=new EventEmitter(),meta=deferred(),file=deferred(),writes=[];
  const state={openProjects:new Map([['N',{tabs:new Map([['T',{}],['B',{}]])}]])};
  const bridgeContext={ipcMain,mainWindow:null,crypto:{randomBytes:()=>({toString:()=>Math.random().toString(16)})},setTimeout,clearTimeout};
  vm.runInNewContext(bridgeCode+'\nglobalThis.call=rendererBridgeRequestForMcp;',bridgeContext);
  const f=fixture({mode:'terminal',read:()=>meta.promise,probe:(...args)=>bridgeContext.call(...args)});
  const app=fs.readFileSync(path.join(__dirname,'../renderer/App.tsx'),'utf8');
  const scalar="if (action === 'validatePromptNativeMenuIntent') return reply(true,validatePromptNativeMenuIntent(payload?.intent));";
  assert.ok(app.includes(scalar));
  const scalarContext={validatePromptNativeMenuIntent:ui.validatePromptNativeMenuIntent};
  vm.runInNewContext(transformSync('globalThis.read=(action,payload,reply)=>{'+scalar+'};',{loader:'tsx'}).code,scalarContext);
  const start=app.indexOf("      if (cmd === 'insert-prompt')"),end=app.indexOf("} else if (cmd === 'add-to-favorites-from-terminal')",start);
  const appContext={cmd:'insert-prompt',data:null,capturedPromptCommandTarget:ui.capturedPromptCommandTarget,
    getEffectiveTabId:()=> 'B',useWorkspaceStore:{getState:()=>state},console:{warn(){}},
    ipcRenderer:{send:(...args)=>writes.push(args),invoke:(channel,payload)=>channel==='ai-prompts:read-files'?file.promise:(writes.push([channel,payload]),Promise.resolve({success:true}))}};
  vm.runInNewContext(transformSync('globalThis.run=()=>{'+app.slice(start,end)+'}};',{loader:'tsx'}).code,appContext);
  f.sender.send=(channel,...args)=>{
    if(channel==='web:bridge-request'){
      const request=args[0];scalarContext.read(request.action,request.payload,(ok,data)=>ipcMain.emit('web:bridge-reply',{sender:f.sender},{requestId:request.requestId,ok,data}));
    }else if(channel==='context-menu-command'){appContext.data=args[1];appContext.run();}
  };
  const terminal=fs.readFileSync(path.join(__dirname,'../renderer/components/Workspace/Terminal.tsx'),'utf8');
  const a=terminal.indexOf('  const openTerminalContextMenu = async'),b=terminal.indexOf('\n  // Handle context menu',a);
  let mainRun;
  const caller={tabId:'T',cwd:'/source',xtermInstance:{current:{hasSelection:()=>false}},useWorkspaceStore:{getState:()=>state},
    tabAllowsShellActions:()=>true,nativeMenuSourceRef:{current:Symbol('T')},nativeMenuPresentedRef:{current:true},beginPromptNativeMenuIntent:ui.beginPromptNativeMenuIntent,
    ipcRenderer:{invoke:async name=>name==='prompts:get'?{success:true,data:[]}:'/source',send:(_name,payload)=>{mainRun=f.dispatch(payload)}}};
  vm.runInNewContext(transformSync(terminal.slice(a,b)+'\nglobalThis.open=openTerminalContextMenu;',{loader:'tsx'}).code,caller);
  await caller.open();assert.equal(f.popups.length,0);meta.resolve({tabId:'T',sources:[],prompts:[{id:'p',title:'File',file_paths:['/prompt']}]});await mainRun;
  assert.equal(f.popups.length,1);const insert=f.popups[0].template.find(r=>r.label==='Insert Prompt');insert.submenu[0].submenu.find(r=>r.label==='File').click();
  assert.equal(writes[0][1],'T');file.resolve({success:true,data:[{content:'body'}]});await tick();
  assert.equal(writes.find(r=>r[0]==='terminal:paste')[1].tabId,'T');
  f.popups[0].options.callback();ui.invalidatePromptNativeMenuSource(caller.nativeMenuSourceRef.current);
});
