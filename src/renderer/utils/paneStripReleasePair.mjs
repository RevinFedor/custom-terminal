import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
import {applyWorkflowDragLayout} from './workflowDragNavigation.mjs';
import {preparePaneStripGroupRelease} from '../../shared/pane-strip-group-admission.cjs';
import {paneStripColorGroupsBasis} from '../../shared/pane-strip-color-groups.cjs';
import {dragPlacement} from '../../shared/workflow-drag.cjs';
import {stableJson} from '../../shared/workflow-organization.cjs';
import {organizationPlacementIntent} from './workflowPlacementMembership.mjs';

const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const same=(a,b)=>a===undefined||b===undefined?a===b:stableJson(a)===stableJson(b);
const layoutOf=(state,space)=>space.id===state.activeSpaceId?captureSpaceLayout(state):space.layout || {};
const blank=()=>({version:1,workflows:{},commands:{}});
const own=(object,key)=>object&&Object.hasOwn(object,key)?object[key]:undefined;
const put=(object,key,value)=>Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Object.assign(Error(code),{code,disposition:'not-applied'});};
const pairMatches=(layout,field,otherLayout,otherField)=>same(dragPlacement(layout),dragPlacement(otherLayout))&&same(field,otherField);

/** One current released pair per workflow, plus only the immutable commands
 * still owned by the existing organization lane. No settled gesture history,
 * recovery writer or retry authority is created by this envelope. */
export function readPaneStripReleasedPairs(value) {
  if(value==null)return blank();
  if(value.version===1&&record(value.workflows)&&record(value.commands)
    &&Object.entries(value.commands).every(([id,item])=>record(item)&&record(item.request)&&item.request.mutationId===id
      &&['preparation','pending','unknown'].includes(item.status))
    &&Object.entries(value.workflows).every(([id,item])=>record(item)&&item.workflowId===id
      &&record(item.beforeLayout)&&record(item.layout)&&record(item.intent)
      &&item.intent.version===2&&item.intent.workflowId===id&&Array.isArray(item.intent.rootTabIds)&&Array.isArray(item.intent.activeBasis)
      &&['command','local','unreconciled'].includes(item.status)))return clone(value);
  return {...blank(),unrecognizedEnvelope:clone(value)};
}

function withField(space,field) {
  const result={...space};
  if(field===undefined)delete result.stripColorGroups;else result.stripColorGroups=clone(field);
  return result;
}
function patchSpaces(state,spaces,envelope) {
  const active=spaces.find(space=>space.id===state.activeSpaceId);
  return {spaces,...(active?.layout || {}),paneStripReleasedPairs:envelope};
}
function releaseRecord({workflowId,field,beforeLayout,layout,intent,status,mutationId}) {
  return {workflowId,status,...(mutationId?{mutationId}:{}),beforeLayout:clone(beforeLayout),
    ...(field===undefined?{}:{beforeField:clone(field)}),layout:clone(layout),
    ...(intent.nextState===undefined?{}:{field:clone(intent.nextState)}),intent:clone(intent)};
}

/** Called synchronously at release, before the first await. Rendering and the
 * next pickup now share the same order/membership; Main still owns durability. */
export function publishPaneStripDragRelease(state,request) {
  if(!request?.stripGroupReleases?.length)return null;
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  const intents=new Map(request.stripGroupReleases.map(intent=>[intent.workflowId,intent]));
  const changes=new Map(request.workflows.map(change=>[change.workflowId,change]));
  const spaces=state.spaces.map(space=>{
    const change=changes.get(space.id);if(!change)return space;
    const beforeLayout=layoutOf(state,space);
    if(!same(dragPlacement(beforeLayout),change.expectedPlacement))fail('workflow_drag_placement_changed');
    const layout=applyWorkflowDragLayout(beforeLayout,change,{reveal:false});
    const intent=intents.get(space.id);
    let next={...space,layout,reserveOrder:change.reserveOrder,reserveRootOrder:change.reserveRootOrder};
    if(intent) {
      if(paneStripColorGroupsBasis(space.stripColorGroups)!==intent.basis)fail('workflow_drag_strip_group_release_changed');
      put(envelope.workflows,space.id,releaseRecord({workflowId:space.id,field:space.stripColorGroups,
        beforeLayout,layout,intent,status:'command',mutationId:request.mutationId}));
      next=withField(next,intent.nextState);
    }
    return next;
  });
  put(envelope.commands,request.mutationId,{request:clone(request),status:'pending'});
  const pending={...state.pendingTabWorkflowMembership};
  for(const tab of request.tabs || [])if(tab.workflowId!==tab.expected.workflowId)
    put(pending,tab.tabId,{tabId:tab.tabId,workflowId:tab.workflowId,revision:tab.expected.membershipRevision+1,
      localReleaseMutationId:request.mutationId});
  return {...patchSpaces(state,spaces,envelope),pendingTabWorkflowMembership:pending};
}

