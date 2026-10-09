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
const PM=vm.runInNewContext(pmTree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='ProjectManager').getText(pmTree)+';ProjectManager');
const quiet={log(){},warn(){},error(){},info(){}};
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture(t,{namespace}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-create-revision-native-')),filename=path.join(root,'private.db');
  let db=new SQLite(filename),manager=new Manager({existingConnection:db});manager.initTables();
  t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});});
  const ns=namespace || manager.createEmptyProject('Private mixed namespace').id;
  let api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
  api.bootstrap({migrationId:'m',mutationId:'m:commit',workspace:{activeSpaceId:'w',spaces:[{id:'w',layout:{},projectIds:[ns]}]}});
  api.createTab({mutationId:'existing-create',tabId:'existing',workflowId:'w',executionNamespace:ns,cwd:root,
    record:{name:'Existing',notes:'preserve user metadata',tabType:'terminal',commandType:'codex',codexSessionId:'same-session'}});
  const workspace={projectId:ns,projectPath:root,tabs:new Map(),tabCounter:0,tabGroups:[],tabHistory:[],activeTabId:'existing'};
  const state={openProjects:new Map([[ns,workspace]]),organizationReady:true,isRestoring:true,splitPanes:[],splitFocusedIndex:0,
    activeSpaceId:'w',organizationRevision:api.read().publication.revision,tabCatalog:{},tabWorkflowMembership:{},
    touchGlobalTabMru(){},clearTerminalBuffer(){}};
  const calls=[],writes=[],module={exports:{}},orgQueue=createProjectTabSaveQueue();
  const mainContext={...ack,validateForceCleanupTabIds,Date,console:quiet,
    get workflowOrganization(){return api;},projectManager:{get db(){return manager;},
      saveProjectTabs:(...args)=>PM.prototype.saveProjectTabs.call({db:manager},...args)},
    _gracefulShutdownInProgress:false,noteProjectCardSignalsChanged(id){state.onSignals?.(id);},tabWorkContext:{syncLinks:async()=>{}}};
  const save=vm.runInNewContext('('+mainSave.arguments[1].getText(mainTree)+')',mainContext);
  const persist=vm.runInNewContext(persistBinding.getText(mainTree)+';persistCodexKnownSessionBinding',{
    projectManager:{get db(){return manager;}},resolveAuthoritativeTabProjectId:()=>ns});
  const useWorkspaceStore={getState:()=>state,setState:patch=>Object.assign(state,patch)};
  const context={module,console:quiet,log:{tabs(){}},crypto:webcrypto,Date,Map,Set,findOpenTabOwner,
    get:()=>state,set:patch=>Object.assign(state,patch),useWorkspaceStore,
    useUIStore:{getState:()=>({newTabPrimarySurface:'history',terminalIsPrimaryTabs:{},setTabTerminalIsPrimary(){},showToast(){}})},
    createExecutionRevisionAcks,createWorkflowRelationReceipts,projectTabSaveQueue:createProjectTabSaveQueue(),
    projectTabCreationQueue:createProjectTabSaveQueue(),projectTabSaveRevisions:new Map(),
    organizationCommitter:{runTask:fn=>orgQueue.enqueue('org',fn)},INBOX_WORKFLOW_ID:'w',
    resolveWorkspaceCwd:value=>value||root,restoreShortId:value=>String(value||''),dndShortId:value=>String(value),
    getNextAvailableName:()=> 'New',resolveExistingTabGroupId:()=>undefined,
    commitCreatedTabSnapshot,resolveSiblingInsertionIndex,resolveTabInsertionIndex,
    ipcRenderer:{send:(...args)=>calls.push(args),invoke:async(channel,payload)=>{
      calls.push([channel,payload]);
      if(channel==='terminal:create')return{pid:123,cwd:payload.cwd};
      if(channel==='workflow:create-tab')return api.createTab(payload);
      if(channel==='workflow:mutation')return api.mutation(payload);
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
  await state.createTab(ns,cold.name,cold.cwd,state.restoreTabOptions(cold));state.isRestoring=false;
  return {root,ns,state,workspace,calls,writes,persist,get db(){return db;},get manager(){return manager;},get snapshot(){return api.read();},
    newTab:options=>state.createTabAfterCurrent(ns,'New Codex',root,{background:true,pendingAction:{type:'codex-new'},...options}),
    reopen(){db.close();db=new SQLite(filename);manager=new Manager({existingConnection:db});api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});},
    row:()=>manager.getExecutionTabV2({executionNamespace:ns,tabId:'existing'})};
}

