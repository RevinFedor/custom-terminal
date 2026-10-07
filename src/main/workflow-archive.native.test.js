'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const DatabaseManager=require('./database');
const {createWorkflowOrganizationApi}=require('./workflow-organization-api');
const {TabHistoryRestoreLeases}=require('./tab-history-restore-leases');
const {ConversationOwners}=require('./conversation-owner');
const {runSaveTabsBatchWithAck}=require('./save-tabs-ack');
const {GLOBAL_EXECUTION_NAMESPACE: NS}=require('../shared/workflow-organization.cjs');

function fixture(t,{legacy=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-workflow-archive-native-'));
  const db=new Database(path.join(root,'fixture.db'));db.pragma('foreign_keys=ON');
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);});
  const database=new DatabaseManager({existingConnection:db});database.initTables();
  if(legacy) {
    for(const namespace of ['P','Q'])db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run(namespace,root,namespace);
    db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,codex_session_id) VALUES(?,?,?,?,?,?)')
      .run('P','legacy-owner','Legacy owner',root,'codex','writer');
    db.prepare("INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,file_path,visual_parent_tab_id) VALUES('Q','legacy-file','file',?,'file',?,'legacy-owner')")
      .run(root,path.join(root,'legacy.bin'));
    fs.writeFileSync(path.join(root,'legacy.bin'),Buffer.from([0,1,255]));
  }
  const api=createWorkflowOrganizationApi({database});
  api.bootstrap({workspace:{activeSpaceId:'a',spaces:[{id:'a',name:'Work',projectIds:legacy?['P','Q']:[],layout:{splitPanes:[]}}]},migrationId:'migration',mutationId:'activate'});
  const leases=new TabHistoryRestoreLeases({getLatest:ns=>database.getLatestTabHistory(ns),
    getById:(id,ns)=>database.getTabHistoryEntry(id,ns),deleteById:id=>database.deleteTabHistoryEntry(id),
    token:()=>require('node:crypto').randomUUID()});api.archive.bindLeases(leases);
  const create=(tabId,record={},sourceTabId)=>api.createTab({mutationId:'create:'+tabId,tabId,cwd:root,workflowId:'a',record,sourceTabId});
  return {root,db,database,api,leases,create};
}