/** The exposed ordinary window writer is a real release too. Its exact pair
 * is frozen for the existing lane before a later local release can replace
 * it. Selected roots alone supply membership authority. */
export function preparePaneStripLocalRelease(state,nextSpaces,{rootTabIds,targetWorkflowId,targetOwner}) {
  if(!state.organizationReady||!rootTabIds?.length)return {spaces:nextSpaces};
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  let changed=false;
  const spaces=nextSpaces.map(space=>{
    const old=state.spaces.find(item=>item.id===space.id);if(!old?.stripColorGroups?.groups?.length)return space;
    const currentLayout=layoutOf(state,old);
    if(same(dragPlacement(currentLayout),dragPlacement(space.layout)))return space;
    const beforeLayout=currentLayout,field=old.stripColorGroups,roots=rootTabIds;
    const prepared=preparePaneStripGroupRelease({workflowId:space.id,field,beforeLayout,layout:space.layout,
      rootTabIds:roots,targetOwner:space.id===targetWorkflowId?targetOwner:null,
      isActive:id=>state.tabCatalog?.[id]?.active});
    put(envelope.workflows,space.id,releaseRecord({workflowId:space.id,field,beforeLayout,layout:space.layout,
      intent:prepared.intent,status:'local'}));
    envelope.workflows[space.id].dependsOnMutationIds=Object.keys(envelope.commands);
    changed=true;return withField(space,prepared.nextState);
  });
  return {spaces,...(changed?{paneStripReleasedPairs:envelope,
    ...releasedPlacementIntent(state,spaces)}:{})};
}

// A following pickup observes the logical membership revision AFTER this
// released move. Its own frozen ordinary write still compares the revision
// BEFORE the move. Keep these two values separate until the lane owns it.
function releasedPlacementIntent(state,spaces) {
  const active=spaces.find(space=>space.id===state.activeSpaceId);
  const next={...state,spaces,...(active?.layout || {})};
  const placement=organizationPlacementIntent(state,next);
  if(!placement)return {};
  const pending=placement.pendingTabWorkflowMembership;
  for(const [id,member]of Object.entries(pending)) {
    const before=state.pendingTabWorkflowMembership?.[id] || state.tabWorkflowMembership?.[id];
    if(!before || before.workflowId===member.workflowId)continue;
    const revision=before.localReleaseMutationId || before.localReleaseQueued
      || before.localReleaseExpectedMembershipRevision!==undefined?before.revision:state.tabWorkflowMembership[id]?.revision;
    if(!Number.isSafeInteger(revision))fail('workflow_membership_revision_changed');
    pending[id]={...member,revision:revision+1,localReleaseExpectedMembershipRevision:revision};
    delete pending[id].localReleaseMutationId;delete pending[id].localReleaseQueued;
  }
  return {pendingTabWorkflowMembership:pending};
}

export function preparePaneStripLocalPatch(state,patch,options) {
  const next={...state,...patch};
  const spaces=next.spaces.map(space=>space.id===next.activeSpaceId?{...space,layout:captureSpaceLayout(next)}:space);
  const release=preparePaneStripLocalRelease(state,spaces,options);
  return release.paneStripReleasedPairs?{...patch,...release}:patch;
}

/** Enqueue exactly the pair just published, before another release can
 * replace the live snapshot. The existing lane owns all delivery/recovery. */
export function enqueuePaneStripLocalRelease({getState,setState,committer,snapshot}) {
  if(!snapshot.stripGroupReleases?.length)return null;
  setState(markPaneStripReleaseQueued(getState()));
  let immutable=null;
  const pending=committer.commit(snapshot,{onPrepared:request=>{
    immutable=request;setState(recordPaneStripReleaseCommand(getState(),request));
  },onStage:event=>setState(notePaneStripReleaseStage(getState(),event))});
  pending.catch(error=>{
    if(immutable)setState(settlePaneStripDragRelease(getState(),immutable,{notApplied:isPaneStripReleaseNotApplied(error),
      continuationPending:error?.organizationContinuationPending===true}));
  });
  return pending;
}

/** Full snapshots include every current lawful local release. An in-flight
 * command is committed only by its existing immutable command, never smuggled
 * into the preflush of that same command. */
