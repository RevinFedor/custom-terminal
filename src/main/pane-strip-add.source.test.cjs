'use strict';
// SOURCE controls: the real shared validators and Main commitWorkspace/mutate
// run against a synchronous in-memory storage port. This does not run SQLite,
// Electron, application state, providers, or an execution/runtime owner.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.PANE_STRIP_ADD_SOURCE_ROOT||path.resolve(__dirname,'../..');
const {WorkflowOrganization,INBOX_WORKFLOW_ID}=require(path.join(root,'src/main/workflow-organization.js'));
const {clone,stableJson}=require(path.join(root,'src/shared/workflow-organization.cjs'));
const {paneStripColorGroupsBasis,mergePaneStripColorGroups,paneStripColorGroupEdits,
  addPaneStripGroupSlots,assertPaneStripGather}=require(path.join(root,'src/shared/pane-strip-color-groups.cjs'));
const {preparePaneStripGroupRelease}=require(path.join(root,'src/shared/pane-strip-group-admission.cjs'));

const slot=id=>({projectId:'P',tabId:id,extension:{id,keep:true}});
const field=()=>({version:1,revision:7,extension:{future:[1,{keep:true}]},groups:[
  {id:'g',revision:4,color:'#c4b5fd',collapsed:true,tabIds:['a','closed','b'],extension:{keep:'raw'}},
  {id:'h',revision:2,color:'#123456',tabIds:['u','v'],extension:{other:true}},
]});
const appended=(before,ids=['x','y'])=>({...clone(before),revision:before.revision+1,
  groups:before.groups.map(group=>group.id==='g'?{...clone(group),revision:group.revision+1,tabIds:[...group.tabIds,...ids]}:clone(group))});
const layout=()=>({splitPanes:[{windowId:'win',projectId:'P',tabId:'b',selectedSlotId:null,
  tabs:[slot('x'),{slotId:'choose',cwd:'/chooser',extension:{keep:true}},slot('b'),slot('a'),slot('z'),slot('y'),slot('u'),slot('v')],
  extension:{window:true}}],centerStrips:{},activeProjectId:'P',focusedProjectId:'P',splitFocusedIndex:0,
  activeSpaceTab:{projectId:'P',tabId:'b',extension:{shown:true}},extension:{layout:true}});
const owner={windowId:'win',paneIndex:0,centerKey:null};
const pureEdit=(before,at=layout(),ids=['x','y'])=>({workflowId:'W',basis:paneStripColorGroupsBasis(before),
  add:{groupId:'g',tabIds:ids},gather:{owner:clone(owner),beforeSlots:clone(at.splitPanes[0].tabs)}});