test('public v2 address: no Project, actual provider CAS, membership move preserves owner but real cwd invalidates it',t=>{
  const f=fixture(t);const created=f.create('owner',{name:'Owner',commandType:'codex',codexSessionId:'SID'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get().n,0);
  assert.equal(f.db.prepare('SELECT project_id FROM tabs WHERE tab_id=?').get('owner').project_id,null);
  assert.equal(f.database.getTabCodexSessionId(NS,'owner'),'SID');
  assert.equal(f.database.compareAndSetTabCodexSessionId(NS,'owner','SID','SID2'),true);
  assert.equal(f.database.compareAndSetTabCodexSessionId('foreign','owner','SID2','BAD'),false);
  const capture=()=>{const scope=f.api.execution('owner').scope;return {known:true,provider:'codex',projectId:NS,
    cwd:scope.cwd,sessionId:'SID2',executionScope:scope,launchId:'L',instanceId:'M',terminalId:'PTY',runSeq:1};};
  const owners=new ConversationOwners({db:f.database,capture});owners.current('owner');
  const before=f.database.getAppState('conversation-owner.v1:owner');
  f.api.service.moveTab({mutationId:'move',expectedRevision:f.api.service.getPublication().revision,
    tabId:'owner',workflowId:'__noted_workflow_inbox__',expectedMembershipRevision:1});owners.current('owner');
  assert.equal(f.database.getAppState('conversation-owner.v1:owner').token,before.token);
  const row=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'});
  f.database.saveExecutionTabV2({executionNamespace:NS,tabId:'owner',subjectId:created.executionSubject.subjectId,
    expectedRevision:row.revision,columns:{cwd:path.join(f.root,'actual-new-cwd')}});owners.current('owner');
  assert.notEqual(f.database.getAppState('conversation-owner.v1:owner').token,before.token);
});

test('owner close/restore restores exact typed direct/file subtree, all bytes and future columns; AI child remains separate',t=>{
  const f=fixture(t);f.db.exec('ALTER TABLE tabs ADD COLUMN future_file_blob BLOB; ALTER TABLE tabs ADD COLUMN derived_name TEXT GENERATED ALWAYS AS(name||\'!\') VIRTUAL');
  f.create('owner',{name:'Owner',commandType:'codex',codexSessionId:'writer'});
  for(const [id,parent,type] of [['file1','owner','file'],['file2','file1','file'],['ai','owner','terminal'],['ai-file','ai','file']]) {
    fs.writeFileSync(path.join(f.root,id+'.bin'),Buffer.from([0,255,7]));
    f.create(id,{name:id,tabType:type,visualParentTabId:parent,filePath:path.join(f.root,id+'.bin')},'owner');
  }
  f.db.prepare('UPDATE tabs SET future_file_blob=? WHERE tab_id=?').run(Buffer.from([255,0]),'file1');
  const historyId=f.database.archiveTab(NS,{tabId:'owner',name:'Latest owner',notes:'Unsaved close note',
    restorePlacement:{version:1,id:'owner-layout',closedOrder:901,window:{spaceId:'a',windowId:'window'}}},
    {sourceTabId:'owner',codexWriterSessionId:'writer'});
  assert.deepEqual(f.api.archivedFileLinks.read(historyId).files.map(row=>row.tab_id).sort(),['file1','file2']);
  const row=f.database.getTabHistoryEntry(historyId,NS);assert.equal(row.name,'Latest owner');
  assert.equal(JSON.parse(row.restore_placement).window.windowId,'window');
  assert.equal(f.database.getLatestWindowTabHistory({spaceId:'a',windowId:'window',projectIds:[NS]}).project_id,NS);
  const remaining=f.database.getExecutionNamespace(NS).tabs.filter(tab=>!['file1','file2'].includes(tab.tabId));
  f.database.saveTabs(NS,remaining,true);
  const lease=f.api.archive.beginRestore({projectId:NS,id:historyId});assert.equal(lease.ok,true);
  const request={namespace:NS,historyId,leaseToken:lease.token};
  assert.throws(()=>f.api.archive.restoreExecution({...request,leaseToken:'foreign'}),/token_mismatch/);
  const restored=f.api.archive.restoreExecution(request);assert.equal(restored.tabId,'owner');
  assert.throws(()=>f.api.archive.finishRestore({projectId:NS,id:historyId,token:lease.token,commit:true}),/file_manifest_restore_incomplete/);
  assert.ok(f.database.getTabHistoryEntry(historyId,NS));
  assert.throws(()=>f.api.archive.restoreFiles({...request,ownerTabId:'owner',manifestHash:'bad'}),/file_manifest_owner_changed/);
  const links=f.api.archive.restoreFiles({...request,ownerTabId:'owner',manifestHash:lease.entry.attachmentManifest.hash});
  assert.deepEqual(links.restoredFileIds.sort(),['file1','file2']);
  assert.deepEqual(f.db.prepare('SELECT future_file_blob FROM tabs WHERE tab_id=?').get('file1').future_file_blob,Buffer.from([255,0]));
  assert.equal(f.api.archive.restoreExecution(request).tabId,'owner','lost ACK repeats one native restore');
  assert.equal(f.api.archive.finishRestore({projectId:NS,id:historyId,token:lease.token,commit:true}).committed,true);
  assert.equal(f.database.getTabHistoryEntry(historyId,NS),undefined);
  for(const id of ['ai','ai-file','file1','file2']) {
    assert.equal(f.database.getExecutionTabV2({executionNamespace:NS,tabId:id}).archived,false);
    assert.deepEqual(fs.readFileSync(path.join(f.root,id+'.bin')),Buffer.from([0,255,7]));
  }
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});

test('legacy close purges file row yet ordinary undo rebinds that exact file to reserved fresh runtime owner',t=>{
  const f=fixture(t,{legacy:true});
  const historyId=f.database.archiveTab('P',{tabId:'legacy-owner',name:'Legacy owner',cwd:f.root,commandType:'codex'}, {sourceTabId:'legacy-owner',codexWriterSessionId:'writer'});
  f.db.prepare('DELETE FROM tabs WHERE tab_id IN (?,?)').run('legacy-owner','legacy-file');
  const lease=f.api.archive.beginRestore({projectId:'P',id:historyId});assert.equal(lease.ok,true);
  assert.notEqual(lease.entry.restoreTargetTabId,'legacy-owner');
  const newId=lease.entry.restoreTargetTabId;
  assert.equal(f.database.saveTabs('P',[{tabId:newId,name:lease.entry.name,notes:lease.entry.notes || '',cwd:f.root,commandType:'codex',codexSessionId:'writer'}],true)?.success !== false,true);
  const restored=f.api.archive.restoreFiles({namespace:'P',historyId,ownerTabId:newId,manifestHash:lease.entry.attachmentManifest.hash,leaseToken:lease.token});
  assert.deepEqual(restored.restoredFileIds,['legacy-file']);
  const file=f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('legacy-file');
  assert.equal(file.project_id,'Q');assert.equal(file.visual_parent_tab_id,newId);
  assert.equal(f.api.archive.finishRestore({projectId:'P',id:historyId,token:lease.token,commit:true}).committed,true);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'legacy.bin')),Buffer.from([0,1,255]));
});

