import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {transformSync} from 'esbuild';

const root=process.env.NOTED_ADD_SOURCE_ROOT?path.resolve(process.env.NOTED_ADD_SOURCE_ROOT)
  :path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const actual=relative=>import(pathToFileURL(path.join(root,relative)));
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const {commitPaneStripGroupAdd}=await actual('src/renderer/utils/paneStripGroupAddCommit.mjs');
const {createOrganizationCommitter,organizationSnapshot,organizationProjection,reconcileWorkflowOrder}=await actual('src/renderer/utils/workflowOrganizationClient.mjs');
const groups=await actual('src/renderer/utils/paneStripGroupsModel.mjs');
const pairs=await actual('src/renderer/utils/paneStripReleasePair.mjs');
const {emptySpaceLayout,captureSpaceLayout}=await actual('src/renderer/utils/workspaceSpacesModel.mjs');
const raw=await actual('src/shared/pane-strip-color-groups.cjs');
const {preparePaneStripGroupRelease,assertPaneStripGroupRelease}=await actual('src/shared/pane-strip-group-admission.cjs');
const {dragPlacement}=await actual('src/shared/workflow-drag.cjs');
const {mergeLayout}=await actual('src/shared/workflow-organization.cjs');
const {newerWorkflowGroups}=await actual('src/renderer/utils/workflowGroupClient.mjs');
const clone=structuredClone,entry=tabId=>({projectId:'P',tabId,extension:{tabId}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const owner={workflowId:'W',windowId:'win',paneIndex:0};
const proofOwner={windowId:'win',paneIndex:0,centerKey:null};

// Actual source helper, lane, pair and Store publication; IPC/Main durability
// is a finite controlled port. Separate native tests own real SQLite evidence.
function fixture({moving=false,center=false,singleton=false,loseAddAck=false,loseReleaseAck=false,publicationThrows=false,rejectRoot=null,onAdoption}={}) {
  const slots=[...(moving?[]:[entry('x')]),entry('u'),entry('b'),...(!singleton?[entry('a')]:[]),
    {slotId:'chooser',extension:{kept:true}},entry('y'),entry('tail')];
  const layout={...emptySpaceLayout(),activeProjectId:'P',focusedProjectId:'P',activeSpaceTab:entry('b'),
    ...(center?{centerStrips:{P:slots}}:{splitPanes:[{windowId:'win',projectId:'P',tabId:'b',tabs:slots,history:[entry('a')]}]})};
  const source={...emptySpaceLayout(),activeProjectId:'P',splitPanes:[{windowId:'source',projectId:'P',tabId:moving?'x':'',tabs:moving?[entry('x'),entry('z')]:[]}]};
  const field={version:1,revision:7,extension:{field:'keep'},groups:[{id:'g',revision:3,color:'#abcdef',collapsed:true,
    extension:{group:'keep'},tabIds:singleton?['b','closed']:['a','closed','b']}]};
  const ids=['a','b','closed','x','y','z','u','tail'];
  const state={...clone(layout),activeSpaceId:'W',navigationRevision:4,organizationReady:true,isRestoring:false,
    organizationRevision:1,organizationGeneration:1,organizationWorkflowOrder:['W','S'],
    spaces:[{id:'W',kind:'user',stripColorGroups:clone(field),layout:clone(layout),goal:'keep goal'},
      {id:'S',kind:'user',layout:clone(source),model:'keep model'}],
    tabWorkflowMembership:Object.fromEntries(ids.map(id=>[id,{tabId:id,workflowId:moving&&['x','z'].includes(id)?'S':'W',revision:1}])),
    pendingTabWorkflowMembership:{},paneStripReleasedPairs:{version:1,workflows:{},commands:{}},
    tabCatalog:Object.fromEntries(ids.map(id=>[id,{tabId:id,active:id!=='closed',namespace:'P',storageId:id==='closed'?null:id,
      physicalParentTabId:null,executionSubject:{projectId:'P'},subjectVersion:1}])),
    openProjects:new Map([['P',{projectId:'P',projectPath:'/fixture',activeTabId:'b',tabs:new Map(ids.filter(id=>id!=='closed')
      .map(id=>[id,{id,cwd:'/fixture',input:'keep input',tabType:'terminal',model:'keep tab model'}]))}]]),
    globalGroups:{version:1,revision:1,groups:[],tabGroups:{},membershipRevisions:{}},
    paneStripSelectedFirst:true,paneStripCloseOnClick:true,paneStripOpenOnHover:true};
  let mainSpaces=clone(state.spaces),mainMembers=clone(state.tabWorkflowMembership),revision=1,leaseCurrent=true,lost=false,hidden=false,thrown=false,lostRelease=false,hiddenRelease=false;
  const writes=[],receipts=new Map(),gate=deferred(),entered=deferred();
  const store={getState:()=>state,setState:patch=>Object.assign(state,patch)};
  const snapshot=()=>({publication:{version:1,migrationVersion:1,revision,generation:1,metadata:{workflowOrder:['W','S']}},
    workflows:mainSpaces.map(space=>({id:space.id,kind:'user',revision,
      metadata:{...(space.stripColorGroups?{stripColorGroups:clone(space.stripColorGroups)}:{})},layout:clone(space.layout)})),
    tabs:Object.entries(mainMembers).map(([tabId,membership])=>({tabId,membership:clone(membership),subjectVersion:1,
      legacyRow:tabId==='closed'?null:{id:tabId},executionSubject:{projectId:'P'},revision:1})),globalGroups:state.globalGroups});
  const full=read('src/renderer/store/useWorkspaceStore.ts'),start=full.indexOf('  applyPublication:async (result:any,request:any,diagnostic?'),end=full.indexOf('\n  onError:',start);
  assert.ok(start>0&&end>start);
  const callback=full.slice(start,end).trim().replace(/^applyPublication:/,'').replace(/,$/,'');
  const module={exports:{}};
  vm.runInNewContext(transformSync('module.exports=('+callback+');',{loader:'ts',format:'cjs'}).code,
    {module,exports:module.exports,useWorkspaceStore:store,ipcRenderer:{invoke:async channel=>{assert.equal(channel,'workflow:read');return snapshot();}},
      organizationProjection,reconcileWorkflowOrder,newerWorkflowGroups,applyPaneStripGatherPublication:groups.applyPaneStripGatherPublication,
      adoptPaneStripColorGroups:raw.adoptPaneStripColorGroups,applyPaneStripReleasePublication:pairs.applyPaneStripReleasePublication,
      uiDiagnosticAbsNow:()=>0,uiDragActionId:id=>id,uiDragDiagnostic:()=>{}});
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),onError(){},
    applyPublication:async(result,request)=>{const value=await module.exports(result,request);onAdoption?.({state,mainSpaces,mainMembers,request});
      if(publicationThrows&&request.stripColorGroupEdits?.length&&!thrown){thrown=true;throw Error('publication_notification_failed');}return value;},
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation'){
        if(loseReleaseAck&&String(payload).startsWith('B5-free-')&&!hiddenRelease){hiddenRelease=true;return null;}
        if(loseAddAck&&!hidden){hidden=true;return null;}return receipts.get(payload)||null;
      }
      assert.equal(channel,'workflow:mutate');const {kind,request}=payload;writes.push({kind,request:clone(request)});
      if(receipts.has(request.mutationId))return receipts.get(request.mutationId);
      if(kind==='commitDrag'||request.controlledBlocker){entered.resolve();await gate.promise;}
      if(request.stripGroupReleases?.length){
        const changes=kind==='commitDrag'?request.workflows:request.spaces.map(space=>({workflowId:space.id,layout:space.layout}));
        const movingId=request.stripGroupReleases[0].rootTabIds[0];
        if(movingId===rejectRoot)throw Object.assign(Error('workflow_membership_revision_changed'),{code:'workflow_membership_revision_changed',disposition:'not-applied'});
        const target=kind==='commitDrag'?request.targetWorkflowId:request.tabWorkflowMembership[movingId].workflowId;
        for(const intent of request.stripGroupReleases){const old=mainSpaces.find(space=>space.id===intent.workflowId),change=changes.find(value=>value.workflowId===old.id);
          assertPaneStripGroupRelease(intent,{workflowId:old.id,field:old.stripColorGroups,beforeLayout:old.layout,layout:change.layout,
            rootTabIds:[movingId],placementTabIds:[movingId],targetOwner:old.id===target?{paneIndex:0,windowId:target==='W'?'win':'source',centerKey:null}:null,
            isActive:id=>id!=='closed'});}
        const moving=request.tabs?.find(value=>value.tabId===movingId),local=request.tabWorkflowMembership?.[movingId];
        if(moving){assert.equal(moving.expected.workflowId,mainMembers[movingId].workflowId);assert.equal(moving.expected.membershipRevision,mainMembers[movingId].revision);}
        else {assert.equal(local.expectedMembershipRevision,mainMembers[movingId].revision);assert.equal(local.revision,mainMembers[movingId].revision+Number(local.workflowId!==mainMembers[movingId].workflowId));}
        mainMembers[movingId]=moving?{tabId:movingId,workflowId:moving.workflowId,revision:moving.expected.membershipRevision+Number(moving.workflowId!==moving.expected.workflowId)}
          :{tabId:movingId,workflowId:local.workflowId,revision:local.revision};
        mainSpaces=mainSpaces.map(space=>{const change=changes.find(value=>value.workflowId===space.id),intent=request.stripGroupReleases.find(value=>value.workflowId===space.id);
          return change?{...space,layout:clone(change.layout),...(intent?{stripColorGroups:clone(intent.nextState)}:{})}:space;});
      } else {
        if(!request.stripColorGroupEdits)mainSpaces=mainSpaces.map(space=>{const next=request.spaces.find(value=>value.id===space.id);
          return next?{...space,layout:mergeLayout(space.layout,next.layout)}:space;});
        for(const edit of request.stripColorGroupEdits||[]){
          for(const[id,member]of Object.entries(request.tabWorkflowMembership)){
            assert.equal(member.workflowId,mainMembers[id].workflowId);assert.equal(member.revision,mainMembers[id].revision);
            assert.equal(member.expectedMembershipRevision,mainMembers[id].revision);
          }
          const old=mainSpaces.find(space=>space.id===edit.workflowId),next=request.spaces.find(space=>space.id===edit.workflowId);
          const field=raw.mergePaneStripColorGroups(old.stripColorGroups,next.stripColorGroups,edit,id=>({active:id!=='closed',member:mainMembers[id]?.workflowId==='W'}));
          const proposedLayout=mergeLayout(old.layout,next.layout);
          const gathered=raw.assertPaneStripGather(old.layout,proposedLayout,old.stripColorGroups,field,edit);
          old.stripColorGroups=field;old.layout=proposedLayout;
          if(gathered?.pane)old.layout.splitPanes[gathered.paneIndex].tabs=clone(gathered.slots);
          else if(gathered)old.layout.centerStrips[gathered.centerKey]=clone(gathered.slots);
        }
      }
      const result={success:true,revision:++revision,generation:1,mutationId:request.mutationId};receipts.set(request.mutationId,result);
      if(loseReleaseAck&&kind==='commitDrag'&&!lostRelease){lostRelease=true;throw Error('controlled_lost_free_B5_ack');}
      if(loseAddAck&&request.stripColorGroupEdits?.length&&!lost){lost=true;throw Error('controlled_lost_Add_ack');}return result;
    }});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const selection=(ids=['a','y','x'])=>({version:1,workflowId:'W',windowId:center?null:'win',paneIndex:center?null:0,entries:ids.map(entry),
    isCurrent:()=>leaseCurrent&&state.navigationRevision===4&&ids.every(id=>state.tabWorkflowMembership[id]?.workflowId==='W'),
    isGroupCurrent:()=>leaseCurrent&&state.navigationRevision===4&&groups.paneStripSelectionMembershipCurrent(state,
      {...owner,windowId:center?null:'win',paneIndex:center?null:0},ids.map(entry))});
  const release=(target='W',{local=false,tabId='x'}={})=>{
    const beforeSnapshot=organizationSnapshot(state),beforeW=captureSpaceLayout(state),beforeS=state.spaces[1].layout;
    const nextW=clone(beforeW),nextS=clone(beforeS),into=target==='W';
    nextW.splitPanes[0].tabs=nextW.splitPanes[0].tabs.filter(slot=>slot.tabId!==tabId);
    if(into)nextW.splitPanes[0].tabs.push(entry(tabId)); // free edge, not ordinary IN joining the old group
    nextS.splitPanes[0].tabs=nextS.splitPanes[0].tabs.filter(slot=>slot.tabId!==tabId);
    if(!into)nextS.splitPanes[0].tabs.push(entry(tabId));nextS.splitPanes[0].tabId=nextS.splitPanes[0].tabs[0]?.tabId||'';
    const nextSpaces=state.spaces.map(space=>({...space,layout:space.id==='W'?nextW:nextS}));
    if(local){const publication=pairs.preparePaneStripLocalRelease(state,nextSpaces,{rootTabIds:[tabId],targetWorkflowId:target,
        targetOwner:{paneIndex:0,windowId:into?'win':'source',centerKey:null}});
      store.setState({...publication,...publication.spaces[0].layout});
      return pairs.enqueuePaneStripLocalRelease({getState:()=>state,setState:store.setState,committer,snapshot:organizationSnapshot(state)});}
    const prepared=preparePaneStripGroupRelease({workflowId:'W',field:state.spaces[0].stripColorGroups,beforeLayout:beforeW,layout:nextW,
      rootTabIds:[tabId],placementTabIds:[tabId],targetOwner:into?proofOwner:null,isActive:id=>id!=='closed'});
    assert.deepEqual(prepared.intent.plan.assignments,[{tabId,groupId:null}]);
    const member=state.pendingTabWorkflowMembership[tabId]||state.tabWorkflowMembership[tabId];
    const request={mutationId:'B5-free-'+tabId+'-'+target+'-'+member.revision,version:1,expectedRevision:state.organizationRevision,targetWorkflowId:target,destinationKind:'window',
      tabs:[{tabId,workflowId:target,expected:{workflowId:member.workflowId,membershipRevision:member.revision}}],
      workflows:[{workflowId:'W',beforeLayout:beforeW,expectedPlacement:dragPlacement(beforeW),layout:nextW,reserveOrder:[],reserveRootOrder:[]},
        {workflowId:'S',beforeLayout:beforeS,expectedPlacement:dragPlacement(beforeS),layout:nextS,reserveOrder:[],reserveRootOrder:[]}],
      stripGroupReleases:[prepared.intent]};
    store.setState(pairs.publishPaneStripDragRelease(state,request));
    return committer.command('commitDrag',request,{beforeSnapshot,isCurrent:()=>!!state.paneStripReleasedPairs.commands[request.mutationId],
      onStage:event=>store.setState(pairs.notePaneStripReleaseStage(state,event))});
  };
  return {state,store,committer,selection,release,writes,gate,entered,
    add:lease=>commitPaneStripGroupAdd({getState:()=>state,committer,lease:lease||selection(),groupId:'g'}),
    revoke:()=>{leaseCurrent=false;},get mainSpaces(){return mainSpaces;},get mainMembers(){return mainMembers;}};
}

