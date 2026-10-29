// TEST ONLY. Real private SQLite + real Main/renderer owners. No application,
// BrowserWindow, provider, PTY or user storage is started by this fixture.
// IPC delivery, a finite hook/store container and runtime execution are the
// controlled ports. SQL, migration, validation, journal and reopen are real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Module,{createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID,webcrypto} from 'node:crypto';
import {buildSync,transformSync} from 'esbuild';
import {createOrganizationCommitter,organizationProjection,organizationSnapshot,reconcileWorkflowOrder} from '../renderer/utils/workflowOrganizationClient.mjs';
import {commitPaneStripGroupAdd} from '../renderer/utils/paneStripGroupAddCommit.mjs';
import {commitPaneStripGroupPresentation} from '../renderer/utils/paneStripGroupPresentationCommit.mjs';
import * as groups from '../renderer/utils/paneStripGroupsModel.mjs';
import * as selection from '../renderer/utils/paneStripSelectionModel.mjs';
import * as actions from '../renderer/utils/paneStripSelectionActions.mjs';
import * as pairs from '../renderer/utils/paneStripReleasePair.mjs';
import * as raw from '../shared/pane-strip-color-groups.cjs';
import {newerWorkflowGroups} from '../renderer/utils/workflowGroupClient.mjs';
import {emptySpaceLayout,captureSpaceLayout} from '../renderer/utils/workspaceSpacesModel.mjs';

const require=createRequire(import.meta.url);
// Deliberately fail if the native dependency/ABI is unavailable. No SQL mock,
// alternative driver, installation or silent skip can turn this suite green.
const Database=require('better-sqlite3'),DatabaseManager=require('./database');
const {WorkflowOrganization}=require('./workflow-organization');
const {createWorkflowOrganizationApi}=require('./workflow-organization-api');
const dirname=path.dirname(fileURLToPath(import.meta.url)),sourceRoot=path.resolve(dirname,'../..');
globalThis.crypto??=webcrypto;
export const clone=structuredClone;
export const turn=()=>new Promise(resolve=>setImmediate(resolve));
export const code=error=>String(error?.code||error?.message||error);
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  promise.catch(()=>{});return {promise,resolve,reject};};
const read=relative=>fs.readFileSync(path.join(sourceRoot,relative),'utf8');
export const ids=slots=>slots.map(slot=>slot.tabId||`chooser:${slot.slotId}`);
export const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
export const button=(tree,name)=>all(tree).find(node=>node.props?.['data-tab-context-action']===name);

// Use the actual renderer compiler, including its typed family/root guards.
// This is the same esbuild entry/alias approach as workflow-drag.native.test.js.
const filename=path.join(sourceRoot,'src/renderer/utils/workflowDragModel.mjs');
const compiled=new Module(filename);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
const bundle=buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',
  alias:{'@noted/structured-dnd':path.join(sourceRoot,'vendor/noted-shared/packages/structured-dnd/src')}});
compiled._compile(bundle.outputFiles[0].text,filename);
const {captureWorkflowDrag,workflowDragRequest}=compiled.exports;

function hooks(){
  const slots=[],effects=[];let cursor=0,changed=false;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
    createContext:()=>({}),useContext:()=>null,
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
      return [slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useMemo:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((value,k)=>value!==old.deps[k]))slots[i]={value:fn(),deps};return slots[i].value;},
    useCallback:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((value,k)=>value!==old.deps[k]))slots[i]={value:fn,deps};return slots[i].value;},
    useEffect:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((value,k)=>value!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=cb();});}}};
  return {React,render:fn=>{let result,n=0;do{assert.ok(n++<12,'finite hook render');cursor=0;changed=false;result=fn();
    while(effects.length)effects.shift()();}while(changed);return result;},dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
function moduleFrom(source,ports){const module={exports:{}};
  vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,
    console,crypto,Map,Set,window:{addEventListener(){},removeEventListener(){}},document:{body:{}},...ports});return module.exports;
}

/** Execute the actual controller. Only hooks, subscription/event delivery and
 * the retained-window Store container are finite ports; its lease logic is not. */