test('global archive actions keep exact pre-ID address, CAS and same-ID favorite creation',t=>{
  const f=fixture(t,{legacy:true});
  const id=Number(f.db.prepare("INSERT INTO tab_history(project_id,name,cwd,notes) VALUES('P','Pre-ID',?,'keep')").run(f.root).lastInsertRowid);
  const snapshot=f.api.archive.read();const row=snapshot.history.find(row=>row.id===id);
  const request={version:1,requestId:'favorite',namespace:'P',historyId:id,expectedRevision:snapshot.revision,record:row};
  const receipt=f.api.archive.mutate('add-favorite',request);assert.equal(receipt.success,true);
  assert.deepEqual(f.api.archive.mutate('add-favorite',request),receipt);
  assert.throws(()=>f.api.archive.mutate('delete-history',{...request,requestId:'stale'}),/archive_revision_changed/);
  const refreshed=f.api.archive.read(),favorite=refreshed.favorites.find(row=>row.id===receipt.favoriteId);
  const open={version:1,requestId:'open',namespace:'P',favoriteId:favorite.id,record:favorite,expectedRevision:refreshed.revision,targetWorkflowId:'a'};
  const created=f.api.archive.mutate('open-favorite',open,f.api.createTab);
  assert.deepEqual(f.api.archive.mutate('open-favorite',open,f.api.createTab),created);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tabs WHERE execution_subject_version=2').get().n,1);
  assert.equal(f.api.service.getMembership(created.tabId).workflowId,'a');
  assert.throws(()=>f.api.archive.mutate('open-favorite',{...open,targetWorkflowId:'foreign'},f.api.createTab),/archive_request_id_conflict/);
});

function grouped(f) {
  const initial=f.api.groups.read();
  const created=f.api.groups.mutate('create',{version:1,mutationId:'group',expectedRevision:initial.revision,metadata:{name:'Responsibility'}});
  f.create('one',{globalGroupId:created.groupId,name:'One',commandType:'codex',codexSessionId:'writer'});
  f.create('file',{name:'attached',tabType:'file',visualParentTabId:'one',filePath:path.join(f.root,'attached')},'one');
  f.create('two',{globalGroupId:created.groupId,name:'Two',commandType:'codex'});
  const publication=f.api.groups.read(),group=f.api.groups.group(created.groupId);
  return {group,request:{groupId:group.id,intent:{version:1,mutationId:'group-operation',
    expectedRevision:publication.revision,expectedGroupRevision:group.revision},
    members:['one','file','two'].map(tabId=>({tabId,namespace:NS}))}};
}

test('group move publishes the entire captured family atomically and preserves native subject/writer',t=>{
  const f=fixture(t),g=grouped(f);
  const previous=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'one'});
  const request={...g.request,kind:'move',workflowId:'__noted_workflow_inbox__'};
  const receipt=f.api.groupActions.begin(request);
  assert.equal(receipt.success,true);
  for(const id of ['one','file','two'])assert.equal(f.api.service.getMembership(id).workflowId,'__noted_workflow_inbox__');
  assert.equal(f.database.getExecutionTabV2({executionNamespace:NS,tabId:'one'}).revision,previous.revision);
  assert.equal(f.database.getTabCodexSessionId(NS,'one'),'writer');
  assert.deepEqual(f.api.groupActions.begin(request),receipt);
  assert.throws(()=>f.api.groupActions.begin({...request,workflowId:'a'}),/group_action_id_conflict/);
});

test('frozen group close requires exact guard, rejects a later writer, and ACKs already cascaded files without a second close',t=>{
  const f=fixture(t),g=grouped(f),request={...g.request,kind:'close'};
  f.api.groupActions.begin(request);
  const checked=f.api.groupActions.step({mutationId:g.request.intent.mutationId,tabId:'one'});
  f.api.groupActions.assertCloseGuard(checked.closeGuard);
  f.database.archiveTab(NS,{tabId:'one',name:'One'}, {sourceTabId:'one',codexWriterSessionId:'writer'});
  f.database.saveTabs(NS,f.database.getExecutionNamespace(NS).tabs.filter(tab=>tab.tabId!=='file'),true);
  assert.equal(f.api.groupActions.ack({mutationId:g.request.intent.mutationId,tabId:'one'}).completed,true);
  assert.equal(f.api.groupActions.step({mutationId:g.request.intent.mutationId,tabId:'file'}).completed,true);
  f.database.updateTabCodexSessionId(NS,'two','new-writer');
  assert.throws(()=>f.api.groupActions.step({mutationId:g.request.intent.mutationId,tabId:'two'}),/group_close_execution_changed/);
  assert.equal(f.database.getExecutionTabV2({executionNamespace:NS,tabId:'two'}).archived,false);
});