function fixture({savedProfile=false,singleton=false,center=false}={}) {
  const raw=field(),live=layout();
  if(singleton){raw.groups[0].tabIds=['b','closed'];live.splitPanes[0].tabs=live.splitPanes[0].tabs.filter(value=>value.tabId!=='a');}
  if(savedProfile)live.windowDisplayLayouts={saved:{splitPanes:[{windowId:'saved-win',projectId:'P',tabId:'a',
    tabs:[slot('a'),slot('b'),slot('z'),slot('x'),slot('y')],extension:{profile:true}}],extension:{keep:true}}};
  if(center){live.centerStrips.P=live.splitPanes[0].tabs;live.splitPanes=[];}
  const tabs=Object.fromEntries(['a','b','closed','x','y','z','u','v','other'].map(tabId=>[tabId,{tabId,revision:9,subjectVersion:2,
    executionSubject:{version:2,tabId,subjectId:'subject-'+tabId,executionNamespace:'P',cwd:'/exact-cwd'},
    nativeRow:{id:'storage-'+tabId,tab_id:tabId,execution_subject_id:'subject-'+tabId,execution_namespace:'P',execution_subject_version:2,
      execution_archived:tabId==='closed'?1:0,cwd:'/exact-cwd',parent_tab_id:null,visual_parent_tab_id:null,input:'keep'},
    executionResolved:true,membership:{tabId,workflowId:tabId==='other'?'S':'W',revision:3},record:{model:'coauthor',goal:{keep:true}}}]));
  let model={publication:{version:1,generation:10,revision:10,migrationVersion:1,sourceFingerprint:'source',metadata:{keep:true}},
    workflows:{W:{id:'W',kind:'user',revision:5,metadata:{id:'W',version:1,name:'Work',stripColorGroups:raw,goal:{keep:true},model:'coauthor'},layout:live},
      S:{id:'S',kind:'user',revision:2,metadata:{id:'S',version:1,name:'Other'},layout:{splitPanes:[{windowId:'other-win',projectId:'P',tabId:'other',tabs:[slot('other')]}]}},
      [INBOX_WORKFLOW_ID]:{id:INBOX_WORKFLOW_ID,kind:'inbox',revision:1,metadata:{id:INBOX_WORKFLOW_ID,version:1},layout:{}}},
    tabs,mutations:{},journal:[],generations:[]};
  const counters={catalog:0,reads:0},published=[];
  const service=Object.create(WorkflowOrganization.prototype);
  service.db={inTransaction:false,transaction(fn){const run=()=>{const before=clone(model);service.db.inTransaction=true;
    try{return fn();}catch(error){model=before;throw error;}finally{service.db.inTransaction=false;}};run.immediate=run;return run;},prepare(sql){
    const normalized=sql.replace(/\s+/g,' ').trim();
    return {get(key){if(normalized==='SELECT * FROM workflow_org_mutations WHERE mutation_id=?')return model.mutations[key];
      throw Error('uncontrolled SELECT: '+normalized);},run(...args){
      if(normalized.startsWith('INSERT INTO workflow_org_journal(')){model.journal.push({generation:args[0],details:JSON.parse(args[1])});return;}
      if(normalized.startsWith('UPDATE workflow_org_workflows SET metadata_json=?,layout_json=?,revision=?')){
        const [metadata,at,revision,id]=args;Object.assign(model.workflows[id],{metadata:JSON.parse(metadata),layout:JSON.parse(at),revision});return;}
      if(normalized.startsWith('UPDATE workflow_org_memberships SET workflow_id=?,revision=revision+1')){
        const member=model.tabs[args[1]].membership;member.workflowId=args[0];member.revision++;return;}
      if(normalized==='UPDATE workflow_org_meta SET metadata_json=? WHERE singleton=1'){model.publication.metadata=JSON.parse(args[0]);return;}
      if(normalized.startsWith('INSERT INTO workflow_org_generations ')){model.generations.push(clone(args));return;}
      if(normalized.startsWith('INSERT INTO workflow_org_mutations ')){
        model.mutations[args[0]]={request_hash:args[1],request_json:args[2],response_json:args[3],generation:args[4]};return;}
      if(normalized.startsWith('UPDATE workflow_org_meta SET generation=?,revision=?,migration_version=?,source_fingerprint=?')){
        assert.equal(model.publication.revision,args[4]);Object.assign(model.publication,{generation:args[0],revision:args[1],migrationVersion:args[2],sourceFingerprint:args[3]});return;}
      throw Error('uncontrolled mutation: '+normalized);
    }};
  }};
  service.getPublication=()=>clone(model.publication);
  service.listWorkflows=()=>Object.values(model.workflows).map(clone);
  service.getWorkflow=id=>model.workflows[id]?clone(model.workflows[id]):null;
  service.getMembership=id=>model.tabs[id]?clone(model.tabs[id].membership):null;
  service.listGlobalTabs=()=>{counters.catalog++;return Object.values(model.tabs).map(clone);};
  service.prepareTabRead=()=>({});
  service.readTab=id=>{counters.reads++;return model.tabs[id]?clone(model.tabs[id]):null;};
  service.readState=()=>({publication:clone(model.publication),workflows:Object.values(model.workflows).map(clone),tabs:Object.values(model.tabs).map(clone)});
  service.scheduleSnapshotPrune=()=>{};service.publish=value=>published.push(value);service.fault=()=>{};
  let serial=0;
  const snapshot=()=>({mutationId:'source-'+(++serial),expectedRevision:model.publication.revision,
    spaces:Object.values(model.workflows).map(value=>({...clone(value.metadata),layout:clone(value.layout)})),
    tabWorkflowMembership:Object.fromEntries(Object.values(model.tabs).map(value=>[value.tabId,{...clone(value.membership),expectedMembershipRevision:value.membership.revision}]))});
  const request=()=>{const result=snapshot(),space=result.spaces.find(value=>value.id==='W'),before=space.stripColorGroups;
    const at=center?{windowId:null,paneIndex:null,centerKey:'P'}:clone(owner);
    const slots=center?space.layout.centerStrips.P:space.layout.splitPanes[0].tabs;
    const beforeSlots=clone(slots),byId=new Map(slots.filter(value=>value.tabId).map(value=>[value.tabId,value]));
    const order=singleton?['choose','b','x','y','z','u','v']:['choose','b','a','x','y','z','u','v'];
    const next=order.map(id=>id==='choose'?slots.find(value=>value.slotId==='choose'):byId.get(id));
    if(center)space.layout.centerStrips.P=next;else space.layout.splitPanes[0].tabs=next;
    space.stripColorGroups=appended(before);
    result.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(before),add:{groupId:'g',tabIds:['x','y']},gather:{owner:at,beforeSlots}}];
    return result;};
  return {service,counters,published,request,snapshot,get model(){return model;},before:()=>clone(model)};
}

