import {readPaneStripGroupState,readPaneStripActiveGroups} from './paneStripGroupsModel.mjs';
import {classifyPaneStripGroupAddSelection} from './paneStripSelectionModel.mjs';
import {capturePaneStripSettingsMembership} from './paneStripSettingsMembership.mjs';
import {readPaneStripReleasedPairs} from './paneStripReleasePair.mjs';
import {paneStripColorGroupsBasis,paneStripLayoutOwner,paneStripSlotOrder,addPaneStripGroupSlots} from '../../shared/pane-strip-color-groups.cjs';
import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
import {organizationSnapshot} from './workflowOrganizationClient.mjs';
import {stableJson} from '../../shared/workflow-organization.cjs';

const same=(a,b)=>stableJson(a)===stableJson(b);
const fail=code=>{throw Object.assign(Error(code),{code,disposition:'not-applied'});};
const copy=value=>JSON.parse(stableJson(value));
const identity=(state,id)=>{
  const item=state.tabCatalog?.[id];
  return [item?.active??null,item?.namespace??null,item?.storageId??null,item?.physicalParentTabId??null,
    item?.subjectVersion??null,item?.executionSubject??null];
};
const sameOwner=(a,b)=>a?.paneIndex===null||b?.paneIndex===null
  ?a?.paneIndex===b?.paneIndex&&a?.centerKey===b?.centerKey
  :a?.windowId&&b?.windowId?a.windowId===b.windowId:a?.paneIndex===b?.paneIndex;
const nextField=(field,groupId,tabIds)=>({...field,revision:field.revision+1,
  groups:field.groups.map(group=>group.id===groupId?{...group,revision:group.revision+1,tabIds:[...group.tabIds,...tabIds]}:group)});

/** Explicit Add is a settings intent in the existing organization lane. It
 * appends selected free roots to the fresh raw definition and gathers through
 * the existing canonical publication. No optimistic pair, drag receipt,
 * activation or execution authority is created here. */
