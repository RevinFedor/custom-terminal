import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {transformSync} from 'esbuild';

const root=process.env.NOTED_U23_SOURCE_ROOT?path.resolve(process.env.NOTED_U23_SOURCE_ROOT)
  :path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const actual=relative=>import(pathToFileURL(path.join(root,relative)));
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const {commitPaneStripGroupPresentation}=await actual('src/renderer/utils/paneStripGroupPresentationCommit.mjs');
const {createOrganizationCommitter,organizationSnapshot,organizationProjection,reconcileWorkflowOrder}=await actual('src/renderer/utils/workflowOrganizationClient.mjs');
const groups=await actual('src/renderer/utils/paneStripGroupsModel.mjs');
const selection=await actual('src/renderer/utils/paneStripSelectionModel.mjs');
const pairs=await actual('src/renderer/utils/paneStripReleasePair.mjs');
const {emptySpaceLayout,captureSpaceLayout}=await actual('src/renderer/utils/workspaceSpacesModel.mjs');
const raw=await actual('src/shared/pane-strip-color-groups.cjs');
const {preparePaneStripGroupRelease,assertPaneStripGroupRelease}=await actual('src/shared/pane-strip-group-admission.cjs');
const {dragPlacement}=await actual('src/shared/workflow-drag.cjs');
const {newerWorkflowGroups}=await actual('src/renderer/utils/workflowGroupClient.mjs');
const clone=structuredClone;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const entry=tabId=>({projectId:'P',tabId});
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
const button=(tree,name)=>all(tree).find(node=>node.props?.['data-tab-context-action']===name);
const groupCurrent=lease=>(lease.isGroupCurrent||lease.isCurrent)();

// Actual components execute against finite hook/store/event ports. These are
// source controls, not a mounted React/DOM or Electron/SQL acceptance run.
function hooks(){
  const slots=[],effects=[];let cursor=0,changed=false;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
    createContext:()=>({}),useContext:()=>null,
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
      return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useMemo:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:fn(),deps};return slots[i].value;},
    useCallback:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:fn,deps};return slots[i].value;},
    useEffect:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k])){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=cb();});}}};
  return {React,render:fn=>{let result,n=0;do{assert.ok(n++<8);cursor=0;changed=false;result=fn();while(effects.length)effects.shift()();}while(changed);return result;},
    dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
function moduleFrom(source,ports){const module={exports:{}};vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs'}).code,
  {module,exports:module.exports,console,crypto,Map,Set,window:{addEventListener(){},removeEventListener(){}},document:{body:{}},...ports});return module.exports;}

function actualOriginalLease(state,store,{whole=false}={}){
  const h=hooks(),exports=moduleFrom(read('src/renderer/components/Workspace/PaneStripSelection.tsx'),{require:name=>{
    if(name==='react')return h.React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
    if(name.endsWith('paneStripSelectionModel.mjs'))return selection;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
    if(name.endsWith('paneStripOutsideSelection.mjs'))return {registerPaneStripOutsideSelection:()=>()=>{}};
    if(name.endsWith('paneTabDragBridge'))return {getPaneTabDragSnapshot:()=>({active:false}),subscribePaneTabDrag:()=>()=>{}};
    if(name.endsWith('paneTabPointerBridge'))return {getPaneTabPointerSnapshot:()=>({active:false}),subscribePaneTabPointer:()=>()=>{}};
    throw Error(name);}});
  const render=()=>h.render(()=>exports.usePaneStripSelectionController({workflowId:'W',windowId:'win',paneIndex:0,
    entries:state.splitPanes[0].tabs,presented:true}));
  render().click('a',{});if(whole)render().click('b',{shiftKey:true});
  const lease=render().menu('a');assert.ok(lease);return {lease,h};
}
function actualMenu(lease,store,runtime){
  let closed=0;
  const h=hooks(),toasts=[],exports=moduleFrom(read('src/renderer/components/Workspace/PaneStripSelectionMenu.tsx'),{require:name=>{
    if(name==='react')return h.React;if(name==='react-dom')return {createPortal:node=>node};
    if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
    if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
    if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({showToast:(...args)=>toasts.push(args)})}};
    if(name.endsWith('paneStripSelectionModel.mjs'))return selection;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
    if(name.endsWith('ptyAgentOwner.mjs'))return {resolvePtyAgentOwner:()=>null};
    if(name.endsWith('paneStripSelectionActions.mjs'))return {tabSessionUuid:()=>null};
    if(name.endsWith('contextMenuMetrics.mjs'))return {CONTEXT_MENU_COMPACT_ROW_STYLE:{},CONTEXT_MENU_ROW_STYLE:{},CONTEXT_MENU_TOP_DIVIDER_STYLE:{},CONTEXT_MENU_PANEL_STYLE:{}};
    return new Proxy({__esModule:true,default:()=>null},{get:(target,key)=>key in target?target[key]:()=>null});}});
  const render=()=>h.render(()=>exports.default({lease,onClose(){closed++;},runtimePort:{run:async(action,target)=>runtime.push([action,target.entries.map(entry=>entry.tabId)])}}));
  return {h,toasts,render,get closed(){return closed;}};
}

