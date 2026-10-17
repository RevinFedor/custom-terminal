// Actual cold reader/factory, creation/save queues, Main IPC/ProjectManager and
// SQLite. PTY/UI and organization-task scheduling are controlled host ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import {createExecutionRevisionAcks} from '../renderer/utils/executionRevisionAcks.mjs';
import {createWorkflowRelationReceipts} from '../renderer/utils/workflowRelationReceipts.mjs';
import {createProjectTabSaveQueue} from '../renderer/utils/projectTabSaveQueue.mjs';
import {commitCreatedTabSnapshot} from '../renderer/utils/tabCreationCommit.mjs';
import {createWorkflowCreationVisibility} from '../renderer/utils/workflowCreationVisibility.mjs';
import {rememberAgentLaunchFence} from '../renderer/utils/agentLaunchFence.mjs';
import {planCodexContextForkSettings} from '../renderer/utils/codexEffectiveSettings.mjs';
import {resolveSiblingInsertionIndex,resolveTabInsertionIndex} from '../renderer/utils/tabInsertionModel.mjs';
import {findOpenTabOwner} from '../renderer/utils/tabLinkNavigation.mjs';
import {selectWorkflowReserve,workflowReserveOutline} from '../renderer/utils/workflowReserve.mjs';
import {spacesWithLiveLayout,workspaceSpacesFingerprint} from '../renderer/utils/workspaceSpaceRecovery.mjs';
import {describeWorkspaceWindowTargets,resolveWorkspaceCreationContext,resolveWorkspaceWindowTarget} from '../renderer/utils/workspaceWindowTarget.mjs';
const require=createRequire(import.meta.url),SQLite=require('better-sqlite3');
const Manager=require('./database'),{createWorkflowOrganizationApi}=require('./workflow-organization-api');
const ack=require('./save-tabs-ack'),{validateForceCleanupTabIds}=require('./save-tabs-precondition');
const read=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
const tree=(name)=>ts.createSourceFile(name,read(name),ts.ScriptTarget.Latest,true);
const storeTree=tree('../renderer/store/useWorkspaceStore.ts'),mainTree=tree('./main.js'),pmTree=tree('./project-manager.js');
function find(ast,predicate){let found;function visit(n){if(!found&&predicate(n))found=n;if(!found)ts.forEachChild(n,visit);}visit(ast);assert.ok(found);return found;}
const variable=name=>find(storeTree,n=>ts.isVariableDeclaration(n)&&n.name.getText(storeTree)===name);
const method=name=>find(storeTree,n=>ts.isPropertyAssignment(n)&&n.name.getText(storeTree)===name).initializer.getText(storeTree);
const declarations=['executionRevisionAcks','workflowRelationReceipts','serializeTabs','saveTabs','notifyProjectLayoutChanged',
  'saveTabsThenNotifyProjectLayoutChanged','saveTabsBatchThenNotifyProjectLayoutChanged','rollbackUnmaterializedCreatedTab','restoreTabOptions']
  .map(name=>'const '+variable(name).getText(storeTree)+';').join('\n');
const allocate=find(storeTree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='allocateOrganizationTab').getText(storeTree);
const code=transformSync(declarations+'\n'+allocate+'\nmodule.exports={saveTabs,saveTabsBatchThenNotifyProjectLayoutChanged,serializeTabs,restoreTabOptions,'
  +['createTab','createTabAfterCurrent'].map(name=>name+':'+method(name)).join(',')+'};',{loader:'ts',format:'cjs'}).code;
