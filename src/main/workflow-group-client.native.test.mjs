// Actual Main IPC handlers + SQLite + renderer mutation/expansion owners.
// Transport faults are injected; no BrowserWindow, PTY or provider is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {createWorkflowGroupClient,newerWorkflowGroups} from '../renderer/utils/workflowGroupClient.mjs';
import {createWorkflowGroupExpansionQueue} from '../renderer/utils/workflowGroupExpansion.mjs';
const require=createRequire(import.meta.url),SQLite=require('better-sqlite3'),Manager=require('./database');
const {createWorkflowOrganizationApi,registerWorkflowOrganizationIpc}=require('./workflow-organization-api');
const storeSource=fs.readFileSync(new URL('../renderer/store/useWorkspaceStore.ts',import.meta.url),'utf8');
const storeTree=ts.createSourceFile('store.ts',storeSource,ts.ScriptTarget.Latest,true);
const methods=new Map();
function findMethods(node){if(ts.isPropertyAssignment(node)&&['mutateWorkflowGroup','refreshWorkflowGroups'].includes(node.name.getText(storeTree)))
  methods.set(node.name.getText(storeTree),node.initializer.getText(storeTree));ts.forEachChild(node,findMethods);}
findMethods(storeTree);assert.equal(methods.size,2);
const methodsCode=ts.transpileModule('({'+[...methods].map(([key,value])=>key+':'+value).join(',')+'})',
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-group-client-native-')),filename=path.join(root,'private.db');
  let db,api,handlers;
  const reopen=()=>{
    if(db?.open)db.close();db=new SQLite(filename);db.pragma('foreign_keys=ON');
    const manager=new Manager({existingConnection:db});manager.initTables();
    api=createWorkflowOrganizationApi({database:manager});handlers=new Map();
    registerWorkflowOrganizationIpc({handle:(key,fn)=>{assert.ok(!handlers.has(key));handlers.set(key,fn);}},api);
  };
  reopen();
  api.bootstrap({migrationId:'M',mutationId:'activate',workspace:{activeSpaceId:'main',
    spaces:[{id:'main',name:'Main',projectIds:[],layout:{}},{id:'other',name:'Other',projectIds:[],layout:{}}]}});
  const made=api.groups.mutate('create',{version:1,mutationId:'make-group',expectedRevision:api.groups.meta().revision,
    metadata:{name:'terminal',collapsed:true,color:'purple',notes:'keep',future:{untouched:1},reserveWorkflowId:'main'}});
  const groupId=made.groupId,requests=[],calls=[];
  let state=api.groups.read(),sequence=0,hook=null;
  const invoke=async(channel,payload)=>{
    calls.push(channel);if(channel==='workflow:group-mutate')requests.push(structuredClone(payload));
    const actual=()=>handlers.get(channel)(null,structuredClone(payload));
    return hook?hook(channel,payload,actual):actual();
  };
  const client=createWorkflowGroupClient({invoke,publish:incoming=>{state=newerWorkflowGroups(state,incoming);}});
  const store=vm.runInNewContext(methodsCode,{workflowGroupClient:client});
  const expand=createWorkflowGroupExpansionQueue({read:()=>state,refresh:store.refreshWorkflowGroups,mutate:request=>store.mutateWorkflowGroup('collapse',request),
    mutationId:()=>`ui-${++sequence}`});
  const request=patch=>({version:1,mutationId:`direct-${++sequence}`,expectedRevision:state.revision,
    groupId,expectedGroupRevision:state.groups.find(g=>g.id===groupId).revision,...patch});
  const foreign=patch=>api.groups.mutate('rename',{...request(patch),expectedRevision:api.groups.meta().revision,
    expectedGroupRevision:api.groups.group(groupId).revision});
  t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);});
  return {root,groupId,client,expand,request,foreign,requests,calls,reopen,get api(){return api;},get db(){return db;},
    get state(){return state;},set hook(value){hook=value;},publish:incoming=>{state=newerWorkflowGroups(state,incoming);}};
}

test('grouped tab allocation advances Main group clock: old clicks stay stale; fresh guarded expansion succeeds',async t=>{
  const f=fixture(t),old=f.state;
  const child=f.api.createTab({mutationId:'new-child',tabId:'child',cwd:f.root,workflowId:'main',record:{globalGroupId:f.groupId}});
  assert.equal(f.api.groups.meta().revision,old.revision+1);
  assert.equal(f.api.groups.group(f.groupId).revision,old.groups[0].revision);
  assert.equal(child.globalGroups,undefined,'allocation ACK does not contain group publication');
  for(let n=0;n<3;n++)assert.throws(()=>f.api.groups.mutate('collapse',f.request({collapsed:false})),/workflow_group_revision_changed/);
  const before=f.api.service.getTab('child');
  assert.equal(await f.expand(f.groupId,true),true);
  assert.equal(f.api.groups.group(f.groupId).collapsed,false);
  assert.equal(f.requests[0].request.expectedRevision,old.revision+1);
  assert.deepEqual(f.api.service.getTab('child'),before,'collapse leaves subject/cwd/membership intact');
  assert.equal(f.api.groups.group(f.groupId).notes,'keep');assert.deepEqual(f.api.groups.group(f.groupId).future,{untouched:1});
});