async function fixture({afterAdoption,loseAck=false,localRelease=false}={}){
  const layout={...emptySpaceLayout(),activeProjectId:'P',focusedProjectId:'P',activeSpaceTab:entry('a'),
    splitPanes:[{windowId:'win',projectId:'P',tabId:'a',tabs:['a','b'].map(entry)}]};
  const sourceLayout={...emptySpaceLayout(),activeProjectId:'P',activeSpaceTab:entry('x'),
    splitPanes:[{windowId:'source',projectId:'P',tabId:'x',tabs:[entry('x')]}]};
  const field={version:1,revision:1,groups:[{id:'g',revision:1,color:'#abcdef',collapsed:true,tabIds:['a','b']}]};
  const members={a:{tabId:'a',workflowId:'W',revision:1},b:{tabId:'b',workflowId:'W',revision:1},x:{tabId:'x',workflowId:'S',revision:1}};
  const state={...clone(layout),activeSpaceId:'W',view:'workspace',navigationRevision:8,organizationReady:true,isRestoring:false,
    organizationRevision:1,organizationGeneration:1,organizationWorkflowOrder:['W','S'],
    spaces:[{id:'W',kind:'user',stripColorGroups:clone(field),layout:clone(layout)},{id:'S',kind:'user',layout:clone(sourceLayout)}],
    tabWorkflowMembership:clone(members),pendingTabWorkflowMembership:{},tabCatalog:Object.fromEntries(['a','b','x'].map(id=>[id,{active:true,namespace:'P',storageId:id}])),
    openProjects:new Map([['P',{projectId:'P',projectPath:'/fixture',activeTabId:'a',tabs:new Map(['a','b','x'].map(id=>[id,{id,cwd:'/fixture',input:'kept',tabType:'terminal'}]))}]]),
    globalGroups:{version:1,revision:1,groups:[],tabGroups:{},membershipRevisions:{}},saveSession(){},refreshOrganizationCatalog:async()=>{}};
  const listeners=new Set();const store=fn=>fn(state);store.getState=()=>state;store.setState=patch=>{Object.assign(state,patch);for(const fn of listeners)fn(state);};
  store.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  let mainSpaces=clone(state.spaces),mainMembers=clone(members),revision=1,lost=false,receiptHidden=false,blockedLocal=false,releaseRequest;
  const inactive=new Set(),writes=[],receipts=new Map(),entered=deferred(),ack=deferred();
  const snapshot=()=>({publication:{version:1,migrationVersion:1,revision,generation:1,metadata:{workflowOrder:['W','S']}},
    workflows:mainSpaces.map(space=>({id:space.id,kind:'user',revision,metadata:{...(space.stripColorGroups?{stripColorGroups:clone(space.stripColorGroups)}:{})},layout:clone(space.layout)})),
    tabs:Object.entries(mainMembers).map(([tabId,membership])=>({tabId,membership:clone(membership),legacyRow:inactive.has(tabId)?null:{id:tabId},executionSubject:{projectId:'P'},revision:1})),
    globalGroups:state.globalGroups});
  // Use the actual Store applyPublication callback, not a rewritten adoption.
  const fullStore=read('src/renderer/store/useWorkspaceStore.ts'),start=fullStore.indexOf('  applyPublication:async (result:any,request:any,diagnostic?'),end=fullStore.indexOf('\n  onError:',start);
  assert.ok(start>0&&end>start);const callback=fullStore.slice(start,end).trim().replace(/^applyPublication:/,'').replace(/,$/,'');
  const actualApplyPublication=moduleFrom('module.exports=('+callback+');',{useWorkspaceStore:store,ipcRenderer:{invoke:async channel=>{assert.equal(channel,'workflow:read');return snapshot();}},
    organizationProjection,reconcileWorkflowOrder,newerWorkflowGroups,applyPaneStripGatherPublication:groups.applyPaneStripGatherPublication,
    adoptPaneStripColorGroups:raw.adoptPaneStripColorGroups,applyPaneStripReleasePublication:pairs.applyPaneStripReleasePublication,
    uiDiagnosticAbsNow:()=>0,uiDragActionId:id=>id,uiDragDiagnostic:()=>{}});
  let afterB5;
  const applyPublication=async(...args)=>{const result=await actualApplyPublication(...args);
    if(args[1].stripGroupReleases?.length){
      afterB5={raw:clone(state.spaces[0].stripColorGroups),slots:clone(state.splitPanes[0].tabs),nav:state.navigationRevision,
        canonical:clone(state.tabWorkflowMembership.x),pending:clone(state.pendingTabWorkflowMembership.x??null),envelope:clone(state.paneStripReleasedPairs)};
      afterAdoption?.({state,store,mainSpaces,mainMembers,inactive});
    }
    return result;};
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),applyPublication,onError(){},invoke:async(channel,payload)=>{
    if(channel==='workflow:mutation'){
      if(loseAck&&payload==='B5-exact-IN'&&!receiptHidden){receiptHidden=true;return null;}
      return receipts.get(payload)||null;
    }
    assert.equal(channel,'workflow:mutate');const {kind,request}=payload;writes.push({kind,request:clone(request)});
    if(receipts.has(request.mutationId))return receipts.get(request.mutationId);
    if(request.stripGroupReleases?.length){
      releaseRequest=clone(request);
      if(kind==='commitDrag'){entered.resolve();await ack.promise;}
      const changes=kind==='commitDrag'?request.workflows:request.spaces.map(space=>({workflowId:space.id,layout:space.layout}));
      const destination=request.targetWorkflowId||request.tabWorkflowMembership.x.workflowId;
      for(const intent of request.stripGroupReleases){const old=mainSpaces.find(space=>space.id===intent.workflowId),change=changes.find(value=>value.workflowId===old.id);
        assertPaneStripGroupRelease(intent,{workflowId:old.id,field:old.stripColorGroups,beforeLayout:old.layout,layout:change.layout,
          rootTabIds:['x'],placementTabIds:['x'],targetOwner:intent.workflowId===destination
            ?{paneIndex:0,windowId:destination==='S'?'source':'win',centerKey:null}:null,isActive:()=>true});}
      mainSpaces=mainSpaces.map(space=>{const change=changes.find(value=>value.workflowId===space.id),intent=request.stripGroupReleases.find(value=>value.workflowId===space.id);
        return change?{...space,layout:clone(change.layout),...(intent?{stripColorGroups:clone(intent.nextState)}:{})}:space;});
      const moving=request.tabs?.find(value=>value.tabId==='x'),local=request.tabWorkflowMembership?.x;
      // Controlled IPC admission port: exact membership CAS, in addition to
      // the actual shared raw/order proof above. This is not a Main/SQL run.
      if(moving){
        assert.equal(moving.expected.workflowId,mainMembers.x.workflowId);
        assert.equal(moving.expected.membershipRevision,mainMembers.x.revision);
      }else{
        assert.equal(local.expectedMembershipRevision,mainMembers.x.revision);
        assert.equal(local.revision,mainMembers.x.revision+Number(local.workflowId!==mainMembers.x.workflowId));
      }
      mainMembers.x=moving?{tabId:'x',workflowId:moving.workflowId,
        revision:moving.expected.membershipRevision+Number(moving.workflowId!==moving.expected.workflowId)}
        :{tabId:'x',workflowId:local.workflowId,revision:local.revision};
    } else {
      if(localRelease&&!blockedLocal){blockedLocal=true;entered.resolve();await ack.promise;}
      for(const edit of request.stripColorGroupEdits||[]){const old=mainSpaces.find(space=>space.id===edit.workflowId),next=request.spaces.find(space=>space.id===edit.workflowId);
        old.stripColorGroups=raw.mergePaneStripColorGroups(old.stripColorGroups,next.stripColorGroups,edit);}
    }
    const result={success:true,revision:++revision,generation:1,mutationId:request.mutationId};receipts.set(request.mutationId,result);
    if(loseAck&&kind==='commitDrag'&&!lost){lost=true;throw Error('controlled_lost_B5_ack');}
    return result;
  }});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const nextLayout=clone(layout);nextLayout.splitPanes[0].tabs=['a','x','b'].map(entry);
  const nextSource=clone(sourceLayout);nextSource.splitPanes[0]={windowId:'source',projectId:'P',tabId:'',tabs:[]};
  const prepared=preparePaneStripGroupRelease({workflowId:'W',field,beforeLayout:layout,layout:nextLayout,
    rootTabIds:['x'],placementTabIds:['x'],targetOwner:{paneIndex:0,windowId:'win',centerKey:null},isActive:()=>true});
  const request={mutationId:'B5-exact-IN',version:1,expectedRevision:1,targetWorkflowId:'W',destinationKind:'window',
    tabs:[{tabId:'x',workflowId:'W',expected:{workflowId:'S',membershipRevision:1}}],
    workflows:[{workflowId:'W',expectedPlacement:dragPlacement(layout),beforeLayout:layout,layout:nextLayout,reserveOrder:[],reserveRootOrder:[]},
      {workflowId:'S',expectedPlacement:dragPlacement(sourceLayout),beforeLayout:sourceLayout,layout:nextSource,reserveOrder:[],reserveRootOrder:[]}],
    stripGroupReleases:[prepared.intent]};
  let command;
  if(localRelease){
    const blocker=committer.commit(()=>organizationSnapshot(state));blocker.catch(()=>{});await entered.promise;
    const nextSpaces=state.spaces.map(space=>({...space,layout:space.id==='W'?nextLayout:nextSource}));
    const released=pairs.preparePaneStripLocalRelease(state,nextSpaces,{rootTabIds:['x'],targetWorkflowId:'W',targetOwner:{paneIndex:0,windowId:'win',centerKey:null}});
    store.setState({...released,...released.spaces[0].layout});
    command=pairs.enqueuePaneStripLocalRelease({getState:()=>state,setState:store.setState,committer,snapshot:organizationSnapshot(state)});
  }else{
    const beforeSnapshot=organizationSnapshot(state);store.setState(pairs.publishPaneStripDragRelease(state,request));
    command=committer.command('commitDrag',request,{beforeSnapshot,isCurrent:()=>!!state.paneStripReleasedPairs.commands[request.mutationId],
      onStage:event=>store.setState(pairs.notePaneStripReleaseStage(state,event))});
    await entered.promise;
  }
  command.catch(()=>{});
  let pending,settingsLease;state.commitPaneStripGroupPresentation=(lease,groupId,options)=>{settingsLease=lease;
    pending=commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId,...options});pending.catch(()=>{});return pending;};
  return {state,store,committer,writes,get request(){return releaseRequest||request;},command,ack,get pending(){return pending;},get settingsLease(){return settingsLease;},get mainSpaces(){return mainSpaces;},get mainMembers(){return mainMembers;},get afterB5(){return afterB5;}};
}

