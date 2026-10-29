import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {transformSync} from 'esbuild';

// Actual controller, runtime port and Main begin/capture/receipt. React, IPC,
// execution rows and the journal's SQL interface are controlled in memory;
// no SQLite database or runtime process is opened by these source controls.
const root=process.env.AUDIT_SOURCE_ROOT||fileURLToPath(new URL('../../../../',import.meta.url));
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
const [selection,groups,pairs,spaces,admission,drag,organization,{createPaneSelectionRuntimePort}]=await Promise.all([
  load('src/renderer/utils/paneStripSelectionModel.mjs'),load('src/renderer/utils/paneStripGroupsModel.mjs'),
  load('src/renderer/utils/paneStripReleasePair.mjs'),load('src/renderer/utils/workspaceSpacesModel.mjs'),
  load('src/shared/pane-strip-group-admission.cjs'),load('src/shared/workflow-drag.cjs'),
  load('src/shared/workflow-organization.cjs'),load('src/renderer/utils/paneSelectionRuntime.mjs'),
]);
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
// Actual observer dependency; this begin/receipt fixture still performs no Stop.
const stopSource=await load('src/main/workflow-selection-stop-source.js');
const fingerprintExpression=read('src/main/workflow-organization.js').match(/const fingerprint = ([^\n]+);/)[1];
const fingerprint=vm.runInNewContext(fingerprintExpression,{crypto,stableJson:organization.stableJson});
const mainModule={exports:{}};
vm.runInNewContext(read('src/main/workflow-selection-runtime.js'),{module:mainModule,exports:mainModule.exports,
  require:name=>{if(name==='node:crypto')return crypto;if(name==='./workflow-organization')return {fingerprint};
    if(name==='./workflow-selection-stop-source')return stopSource;throw Error(name);}});
const {WorkflowSelectionRuntime}=mainModule.exports;
const clone=value=>JSON.parse(JSON.stringify(value));
const entry=tabId=>({projectId:'P',tabId});

