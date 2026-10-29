import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import * as panes from '../utils/splitPanesModel.mjs';
import * as organization from '../utils/workflowOrganizationClient.mjs';
import {restorePaneStripReleasedPairs,applyPaneStripReleasePublication} from '../utils/paneStripReleasePair.mjs';
import {adoptPaneStripColorGroups} from '../../shared/pane-strip-color-groups.cjs';
import {newerWorkflowGroups} from '../utils/workflowGroupClient.mjs';
import {reconcileWorkspaceDisplayPatch} from '../utils/windowDisplayLayouts.mjs';
import {emptySpaceLayout} from '../utils/workspaceSpacesModel.mjs';
import {dropTabsFromOtherSpaces} from '../utils/workspaceSpacesModel.mjs';
import {tabsAfterClose} from '../utils/tabRestorePlacement.mjs';
import {isDurableSaveTabsAck} from '../utils/tabPersistenceTransactions.mjs';
import {beginTabCloseFeedback} from '../utils/tabCloseFeedback.mjs';
import {createProjectTabSaveQueue} from '../utils/projectTabSaveQueue.mjs';
import {dropFromMru} from '../utils/tabSwitcherModel.mjs';
import {applyPaneStripGatherPublication} from '../utils/paneStripGroupsModel.mjs';
import {organizationPlacementIntent} from '../utils/workflowPlacementMembership.mjs';