function releasedReturnTrip(f,{local=false}={}){
  const commands=[];
  for(const targetWorkflowId of ['S','W']){
    const state=f.state,beforeSnapshot=organizationSnapshot(state),beforeW=captureSpaceLayout(state),beforeS=state.spaces.find(space=>space.id==='S').layout;
    const nextW=clone(beforeW),nextS=clone(beforeS),intoW=targetWorkflowId==='W';
    nextW.splitPanes[0].tabs=(intoW?['a','x','b']:['a','b']).map(entry);
    nextS.splitPanes[0].tabs=intoW?[]:[entry('x')];nextS.splitPanes[0].tabId=intoW?'':'x';
    const field=state.spaces.find(space=>space.id==='W').stripColorGroups;
    const prepared=preparePaneStripGroupRelease({workflowId:'W',field,beforeLayout:beforeW,layout:nextW,
      rootTabIds:['x'],placementTabIds:['x'],targetOwner:intoW?{paneIndex:0,windowId:'win',centerKey:null}:null,isActive:()=>true});
    if(!intoW)assert.deepEqual(prepared.nextState.groups[0].tabIds,['a','b'],'ordinary OUT removes only moving root x');
    if(local){
      const nextSpaces=state.spaces.map(space=>({...space,layout:space.id==='W'?nextW:nextS}));
      const released=pairs.preparePaneStripLocalRelease(state,nextSpaces,{rootTabIds:['x'],targetWorkflowId,
        targetOwner:{paneIndex:0,windowId:intoW?'win':'source',centerKey:null}});
      f.store.setState({...released,...released.spaces[0].layout});
      const command=pairs.enqueuePaneStripLocalRelease({getState:()=>f.state,setState:f.store.setState,committer:f.committer,snapshot:organizationSnapshot(f.state)});
      command.catch(()=>{});commands.push(command);continue;
    }
    const previous=state.pendingTabWorkflowMembership.x||state.tabWorkflowMembership.x;
    const request={mutationId:intoW?'B5-return-IN':'B5-return-OUT',version:1,expectedRevision:state.organizationRevision,targetWorkflowId,destinationKind:'window',
      tabs:[{tabId:'x',workflowId:targetWorkflowId,expected:{workflowId:previous.workflowId,membershipRevision:previous.revision}}],
      workflows:[{workflowId:'W',expectedPlacement:dragPlacement(beforeW),beforeLayout:beforeW,layout:nextW,reserveOrder:[],reserveRootOrder:[]},
        {workflowId:'S',expectedPlacement:dragPlacement(beforeS),beforeLayout:beforeS,layout:nextS,reserveOrder:[],reserveRootOrder:[]}],stripGroupReleases:[prepared.intent]};
    f.store.setState(pairs.publishPaneStripDragRelease(state,request));
    const command=f.committer.command('commitDrag',request,{beforeSnapshot,isCurrent:()=>!!f.state.paneStripReleasedPairs.commands[request.mutationId],
      onStage:event=>f.store.setState(pairs.notePaneStripReleaseStage(f.state,event))});
    command.catch(()=>{});commands.push(command);
  }
  return commands;
}