test('per-tab source inheritance preserves exact legacy roots; explicit empty binding never falls back to a namespace union',t=>{
  const f=fixture(t,{legacy:true});
  // A registration is independent of tab cwd. Selecting it is an explicit
  // per-tab operation, then subsequent child creation inherits this binding.
  const source=f.api.roots.save({mutationId:'root',expectedRevision:f.api.roots.read().revision,path:f.root,name:'Docs',kind:'prompt-source'});
  f.api.roots.setTabSources({mutationId:'sources',expectedRevision:f.api.roots.read().revision,tabId:'legacy-owner',rootIds:[source.id]});
  f.create('child',{name:'Child'},'legacy-owner');
  assert.deepEqual(f.api.roots.sourcesForTab('child').map(root=>root.rootId),[source.id]);
  f.api.roots.setTabSources({mutationId:'empty-sources',expectedRevision:f.api.roots.read().revision,tabId:'child',rootIds:[]});
  f.create('grandchild',{name:'Grandchild'},'child');
  assert.deepEqual(f.api.roots.sourcesForTab('grandchild'),[]);
  assert.equal(f.database.getExecutionTabV2({executionNamespace:'P',tabId:'child'}).tab.cwd,f.root);
  f.db.prepare('UPDATE workflow_root_meta SET version=2').run();
  assert.throws(()=>f.api.roots.save({mutationId:'root',expectedRevision:0,path:f.root,name:'Docs',kind:'prompt-source'}),/root_forward_version/);
  assert.equal(f.api.roots.read().version,2);
});