function selectionLease(f,wanted,sourceId=wanted[0]){
  const h=hooks(),exports=moduleFrom(read('src/renderer/components/Workspace/PaneStripSelection.tsx'),{require:name=>{
    if(name==='react')return h.React;
    if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:f.store};
    if(name.endsWith('paneStripSelectionModel.mjs'))return selection;
    if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
    if(name.endsWith('paneStripOutsideSelection.mjs'))return {registerPaneStripOutsideSelection:()=>()=>{}};
    if(name.endsWith('paneTabDragBridge'))return {getPaneTabDragSnapshot:()=>({active:false}),subscribePaneTabDrag:()=>()=>{}};
    if(name.endsWith('paneTabPointerBridge'))return {getPaneTabPointerSnapshot:()=>({active:false}),subscribePaneTabPointer:()=>()=>{}};
    throw Error('unhandled_selection_import:'+name);
  }});
  const render=()=>h.render(()=>exports.usePaneStripSelectionController({workflowId:'W',windowId:'win',paneIndex:0,
    entries:f.state.splitPanes[0].tabs,presented:true}));
  wanted.forEach((id,index)=>render().click(id,index?{metaKey:true}:{}));
  const lease=render().menu(sourceId);assert.ok(lease,'actual selected menu lease');f.disposables.push(h.dispose);
  return {lease,render,dispose:h.dispose};
}

/** Run actual selection-menu actions, keeping the runtime port visibly
 * controlled. These assertions prove target/admission boundaries, not 3314
 * execution, BrowserWindow hit-testing or provider behavior. */
function menu(f,lease){
  const h=hooks(),runtime=[],toasts=[];let closed=0;
  const unused=name=>()=>{throw Error('unexpected_menu_effect:'+name);};
  const exports=moduleFrom(read('src/renderer/components/Workspace/PaneStripSelectionMenu.tsx'),{require:name=>{
    if(name==='react')return h.React;
    if(name==='react-dom')return {createPortal:node=>node};
    if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
    if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:f.store};
    if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({showToast:(...args)=>toasts.push(args)})}};
    if(name.endsWith('paneStripSelectionModel.mjs'))return selection;
    if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
    if(name.endsWith('paneStripSelectionActions.mjs'))return actions;
    if(name.endsWith('codexWriterIdentity'))return {requireCodexSurfaceSessionId:unused(name)};
    if(name.endsWith('generateTabTitle'))return {refreshGeneratedTabTitle:unused(name)};
    if(name.endsWith('ptyAgentOwner.mjs'))return {resolvePtyAgentOwner:()=>null};
    if(name.endsWith('contextMenuMetrics.mjs'))return {CONTEXT_MENU_COMPACT_ROW_STYLE:{},CONTEXT_MENU_ROW_STYLE:{},CONTEXT_MENU_TOP_DIVIDER_STYLE:{},CONTEXT_MENU_PANEL_STYLE:{}};
    if(name.endsWith('TabIdActions'))return {TabIdActions:()=>null};
    if(['SideFlyout','TabNotificationControls','PaneStripGroupColorPicker'].some(file=>name.endsWith(file)))return {__esModule:true,default:()=>null};
    throw Error('unhandled_menu_import:'+name);
  }});
  const render=()=>h.render(()=>exports.default({lease,onClose(){closed++;},runtimePort:{run:async(action,target)=>{
    assert.equal(target,lease,'runtime receives original canonical lease');assert.equal(target.isCurrent(),true,'runtime admission stays canonical');
    runtime.push({action,entries:clone(target.entries)});
  }}}));
  f.disposables.push(h.dispose);return {render,runtime,toasts,dispose:h.dispose,get closed(){return closed;}};
}