test('B5 exact cross-workflow IN ACK must preserve already-current represented-group Ungroup intent',async()=>{
  const f=await fixture(),runtime=[],original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,runtime);
  const tabs=new Map(f.state.openProjects.get('P').tabs);
  const before={raw:clone(f.state.spaces[0].stripColorGroups),slots:clone(f.state.splitPanes[0].tabs),nav:f.state.navigationRevision,
    effective:clone(f.state.pendingTabWorkflowMembership.x||f.state.tabWorkflowMembership.x),canonical:clone(f.state.tabWorkflowMembership.x)};
  const ungroup=button(menu.render(),'group-ungroup');assert.ok(ungroup);assert.equal(ungroup.props.disabled,false);
  ungroup.props.onClick();assert.ok(f.pending);assert.equal(f.settingsLease.isCurrent(),true);
  assert.deepEqual(f.settingsLease.entries.map(entry=>entry.tabId),['a','x','b']);assert.deepEqual(original.lease.entries.map(entry=>entry.tabId),['a']);
  f.ack.resolve();await f.command;await tick();
  assert.equal(original.lease.isCurrent(),true,'actual controller lease survives its exact B5 ACK');
  assert.equal(f.settingsLease.isCurrent(),true,'actual menu settings lease survives its exact B5 ACK');
  assert.deepEqual(f.afterB5.raw,before.raw);assert.deepEqual(f.afterB5.slots,before.slots);
  assert.equal(f.afterB5.nav,before.nav);assert.equal(f.afterB5.canonical.workflowId,before.effective.workflowId);
  assert.equal(f.afterB5.canonical.revision,before.effective.revision);assert.equal(f.afterB5.pending,null);
  assert.equal(f.afterB5.envelope.commands[f.request.mutationId],undefined);
  assert.equal(f.afterB5.envelope.workflows.W,undefined);
  button(menu.render(),'close').props.onClick();await tick();button(menu.render(),'stop').props.onClick();await tick();
  assert.deepEqual(runtime,[['close',['a']],['stop',['a']]]);
  let rejected;try{await f.pending;}catch(error){rejected={code:error.code,message:error.message};}
  console.log('RECEIPT',JSON.stringify({before,after:f.afterB5,rejected,
    originalLeaseCurrent:original.lease.isCurrent(),settingsLeaseCurrent:f.settingsLease.isCurrent(),runtime,
    writes:f.writes.map(value=>({kind:value.kind,mutationId:value.request.mutationId,groupEdit:!!value.request.stripColorGroupEdits}))}));
  menu.h.dispose();original.h.dispose();
  assert.equal(rejected,undefined,'same B5 pair adoption must not turn current Ungroup into selection_changed');
  assert.deepEqual(f.mainSpaces[0].stripColorGroups.groups,[]);
  assert.deepEqual(f.state.splitPanes[0].tabs,before.slots);
  for(const[id,tab]of tabs){assert.equal(f.state.openProjects.get('P').tabs.get(id),tab);assert.equal(tab.cwd,'/fixture');assert.equal(tab.input,'kept');}
});

