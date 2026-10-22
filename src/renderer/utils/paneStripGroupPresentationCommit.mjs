import {readPaneStripGroupState,readPaneStripActiveGroups} from './paneStripGroupsModel.mjs';
import {paneStripColorGroupsBasis,paneStripLayoutOwner,paneStripSlotOrder} from '../../shared/pane-strip-color-groups.cjs';
import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
import {organizationSnapshot} from './workflowOrganizationClient.mjs';
import {stableJson} from '../../shared/workflow-organization.cjs';
const fail=code=>{throw Object.assign(Error(code),{code,disposition:'not-applied'});};
const same=(a,b)=>stableJson(a)===stableJson(b);
const copySlots=slots=>slots.map(slot=>({...slot}));
const sameOwner=(a,b)=>a?.paneIndex===null||b?.paneIndex===null
  ?a?.paneIndex===b?.paneIndex&&a?.centerKey===b?.centerKey
  :a?.windowId&&b?.windowId?a.windowId===b.windowId:a?.paneIndex===b?.paneIndex;

/** Recovery is not a general rebase permission. Only the exact prior arrange
 * whose before/order bridge THIS captured owner to the now-adopted owner may
 * advance the pending selection. Newer local order and changed definitions
 * remain fences; the selected member itself is never recovered from a request. */
function recoveredArrangementMatches(recovered,{workflowId,groupId,owner,basis,beforeOrder,slots}) {
  if(recovered?.kind!=='commitWorkspace')return false;
  const request=recovered.request,edit=request?.stripColorGroupEdits?.find(edit=>edit.workflowId===workflowId);
  const arrange=edit?.arrange,space=request?.spaces?.find(space=>space.id===workflowId);
  if(!arrange||arrange.groupId!==groupId||edit.basis!==basis||!sameOwner(arrange.owner,owner)
    ||!same(paneStripSlotOrder(arrange.beforeSlots||[]),beforeOrder))return false;
  if(paneStripColorGroupsBasis(space?.stripColorGroups)!==basis)return false;
  const proposed=paneStripLayoutOwner(space?.layout,owner);
  return !!proposed&&same(paneStripSlotOrder(proposed.slots),paneStripSlotOrder(slots));
}

/** One explicit field intent in the existing serial organization owner. All
 * captured membership is a fence, never a definition to restore after await. */
