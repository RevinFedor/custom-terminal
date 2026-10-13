'use strict';
// Offline, deliberately synthetic saved histories. Real Main/SQLite/JSONL,
// no production storage, credentials, provider launch or PTY input.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Database=require('better-sqlite3'),DatabaseManager=require('../src/main/database');
const {createWorkflowOrganizationApi}=require('../src/main/workflow-organization-api');
const {GLOBAL_EXECUTION_NAMESPACE:NS}=require('../src/shared/workflow-organization.cjs');
const lease=fs.realpathSync(process.argv[2]),manifest=JSON.parse(fs.readFileSync(path.join(lease,'manifest.json')));
assert.equal(fs.realpathSync(manifest.lease),lease);
const filename=path.join(manifest.env.NOTED_USER_DATA_DIR,'noted-terminal-dev.db');
assert.equal(fs.existsSync(filename),false,'never overwrite a fixture');
const db=new Database(filename),manager=new DatabaseManager({existingConnection:db});manager.initTables();
const api=createWorkflowOrganizationApi({database:manager});
const cwd=path.join(lease,'fixture-files');fs.mkdirSync(cwd,{recursive:true});
const ref=id=>({projectId:NS,tabId:id});
const pane=(id,ids,column)=>({windowId:id,projectId:NS,tabId:ids[0],tabs:ids.map(ref),column,row:0});
const layout={splitPanes:[pane('drag-window',['drag-claude'],0),pane('retained-window',['retained-claude'],1)],
  splitFocusedIndex:0,activeProjectId:NS,focusedProjectId:NS,activeSpaceTab:ref('drag-claude'),
  centerStrips:{},splitSizes:[0.5,0.5],windowDisplayLayouts:{},windowDisplayKey:null};
api.bootstrap({migrationId:'navbar-drag-migration',mutationId:'navbar-drag-activate',workspace:{activeSpaceId:'drag-main',spaces:[
  {id:'drag-main',name:'Drag main',projectIds:[],layout:{}},
  {id:'drag-other',name:'Drag other',projectIds:[],layout:{}}]}});
const transcripts=[];
for(const [index,id] of ['drag-claude','retained-claude'].entries()){
  const sid=`b4410000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
  api.createTab({mutationId:'fixture:'+id,tabId:id,cwd,workflowId:'drag-main',record:{
    name:index?'Retained Claude':'Navbar Claude',color:'claude',commandType:'claude',tabType:'terminal',
    claudeSessionId:sid,wasInterrupted:true,activeView:'history'}});
  const dir=path.join(manifest.env.CLAUDE_CONFIG_DIR,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(dir,{recursive:true});
  const records=[];let parent=null;
  for(let i=0;i<900;i++){
    const user=crypto.randomUUID(),assistant=crypto.randomUUID(),timestamp=new Date(Date.parse('2026-10-10T01:00:00Z')+i*2000).toISOString();
    records.push({uuid:user,parentUuid:parent,type:'user',sessionId:sid,cwd,timestamp,
      message:{role:'user',content:`Saved synthetic turn ${i+1}. Inspect the source, preserve hierarchy and cancel guards.`}});
    records.push({uuid:assistant,parentUuid:user,type:'assistant',sessionId:sid,cwd,
      timestamp:new Date(Date.parse(timestamp)+1000).toISOString(),message:{id:'msg-'+assistant,model:'claude-sonnet-5',role:'assistant',
        stop_reason:'end_turn',usage:{input_tokens:1200,output_tokens:300},content:[{type:'text',text:
          `### Saved answer ${i+1}\n\n`+Array.from({length:6},(_,n)=>`Paragraph ${n+1}: this deliberately synthetic persisted history goes through the real reader and renderer. The drag must preserve its source, current targets, live updates and cancellation.\n`).join('\n')}]}});
    parent=assistant;
  }
  const transcript=path.join(dir,sid+'.jsonl');fs.writeFileSync(transcript,records.map(record=>JSON.stringify(record)).join('\n')+'\n',{flag:'wx'});
  transcripts.push({id,sid,transcript,records:records.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(transcript)).digest('hex')});
}
const reserveIds=Array.from({length:60},(_,i)=>'reserve-'+String(i).padStart(2,'0'));
for(const id of reserveIds)api.createTab({mutationId:'fixture:'+id,tabId:id,cwd,workflowId:'drag-main',record:{name:id,tabType:'terminal',commandType:null}});
for(const id of ['other-0','other-1','other-2'])api.createTab({mutationId:'fixture:'+id,tabId:id,cwd,workflowId:'drag-other',record:{name:id,tabType:'terminal',commandType:null}});
const group=api.groups.mutate('create',{version:1,mutationId:'fixture:group',expectedRevision:api.groups.meta().revision,
  metadata:{name:'Hover group',reserveWorkflowId:'drag-main'}}).groupId;
api.groups.mutate('assign',{version:1,mutationId:'fixture:group-assign',expectedRevision:api.groups.meta().revision,
  groupId:group,tabIds:reserveIds.slice(2,5),expectedTabGroups:Object.fromEntries(reserveIds.slice(2,5).map(id=>[id,null]))});
const spaces=api.service.listWorkflows().map(workflow=>({id:workflow.id,name:workflow.metadata.name,kind:workflow.kind,
  projectIds:[],reserveOrder:workflow.id==='drag-main'?reserveIds:[],layout:workflow.id==='drag-main'?layout:{}}));
api.service.commitWorkspace({mutationId:'fixture:layout',expectedRevision:api.service.getPublication().revision,spaces,
  tabWorkflowMembership:Object.fromEntries(api.service.listGlobalTabs().map(tab=>[tab.tabId,tab.membership]))});
manager.setAppState('workspace-session',{openProjects:[{projectId:NS,projectPath:cwd,activeTabIndex:0,runtimeTabIds:[]}],
  ...layout,spaces,activeSpaceId:'drag-main',view:'workspace',projectHistory:[NS],globalTabMru:[],
  organizationVersion:1,organizationRevision:api.service.getPublication().revision,organizationGeneration:api.service.getPublication().generation,
  tabLastWorkflowIds:{},workflowSidebarState:{},runAfterWorkflowScopeVersions:{}});
manager.setAppState('globalAutoCompact',{enabled:false});manager.setAppState('promptQueueByTab',{});
assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();
fs.copyFileSync(filename,path.join(lease,'fixture-baseline.db'));
const fixture={lease,namespace:NS,database:filename,cwd,layout,transcripts,reserveIds,groupId:group,
  activeWorkflow:'drag-main',otherWorkflow:'drag-other',providerStarted:false,credentialsCopied:false};
fs.writeFileSync(path.join(lease,'fixture.json'),JSON.stringify(fixture,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({prepared:true,lease,namespace:NS,tabs:65,transcripts:transcripts.map(t=>({id:t.id,sid:t.sid,records:t.records})),groupId:group}));
