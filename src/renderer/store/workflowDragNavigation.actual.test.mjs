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

function fixture() {
  const before=layout('A',['A','C']),after=layout('B',['A','B','C']);
  const state={...before,view:'workspace',activeSpaceId:'w1',navigationRevision:0,organizationReady:true,
    spaces:[{id:'w1',kind:'user',layout:before}],openProjects:new Map(),activated:[],saves:0};
  state.commitOrganization=async()=>{};state.activateCenterTab=(_namespace,id)=>{state.activated.push(id);state.view='workspace';};state.saveSession=()=>state.saves++;
  let release,arrive;
  const pending=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{arrive=resolve;});
  const bindings={get:()=>state,set:patch=>Object.assign(state,patch),
    organizationCommitter:{command:()=>{arrive();return pending;}},projectTabSaveQueue:{enqueueMany:(_ids,operation)=>operation()},
    executionRevisionAcks:{},workflowRelationReceipts:{},organizationProjection,captureSpaceLayout,applyWorkflowDragLayout,uiDragDiagnostic,newerWorkflowGroups};
  const action=Function(...Object.keys(bindings),'const module={exports:null};'+code+';return module.exports;')(...Object.values(bindings));
  const request={tabs:[],destinationKind:'window',targetWorkflowId:'w1',workflows:[{workflowId:'w1',beforeLayout:before,layout:after,reserveOrder:[],reserveRootOrder:[]}]};
  const run=action(request);
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