test('B5 whole-group settings remain usable before ACK without lending that proof to Full or Stop',async()=>{
  const f=await fixture(),runtime=[],original=actualOriginalLease(f.state,f.store,{whole:true}),menu=actualMenu(original.lease,f.store,runtime);
  const tree=menu.render();
  const before={current:original.lease.isCurrent(),groupCurrent:groupCurrent(original.lease),entries:original.lease.entries.map(entry=>entry.tabId),
    canonical:clone(f.state.tabWorkflowMembership.x),pending:clone(f.state.pendingTabWorkflowMembership.x),
    raw:clone(f.state.spaces[0].stripColorGroups),slots:clone(f.state.splitPanes[0].tabs),closed:menu.closed,
    fullDisabled:button(tree,'close').props.disabled,stopDisabled:button(tree,'stop').props.disabled,
    groupDisabled:button(tree,'group-ungroup').props.disabled};
  assert.deepEqual(before.entries,['a','x','b']);assert.equal(before.canonical.workflowId,'S');assert.equal(before.pending.workflowId,'W');
  button(tree,'close').props.onClick();await tick();button(menu.render(),'stop').props.onClick();await tick();
  assert.deepEqual(runtime,[],'pre-ACK settings proof must not enter the runtime port or cache a rejected operation');
  button(menu.render(),'group-ungroup').props.onClick();const started=!!f.pending;
  f.ack.resolve();await f.command;let rejected;try{if(f.pending)await f.pending;}catch(error){rejected=error.code||error.message;}
  await tick();const canonicalCurrent=original.lease.isCurrent(),after=menu.render();
  const afterDisabled=[button(after,'close').props.disabled,button(after,'stop').props.disabled];
  menu.h.dispose();original.h.dispose();
  console.log('WHOLE_SELECTION_RECEIPT',JSON.stringify(before));
  assert.equal(before.current,false,'original runtime lease keeps its canonical membership boundary');
  assert.equal(before.groupCurrent,true,'public pair grants only current group settings before ACK');
  assert.equal(before.closed,0);assert.equal(before.fullDisabled,true);assert.equal(before.stopDisabled,true);assert.equal(before.groupDisabled,false);
  assert.equal(started,true);assert.equal(rejected,undefined);assert.equal(canonicalCurrent,true);assert.deepEqual(afterDisabled,[false,false]);
  assert.deepEqual(f.mainSpaces[0].stripColorGroups.groups,[]);
});