const mainSave=find(mainTree,n=>ts.isCallExpression(n)&&n.expression.getText(mainTree)==='ipcMain.handle'&&n.arguments[0]?.text==='project:save-tabs');
const persistBinding=find(mainTree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='persistCodexKnownSessionBinding');
const markAiTab=find(mainTree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='_markTerminalAsAiTab');
const PM=vm.runInNewContext(pmTree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='ProjectManager').getText(pmTree)+';ProjectManager');
const quiet={log(){},warn(){},error(){},info(){}};
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture(t,{namespace,empty=false,initialRecord={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-create-revision-native-')),filename=path.join(root,'private.db');
  let db=new SQLite(filename),manager=new Manager({existingConnection:db});manager.initTables();
  t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});});
  const ns=namespace || manager.createEmptyProject('Private mixed namespace').id;
  let api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
  api.bootstrap({migrationId:'m',mutationId:'m:commit',workspace:{activeSpaceId:'w',spaces:[{id:'w',layout:{},projectIds:[ns]}]}});
  if(!empty)api.createTab({mutationId:'existing-create',tabId:'existing',workflowId:'w',executionNamespace:ns,cwd:root,
    record:{name:'Existing',notes:'preserve user metadata',tabType:'terminal',commandType:'codex',codexSessionId:'same-session',...initialRecord}});
  const workspace={projectId:ns,projectPath:root,tabs:new Map(),tabCounter:0,tabGroups:[],tabHistory:[],activeTabId:'existing'};
  const state={openProjects:new Map([[ns,workspace]]),organizationReady:true,isRestoring:true,splitPanes:[],splitFocusedIndex:0,
    activeSpaceId:'w',organizationRevision:api.read().publication.revision,tabCatalog:{},tabWorkflowMembership:{},runAfterWorkflowScopeVersions:{},
    touchGlobalTabMru(){},clearTerminalBuffer(){}};
  const calls=[],writes=[],module={exports:{}},orgQueue=createProjectTabSaveQueue(),mainEvents=[];
  const mainContext={...ack,validateForceCleanupTabIds,Date,console:quiet,
    get workflowOrganization(){return api;},projectManager:{get db(){return manager;},
      saveProjectTabs:(...args)=>PM.prototype.saveProjectTabs.call({db:manager},...args)},
    _gracefulShutdownInProgress:false,noteProjectCardSignalsChanged(id){state.onSignals?.(id);},tabWorkContext:{syncLinks:async()=>{}}};
  const save=vm.runInNewContext('('+mainSave.arguments[1].getText(mainTree)+')',mainContext);
  const persist=vm.runInNewContext(persistBinding.getText(mainTree)+';persistCodexKnownSessionBinding',{
    projectManager:{get db(){return manager;}},resolveAuthoritativeTabProjectId:()=>ns});
  const mark=vm.runInNewContext(markAiTab.getText(mainTree)+';_markTerminalAsAiTab',{
    console:quiet,projectManager:{get db(){return manager;}},
    mainWindow:{isDestroyed:()=>false,webContents:{send:(...args)=>mainEvents.push(args)}}});
  const useWorkspaceStore={getState:()=>state,setState:patch=>Object.assign(state,patch)};
  const context={module,console:quiet,log:{tabs(){}},crypto:webcrypto,Date,Map,Set,findOpenTabOwner,
    get:()=>state,set:patch=>Object.assign(state,patch),useWorkspaceStore,
    useUIStore:{getState:()=>({newTabPrimarySurface:'history',terminalIsPrimaryTabs:{},setTabTerminalIsPrimary(){},showToast(){}})},
    createExecutionRevisionAcks,createWorkflowRelationReceipts,projectTabSaveQueue:createProjectTabSaveQueue(),
    projectTabCreationQueue:createProjectTabSaveQueue(),projectTabSaveRevisions:new Map(),
    organizationCommitter:{runTask:fn=>orgQueue.enqueue('org',fn)},INBOX_WORKFLOW_ID:'w',
    resolveWorkspaceCwd:value=>value||root,restoreShortId:value=>String(value||''),dndShortId:value=>String(value),
    getNextAvailableName:()=> 'New',resolveExistingTabGroupId:()=>undefined,
    commitCreatedTabSnapshot,resolveSiblingInsertionIndex,resolveTabInsertionIndex,rememberAgentLaunchFence,
    planCodexContextForkSettings,
    workflowCreationVisibility:createWorkflowCreationVisibility({log(){}}),
    ipcRenderer:{send:(...args)=>calls.push(args),invoke:async(channel,payload)=>{
      calls.push([channel,payload]);
      if(channel==='terminal:create')return{pid:123,cwd:payload.cwd};
      if(channel==='workflow:create-tab'){
        const result=api.createTab(payload);
        if(state.afterAllocation)await state.afterAllocation(payload,result);
        return result;
      }
      if(channel==='workflow:mutation')return api.getMutation(payload);
      if(channel==='project:layout-changed')return{success:true};
      if(channel==='tab:rollback-unmaterialized-create')return manager.rollbackUnmaterializedCreatedTab(payload.projectId,payload.tabId);
      if(channel==='project:save-tabs'){
        if(state.beforeSave)await state.beforeSave(payload);
        const result=save({},plain(payload));writes.push({payload:plain(payload),result:plain(result)});
        if(state.afterSave)await state.afterSave(payload,result);
        return result;
      }
      throw Error('Unexpected port '+channel);
    }}};
  vm.runInNewContext(code,context);Object.assign(state,module.exports);
  const cold=manager.getProjectById(ns).tabs.find(tab=>tab.tabId==='existing');
  if(cold)await state.createTab(ns,cold.name,cold.cwd,state.restoreTabOptions(cold));state.isRestoring=false;
  return {root,ns,state,workspace,calls,writes,persist,mark,mainEvents,get db(){return db;},get manager(){return manager;},get snapshot(){return api.read();},
    newTab:options=>state.createTabAfterCurrent(ns,'New Codex',root,{background:true,pendingAction:{type:'codex-new'},...options}),
    reopen(){db.close();db=new SQLite(filename);manager=new Manager({existingConnection:db});api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});},
    row:()=>manager.getExecutionTabV2({executionNamespace:ns,tabId:'existing'})};
}

test('empty standalone namespace restore stays empty, then actual New commits without a synthetic legacy tab',async t=>{
  const f=await fixture(t,{namespace:'__tab_catalog_v2__',empty:true});
  const projectData=f.manager.getProjectById(f.ns);
  assert.equal(projectData.executionScopeVersion,2);assert.deepEqual(projectData.tabs,[]);
  const restore=find(storeTree,n=>ts.isPropertyAssignment(n)&&n.name.getText(storeTree)==='restoreSession');
  const branch=find(restore,n=>ts.isIfStatement(n)&&n.expression.getText(storeTree).includes('isInbox')
    &&n.thenStatement.getText(storeTree).includes('defaultTabFailed'));
  const creates=vm.runInNewContext(branch.expression.getText(storeTree),{isInbox:false,projectData});
  f.state.organizationReady=false;f.state.isRestoring=true;
  if(creates)await f.state.createTab(f.ns,'Terminal 1',f.root);
  f.state.organizationReady=true;f.state.isRestoring=false;
  assert.equal(f.workspace.tabs.size,0,'no namespace-tab-0 PTY may poison later full snapshots');
  const id=await f.newTab();assert.ok(id);assert.equal(f.workspace.tabs.size,1);
  const saved=f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id});
  assert.ok(saved);assert.equal(saved.row.project_id,null);assert.equal(saved.tab.executionSubject.version,2);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:create').length,1);
  assert.equal(f.calls.some(([kind])=>kind==='terminal:kill'),false);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].result.success,true);
});