test('same-SID first-writer settings update reconciles before unrelated New commits exactly once',async t=>{
  const f=await fixture(t),cold=f.workspace.tabs.get('existing'),before=cold.executionStorageRevision;
  assert.equal(f.persist('existing','same-session',{model:'fixture-model',effort:'high',proofAt:700}).success,true);
  assert.equal(f.row().revision,before+1);assert.equal(cold.executionStorageRevision,before);
  const id=await f.newTab();
  assert.ok(id);assert.equal(f.workspace.tabs.has(id),true);assert.equal(f.writes.length,1);
  assert.equal(f.row().tab.codexModel,'fixture-model');assert.equal(f.row().tab.codexSettingsProofAt,700);
  assert.equal(f.row().tab.notes,'preserve user metadata');assert.equal(f.row().tab.codexSessionId,'same-session');
  assert.equal(cold.executionStorageRevision,f.row().revision);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:kill').length,0);
});

test('session-bound context point update also cannot strand an unrelated creation',async t=>{
  const f=await fixture(t),before=f.row().revision;
  assert.equal(f.manager.updateCodexTabContextPctForSession('existing','same-session',43.9),true);
  assert.equal(f.row().revision,before+1);
  const id=await f.newTab();assert.ok(id);assert.equal(f.row().row.context_pct,43.9);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,f.row().revision);
});

test('direct New factory uses the same reconciled durable save as chooser creation',async t=>{
  const f=await fixture(t);f.persist('existing','same-session',{model:'new-model',effort:'high',proofAt:800});
  const id=await f.state.createTab(f.ns,'Direct Codex',f.root,{background:true,pendingAction:{type:'codex-new'}});
  assert.ok(id);assert.equal(f.workspace.tabs.has(id),true);assert.equal(f.writes.length,1);
  assert.equal(f.row().tab.codexModel,'new-model');
  assert.ok(f.writes[0].result.executionReconciliations[0].fields.includes('codex_model'));
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
  const saved=f.row();
  assert.equal(saved.tab.notes,'local unsaved metadata');assert.equal(saved.tab.codexSessionId,'new-session');
  assert.equal(saved.tab.codexModel,'latest-model');assert.equal(saved.tab.codexSettingsProofAt,800);
  assert.equal(saved.row.context_pct,9.1);
  assert.equal(f.workspace.tabs.get('existing').executionStorageRevision,saved.revision);
  assert.equal(f.writes[0].result.executionReconciliations[0].fromRevision,before);
  assert.equal(f.writes[0].result.executionReconciliations[0].toRevision,before+5);
});

test('foreign metadata between points breaks proof and creation rolls back without overwriting it',async t=>{
  const f=await fixture(t);
  f.manager.updateCodexTabContextPctForSession('existing','same-session',10);
  f.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('newer foreign note','existing');
  f.persist('existing','same-session',{model:'latest-model',effort:'high',proofAt:900});
  const revision=f.row().revision;
  await assert.rejects(f.newTab(),/execution_storage_revision_changed/);
  assert.equal(f.row().tab.notes,'newer foreign note');assert.equal(f.row().revision,revision);
  const created=f.calls.filter(([kind])=>kind==='workflow:create-tab').map(([,payload])=>payload.tabId);
  assert.equal(created.length,1);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.ns,tabId:created[0]}),null);
  assert.equal(f.workspace.tabs.has(created[0]),false);
  assert.equal(f.calls.filter(([kind])=>kind==='terminal:kill').length,1);
});

test('compound Main and metadata UPDATE cannot acquire a point-only receipt',async t=>{
  const f=await fixture(t);
  f.db.prepare('UPDATE tabs SET context_pct=20,name=? WHERE tab_id=?').run('foreign name','existing');
  f.manager.updateCodexTabContextPctForSession('existing','same-session',30);
  await assert.rejects(f.newTab(),/execution_storage_revision_changed/);
  assert.equal(f.row().tab.name,'foreign name');
});

for(const mainFirst of [false,true])test('metadata side-effect trigger invalidates point proof regardless of execution order '+mainFirst,async t=>{
  const f=await fixture(t);
  f.db.exec("CREATE TRIGGER foreign_metadata AFTER UPDATE OF context_pct ON tabs BEGIN UPDATE tabs SET notes='foreign side effect' WHERE id=NEW.id; END");
  if(mainFirst){f.db.exec('DROP TRIGGER workflow_tabs_main_field_receipt; DROP TRIGGER workflow_tabs_metadata_receipt_invalidate');f.manager.ensureWorkflowExecutionStorage();}
  f.manager.updateCodexTabContextPctForSession('existing','same-session',20);
  await assert.rejects(f.newTab(),/execution_storage_revision_changed/);
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
  await assert.rejects(f.newTab(),/execution_storage_revision_changed/);
  assert.deepEqual(f.row().row.future_metadata,Buffer.from([0,1,255]));
});

test('case-only metadata changes are conflicts even when a future column uses NOCASE collation',async t=>{
  const f=await fixture(t);
  f.db.exec("ALTER TABLE tabs ADD COLUMN future_label TEXT COLLATE NOCASE DEFAULT 'Alpha'");
  f.manager.ensureWorkflowExecutionStorage();
  f.db.prepare("UPDATE tabs SET context_pct=22,future_label='alpha' WHERE tab_id=?").run('existing');
  await assert.rejects(f.newTab(),/execution_storage_revision_changed/);
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