export function nativeAddFixture(t,{partial=false,savedProfile=false}={}){
  const privateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'noted-strip-add-private-')),file=path.join(privateRoot,'private.db');
  let db,observer,manager,api;const gates=[],flights=[],disposables=[],attempts=[],publications=[],errors=[];
  t.after(async()=>{
    for(const gate of gates)gate.ack.resolve();await Promise.allSettled(flights);for(const dispose of disposables)dispose();
    if(api?.service.snapshotPrune)await api.service.snapshotPrune.terminate();if(observer?.open)observer.close();if(db?.open)db.close();
    fs.rmSync(privateRoot,{recursive:true,force:true});assert.equal(fs.existsSync(privateRoot),false,'only owned private DB removed');
  });
  const open=()=>{db=new Database(file);db.pragma('foreign_keys=ON');manager=new DatabaseManager({existingConnection:db});
    api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
    assert.ok(api.service instanceof WorkflowOrganization);observer=new Database(file,{readonly:true,fileMustExist:true});};
  // initTables must run before the canonical API reads the owned connection.
  db=new Database(file);db.pragma('foreign_keys=ON');manager=new DatabaseManager({existingConnection:db});manager.initTables();
  for(const projectId of ['P','Q'])db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run(projectId,path.join(privateRoot,projectId),projectId);
  const namespaces={a:'P',b:'Q',c:'P',x:'Q',t:'P',z:'P',u:'Q',closed:'P'};
  for(const [id,projectId] of Object.entries(namespaces).filter(([id])=>!['c','closed'].includes(id)))db.prepare(`INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type,codex_session_id)
    VALUES(?,?,?,?,?,?,?)`).run(projectId,id,id,path.join(privateRoot,projectId),'terminal','codex','private-session-'+id);
  const entry=id=>({projectId:namespaces[id],tabId:id,extension:{preserve:id},width:60+id.charCodeAt(0)});
  const chooser=(id)=>({slotId:id,cwd:privateRoot,extension:{chooser:id}});
  const layout={...emptySpaceLayout(),activeProjectId:'P',focusedProjectId:'P',activeSpaceTab:{projectId:'P',tabId:'a'},
    splitPanes:[{windowId:'win',projectId:'P',tabId:'a',extension:{owner:true},tabs:partial
      ?[chooser('left'),entry('a'),entry('closed'),entry('b'),entry('t'),chooser('middle'),entry('c'),entry('z'),entry('x')]
      :[chooser('left'),entry('a'),entry('t'),chooser('middle'),entry('b'),entry('c'),entry('z'),entry('x')]}]};
  if(savedProfile)layout.windowDisplayLayouts={saved:{splitPanes:[{windowId:'saved-win',projectId:'P',tabId:'a',tabs:[entry('a'),entry('x'),entry('b')]}],extension:{saved:true}}};
  const source={...emptySpaceLayout(),activeProjectId:'Q',focusedProjectId:'Q',activeSpaceTab:{projectId:'Q',tabId:'u'},
    splitPanes:[{windowId:'source',projectId:'Q',tabId:'u',tabs:[entry('u')]}]};
  api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
  const migrationLayout=clone(layout);migrationLayout.splitPanes[0].tabs=migrationLayout.splitPanes[0].tabs.filter(slot=>!['c','closed'].includes(slot.tabId));
  api.bootstrap({migrationId:'private-add',mutationId:'private-add:publish',workspace:{...migrationLayout,activeSpaceId:'W',
    spaces:[{id:'W',projectIds:['P','Q'],extension:{workflow:'keep'},layout:migrationLayout},{id:'S',projectIds:[],layout:source}]}});
  // Mix real native V2 and legacy execution subjects. These finite subjects
  // use the actual create owner; no provider process or launch is requested.
  for(const tabId of ['c','closed'])api.createTab({mutationId:'private-create:'+tabId,expectedRevision:api.service.getPublication().revision,
    tabId,workflowId:'W',executionNamespace:'P',cwd:path.join(privateRoot,'P'),record:{name:tabId,tabType:'terminal',commandType:'codex',
      codexSessionId:'private-session-'+tabId,input:'private input '+tabId,extension:{native:'keep'}}});
  const snapshot=()=>({mutationId:randomUUID(),expectedRevision:api.service.getPublication().revision,
    spaces:api.service.listWorkflows().map(workflow=>({...workflow.metadata,id:workflow.id,kind:workflow.kind,layout:workflow.layout})),
    tabWorkflowMembership:Object.fromEntries(api.service.listGlobalTabs().map(tab=>[tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]))});
  const mutate=(kind,request)=>api.mutate(kind,{mutationId:randomUUID(),expectedRevision:api.service.getPublication().revision,...request});
  // Migration chooses one owner per namespace. Establish this finite ordinary
  // cross-workflow source through Main, then save its complete source window.
  if(api.service.getMembership('u').workflowId!=='S')mutate('moveTab',{tabId:'u',workflowId:'S',expectedMembershipRevision:api.service.getMembership('u').revision});
  for(const id of Object.keys(namespaces).filter(id=>id!=='u'))if(api.service.getMembership(id).workflowId!=='W')
    mutate('moveTab',{tabId:id,workflowId:'W',expectedMembershipRevision:api.service.getMembership(id).revision});
  mutate('saveLayout',{workflowId:'S',expectedWorkflowRevision:api.service.getWorkflow('S').revision,layout:source});
  // Place all W roots before creating the raw field, preserving mixed slots.
  mutate('saveLayout',{workflowId:'W',expectedWorkflowRevision:api.service.getWorkflow('W').revision,layout});
  const initial=snapshot();initial.spaces.find(space=>space.id==='W').stripColorGroups={version:1,revision:1,extension:{field:'keep'},groups:[
    {id:'g',revision:1,color:'#abcdef',collapsed:true,tabIds:partial?['a','closed','b']:['a'],extension:{group:'keep'}},
    {id:'peer',revision:1,color:'#123456',collapsed:false,tabIds:['z'],extension:{peer:'keep'}}]};
  initial.stripColorGroupEdits=[{workflowId:'W',basis:raw.paneStripColorGroupsBasis(undefined)}];api.mutate('commitWorkspace',initial);
  if(partial){
    // Real private native archive owner retains a positively archived row.
    // Removing its placement must not rewrite old raw definition provenance.
    const closed=manager.getExecutionTabV2({executionNamespace:'P',tabId:'closed'});
    manager.archiveExecutionTabV2({mutationId:'private-archive:closed',executionNamespace:'P',tabId:'closed',
      subjectId:closed.executionSubject.subjectId,expectedRevision:closed.revision,workflowContext:{workflowId:'W'}});
    const next=clone(api.service.getWorkflow('W').layout);next.splitPanes[0].tabs=next.splitPanes[0].tabs.filter(slot=>slot.tabId!=='closed');
    mutate('saveLayout',{workflowId:'W',expectedWorkflowRevision:api.service.getWorkflow('W').revision,layout:next});
  }
  for(const key of ['paneStripSelectedFirst','paneStripCloseOnClick','paneStripInstantHover'])manager.setAppState(key,true);
  observer=new Database(file,{readonly:true,fileMustExist:true});
  const openProjects=new Map(api.listNamespaces().map(data=>[data.id,{...data,activeTabId:'a',
    tabs:new Map(data.tabs.map(tab=>[tab.tabId,{...tab,id:tab.tabId,input:'private input '+tab.tabId}]))}]));
  const state={...organizationProjection(api.read(),{activeSpaceId:'W'}),view:'workspace',navigationRevision:8,isRestoring:false,
    pendingTabWorkflowMembership:{},openProjects,saveSession(){},refreshOrganizationCatalog:async()=>{}};
  const listeners=new Set(),store=selector=>selector(state);store.getState=()=>state;
  store.setState=update=>{const patch=typeof update==='function'?update(state):update;if(patch)Object.assign(state,patch);for(const listener of listeners)listener(state);};
  store.subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
  const pair=(connection=db)=>{const row=connection.prepare('SELECT metadata_json,layout_json FROM workflow_org_workflows WHERE workflow_id=?').get('W');
    return {field:JSON.parse(row.metadata_json).stripColorGroups,layout:JSON.parse(row.layout_json)};};
  const record=()=>({raw:clone(groups.readPaneStripGroupState(state,'W')),slots:clone(state.splitPanes[0].tabs),
    canonical:clone(state.tabWorkflowMembership),pending:clone(state.pendingTabWorkflowMembership),
    envelope:clone(state.paneStripReleasedPairs??null),navigationRevision:state.navigationRevision});
  // Full actual Store callback, with the same imported actual projection and
  // pair/gather adoption functions. No substitute canonical publication code.
  const full=read('src/renderer/store/useWorkspaceStore.ts'),marker='  applyPublication:async (result:any,request:any,diagnostic?';
  const start=full.indexOf(marker),end=full.indexOf('\n  onError:',start);
  assert.ok(start>=0&&end>start&&full.indexOf(marker,start+marker.length)===-1,'one actual Store publication callback');
  const callback=full.slice(start,end).trim().replace(/^applyPublication:/,'').replace(/,$/,'');
  const actualApply=moduleFrom('module.exports=('+callback+');',{useWorkspaceStore:store,
    ipcRenderer:{invoke:async channel=>{assert.equal(channel,'workflow:read');return api.read();}},
    organizationProjection,reconcileWorkflowOrder,newerWorkflowGroups,applyPaneStripGatherPublication:groups.applyPaneStripGatherPublication,
    adoptPaneStripColorGroups:raw.adoptPaneStripColorGroups,applyPaneStripReleasePublication:pairs.applyPaneStripReleasePublication,
    uiDiagnosticAbsNow:()=>0,uiDragActionId:id=>id,uiDragDiagnostic:()=>{}});
  let nextGate=null,nextLoss=null,nextCapture=null,afterPublication=null,atomic=null;
  const hiddenReceipts=new Set();
  const applyPublication=async(result,request,diagnostic)=>{const answer=await actualApply(result,request,diagnostic);
    publications.push({request:clone(request),state:record()});await afterPublication?.({result,request,state,store,api});return answer;};
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),applyPublication,
    onError:error=>errors.push({code:code(error)}),invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation'){
        if(hiddenReceipts.delete(payload))return null;return api.getMutation(payload);
      }
      assert.equal(channel,'workflow:mutate');const {kind,request}=payload;attempts.push({kind,request:clone(request)});
      const matches=selector=>selector?.(kind,request);
      if(matches(nextCapture?.matches)){
        const capture=nextCapture;nextCapture=null;capture.entered.resolve(clone(request));
        throw Object.assign(Error('fixture_request_captured_before_sql'),{disposition:'not-applied'});
      }
      const gate=matches(nextGate?.matches)?nextGate:null;if(gate)nextGate=null;
      const loss=matches(nextLoss?.matches)?nextLoss:null;if(loss)nextLoss=null;
      const probe=matches(atomic?.matches)?atomic:null;
      const priorFault=api.service.fault;
      if(probe)api.service.fault=(point,detail)=>{priorFault(point,detail);if(point==='beforePublicationMarker'){
        probe.during={writer:pair(db),reader:pair(observer)};
        if(probe.reject)throw Object.assign(Error('fixture_atomic_abort'),{disposition:'not-applied'});
      }};
      let result;
      try{result=api.mutate(kind,request);}catch(error){gate?.entered.reject(error);throw error;}
      finally{if(probe){api.service.fault=priorFault;atomic=null;probe.after=pair(observer);}}
      if(gate){gate.request=clone(request);gate.result=clone(result);gate.entered.resolve({request:gate.request,result:gate.result});await gate.ack.promise;}
      if(loss){hiddenReceipts.add(request.mutationId);throw Error('fixture_lost_ack');}
      return result;
    }});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const fieldFlights=[];
  state.commitPaneStripGroupAdd=(lease,groupId)=>{const promise=commitPaneStripGroupAdd({getState:()=>state,committer,lease,groupId});
    promise.catch(()=>{});fieldFlights.push({kind:'add',lease,promise});flights.push(promise);return promise;};
  state.commitPaneStripGroupPresentation=(lease,groupId,options)=>{const promise=commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId,...options});
    promise.catch(()=>{});fieldFlights.push({kind:'presentation',lease,promise});flights.push(promise);return promise;};
  state.refreshOrganizationCatalog=()=>actualApply({success:true},{});
  const f={state,store,committer,attempts,publications,errors,disposables,fieldFlights,snapshot,mutate,pair,record,
    get db(){return db;},get api(){return api;},get manager(){return manager;},
    raw:()=>pair().field,slots:()=>pair().layout.splitPanes[0].tabs,
    rows:()=>db.prepare('SELECT * FROM tabs ORDER BY id').all(),
    membership:()=>api.service.listGlobalTabs().map(tab=>tab.membership),
    receipt:id=>db.prepare('SELECT * FROM workflow_org_mutations WHERE mutation_id=?').get(id),
    fieldAttempts:()=>attempts.filter(value=>value.request.stripColorGroupEdits?.length),
    selection:(wanted,sourceId)=>selectionLease(f,wanted,sourceId),menu:lease=>menu(f,lease),
    add:lease=>state.commitPaneStripGroupAdd(lease,'g'),ungroup:lease=>state.commitPaneStripGroupPresentation(lease,'g',{ungroup:true}),
    runtime:()=>{
      const {WorkflowSelectionRuntime}=require('./workflow-selection-runtime'),calls=[];
      const owner=new WorkflowSelectionRuntime({database:manager,organization:api.service,groupActions:api.groupActions,
        captureOwner:tabId=>({mainInstanceId:'private-fixture-main',terminalId:'private-terminal-'+tabId}),
        observe:async()=>({known:true}),
        stop:async(member,_observation,isCurrent)=>{
          assert.equal(isCurrent(member.runtimeOwner),true);calls.push({tabId:member.tabId,namespace:member.namespace});
          return {version:1,completed:true,before:member.runtimeOwner,afterOwner:member.runtimeOwner};
        },recoverRuntime:async()=>{throw Error('physical_close_runtime_not_allowed_in_fixture');}});
      return {owner,calls};
    },
    afterPublication:fn=>{afterPublication=fn;},
    atomicProbe:({reject=false}={})=>{assert.equal(atomic,null);const probe={matches:(_kind,request)=>!!request.stripColorGroupEdits?.some(edit=>edit.add),reject};atomic=probe;return probe;},
    hold:(matches=(_kind,request)=>!!request.stripColorGroupEdits?.length)=>{assert.equal(nextGate,null);const gate={matches,entered:deferred(),ack:deferred()};gates.push(gate);nextGate=gate;return gate;},
    lose:(matches=(_kind,request)=>!!request.stripColorGroupEdits?.length)=>{assert.equal(nextLoss,null);nextLoss={matches};},
    capture:()=>{assert.equal(nextCapture,null);const capture={matches:(_kind,request)=>!!request.stripColorGroupEdits?.some(edit=>edit.add),entered:deferred()};nextCapture=capture;return capture;},
    syncPublished:async()=>actualApply({success:true},{}),
    release:({workflowId='W',at,hold=false,lose=false}={})=>{
      const current=state.pendingTabWorkflowMembership.u||state.tabWorkflowMembership.u;
      const admission=captureWorkflowDrag(state,{gestureId:randomUUID(),origin:'pane',sourceId:'reserve-tab:u',entries:[{projectId:'Q',tabId:'u'}],
        sourceWorkflowId:current.workflowId,sourcePaneKey:current.workflowId==='W'?'win':'source'});
      assert.ok(admission,'actual typed renderer capture');
      const destination=workflowId==='W'?captureSpaceLayout(state):state.spaces.find(space=>space.id===workflowId).layout;
      const request=workflowDragRequest(admission,{workflowId,previewOutline:[],target:{paneIndex:0,
        paneKey:workflowId==='W'?'win':'source',at:at??destination.splitPanes[0].tabs.length}});
      assert.ok(request,'actual complete renderer drag DTO');assert.ok(request.stripGroupReleases?.length,'actual B5 release present');
      const gate=hold?f.hold((kind,value)=>kind==='commitDrag'&&value.mutationId===request.mutationId):null;
      if(lose)f.lose((kind,value)=>kind==='commitDrag'&&value.mutationId===request.mutationId);
      const beforeSnapshot=organizationSnapshot(state);store.setState(pairs.publishPaneStripDragRelease(state,request));
      const command=committer.command('commitDrag',request,{beforeSnapshot,
        isCurrent:()=>!!state.paneStripReleasedPairs?.commands?.[request.mutationId],
        onStage:event=>store.setState(pairs.notePaneStripReleaseStage(state,event))});
      command.catch(error=>gate?.entered.reject(error));flights.push(command);return {request,command,gate};
    },
    reopen:async()=>{if(api.service.snapshotPrune)await api.service.snapshotPrune.terminate();observer.close();db.close();open();},
  };
  return f;
}