test('context Fork initial allocation/SQLite row carries the source choice without source SID/proof',async t=>{
  const f=await fixture(t),source=f.workspace.tabs.get('existing');
  Object.assign(source,{codexModel:'gpt-6-astra',codexEffort:'max',codexSettingsProofAt:700,codexSettingsProofSessionId:'same-session'});
  const id=await f.newTab({pendingAction:{type:'codex-fork',sessionId:'same-session',contextFork:{
    sourceTabId:'existing',sourceSessionId:'same-session',fromLatestCompact:false}}});
  const child=f.workspace.tabs.get(id),saved=f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id}).tab;
  assert.equal(child.codexModel,'gpt-6-astra');assert.equal(saved.codexModel,'gpt-6-astra');
  assert.equal(saved.codexEffort,'max');assert.equal(saved.codexSessionId,null);
  assert.equal(saved.codexSettingsProofAt,null);assert.equal(saved.codexSettingsProofSessionId,null);
  assert.equal(saved.codexForkInitialSettings,undefined,'transient display hint is not a persistent proof or replay');
  assert.equal(source.codexSessionId,'same-session');
});

test('same-SID first-writer settings update reconciles before unrelated New commits exactly once',async t=>{
  const f=await fixture(t),cold=f.workspace.tabs.get('existing'),before=cold.executionStorageRevision;
  assert.equal(f.persist('existing','same-session',{model:'fixture-model',effort:'high',proofAt:700}).success,true);
  assert.equal(f.row().revision,before+1);assert.equal(cold.executionStorageRevision,before);
  const id=await f.newTab();
  assert.ok(id);assert.equal(f.workspace.tabs.has(id),true);assert.equal(f.writes.length,1);
  assert.equal(f.row().tab.codexModel,'fixture-model');assert.equal(f.row().tab.codexSettingsProofAt,700);
  assert.equal(f.row().tab.notes,'preserve user metadata');assert.equal(f.row().tab.codexSessionId,'same-session');
  assert.equal(cold.executionStorageRevision,before,'New did not write or rebase the neighbor');
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  assert.equal(cold.executionStorageRevision,f.row().revision);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:kill').length,0);
});

for(const method of ['createTab','createTabAfterCurrent'])test(method+': Fork child ignores the exact MCP mark-ai neighbor revision gap 5→6',async t=>{
  const f=await fixture(t,{initialRecord:{commandType:null,color:null,nameSetManually:true}});
  const neighbor=f.workspace.tabs.get('existing');
  for(let n=1;n<5;n++)assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  assert.equal(neighbor.executionStorageRevision,5);
  f.mark('existing','codex');
  assert.equal(f.row().revision,6);assert.equal(neighbor.executionStorageRevision,5);
  assert.equal(f.row().tab.commandType,'codex');assert.equal(f.row().tab.color,'codex');
  assert.equal(f.db.prepare('SELECT count(*) n FROM workflow_execution_main_field_receipts').get().n,0,
    'command type and color are renderer-writable: no forged Main-only reconciliation');
  assert.equal(f.mainEvents[0][0],'terminal:mcp-ai-tab');
  const before=plain(f.row().row),writesBefore=f.writes.length;
  const id=await f.state[method](f.ns,'Fork',f.root,{background:true,commandType:'codex',visualParentTabId:'existing',
    pendingAction:{type:'codex-fork',sessionId:'same-session',contextFork:{sourceTabId:'existing',sourceSessionId:'same-session'}}});
  assert.ok(id);assert.equal(f.workspace.tabs.get('existing'),neighbor);
  assert.deepEqual(f.row().row,before,'creating the child must not write or adopt a revision for its neighbor');
  assert.deepEqual(f.writes.slice(writesBefore).map(w=>w.payload.tabs.map(t=>t.tabId)),[[id]]);
  const child=f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id});
  assert.ok(child);assert.equal(child.tab.visualParentTabId,'existing');assert.equal(child.tab.codexSessionId,null);
  assert.equal(f.workspace.tabs.get(id).pendingOperation,'Создание форка…');
  assert.equal(f.calls.filter(([kind])=>kind==='workflow:create-tab').length,1);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:create').length,2,'one restored fixture shell and one child shell');
  assert.equal(f.calls.some(([kind])=>kind==='terminal:kill'),false);
  assert.equal((await f.state.saveTabs(f.ns,new Map([['existing',neighbor]]))).success,false,
    'the same stale neighbor still refuses a write that actually includes it');
});

test('Fork child does not commit unsaved or foreign neighboring metadata and retains its own strict CAS',async t=>{
  const f=await fixture(t),neighbor=f.workspace.tabs.get('existing');
  neighbor.notes='local pending note';
  f.db.prepare('UPDATE tabs SET notes=?,name=? WHERE tab_id=?').run('foreign newer note','foreign newer name','existing');
  const before=plain(f.row().row);
  const id=await f.newTab({visualParentTabId:'existing',pendingAction:{type:'codex-fork',sessionId:'same-session',
    contextFork:{sourceTabId:'existing',sourceSessionId:'same-session'}}});
  assert.ok(id);assert.deepEqual(f.row().row,before);assert.equal(neighbor.notes,'local pending note');
  assert.equal((await f.state.saveTabs(f.ns,new Map([['existing',neighbor]]))).success,false);
  f.state.beforeSave=payload=>{
    f.state.beforeSave=null;
    const child=payload.tabs.find(tab=>tab.tabId!=='existing'&&tab.tabId!==id);
    f.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('foreign candidate edit',child.tabId);
  };
  await assert.rejects(f.newTab(),/execution_storage_revision_changed/);
  const last=f.calls.filter(([kind])=>kind==='workflow:create-tab').at(-1)[1].tabId;
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:last}),null);
  assert.equal(f.workspace.tabs.has(last),false);assert.equal(f.calls.filter(([kind])=>kind==='terminal:kill').length,1);
  assert.deepEqual(f.row().row,before);
});

