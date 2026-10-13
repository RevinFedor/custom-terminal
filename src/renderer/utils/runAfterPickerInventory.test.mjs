import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRunAfterPickerInventory} from './runAfterPickerInventory.mjs';

const inbox='__noted_workflow_inbox__';
const fixture=()=>({organizationReady:true,activeSpaceId:'a',
  spaces:[{id:'a',name:'A',projectIds:[],reserveOrder:['second','owner']},{id:'b',name:'B',projectIds:[]},{id:inbox,kind:'inbox',name:'Inbox',projectIds:[]}],
  openProjects:new Map([['same-namespace',{tabs:new Map([
    ['owner',{id:'owner',name:'Owner',commandType:'codex'}],['second',{id:'second',commandType:'claude'}],
    ['other',{id:'other',commandType:'codex'}],['inbox',{id:'inbox',tabType:'claude-sdk'}],
    ['file',{id:'file',tabType:'file'}],['physical',{id:'physical',commandType:'codex',parentTabId:'owner'}],
  ])}]]),
  tabWorkflowMembership:Object.fromEntries([['owner','a'],['second','a'],['other','b'],['inbox',inbox],['file','a'],['physical','a']]
    .map(([id,workflowId])=>[id,{workflowId,revision:1}])),
  globalGroups:{version:1,revision:1,groups:[],tabGroups:{}}});

test('one execution namespace divides by canonical workflow, not empty projectIds or placement',()=>{
  const state=fixture();state.splitPanes=[{tabId:'other',displayHidden:true}];
  const inventory=canonicalRunAfterPickerInventory(state,{ownerTabId:'owner'});
  assert.deepEqual(inventory.groups.map(g=>[g.workflowId,g.tabs.map(t=>t.id)]),[['a',['second','owner']],['b',['other']],[inbox,['inbox']]]);
  assert.equal(inventory.ownerWorkflowId,'a');assert.ok(inventory.groups.every(g=>!g.unplaced));
});

test('membership-only move updates scope and selected target without changing source state',()=>{
  const state=fixture();state.tabWorkflowMembership.other={workflowId:'a',revision:2};
  const before=structuredClone(state);
  const inventory=canonicalRunAfterPickerInventory(state,{ownerTabId:'owner',selectedTabIds:['other']});
  assert.equal(inventory.selectedTargetWorkflowId,'a');assert.equal(inventory.groups.some(g=>g.workflowId==='b'),false);
  assert.deepEqual(inventory.groups[0].tabs.map(t=>t.id),['second','owner','other']);assert.deepEqual(state,before);
});

test('icon scope explicitly includes empty workflows and Inbox without inventing target tabs',()=>{
  const state=fixture();
  state.tabWorkflowMembership.inbox={workflowId:'a',revision:2};
  state.spaces.splice(1,0,{id:'empty',name:'Empty',projectIds:[]});
  const before=structuredClone(state);
  const compact=canonicalRunAfterPickerInventory(state,{ownerTabId:'owner',includeEmptyWorkflows:true});
  assert.deepEqual(compact.groups.map(group=>group.workflowId),['a','empty','b',inbox]);
  assert.deepEqual(compact.groups.find(group=>group.workflowId===inbox).tabs,[]);
  assert.deepEqual(compact.groups.find(group=>group.workflowId==='empty').rows,[]);
  const legacy=canonicalRunAfterPickerInventory(state,{ownerTabId:'owner'});
  assert.deepEqual(legacy.groups.map(group=>group.workflowId),['a','b']);
  assert.deepEqual(state,before);
});

test('global group spans namespaces in one workflow and uses mixed root order',()=>{
  const state=fixture();state.openProjects.set('second-namespace',{tabs:new Map([['extra',{id:'extra',commandType:'codex'}]])});
  state.tabWorkflowMembership.extra={workflowId:'a',revision:1};
  state.globalGroups={version:1,revision:2,groups:[{id:'g',name:'Group',revision:1,collapsed:true}],tabGroups:{owner:'g',extra:'g',other:'g'}};
  state.spaces[0].reserveRootOrder=['reserve-group:'+JSON.stringify(['__tab_catalog_v2__','g']),'reserve-tab:second'];
  const inventory=canonicalRunAfterPickerInventory(state,{ownerTabId:'owner'}),rows=inventory.groups[0].rows;
  assert.equal(rows[0].type,'group');assert.deepEqual(rows[0].tabs.map(t=>t.id),['owner','extra']);
  assert.equal(rows[0].group.collapsed,true);assert.equal(rows[1].tab.id,'second');
  assert.deepEqual(inventory.groups[1].rows[0].tabs.map(t=>t.id),['other']);
});
