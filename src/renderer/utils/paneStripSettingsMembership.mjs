import {paneStripColorGroupsBasis,paneStripLayoutOwner,paneStripSlotOrder} from '../../shared/pane-strip-color-groups.cjs';
import {readPaneStripReleasedPairs} from './paneStripReleasePair.mjs';
import {stableJson} from '../../shared/workflow-organization.cjs';

const same=(a,b)=>stableJson(a)===stableJson(b);

// A later ordinary release can replace the current pair before an earlier
// queued free root receives its immutable command key. The existing pair owns
// the complete before/after inventory. Require that root to be stationary and
// explicitly active/free at the same address in both of those inventories.
// This is only a phase witness: final canonical equality and retirement below
// are still mandatory before Add may enter the organization mutation lane.
function stationaryQueuedFree(state,pair,pending,owner,id) {
  if(pair.queued!==true||pending.localReleaseQueued!==true||state.tabCatalog?.[id]?.active!==true
    ||pair.intent.rootTabIds.includes(id)||pair.intent.placementTabIds?.includes(id)
    ||pair.intent.plan?.assignments?.some(value=>value.tabId===id))return false;
  try {
    const namespace=state.tabCatalog[id].namespace;
    if(typeof namespace!=='string'||!namespace||!pair.intent.activeBasis.some(value=>value[0]===id&&value[1]===true))return false;
    for(const field of [pair.beforeField,pair.field]) {
      paneStripColorGroupsBasis(field);
      if(field?.groups.some(group=>group.tabIds.includes(id)))return false;
    }
    for(const [layout,proof]of [[pair.beforeLayout,pair.intent.beforeOwners],[pair.layout,pair.intent.afterOwners]]) {
      const at=paneStripLayoutOwner(layout,owner),slots=at?.slots.filter(slot=>slot.tabId===id);
      if(slots?.length!==1||slots[0].projectId!==namespace)return false;
      const witnesses=proof?.filter(value=>value.path?.length===0&&value.owner?.paneIndex===owner.paneIndex
        &&(value.owner.windowId??null)===(owner.windowId??null)&&(value.owner.centerKey??null)===(owner.centerKey??null));
      if(witnesses?.length!==1||!same(witnesses[0].slots,paneStripSlotOrder(at.slots)))return false;
    }
    return true;
  } catch {return false;}
}

/** Read-only phase witness for group settings. The existing released pair,
 * command and canonical publication remain the only owners. In particular a
 * free root needs an explicit null assignment or the exact queued stationary
 * footprint above; pending.workflowId alone grants no settings authority.
 * This witness never grants execution or membership-transfer permission. */
export function capturePaneStripSettingsMembership(state,{workflowId,owner,tabIds,assignments,basis,beforeOrder}) {
  tabIds=[...tabIds];assignments=[...assignments];
  const membership=value=>tabIds.map(id=>[
    value.tabWorkflowMembership?.[id]??null,value.pendingTabWorkflowMembership?.[id]??null]);
  // Never keep state object references across the organization await.
  const captured=JSON.parse(stableJson(membership(state)));
  const envelope=readPaneStripReleasedPairs(state.paneStripReleasedPairs),pair=envelope.workflows[workflowId];
  const releasedOwner=pair&&paneStripLayoutOwner(pair.layout,owner);
  let pairAtCapture=false;
  try {
    pairAtCapture=!envelope.unrecognizedEnvelope&&!!pair&&['command','local'].includes(pair.status)
      &&pair.intent?.version===2&&pair.intent.workflowId===workflowId
      &&paneStripColorGroupsBasis(pair.field)===basis&&paneStripColorGroupsBasis(pair.intent.nextState)===basis
      &&!!releasedOwner&&same(paneStripSlotOrder(releasedOwner.slots),beforeOrder);
  } catch { /* An unknown/malformed pair cannot grant settings authority. */ }
  const adopted=captured.map(([canonical,pending],index)=>{
    if(!pairAtCapture||!canonical||!pending||pending.tabId!==tabIds[index]
      ||pending.workflowId!==workflowId||!Number.isSafeInteger(pending.revision))return null;
    const id=tabIds[index],groupId=assignments[index],mutationId=pending.localReleaseMutationId;
    const assigned=intent=>intent?.version===2&&intent.workflowId===workflowId&&intent.rootTabIds?.includes(id)
      &&intent.plan?.assignments?.some(value=>value.tabId===id&&value.groupId===groupId);
    if(mutationId) {
      const request=envelope.commands[mutationId]?.request;
      const intent=request?.stripGroupReleases?.find(value=>value.workflowId===workflowId);
      if(request?.mutationId!==mutationId||!assigned(intent))return null;
      const drag=request.tabs?.find(value=>value.tabId===id),local=request.tabWorkflowMembership?.[id];
      if(!(drag?.workflowId===pending.workflowId&&drag.expected?.membershipRevision
        +Number(drag.workflowId!==drag.expected.workflowId)===pending.revision)
        &&!(local?.workflowId===pending.workflowId&&local.revision===pending.revision
          &&local.expectedMembershipRevision===pending.revision-1))return null;
    } else {
      if(pair.status!=='local'||!pending.localReleaseQueued
        &&pending.localReleaseExpectedMembershipRevision!==pending.revision-1)return null;
      // Preserve group-member queued chains, and prove a free root either by
      // its explicit null assignment or the exact later stationary footprint.
      if(groupId===null&&!assigned(pair.intent)&&!stationaryQueuedFree(state,pair,pending,owner,id))return null;
    }
    const {localReleaseMutationId,localReleaseQueued,localReleaseExpectedMembershipRevision,...accepted}=pending;
    // Canonical may lag several already queued IN/OUT/IN revisions. Main
    // validates each step; only this exact result and pair retirement advance
    // this captured settings fence. There is no revision>= rebase.
    return {accepted,mutationId};
  });
  return {
    hasReleasedProof:id=>!!adopted[tabIds.indexOf(id)],
    isCurrent:value=>{
      const next=value.paneStripReleasedPairs?.version===1?readPaneStripReleasedPairs(value.paneStripReleasedPairs):null;
      return membership(value).every((tuple,index)=>{
        if(same(tuple,captured[index]))return true;
        const witness=adopted[index];
        return !!witness&&tuple[1]===null&&same(tuple[0],witness.accepted)
          &&next&&!next.unrecognizedEnvelope&&!next.workflows[workflowId]
          &&(!witness.mutationId||!next.commands[witness.mutationId]);
      });
    },
  };
}