test('native Fork rebases placement after a neighbor replacement without allocating or publishing twice',async t=>{
  const f=await fixture(t),published=[];
  f.state.afterSave=()=>{
    f.state.afterSave=null;
    f.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('foreign latest note','existing');
    const replacement={...f.workspace.tabs.get('existing'),notes:'newer local note'};
    f.workspace.tabs=new Map([['existing',replacement]]);
  };
  const id=await f.newTab({pendingAction:{type:'codex-fork',sessionId:'same-session',
    contextFork:{sourceTabId:'existing',sourceSessionId:'same-session'}},onPublish:tabId=>{published.push(tabId);return null;}});
  assert.deepEqual(published,[id]);assert.equal(f.writes.length,2,'only persistence/placement retries, not allocation or launch');
  assert.deepEqual(f.writes.map(w=>w.payload.tabs.map(t=>t.tabId)),[[id],[id]]);
  assert.equal(f.calls.filter(([kind])=>kind==='workflow:create-tab').length,1);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:create').length,2);
  assert.equal(f.workspace.tabs.get('existing').notes,'newer local note');assert.equal(f.row().tab.notes,'foreign latest note');
  assert.equal(f.calls.some(([kind])=>/run-command|send|paste|terminal:kill/.test(kind)),false);
});

test('lost allocation ACK resolves the exact mutation once before native Fork save/publication',async t=>{
  const f=await fixture(t),published=[];
  f.state.afterAllocation=()=>{f.state.afterAllocation=null;throw Error('lost exact allocation ACK');};
  const id=await f.newTab({pendingAction:{type:'codex-fork',sessionId:'same-session',
    contextFork:{sourceTabId:'existing',sourceSessionId:'same-session'}},onPublish:tabId=>{published.push(tabId);return null;}});
  const allocation=f.calls.find(([kind])=>kind==='workflow:create-tab')[1];
  assert.equal(f.calls.filter(([kind])=>kind==='workflow:create-tab').length,1);
  assert.deepEqual(f.calls.filter(([kind])=>kind==='workflow:mutation').map(([,id])=>id),[allocation.mutationId]);
  assert.deepEqual(published,[id]);assert.deepEqual(f.writes.map(w=>w.payload.tabs.map(t=>t.tabId)),[[id]]);
  assert.ok(f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id}));
});

test('session-bound context point update also cannot strand an unrelated creation',async t=>{
  const f=await fixture(t),before=f.row().revision;
  assert.equal(f.manager.updateCodexTabContextPctForSession('existing','same-session',43.9),true);
  assert.equal(f.row().revision,before+1);
  const id=await f.newTab();assert.ok(id);assert.equal(f.row().row.context_pct,43.9);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,f.row().revision);
});

test('direct New factory uses the same reconciled durable save as chooser creation',async t=>{
  const f=await fixture(t);f.persist('existing','same-session',{model:'new-model',effort:'high',proofAt:800});
  const id=await f.state.createTab(f.ns,'Direct Codex',f.root,{background:true,pendingAction:{type:'codex-new'}});
  assert.ok(id);assert.equal(f.workspace.tabs.has(id),true);assert.equal(f.writes.length,1);
  assert.equal(f.row().tab.codexModel,'new-model');
  assert.deepEqual(f.writes[0].payload.tabs.map(row=>row.tabId),[id]);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  assert.ok(f.writes[1].result.executionReconciliations[0].fields.includes('codex_model'));
});

test('early fork target keeps a concurrent manual name across Main compact binding and metadata save',async t=>{
  const f=await fixture(t);
  const id=await f.newTab({commandType:'codex',pendingAction:{type:'codex-fork',sessionId:'same-session',
    contextFork:{sourceTabId:'existing',sourceSessionId:'same-session',fromLatestCompact:true}}});
  const tab=f.workspace.tabs.get(id);
  assert.equal(tab.pendingOperation,'Создание форка…');
  assert.equal(tab.codexSessionId,undefined,'parent SID is not lent to the child');
  tab.name='Моя ветка';tab.nameSetManually=true;
  assert.equal(f.manager.compareAndSetTabCodexSessionId(f.ns,id,null,'compact-child'),true);
  const saved=await f.state.saveTabs(f.ns,f.workspace.tabs);
  assert.equal(saved.success,true);
  const after=f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id});
  assert.equal(after.tab.name,'Моя ветка');assert.equal(after.tab.nameSetManually,true);
  assert.equal(after.tab.codexSessionId,'compact-child');
  assert.equal(after.tab.pendingOperation,undefined,'preparation is not a restored phantom operation');
  assert.equal(after.tab.pendingAction,undefined,'restart cannot replay an interrupted fork');
  assert.equal(f.row().tab.codexSessionId,'same-session');
});

