import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {organizationProjection} from '../utils/workflowOrganizationClient.mjs';
import {captureSpaceLayout} from '../utils/workspaceSpacesModel.mjs';
import {applyWorkflowDragLayout} from '../utils/workflowDragNavigation.mjs';
import {uiDragDiagnostic} from '../utils/uiPerformanceDiagnostics.mjs';
import {newerWorkflowGroups} from '../utils/workflowGroupClient.mjs';

const source=ts.createSourceFile('store.ts',fs.readFileSync(new URL('./useWorkspaceStore.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let expression;
const visit=node=>{
  if(ts.isPropertyAssignment(node) && node.name.getText(source)==='commitWorkflowDrag')expression=node.initializer.getText(source);
  ts.forEachChild(node,visit);
};visit(source);assert.ok(expression);
const code=ts.transpileModule('module.exports='+expression,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const ref=tabId=>({projectId:'P',tabId});
const layout=(tabId,ids)=>({splitPanes:[{windowId:'W',...ref(tabId),tabs:ids.map(ref)}],splitFocusedIndex:0,
  activeSpaceTab:ref(tabId),activeProjectId:'P',focusedProjectId:'P',centerStrips:{}});

function fixture({isSourceCurrent=()=>true,flush=async()=>{},namespaces=[],enqueue}={}) {
  const before=layout('A',['A','C']),after=layout('B',['A','B','C']);
  const state={...before,view:'workspace',activeSpaceId:'w1',navigationRevision:0,organizationReady:true,
    spaces:[{id:'w1',kind:'user',layout:before}],openProjects:new Map(),activated:[],saves:0};
  state.commitOrganization=flush;state.activateCenterTab=(_namespace,id)=>{state.activated.push(id);state.view='workspace';};state.saveSession=()=>state.saves++;
  let release,arrive;
  const pending=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{arrive=resolve;});
  // This existing fixture isolates navigationRevision. Mounted release/scope
  // proofs are exercised with the actual bridge and full request in the repair
  // controls; a presentation owner and current-scope proof are boundaries here.
  const bindings={get:()=>state,set:patch=>Object.assign(state,patch),api:{subscribe:()=>()=>{}},
    beginPaneTabDropPresentation:()=>null,paneDropScopeCurrent:()=>true,
    organizationCommitter:{command:()=>{state.commands=(state.commands||0)+1;arrive();return pending;}},projectTabSaveQueue:{enqueueMany:(_ids,operation)=>enqueue?enqueue(operation):operation()},
    executionRevisionAcks:{},workflowRelationReceipts:{},organizationProjection,captureSpaceLayout,applyWorkflowDragLayout,uiDragDiagnostic,newerWorkflowGroups};
  const action=Function(...Object.keys(bindings),'const module={exports:null};'+code+';return module.exports;')(...Object.values(bindings));
  const request={tabs:namespaces.map(namespace=>({expected:{namespace}})),destinationKind:'window',targetWorkflowId:'w1',workflows:[{workflowId:'w1',beforeLayout:before,layout:after,reserveOrder:[],reserveRootOrder:[]}]};
  const run=action(request,{isSourceCurrent});
  const finish=()=>release({success:true,relationReceipts:[],snapshot:{publication:{version:1,migrationVersion:1,revision:2,generation:2},
    workflows:[{id:'w1',kind:'user',metadata:{},layout:after}],tabs:[],globalGroups:{groups:[],tabGroups:{}}}});
  return {state,run,arrived,finish};
}

test('actual store reveals the accepted drop when its navigation intent survives',async()=>{
  const f=fixture();await f.arrived;f.finish();assert.equal(await f.run,true);
  assert.deepEqual(f.state.activated,['B']);assert.equal(f.state.activeSpaceTab.tabId,'B');
});
test('actual store keeps Home after SQL commit and a delayed ACK, while retaining durable placement',async()=>{
  const f=fixture();await f.arrived;f.state.view='dashboard';f.state.navigationRevision++;f.finish();
  assert.equal(await f.run,true);assert.equal(f.state.view,'dashboard');assert.deepEqual(f.state.activated,[]);
  assert.equal(f.state.activeSpaceTab.tabId,'A');assert.deepEqual(f.state.splitPanes[0].tabs.map(tab=>tab.tabId),['A','B','C']);
});
test('actual store does not revive foreground reveal after away/back to the same tab',async()=>{
  const f=fixture();await f.arrived;f.state.navigationRevision+=2;f.finish();
  assert.equal(await f.run,true);assert.deepEqual(f.state.activated,[]);assert.equal(f.state.activeSpaceTab.tabId,'A');
});

test('group source revoked during organization flush never reaches the drag writer',async()=>{
  let current=true,release;
  const flushed=new Promise(resolve=>{release=resolve;});
  const f=fixture({isSourceCurrent:()=>current,flush:()=>flushed});
  current=false;release();
  assert.equal(await f.run,false);assert.equal(f.state.commands||0,0);assert.equal(f.state.saves,0);
});

test('group source revoked in the namespace queue is refused before Main command',async()=>{
  let current=true;
  const f=fixture({isSourceCurrent:()=>current,namespaces:['P'],enqueue:operation=>{current=false;return operation();}});
  assert.equal(await f.run,false);assert.equal(f.state.commands||0,0);
});

test('a successful own publication does not retire presentation through the old source-order fence',async()=>{
  let current=true;
  const f=fixture({isSourceCurrent:()=>current});await f.arrived;
  current=false;f.finish();
  assert.equal(await f.run,true);assert.equal(f.state.splitPanes[0].tabs[1].tabId,'B');assert.equal(f.state.saves,1);
});
