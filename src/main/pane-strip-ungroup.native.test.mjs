// Finite private SQLite controls. No Electron application, user DB or runtime
// executor is started; IPC delivery and UI lease are controlled ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID,webcrypto} from 'node:crypto';
import {createOrganizationCommitter,organizationProjection,organizationSnapshot} from '../renderer/utils/workflowOrganizationClient.mjs';
import {commitPaneStripGroupPresentation} from '../renderer/utils/paneStripGroupPresentationCommit.mjs';
import {adoptPaneStripColorGroups,paneStripColorGroupsBasis} from '../shared/pane-strip-color-groups.cjs';
import {emptySpaceLayout} from '../renderer/utils/workspaceSpacesModel.mjs';
const require=createRequire(import.meta.url),Database=require('better-sqlite3');
const DatabaseManager=require('./database'),{WorkflowOrganization}=require('./workflow-organization');
globalThis.crypto??=webcrypto;
const clone=structuredClone;

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-ungroup-private-')),file=path.join(root,'private.db');
  let db=new Database(file),manager=new DatabaseManager({existingConnection:db}),service;
  t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);});
  manager.initTables();db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P',root,'P');
  for(const id of ['a','b','c','x'])db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type) VALUES(?,?,?,?,?,?)')
    .run('P',id,id,root,'terminal','codex');
  const pane={windowId:'win',projectId:'P',tabId:'b',tabs:[{slotId:'chooser',cwd:root,extension:'picker'},
    ...['a','b','c','x'].map(tabId=>({projectId:'P',tabId,extension:{keep:tabId}}))]};
  const layout={...emptySpaceLayout(),activeProjectId:'P',splitPanes:[pane]};
  manager.setAppState('workspace-session',{...layout,activeSpaceId:'W',
    spaces:[{id:'W',projectIds:['P'],extension:{workflow:true},layout}]});
  service=new WorkflowOrganization({database:manager});
  const stage=service.prepareMigration({migrationId:'private',expectedRevision:0});
  service.publishMigration({mutationId:'migration',migrationId:'private',expectedRevision:0,sourceFingerprint:stage.sourceFingerprint});
  const snapshot=()=>({mutationId:randomUUID(),expectedRevision:service.getPublication().revision,
    spaces:service.listWorkflows().map(workflow=>({...workflow.metadata,id:workflow.id,kind:workflow.kind,layout:workflow.layout})),
    tabWorkflowMembership:Object.fromEntries(service.listGlobalTabs().map(tab=>[tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]))});
  const initial=snapshot();initial.spaces.find(space=>space.id==='W').stripColorGroups={version:1,revision:1,extension:{raw:true},groups:[
    {id:'g',revision:1,color:'#abcdef',collapsed:true,tabIds:['a','b','c'],extension:{group:true}},
    {id:'other',revision:1,color:'#123456',tabIds:['x'],extension:{peer:true}}]};
  initial.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(undefined)}];service.commitWorkspace(initial);
  for(const key of ['paneStripSelectedFirst','paneStripCloseOnClick','paneStripInstantHover'])manager.setAppState(key,true);
  const state={...organizationProjection(service.readState(),{activeSpaceId:'W'}),openProjects:new Map(),pendingTabWorkflowMembership:{}};
  let lose=false,hide=false,alive=true;const attempts=[],authorityAtSend=[];
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation') {
        if(hide)return null;
        const row=db.prepare('SELECT response_json FROM workflow_org_mutations WHERE mutation_id=?').get(payload);
        return row?JSON.parse(row.response_json):null;
      }
      assert.equal(channel,'workflow:mutate');assert.equal(payload.kind,'commitWorkspace');attempts.push(clone(payload.request));
      if(payload.request.stripColorGroupEdits)authorityAtSend.push(lease.isCurrent());
      const result=service.commitWorkspace(payload.request);
      if(lose&&payload.request.stripColorGroupEdits){lose=false;throw Error('lost ACK');}
      return result;
    },applyPublication:async()=>{
      const published=service.readState(),projected=organizationProjection(published,state);
      Object.assign(state,{spaces:adoptPaneStripColorGroups(state.spaces,projected.spaces),organizationRevision:published.publication.revision});
    },onError:()=>{}});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const lease={version:1,workflowId:'W',windowId:'win',paneIndex:0,
    entries:state.splitPanes[0].tabs.filter(slot=>['a','b','c'].includes(slot.tabId)),isCurrent:()=>alive};
  const raw=()=>service.getWorkflow('W').metadata.stripColorGroups;
  return {state,lease,committer,attempts,authorityAtSend,raw,snapshot,
    get db(){return db;},get service(){return service;},get manager(){return manager;},
    run:()=>commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId:'g',ungroup:true}),
    reopen:()=>{db.close();db=new Database(file);manager=new DatabaseManager({existingConnection:db});service=new WorkflowOrganization({database:manager});},
    lose:()=>{lose=true;hide=true;},recover:()=>{hide=false;},revoke:()=>{alive=false;}};
}