// Execute the actual restore/refresh entries and the actual store setter. IPC
// supplies finite saved-publication fixtures; no Electron, profile or DB opens.
const source=fs.readFileSync(process.env.NOTED_CLOSED_PLACEMENT_STORE || new URL('./useWorkspaceStore.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true);
function find(predicate) {
  let found;const visit=node=>{if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);};
  visit(tree);return found;
}
const action=name=>find(n=>ts.isPropertyAssignment(n)&&n.name.getText(tree)===name)?.initializer.getText(tree);
const declaration=name=>find(n=>ts.isVariableDeclaration(n)&&n.name.getText(tree)===name);
const ns='__tab_catalog_v2__',workflow='space-mvne474t-815oe';
const closed='tab-1f9546c9-854a-421e-a1a6-41a42294b6ae';
const passive='tab-003ee6b1-0cbe-47f9-9b6a-5c317b6ba377';
const retained='tab-31fbc2f2-a8e2-4fad-aa1a-b6ae96f9975a';
const bottom='57386642-c4f9-4b48-8962-1ad71720ae7c';
const chip=tabId=>({projectId:ns,tabId});
const layout=()=>({...emptySpaceLayout(),splitPanes:[
  {...chip(passive),windowId:workflow+':initial',column:0},
  {...chip(closed),windowId:bottom,column:0},
],splitFocusedIndex:1,splitSizes:[0.6,0.4],activeSpaceTab:chip(closed)});
function fixture({enriched=false}={}) {
  const live=layout();
  if(enriched) {
    Object.assign(live.splitPanes[1],{tabs:[chip(closed),{slotId:'chooser',kind:'chooser'},chip(retained),chip('unknown')],
      history:[chip(closed),chip(retained)],detachedTabs:[{...chip(closed),closedOrder:1},{...chip(retained),closedOrder:2}],
      displayHidden:true,extension:{keep:true}});
    live.centerStrips={center:[chip(closed),chip(retained),chip('unknown')]};
    live.windowDisplayLayouts={external:{positions:[{windowId:bottom,column:1,row:0}],sizes:[1]}};
  }
  const rows=[passive,retained].map(id=>({tabId:id,name:id,cwd:'/keep/cwd',codexSessionId:'sid:'+id,draft:'keep draft'}));
  const snapshot={publication:{version:1,migrationVersion:1,revision:8,generation:3},
    workflows:[{id:workflow,kind:'normal',metadata:{},layout:live},
      {id:'dormant',kind:'normal',metadata:{},layout:structuredClone(live)}],
    tabs:[passive,retained,closed,'unresolved'].map(id=>({tabId:id,subjectVersion:2,revision:1,
      executionSubject:{version:2,subjectId:'subject:'+id,executionNamespace:ns,tabId:id},
      nativeRow:id==='unresolved'?null:{id:'row:'+id,execution_archived:id===closed?1:0},
      membership:{workflowId:workflow,revision:1}})),namespaces:[{id:ns,tabs:rows}]};
  const workspace={projectId:ns,tabs:new Map(rows.map(row=>[row.tabId,{...row,id:row.tabId}])),tabHistory:[],tabCounter:2};
  let state={...emptySpaceLayout(),...live,spaces:snapshot.workflows.map(w=>({id:w.id,kind:w.kind,layout:w.layout})),
    openProjects:new Map([[ns,workspace]]),activeSpaceId:workflow,organizationRevision:7,
    organizationWorkflowOrder:[workflow,'dormant'],tabCatalog:{},tabWorkflowMembership:{},pendingTabWorkflowMembership:{},
    organizationReady:false,isRestoring:true,paneStripReleasedPairs:{version:1,workflows:{},commands:{}}};
  const stop=Error('fixture stops after real bootstrap publication'),calls=[];
  let stopAfterPublish=false;
  const context=vm.createContext({...panes,...organization,restorePaneStripReleasedPairs,applyPaneStripReleasePublication,applyPaneStripGatherPublication,
    adoptPaneStripColorGroups,newerWorkflowGroups,reconcileWorkspaceDisplayPatch,crypto:webcrypto,
    useWorkspaceStore:{getState:()=>state,setState:patch=>context.applySet(patch)},
    GLOBAL_EXECUTION_NAMESPACE:ns,INBOX_WORKFLOW_ID:'__inbox__',
    organizationPlacementIntent,tabNavigationLocation:()=>'',ownedTabNavigation:null,
    executionRevisionAcks:{canHydrate:()=>false},projectTabSaveQueue:{pending:()=>false},
    ipcRenderer:{invoke:async channel=>{calls.push(channel);
      if(channel==='workflow:catalog'||channel==='workflow:read')return snapshot;
      if(channel==='workflow:bootstrap')return {};
      throw Error('unexpected IPC '+channel);}},
    get:()=>state,baseSet:update=>{Object.assign(state,update(state));
      if(stopAfterPublish&&state.organizationReady)throw stop;}});
  const helper=declaration('reconcileArchivedWorkspacePlacements');
  const code=(helper?'const '+helper.getText(tree)+';\n':'')
    +'const '+declaration('set').getText(tree)+';\n'
    +'globalThis.applySet=set;\n'
    +'globalThis.bootstrap='+action('bootstrapOrganization')+';\n'
    +'globalThis.refresh='+action('refreshOrganizationCatalog')+';\n'
    +'globalThis.publish='+action('applyPublication')+';\n';
  vm.runInContext(transformSync(code,{loader:'ts',format:'cjs',target:'es2022'}).code,context);
  return {snapshot,calls,workspace,get state(){return state;},
    bootstrap:async()=>{stopAfterPublish=true;await assert.rejects(context.bootstrap({fresh:true}),e=>e===stop);stopAfterPublish=false;},
    refresh:()=>context.refresh(),publish:()=>context.publish({},{}),replaceState:value=>{state=value;}};
}
function assertVacant(state) {
  assert.equal(state.splitPanes[1].windowId,bottom);
  assert.equal(state.splitPanes[1].tabId,'','closed actor must not be selected');
  assert.equal(panes.isEmptyPane(state.splitPanes[1]),true);
  assert.equal(state.splitFocusedIndex,1,'vacant focused window keeps focus');
  assert.equal(state.activeSpaceTab,null);
  assert.equal(state.splitPanes[0].tabId,passive);
  assert.equal(state.spaces.find(s=>s.id==='dormant').layout.splitPanes[1].tabId,'');
}

test('actual catalog-v2 bootstrap: UI37 closed actor cannot reappear from saved UI38 workflow layout',async()=>{
  const f=fixture(),original=structuredClone(f.snapshot),tabs=f.workspace.tabs;
  await f.bootstrap();assertVacant(f.state);
  assert.equal(f.workspace.tabs,tabs);assert.equal(tabs.size,2);
  assert.deepEqual(f.snapshot,original,'publication/receipts remain immutable');
  assert.deepEqual(f.calls,['workflow:bootstrap','workflow:catalog']);
});

test('actual refresh scrubs confirmed archived placements in active and dormant layouts, preserving siblings and authoring',async()=>{
  const f=fixture({enriched:true}),objects=[...f.workspace.tabs.values()],profiles=f.state.windowDisplayLayouts;
  f.state.organizationReady=true;f.state.isRestoring=false;
  await f.refresh();assertVacant(f.state);
  const p=f.state.splitPanes[1];
  assert.deepEqual(panes.paneTabs(p).map(x=>x.tabId),[retained,'unknown']);
  assert.equal(panes.paneChooserSlots(p)[0].slotId,'chooser');
  assert.deepEqual(panes.paneHistory(p).map(x=>x.tabId),[retained]);
  assert.deepEqual(panes.paneDetachedTabs(p).map(x=>x.tabId),[retained]);
  assert.equal(p.displayHidden,true);assert.deepEqual(p.extension,{keep:true});
  assert.equal(f.state.windowDisplayLayouts,profiles);
  assert.deepEqual(f.state.centerStrips.center.map(x=>x.tabId),[retained,'unknown']);
  assert.deepEqual([...f.workspace.tabs.values()],objects);
  assert.equal(f.workspace.tabs.get(retained),objects[1]);
  // A late publication can carry the pre-close layout while its exact row is
  // already archived. Applying it again may not resurrect that placement.
  f.state.splitPanes=f.snapshot.workflows[0].layout.splitPanes;
  f.state.activeSpaceTab=chip(closed);
  await f.refresh();assertVacant(f.state);
});

test('absence/unresolved catalog rows do not authorize removing arbitrary placements; stale revision is ignored',async()=>{
  const f=fixture();f.snapshot.tabs=f.snapshot.tabs.filter(row=>row.tabId!==closed);
  await f.bootstrap();assert.equal(f.state.splitPanes[1].tabId,closed);
  f.state.splitPanes=[{...chip('unresolved'),windowId:bottom}];
  f.state.organizationReady=true;await f.refresh();assert.equal(f.state.splitPanes[0].tabId,'unresolved');
  f.snapshot.publication.revision=1;f.snapshot.tabs[0].nativeRow.execution_archived=1;
  const before=f.state.splitPanes;await f.refresh();assert.equal(f.state.splitPanes,before);
});

test('actual organization applyPublication cannot revive confirmed archived chips after release/gather publication',async()=>{
  const f=fixture({enriched:true}),pending={unknown:{workflowId:workflow,revision:1}};
  f.state.pendingTabWorkflowMembership=pending;
  f.state.organizationReady=true;f.state.isRestoring=false;
  const envelope=f.state.paneStripReleasedPairs;
  await f.publish();assertVacant(f.state);
  assert.equal(f.state.pendingTabWorkflowMembership.unknown,pending.unknown);
  assert.equal(JSON.stringify(f.state.paneStripReleasedPairs),JSON.stringify(envelope));
  assert.deepEqual(f.calls,['workflow:read']);
});

for(const replacement of [false,true])
test('an archived publication cannot vacate a '+(replacement?'replacement subject':'newer restored storage revision'),async()=>{
  const f=fixture(),row=f.snapshot.tabs.find(row=>row.tabId===closed);
  row.nativeRow.execution_storage_revision=5;
  const current={id:closed,executionSubject:{...row.executionSubject,...(replacement?{subjectId:'new subject'}:{})},
    executionStorageRevision:replacement?1:6,cwd:'/new/cwd',draft:'new draft',codexSessionId:'restored-sid'};
  f.workspace.tabs.set(closed,current);
  await f.bootstrap();assert.equal(f.state.splitPanes[1].tabId,closed);
  assert.equal(f.workspace.tabs.get(closed),current);
  await f.publish();assert.equal(f.state.splitPanes[1].tabId,closed);
});

function closingFixture(finalizeAck,onTabClosed=()=>{}) {
  const f=fixture({enriched:true}),state=f.state,events=[];
  const receipt={version:1,mutationId:'original-close',tabId:closed,namespace:ns,subjectId:'subject:'+closed,historyId:100};
  const owner={id:closed,name:'closed actor',tabType:'terminal',commandType:'codex',cwd:'/own/cwd',
    codexSessionId:'01a173ba-4fd5-7211-8e20-7d609a380f65',draft:'own draft',
    executionSubject:{version:2,subjectId:'subject:'+closed,executionNamespace:ns,tabId:closed},
    __archiveClosePending:{archiveRequest:{closeRequest:{mutationId:'original-close'}},
      result:{success:true,historyId:100,closeReceipt:receipt},runtimeStopped:true,parameters:{shouldStopAiProcess:false}}};
  f.workspace.tabs.set(closed,owner);f.workspace.activeTabId=closed;
  state.clearTerminalBuffer=()=>events.push('buffer-cleanup');
  state.globalTabMru=[chip(closed),chip(retained)];state.activeProjectId=ns;
  state.saveSession=()=>events.push({saved:structuredClone({splitPanes:state.splitPanes,spaces:state.spaces})});
  const context=vm.createContext({...panes,tabsAfterClose,dropTabsFromOtherSpaces,dropFromMru,isDurableSaveTabsAck,beginTabCloseFeedback,
    ...organization,crypto:webcrypto,console:{log(){},warn(){}},get:()=>state,
    set:patch=>Object.assign(state,patch),startTransition:fn=>fn(),
    resolvePtyAgentOwner:()=> 'codex',isAiRuntimeTab:()=>true,isAiBusyTab:()=>false,
    collectTabLinkedFiles:()=>[],projectTabSaveQueue:createProjectTabSaveQueue(),projectTabSaveRevisions:new Map(),
    executionRevisionAcks:{ack(){}},notifyProjectLayoutChanged:()=>events.push('layout-notify'),
    clearPendingAutoTabTitle(){},autoTabTitleIntents:new Map(),
    useUIStore:{getState:()=>({showToast:()=>events.push('toast')})},
    usePromptQueueStore:{getState:()=>({cleanupClosedTab:()=>events.push('queue-cleanup')})},
    ipcRenderer:{invoke:async(channel,args)=>{
      events.push(channel);
      if(channel==='project:save-tabs') {
        assert.equal(args.closeFinalization.receipt,receipt,'original receipt is reused');
        assert.equal(args.closeFinalization.runtimeAction,undefined,'no Stop/kill replay');
        if(finalizeAck!==true)return finalizeAck;
        return {success:true,closeReceipt:receipt,closedTabIds:[closed],projectIds:[ns]};
      }
      if(channel==='orchestration:tab-closed'){onTabClosed(f,events);return {success:true};}
      throw Error('unexpected side effect '+channel);
    }}});
  vm.runInContext(transformSync('globalThis.close='+action('closeTab'),{loader:'ts',target:'es2022'}).code,context);
  return {f,state,events,owner,close:()=>context.close(ns,closed)};
}

test('actual receipt-owned close saves the cleaned active AND saved layouts without archive/Stop replay',async()=>{
  const {f,state,events,close}=closingFixture(true),retainedOwner=f.workspace.tabs.get(retained);
  assert.equal(await close(),true);assertVacant(state);
  assert.equal(f.workspace.tabs.has(closed),false);
  assert.equal(f.workspace.tabs.get(retained),retainedOwner);
  const saved=events.filter(e=>e?.saved);assert.equal(saved.length,1);
  assert.equal(saved[0].saved.splitPanes[1].windowId,bottom);
  assert.equal(saved[0].saved.splitPanes[1].tabId,'');
  assert.equal(saved[0].saved.spaces.find(s=>s.id===workflow).layout.splitPanes[1].tabId,'');
  assert.equal(events.filter(e=>e==='project:save-tabs').length,1);
  assert.ok(!events.includes('project:archive-tab'));
});

test('close cleanup runs before orchestration await and cannot purge a later restored owner',async()=>{
  const replacement={id:closed,cwd:'/restored',draft:'restored draft',codexSessionId:'restored-sid'};
  const run=closingFixture(true,(f,events)=>{
    assert.ok(events.some(e=>e?.saved),'save was already scheduled at the owned close boundary');
    f.workspace.tabs.set(closed,replacement);
    f.state.splitPanes=f.state.splitPanes.map(p=>p.windowId===bottom?{...p,...chip(closed),tabs:[chip(closed)]}:p);
  });
  assert.equal(await run.close(),true);
  assert.equal(run.f.workspace.tabs.get(closed),replacement);
  assert.equal(run.state.splitPanes[1].tabId,closed);
});

for(const ack of [undefined,{success:false,error:'fixture-finalization-refused'}])
test('actual close keeps placements and skips organization save for '+(ack?'refusal':'UNKNOWN ACK'),async()=>{
  const {f,state,events,owner,close}=closingFixture(ack),before=state.splitPanes;
  assert.equal(await close(),false);assert.equal(state.splitPanes,before);
  assert.equal(f.workspace.tabs.get(closed),owner);
  assert.ok(!events.some(e=>e?.saved || e==='buffer-cleanup' || e==='queue-cleanup'));
});

test('closed single-centre becomes vacant with live parked chips; cleanup is idempotent and unknown-safe',()=>{
  const original={...emptySpaceLayout(),activeSpaceTab:chip(closed),
    centerStrips:{own:[chip(closed),chip(retained)],foreign:[chip('unknown')]}};
  const cleaned=panes.dropClosedTabPlacements(original,[closed]);
  assert.equal(cleaned.splitPanes.length,1);assert.equal(cleaned.splitPanes[0].tabId,'');
  assert.deepEqual(panes.paneTabs(cleaned.splitPanes[0]),[chip(retained)]);
  assert.equal(cleaned.centerStrips.foreign,original.centerStrips.foreign);
  assert.equal(panes.dropClosedTabPlacements(cleaned,[closed]),cleaned);
  assert.equal(original.activeSpaceTab.tabId,closed);
});
