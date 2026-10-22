import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
import {workflowTabCatalog} from './workflowReserve.mjs';
import {paneTabs} from './splitPanesModel.mjs';
import {dragPlacement,dragRelation,dragFamily} from '../../shared/workflow-drag.cjs';
import {stableJson,layoutReferences} from '../../shared/workflow-organization.cjs';
import {normalizePaneStripRowPlacement,samePaneStripRowPlacement} from '../../shared/pane-strip-row-placement.cjs';
import {readPaneStripRowPlacement} from '../../shared/pane-strip-row-layout.cjs';
import {paneStripColorGroupsBasis} from '../../shared/pane-strip-color-groups.cjs';

// These are read proofs for a released chip presentation, never write guards,
// a second layout store, or permission to resend an immutable drag request.
export const samePaneEntries = (a,b) => Array.isArray(a) && Array.isArray(b)
  && a.length===b.length && a.every((entry,i)=>entry.tabId===b[i]?.tabId && entry.projectId===b[i]?.projectId);
export const panePresentationKey = (workflowId,windowId,centerKey) =>
  JSON.stringify([workflowId,windowId ? 'window':'center',windowId || centerKey || null]);
const layoutOf = (state,id) => id===state.activeSpaceId ? captureSpaceLayout(state)
  : state.spaces.find(space=>space.id===id)?.layout;
const centerEntries = (layout,key) => layout.centerStrips?.[key]
  || (layout.activeSpaceTab ? [layout.activeSpaceTab]:[]);
const same = (a,b) => stableJson(a)===stableJson(b);
const sameIds = (a,b) => same([...a].sort(),[...b].sort());
const rowsOf = (layout,windowId,centerKey,entries) => normalizePaneStripRowPlacement(
  readPaneStripRowPlacement(layout,{windowId,centerKey}),{order:entries.map(entry=>entry.tabId)});

/** The request and the actual React strip receipt must describe the same slot. */
export function createPaneDropPresentation(request,receipt,state) {
  if(request?.destinationKind!=='window' || request.gestureId!==receipt?.gestureId
    || receipt.workflowId!==request.targetWorkflowId || state.activeSpaceId!==receipt.workflowId
    || state.view!=='workspace')return null;
  const change=request.workflows.find(change=>change.workflowId===receipt.workflowId);
  if(!change)return null;
  const before=receipt.windowId ? change.beforeLayout.splitPanes?.find(pane=>pane.windowId===receipt.windowId)
    : null;
  const after=receipt.windowId ? change.layout.splitPanes?.find(pane=>pane.windowId===receipt.windowId) : null;
  if(receipt.windowId && (!before || before.displayHidden || !after || after.displayHidden))return null;
  const beforeEntries=receipt.windowId ? paneTabs(before):centerEntries(change.beforeLayout,receipt.centerKey);
  const afterEntries=receipt.windowId ? paneTabs(after):centerEntries(change.layout,receipt.centerKey);
  const rawRows=rowsOf(change.layout,receipt.windowId,receipt.centerKey,afterEntries);
  const measuredWidth=typeof receipt.stripWidth==='number' && Number.isFinite(receipt.stripWidth) && receipt.stripWidth>0;
  // React consumes the width-normalized rows, while Main keeps the captured
  // raw descriptor. An unmeasured explicit break supplies no layout proof.
  const effectiveRows=rawRows && !measuredWidth ? undefined : normalizePaneStripRowPlacement(
    rawRows,{order:afterEntries.map(entry=>entry.tabId),width:measuredWidth ? receipt.stripWidth:undefined});
  if(!samePaneEntries(beforeEntries,receipt.baseEntries) || !samePaneEntries(afterEntries,receipt.entries)
    || effectiveRows===undefined || !samePaneStripRowPlacement(effectiveRows,receipt.rowPlacement))return null;
  const release=request.stripGroupReleases?.find(value=>value.workflowId===receipt.workflowId);
  const groupAfterBasis=release?paneStripColorGroupsBasis(release.nextState):null;
  // Order and membership must have been shown by the SAME committed React
  // receipt. A painted order alone never proves an IN/OUT membership preview.
  if(release&&(paneStripColorGroupsBasis(receipt.baseGroupState)!==release.basis
    ||paneStripColorGroupsBasis(receipt.groupState)!==groupAfterBasis))return null;
  const strips=[];
  for(const pane of change.beforeLayout.splitPanes || []) {
    if(!pane.windowId || pane.displayHidden)continue;
    const next=change.layout.splitPanes?.find(item=>item.windowId===pane.windowId);
    if(!next || next.displayHidden)return null;
    const base=paneTabs(pane),entries=paneTabs(next);
    const rowPlacement=rowsOf(change.layout,pane.windowId,null,entries);
    if(!samePaneEntries(base,entries) || !samePaneStripRowPlacement(
      rowsOf(change.beforeLayout,pane.windowId,null,base),rowPlacement))
      strips.push({key:panePresentationKey(receipt.workflowId,pane.windowId),base,entries,rowPlacement});
  }
  if(!change.beforeLayout.splitPanes?.length) {
    const base=centerEntries(change.beforeLayout,receipt.centerKey),entries=centerEntries(change.layout,receipt.centerKey);
    const rowPlacement=rowsOf(change.layout,null,receipt.centerKey,entries);
    if(!samePaneEntries(base,entries) || !samePaneStripRowPlacement(
      rowsOf(change.beforeLayout,null,receipt.centerKey,base),rowPlacement))
      strips.push({key:panePresentationKey(receipt.workflowId,null,receipt.centerKey),base,entries,rowPlacement});
  }
  const targetKey=panePresentationKey(receipt.workflowId,receipt.windowId,receipt.centerKey);
  if(release&&release.basis!==groupAfterBasis&&!strips.some(strip=>strip.key===targetKey))
    strips.push({key:targetKey,base:beforeEntries,entries:afterEntries,rowPlacement:rawRows});
  if(release)for(const strip of strips)strip.groupState=release.nextState;
  // A no-op needs no owner beyond the existing canonical strip.
  if(!strips.some(strip=>strip.key===targetKey))return null;
  const presentation={request,strips,targetKey,targetOwner:receipt.owner,
    workflowId:receipt.workflowId,navigationRevision:state.navigationRevision,
    groupBeforeBasis:release?.basis||null,groupAfterBasis,
    phase:'pending'};
  return paneDropPresentationValid(presentation,state) ? presentation:null;
}