test('chooser-style foreground publication sees the exact durable row once and retains the existing object',async t=>{
  const f=await fixture(t),existing=f.workspace.tabs.get('existing'),published=[];
  f.persist('existing','same-session',{model:'new-model',effort:'high',proofAt:800});
  const id=await f.newTab({background:false,onPublish:(tabId,candidate)=>{
    const saved=f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId});
    assert.ok(saved);assert.equal(candidate.get(tabId).executionStorageRevision,saved.revision);
    published.push(tabId);return{activeSpaceTab:{projectId:f.ns,tabId}};
  }});
  assert.deepEqual(published,[id]);assert.equal(f.workspace.activeTabId,id);
  assert.equal(f.workspace.tabs.get('existing'),existing);assert.equal(f.state.activeSpaceTab.tabId,id);
  assert.equal(f.calls.some(([kind])=>/input|send-prompt|write/.test(kind)),false);
});

test('context seed on the allocated new native candidate before publication preserves its initial ACK',async t=>{
  const f=await fixture(t);
  f.state.beforeSave=payload=>{
    f.state.beforeSave=null;
    const candidate=payload.tabs.find(row=>row.tabId!=='existing');
    assert.equal(f.manager.updateCodexTabContextPctForSession(candidate.tabId,'fork-session',43.9),true);
  };
  const id=await f.newTab({codexSessionId:'fork-session',pendingAction:{type:'codex-compact-fork',sessionId:'fork-session'}});
  const saved=f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id});
  assert.equal(saved.row.context_pct,43.9);assert.equal(saved.tab.codexSessionId,'fork-session');
  assert.equal(f.workspace.tabs.get(id).executionStorageRevision,saved.revision);
  assert.equal(f.writes.length,1);
});

test('contiguous context/settings/writer points preserve newer Main data and queued user metadata',async t=>{
  const f=await fixture(t),before=f.row().revision;
  f.manager.updateCodexTabContextPctForSession('existing','same-session',43.9);
  f.persist('existing','same-session',{model:'first-model',effort:'high',proofAt:700});
  assert.equal(f.manager.compareAndSetTabCodexSessionId(f.ns,'existing','same-session','new-session'),true);
  f.manager.updateCodexTabContextPctForSession('existing','new-session',9.1);
  f.persist('existing','new-session',{model:'latest-model',effort:'max',proofAt:800});
  assert.equal(f.row().revision,before+5);
  f.workspace.tabs.get('existing').notes='local unsaved metadata';
  const id=await f.newTab();assert.ok(id);
  assert.equal(f.row().tab.notes,'preserve user metadata','creating a child cannot commit a pending neighbor edit');
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  const saved=f.row();
  assert.equal(saved.tab.notes,'local unsaved metadata');assert.equal(saved.tab.codexSessionId,'new-session');
  assert.equal(saved.tab.codexModel,'latest-model');assert.equal(saved.tab.codexSettingsProofAt,800);
  assert.equal(saved.row.context_pct,9.1);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,saved.revision);
  assert.equal(f.writes[1].result.executionReconciliations[0].fromRevision,before);
  assert.equal(f.writes[1].result.executionReconciliations[0].toRevision,before+5);
});

test('foreign metadata between points still refuses its full save without blocking unrelated creation',async t=>{
  const f=await fixture(t);
  f.manager.updateCodexTabContextPctForSession('existing','same-session',10);
  f.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('newer foreign note','existing');
  f.persist('existing','same-session',{model:'latest-model',effort:'high',proofAt:900});
  const revision=f.row().revision;
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,false);
  const id=await f.newTab();assert.ok(id);
  assert.equal(f.row().tab.notes,'newer foreign note');assert.equal(f.row().revision,revision);
  const created=f.calls.filter(([kind])=>kind==='workflow:create-tab').map(([,payload])=>payload.tabId);
  assert.equal(created.length,1);
  assert.ok(f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:created[0]}));
  assert.equal(f.workspace.tabs.has(created[0]),true);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:kill').length,0);
});

test('compound Main and metadata UPDATE cannot acquire a point-only receipt',async t=>{
  const f=await fixture(t);
  f.db.prepare('UPDATE tabs SET context_pct=20,name=? WHERE tab_id=?').run('foreign name','existing');
  f.manager.updateCodexTabContextPctForSession('existing','same-session',30);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,false);
  assert.ok(await f.newTab());
  assert.equal(f.row().tab.name,'foreign name');
});

for(const mainFirst of [false,true])test('metadata side-effect trigger invalidates point proof regardless of execution order '+mainFirst,async t=>{
  const f=await fixture(t);
  f.db.exec("CREATE TRIGGER foreign_metadata AFTER UPDATE OF context_pct ON tabs BEGIN UPDATE tabs SET notes='foreign side effect' WHERE id=NEW.id; END");
  if(mainFirst){f.db.exec('DROP TRIGGER workflow_tabs_main_field_receipt; DROP TRIGGER workflow_tabs_metadata_receipt_invalidate');f.manager.ensureWorkflowExecutionStorage();}
  f.manager.updateCodexTabContextPctForSession('existing','same-session',20);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,false);
  assert.ok(await f.newTab());
  assert.equal(f.row().tab.notes,'foreign side effect');
});