test('B5 same-ID unknown ACK recovers once before preserving represented-group Ungroup',async()=>{
  const f=await fixture({loseAck:true}),original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,[]);
  button(menu.render(),'group-ungroup').props.onClick();assert.ok(f.pending);
  f.ack.resolve();await assert.rejects(f.command,/controlled_lost_B5_ack/);await f.pending;
  const attempts=f.writes.filter(write=>write.kind==='commitDrag');
  assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1],'recovery resends the same immutable command');
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits?.length).length,1);
  assert.equal(f.state.pendingTabWorkflowMembership.x,undefined);assert.equal(f.state.tabWorkflowMembership.x.revision,2);
  assert.deepEqual(f.mainSpaces[0].stripColorGroups.groups,[]);
  menu.h.dispose();original.h.dispose();
});

test('B5 queued ordinary local IN preserves Ungroup captured before command preparation',async()=>{
  const f=await fixture({localRelease:true}),original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,[]);
  assert.equal(f.state.pendingTabWorkflowMembership.x.localReleaseQueued,true);
  assert.equal(f.state.pendingTabWorkflowMembership.x.localReleaseMutationId,undefined);
  assert.deepEqual(Object.keys(f.state.paneStripReleasedPairs.commands),[]);
  button(menu.render(),'group-ungroup').props.onClick();assert.ok(f.pending);
  f.ack.resolve();await f.command;await f.pending;
  assert.equal(f.state.tabWorkflowMembership.x.workflowId,'W');assert.equal(f.state.tabWorkflowMembership.x.revision,2);
  assert.equal(f.state.pendingTabWorkflowMembership.x,undefined);
  assert.equal(f.writes.filter(write=>write.request.stripGroupReleases?.length).length,1);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits?.length).length,1);
  assert.deepEqual(f.mainSpaces[0].stripColorGroups.groups,[]);
  menu.h.dispose();original.h.dispose();
});