/** A later publication may have unchanged scope, or already contain this exact
 * proposed placement. Anything else is current truth and retires the preview.
 * Matching the proposal is only a presentation proof, never a durable ACK. */
export function paneDropPresentationValid(presentation,state,{applying=false}={}) {
  if(state.view!=='workspace' || state.activeSpaceId!==presentation.workflowId
    || !applying && state.navigationRevision!==presentation.navigationRevision)return false;
  if(presentation.groupAfterBasis) {
    const basis=paneStripColorGroupsBasis(state.spaces.find(space=>space.id===presentation.workflowId)?.stripColorGroups);
    if(basis!==presentation.groupBeforeBasis&&basis!==presentation.groupAfterBasis)return false;
  }
  return paneDropScopeCurrent(presentation.request,state);
}

/** Independent of any presentation owner. Also bounds foreground reveal after
 * an ACK: an accepted delta must not focus a removed/replaced window or source.
 * It neither authorizes a write nor replaces Main's admission/publication CAS. */
export function paneDropScopeCurrent(request,state) {
  const catalog=workflowTabCatalog(state),records={};
  const active=owner=>owner?.active && !owner.tab.archived && !owner.tab.isArchived && !owner.tab.archivedAt && !owner.tab.deleted;
  for(const [id,owner] of catalog)if(active(owner))records[id]=owner.tab;
  if(!sameIds(dragFamily(records,request.sourceRootTabIds),request.sourceFamilyIds)
    || !sameIds(dragFamily(records,request.paneRootTabIds,{physicalOnly:true}),request.paneFamilyIds))return false;
  for(const proposal of request.tabs) {
    const guard=proposal.expected,owner=catalog.get(proposal.tabId),member=state.tabWorkflowMembership[proposal.tabId];
    const identity=state.tabCatalog?.[proposal.tabId];
    // Window drops preserve relations and groups. Membership is the only
    // changed tab field; Main increments it once iff the workflow changes.
    const sameMember=member?.workflowId===guard.workflowId && member?.revision===guard.membershipRevision;
    const movedMember=member?.workflowId===proposal.workflowId
      && member?.revision===guard.membershipRevision+Number(proposal.workflowId!==guard.workflowId);
    if(!active(owner) || owner.projectId!==guard.namespace || !sameMember && !movedMember
      || !same(dragRelation(owner.tab),dragRelation(guard))
      || (identity?.storageId ?? identity?.executionSubject?.legacyStorageId ?? null)!==guard.storageId
      || (identity?.executionSubject?.subjectId || null)!==guard.subjectId
      || (state.globalGroups?.tabGroups[proposal.tabId] || null)!==guard.groupId
      || (state.globalGroups?.membershipRevisions?.[proposal.tabId] || 0)!==guard.groupRevision)return false;
  }
  for(const [groupId,expected] of Object.entries(request.groupScopes || {})) {
    const members=Object.entries(state.globalGroups?.tabGroups || {}).filter(([,id])=>id===groupId).map(([id])=>id);
    if(!sameIds(members,expected))return false;
  }
  for(const change of request.workflows) {
    const space=state.spaces.find(space=>space.id===change.workflowId);
    if(!space || (space.kind || 'user')!==change.expectedKind)return false;
    const current=dragPlacement(layoutOf(state,space.id));
    if(!same(current,change.expectedPlacement) && !same(current,dragPlacement(change.layout)))return false;
    if(!same(space.reserveOrder || [],change.expectedReserveOrder)
      && !same(space.reserveOrder || [],change.reserveOrder))return false;
    if(!same(space.reserveRootOrder || [],change.expectedReserveRootOrder)
      && !same(space.reserveRootOrder || [],change.reserveRootOrder))return false;
  }
  // Unrelated workflows are free to change. Only another placement of this
  // guarded family matters; layoutReferences includes display profiles too.
  const known=new Set(request.workflows.map(change=>change.workflowId));
  const family=new Set(request.guardedFamilyIds);
  for(const space of state.spaces) {
    if(known.has(space.id))continue;
    const refs=layoutReferences(layoutOf(state,space.id)).filter(ref=>family.has(ref.tabId))
      .map(({tabId,namespace,path,kind})=>({tabId,namespace,path,kind}));
    if(!same(refs,request.sourcePlacements[space.id] || []))return false;
  }
  return true;
}