test('Add exact append preserves raw closed provenance, extensions, singleton and existing visual member order',()=>{
  const before=field(),edit=pureEdit(before),next=appended(before),isMember=id=>({member:true,active:id!=='closed'});
  assert.equal(mergePaneStripColorGroups(before,next,edit,isMember),next);
  assert.deepEqual(next.groups[0].tabIds,['a','closed','b','x','y']);
  assert.deepEqual(next.groups[1],before.groups[1]);assert.deepEqual(next.extension,before.extension);
  const at=layout(),slots=addPaneStripGroupSlots(at.splitPanes[0].tabs,before.groups[0].tabIds,['x','y']);
  assert.deepEqual(slots.map(value=>value.tabId||value.slotId),['choose','b','a','x','y','z','u','v']);
  for(const value of slots)assert.ok(at.splitPanes[0].tabs.includes(value),'canonical slot references retained');
});
test('ordinary explicit recolor still cannot append members or turn into Add',()=>{
  const before=field();assert.throws(()=>mergePaneStripColorGroups(before,appended(before),{basis:paneStripColorGroupsBasis(before)}),/membership_changed/);
  const next={...clone(before),revision:8,groups:before.groups.map(value=>value.id==='g'?{...value,color:'#abcdef',revision:5}:value)};
  assert.equal(mergePaneStripColorGroups(before,next,{basis:paneStripColorGroupsBasis(before)},()=>({member:true,active:true})),next);
});
test('Add DTO rejects absent gather, arrange, malformed/duplicate/empty roots and unknown fields',()=>{
  const before=field(),edit=pureEdit(before),requested=new Map([['W',{}]]);
  for(const change of [value=>delete value.gather,value=>value.arrange={},value=>value.add=null,value=>value.add.tabIds=[],
    value=>value.add.tabIds=['x','x'],value=>value.add.tabIds=[''],value=>value.add.extra=true,value=>value.add.groupId='',value=>value.extra=true,
    value=>value.gather.beforeSlots[0]=null,value=>delete value.gather.beforeSlots[0].projectId,
    value=>value.gather.owner.centerKey='P',value=>value.gather.owner.paneIndex=null]) {
    const invalid=clone(edit);change(invalid);assert.throws(()=>paneStripColorGroupEdits(requested,[invalid]),/basis_invalid/);
  }
  assert.equal(paneStripColorGroupEdits(requested,[edit]).get('W'),edit);
});
test('Add exact raw comparison rejects recolor, collapse, removal, raw reorder and extension loss',()=>{
  const before=field(),edit=pureEdit(before);
  for(const change of [value=>value.groups[0].color='#ffffff',value=>value.groups[0].collapsed=false,
    value=>value.groups[0].tabIds.splice(1,1),value=>value.groups[0].tabIds.reverse(),value=>delete value.groups[0].extension,
    value=>value.groups.pop(),value=>delete value.extension]) {
    const invalid=appended(before);change(invalid);assert.throws(()=>mergePaneStripColorGroups(before,invalid,edit),/add_changed/);
  }
  assert.throws(()=>mergePaneStripColorGroups(before,before,edit),/revision_changed/);
});
test('Add only appends free active IDs; membership in another raw group and newly inactive or unknown roots reject',()=>{
  const before=field();
  for(const verdict of [false,{member:true,active:false},{member:true},{member:false,active:true}])
    assert.throws(()=>mergePaneStripColorGroups(before,appended(before),pureEdit(before),id=>id==='x'?verdict:{member:true,active:true}),/membership_changed/);
  assert.throws(()=>mergePaneStripColorGroups(before,appended(before,['u']),pureEdit(before,layout(),['u'])),/invalid|membership_changed/);
});
test('Add gather rejects split old run, chooser hole, reverse free order, duplicates and missing roots',()=>{
  const at=layout().splitPanes[0].tabs,ids=field().groups[0].tabIds;
  for(const bad of [[...at.slice(0,3),{slotId:'hole'},...at.slice(3)],at.filter(value=>value.tabId!=='x'),[...at,slot('x')]])
    assert.throws(()=>addPaneStripGroupSlots(bad,ids,['x','y']),/order_changed/);
  assert.throws(()=>addPaneStripGroupSlots(at,ids,['y','x']),/order_changed/);
  assert.throws(()=>addPaneStripGroupSlots(at,ids,['x','a']),/order_changed/);
});
test('Add gather proves exact mixed before order, actual owner and unchanged shown/focus; canonical extensions win',()=>{
  const before=field(),at=layout(),after=clone(at),edit=pureEdit(before,at);
  after.splitPanes[0].tabs=addPaneStripGroupSlots(at.splitPanes[0].tabs,before.groups[0].tabIds,['x','y']).map(value=>({tabId:value.tabId,projectId:value.projectId,slotId:value.slotId}));
  const accepted=assertPaneStripGather(at,after,before,appended(before),edit);
  assert.equal(accepted.slots[0],at.splitPanes[0].tabs[1]);
  for(const change of [value=>value.gather.beforeSlots.reverse(),value=>value.gather.owner.windowId='other',value=>value.gather.owner.windowId=null]) {
    const invalid=clone(edit);change(invalid);assert.throws(()=>assertPaneStripGather(at,after,before,appended(before),invalid),/order_changed/);
  }
  const shown=clone(after);shown.splitPanes[0].tabId='x';assert.throws(()=>assertPaneStripGather(at,shown,before,appended(before),edit),/order_changed/);
  const focused=clone(after);focused.focusedProjectId='Q';assert.throws(()=>assertPaneStripGather(at,focused,before,appended(before),edit),/order_changed/);
});
test('actual Main atomically accepts Add+gather; native execution/catalog/input and membership stay exact',()=>{
  const f=fixture(),before=f.before(),request=f.request(),result=f.service.commitWorkspace(request),after=f.model;
  assert.equal(result.revision,before.publication.revision+1);assert.equal(after.mutations[request.mutationId].generation,result.generation);
  assert.deepEqual(after.tabs,before.tabs);assert.deepEqual(after.workflows.W.metadata.stripColorGroups,appended(before.workflows.W.metadata.stripColorGroups));
  assert.deepEqual(after.workflows.W.layout.splitPanes[0].tabs.map(value=>value.tabId||value.slotId),['choose','b','a','x','y','z','u','v']);
  assert.deepEqual(after.workflows.W.metadata.goal,before.workflows.W.metadata.goal);assert.equal(f.counters.catalog,1);
  assert.deepEqual(after.journal.map(value=>value.details.reason),['snapshot-workflow']);assert.equal(after.generations.length,1);
});
test('actual Main accepts a singleton group and center owner through same Add transaction',()=>{
  for(const options of [{singleton:true},{center:true}]) {
    const f=fixture(options),before=f.before();f.service.commitWorkspace(f.request());
    assert.deepEqual(f.model.tabs,before.tabs);assert.deepEqual(f.model.workflows.W.metadata.stripColorGroups,appended(before.workflows.W.metadata.stripColorGroups));
  }
});
test('actual Main Add preserves normal unrelated metadata/settings/geometry merging without widening placement authority',()=>{
  const f=fixture(),request=f.request(),space=request.spaces.find(value=>value.id==='W'),other=request.spaces.find(value=>value.id==='S');
  space.name='Current name';space.goal={keep:true,coauthor:'accepted'};space.layout.splitSizes=[.7,.3];
  other.modelSettings={model:'neighbor',keep:true};f.service.commitWorkspace(request);
  assert.equal(f.model.workflows.W.metadata.name,'Current name');assert.deepEqual(f.model.workflows.W.metadata.goal,{keep:true,coauthor:'accepted'});
  assert.deepEqual(f.model.workflows.W.layout.splitSizes,[.7,.3]);assert.deepEqual(f.model.workflows.S.metadata.modelSettings,{model:'neighbor',keep:true});
  assert.equal(f.model.workflows.W.metadata.stripColorGroups.groups[0].color,'#c4b5fd');
});
test('actual Main Add preserves unchanged saved profile even when appended member gains a profile gap',()=>{
  const f=fixture({savedProfile:true}),saved=clone(f.model.workflows.W.layout.windowDisplayLayouts);f.service.commitWorkspace(f.request());
  assert.deepEqual(f.model.workflows.W.layout.windowDisplayLayouts,saved);
});
test('actual Main Add rejects forged profile/other owner placement and rolls back all field/order work',()=>{
  for(const change of [request=>request.spaces.find(value=>value.id==='W').layout.windowDisplayLayouts.saved.splitPanes[0].tabs.reverse(),
    request=>request.spaces.find(value=>value.id==='S').layout.splitPanes[0].tabs.push({slotId:'unrelated-chooser'}),
    request=>request.spaces.find(value=>value.id==='W').layout.splitPanes.push({windowId:'forged',tabs:[slot('x')]})]) {
    const f=fixture({savedProfile:true}),before=f.before(),request=f.request();change(request);
    assert.throws(()=>f.service.commitWorkspace(request),/order_changed/);assert.deepEqual(f.model,before);assert.equal(f.published.length,0);
  }
});
test('actual Main Add rejects every global membership transfer/revision spoof before any journal/write',()=>{
  for(const change of [value=>value.workflowId='W',value=>value.revision++,value=>value.expectedMembershipRevision++,
    value=>delete value.expectedMembershipRevision,value=>value.tabId='x']) {
    const f=fixture(),before=f.before(),request=f.request();change(request.tabWorkflowMembership.other);
    assert.throws(()=>f.service.commitWorkspace(request),/membership_changed/);assert.deepEqual(f.model,before);
  }
});
test('actual Main Add requires active exact binding/namespace and all live old members in its owner; unknown is not archived',()=>{
  for(const change of [model=>model.tabs.x.nativeRow.execution_archived=1,model=>{model.tabs.x.executionResolved=false;model.tabs.x.nativeRow=null;},
    model=>{model.tabs.closed.executionResolved=false;model.tabs.closed.nativeRow=null;},
    model=>model.tabs.x.executionSubject.executionNamespace='Q',model=>model.tabs.a.executionSubject.executionNamespace='Q',
    model=>model.tabs.a.membership.workflowId='S',model=>model.workflows.W.layout.splitPanes[0].tabs.splice(3,1)]) {
    const f=fixture(),request=f.request();change(f.model);const before=f.before();
    assert.throws(()=>f.service.commitWorkspace(request),/membership_changed|order_changed/);assert.deepEqual(f.model,before);
  }
});
test('actual Main Add exact field/owner/order basis rejects newer recolor, raw extension or order without resurrection',()=>{
  for(const change of [model=>model.workflows.W.metadata.stripColorGroups.groups[0].color='#ffffff',
    model=>model.workflows.W.metadata.stripColorGroups.extension.extra=true,
    model=>model.workflows.W.layout.splitPanes[0].tabs.reverse()]) {
    const f=fixture(),request=f.request();change(f.model);const before=f.before();
    assert.throws(()=>f.service.commitWorkspace(request),/revision_changed|order_changed/);assert.deepEqual(f.model,before);
  }
});
test('actual Main Add rejects mixed field edits, workflow create/delete and top-level pseudo Add',()=>{
  for(const change of [request=>request.stripColorGroupEdits.push({workflowId:'S',basis:paneStripColorGroupsBasis(undefined)}),
    request=>request.spaces.push({id:'new',version:1,layout:{}}),request=>request.spaces=request.spaces.filter(value=>value.id!=='S'),
    request=>request.add={groupId:'g',tabIds:['x']}]) {
    const f=fixture(),before=f.before(),request=f.request();change(request);
    assert.throws(()=>f.service.commitWorkspace(request),/add_changed|basis_invalid/);assert.deepEqual(f.model,before);
  }
});
test('actual Main Add cannot carry an otherwise valid B5 release for another workflow',()=>{
  const f=fixture(),before=f.before(),request=f.request(),at=f.model.workflows.S.layout;
  request.stripGroupReleases=[preparePaneStripGroupRelease({workflowId:'S',beforeLayout:at,layout:at,
    rootTabIds:['other'],targetOwner:{windowId:'other-win',paneIndex:0,centerKey:null},isActive:()=>true}).intent];
  assert.throws(()=>f.service.commitWorkspace(request),/add_changed/);assert.deepEqual(f.model,before);
});
test('actual Main same-ID lost ACK recovery is exact and cannot apply Add twice after later work',()=>{
  const f=fixture(),request=f.request();f.service.fault=phase=>{if(phase==='afterCommit')throw Error('lost ACK');};
  assert.throws(()=>f.service.commitWorkspace(request),/lost ACK/);const accepted=f.before();
  f.model.workflows.W.metadata.stripColorGroups.groups[0].color='#abcdef';f.model.publication.revision++;
  const later=f.before();f.service.fault=()=>{};const recovered=f.service.commitWorkspace(request);
  assert.equal(recovered.revision,accepted.publication.revision);assert.deepEqual(f.model,later);
  const changed=clone(request);changed.stripColorGroupEdits[0].add.tabIds.reverse();
  assert.throws(()=>f.service.commitWorkspace(changed),/mutation_id_conflict/);assert.deepEqual(f.model,later);
});
test('actual Main rollback before publication marker leaves no Add metadata, order, journal or mutation receipt',()=>{
  const f=fixture(),before=f.before();f.service.fault=phase=>{if(phase==='beforePublicationMarker')throw Error('controlled rollback');};
  assert.throws(()=>f.service.commitWorkspace(f.request()),/controlled rollback/);assert.deepEqual(f.model,before);assert.equal(f.published.length,0);
});
test('ordinary Main snapshot membership move and ordinary pair gap rejection retain CURRENT behavior',()=>{
  const f=fixture(),request=f.snapshot();request.tabWorkflowMembership.other.workflowId='W';
  // Existing generic snapshot prunes the former source placement.
  f.service.commitWorkspace(request);assert.equal(f.model.tabs.other.membership.workflowId,'W');
  const g=fixture(),before=g.before(),gap=g.snapshot(),at=gap.spaces.find(value=>value.id==='W').layout.splitPanes[0].tabs;
  [at[3],at[4]]=[at[4],at[3]];
  assert.throws(()=>g.service.commitWorkspace(gap),/pair_conflict/);assert.deepEqual(g.model,before);
});