test('direct execution CAS stays strict; stale subject/cwd and archive never use metadata-save reconciliation',async t=>{
  const f=await fixture(t),row=plain(f.state.serializeTabs(f.workspace.tabs)[0]);
  f.manager.updateCodexTabContextPctForSession('existing','same-session',20);
  assert.throws(()=>f.manager.saveExecutionTabV2({executionNamespace:f.ns,tabId:row.tabId,
    subjectId:row.executionSubject.subjectId,expectedRevision:row.executionStorageRevision,record:row}),/execution_storage_revision_changed/);
  for(const change of [{subjectId:'foreign'},{cwd:'/foreign'},{executionNamespace:'foreign'},{tabId:'foreign'}]) {
    const copy={...row,executionSubject:{...row.executionSubject,...change}};
    assert.throws(()=>f.manager.saveTabs(f.ns,[copy]),/execution_(subject|storage_revision)_changed/);
  }
  f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('existing');
  assert.throws(()=>f.manager.saveTabs(f.ns,[row]),/execution_storage_revision_changed/);
});

test('point receipt is atomic on rollback and survives database reopen',async t=>{
  const f=await fixture(t),before=f.row().revision;
  assert.throws(()=>f.db.transaction(()=>{f.manager.updateCodexTabContextPctForSession('existing','same-session',10);throw Error('rollback');})(),/rollback/);
  assert.equal(f.row().revision,before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM workflow_execution_main_field_receipts').get().n,0);
  f.manager.updateCodexTabContextPctForSession('existing','same-session',20);
  f.reopen();
  assert.equal(f.db.prepare('SELECT count(*) n FROM workflow_execution_main_field_receipts').get().n,1);
  assert.ok(await f.newTab());assert.equal(f.row().row.context_pct,20);
});

test('cancel after durable save rolls back only the unpublished candidate and preserves reconciled owner',async t=>{
  const f=await fixture(t);let canPublish=true;
  f.persist('existing','same-session',{model:'new-model',effort:'high',proofAt:800});
  f.state.afterSave=()=>{canPublish=false;};
  assert.equal(await f.newTab({canPublish:()=>canPublish}),'');
  const id=f.calls.find(([kind])=>kind==='workflow:create-tab')[1].tabId;
  assert.equal(f.workspace.tabs.size,1);assert.equal(f.workspace.tabs.has(id),false);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:id}),null);
  assert.equal(f.row().tab.codexModel,'new-model');
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:kill').length,1);
});

test('queued own ACK updates replacement objects, then the next frozen snapshot may change its own metadata',async t=>{
  const f=await fixture(t);f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  let release,arrived;const gate=new Promise(resolve=>{arrived=resolve;});
  f.state.afterSave=async()=>{f.state.afterSave=null;arrived();await new Promise(resolve=>{release=resolve;});};
  const first=f.state.saveTabs(f.ns,f.workspace.tabs);await gate;
  const replacement={...f.workspace.tabs.get('existing'),notes:'second queued edit'};f.workspace.tabs.set('existing',replacement);
  const second=f.state.saveTabs(f.ns,f.workspace.tabs);release();
  assert.equal((await first).success,true);assert.equal((await second).success,true);
  assert.equal(f.row().tab.notes,'second queued edit');assert.equal(replacement.executionStorageRevision,f.row().revision);
  assert.equal(f.writes.length,2);assert.equal(f.row().row.context_pct,22);
});

test('whole batch preserves Main-field receipts for its existing ACK path',async t=>{
  const f=await fixture(t);f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  const result=await f.state.saveTabsBatchThenNotifyProjectLayoutChanged([
    {projectId:f.ns,tabs:f.workspace.tabs,expectedTabIds:['existing']}],'fixture-batch');
  assert.equal(result.success,true);assert.equal(result.executionReconciliations.length,1);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,f.row().revision);
});

test('batch ACK captures its own commit before publication callbacks can advance the data clock again',async t=>{
  const f=await fixture(t),before=f.row().revision;
  f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  f.state.onSignals=()=>{f.state.onSignals=null;f.manager.updateCodexTabContextPctForSession('existing','same-session',23);};
  const result=await f.state.saveTabsBatchThenNotifyProjectLayoutChanged([
    {projectId:f.ns,tabs:f.workspace.tabs,expectedTabIds:['existing']}],'fixture-batch-post-commit');
  assert.equal(result.success,true);assert.equal(f.row().revision,before+3);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,before+2);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,f.row().revision);
});

test('later batch failure rolls back the admitted metadata and its receipt consumption together',async t=>{
  const f=await fixture(t),other=f.manager.createEmptyProject('Other private namespace').id;
  f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  const before=f.row(),proof=f.db.prepare('SELECT * FROM workflow_execution_main_field_receipts').get();
  f.workspace.tabs.get('existing').notes='queued local note';
  const result=await f.state.saveTabsBatchThenNotifyProjectLayoutChanged([
    {projectId:f.ns,tabs:f.workspace.tabs,expectedTabIds:['existing']},
    {projectId:other,tabs:new Map([['bad',{id:'',name:'invalid'}]]),expectedTabIds:[]},
  ],'fixture-batch-failure');
  assert.equal(result.success,false);assert.equal(f.row().revision,before.revision);
  assert.equal(f.row().tab.notes,before.tab.notes);
  assert.deepEqual(f.db.prepare('SELECT * FROM workflow_execution_main_field_receipts').get(),proof);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,true);
  assert.equal(f.row().tab.notes,'queued local note');
});

test('a future metadata column also invalidates the narrow proof after schema reconciliation',async t=>{
  const f=await fixture(t);
  f.db.exec('ALTER TABLE tabs ADD COLUMN future_metadata BLOB');f.manager.ensureWorkflowExecutionStorage();
  f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  f.db.prepare('UPDATE tabs SET future_metadata=? WHERE tab_id=?').run(Buffer.from([0,1,255]),'existing');
  f.manager.updateCodexTabContextPctForSession('existing','same-session',23);
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,false);
  assert.ok(await f.newTab());
  assert.deepEqual(f.row().row.future_metadata,Buffer.from([0,1,255]));
});