export async function commitPaneStripGroupAdd({getState,committer,lease,groupId}) {
  const currentLease=()=>!!(lease.isGroupCurrent||lease.isCurrent)();
  const initial=getState(),workflowId=lease.workflowId;
  if(!initial.organizationReady||initial.isRestoring||!currentLease())fail('strip_selection_changed');
  const raw=readPaneStripGroupState(initial,workflowId),basis=paneStripColorGroupsBasis(raw);
  const group=raw.groups.find(value=>value.id===groupId);
  const selected=lease.entries.map(entry=>entry.tabId);
  const choice=classifyPaneStripGroupAddSelection(readPaneStripActiveGroups(initial,workflowId),selected);
  if(!group||choice.kind!=='add'||choice.group.id!==groupId)
    return recoverInstalledAdd({getState,committer,lease,groupId,initial,raw});
  const owner={windowId:lease.windowId,paneIndex:lease.paneIndex,
    centerKey:lease.paneIndex===null?(initial.centerStripKey?.()||initial.activeProjectId):null};
  const source=paneStripLayoutOwner(captureSpaceLayout(initial),owner);if(!source)fail('strip_selection_changed');
  const beforeSlots=copy(source.slots),beforeOrder=paneStripSlotOrder(beforeSlots);
  const free=new Set(choice.tabIds),added=source.slots.filter(slot=>free.has(slot.tabId)).map(slot=>slot.tabId);
  if(added.length!==free.size||new Set(added).size!==added.length)fail('strip_group_selection_changed');
  const active=readPaneStripActiveGroups(initial,workflowId).find(value=>value.id===groupId);
  if(!active||active.tabIds.some(id=>!source.slots.some(slot=>slot.tabId===id)))fail('strip_group_selection_changed');
  const targetIds=[...active.tabIds,...added],rawIds=[...group.tabIds,...added];
  const activity=copy(rawIds.map(id=>identity(initial,id)));
  const addresses=targetIds.map(id=>{
    const matches=source.slots.filter(slot=>slot.tabId===id);
    if(matches.length!==1)fail('strip_group_selection_changed');
    const {projectId}=matches[0],tab=initial.openProjects.get(projectId)?.tabs.get(id);
    if(!tab||initial.tabCatalog?.[id]?.active!==true||initial.tabCatalog[id].namespace!==projectId)fail('strip_group_selection_changed');
    return {tabId:id,projectId,tab};
  });
  const witness=capturePaneStripSettingsMembership(initial,{workflowId,owner,tabIds:targetIds,
    assignments:[...active.tabIds.map(()=>groupId),...added.map(()=>null)],basis,beforeOrder});
  if(targetIds.some(id=>(initial.pendingTabWorkflowMembership?.[id]||initial.tabWorkflowMembership?.[id])?.workflowId!==workflowId
    ||initial.tabWorkflowMembership?.[id]?.workflowId!==workflowId&&!witness.hasReleasedProof(id)))fail('strip_group_selection_changed');
  const navigationRevision=initial.navigationRevision;
  // Pure preview is only an exact receipt comparison. It is never installed
  // in state or reused as a post-await metadata candidate.
  const expectedBasis=paneStripColorGroupsBasis(nextField(raw,groupId,added));
  const expectedOrder=paneStripSlotOrder(addPaneStripGroupSlots(source.slots,group.tabIds,added));
  const liveFence=state=>{
    if(!currentLease()||!state.organizationReady||state.isRestoring||state.activeSpaceId!==workflowId
      ||state.navigationRevision!==navigationRevision)fail('strip_selection_changed');
    if(!same(rawIds.map(id=>identity(state,id)),activity)||!witness.isCurrent(state)
      ||addresses.some(({tabId,projectId,tab})=>state.openProjects.get(projectId)?.tabs.get(tabId)!==tab))
      fail('strip_group_selection_changed');
  };
  const sourceFence=state=>{
    liveFence(state);
    const field=readPaneStripGroupState(state,workflowId),at=paneStripLayoutOwner(captureSpaceLayout(state),owner);
    if(paneStripColorGroupsBasis(field)!==basis)fail('workflow_strip_groups_revision_changed');
    if(!at||!same(paneStripSlotOrder(at.slots),beforeOrder))fail('workflow_strip_groups_order_changed');
    const live=readPaneStripActiveGroups(state,workflowId).find(value=>value.id===groupId);
    if(!live||!same(live.tabIds,active.tabIds))fail('strip_group_selection_changed');
    const decision=classifyPaneStripGroupAddSelection(readPaneStripActiveGroups(state,workflowId),selected);
    if(decision.kind!=='add'||decision.group.id!==groupId||new Set(decision.tabIds).size!==free.size
      ||decision.tabIds.some(id=>!free.has(id)))fail('strip_group_selection_changed');
    return {field,at};
  };
  // Recovery must precede the no-op decision, including an already accepted
  // Add whose ACK was lost. Only this lane's exact original request bridges
  // the captured before state to its accepted result; matching colors or IDs
  // alone never authorize a rebase after foreign work.
  const recovered=await committer.runTask(context=>context?.recovered||null);
  if(recovered?.kind==='commitWorkspace') {
    const request=recovered.request,edit=request.stripColorGroupEdits?.find(value=>value.workflowId===workflowId);
    const space=request.spaces?.find(value=>value.id===workflowId),at=paneStripLayoutOwner(space?.layout,owner);
    if(edit?.add?.groupId===groupId&&same(edit.add.tabIds,added)&&edit.basis===basis&&edit.gather&&!edit.arrange
      &&sameOwner(edit.gather.owner,owner)&&same(paneStripSlotOrder(edit.gather.beforeSlots||[]),beforeOrder)
      &&paneStripColorGroupsBasis(space?.stripColorGroups)===expectedBasis&&at&&same(paneStripSlotOrder(at.slots),expectedOrder)) {
      const state=getState();liveFence(state);
      const live=paneStripLayoutOwner(captureSpaceLayout(state),owner);
      if(paneStripColorGroupsBasis(readPaneStripGroupState(state,workflowId))!==expectedBasis
        ||!live||!same(paneStripSlotOrder(live.slots),expectedOrder))fail('strip_group_selection_changed');
      return {...recovered.result,unchanged:true};
    }
  }
  sourceFence(getState());
  await getState().commitOrganization();
  return committer.commit(()=>{
    const state=getState(),{field,at}=sourceFence(state);
    const current=field.groups.find(value=>value.id===groupId);
    const slots=addPaneStripGroupSlots(at.slots,current.tabIds,added);
    const spaces=state.spaces.map(space=>space.id===workflowId?{...space,stripColorGroups:nextField(field,groupId,added)}:space);
    const patch=at.pane?{splitPanes:state.splitPanes.map((pane,index)=>index===at.paneIndex?{...pane,tabs:slots}:pane)}
      :{centerStrips:{...state.centerStrips,[at.centerKey]:slots}};
    const snapshot=organizationSnapshot({...state,...patch,spaces});
    const pairs=readPaneStripReleasedPairs(state.paneStripReleasedPairs);
    if(pairs.unrecognizedEnvelope||Object.keys(pairs.workflows).length||Object.keys(pairs.commands).length
      ||snapshot.stripGroupReleases?.length||snapshot.stripReleaseDeferrals?.length
      ||Object.entries(snapshot.tabWorkflowMembership).some(([id,member])=>{
        const canonical=state.tabWorkflowMembership[id];
        return !canonical||member.workflowId!==canonical.workflowId||member.revision!==canonical.revision
          ||member.expectedMembershipRevision!==canonical.revision;
      }))fail('strip_group_selection_changed');
    return {...snapshot,stripColorGroupEdits:[{workflowId,basis,add:{groupId,tabIds:added},gather:{owner,beforeSlots}}]};
  });
}