test('independent namespace keeps saved export/response bytes without manufacturing a Project or writer',t=>{
  const f=fixture(t);f.create('owner',{name:'Owner'});
  const id=f.database.saveAISession(NS,'claude','saved','original bytes',f.root,'saved-SID');
  assert.equal(f.database.saveAISession(NS,'claude','saved','updated bytes',f.root,'saved-SID'),id);
  const response=f.database.saveGeminiHistory(NS,'selection','prompt','response');
  const exports=f.database.getAISessions(NS,'claude');assert.equal(exports.length,1);
  assert.equal(exports[0].content_blob,'updated bytes');assert.equal(exports[0].original_hash,'saved-SID');
  assert.equal(exports[0].project_id,NS);assert.equal(JSON.parse(exports[0].workflow_context_json).kind,'session-export');
  assert.equal(f.database.getGeminiHistory(NS)[0].id,response.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tabs').get().n,1);
  assert.equal(f.database.getTabClaudeSessionId(NS,'owner'),null);
});

test('selecting an older close restores its exact snapshot; stale first lease cannot reactivate a later closed writer',t=>{
  const f=fixture(t);f.create('owner',{name:'First',commandType:'codex',codexSessionId:'first-SID'});
  const storageId=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'}).row.id;
  const first=f.database.archiveTab(NS,{tabId:'owner',name:'First',notes:'first snapshot'}, {sourceTabId:'owner',codexWriterSessionId:'first-SID'});
  const lease=f.api.archive.beginRestore({projectId:NS,id:first});
  f.api.archive.restoreExecution({namespace:NS,historyId:first,leaseToken:lease.token});
  f.database.updateTabCodexSessionId(NS,'owner','later-SID');
  const later=f.database.archiveTab(NS,{tabId:'owner',name:'Later',notes:'later snapshot'}, {sourceTabId:'owner',codexWriterSessionId:'later-SID'});
  assert.throws(()=>f.api.archive.restoreExecution({namespace:NS,historyId:first,leaseToken:lease.token}),/archive_restored_owner_changed/);
  f.api.archive.finishRestore({projectId:NS,id:first,token:lease.token,commit:false});
  const chosen=f.api.archive.beginRestore({projectId:NS,id:first});assert.equal(chosen.ok,true);
  f.api.archive.restoreExecution({namespace:NS,historyId:first,leaseToken:chosen.token});
  const restored=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'});
  assert.equal(restored.row.id,storageId);assert.equal(restored.tab.notes,'first snapshot');
  assert.equal(restored.tab.codexSessionId,'first-SID');
  assert.equal(f.api.archive.finishRestore({projectId:NS,id:first,token:chosen.token,commit:true}).committed,true);
  assert.ok(f.database.getTabHistoryEntry(later,NS),'another exact archive stays available');
});

test('native nullable collection columns keep the legacy optional-array DTO across create/read/archive/restore',t=>{
  const f=fixture(t);f.create('owner',{name:'Owner'});
  const empty=f.database.getProjectById(NS).tabs.find(tab=>tab.tabId==='owner');
  for(const key of ['restartAfterWorkflowIds','restartAfterTabIds','claudeSessionHistory'])assert.equal(empty[key],undefined);
  assert.equal(f.db.prepare('SELECT restart_after_workflow_ids FROM tabs WHERE tab_id=?').get('owner').restart_after_workflow_ids,null);
  const current=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'});
  f.database.saveExecutionTabV2({executionNamespace:NS,tabId:'owner',subjectId:current.executionSubject.subjectId,
    expectedRevision:current.revision,record:{restartAfterWorkflowIds:['a'],restartAfterTabIds:['x']}});
  const read=f.database.getProjectById(NS).tabs.find(tab=>tab.tabId==='owner');
  assert.deepEqual(read.restartAfterWorkflowIds,['a']);assert.deepEqual(read.restartAfterTabIds,['x']);
  f.create('history-owner',{name:'History owner',claudeSessionHistory:[{sessionId:'saved'}]});
  assert.deepEqual(f.database.getProjectById(NS).tabs.find(tab=>tab.tabId==='history-owner').claudeSessionHistory,[{sessionId:'saved'}]);
});

test('standalone file group close has an atomic guard/proof even with its owner outside the group',t=>{
  const f=fixture(t);f.create('owner',{name:'Outside'});
  const group=f.api.groups.mutate('create',{version:1,mutationId:'file-group',expectedRevision:f.api.groups.read().revision,metadata:{name:'File-only'}});
  const file=path.join(f.root,'kept.txt');fs.writeFileSync(file,'kept');
  f.create('file',{name:'File',tabType:'file',visualParentTabId:'owner',filePath:file,globalGroupId:group.groupId},'owner');
  const request={kind:'close',groupId:group.groupId,members:[{tabId:'file',namespace:NS}],intent:{version:1,mutationId:'file-close',
    expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(group.groupId).revision}};
  f.api.groupActions.begin(request);const step=f.api.groupActions.step({mutationId:'file-close',tabId:'file'});
  const snapshots=[{projectId:NS,expectedTabIds:f.database.getProjectTabIds(NS),tabs:f.database.getExecutionNamespace(NS).tabs.filter(tab=>tab.tabId!=='file')}];
  const commit=guard=>runSaveTabsBatchWithAck({snapshots,transaction:fn=>f.db.transaction(fn),getTabIds:ns=>f.database.getProjectTabIds(ns),
    save:row=>f.database.saveTabs(row.projectId,row.tabs,true),
    beforeSave:rows=>f.api.groupActions.prepareFileClose(guard,rows),afterSave:proof=>f.api.groupActions.finishFileClose(proof)});
  assert.equal(commit({...step.closeGuard,guardToken:'wrong'}).success,false);
  assert.equal(f.database.getExecutionTabV2({executionNamespace:NS,tabId:'file'}).archived,false);
  assert.equal(commit(step.closeGuard).success,true);
  assert.equal(f.api.groupActions.ack({mutationId:'file-close',tabId:'file'}).completed,true);
  assert.equal(f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'}).archived,false);
  assert.equal(fs.readFileSync(file,'utf8'),'kept');assert.equal(f.database.getTabHistory(NS).length,0);
});

test('F1: edited archive metadata and empty notes survive restore; partial retry preserves later live edits and exact consume receipt',t=>{
  const f=fixture(t);f.create('owner',{name:'A',notes:'N0',commandType:'codex',codexSessionId:'SID'});
  const pk=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'}).row.id;
  const h=f.database.archiveTab(NS,{tabId:'owner',name:'A',notes:'N0'},{sourceTabId:'owner',codexWriterSessionId:'SID'});
  f.database.updateTabHistoryTitle(h,'B',true);f.db.prepare('UPDATE tab_history SET notes=? WHERE id=?').run('N1',h);
  let lease=f.api.archive.beginRestore({projectId:NS,id:h});
  f.api.archive.restoreExecution({namespace:NS,historyId:h,leaseToken:lease.token});
  let row=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'});
  assert.equal(row.tab.name,'B');assert.equal(row.tab.notes,'N1');assert.equal(row.row.id,pk);assert.equal(row.tab.codexSessionId,'SID');
  f.api.archive.finishRestore({projectId:NS,id:h,token:lease.token,commit:false});
  f.db.prepare('UPDATE tab_history SET notes=? WHERE id=?').run('',h);
  lease=f.api.archive.beginRestore({projectId:NS,id:h});
  assert.throws(()=>f.api.archive.finishRestore({projectId:NS,id:h,token:lease.token,commit:true}),/metadata_transfer_unconfirmed/);
  f.api.archive.synchronizeMetadata({namespace:NS,historyId:h,ownerTabId:'owner',leaseToken:lease.token,expectedLiveMetadata:{name:'B',notes:'N1',nameSetManually:true}});
  row=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'});assert.equal(row.tab.notes,'');
  const finish={projectId:NS,id:h,token:lease.token,commit:true};const receipt=f.api.archive.finishRestore(finish);
  assert.equal(receipt.committed,true);assert.deepEqual(f.api.archive.finishRestore(finish),receipt,'lost finish ACK replays durable receipt');
  assert.equal(f.database.getTabHistoryEntry(h,NS),undefined);
});

test('F1: conflicting live/archive note edits retain both versions without silently consuming the archive',t=>{
  const f=fixture(t);f.create('owner',{name:'A',notes:'base'});
  const h=f.database.archiveTab(NS,{tabId:'owner',name:'A',notes:'base'},{sourceTabId:'owner'});
  let lease=f.api.archive.beginRestore({projectId:NS,id:h});f.api.archive.restoreExecution({namespace:NS,historyId:h,leaseToken:lease.token});
  f.api.archive.finishRestore({projectId:NS,id:h,token:lease.token,commit:false});
  const row=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'});
  f.database.saveExecutionTabV2({executionNamespace:NS,tabId:'owner',subjectId:row.executionSubject.subjectId,expectedRevision:row.revision,record:{notes:'live edit'}});
  f.db.prepare('UPDATE tab_history SET notes=? WHERE id=?').run('archive edit',h);
  lease=f.api.archive.beginRestore({projectId:NS,id:h});
  assert.throws(()=>f.api.archive.synchronizeMetadata({namespace:NS,historyId:h,ownerTabId:'owner',leaseToken:lease.token,
    expectedLiveMetadata:{name:'A',notes:'live edit',nameSetManually:false}}),/archive_metadata_conflict/);
  assert.equal(f.database.getExecutionTabV2({executionNamespace:NS,tabId:'owner'}).tab.notes,'live edit');
  assert.equal(f.database.getTabHistoryEntry(h,NS).notes,'archive edit');
});

test('F2: mixed namespace force cleanup deletes last v1 while retaining exact v2 storage/subject/SID; ordinary omission preserves v1',t=>{
  const f=fixture(t,{legacy:true});f.api.createTab({mutationId:'mixed',tabId:'V',cwd:f.root,workflowId:'a',executionNamespace:'P',record:{name:'V',codexSessionId:'V-SID'}});
  let v=f.database.getExecutionTabV2({executionNamespace:'P',tabId:'V'}),pk=v.row.id;
  f.database.saveTabs('P',[v.tab],false);
  assert.ok(f.db.prepare("SELECT 1 FROM tabs WHERE tab_id='legacy-owner'").get());
  v=f.database.getExecutionTabV2({executionNamespace:'P',tabId:'V'});f.database.saveTabs('P',[v.tab],true);
  assert.equal(f.db.prepare("SELECT 1 FROM tabs WHERE tab_id='legacy-owner'").get(),undefined);
  v=f.database.getExecutionTabV2({executionNamespace:'P',tabId:'V'});
  assert.equal(v.row.id,pk);assert.equal(v.tab.codexSessionId,'V-SID');assert.equal(v.archived,false);
});

test('R1: first v1 restore baseline survives release before metadata sync, restart, empty notes and conflicting live edits',t=>{
  const f=fixture(t,{legacy:true});
  for(const [index,note,liveEdit] of [[0,'N1',null],[1,'',null],[2,'archive edit','live edit']]) {
    const source='v1-'+index;
    f.db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,notes) VALUES(?,?,?,?,?)').run('P',source,'A',f.root,'N0');
    const id=f.database.archiveTab('P',{tabId:source,name:'A',notes:'N0',cwd:f.root},{sourceTabId:source});
    f.db.prepare('DELETE FROM tabs WHERE tab_id=?').run(source);
    let lease=f.api.archive.beginRestore({projectId:'P',id});const target=lease.entry.restoreTargetTabId;
    f.db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,notes) VALUES(?,?,?,?,?)').run('P',target,'A',f.root,'N0');
    f.api.archive.finishRestore({projectId:'P',id,token:lease.token,commit:false});
    f.db.prepare('UPDATE tab_history SET notes=? WHERE id=?').run(note,id);
    if(liveEdit)f.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run(liveEdit,target);
    const fresh=createWorkflowOrganizationApi({database:f.database});
    fresh.archive.bindLeases(new TabHistoryRestoreLeases({getLatest:ns=>f.database.getLatestTabHistory(ns),
      getById:(id,ns)=>f.database.getTabHistoryEntry(id,ns),deleteById:id=>f.database.deleteTabHistoryEntry(id),token:()=>require('node:crypto').randomUUID()}));
    lease=fresh.archive.beginRestore({projectId:'P',id});assert.equal(lease.replacement.tabId,target);
    const sync=()=>fresh.archive.synchronizeMetadata({namespace:'P',historyId:id,ownerTabId:target,leaseToken:lease.token,
      expectedLiveMetadata:{name:'A',notes:liveEdit || 'N0',nameSetManually:false}});
    if(liveEdit) {
      assert.throws(sync,/metadata_conflict/);assert.equal(f.database.getTabHistoryEntry(id,'P').notes,note);
      assert.equal(f.db.prepare('SELECT notes FROM tabs WHERE tab_id=?').get(target).notes,liveEdit);
    } else {
      sync();assert.equal(f.db.prepare('SELECT notes FROM tabs WHERE tab_id=?').get(target).notes,note);
      assert.equal(fresh.archive.finishRestore({projectId:'P',id,token:lease.token,commit:true}).committed,true);
      assert.equal(f.database.getTabHistoryEntry(id,'P'),undefined);
    }
  }
});