test('case-only metadata changes are conflicts even when a future column uses NOCASE collation',async t=>{
  const f=await fixture(t);
  f.db.exec("ALTER TABLE tabs ADD COLUMN future_label TEXT COLLATE NOCASE DEFAULT 'Alpha'");
  f.manager.ensureWorkflowExecutionStorage();
  f.db.prepare("UPDATE tabs SET context_pct=22,future_label='alpha' WHERE tab_id=?").run('existing');
  assert.equal((await f.state.saveTabs(f.ns,f.workspace.tabs)).success,false);
  assert.ok(await f.newTab());
  assert.equal(f.row().row.future_label,'alpha');
});

test('legacy rows retain their existing snapshot behavior in a mixed namespace',async t=>{
  const f=await fixture(t);
  assert.equal(f.manager._saveLegacyTabs(f.ns,[{tabId:'legacy',name:'Legacy',cwd:f.root,notes:'legacy note'}]).success,true);
  const saved=f.manager.getProjectById(f.ns).tabs.find(tab=>tab.tabId==='legacy');
  f.workspace.tabs.set('legacy',{...saved,id:'legacy'});
  f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  assert.ok(await f.newTab());
  const legacy=f.manager.getProjectById(f.ns).tabs.find(tab=>tab.tabId==='legacy');
  assert.equal(legacy.notes,'legacy note');assert.equal(legacy.executionSubject,undefined);
  assert.equal(f.db.prepare('SELECT execution_subject_version FROM tabs WHERE tab_id=?').get('legacy').execution_subject_version,1);
});

test('proof remains bounded per tab and never classifies a renderer-writable column as Main-owned',async t=>{
  const {MAIN_OWNED_COLUMNS}=require('./execution-main-field-receipts');
  const f=await fixture(t);
  for(let n=0;n<100;n++)f.manager.updateCodexTabContextPctForSession('existing','same-session',n/2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM workflow_execution_main_field_receipts').get().n,1);
  const writable=f.manager._executionRecordColumns(f.row().tab);
  assert.deepEqual(Object.keys(writable).filter(name=>MAIN_OWNED_COLUMNS.includes(name)),[]);
  assert.ok(await f.newTab());
});

test('physical removal discards proof even on a connection with foreign keys disabled',async t=>{
  const f=await fixture(t);f.manager.updateCodexTabContextPctForSession('existing','same-session',22);
  f.db.pragma('foreign_keys=OFF');f.db.prepare('DELETE FROM tabs WHERE tab_id=?').run('existing');
  assert.equal(f.db.prepare('SELECT count(*) n FROM workflow_execution_main_field_receipts').get().n,0);
});

// Execute the actual Project API creation branch and its workflow resolver.
// Namespace opening, path-exists and provider launch are controlled ports;
// the factory, canonical allocation, save ACK, SQLite and Reserve are real.
const appSource=read('../renderer/App.tsx');
const appTree=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const appVariable=name=>find(appTree,n=>ts.isVariableDeclaration(n)&&n.name.getText(appTree)===name);
const agentBranch=find(appTree,n=>ts.isIfStatement(n)&&n.expression.getText(appTree)==="action === 'createAgentTab'");
const agentBridgeCode=transformSync(['resolveBridgeCreationTarget','placeCreatedTab'].map(name=>'const '+appVariable(name).getText(appTree)+';').join('\n')
  +'\nmodule.exports=async(payload)=>{const action="createAgentTab",state=useWorkspaceStore.getState();'+agentBranch.getText(appTree)+'};',
  {loader:'tsx',format:'cjs'}).code;
function agentBridge(f){
  const module={exports:{}},launches=[];
  const snapshot=f.snapshot;
  Object.assign(f.state,{activeSpaceId:'different-visible-workflow',pendingTabWorkflowMembership:{},
    spaces:[...snapshot.workflows.map(w=>({...w.metadata,id:w.id,layout:w.layout,projectIds:[]})),{id:'different-visible-workflow',layout:{},projectIds:[]}],
    tabWorkflowMembership:Object.fromEntries(snapshot.tabs.filter(t=>t.membership).map(t=>[t.tabId,t.membership])),
    setTabCommandType(id,type){f.workspace.tabs.get(id).commandType=type;},markAiLaunchAutoTitle(){}});
  vm.runInNewContext(agentBridgeCode,{module,console:quiet,
    useWorkspaceStore:{getState:()=>f.state},ensureProjectWorkspace:async id=>f.state.openProjects.get(id),
    spacesWithLiveLayout,workspaceSpacesFingerprint,describeWorkspaceWindowTargets,resolveWorkspaceCreationContext,resolveWorkspaceWindowTarget,
    resolveWorkspaceCwd:()=>f.root,ipcRenderer:{invoke:async(channel,value)=>{
      assert.equal(channel,'app:check-path-exists');return fs.existsSync(value);
    }},reply:(ok,data,error)=>({ok,data,error}),
    startFreshCodexSession:async request=>{
      const entry=f.snapshot.tabs.find(t=>t.tabId===request.tabId);
      launches.push({request,membership:entry?.membership,
        native:!!f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:request.tabId})});return{success:true};
    }});
  return{create:module.exports,launches};
}