export function paneDropPresentationCaughtUp(presentation,state) {
  const layout=layoutOf(state,presentation.workflowId);
  if(!layout)return false;
  if(presentation.groupAfterBasis&&paneStripColorGroupsBasis(
    state.spaces.find(space=>space.id===presentation.workflowId)?.stripColorGroups)!==presentation.groupAfterBasis)return false;
  return presentation.strips.every(strip=>{
    const [,kind,id]=JSON.parse(strip.key);
    const entries=kind==='window' ? paneTabs(layout.splitPanes?.find(pane=>pane.windowId===id)) : centerEntries(layout,id);
    return samePaneEntries(entries,strip.entries)
      && samePaneStripRowPlacement(rowsOf(layout,kind==='window'?id:null,kind==='center'?id:null,entries),strip.rowPlacement);
  });
}

/** A new drag recaptures the Store's current logical address, including an
 * already released pair awaiting ACK. Visual props alone grant no authority. */
export function canonicalPaneDragAddress(state,projectId,tabId) {
  const workflowId=state.pendingTabWorkflowMembership?.[tabId]?.workflowId
    || state.tabWorkflowMembership?.[tabId]?.workflowId || state.activeSpaceId;
  const layout=layoutOf(state,workflowId);
  if(!layout)return {sourceSpaceId:workflowId,sourcePaneKey:null};
  const index=(layout.splitPanes || []).findIndex(pane=>!pane.displayHidden
    && paneTabs(pane).some(entry=>entry.tabId===tabId && entry.projectId===projectId));
  const center=!layout.splitPanes?.length && Object.values(layout.centerStrips || {}).some(entries=>
    entries.some(entry=>entry.tabId===tabId && entry.projectId===projectId));
  return {sourceSpaceId:workflowId,sourcePaneKey:index>=0 ? `pane:${index}`:center?'center':null};
}