test('OSC cwd point receipt: same cwd is durable without a revision bump; actual change keeps exact subject and CAS before/after',t=>{
  const f=fixture(t);f.create('cwd-owner',{name:'Owner'});
  const before=f.database.getExecutionTabV2({executionNamespace:NS,tabId:'cwd-owner'});
  const same=f.database.updateProvenTabCwd('cwd-owner',f.root);
  assert.equal(same.persisted,true);assert.equal(same.executionReceipt.fromRevision,before.revision);
  assert.equal(same.executionReceipt.toRevision,before.revision);assert.equal(f.database.updateTabCwd('cwd-owner',f.root),true);
  const changed=f.database.updateProvenTabCwd('cwd-owner',path.join(f.root,'actual-cwd'));
  assert.equal(changed.executionReceipt.fromRevision,before.revision);assert.equal(changed.executionReceipt.toRevision,before.revision+1);
  assert.equal(changed.executionReceipt.subjectId,before.executionSubject.subjectId);
  assert.equal(changed.executionReceipt.executionSubject.cwd,path.join(f.root,'actual-cwd'));
  assert.equal(f.database.updateProvenTabCwd('missing',f.root).persisted,false);
});

test('F3/C1: frozen standalone file family rejects reparent/type/extra omission and parent-first completion proves every member',t=>{
  const f=fixture(t);f.create('owner',{name:'Outside'});
  const g=f.api.groups.mutate('create',{version:1,mutationId:'G',expectedRevision:f.api.groups.read().revision,metadata:{name:'Files'}});
  for(const [id,parent] of [['F','owner'],['C','F'],['D','C']])f.create(id,{name:id,tabType:'file',visualParentTabId:parent,filePath:path.join(f.root,id),globalGroupId:g.groupId},'owner');
  f.api.groupActions.begin({kind:'close',groupId:g.groupId,members:['F','C','D'].map(tabId=>({tabId,namespace:NS})),
    intent:{version:1,mutationId:'close-files',expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(g.groupId).revision}});
  const step=f.api.groupActions.step({mutationId:'close-files',tabId:'F'});
  const snapshots=[{projectId:NS,expectedTabIds:f.database.getProjectTabIds(NS),tabs:f.database.getExecutionNamespace(NS).tabs.filter(tab=>!['F','C','D'].includes(tab.tabId))}];
  f.db.prepare("UPDATE tabs SET visual_parent_tab_id='owner' WHERE tab_id='C'").run();
  assert.throws(()=>f.api.groupActions.prepareFileClose(step.closeGuard,snapshots),/family_changed/);
  f.db.prepare("UPDATE tabs SET visual_parent_tab_id='F' WHERE tab_id='C'").run();
  assert.throws(()=>f.api.groupActions.prepareFileClose(step.closeGuard,snapshots),/family_changed/,'revision proof rejects undo of a foreign mutation');
  // A fresh explicit intent captures the changed generation, then negative
  // extra-omission control verifies the reverse subset at the SQL boundary.
  const request={kind:'close',groupId:g.groupId,members:['F','C','D'].map(tabId=>({tabId,namespace:NS})),
    intent:{version:1,mutationId:'new-close-files',expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(g.groupId).revision}};
  f.api.groupActions.begin(request);const fresh=f.api.groupActions.step({mutationId:'new-close-files',tabId:'F'});
  assert.throws(()=>f.api.groupActions.prepareFileClose(fresh.closeGuard,[{...snapshots[0],tabs:[]}]),/outside_family/);
  const updated=[{...snapshots[0],tabs:f.database.getExecutionNamespace(NS).tabs.filter(tab=>!['F','C','D'].includes(tab.tabId))}];
  const result=runSaveTabsBatchWithAck({snapshots:updated,transaction:fn=>f.db.transaction(fn),getTabIds:ns=>f.database.getProjectTabIds(ns),
    save:row=>f.database.saveTabs(row.projectId,row.tabs,true),beforeSave:rows=>f.api.groupActions.prepareFileClose(fresh.closeGuard,rows),afterSave:proof=>f.api.groupActions.finishFileClose(proof)});
  assert.equal(result.success,true);
  for(const tabId of ['F','C','D'])assert.equal(f.api.groupActions.step({mutationId:'new-close-files',tabId}).completed,true);
});