for(const mode of ['window','center','singleton'])test(`explicit Add ${mode}: preserve raw closed/unselected members, append visual free order, retain slots and runtime identity`,async()=>{
  const f=fixture({center:mode==='center',singleton:mode==='singleton'}),before=clone(f.state.spaces[0].stripColorGroups),tabs=new Map(f.state.openProjects.get('P').tabs);
  const selection=f.selection([mode==='singleton'?'b':'a','y','x']);await f.add(selection);
  const field=f.state.spaces[0].stripColorGroups,slots=mode==='center'?f.state.centerStrips.P:f.state.splitPanes[0].tabs;
  assert.deepEqual(field.groups[0].tabIds,[...before.groups[0].tabIds,'x','y']);
  assert.deepEqual(field.extension,before.extension);assert.deepEqual(field.groups[0].extension,before.groups[0].extension);
  assert.equal(field.revision,8);assert.equal(field.groups[0].revision,4);assert.equal(field.groups[0].collapsed,true);assert.equal(field.groups[0].color,'#abcdef');
  assert.deepEqual(slots.map(slot=>slot.tabId||slot.slotId),['u','b',...(mode==='singleton'?[]:['a']),'x','y','chooser','tail']);
  for(const slot of slots)assert.ok(slot.extension);assert.equal(f.state.activeSpaceTab.tabId,'b');assert.equal(f.state.navigationRevision,4);
  for(const[id,tab]of tabs){assert.equal(f.state.openProjects.get('P').tabs.get(id),tab);assert.equal(tab.cwd,'/fixture');assert.equal(tab.input,'keep input');}
  assert.equal(f.state.spaces[0].goal,'keep goal');assert.equal(f.state.spaces[1].model,'keep model');
  assert.equal(f.state.paneStripOpenOnHover,true);assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits).length,1);
  assert.ok(f.writes.every(write=>!write.request.stripGroupReleases));
});