/** applyPublication may have installed the accepted result before a later
 * notification throws. A repeated action must let the existing lane finish
 * that same operation even though its selection now contains no free roots.
 * This path can only acknowledge that exact receipt; it cannot submit edits. */
async function recoverInstalledAdd({getState,committer,lease,groupId,initial,raw}) {
  const workflowId=lease.workflowId,group=raw.groups.find(value=>value.id===groupId);
  const owner={windowId:lease.windowId,paneIndex:lease.paneIndex,
    centerKey:lease.paneIndex===null?(initial.centerStripKey?.()||initial.activeProjectId):null};
  const at=paneStripLayoutOwner(captureSpaceLayout(initial),owner),basis=paneStripColorGroupsBasis(raw);
  const order=at&&paneStripSlotOrder(at.slots),selected=lease.entries.map(entry=>entry.tabId),navigationRevision=initial.navigationRevision;
  const ids=group?.tabIds.filter(id=>initial.tabCatalog?.[id]?.active!==false)||[];
  const rawIds=group?.tabIds.slice()||[],identities=copy(rawIds.map(id=>identity(initial,id)));
  const membership=value=>ids.map(id=>[value.tabWorkflowMembership?.[id]??null,value.pendingTabWorkflowMembership?.[id]??null]);
  const capturedMembership=copy(membership(initial));
  const tabs=ids.map(id=>{const slot=at?.slots.find(value=>value.tabId===id);
    return {id,projectId:slot?.projectId,tab:slot&&initial.openProjects.get(slot.projectId)?.tabs.get(id)};});
  const recovered=await committer.runTask(context=>context?.recovered||null);
  if(!group||!at||!ids.length||recovered?.kind!=='commitWorkspace')fail('strip_group_selection_changed');
  const request=recovered.request,edit=request.stripColorGroupEdits?.find(value=>value.workflowId===workflowId);
  const space=request.spaces?.find(value=>value.id===workflowId),proposed=paneStripLayoutOwner(space?.layout,owner);
  if(edit?.add?.groupId!==groupId||!edit.add.tabIds?.length||edit.add.tabIds.some(id=>!selected.includes(id))
    ||!edit.gather||edit.arrange||!sameOwner(edit.gather.owner,owner)||!proposed
    ||paneStripColorGroupsBasis(space.stripColorGroups)!==basis||!same(paneStripSlotOrder(proposed.slots),order))fail('strip_group_selection_changed');
  const before=JSON.parse(edit.basis),old=before.groups?.find(value=>value.id===groupId);
  if(!old||!selected.some(id=>old.tabIds.includes(id))||selected.some(id=>!group.tabIds.includes(id))
    ||paneStripColorGroupsBasis(nextField(before,groupId,edit.add.tabIds))!==basis
    ||!same(paneStripSlotOrder(addPaneStripGroupSlots(edit.gather.beforeSlots,old.tabIds,edit.add.tabIds)),order))fail('strip_group_selection_changed');
  const state=getState(),live=paneStripLayoutOwner(captureSpaceLayout(state),owner);
  if(!(lease.isGroupCurrent||lease.isCurrent)()||!state.organizationReady||state.isRestoring||state.activeSpaceId!==workflowId
    ||state.navigationRevision!==navigationRevision)fail('strip_selection_changed');
  if(paneStripColorGroupsBasis(readPaneStripGroupState(state,workflowId))!==basis||!live
    ||!same(paneStripSlotOrder(live.slots),order)||!same(rawIds.map(id=>identity(state,id)),identities)
    ||!same(membership(state),capturedMembership)||ids.some(id=>{const member=request.tabWorkflowMembership?.[id],canonical=state.tabWorkflowMembership?.[id];
      return !member||!canonical||member.workflowId!==canonical.workflowId||member.revision!==canonical.revision;})||tabs.some(({id,projectId,tab})=>!tab
      ||state.tabCatalog?.[id]?.active!==true||state.tabCatalog[id].namespace!==projectId
      ||state.openProjects.get(projectId)?.tabs.get(id)!==tab))fail('strip_group_selection_changed');
  return {...recovered.result,unchanged:true};
}