test('changed target definition refreshes UI but does not overwrite a foreign rename or falsely ACK expansion',async t=>{
  const f=fixture(t);f.foreign({name:'renamed elsewhere'});
  await assert.rejects(f.expand(f.groupId,true),error=>error.disposition==='not-applied'&&/definition_changed/.test(error.message));
  assert.equal(f.requests.length,0);assert.equal(f.state.groups[0].name,'renamed elsewhere');
  assert.equal(f.api.groups.group(f.groupId).collapsed,true);
  assert.equal(await f.expand(f.groupId,true),true,'a new explicit click uses the now-published definition');
});

test('deleted exact group cannot become an affirmative expansion',async t=>{
  const f=fixture(t);f.api.groups.mutate('delete',f.request({}));
  assert.equal(await f.expand(f.groupId,true),false);assert.equal(f.requests.length,0);
});

test('committed but lost IPC ACK recovers durable receipt after SQLite reopen without another mutation',async t=>{
  const f=fixture(t);let lose=true;
  f.hook=(channel,payload,actual)=>{
    const result=actual();if(channel==='workflow:group-mutate'&&lose){lose=false;f.reopen();throw Error('IPC reply lost');}return result;
  };
  assert.equal(await f.expand(f.groupId,true),true);assert.equal(f.requests.length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM workflow_group_mutations WHERE mutation_id LIKE 'ui-%'").get().n,1);
});

test('lost ACK and unavailable receipt preserve exact expansion; cancel waits for recovery, then uses its ACK revision',async t=>{
  const f=fixture(t);let lose=true,offline=true;
  f.hook=(channel,payload,actual)=>{
    if(channel==='workflow:group-mutation'&&offline)throw Error('receipt unavailable');
    const result=actual();if(channel==='workflow:group-mutate'&&lose){lose=false;throw Error('IPC reply lost');}return result;
  };
  await assert.rejects(f.expand(f.groupId,true),error=>error.disposition==='unknown');
  const first=f.requests[0].request;offline=false;f.reopen();
  assert.equal(await f.expand(f.groupId,false),true);
  assert.equal(f.requests.length,2,'first operation recovered by receipt; only cancel adds another write');
  assert.notEqual(f.requests[1].request.mutationId,first.mutationId);
  assert.equal(f.requests[1].request.expectedRevision,first.expectedRevision+1);
  assert.equal(f.api.groups.group(f.groupId).collapsed,true);
});

test('unknown before admission retries only the same request and blocks a different intent until resolved',async t=>{
  const f=fixture(t);let offline=true;
  f.hook=(channel,payload,actual)=>{if(offline&&channel!=='workflow:groups-read')throw Error('transport unavailable');return actual();};
  const original=f.request({collapsed:false});
  await assert.rejects(f.client.mutate('collapse',original),error=>error.disposition==='unknown');
  await assert.rejects(f.client.mutate('rename',f.request({name:'later'})),error=>error.disposition==='unknown');
  assert.equal(f.requests.length,2);assert.deepEqual(f.requests[1],f.requests[0]);
  offline=false;assert.equal((await f.client.mutate('collapse',original)).success,true);
  assert.deepEqual(f.requests[2],f.requests[0]);assert.equal(f.api.groups.group(f.groupId).name,'terminal');
});

test('Main still rejects a race after refresh; error contains exact operation and refresh enables next click',async t=>{
  const f=fixture(t);let race=true;
  f.hook=(channel,payload,actual)=>{
    if(channel==='workflow:group-mutate'&&race){race=false;f.api.groups.mutate('create',{
      version:1,mutationId:'racing-group',expectedRevision:f.api.groups.meta().revision,metadata:{name:'foreign',reserveWorkflowId:'other'}});}
    return actual();
  };
  await assert.rejects(f.expand(f.groupId,true),error=>{
    assert.equal(error.disposition,'not-applied');assert.equal(error.workflowOperation.groupId,f.groupId);
    assert.equal(error.workflowOperation.currentRevision,error.workflowOperation.expectedRevision+1);
    assert.equal(error.workflowOperation.mutationId,f.requests[0].request.mutationId);return true;
  });
  assert.equal(f.api.groups.group(f.groupId).collapsed,true);
  assert.equal(await f.expand(f.groupId,true),true);
  assert.equal(f.api.groups.read().groups.find(g=>g.name==='foreign').reserveWorkflowId,'other');
});

test('late publication/receipt cannot roll back newer group metadata on an independent organization clock',async t=>{
  const f=fixture(t),old=f.state;
  assert.equal(await f.expand(f.groupId,true),true);const current=f.state;
  f.publish(old);assert.equal(f.state,current);assert.equal(f.state.groups[0].collapsed,false);
  const {organizationProjection}=await import('../renderer/utils/workflowOrganizationClient.mjs');
  const snapshot=f.api.read();snapshot.globalGroups=old;
  const projected=organizationProjection(snapshot,{activeSpaceId:'main',globalGroups:current});
  assert.equal(projected.globalGroups,current);
});