for(const local of [false,true])for(const chain of [false,true])test(`explicit Add free B5 ${local?'ordinary queued':'command'} ${chain?'IN/OUT/IN':'IN'} survives exact own adoption`,async()=>{
  const f=fixture({moving:true});let blocker;
  if(local){blocker=f.committer.commit(()=>({...organizationSnapshot(f.state),controlledBlocker:true}));await f.entered.promise;}
  const first=f.release('W',{local});first.catch(()=>{});if(!local)await f.entered.promise;
  const commands=chain?[f.release('S',{local}),f.release('W',{local})]:[];for(const command of commands)command.catch(()=>{});
  const lease=f.selection(['a','x']);assert.equal(lease.isCurrent(),false);assert.equal(lease.isGroupCurrent(),true);
  assert.equal(f.state.pendingTabWorkflowMembership.x.revision,chain?4:2);
  const pending=f.add(lease);await tick();assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
  f.gate.resolve();await blocker;await first;await Promise.all(commands);await pending;
  assert.equal(f.state.tabWorkflowMembership.x.revision,chain?4:2);assert.equal(f.state.pendingTabWorkflowMembership.x,undefined);
  assert.equal(f.state.paneStripReleasedPairs.workflows.W,undefined);
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b','x']);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits).length,1);
});

