'use strict';
// Run with the repo Electron in Node mode. Exact parent-owned fixture only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const DatabaseManager=require('../src/main/database');
const {createWorkflowOrganizationApi}=require('../src/main/workflow-organization-api');
const {GLOBAL_EXECUTION_NAMESPACE:NS,INBOX_WORKFLOW_ID}=require('../src/shared/workflow-organization.cjs');
const lease=path.resolve(process.argv[2] || '');
const manifest=JSON.parse(fs.readFileSync(path.join(lease,'manifest.json')));
assert.equal(path.resolve(manifest.lease),lease);
const filename=path.join(manifest.env.NOTED_USER_DATA_DIR,'noted-terminal-dev.db');
assert.equal(fs.existsSync(filename),false,'never overwrite an active fixture');
const db=new Database(filename);db.pragma('foreign_keys=ON');
const manager=new DatabaseManager({existingConnection:db});manager.initTables();
const docs=path.join(lease,'fixture-files');fs.mkdirSync(docs);
fs.writeFileSync(path.join(docs,'visual.md'),'# Visual fixture\n\nExact owner attachment.\n');
fs.writeFileSync(path.join(docs,'details.txt'),'Second direct attachment\n');
const api=createWorkflowOrganizationApi({database:manager});
const ref=id=>({projectId:NS,tabId:id});
const pane=(windowId,ids,hidden=false)=>({windowId,projectId:NS,tabId:ids[0] || null,tabs:ids.map(ref),
  displayHidden:hidden,column:windowId.endsWith('2')?1:0,row:0});
const layout=(panes,focus=0)=>({splitPanes:panes,splitFocusedIndex:focus,activeProjectId:NS,focusedProjectId:NS,
  activeSpaceTab:panes[focus]?.tabId?ref(panes[focus].tabId):null,centerStrips:{},splitSizes:null,
  windowDisplayKey:null,windowDisplayLayouts:{}});
api.bootstrap({migrationId:'fixture-migration',mutationId:'fixture-activate',workspace:{spaces:[
  {id:'visual-fixture',name:'Визуал E2E',projectIds:[],layout:layout([])},
  {id:'background-fixture',name:'Фоновый E2E',projectIds:[],layout:layout([])}],activeSpaceId:'visual-fixture'}});
for(const [id,name,wf,type,parent,file] of [
  ['fixture-A','Владелец файлов','visual-fixture','terminal'],['fixture-A2','Сосед A2','visual-fixture','terminal'],
  ['fixture-B','Окно B1','background-fixture','terminal'],['fixture-D','Окно B2','background-fixture','terminal'],
  ['fixture-R','Резерв R','background-fixture','terminal'],['fixture-H','Скрытая H','visual-fixture','terminal'],
  ['fixture-F1','visual.md','visual-fixture','file','fixture-A','visual.md'],
  ['fixture-F2','details.txt','visual-fixture','file','fixture-A','details.txt']])api.createTab({mutationId:'fixture-create:'+id,
    tabId:id,cwd:docs,workflowId:wf,sourceTabId:parent,record:{name,tabType:type,
      ...(parent?{visualParentTabId:parent,filePath:path.join(docs,file)}:{}),notes:id==='fixture-A'?'Контекст владельца файлов':'',
      commandType:null,wasInterrupted:false}});
const a=layout([pane('fixture-a1',['fixture-A','fixture-A2']),pane('fixture-hidden',['fixture-H'],true)]);
const b=layout([pane('fixture-b1',['fixture-B']),pane('fixture-b2',['fixture-D'])],1);
const spaces=api.service.listWorkflows().map(wf=>({id:wf.id,name:wf.metadata.name,kind:wf.kind,
  projectIds:[],layout:wf.id==='visual-fixture'?a:wf.id==='background-fixture'?b:layout([pane('fixture-inbox',[])])}));
api.service.commitWorkspace({mutationId:'fixture-layout',expectedRevision:api.service.getPublication().revision,spaces,
  tabWorkflowMembership:Object.fromEntries(api.service.listGlobalTabs().map(tab=>[tab.tabId,tab.membership]))});
manager.setAppState('workspace-session',{openProjects:[{projectId:NS,projectPath:docs,activeTabIndex:0,runtimeTabIds:[]}],
  activeProjectId:NS,focusedProjectId:NS,view:'workspace',projectHistory:[NS],globalTabMru:[],...a,spaces,activeSpaceId:'visual-fixture',
  organizationVersion:1,organizationRevision:api.service.getPublication().revision,organizationGeneration:api.service.getPublication().generation,
  tabLastWorkflowIds:{'fixture-R':'background-fixture'},runAfterWorkflowScopeVersions:{},workflowSidebarState:{}});
manager.setAppState('globalAutoCompact',{enabled:false});
manager.setAppState('promptQueueByTab',{});
assert.equal(db.prepare('SELECT COUNT(*) n FROM projects').get().n,0);
assert.equal(api.service.listGlobalTabs().length,8);
assert.equal(api.service.getMembership('fixture-R').workflowId,'background-fixture');
assert.ok(api.service.getWorkflow(INBOX_WORKFLOW_ID));assert.deepEqual(db.pragma('foreign_key_check'),[]);
db.close();
const expected={version:1,namespace:NS,database:filename,docs,workflows:['visual-fixture','background-fixture',INBOX_WORKFLOW_ID],
  tabs:['fixture-A','fixture-A2','fixture-B','fixture-D','fixture-R','fixture-H','fixture-F1','fixture-F2'],
  tabCount:8,projectCount:0,ownerId:'fixture-A',fileIds:['fixture-F1','fixture-F2'],fileHashes:[]};
for(const name of ['visual.md','details.txt'])expected.fileHashes.push({path:path.join(docs,name),
  sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(docs,name))).digest('hex')});
fs.copyFileSync(filename,path.join(lease,'fixture-baseline.db'));
fs.writeFileSync(path.join(lease,'fixture.json'),JSON.stringify(expected,null,2),{mode:0o600});
console.log(JSON.stringify({prepared:true,...expected,fileHashes:expected.fileHashes.map(row=>({sha256:row.sha256}))}));