function fixture(){
  const layout={...spaces.emptySpaceLayout(),activeProjectId:'P',activeSpaceTab:entry('a'),
    splitPanes:[{windowId:'win',projectId:'P',tabId:'a',tabs:['a','b'].map(entry)}]};
  const sourceLayout={...spaces.emptySpaceLayout(),activeProjectId:'P',activeSpaceTab:entry('x'),
    splitPanes:[{windowId:'source',projectId:'P',tabId:'x',tabs:[entry('x')]}]};
  const field={version:1,revision:1,groups:[{id:'g',revision:1,color:'#abcdef',collapsed:true,tabIds:['a','b']}]};
  const canonical={a:{tabId:'a',workflowId:'W',revision:1},b:{tabId:'b',workflowId:'W',revision:1},x:{tabId:'x',workflowId:'S',revision:1}};
  const state={...clone(layout),activeSpaceId:'W',organizationReady:true,isRestoring:false,navigationRevision:8,
    spaces:[{id:'W',layout:clone(layout),stripColorGroups:clone(field)},{id:'S',layout:clone(sourceLayout)}],
    tabWorkflowMembership:clone(canonical),pendingTabWorkflowMembership:{},
    tabCatalog:Object.fromEntries(['a','b','x'].map(id=>[id,{active:true}])),
    openProjects:new Map([['P',{activeTabId:'a',tabs:new Map(['a','b','x'].map(id=>[id,{id,tabType:'terminal'}]))}]]),
    closeTab(){throw Error('source control must not execute runtime close');}};
  const nextLayout=clone(layout);nextLayout.splitPanes[0].tabs=['a','x','b'].map(entry);
  const nextSource=clone(sourceLayout);nextSource.splitPanes[0]={windowId:'source',projectId:'P',tabId:'',tabs:[]};
  const prepared=admission.preparePaneStripGroupRelease({workflowId:'W',field,beforeLayout:layout,layout:nextLayout,
    rootTabIds:['x'],placementTabIds:['x'],targetOwner:{paneIndex:0,windowId:'win',centerKey:null},isActive:()=>true});
  const request={mutationId:'B5-runtime-IN',version:1,expectedRevision:1,targetWorkflowId:'W',destinationKind:'window',
    tabs:[{tabId:'x',workflowId:'W',expected:{workflowId:'S',membershipRevision:1}}],
    workflows:[{workflowId:'W',expectedPlacement:drag.dragPlacement(layout),beforeLayout:layout,layout:nextLayout,reserveOrder:[],reserveRootOrder:[]},
      {workflowId:'S',expectedPlacement:drag.dragPlacement(sourceLayout),beforeLayout:sourceLayout,layout:nextSource,reserveOrder:[],reserveRootOrder:[]}],
    stripGroupReleases:[prepared.intent]};
  Object.assign(state,pairs.publishPaneStripDragRelease(state,request));

  const slots=[],effects=[];let cursor=0,changed=false,controller;
  const hooks={createContext:()=>({}),useContext:()=>null,
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],next=>{
      const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useMemo:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:fn(),deps};return slots[i].value;},
    useEffect:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const controllerSource=process.env.PANE_SELECTION_SOURCE?fs.readFileSync(process.env.PANE_SELECTION_SOURCE,'utf8')
    :read('src/renderer/components/Workspace/PaneStripSelection.tsx');
  const controllerModule={exports:{}};
  vm.runInNewContext(transformSync(controllerSource,{loader:'tsx',format:'cjs'}).code,{module:controllerModule,exports:controllerModule.exports,
    window:{addEventListener(){},removeEventListener(){}},require:name=>{
      if(name==='react')return hooks;if(name.endsWith('paneStripSelectionModel.mjs'))return selection;
      if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
      if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:{getState:()=>state}};
      if(name.endsWith('paneStripOutsideSelection.mjs'))return {registerPaneStripOutsideSelection:()=>()=>{}};
      if(name.endsWith('paneTabDragBridge'))return {getPaneTabDragSnapshot:()=>({active:false}),subscribePaneTabDrag:()=>()=>{}};
      if(name.endsWith('paneTabPointerBridge'))return {getPaneTabPointerSnapshot:()=>({active:false}),subscribePaneTabPointer:()=>()=>{}};
      throw Error(name);}});
  const render=()=>{let count=0;do{assert.ok(count++<10);cursor=0;changed=false;
    controller=controllerModule.exports.usePaneStripSelectionController({workflowId:'W',windowId:'win',paneIndex:0,
      entries:state.splitPanes[0].tabs,presented:true});while(effects.length)effects.shift()();}while(changed);return controller;};
  render().click('a',{});render().click('b',{shiftKey:true});const lease=render().menu('a');
  assert.deepEqual(clone(lease.entries),['a','x','b'].map(entry));

  const journal=new Map(),calls=[];
  const db={transaction:fn=>({immediate:fn}),prepare(sql){return {
    get(id){
      if(sql.startsWith('SELECT version FROM workflow_group_action_meta'))return {version:1};
      if(sql.startsWith('SELECT request_hash FROM workflow_group_actions')||sql.startsWith('SELECT * FROM workflow_group_actions'))return journal.get(id);
      if(sql.startsWith('SELECT COALESCE(MAX(id),0) id FROM tab_history'))return {id:0};throw Error(sql);
    },
    all(id){if(sql==='SELECT * FROM tabs WHERE tab_id=? AND execution_archived=0')return [{id,tab_id:id,execution_archived:0}];throw Error(sql);},
    run(id,hash,json){if(sql==='INSERT INTO workflow_group_actions VALUES(?,?,?,NULL)'){journal.set(id,{mutation_id:id,request_hash:hash,command_json:json});return;}throw Error(sql);},
  };}};
  const main=new WorkflowSelectionRuntime({database:{db},organization:{
    workflowRequired:id=>assert.equal(id,'W'),getPublication:()=>({version:1,migrationVersion:1,generation:1}),
    getTab:id=>({executionResolved:true,nativeRow:{id},membership:canonical[id],executionSubject:{projectId:'P'}}),
  },groupActions:{signature:()=>({scope:{executionNamespace:'P'},tabType:'terminal'})},captureOwner:()=>({mainInstanceId:'controlled-main'})});
  const port=createPaneSelectionRuntimePort({getState:()=>state,makeId:()=>`runtime-${calls.length}`,invoke:async(channel,payload)=>{
    calls.push({channel,payload:clone(payload)});
    if(channel==='workflow:selection-begin')return main.begin(payload);
    if(channel==='workflow:selection-step'){
      // A controlled completed effect. The actual begin guard above is the seam
      // under test; no Stop/Full implementation or provider process is run.
      const row=journal.get(payload.mutationId),command=JSON.parse(row.command_json);
      command.steps[payload.tabId]={state:'completed'};row.command_json=JSON.stringify(command);
      return {success:true,completed:true,mutationId:payload.mutationId,tabId:payload.tabId};
    }
    if(channel==='workflow:selection-ack')return main.ack(payload);
    if(channel==='workflow:selection-receipt')return main.receipt(payload.mutationId);
    throw Error(channel);
  }});
  const ack=()=>{
    canonical.x={tabId:'x',workflowId:'W',revision:2};state.tabWorkflowMembership.x=clone(canonical.x);
    delete state.pendingTabWorkflowMembership.x;state.paneStripReleasedPairs={version:1,workflows:{},commands:{}};
  };
  return {lease,state,port,calls,journal,ack,dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}

test('runtime lease stays canonical while the exact pending B5 group presentation is current',()=>{
  const f=fixture();
  assert.equal(f.lease.isCurrent(),false,'pending presentation must not open canonical Full/Stop admission');
  assert.equal(f.lease.isGroupCurrent?.(),true,'group settings retain the released presentation');
  f.dispose();
});

test('actual runtime port retains the original rejected Main begin promise if a group-only lease is misused',async()=>{
  const f=fixture(),misused={...f.lease,isCurrent:()=>f.lease.isGroupCurrent?.()??f.lease.isCurrent()};
  const first=f.port.run('close',misused);
  await assert.rejects(first,error=>error.code==='selection_action_capture_changed');
  assert.equal(f.journal.size,0,'Main rejects before writing any action journal row');
  f.ack();assert.equal(f.lease.isCurrent(),true);
  const retry=f.port.run('stop',misused);assert.equal(retry,first,'unchanged WeakMap owns the rejected lease promise');
  await assert.rejects(retry,error=>error.code==='selection_action_capture_changed');
  assert.equal(f.calls.length,1,'no second begin and no runtime step');f.dispose();
});

for(const action of ['close','stop'])test(`same original lease first-admits ${action} after B5 ACK without an earlier poisoned flight`,async()=>{
  const f=fixture();
  // The menu's non-group action gate is still this original canonical lease.
  // Deliberately retain the same object across ACK to distinguish WeakMap poison.
  if(f.lease.isCurrent())await f.port.run(action,f.lease).catch(()=>{});
  const beforeAck=f.calls.length;f.ack();await f.port.run(action,f.lease);
  assert.equal(beforeAck,0,'no pre-ACK runtime invocation');
  assert.equal(f.calls.filter(call=>call.channel==='workflow:selection-begin').length,1);
  assert.equal(f.journal.size,1);f.dispose();
});
