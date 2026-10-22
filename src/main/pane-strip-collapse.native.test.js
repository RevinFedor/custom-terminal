'use strict';
// Actual organization/SQLite in a finite, owned file. No Electron app startup.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3'),DatabaseManager=require('./database'),{WorkflowOrganization}=require('./workflow-organization');
const {paneStripColorGroupsBasis}=require('../shared/pane-strip-color-groups.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-collapse-private-')),db=new Database(path.join(root,'private.db'));
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);});
  const manager=new DatabaseManager({existingConnection:db});manager.initTables();
  db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P',root,'P');
  for(const id of ['a','b','c','x'])db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type) VALUES(?,?,?,?,?,?)').run('P',id,id,root,'terminal','codex');
  const pane={windowId:'win',projectId:'P',tabId:'b',tabs:['a','b','c','x'].map(tabId=>({projectId:'P',tabId,extension:tabId}))};
  manager.setAppState('workspace-session',{activeSpaceId:'W',splitPanes:[pane],spaces:[{id:'W',projectIds:['P'],layout:{splitPanes:[pane]}}]});
  const service=new WorkflowOrganization({database:manager}),stage=service.prepareMigration({migrationId:'private',expectedRevision:0});
  service.publishMigration({mutationId:'migration',migrationId:'private',expectedRevision:0,sourceFingerprint:stage.sourceFingerprint});
  const snapshot=()=>({mutationId:require('node:crypto').randomUUID(),expectedRevision:service.getPublication().revision,
    spaces:service.listWorkflows().map(workflow=>({...workflow.metadata,id:workflow.id,kind:workflow.kind,layout:workflow.layout})),
    tabWorkflowMembership:Object.fromEntries(service.listGlobalTabs().map(tab=>[tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]))});
  const raw=()=>service.getWorkflow('W').metadata.stripColorGroups;
  const write=value=>{const request=snapshot();request.spaces.find(space=>space.id==='W').stripColorGroups=value;
    request.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(raw())}];return request;};
  const initial={version:1,revision:1,groups:[{id:'g',revision:1,color:'#abcdef',tabIds:['a','b','c']}]};
  service.commitWorkspace(write(initial));
  return {service,db,snapshot,raw,write};
}
test('actual SQL collapse toggle is field-CAS guarded, preserves unknown group fields and rejects stale incidental/explicit writes',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),old=f.snapshot();
  const next=clone(f.raw());next.revision++;next.groups[0]={...next.groups[0],revision:2,collapsed:true};
  f.service.commitWorkspace(f.write(next));old.expectedRevision=f.service.getPublication().revision;f.service.commitWorkspace(old);
  assert.equal(f.raw().groups[0].collapsed,true);assert.deepEqual(f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),before);
  const invalid=clone(next);invalid.groups[0].collapsed='yes';assert.throws(()=>f.service.commitWorkspace(f.write(invalid)),/strip_groups_invalid/);
});
test('actual SQL representative fit reorder saves existing canonical slots, no metadata bump, replay remains exact; foreign reorder rolls back',t=>{
  const f=fixture(t),next=clone(f.raw());next.revision++;next.groups[0]={...next.groups[0],revision:2,collapsed:true};f.service.commitWorkspace(f.write(next));
  const request=f.write(clone(f.raw())),pane=request.spaces.find(space=>space.id==='W').layout.splitPanes[0],before=clone(pane.tabs);
  request.stripColorGroupEdits[0].arrange={owner:{windowId:'win',paneIndex:0,centerKey:null},groupId:'g',representative:'b',beforeSlots:before,order:['a','c','b']};
  pane.tabs=[before[0],before[2],before[1],before[3]];delete pane.tabs[0].extension;
  const receipt=f.service.commitWorkspace(request),revision=f.service.getPublication().revision;
  assert.deepEqual(f.service.getWorkflow('W').layout.splitPanes[0].tabs.map(slot=>slot.tabId),['a','c','b','x']);
  assert.equal(f.service.getWorkflow('W').layout.splitPanes[0].tabs[0].extension,'a');assert.equal(f.raw().revision,2);
  assert.deepEqual(f.service.commitWorkspace(request),receipt);assert.equal(f.service.getPublication().revision,revision);
  const stale=clone(request);stale.mutationId='stale';stale.expectedRevision=revision;
  assert.throws(()=>f.service.commitWorkspace(stale),/strip_groups_order_changed/);assert.equal(f.service.getPublication().revision,revision);
});
