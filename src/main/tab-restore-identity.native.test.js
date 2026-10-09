'use strict';
// Actual saved-row reader -> actual cold restore/factory -> actual serializer
// -> SQLite CAS. Only terminal:create is a fake PTY boundary; no process runs.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript'),{transformSync}=require('esbuild'),Database=require('better-sqlite3');
const Manager=require('./database'),{createWorkflowOrganizationApi}=require('./workflow-organization-api');
const source=fs.readFileSync(path.join(__dirname,'../renderer/store/useWorkspaceStore.ts'),'utf8');
const ast=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true),parts={};
const named=new Set(['restoreTabOptions','createBrokenRestoredTab','serializeTabs']);
function visit(node) {
  if(ts.isVariableDeclaration(node)&&named.has(node.name.getText(ast)))parts[node.name.getText(ast)]=node.initializer.getText(ast);
  if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='createTab')parts.createTab=node.initializer.getText(ast);
  ts.forEachChild(node,visit);
}visit(ast);
assert.equal(Object.keys(parts).length,4);
const code=transformSync('module.exports={'+Object.entries(parts).map(([name,body])=>name+':'+body).join(',')+'}',{loader:'ts',format:'cjs'}).code;
for(const type of ['file','terminal','claude-sdk'])test('cold '+type+' preserves exact saved subject/revision through factory and SQLite',async t=>{
  const db=new Database(':memory:');t.after(()=>db.close());const manager=new Manager({existingConnection:db});manager.initTables();
  const api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
  api.bootstrap({migrationId:'m',mutationId:'m:commit',workspace:{activeSpaceId:'w',spaces:[{id:'w',layout:{},projectIds:[]}]}});
  api.createTab({mutationId:'create',tabId:'saved',workflowId:'w',cwd:'/fixture',record:{name:'saved',tabType:type,
    filePath:type==='file'?'/fixture/test.md':undefined,parentTabId:type==='terminal'?'physical-owner':null,visualParentTabId:'owner',codexSessionId:'existing-sid'}});
  const ns='__tab_catalog_v2__',saved=manager.getProjectById(ns).tabs.find(tab=>tab.tabId==='saved');
  const workspace={projectId:ns,projectPath:'/fixture',tabs:new Map(),tabCounter:0};
  const state={openProjects:new Map([[ns,workspace]]),organizationReady:true,isRestoring:true,splitPanes:[],splitFocusedIndex:0};
  const module={exports:{}},calls=[];
  vm.runInNewContext(code,{module,console:{log(){},warn(){},error(){}},log:{tabs(){}},get:()=>state,
    useUIStore:{getState:()=>({newTabPrimarySurface:'history',terminalIsPrimaryTabs:{},setTabTerminalIsPrimary(){}})},
    getNextAvailableName:()=> 'tab',findOpenTabOwner:()=>null,resolveWorkspaceCwd:value=>value,restoreShortId:value=>String(value),
    allocateOrganizationTab:async(_namespace,tab,options)=>{assert.equal(options.restoreId,tab.id);},
    parseRestoreError:()=>({message:'private error'}),ipcRenderer:{invoke:async(channel)=>{calls.push(channel);assert.equal(channel,'terminal:create');return{pid:123,cwd:'/fixture'};}}});
  const f=module.exports,options=f.restoreTabOptions(saved);
  await f.createTab(ns,saved.name,saved.cwd,options);
  const restored=workspace.tabs.get('saved'),serialized=JSON.parse(JSON.stringify(f.serializeTabs(workspace.tabs)[0]));
  assert.deepEqual(serialized.executionSubject,saved.executionSubject);assert.equal(serialized.executionStorageRevision,saved.executionStorageRevision);
  assert.equal(restored.parentTabId,saved.parentTabId);assert.equal(restored.visualParentTabId,saved.visualParentTabId);
  assert.equal(serialized.codexSessionId,'existing-sid');assert.equal(calls.length,type==='terminal'?1:0);
  const result=manager.saveExecutionTabV2({executionNamespace:ns,tabId:'saved',subjectId:serialized.executionSubject.subjectId,
    expectedRevision:serialized.executionStorageRevision,record:serialized});
  assert.equal(result.executionSubject.subjectId,saved.executionSubject.subjectId);
  assert.throws(()=>manager.saveExecutionTabV2({executionNamespace:ns,tabId:'saved',subjectId:serialized.executionSubject.subjectId,
    expectedRevision:serialized.executionStorageRevision,record:serialized}),/execution_storage_revision_changed/);
  await assert.rejects(f.createTab(ns,saved.name,saved.cwd,{...options,executionSubject:{...options.executionSubject,tabId:'foreign'}}),/restore_execution_subject_changed/);
  await assert.rejects(f.createTab(ns,saved.name,saved.cwd,{...options,executionSubject:{...options.executionSubject,executionNamespace:'foreign'}}),/restore_execution_subject_changed/);
  const broken=f.createBrokenRestoredTab(workspace,saved,new Error('fixture'));
  assert.deepEqual(JSON.parse(JSON.stringify(broken.executionSubject)),saved.executionSubject);
  assert.equal(broken.executionStorageRevision,saved.executionStorageRevision);
});
