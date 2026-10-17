import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';
const source=fs.readFileSync(process.env.NOTED_CREATION_STORE_SOURCE||new URL('./useWorkspaceStore.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true);
const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='allocateOrganizationTab');assert.ok(node);
const code=ts.transpileModule(node.getText(tree)+';allocateOrganizationTab;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
 const state={organizationReady:true,organizationRevision:1,activeSpaceId:'workflow',tabWorkflowMembership:{neighbor:{revision:4}},tabCatalog:{neighbor:{active:true}},runAfterWorkflowScopeVersions:{neighbor:2}};
 const writes=[],requests=[],tab={id:'child',cwd:'/fixture',pendingOperation:'Создание форка…',pendingAction:{contextFork:{sourceTabId:'source'}}};
 const allocate=vm.runInNewContext(code,{useWorkspaceStore:{getState:()=>state,setState:patch=>{writes.push(patch);Object.assign(state,patch)}},
 organizationCommitter:{runTask:fn=>fn()},crypto:{randomUUID:()=> 'one-mutation'},INBOX_WORKFLOW_ID:'inbox',
 ipcRenderer:{invoke:async(channel,request)=>{requests.push({channel,request});return {executionSubject:{version:2,tabId:'child',subjectId:'subject'},revision:2,generation:8,workflowId:'workflow',membershipRevision:1}}},
 workflowCreationVisibility:{allocated(){}},console:{log(){}}});
 return {state,writes,requests,tab,allocate};
}
test('actual background allocator confirms durable identity/revision without an early membership-only UI publication',async()=>{
 const f=fixture(),members=f.state.tabWorkflowMembership;
 const publish=await f.allocate('namespace',f.tab,{background:true,publishOrganizationWithTab:true});
 assert.equal(f.state.organizationRevision,2);assert.equal(f.state.tabWorkflowMembership,members);
 assert.equal(f.state.tabCatalog.child,undefined);assert.equal(typeof publish,'function');
 assert.equal(f.tab.executionSubject.subjectId,'subject');
 assert.equal(f.requests[0].request.record.pendingAction,undefined,'restart cannot replay transient Fork');
 assert.ok(f.tab.pendingAction.contextFork,'live exact launch intent retained');
 const patch=publish();assert.equal(patch.tabWorkflowMembership.child.workflowId,'workflow');
 assert.equal(patch.tabCatalog.child.executionSubject,f.tab.executionSubject);
 assert.equal(patch.tabCatalog.neighbor,f.state.tabCatalog.neighbor);
 assert.equal(f.state.tabCatalog.child,undefined,'constructing the final patch is pure');
});
test('later authoritative move/close survives delayed final factory publication',async()=>{
 const f=fixture(),publish=await f.allocate('namespace',f.tab,{background:true,publishOrganizationWithTab:true});
 const moved={tabId:'child',workflowId:'away',revision:3},closed={active:false,executionSubject:f.tab.executionSubject};
 f.state.tabWorkflowMembership.child=moved;f.state.tabCatalog.child=closed;f.state.runAfterWorkflowScopeVersions.child=7;
 const patch=publish();assert.equal(patch.tabWorkflowMembership.child,moved);assert.equal(patch.tabCatalog.child,closed);
 assert.equal(patch.runAfterWorkflowScopeVersions.child,7);
});
test('foreground/legacy/restore callers retain their earlier metadata semantics',async()=>{
 const f=fixture();assert.ok((await f.allocate('namespace',f.tab,{}))==null);assert.equal(f.state.tabCatalog.child.active,true);
 const otherBackground=fixture();assert.ok((await otherBackground.allocate('namespace',otherBackground.tab,{background:true}))==null);assert.equal(otherBackground.state.tabCatalog.child.active,true);
 const restored=fixture();assert.ok((await restored.allocate('namespace',restored.tab,{restoreId:'child'}))==null);assert.equal(restored.requests.length,0);
});