test('actual private SQL: ungroup removes one raw definition, preserves all placements/execution rows/other group/prefs, and survives reopen',async t=>{
  const f=fixture(t),before=f.service.getWorkflow('W'),rows=f.db.prepare('SELECT * FROM tabs ORDER BY id').all();
  const membership=f.service.listGlobalTabs().map(tab=>tab.membership),local=f.state.splitPanes;
  await f.run();f.reopen();
  const after=f.service.getWorkflow('W');assert.deepEqual(after.layout,before.layout);
  assert.deepEqual(f.raw(),{...before.metadata.stripColorGroups,revision:2,groups:[before.metadata.stripColorGroups.groups[1]]});
  assert.deepEqual(f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),rows);
  assert.deepEqual(f.service.listGlobalTabs().map(tab=>tab.membership),membership);
  assert.equal(f.state.splitPanes,local);
  for(const key of ['paneStripSelectedFirst','paneStripCloseOnClick','paneStripInstantHover'])assert.equal(f.manager.getAppState(key),true);
});

test('actual private SQL: lost ungroup ACK/reopen retries the original request, with exactly one field revision and one deletion receipt',async t=>{
  const f=fixture(t);f.lose();await assert.rejects(f.run(),/lost ACK/);
  assert.equal(f.raw().groups.some(group=>group.id==='g'),false);
  assert.equal(f.state.spaces.find(space=>space.id==='W').stripColorGroups.groups.some(group=>group.id==='g'),true);
  const revision=f.service.getPublication().revision;f.reopen();f.recover();await f.run();
  assert.equal(f.raw().revision,2);
  assert.equal(f.service.getPublication().revision,revision+2,'existing flush and no-op snapshot are distinct from the recovered deletion');
  const edits=f.attempts.filter(request=>request.stripColorGroupEdits);assert.equal(edits.length,2);assert.deepEqual(edits[0],edits[1]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workflow_org_mutations WHERE mutation_id=?').get(edits[0].mutationId).n,1);
});

test('actual private SQL: durable ungroup adoption continues after UI lease revocation without a second deletion',async t=>{
  const f=fixture(t);f.lose();await assert.rejects(f.run(),/lost ACK/);
  const revision=f.service.getPublication().revision;f.reopen();f.recover();f.revoke();await f.committer.settle();
  assert.equal(f.lease.isCurrent(),false);assert.equal(f.service.getPublication().revision,revision);
  assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,f.raw());assert.equal(f.raw().revision,2);
});

test('actual private SQL: a foreign recolor cannot be erased by an old ungroup snapshot even after refreshing organization revision',async t=>{
  const f=fixture(t),raw=clone(f.raw()),request=f.snapshot();raw.revision++;raw.groups[0].color='#fedcba';raw.groups[0].revision++;
  request.spaces.find(space=>space.id==='W').stripColorGroups=raw;
  request.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(f.raw())}];f.service.commitWorkspace(request);
  f.state.organizationRevision=f.service.getPublication().revision;
  const rows=f.db.prepare('SELECT * FROM tabs ORDER BY id').all();
  await assert.rejects(f.run(),/strip_groups_revision_changed/);
  assert.deepEqual(f.raw(),raw);assert.deepEqual(f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),rows);
  assert.equal(f.attempts.some(value=>value.stripColorGroupEdits),false);
});

test('actual private SQL: synchronous Ungroup admission precedes a queued UI revoke, then adopts its durable deletion after revoke',async t=>{
  const f=fixture(t),wasCurrent=f.lease.isCurrent;let checks=0;
  f.lease.isCurrent=()=>{
    const current=wasCurrent();
    if(++checks===2)queueMicrotask(f.revoke);
    return current;
  };
  await f.run();
  assert.deepEqual(f.authorityAtSend,[true]);assert.equal(wasCurrent(),false);
  assert.equal(f.raw().groups.some(group=>group.id==='g'),false);
  assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,f.raw());
});