test('chained released IN/OUT/IN preserves exact final membership and current Ungroup before the first ACK',async()=>{
  const f=await fixture(),commands=releasedReturnTrip(f),whole=actualOriginalLease(f.state,f.store,{whole:true});
  const wholeCurrent=groupCurrent(whole.lease),runtimeCurrent=whole.lease.isCurrent(),original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,[]);
  const before={raw:clone(f.state.spaces[0].stripColorGroups),slots:clone(f.state.splitPanes[0].tabs),
    canonical:clone(f.state.tabWorkflowMembership.x),pending:clone(f.state.pendingTabWorkflowMembership.x)};
  assert.equal(before.canonical.revision,1);assert.equal(before.pending.revision,4);assert.equal(before.pending.workflowId,'W');
  button(menu.render(),'group-ungroup').props.onClick();assert.ok(f.pending);
  f.ack.resolve();await f.command;await Promise.all(commands);
  let rejected;try{await f.pending;}catch(error){rejected={code:error.code,message:error.message};}
  console.log('CHAIN_RECEIPT',JSON.stringify({before,after:f.afterB5,wholeCurrent,runtimeCurrent,rejected,
    commands:f.writes.filter(write=>write.kind==='commitDrag').map(write=>({mutationId:write.request.mutationId,tabs:write.request.tabs}))}));
  assert.deepEqual(f.afterB5.raw,before.raw);assert.deepEqual(f.afterB5.slots,before.slots);
  assert.equal(f.afterB5.canonical.revision,4);assert.equal(f.afterB5.pending,null);
  menu.h.dispose();original.h.dispose();whole.h.dispose();
  assert.equal(wholeCurrent,true,'each released command preserves the public current strip selection');
  assert.equal(runtimeCurrent,false,'queued membership cannot borrow canonical Full/Stop authority');
  assert.equal(rejected,undefined,'exact final ACK adoption is not a foreign membership change');
  assert.deepEqual(f.mainSpaces[0].stripColorGroups.groups,[]);
});

test('queued ordinary local IN/OUT/IN needs no invented command history to preserve current Ungroup',async()=>{
  const f=await fixture({localRelease:true}),commands=releasedReturnTrip(f,{local:true});
  assert.equal(f.state.tabWorkflowMembership.x.revision,1);assert.equal(f.state.pendingTabWorkflowMembership.x.revision,4);
  assert.equal(f.state.pendingTabWorkflowMembership.x.localReleaseQueued,true);assert.deepEqual(Object.keys(f.state.paneStripReleasedPairs.commands),[]);
  const whole=actualOriginalLease(f.state,f.store,{whole:true}),wholeCurrent=groupCurrent(whole.lease),runtimeCurrent=whole.lease.isCurrent();
  const original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,[]);
  button(menu.render(),'group-ungroup').props.onClick();assert.ok(f.pending);
  f.ack.resolve();await f.command;await Promise.all(commands);await f.pending;
  assert.equal(wholeCurrent,true);assert.equal(runtimeCurrent,false);assert.equal(f.state.tabWorkflowMembership.x.revision,4);
  assert.equal(f.state.pendingTabWorkflowMembership.x,undefined);
  assert.equal(f.writes.filter(write=>write.request.stripGroupReleases?.length).length,3);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits?.length).length,1);
  assert.deepEqual(f.mainSpaces[0].stripColorGroups.groups,[]);
  menu.h.dispose();original.h.dispose();whole.h.dispose();
});

