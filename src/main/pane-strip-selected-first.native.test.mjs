// Run in the existing repository's matching better-sqlite3 Node/Electron ABI.
// Real DatabaseManager + WorkflowOrganization + renderer committer/helper,
// finite PRIVATE physical SQLite file. No Electron application, provider,
// History source, PTY, runtime executor or native UI starts here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {createOrganizationCommitter,organizationProjection,organizationSnapshot} from '../renderer/utils/workflowOrganizationClient.mjs';
import {commitPaneStripGroupPresentation} from '../renderer/utils/paneStripGroupPresentationCommit.mjs';
import {applyPaneStripGatherPublication} from '../renderer/utils/paneStripGroupsModel.mjs';
import {adoptPaneStripColorGroups,paneStripColorGroupsBasis} from '../shared/pane-strip-color-groups.cjs';
const require=createRequire(import.meta.url),Database=require('better-sqlite3'),DatabaseManager=require('./database');
const {WorkflowOrganization}=require('./workflow-organization');
const clone=structuredClone;
// Electron28 RUN_AS_NODE has no global WebCrypto; the actual renderer does.
// Supply that browser primitive, without replacing the SQL/organization owners.
globalThis.crypto??=webcrypto;

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-selected-first-private-')),file=path.join(root,'private.db');
  let db=new Database(file),manager=new DatabaseManager({existingConnection:db}),service;
  t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);});
  manager.initTables();db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P',root,'P');
  for(const id of ['a','b','c','d','x'])db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type) VALUES(?,?,?,?,?,?)')
    .run('P',id,id,root,'terminal','codex');
  const pane={windowId:'win',projectId:'P',tabId:'a',tabs:[{slotId:'chooser',cwd:root,extension:'picker'},
    ...['a','b','c','d','x'].map(tabId=>({projectId:'P',tabId,extension:{keep:tabId}}))]};
  manager.setAppState('workspace-session',{activeSpaceId:'W',activeProjectId:'P',splitPanes:[pane],
    spaces:[{id:'W',projectIds:['P'],extension:{workflow:true},layout:{splitPanes:[pane]}}]});
  service=new WorkflowOrganization({database:manager});
  const stage=service.prepareMigration({migrationId:'private',expectedRevision:0});
  service.publishMigration({mutationId:'migration',migrationId:'private',expectedRevision:0,sourceFingerprint:stage.sourceFingerprint});
  const snapshot=()=>({mutationId:require('node:crypto').randomUUID(),expectedRevision:service.getPublication().revision,
    spaces:service.listWorkflows().map(workflow=>({...workflow.metadata,id:workflow.id,kind:workflow.kind,layout:workflow.layout})),
    tabWorkflowMembership:Object.fromEntries(service.listGlobalTabs().map(tab=>[tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]))});
  const initial=snapshot(),raw={version:1,revision:1,extension:{raw:true},groups:[{
    id:'g',revision:1,color:'#abcdef',collapsed:true,tabIds:['a','b','c','d'],extension:{group:true}}]};
  initial.spaces.find(space=>space.id==='W').stripColorGroups=raw;
  initial.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(undefined)}];service.commitWorkspace(initial);
  const state={...organizationProjection(service.readState(),{activeSpaceId:'W'}),openProjects:new Map(),pendingTabWorkflowMembership:{}};
  let lose=false,hide=false,alive=true;
  const attempts=[];
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation') {
        if(hide)return null;
        const row=db.prepare('SELECT response_json FROM workflow_org_mutations WHERE mutation_id=?').get(payload);
        return row?JSON.parse(row.response_json):null;
      }
      assert.equal(channel,'workflow:mutate');assert.equal(payload.kind,'commitWorkspace');attempts.push(clone(payload.request));
      const result=service.commitWorkspace(payload.request);
      if(lose&&payload.request.stripColorGroupEdits?.some(edit=>edit.arrange)){lose=false;throw Error('lost ACK');}
      return result;
    },applyPublication:async(_result,request)=>{
      const snapshot=service.readState(),projected=organizationProjection(snapshot,state);
      Object.assign(state,applyPaneStripGatherPublication(state,adoptPaneStripColorGroups(state.spaces,projected.spaces),projected.spaces,request),
        {organizationRevision:snapshot.publication.revision});
    },onError:()=>{}});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const lease={version:1,workflowId:'W',windowId:'win',paneIndex:0,
    entries:state.splitPanes[0].tabs.filter(slot=>['a','b','c','d'].includes(slot.tabId)),isCurrent:()=>alive};
  return {state,lease,committer,attempts,snapshot,
    get db(){return db;},get service(){return service;},
    raw:()=>service.getWorkflow('W').metadata.stripColorGroups,
    order:()=>service.getWorkflow('W').layout.splitPanes[0].tabs.map(slot=>slot.tabId||slot.slotId),
    rows:()=>db.prepare('SELECT * FROM tabs ORDER BY id').all(),
    select:id=>{state.splitPanes[0].tabId=id;return commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId:'g',selectedTabId:id});},
    reopen:()=>{db.close();db=new Database(file);manager=new DatabaseManager({existingConnection:db});service=new WorkflowOrganization({database:manager});},
    lose:()=>{lose=true;hide=true;},recover:()=>{hide=false;},revoke:()=>{alive=false;},
  };
}
test('actual private SQL: selected-first saves exact durable order with original raw definition/extensions and unchanged execution rows',async t=>{
  const f=fixture(t),raw=clone(f.raw()),rows=f.rows(),members=f.service.listGlobalTabs().map(tab=>tab.membership);
  await f.select('b');assert.deepEqual(f.order(),['chooser','b','a','c','d','x']);
  await f.select('d');assert.deepEqual(f.order(),['chooser','d','b','a','c','x']);f.reopen();
  assert.deepEqual(f.order(),['chooser','d','b','a','c','x']);assert.deepEqual(f.raw(),raw);assert.deepEqual(f.rows(),rows);
  assert.deepEqual(f.service.listGlobalTabs().map(tab=>tab.membership),members);
  assert.equal(f.service.getWorkflow('W').layout.splitPanes[0].tabs[1].extension.keep,'d');
  assert.equal(f.service.getWorkflow('W').layout.splitPanes[0].tabs[0].extension,'picker');
});
test('actual private SQL: same-ID lost ACK/reopen followed by newest select1 recovers before no-op and persists newest order',async t=>{
  const f=fixture(t),raw=clone(f.raw());f.lose();await assert.rejects(f.select('b'),/lost ACK/);
  const acceptedRevision=f.service.getPublication().revision;f.reopen();f.recover();await f.select('a');
  assert.deepEqual(f.order(),['chooser','a','b','c','d','x']);assert.deepEqual(f.raw(),raw);
  const attempts=f.attempts.filter(request=>request.stripColorGroupEdits?.some(edit=>edit.arrange));
  assert.deepEqual(attempts[0],attempts[1]);assert.notEqual(attempts[1].mutationId,attempts[2].mutationId);
  assert.equal(f.service.getPublication().revision,acceptedRevision+2,'only newer normal flush and newer arrange commit');
});
test('actual private SQL: no-fit OPEN settle recovers old order without another mutation even after UI lease expires',async t=>{
  const f=fixture(t);f.lose();await assert.rejects(f.select('b'),/lost ACK/);
  const revision=f.service.getPublication().revision;f.reopen();f.recover();f.revoke();await f.committer.settle();
  assert.deepEqual(f.state.splitPanes[0].tabs.map(slot=>slot.tabId||slot.slotId),['chooser','b','a','c','d','x']);
  assert.equal(f.service.getPublication().revision,revision);assert.equal(f.lease.isCurrent(),false);
});
test('actual private SQL: newer canonical order rejects stale beforeSlots and rolls back the whole selected arrange',async t=>{
  const f=fixture(t);await f.select('b');
  const old=clone(f.attempts.find(request=>request.stripColorGroupEdits?.some(edit=>edit.arrange)));
  old.mutationId='stale-new-id';old.expectedRevision=f.service.getPublication().revision;
  const revision=old.expectedRevision,raw=clone(f.raw()),rows=f.rows();
  assert.throws(()=>f.service.commitWorkspace(old),/strip_groups_order_changed/);
  assert.equal(f.service.getPublication().revision,revision);assert.deepEqual(f.raw(),raw);assert.deepEqual(f.rows(),rows);
});
