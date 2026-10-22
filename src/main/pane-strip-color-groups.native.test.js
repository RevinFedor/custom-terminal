'use strict';
// Finite private SQLite controls, Electron RUN_AS_NODE only; no app/bootstrap,
// production DB, provider, PTY or GUI. Existing DatabaseManager + actual service.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const Database=require('better-sqlite3'),DatabaseManager=require('./database');
const original=path.join(__dirname,'workflow-organization.js');
function organizationModule() {
  if(!process.env.NOTED_STRIP_ORGANIZATION_SOURCE)return require(original);
  const loaded=new Module(original,module);loaded.filename=original;loaded.paths=module.paths;
  loaded._compile(fs.readFileSync(process.env.NOTED_STRIP_ORGANIZATION_SOURCE,'utf8'),original);return loaded.exports;
}
const {WorkflowOrganization}=organizationModule();
const {paneStripColorGroupsBasis,gatherPaneStripSlots}=require('../shared/pane-strip-color-groups.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(t,{hole=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-strip-colors-sql-')),file=path.join(root,'private.db');
  let db=new Database(file),manager=new DatabaseManager({existingConnection:db});manager.initTables();
  t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);});
  for(const namespace of ['P','Q'])db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run(namespace,root,namespace);
  for(const [id,namespace] of [['a','P'],['b','Q'],...(hole?[['x','P']]:[])])db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type) VALUES(?,?,?,?,?,?)')
    .run(namespace,id,id,root,'terminal','codex');
  const panes=[{windowId:'win',projectId:'P',tabId:'a',tabs:[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'}]}];
  if(hole){panes[0].tabs.splice(1,0,{projectId:'P',tabId:'x',future:{keep:true}});panes[0].tabId='x';}
  manager.setAppState('workspace-session',{activeSpaceId:'W',splitPanes:panes,spaces:[{id:'W',name:'Work',projectIds:['P','Q'],layout:{splitPanes:panes},future:{retain:true}}]});
  let service=new WorkflowOrganization({database:manager});
  const stage=service.prepareMigration({migrationId:'private',expectedRevision:0});
  service.publishMigration({mutationId:'publication',migrationId:'private',expectedRevision:0,sourceFingerprint:stage.sourceFingerprint});
  const state=()=>service.getWorkflow('W').metadata.stripColorGroups;
  const snapshot=()=>({mutationId:require('node:crypto').randomUUID(),expectedRevision:service.getPublication().revision,
    spaces:service.listWorkflows().map(workflow=>({...workflow.metadata,id:workflow.id,kind:workflow.kind,layout:workflow.layout})),
    tabWorkflowMembership:Object.fromEntries(service.listGlobalTabs().map(tab=>[tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]))});
  const write=(value,basis=paneStripColorGroupsBasis(state()))=>{
    const request=snapshot();request.spaces.find(space=>space.id==='W').stripColorGroups=value;
    request.stripColorGroupEdits=[{workflowId:'W',basis}];return request;
  };
  const reopen=()=>{db.close();db=new Database(file);manager=new DatabaseManager({existingConnection:db});service=new WorkflowOrganization({database:manager});};
  return {state,snapshot,write,reopen,get db(){return db;},get service(){return service;}};
}
const first=()=>({version:1,revision:1,groups:[{id:'g',revision:1,color:'#123456',tabIds:['a','b']}]});
const recolor=(source,color)=>({...clone(source),revision:source.revision+1,groups:source.groups.map(group=>({...clone(group),color,revision:group.revision+1}))});
test('actual SQL: release identity proof leaves unrelated large record bodies in SQLite',t=>{
  const f=fixture(t,{hole:true}),create=f.write(first()),space=create.spaces.find(value=>value.id==='W');
  const before=clone(space.layout.splitPanes[0].tabs);
  create.stripColorGroupEdits[0].gather={owner:{windowId:'win',paneIndex:0,centerKey:null},beforeSlots:before};
  space.layout.splitPanes[0].tabs=gatherPaneStripSlots(before,['a','b']);f.service.commitWorkspace(create);
  const workflow=f.service.getWorkflow('W'),next=clone(workflow.layout),pane=next.splitPanes[0];
  const moving=pane.tabs.find(entry=>entry.tabId==='x');pane.tabs=pane.tabs.filter(entry=>entry.tabId!=='x');pane.tabs.splice(1,0,moving);
  const {preparePaneStripGroupRelease}=require('../shared/pane-strip-group-admission.cjs');
  const prepared=preparePaneStripGroupRelease({workflowId:'W',field:f.state(),beforeLayout:workflow.layout,layout:next,
    rootTabIds:['x'],targetOwner:{paneIndex:0,windowId:'win',centerKey:null},isActive:id=>f.service.stripActivity(id)});
  const saved=JSON.parse(f.db.prepare('SELECT record_json FROM workflow_org_tabs WHERE tab_id=?').get('x').record_json);
  saved.ownedSyntheticBody='x'.repeat(256*1024);f.db.prepare('UPDATE workflow_org_tabs SET record_json=? WHERE tab_id=?').run(JSON.stringify(saved),'x');
  const original=f.db.prepare;let bodyBytes=0;
  const measure=rows=>{for(const row of Array.isArray(rows)?rows:[rows])if(row&&typeof row.record_json==='string')bodyBytes+=Buffer.byteLength(row.record_json);return rows;};
  f.db.prepare=function(...args){const stmt=original.apply(this,args);return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key,target);
    if(key==='get'||key==='all')return(...parameters)=>measure(value.apply(target,parameters));
    return typeof value==='function'?value.bind(target):value;}});};
  let actual;try{actual=f.service.releaseStripGroups(workflow,next,prepared.intent);}finally{f.db.prepare=original;}
  assert.deepEqual(actual,prepared.nextState,'identity/activity projection preserves the exact admission result');
  assert.equal(bodyBytes,0,'unrelated record bodies are not an input to group admission');
});
test('actual SQL: create/recolor/known clear keep execution rows, memberships, unknown metadata and publication journal ownership',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),members=f.service.listGlobalTabs().map(tab=>tab.membership);
  f.service.commitWorkspace(f.write(first()));assert.deepEqual(f.state(),first());
  const next=recolor(f.state(),'#abcdef');f.service.commitWorkspace(f.write(next));assert.deepEqual(f.state(),next);
  assert.equal(f.service.getWorkflow('W').metadata.future.retain,true);
  assert.deepEqual(f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),before);
  assert.deepEqual(f.service.listGlobalTabs().map(tab=>tab.membership),members);
  f.service.commitWorkspace(f.write({version:1,revision:3,groups:[]}));assert.deepEqual(f.state().groups,[]);
});
test('actual SQL: latest org revision plus stale incidental snapshot cannot undo foreign recolor; explicit stale basis rejects atomically',t=>{
  const f=fixture(t);f.service.commitWorkspace(f.write(first()));const old=f.snapshot(),staleEdit=f.write(recolor(first(),'#445566'));
  const foreign=recolor(f.state(),'#abcdef');f.service.commitWorkspace(f.write(foreign));
  old.expectedRevision=f.service.getPublication().revision;old.spaces.find(space=>space.id==='W').name='Changed settings';
  f.service.commitWorkspace(old);assert.deepEqual(f.state(),foreign);assert.equal(f.service.getWorkflow('W').metadata.name,'Changed settings');
  staleEdit.expectedRevision=f.service.getPublication().revision;const revision=staleEdit.expectedRevision;
  assert.throws(()=>f.service.commitWorkspace(staleEdit),/strip_groups_revision_changed/);
  assert.equal(f.service.getPublication().revision,revision);assert.deepEqual(f.state(),foreign);
});
test('actual SQL: lost ACK/reopen recovers same mutation and exact result; altered basis/payload under same ID conflicts',t=>{
  const f=fixture(t),request=f.write(first()),result=f.service.commitWorkspace(request),revision=f.service.getPublication().revision;
  f.reopen();assert.deepEqual(f.service.commitWorkspace(request),result);assert.equal(f.service.getPublication().revision,revision);
  const changed=clone(request);changed.spaces.find(space=>space.id==='W').stripColorGroups.groups[0].color='#ffffff';
  assert.throws(()=>f.service.commitWorkspace(changed),/mutation_id_conflict/);
  assert.deepEqual(f.state(),first());
});
test('actual SQL: malformed/unknown basis and foreign/closed membership never become ready empty or mutate clocks',t=>{
  const f=fixture(t);f.service.commitWorkspace(f.write(first()));
  for(const basis of [null,{},'unknown']) {
    const request=f.write(recolor(f.state(),'#abcdef'),basis),revision=f.service.getPublication().revision;
    assert.throws(()=>f.service.commitWorkspace(request),/strip_groups_(basis_invalid|revision_changed)/);
    assert.equal(f.service.getPublication().revision,revision);assert.deepEqual(f.state(),first());
  }
  const invalid=recolor(f.state(),'#abcdef');invalid.groups[0].tabIds.push('missing');
  assert.throws(()=>f.service.commitWorkspace(f.write(invalid)),/strip_groups_membership_changed/);
  assert.deepEqual(f.state(),first());
});
test('actual SQL: A-X-B CREATE commits gathered A-B-X and color atomically; stale source order rolls back both',t=>{
  for(const stale of [false,true]) {
    const f=fixture(t,{hole:true}),request=f.write(first()),space=request.spaces.find(space=>space.id==='W'),before=clone(space.layout.splitPanes[0].tabs);
    delete before[1].future; // an older renderer need not understand this slot extension
    request.stripColorGroupEdits[0].gather={owner:{windowId:'win',paneIndex:0,centerKey:null},beforeSlots:before};
    space.layout.splitPanes[0].tabs=gatherPaneStripSlots(before,['a','b']);
    if(stale){const foreign=f.snapshot();foreign.spaces.find(space=>space.id==='W').layout.splitPanes[0].tabs.reverse();f.service.commitWorkspace(foreign);
      request.expectedRevision=f.service.getPublication().revision;}
    const revision=f.service.getPublication().revision,rows=f.db.prepare('SELECT * FROM tabs ORDER BY id').all();
    if(stale){assert.throws(()=>f.service.commitWorkspace(request),/strip_groups_order_changed/);assert.equal(f.state(),undefined);assert.equal(f.service.getPublication().revision,revision);}
    else{f.service.commitWorkspace(request);const pane=f.service.getWorkflow('W').layout.splitPanes[0];
      assert.deepEqual(pane.tabs.map(entry=>entry.tabId),['a','b','x']);assert.equal(pane.tabId,'x');assert.equal(pane.tabs[2].future.keep,true);
      assert.equal(f.state().groups[0].color,'#123456');const after=f.service.getPublication().revision;
      f.reopen();f.service.commitWorkspace(request);assert.equal(f.service.getPublication().revision,after);}
    assert.deepEqual(f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),rows);
  }
});
test('actual SQL: closed same-workflow provenance survives recolor; new inactive or foreign members remain refused',t=>{
  const f=fixture(t);f.service.commitWorkspace(f.write(first()));
  // Seed the already-finalized close in this private fixture only. Production
  // close/lifecycle executors are not replaced or invoked by this control.
  f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('b');
  const layout=f.snapshot();layout.spaces.find(space=>space.id==='W').layout.splitPanes[0].tabs.pop();f.service.commitWorkspace(layout);
  const next=recolor(f.state(),'#abcdef');f.service.commitWorkspace(f.write(next));
  assert.deepEqual(f.state().groups[0].tabIds,['a','b']);assert.equal(f.state().groups[0].color,'#abcdef');
  const invalid=clone(next);invalid.revision++;invalid.groups[0].id='new';invalid.groups[0].revision=1;
  const revision=f.service.getPublication().revision;
  assert.throws(()=>f.service.commitWorkspace(f.write(invalid)),/strip_groups_membership_changed/);
  assert.equal(f.service.getPublication().revision,revision);
  f.service.moveTab({mutationId:'foreign',expectedRevision:revision,tabId:'b',
    expectedMembershipRevision:f.service.getMembership('b').revision,workflowId:f.service.listWorkflows().find(workflow=>workflow.kind==='inbox').id});
  assert.throws(()=>f.service.commitWorkspace(f.write(recolor(next,'#ffffff'))),/strip_groups_membership_changed/);
  assert.deepEqual(f.state(),next);
});