export function paneStripReleaseSnapshot(state) {
  const envelope=state.paneStripReleasedPairs;
  if(envelope?.version!==1)return {};
  const releases=[],deferrals=[];
  for(const [id,item] of Object.entries(envelope.workflows)) {
    if(item.status==='unreconciled') {
      if(!item.canonical)fail('workflow_strip_groups_canonical_read_required');
      deferrals.push({workflowId:id,basis:paneStripColorGroupsBasis(item.canonical.field),placement:dragPlacement(item.canonical.layout)});
      continue;
    }
    if(item.status!=='local'||item.queued)continue;
    const space=state.spaces.find(space=>space.id===id);
    if(!space||!pairMatches(layoutOf(state,space),space.stripColorGroups,item.layout,item.field))
      fail('workflow_strip_groups_local_release_changed');
    releases.push(clone(item.intent));
  }
  return {...(releases.length?{stripGroupReleases:releases}:{}),...(deferrals.length?{
    stripReleaseDeferrals:deferrals,
    spaces:state.spaces.map((space,index)=>{
      const item=own(envelope.workflows,space.id);
      return item?.status==='unreconciled'?withField({...space,order:index,layout:clone(item.canonical.layout)},item.canonical.field)
        :{...space,order:index,layout:layoutOf(state,space)};
    })}:{} )};
}

/** Every read path observes the same pending owner. Matching canonical pair
 * retires it; an older command/generic/catalog publication cannot graft its
 * field onto a later released order. Unrelated workflow metadata stays live. */
export function applyPaneStripReleasePublication(state,patch,publishedSpaces,publication,tabCatalog=state.tabCatalog,request) {
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  if(request?.mutationId&&own(envelope.commands,request.mutationId)) {
    delete envelope.commands[request.mutationId];
    for(const item of Object.values(envelope.workflows))if(item.dependsOnMutationIds)
      item.dependsOnMutationIds=item.dependsOnMutationIds.filter(id=>id!==request.mutationId);
  }
  const incoming=new Map(publishedSpaces.map(space=>[space.id,space]));
  let livePatch={};
  const spaces=(patch.spaces || state.spaces).map(space=>{
    const pending=own(envelope.workflows,space.id),published=incoming.get(space.id);
    if(!pending||!published)return space;
    pending.canonical={layout:clone(published.layout || {}),...(published.stripColorGroups===undefined?{}:{field:clone(published.stripColorGroups)}),
      publicationRevision:publication?.revision};
    const current=state.spaces.find(item=>item.id===space.id)||space;
    const currentLayout=layoutOf(state,current);
    if(pairMatches(published.layout,published.stripColorGroups,pending.layout,pending.field)) {
      delete envelope.workflows[space.id];return space;
    }
    if(pending.status==='unreconciled'&&!pairMatches(currentLayout,current.stripColorGroups,pending.layout,pending.field))return space;
    // Keep the latest local pair even if a current read reports an unrelated
    // edit. Main checks its frozen basis; a read is not a new release.
    let retained=withField({...space,layout:currentLayout},current.stripColorGroups);
    if(state.activeSpaceId===space.id)livePatch=currentLayout;
    return retained;
  });
  return {...patch,...livePatch,spaces,paneStripReleasedPairs:envelope};
}

export function settlePaneStripDragRelease(state,request,{accepted=false,notApplied=false,continuationPending=false}={}) {
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  const command=own(envelope.commands,request.mutationId);
  if(!command)return {};
  // A preceding operation may be known rejected while this release is still
  // waiting. That predecessor's error is not a rejection receipt for us.
  if(continuationPending&&!accepted)return {};
  if(accepted||notApplied)delete envelope.commands[request.mutationId];
  else command.status='unknown';
  const pending={...state.pendingTabWorkflowMembership};
  if(notApplied) {
    for(const item of Object.values(envelope.workflows))if(item.mutationId===request.mutationId
      ||item.dependsOnMutationIds?.includes(request.mutationId))item.status='unreconciled';
    for(const [id,member]of Object.entries(pending))if(member.localReleaseMutationId===request.mutationId)delete pending[id];
  }
  return {paneStripReleasedPairs:envelope,...(notApplied?{pendingTabWorkflowMembership:pending}:{})};
}

/** Runtime stages describe the actual owner of an uncertain delivery. A
 * command waiting behind preparation has not itself been submitted. Later
 * recovery still reports settlement here after the original await rejected. */
export function notePaneStripReleaseStage(state,event) {
  if(!event?.request?.mutationId)return {};
  if(event.stage==='accepted'||event.stage==='not-applied')return settlePaneStripDragRelease(state,event.request,
    {accepted:event.stage==='accepted',notApplied:event.stage==='not-applied'});
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  const command=own(envelope.commands,event.request.mutationId);
  if(!command)return {};
  command.status=event.stage==='preparation'?'preparation':event.stage==='unknown'?'unknown':'pending';
  if(event.preparationRequest)command.preparationRequest=clone(event.preparationRequest);
  else if(event.stage==='submitted')delete command.preparationRequest;
  return {paneStripReleasedPairs:envelope};
}