export async function commitPaneStripGroupPresentation({getState,committer,lease,groupId,collapsed,order,representative,selectedTabId,selectionReady}) {
  const initial=getState();if(!initial.organizationReady||initial.isRestoring||!lease.isCurrent())fail('strip_selection_changed');
  const raw=readPaneStripGroupState(initial,lease.workflowId),group=raw.groups.find(group=>group.id===groupId);
  if(!group)fail('strip_group_selection_changed');
  if(collapsed!==undefined&&typeof collapsed!=='boolean')fail('strip_group_selection_changed');
  const selecting=selectedTabId!==undefined;
  if(selecting&&(typeof selectedTabId!=='string'||!selectedTabId||order!==undefined||representative!==undefined||collapsed!==undefined
    ||!group.collapsed))fail('strip_group_selection_changed');
  if(selectionReady!==undefined&&(!selecting||typeof selectionReady?.then!=='function'))fail('strip_group_selection_changed');
  // Observe rejection immediately, even if an earlier durable operation must
  // recover first. Readiness is only local admission; it never enters the wire.
  const ready=selectionReady===undefined?null:Promise.resolve(selectionReady).then(value=>value===true,()=>false);
  const owner={windowId:lease.windowId,paneIndex:lease.paneIndex,centerKey:lease.paneIndex===null?(initial.centerStripKey?.()||initial.activeProjectId):null};
  const source=paneStripLayoutOwner(captureSpaceLayout(initial),owner);if(!source)fail('strip_selection_changed');
  let beforeSlots=copySlots(source.slots),beforeOrder=paneStripSlotOrder(beforeSlots);
  const basis=paneStripColorGroupsBasis(raw);
  const active=readPaneStripActiveGroups(initial,lease.workflowId).find(value=>value.id===groupId);
  if(!active||active.tabIds.some(id=>!beforeSlots.some(slot=>slot.tabId===id)))fail('strip_group_selection_changed');
  const members=new Set(active.tabIds),membership=state=>active.tabIds.map(id=>[
    state.tabWorkflowMembership?.[id]??null,state.pendingTabWorkflowMembership?.[id]??null]);
  const membershipBasis=stableJson(membership(initial));
  const checkActive=state=>{
    const current=readPaneStripActiveGroups(state,lease.workflowId).find(value=>value.id===groupId);
    if(!current||!same(current.tabIds,active.tabIds)||stableJson(membership(state))!==membershipBasis
      ||selecting&&(!current.tabIds.includes(selectedTabId)||state.tabCatalog?.[selectedTabId]?.active===false))fail('strip_group_selection_changed');
    if(selecting&&active.tabIds.some(id=>(state.pendingTabWorkflowMembership?.[id]||state.tabWorkflowMembership?.[id])?.workflowId!==lease.workflowId))
      fail('strip_group_selection_changed');
  };
  if(selecting) {
    checkActive(initial);
    // Reconcile unknown delivery BEFORE even deciding that selected-first is a
    // no-op. Otherwise select 2 / lost ACK / select 1 loses the latest intent.
    await committer.runTask(context=>{
      const state=getState();if(!lease.isCurrent())fail('strip_selection_changed');
      if(paneStripColorGroupsBasis(readPaneStripGroupState(state,lease.workflowId))!==basis)fail('workflow_strip_groups_revision_changed');
      checkActive(state);
      const at=paneStripLayoutOwner(captureSpaceLayout(state),owner);if(!at)fail('strip_selection_changed');
      if(!same(paneStripSlotOrder(at.slots),beforeOrder)) {
        if(!recoveredArrangementMatches(context?.recovered,{workflowId:lease.workflowId,groupId,owner,basis,beforeOrder,slots:at.slots}))
          fail('workflow_strip_groups_order_changed');
        beforeSlots=copySlots(at.slots);beforeOrder=paneStripSlotOrder(beforeSlots);
      }
      const ids=beforeSlots.filter(slot=>members.has(slot.tabId)).map(slot=>slot.tabId);
      const indices=beforeSlots.flatMap((slot,index)=>members.has(slot.tabId)?[index]:[]);
      if(indices.length!==active.tabIds.length||Math.max(...indices)-Math.min(...indices)+1!==indices.length)
        fail('workflow_strip_groups_order_changed');
      order=[selectedTabId,...ids.filter(id=>id!==selectedTabId)];representative=selectedTabId;
    });
    // Do not hold the organization lane while activation hydrates its existing
    // owner. A saveSession debounce may use the same lane during that await.
    if(ready&&!(await ready))fail('strip_selection_changed');
    const state=getState();if(!lease.isCurrent())fail('strip_selection_changed');
    if(paneStripColorGroupsBasis(readPaneStripGroupState(state,lease.workflowId))!==basis)fail('workflow_strip_groups_revision_changed');
    checkActive(state);
    const at=paneStripLayoutOwner(captureSpaceLayout(state),owner);
    if(!at||!same(paneStripSlotOrder(at.slots),beforeOrder))fail('workflow_strip_groups_order_changed');
    // A proved no-op needs no extra full-workspace writes. Activation keeps its
    // existing saveSession owner; the recovery above must precede this branch.
    if(same(beforeSlots.filter(slot=>members.has(slot.tabId)).map(slot=>slot.tabId),order))
      return {revision:state.organizationRevision,unchanged:true};
  } else if(order)order=[...order];
  if(order&&(!group.collapsed||order.length!==active.tabIds.length||new Set(order).size!==order.length
    ||active.tabIds.some(id=>!order.includes(id))||!order.includes(representative)))fail('strip_group_selection_changed');
  if(collapsed===undefined&&!order||collapsed!==undefined&&!!group.collapsed===collapsed&&!order)return {revision:initial.organizationRevision,unchanged:true};
  await getState().commitOrganization();
  return committer.commit(()=>{
    const state=getState();if(!lease.isCurrent())fail('strip_selection_changed');
    const current=readPaneStripGroupState(state,lease.workflowId),live=current.groups.find(value=>value.id===groupId);
    const at=paneStripLayoutOwner(captureSpaceLayout(state),owner);
    if(!live||paneStripColorGroupsBasis(current)!==basis) {
      if(!order&&live&&collapsed!==undefined&&!!live.collapsed===collapsed)return organizationSnapshot(state);
      fail('workflow_strip_groups_revision_changed');
    }
    checkActive(state);
    if(!at||!same(paneStripSlotOrder(at.slots),beforeOrder))fail('workflow_strip_groups_order_changed');
    let candidate=state;
    if(collapsed!==undefined&&!!live.collapsed!==collapsed) {
      const groups=current.groups.map(value=>value.id===groupId?{...value,collapsed,revision:value.revision+1}:value);
      candidate={...candidate,spaces:state.spaces.map(space=>space.id===lease.workflowId?
        {...space,stripColorGroups:{...current,revision:current.revision+1,groups}}:space)};
    }
    let arrange;
    if(order) {
      const ids=new Set(order),indices=at.slots.flatMap((slot,index)=>ids.has(slot.tabId)?[index]:[]),start=Math.min(...indices);
      if(Math.max(...indices)-start+1!==order.length)fail('workflow_strip_groups_order_changed');
      const byId=new Map(at.slots.filter(slot=>ids.has(slot.tabId)).map(slot=>[slot.tabId,slot]));
      const slots=[...at.slots.slice(0,start),...order.map(id=>byId.get(id)),...at.slots.slice(start+order.length)];
      if(!same(paneStripSlotOrder(slots),beforeOrder)) {
        candidate=at.pane?{...candidate,splitPanes:state.splitPanes.map((pane,index)=>index===at.paneIndex?{...pane,tabs:slots}:pane)}:
          {...candidate,centerStrips:{...state.centerStrips,[at.centerKey]:slots}};
        arrange={owner,groupId,representative,beforeSlots,order};
      }
    }
    return {...organizationSnapshot(candidate),stripColorGroupEdits:[{workflowId:lease.workflowId,basis,...(arrange?{arrange}:{})}]};
  });
}