test('C2: archive replay after file cleanup returns the same frozen manifest/history; future root inheritance keeps version opaque',t=>{
  const f=fixture(t);f.create('owner',{name:'Owner'});f.create('file',{name:'File',tabType:'file',visualParentTabId:'owner',filePath:path.join(f.root,'file')},'owner');
  const h=f.database.archiveTab(NS,{tabId:'owner',name:'Owner'},{sourceTabId:'owner'});const manifest=f.api.archivedFileLinks.read(h);
  f.database.saveTabs(NS,[],true);
  assert.equal(f.database.archiveTab(NS,{tabId:'owner',name:'Owner'},{sourceTabId:'owner'}),h);
  assert.equal(f.api.archivedFileLinks.read(h).hash,manifest.hash);
  f.db.prepare("UPDATE workflow_root_scope_meta SET version=2 WHERE scope='tab:owner'").run();
  f.create('future-child',{name:'Future child'},'owner');
  assert.equal(f.db.prepare("SELECT version FROM workflow_root_scope_meta WHERE scope='tab:future-child'").get().version,2);
  assert.throws(()=>f.api.roots.sourcesForTab('future-child'),/forward_version/);
  f.create('unrelated',{name:'Unrelated'});assert.equal(f.api.roots.sourcesForTab('unrelated').length,0);
});