/** Exact Main validation refusals survive Electron's Error serialization.
 * A timeout whose prose happens to contain a code remains UNKNOWN. */
export function isPaneStripReleaseNotApplied(error) {
  if(error?.disposition==='not-applied')return true;
  const name='workflow_(?:(?:drag_|strip_groups_)[a-z_]+|revision_changed|membership_revision_changed)';
  if(typeof error?.code==='string'&&new RegExp('^'+name+'$').test(error.code))return true;
  return new RegExp('^(?:Error: )?(?:Error invoking remote method [\\\'\\\"]workflow:mutate[\\\'\\\"]: Error: )?'+name+'$')
    .test(String(error?.message || ''));
}

export function markPaneStripReleaseQueued(state) {
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  for(const item of Object.values(envelope.workflows))if(item.status==='local')item.queued=true;
  const pending={...state.pendingTabWorkflowMembership};
  for(const [id,member]of Object.entries(pending))if(member.localReleaseExpectedMembershipRevision!==undefined) {
    pending[id]={...member,localReleaseQueued:true};delete pending[id].localReleaseExpectedMembershipRevision;
  }
  return {paneStripReleasedPairs:envelope,pendingTabWorkflowMembership:pending};
}
export function recordPaneStripReleaseCommand(state,request) {
  if(!request.stripGroupReleases?.length)return {};
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
  put(envelope.commands,request.mutationId,{request:clone(request),status:'pending'});
  for(const intent of request.stripGroupReleases) {
    const item=own(envelope.workflows,intent.workflowId);
    if(item&&same(item.intent,intent)){item.mutationId=request.mutationId;item.queued=true;}
  }
  const pending={...state.pendingTabWorkflowMembership};
  for(const [id,member]of Object.entries(pending)) {
    const requested=request.tabWorkflowMembership?.[id];
    if((member.localReleaseQueued||member.localReleaseExpectedMembershipRevision!==undefined)
      &&requested?.workflowId===member.workflowId&&requested.revision===member.revision) {
      pending[id]={...member,localReleaseMutationId:request.mutationId};delete pending[id].localReleaseQueued;
      delete pending[id].localReleaseExpectedMembershipRevision;
    }
  }
  return {paneStripReleasedPairs:envelope,pendingTabWorkflowMembership:pending};
}
export function paneStripReleaseNeedsCanonical(state) {
  return Object.values(state.paneStripReleasedPairs?.workflows || {}).some(item=>item.status==='unreconciled');
}

/** Session envelopes are data, not retry credentials. Restore publishes a
 * saved local release only against its exact fresh basis. Unknown commands
 * remain explicit retained data; bootstrap never sends them. */
export function restorePaneStripReleasedPairs(state,saved) {
  const envelope=readPaneStripReleasedPairs(saved?.paneStripReleasedPairs);
  for(const command of Object.values(envelope.commands))if(command.status!=='preparation')command.status='unknown';
  let spaces=state.spaces;
  for(const [id,item] of Object.entries(envelope.workflows)) {
    const space=spaces.find(space=>space.id===id);if(!space){item.status='unreconciled';continue;}
    const layout=layoutOf(state,space);
    if(pairMatches(layout,space.stripColorGroups,item.layout,item.field)) {
      delete envelope.workflows[id];continue;
    }
    const canRestore=item.status==='local'&&!item.queued&&!Object.keys(envelope.commands).length
      &&pairMatches(layout,space.stripColorGroups,item.beforeLayout,item.beforeField)
      &&item.intent.activeBasis.every(([tabId,active])=>(state.tabCatalog?.[tabId]?.active??null)===active);
    if(canRestore) {
      // Only a pair outside the queue can be restored as unsent local data.
      // A queued saved pair may have reached Main after this session write;
      // absence of a saved command key does not authorize a new-key replay.
      delete item.queued;delete item.mutationId;delete item.dependsOnMutationIds;
      spaces=spaces.map(value=>value.id===id?withField({...value,
        layout:applyWorkflowDragLayout(layout,{beforeLayout:item.beforeLayout,layout:item.layout},{reveal:false})},item.field):value);
    }
    else {item.status='unreconciled';item.canonical={layout:clone(layout),...(space.stripColorGroups===undefined?{}:{field:clone(space.stripColorGroups)}),
      publicationRevision:state.organizationRevision};}
  }
  return {...patchSpaces(state,spaces,envelope),
    ...releasedPlacementIntent({...state,isRestoring:false,pendingTabWorkflowMembership:{}},spaces)};
}