for(const namespace of [undefined,'__tab_catalog_v2__'])for(const placement of ['child','root'])test('reserved MCP '+placement+' in '+(namespace||'legacy namespace')+' registers exact ID before launch and appears in source workflow Reserve',async t=>{
  const f=await fixture(t,{namespace}),bridge=agentBridge(f),reservedTabId='reserved-'+placement;
  f.state.spaces.find(space=>space.id==='w').layout={splitPanes:[{windowId:'parent-window',projectId:f.ns,
    tabId:'existing',tabs:[{projectId:f.ns,tabId:'existing'}],hidden:true}]};
  const result=await bridge.create({projectId:f.ns,sourceTabId:'existing',reservedTabId,
    name:'MCP child',toolType:'codex',placement,background:true,startNow:true,codexModel:'fixture-model',codexEffort:'high'});
  assert.equal(result.ok,true);assert.equal(result.data.tabId,reservedTabId);
  assert.equal(f.workspace.tabs.get(reservedTabId).visualParentTabId,placement==='child'?'existing':undefined);
  assert.equal(f.workspace.tabs.get(reservedTabId).codexModel,'fixture-model');
  const entry=f.snapshot.tabs.find(t=>t.tabId===reservedTabId);
  assert.ok(entry,'new reserved target must enter canonical workflow catalog');
  assert.equal(entry.membership.workflowId,'w');assert.equal(entry.executionSubject.executionNamespace,f.ns);
  assert.equal(entry.executionSubject.cwd,f.root);assert.equal(f.state.activeSpaceId,'different-visible-workflow');
  const reserve=selectWorkflowReserve(f.state,'w');
  assert.equal(reserve.reserve.some(item=>item.tabId===reservedTabId),true);
  assert.equal(reserve.reserve.some(item=>item.tabId==='existing'),false);
  const outline=workflowReserveOutline(reserve),all=[];
  const visit=nodes=>nodes.forEach(n=>{all.push(n);visit(n.children||[]);});visit(outline);
  assert.ok(all.some(node=>node.tabId===reservedTabId));
  if(placement==='child')assert.equal(all.find(node=>node.tabId===reservedTabId).contextParent?.tabId,'existing');
  assert.equal(bridge.launches.length,1);assert.equal(bridge.launches[0].membership?.workflowId,'w');
  assert.equal(bridge.launches[0].native,true);assert.equal(f.calls.filter(([name])=>name==='workflow:create-tab').length,1);
  const repeat=await bridge.create({projectId:f.ns,sourceTabId:'existing',reservedTabId,toolType:'codex',background:true,startNow:true});
  assert.equal(repeat.ok,false);assert.equal(bridge.launches.length,1);assert.equal(f.writes.length,1);
  f.reopen();assert.equal(f.snapshot.tabs.find(t=>t.tabId===reservedTabId).membership.workflowId,'w');
});

for(const method of ['createTab','createTabAfterCurrent'])test(method+': reserved identity is New; real cold restore still reuses durable subject',async t=>{
  const f=await fixture(t),before=f.calls.filter(([name])=>name==='workflow:create-tab').length;
  assert.equal(before,0,'cold restore never allocates another execution subject');
  const id='reserved-'+method;
  assert.equal(await f.state[method](f.ns,'Reserved',f.root,{background:true,reservedTabId:id,sourceTabId:'existing'}),id);
  assert.equal(f.snapshot.tabs.find(t=>t.tabId===id)?.executionSubject?.version,2);
  assert.equal(f.calls.filter(([name])=>name==='workflow:create-tab').length,1);
  const beforeRetry=f.calls.length;
  await assert.rejects(f.state[method](f.ns,'Duplicate',f.root,{background:true,reservedTabId:id}),/reserved target tab already exists/);
  await assert.rejects(f.state[method](f.ns,'Ambiguous',f.root,{background:true,reservedTabId:'other',restoreId:id}),/tab_creation_identity_conflict/);
  assert.equal(f.calls.length,beforeRetry);
});

test('reserved fork creation options still allocate a new subject in the visual parent workflow',async t=>{
  const f=await fixture(t);agentBridge(f);
  const declaration=find(appTree,n=>ts.isVariableDeclaration(n)&&n.name.getText(appTree)==='createOptions'
    && n.initializer?.getText(appTree).includes('commandType: provider'));
  const options=vm.runInNewContext(transformSync('module.exports='+declaration.initializer.getText(appTree),{loader:'ts',format:'cjs'}).code+';module.exports;',{
    module:{exports:{}},provider:'codex',options:{background:true},reservedTabId:'reserved-fork',requestedParentId:'existing',
    fromLatestCompact:true,launchSessionId:'synthetic-fork-session'});
  const id=await f.state.createTabAfterCurrent(f.ns,'Fork',f.root,options);
  assert.equal(id,'reserved-fork');assert.equal(f.snapshot.tabs.find(t=>t.tabId===id)?.membership?.workflowId,'w');
  assert.equal(f.workspace.tabs.get(id).codexSessionId,'synthetic-fork-session');
  assert.equal(f.workspace.tabs.get(id).visualParentTabId,'existing');
});

test('cancelled reserved New never publishes into Reserve or launches provider',async t=>{
  const f=await fixture(t);agentBridge(f);
  const id=await f.newTab({reservedTabId:'cancel-reserved',sourceTabId:'existing',canPublish:()=>false});
  assert.equal(id,'');assert.equal(f.workspace.tabs.has('cancel-reserved'),false);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:'cancel-reserved'}),null);
  assert.equal(selectWorkflowReserve(f.state,'w').reserve.some(item=>item.tabId==='cancel-reserved'),false);
});
