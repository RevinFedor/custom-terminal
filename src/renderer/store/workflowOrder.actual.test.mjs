import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {organizationProjection,reconcileWorkflowOrder} from '../utils/workflowOrganizationClient.mjs';
const source=ts.createSourceFile('store.ts',fs.readFileSync(new URL('./useWorkspaceStore.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const expressions={};
const walk=node=>{if(ts.isPropertyAssignment(node)&&['refreshOrganizationCatalog','applyPublication'].includes(node.name.getText(source)))expressions[node.name.getText(source)]=node.initializer.getText(source);ts.forEachChild(node,walk);};walk(source);
const snap=(ids,revision=2)=>({publication:{version:1,migrationVersion:1,revision,generation:revision,metadata:{workflowOrder:ids}},
  workflows:ids.map(id=>({id,kind:id==='inbox'?'inbox':'user',revision:1,metadata:{name:id,order:id==='a'?0:1},layout:{server:true}})),tabs:[],namespaces:[],globalGroups:{version:1,revision:1,groups:[],tabGroups:{}}});
for(const method of ['refreshOrganizationCatalog','applyPublication'])for(const localDrag of [false,true])test(`actual ${method}: ${localDrag?'late read preserves newer drag':'publication order preserves layout and focus'}`,async()=>{
  const a={id:'a',layout:{window:'A'},name:'local name'},b={id:'b',layout:{window:'B'}},inbox={id:'inbox',kind:'inbox',layout:{}};
  const state={spaces:[a,b,inbox],organizationWorkflowOrder:['a','b','inbox'],organizationRevision:1,
    activeSpaceId:'a',openProjects:new Map(),pendingTabWorkflowMembership:{},splitPanes:[{windowId:'A'}],view:'dashboard',globalTabMru:['unchanged']};
  let resolve;const pending=new Promise(r=>resolve=r);
  const bindings={ipcRenderer:{invoke:()=>pending},get:()=>state,set:patch=>Object.assign(state,patch),
    useWorkspaceStore:{getState:()=>state,setState:patch=>Object.assign(state,patch)},organizationProjection,reconcileWorkflowOrder,
    INBOX_WORKFLOW_ID:'inbox',executionRevisionAcks:{},projectTabSaveQueue:{}};
  const code=ts.transpileModule('module.exports='+expressions[method],{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const action=Function(...Object.keys(bindings),'const module={exports:null};'+code+';return module.exports;')(...Object.values(bindings));
  const run=action();
  if(localDrag)state.spaces=[b,a,inbox];
  resolve(snap(['a','c','b','inbox']));await run;
  assert.deepEqual(state.spaces.map(s=>s.id),localDrag?['b','a','inbox']:['a','c','b','inbox']);
  assert.equal(state.spaces.find(s=>s.id==='a'),a);assert.equal(state.spaces.find(s=>s.id==='b'),b);
  assert.equal(state.activeSpaceId,'a');assert.equal(state.view,'dashboard');assert.deepEqual(state.splitPanes,[{windowId:'A'}]);
  assert.deepEqual(state.globalTabMru,['unchanged']);assert.deepEqual(state.organizationWorkflowOrder,['a','c','b','inbox']);
});
