import test from 'node:test';import assert from 'node:assert/strict';
import {commitPaneStripGroupPresentation} from './paneStripGroupPresentationCommit.mjs';
import {createOrganizationCommitter,organizationSnapshot} from './workflowOrganizationClient.mjs';
import {applyPaneStripGatherPublication} from './paneStripGroupsModel.mjs';
import {adoptPaneStripColorGroups,assertPaneStripGather,mergePaneStripColorGroups} from '../../shared/pane-strip-color-groups.cjs';
import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
const clone=structuredClone;
function fixture(){
  const entries=['a','b','c'].map(tabId=>({projectId:'P',tabId})),groups={version:1,revision:1,
    groups:[{id:'g',revision:1,color:'#abcdef',tabIds:['a','b','c']}]};
  const state={spaces:[{id:'W',stripColorGroups:groups}],organizationReady:true,organizationRevision:1,
    activeSpaceId:'W',activeProjectId:'P',splitPanes:[{windowId:'win',projectId:'P',tabId:'b',tabs:entries}],
    tabCatalog:{},tabWorkflowMembership:Object.fromEntries(entries.map(entry=>[entry.tabId,{workflowId:'W',revision:1}])),
    pendingTabWorkflowMembership:{},centerStrips:{},openProjects:new Map()};
  let current=clone(groups),layout=clone(captureSpaceLayout(state)),revision=1,lose=false,hide=false;
  const receipts=new Map(),writes=[];
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation')return hide?null:receipts.get(payload);
      const request=payload.request;writes.push(clone(request));let result=receipts.get(request.mutationId);
      if(!result){const proposed=request.spaces.find(space=>space.id==='W'),edit=request.stripColorGroupEdits?.[0];
        const next=mergePaneStripColorGroups(current,proposed.stripColorGroups,edit);
        const arranged=edit?assertPaneStripGather(layout,proposed.layout,current,next,edit):null;
        if(arranged?.pane)proposed.layout.splitPanes[arranged.paneIndex].tabs=arranged.slots;
        current=clone(next);layout=clone(proposed.layout);result={success:true,revision:++revision,mutationId:request.mutationId};receipts.set(request.mutationId,result);}
      if(lose&&request.stripColorGroupEdits){lose=false;throw Error('lost ACK');}return result;
    },applyPublication:async(_result,request)=>{
      const published=[{id:'W',stripColorGroups:current,layout}];
      Object.assign(state,applyPaneStripGatherPublication(state,adoptPaneStripColorGroups(state.spaces,published),published,request),{organizationRevision:revision});
    },onError:()=>{}});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const lease={version:1,workflowId:'W',windowId:'win',paneIndex:0,entries,isCurrent:()=>true};
  return {state,writes,lease,get main(){return current;},run:options=>commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId:'g',...options}),
    lose:()=>{lose=true;hide=true;},recover:()=>{hide=false;},foreign:()=>{current={...current,revision:current.revision+1,
      groups:current.groups.map(group=>({...group,color:'#123456',revision:group.revision+1}))};state.organizationRevision=++revision;}};
}
test('collapse toggle changes only explicit metadata after ACK; order/shown/cwd/input stay with their existing owners',async()=>{
  const f=fixture(),before=f.state.splitPanes;await f.run({collapsed:true});
  assert.equal(f.main.groups[0].collapsed,true);assert.equal(f.main.revision,2);assert.equal(f.state.splitPanes,before);
  assert.equal(f.writes.filter(request=>request.stripColorGroupEdits).length,1);
  await f.run({collapsed:false});assert.equal(f.main.groups[0].collapsed,false);assert.equal(f.main.groups[0].revision,3);
});
test('OPEN persists only minimal representative rearrangement through same transaction and ACK adoption; unrelated slots/shown stay',async()=>{
  const f=fixture();await f.run({collapsed:true});const raw=clone(f.main);
  await f.run({order:['a','c','b'],representative:'b'});
  assert.deepEqual(f.state.splitPanes[0].tabs.map(entry=>entry.tabId),['a','c','b']);
  assert.equal(f.state.splitPanes[0].tabId,'b');assert.deepEqual(f.main,raw);
});
test('foreign recolor/definition before queued collapse is not resurrected from captured members or latest organization revision',async()=>{
  const f=fixture();f.foreign();await assert.rejects(f.run({collapsed:true}),/revision_changed/);
  assert.equal(f.main.groups[0].color,'#123456');assert.equal(f.main.groups[0].collapsed,undefined);
});
test('unknown ACK recovers same immutable collapse before next intent, without duplicate metadata revision',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.run({collapsed:true}),/lost ACK/);
  f.recover();await f.run({collapsed:true});assert.equal(f.main.revision,2);
  const edits=f.writes.filter(request=>request.stripColorGroupEdits);assert.deepEqual(edits[0],edits[1]);
});
test('changed owner/order while flush awaits refuses new layout intent; no hidden member deletion or retarget',async()=>{
  const f=fixture();await f.run({collapsed:true});let release;
  f.state.commitOrganization=()=>new Promise(resolve=>release=resolve);
  const result=f.run({order:['b','a','c'],representative:'b'});f.state.splitPanes[0].tabs.reverse();release();
  await assert.rejects(result,/order_changed/);assert.equal(f.writes.filter(request=>request.stripColorGroupEdits?.[0].arrange).length,0);
});
test('ungroup removes only the exact visual definition, including inactive provenance, without changing placement, shown tab or membership',async()=>{
  const f=fixture(),before={panes:f.state.splitPanes,membership:f.state.tabWorkflowMembership,catalog:f.state.tabCatalog,projects:f.state.openProjects};
  f.state.tabCatalog.a={active:false};f.lease.entries=f.lease.entries.filter(entry=>entry.tabId!=='a');
  await f.run({ungroup:true});assert.deepEqual(f.main.groups,[]);assert.equal(f.main.revision,2);
  assert.equal(f.state.splitPanes,before.panes);assert.equal(f.state.tabWorkflowMembership,before.membership);
  assert.equal(f.state.tabCatalog,before.catalog);assert.equal(f.state.openProjects,before.projects);
  assert.deepEqual(f.state.splitPanes[0].tabs.map(entry=>entry.tabId),['a','b','c']);assert.equal(f.state.splitPanes[0].tabId,'b');
  const edits=f.writes.filter(request=>request.stripColorGroupEdits);assert.equal(edits.length,1);
  assert.equal(edits[0].stripColorGroupEdits[0].arrange,undefined);assert.equal(edits[0].stripColorGroupEdits[0].gather,undefined);
});
test('ungroup rejects partial selection and conflicting settings before any durable mutation',async()=>{
  const f=fixture();f.lease.entries=f.lease.entries.slice(0,1);await assert.rejects(f.run({ungroup:true}),/selection_changed/);
  for(const options of [{collapsed:true},{order:['a','b','c'],representative:'a'},{selectedTabId:'a'},{selectionReady:Promise.resolve(true)}])
    await assert.rejects(f.run({ungroup:true,...options}),/selection_changed/);
  assert.equal(f.writes.length,0);assert.equal(f.main.groups.length,1);
});
test('ungroup cannot overwrite a foreign definition or a changed owner/order/membership during the flush',async()=>{
  const foreign=fixture();foreign.foreign();await assert.rejects(foreign.run({ungroup:true}),/revision_changed/);
  assert.equal(foreign.main.groups[0].color,'#123456');
  for(const change of ['owner','order','membership','activity','definition','lease']) {
    const f=fixture();let release,current=true;f.lease.isCurrent=()=>current;
    f.state.commitOrganization=()=>new Promise(resolve=>release=resolve);
    const result=f.run({ungroup:true});
    if(change==='owner')f.state.splitPanes[0].windowId='other';
    if(change==='order')f.state.splitPanes[0].tabs.reverse();
    if(change==='membership')f.state.tabWorkflowMembership.b={workflowId:'other',revision:2};
    if(change==='activity')f.state.tabCatalog.b={active:false};
    if(change==='definition')f.state.spaces[0].stripColorGroups={version:1,revision:2,groups:[{id:'g',revision:2,color:'#123456',tabIds:['a','b','c']}]};
    if(change==='lease')current=false;
    release();await assert.rejects(result,/changed/,change);
    assert.equal(f.writes.filter(request=>request.stripColorGroupEdits).length,0,change);assert.equal(f.main.groups.length,1,change);
  }
});
test('unknown ungroup ACK recovers the same immutable mutation and does not delete or revise twice',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.run({ungroup:true}),/lost ACK/);
  assert.equal(f.state.spaces[0].stripColorGroups.groups.length,1,'no optimistic publication from a lost ACK');
  f.recover();await f.run({ungroup:true});assert.deepEqual(f.main.groups,[]);assert.equal(f.main.revision,2);
  const edits=f.writes.filter(request=>request.stripColorGroupEdits);assert.equal(edits.length,2);assert.deepEqual(edits[0],edits[1]);
});