const foreignCases=[
  ['foreign recolor',({state,mainSpaces})=>{
    const field=mainSpaces[0].stripColorGroups;field.revision++;field.groups[0].revision++;field.groups[0].color='#fedcba';
    state.spaces[0].stripColorGroups=clone(field);
  }],
  ['newer same-workflow membership revision',({state,mainMembers})=>{
    mainMembers.x={...mainMembers.x,revision:3};state.tabWorkflowMembership.x=clone(mainMembers.x);
  }],
  ['foreign workflow membership',({state,mainMembers})=>{
    mainMembers.x={...mainMembers.x,workflowId:'S',revision:3};state.tabWorkflowMembership.x=clone(mainMembers.x);
  }],
  ['newer owner order',({state,mainSpaces})=>{
    const slots=['b','x','a'].map(entry);state.splitPanes[0].tabs=clone(slots);mainSpaces[0].layout.splitPanes[0].tabs=slots;
  }],
  ['new navigation',({state})=>{state.navigationRevision++;}],
  ['closed member',({state,inactive})=>{
    inactive.add('x');state.tabCatalog.x={...state.tabCatalog.x,active:false};state.openProjects.get('P').tabs.delete('x');
  }],
];
for(const [name,afterAdoption]of foreignCases)test(`B5 adoption never rebases Ungroup across ${name}`,async()=>{
  const f=await fixture({afterAdoption}),original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,[]);
  button(menu.render(),'group-ungroup').props.onClick();assert.ok(f.pending);
  f.ack.resolve();await f.command;await assert.rejects(f.pending,error=>/changed/.test(error.code||error.message));
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits?.length),false,'stale settings intent sends no field edit');
  assert.equal(f.mainSpaces[0].stripColorGroups.groups.length,1,'stale intent neither deletes nor restores foreign metadata');
  menu.h.dispose();original.h.dispose();
});

test('captured canonical membership stays immutable across an in-place change during B5 await',async()=>{
  const f=await fixture(),original=actualOriginalLease(f.state,f.store),menu=actualMenu(original.lease,f.store,[]);
  button(menu.render(),'group-ungroup').props.onClick();
  f.state.tabWorkflowMembership.a.revision=2;f.mainMembers.a.revision=2;
  f.ack.resolve();await f.command;await assert.rejects(f.pending,{code:'strip_group_selection_changed'});
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits?.length),false);
  menu.h.dispose();original.h.dispose();
});

const invalidSelectionProofs=[
  ['malformed envelope',state=>{delete state.paneStripReleasedPairs.commands;}],
  ['bare pending membership',state=>{delete state.paneStripReleasedPairs;}],
  ['unrelated pending command',state=>{state.pendingTabWorkflowMembership.x.localReleaseMutationId='not-the-released-command';}],
  ['another released owner',state=>{state.paneStripReleasedPairs.workflows.W.layout.splitPanes[0].windowId='other-window';}],
  ['different released order',state=>{state.paneStripReleasedPairs.workflows.W.layout.splitPanes[0].tabs=['b','x','a'].map(entry);}],
  ['invalid released raw field',state=>{state.paneStripReleasedPairs.workflows.W.field={version:1,revision:-1,groups:[]};}],
  ['invalid intent nextState',state=>{state.paneStripReleasedPairs.workflows.W.intent.nextState={version:9};}],
];
for(const[name,alter]of invalidSelectionProofs)test(`whole selection rejects ${name}`,async()=>{
  const f=await fixture(),envelope=clone(f.state.paneStripReleasedPairs),pending=clone(f.state.pendingTabWorkflowMembership);
  alter(f.state);const original=actualOriginalLease(f.state,f.store,{whole:true}),current=groupCurrent(original.lease);
  f.store.setState({paneStripReleasedPairs:envelope,pendingTabWorkflowMembership:pending});
  f.ack.resolve();await f.command;original.h.dispose();assert.equal(current,false);
});
