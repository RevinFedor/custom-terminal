'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {projectWorkflowCatalog,catalogHydrationOrder}=require('./workflow-catalog-projection.cjs');
const {orderedWorkflows}=require('./workflow-order.cjs');
const {selectWorkflowMembers,workflowMemberOutline}=require('./workflow-tree.cjs');
const NS='__tab_catalog_v2__';
const tab=(id,extra={})=>({tabId:id,subjectVersion:2,revision:1,executionSubject:{version:2,tabId:id,subjectId:'subject-'+id,executionNamespace:NS,cwd:'/fixture'},
  executionResolved:true,membership:{tabId:id,workflowId:'w',revision:1},record:{name:'STALE',notes:'OMITTED-LARGE-BODY'},
  nativeRow:{id:1,name:id,tab_type:'terminal',cwd:'/fixture',execution_storage_revision:3,...extra}});
const base=tabs=>({publication:{version:1,migrationVersion:1,revision:4,generation:5,metadata:{}},
  workflows:[{id:'w',kind:'user',revision:1,metadata:{name:'W'},layout:{splitPanes:[{tabId:'a'}]}}],tabs,
  globalGroups:{version:1,revision:2,groups:[],tabGroups:{},membershipRevisions:{}}});

test('canonical workflow order has publication precedence, finite fallback, stable missing IDs and Inbox last',()=>{
  const ws=[{id:'inbox',kind:'inbox',metadata:{order:-100}},{id:'c',metadata:{}},{id:'a',metadata:{order:0}},
    {id:'d',metadata:{order:null}},{id:'b',metadata:{order:1}},{id:'e',metadata:{order:1}}];
  assert.deepEqual(orderedWorkflows(ws,{}).map(w=>w.id),['a','b','e','c','d','inbox']);
  assert.deepEqual(orderedWorkflows(ws,{metadata:{workflowOrder:['b','missing','inbox','a','b']}}).map(w=>w.id),['b','a','e','c','d','inbox']);
  assert.equal(ws[0].id,'inbox');
});

test('hydration fallback retains saved namespace order and existing legacy/independent row ordering',()=>{
  const data=[tab('a',{id:4,position:0,is_utility:1}),tab('b',{id:3,position:0,is_utility:0}),tab('null',{id:5,position:null,is_utility:0}),
    {...tab('legacy-utility',{id:1,position:-1,is_utility:1}),executionSubject:{version:1,projectId:'legacy'}},
    {...tab('legacy-main',{id:2,position:10,is_utility:0}),executionSubject:{version:1,projectId:'legacy'}}];
  assert.deepEqual(catalogHydrationOrder(data,['legacy',NS],['legacy']).map(t=>t.tabId),['legacy-main','legacy-utility','null','b','a']);
});

test('projection separates provenance, uses live fields, and has no bodies or runtime claims',()=>{
  const input=base([tab('a'),tab('archived',{execution_archived:1}),{...tab('missing'),nativeRow:null,executionResolved:false},tab('__proto__')]);
  input.globalGroups.groups=[{id:'empty',name:'E',revision:1,reserveWorkflowId:'w',notes:'OMITTED-GROUP-BODY'}];
  const before=structuredClone(input),dto=projectWorkflowCatalog({snapshot:input});
  assert.deepEqual(input,before);
  assert.deepEqual(Object.keys(dto.rows),['a','__proto__']);
  assert.equal(dto.rows.a.name,'a');assert.equal(dto.rows.__proto__.tabId,'__proto__');
  assert.deepEqual(new Set(dto.provenance.map(p=>p.reason)),new Set(['archived','unresolved']));
  const text=JSON.stringify(dto);assert.ok(!text.includes('OMITTED'));assert.ok(!text.includes('STALE'));
  assert.equal(Object.hasOwn(dto.rows.a,'isRunning'),false);
  assert.deepEqual(dto.excludedSignals,['runtime','cardSignals','history']);
  assert.equal(dto.workflows[0].nodes.find(node=>node.groupId==='empty').childIds.length,0);
});

test('physical and visual relations stay distinct; cycles and foreign parents become context references',()=>{
  const snapshot=base([tab('a',{visual_parent_tab_id:'b'}),tab('b',{visual_parent_tab_id:'a'}),tab('self',{visual_parent_tab_id:'self'}),
    tab('physical',{parent_tab_id:'a'}),tab('child',{parent_tab_id:'a',visual_parent_tab_id:'foreign'}),
    {...tab('foreign'),membership:{workflowId:'other',revision:1}}]);
  snapshot.workflows.push({id:'other',kind:'user',revision:1,metadata:{name:'Other'},layout:{}});
  const dto=projectWorkflowCatalog({snapshot}),tree=dto.workflows.find(w=>w.id==='w').nodes;
  assert.equal(new Set(tree.map(n=>n.id)).size,5);
  assert.ok(tree.every(n=>n.parentId===null),'paths into a cycle are not inline ownership');
  assert.equal(tree.find(n=>n.tabId==='child').contextParent.tabId,'foreign');
  assert.equal(tree.find(n=>n.tabId==='child').contextParent.workflowId,'other');
  assert.equal(dto.rows.child.parentTabId,'a');assert.equal(dto.rows.child.visualParentTabId,'foreign');
});

test('same pure tree receives full members or desktop placement selection, with identical shared semantics',async()=>{
  const {selectWorkflowReserve,workflowReserveOutline}=await import('../renderer/utils/workflowReserve.mjs');
  const {selectWorkflowGlobalGroups}=await import('../renderer/utils/workflowGlobalGroups.mjs');
  assert.equal(typeof selectWorkflowGlobalGroups,'function');
  const tabs=new Map(['a','b','file','hidden','profile','reserve'].map(id=>[id,{id,name:id,...(id==='file'?{tabType:'file',filePath:'/f',visualParentTabId:'a'}:{})}]));
  const state={activeSpaceId:'w',openProjects:new Map([[NS,{tabs}]]),tabWorkflowMembership:Object.fromEntries([...tabs.keys()].map(id=>[id,{workflowId:'w'}])),
    spaces:[{id:'w',reserveOrder:['reserve','a'],reserveRootOrder:['reserve-tab:reserve'],layout:{}}],
    splitPanes:[{tabId:'a'},{tabId:'hidden',displayHidden:true}],windowDisplayLayouts:{old:{splitPanes:[{tabId:'profile'}]}},
    globalGroups:{version:1,revision:1,groups:[],tabGroups:{}}};
  const desktop=selectWorkflowReserve(state,'w',['reserve','a']);
  const full=selectWorkflowMembers({catalog:desktop.catalog,membership:state.tabWorkflowMembership,workflowId:'w',
    globalGroups:state.globalGroups,orderedTabIds:['reserve','a'],rootOrder:['reserve-tab:reserve']});
  assert.equal(full.items.length,6);assert.equal(desktop.reserve.length,3);
  assert.deepEqual(workflowReserveOutline(desktop),workflowMemberOutline({...desktop,items:desktop.reserve}));
  assert.equal(workflowMemberOutline(full)[0].tabId,'reserve');
  assert.equal(workflowMemberOutline(full).find(n=>n.tabId==='a').children[0].tabId,'file');
});