test('F5: frozen whole-namespace clear includes hidden file rows, keeps notes/foreign scope and refuses leases or changed notes',t=>{
  const f=fixture(t,{legacy:true});
  for(const [type,notes] of [['terminal',''],['terminal','keep'],['file','']])f.db.prepare('INSERT INTO tab_history(project_id,name,cwd,tab_type,notes) VALUES(?,?,?,?,?)').run('P',type,f.root,type,notes);
  const foreign=Number(f.db.prepare("INSERT INTO tab_history(project_id,name,cwd) VALUES('Q','foreign',?)").run(f.root).lastInsertRowid);
  let scope=f.api.archive.clearScope('P');
  const req={version:1,requestId:'clear',namespace:'P',kind:'clear-except-notes',historyIds:scope.historyIds,expectedRowsHash:scope.rowsHash};
  f.db.prepare('UPDATE tab_history SET notes=? WHERE id=?').run('changed',scope.historyIds[0]);
  assert.throws(()=>f.api.archive.clearNamespace(req),/scope_changed/);
  scope=f.api.archive.clearScope('P');const lease=f.api.archive.beginRestore({projectId:'P',id:scope.historyIds[0]});
  assert.throws(()=>f.api.archive.clearNamespace({...req,requestId:'leased',historyIds:scope.historyIds,expectedRowsHash:scope.rowsHash}),/restore_busy/);
  f.api.archive.finishRestore({projectId:'P',id:lease.id,token:lease.token,commit:false});
  const accepted={...req,requestId:'accepted',historyIds:scope.historyIds,expectedRowsHash:scope.rowsHash};
  const done=f.api.archive.clearNamespace(accepted);assert.equal(done.deletedIds.length,1);assert.deepEqual(f.api.archive.clearNamespace(accepted),done);
  assert.ok(f.database.getTabHistoryEntry(foreign,'Q'));assert.equal(f.api.archive.clearScope('P').count,2);
});

test('F4: detach and same-workflow moves preserve imported automation eligibility; cross-workflow move replaces it',async t=>{
  const f=fixture(t);f.create('owner',{name:'Owner'});
  const {autoCompactIncludesTarget}=await import('../renderer/utils/autoCompactPolicy.mjs');
  const member=f.api.service.getMembership('owner');
  const policy={allWorkflows:true,workflowIds:[],excludedTabIds:[],includeUnplaced:false,
    migrationEligibility:{owner:{workflowId:member.workflowId,membershipRevision:member.revision,included:false}}};
  const included=()=>{const current=f.api.service.getMembership('owner');return autoCompactIncludesTarget(policy,{provider:'codex',tabId:'owner',workflowId:current.workflowId,membershipRevision:current.revision});};
  assert.equal(included(),false);
  f.api.service.detachTab({mutationId:'detach',expectedRevision:f.api.service.getPublication().revision,tabId:'owner',expectedMembershipRevision:member.revision});
  assert.equal(included(),false);
  f.api.service.moveTab({mutationId:'same',expectedRevision:f.api.service.getPublication().revision,tabId:'owner',workflowId:'a',expectedMembershipRevision:member.revision});
  assert.equal(included(),false);
  f.api.service.moveTab({mutationId:'cross',expectedRevision:f.api.service.getPublication().revision,tabId:'owner',workflowId:'__noted_workflow_inbox__',expectedMembershipRevision:member.revision});
  assert.equal(included(),true);
});