const staleCases=[
  ['recolor',f=>{f.state.spaces[0].stripColorGroups.groups[0].color='#fedcba';}],
  ['unjoin',f=>{f.state.spaces[0].stripColorGroups.groups[0].tabIds=['a','closed'];}],
  ['deleted group',f=>{f.state.spaces[0].stripColorGroups.groups=[];}],
  ['free root assigned elsewhere',f=>{f.state.spaces[0].stripColorGroups.groups.push({id:'other',revision:1,color:'#112233',tabIds:['x']});}],
  ['owner order',f=>{f.state.splitPanes[0].tabs.reverse();}],
  ['navigation',f=>{f.state.navigationRevision++;}],
  ['closed unselected old member',f=>{f.state.tabCatalog.b.active=false;f.state.openProjects.get('P').tabs.delete('b');}],
  ['closed selected free member',f=>{f.state.tabCatalog.x.active=false;f.state.openProjects.get('P').tabs.delete('x');}],
  ['same-ID reopened runtime object',f=>{f.state.openProjects.get('P').tabs.set('x',{...f.state.openProjects.get('P').tabs.get('x')});}],
  ['execution subject changed',f=>{f.state.tabCatalog.b.executionSubject={projectId:'other'};}],
  ['namespace changed',f=>{f.state.tabCatalog.x.namespace='other';}],
  ['newer canonical revision',f=>{f.state.tabWorkflowMembership.x.revision++;}],
  ['foreign canonical membership',f=>{f.state.tabWorkflowMembership.x.workflowId='S';}],
  ['unknown old activity',f=>{delete f.state.tabCatalog.b.active;}],
  ['unknown closed provenance',f=>{delete f.state.tabCatalog.closed.active;}],
];
for(const[name,alter]of staleCases)test(`explicit Add does not resurrect after ${name} during flush`,async()=>{
  const f=fixture(),flush=deferred();f.state.commitOrganization=()=>flush.promise;
  const pending=f.add();pending.catch(()=>{});await tick();alter(f);flush.resolve();
  await assert.rejects(pending,error=>/changed/.test(error.code||error.message));
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

for(const[name,alter]of [
  ['bare pending',s=>{s.paneStripReleasedPairs={version:1,workflows:{},commands:{}};}],
  ['unrelated command',s=>{s.pendingTabWorkflowMembership.x.localReleaseMutationId='other';}],
  ['missing null assignment',s=>{s.paneStripReleasedPairs.commands[s.pendingTabWorkflowMembership.x.localReleaseMutationId].request.stripGroupReleases[0].plan.assignments=[];}],
  ['wrong owner',s=>{s.paneStripReleasedPairs.workflows.W.layout.splitPanes[0].windowId='other';}],
  ['wrong raw',s=>{s.paneStripReleasedPairs.workflows.W.field.groups[0].color='#fedcba';}],
  ['unreconciled pair',s=>{s.paneStripReleasedPairs.workflows.W.status='unreconciled';}],
])test(`free B5 settings proof rejects ${name}`,async()=>{
  const f=fixture({moving:true}),command=f.release();command.catch(()=>{});await f.entered.promise;
  const envelope=clone(f.state.paneStripReleasedPairs),pending=clone(f.state.pendingTabWorkflowMembership);alter(f.state);
  const lease=f.selection(['a','x']);assert.equal(lease.isGroupCurrent(),false);await assert.rejects(f.add(lease));
  Object.assign(f.state,{paneStripReleasedPairs:envelope,pendingTabWorkflowMembership:pending});f.gate.resolve();await command;
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

test('Add UNKNOWN retries exact same mutation and acknowledges recovered own Add without another edit',async()=>{
  const f=fixture({loseAddAck:true}),lease=f.selection();await assert.rejects(f.add(lease),/controlled_lost_Add_ack/);
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b']);
  const result=await f.add(lease),attempts=f.writes.filter(write=>write.request.stripColorGroupEdits);
  assert.equal(result.unchanged,true);assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b','x','y']);
});

test('Add publication installed before notification error still recovers the same lane operation',async()=>{
  const f=fixture({publicationThrows:true}),lease=f.selection();await assert.rejects(f.add(lease),/publication_notification_failed/);
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b','x','y']);
  const result=await f.add(lease);assert.equal(result.unchanged,true);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits).length,1);
});

test('dead renderer lease after Add admission cannot discard durable accepted metadata',async()=>{
  let f;f=fixture({onAdoption:({request})=>{if(request.stripColorGroupEdits)f.revoke();}});
  await f.add();assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b','x','y']);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits).length,1);
});

test('Add cannot carry an unrelated membership transfer from a newer pending edit',async()=>{
  const f=fixture();f.state.commitOrganization=async()=>{f.state.pendingTabWorkflowMembership.tail={tabId:'tail',workflowId:'S',revision:2};};
  await assert.rejects(f.add(),{code:'strip_group_selection_changed'});
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

test('Add rejects an unrelated pending membership CAS even when target workflow and revision look unchanged',async()=>{
  const f=fixture();f.state.commitOrganization=async()=>{
    f.state.pendingTabWorkflowMembership.tail={tabId:'tail',workflowId:'W',revision:1,localReleaseExpectedMembershipRevision:0};};
  await assert.rejects(f.add(),{code:'strip_group_selection_changed'});
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

test('Add refuses an unrelated unreconciled pair rather than attaching a deferral to its field edit',async()=>{
  const f=fixture();f.state.commitOrganization=async()=>{
    const layout=clone(f.state.spaces[1].layout);
    f.state.paneStripReleasedPairs.workflows.S={workflowId:'S',status:'unreconciled',beforeLayout:layout,layout,
      intent:{version:2,workflowId:'S',rootTabIds:['z'],activeBasis:[['z',true]]},canonical:{layout}};
  };
  await assert.rejects(f.add(),{code:'strip_group_selection_changed'});
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

test('two independently queued free roots retain Add for earlier stationary x without inventing command history',async()=>{
  const f=fixture({moving:true}),blocker=f.committer.commit(()=>({...organizationSnapshot(f.state),controlledBlocker:true}));await f.entered.promise;
  const first=f.release('W',{local:true}),second=f.release('W',{local:true,tabId:'z'});
  first.catch(()=>{});second.catch(()=>{});
  assert.deepEqual(Object.keys(f.state.paneStripReleasedPairs.commands),[]);
  assert.deepEqual(f.state.paneStripReleasedPairs.workflows.W.intent.rootTabIds,['z']);
  assert.equal(f.state.pendingTabWorkflowMembership.x.localReleaseQueued,true);
  const lease=f.selection(['a','x']);assert.equal(lease.isCurrent(),false);assert.equal(lease.isGroupCurrent(),true);
  const pending=f.add(lease);f.gate.resolve();await blocker;await first;await second;await pending;
  assert.equal(f.state.tabWorkflowMembership.x.workflowId,'W');assert.equal(f.state.tabWorkflowMembership.z.workflowId,'W');
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b','x']);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits).length,1);
});

for(const[name,alter]of [
  ['unowned queued marker',s=>{delete s.paneStripReleasedPairs.workflows.W.queued;}],
  ['different stationary address',s=>{s.paneStripReleasedPairs.workflows.W.beforeLayout.splitPanes[0].tabs.find(slot=>slot.tabId==='x').projectId='other';}],
  ['missing before owner proof',s=>{s.paneStripReleasedPairs.workflows.W.intent.beforeOwners=[];}],
  ['different after owner proof',s=>{s.paneStripReleasedPairs.workflows.W.intent.afterOwners[0].slots=[];}],
  ['inactive stationary basis',s=>{s.paneStripReleasedPairs.workflows.W.intent.activeBasis.find(value=>value[0]==='x')[1]=false;}],
  ['previous group membership',s=>{s.paneStripReleasedPairs.workflows.W.beforeField.groups[0].tabIds.push('x');}],
])test(`stationary queued free proof rejects ${name}`,async()=>{
  const f=fixture({moving:true}),blocker=f.committer.commit(()=>({...organizationSnapshot(f.state),controlledBlocker:true}));await f.entered.promise;
  const first=f.release('W',{local:true}),second=f.release('W',{local:true,tabId:'z'});first.catch(()=>{});second.catch(()=>{});
  const envelope=clone(f.state.paneStripReleasedPairs);alter(f.state);
  const lease=f.selection(['a','x']);assert.equal(lease.isGroupCurrent(),false);await assert.rejects(f.add(lease));
  f.state.paneStripReleasedPairs=envelope;f.gate.resolve();await blocker;await first;await second;
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

test('stationary queued x that Main never accepted cannot cross Add admission after lane drain',async()=>{
  const f=fixture({moving:true,rejectRoot:'x'}),blocker=f.committer.commit(()=>({...organizationSnapshot(f.state),controlledBlocker:true}));await f.entered.promise;
  const first=f.release('W',{local:true}),second=f.release('W',{local:true,tabId:'z'});first.catch(()=>{});second.catch(()=>{});
  const lease=f.selection(['a','x']);assert.equal(lease.isGroupCurrent(),true);
  const pending=f.add(lease);pending.catch(()=>{});f.gate.resolve();await blocker;
  await assert.rejects(first);await assert.rejects(second);await assert.rejects(pending);
  assert.equal(f.mainMembers.x.workflowId,'S');assert.equal(f.mainMembers.x.revision,1);
  assert.equal(f.writes.some(write=>write.request.stripColorGroupEdits),false);
});

test('free B5 UNKNOWN recovers its exact same command before one Add mutation',async()=>{
  const f=fixture({moving:true,loseReleaseAck:true}),command=f.release();command.catch(()=>{});await f.entered.promise;
  const lease=f.selection(['a','x']);assert.equal(lease.isGroupCurrent(),true);
  const pending=f.add(lease);f.gate.resolve();await assert.rejects(command,/controlled_lost_free_B5_ack/);await pending;
  const attempts=f.writes.filter(write=>write.kind==='commitDrag');assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);
  assert.equal(f.writes.filter(write=>write.request.stripColorGroupEdits).length,1);
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','closed','b','x']);
});
