import {paneTabs} from './splitPanesModel.mjs';
import {editPaneStripColorGroups,paneStripGroupDragBoundary,classifyPaneStripColorSelection,normalizeStripGroupColor} from './paneStripSelectionModel.mjs';
import {validatePaneStripColorGroups,paneStripColorGroupsBasis,paneStripLayoutOwner,gatherPaneStripSlots,paneStripSlotOrder,projectActivePaneStripGroups} from '../../shared/pane-strip-color-groups.cjs';
import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
import {stableJson} from '../../shared/workflow-organization.cjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const entriesKey=entries=>JSON.stringify(entries.map(({projectId,tabId})=>[projectId,tabId]));
const empty=Object.freeze({version:1,revision:0,groups:Object.freeze([])});

/** Presentation metadata in the existing workflow organization snapshot. This
 * does not read/write globalGroups, tab parents, execution subjects or cwd. */
export function readPaneStripGroupState(state,workflowId) {
  const source=state.spaces.find(space=>space.id===workflowId)?.stripColorGroups;
  return source===undefined?empty:validatePaneStripColorGroups(source);
}
export function readPaneStripActiveGroups(state,workflowId) {
  return projectActivePaneStripGroups(readPaneStripGroupState(state,workflowId).groups,id=>state.tabCatalog?.[id]?.active);
}
export function paneStripGroupActivityFingerprint(state,workflowId) {
  const raw=state.spaces.find(space=>space.id===workflowId)?.stripColorGroups;
  if(!raw)return '';
  if(!Array.isArray(raw.groups))return 'unknown';
  return raw.groups.map(group=>Array.isArray(group.tabIds)?group.tabIds.map(id=>`${id}:${state.tabCatalog?.[id]?.active ?? '?'}`).join('|'):'?').join(';');
}

export function readPaneStripOwnerEntries(state,{workflowId,windowId,paneIndex}) {
  if(state.activeSpaceId!==workflowId)return null;
  if(paneIndex!==null) {
    const pane=windowId?state.splitPanes.find(pane=>pane.windowId===windowId):state.splitPanes[paneIndex];
    return !pane || pane.displayHidden?null:paneTabs(pane).filter(entry=>entry.tabId);
  }
  if(state.splitPanes.length)return null;
  const key=state.centerStripKey?.() || state.activeProjectId;
  const shown=state.activeSpaceTab || {projectId:state.activeProjectId,tabId:state.openProjects.get(state.activeProjectId)?.activeTabId};
  return state.centerStrips[key] || (shown?.tabId?[shown]:[]);
}

/** Read-only lease for the existing DnD owner. No subscription or DOM reads.
 * Order has its own fence: merely recoloring cannot grant a stale insertion. */
export function capturePaneStripGroupDrag({getState,owner,sourceIds,internalScope=false}) {
  const state=getState();let source;
  try{source=readPaneStripGroupState(state,owner.workflowId);}catch{
    return {boundary:{kind:'blocked',reason:'strip-groups-unavailable'},isCurrent:()=>false};
  }
  const order=readPaneStripOwnerEntries(state,owner);
  if(!order)return {boundary:{kind:'blocked',reason:'strip-owner-changed'},isCurrent:()=>false};
  const boundary=paneStripGroupDragBoundary(readPaneStripActiveGroups(state,owner.workflowId),{sourceIds,order});
  // A free drag may navigate to another workflow. Only a NEW color membership
  // revokes that freedom; the existing workflow drag owns identity/order guards.
  if(boundary.kind==='free')return {boundary,owner:{...owner},isCurrent:()=>{
    const next=getState();
    if(!next.spaces.some(space=>space.id===owner.workflowId))return false;
    try {return !readPaneStripGroupState(next,owner.workflowId).groups.some(group=>
      group.tabIds.some(id=>sourceIds.includes(id)));}catch{return false;}
  }};
  const key=entriesKey(order),revision=source.revision,navigationRevision=state.navigationRevision,basis=paneStripColorGroupsBasis(source);
  const proofOwner={...owner,centerKey:owner.paneIndex===null?(state.centerStripKey?.()||state.activeProjectId):null};
  const member=(value,id)=>value.pendingTabWorkflowMembership?.[id]||value.tabWorkflowMembership[id]||null;
  const memberships=sourceIds.map(id=>JSON.stringify(member(state,id)));
  return {boundary,internalScope:internalScope&&boundary.kind==='group',owner:{...owner},revision,isCurrent:()=>{
    const next=getState(),layout=next.activeSpaceId===owner.workflowId?captureSpaceLayout(next):next.spaces.find(space=>space.id===owner.workflowId)?.layout;
    const placed=paneStripLayoutOwner(layout,proofOwner),entries=placed?.slots.filter(entry=>entry.tabId);
    if(!entries || entriesKey(entries)!==key || internalScope&&(next.activeSpaceId!==owner.workflowId||next.navigationRevision!==navigationRevision))return false;
    try {if(paneStripColorGroupsBasis(readPaneStripGroupState(next,owner.workflowId))!==basis)return false;}catch{return false;}
    return sourceIds.every((id,index)=>JSON.stringify(member(next,id))===memberships[index]);
  }};
}

/** A candidate for the existing organization lane, not an optimistic store
 * publication. Main compares the explicit field basis; ACK adopts just this
 * field. Unrelated spaces/settings/layout references stay with their owner. */
export function editPaneStripGroupColor(state,{workflowId,entries,isCurrent},color,newId) {
  if(!state.organizationReady || state.isRestoring)fail('strip_groups_not_ready');
  if(!isCurrent())fail('strip_group_selection_changed');
  const before=readPaneStripGroupState(state,workflowId),ids=entries.map(entry=>entry.tabId);
  if(ids.some(id=>state.tabCatalog?.[id]?.active===false))fail('strip_group_selection_changed');
  const choice=classifyPaneStripColorSelection(readPaneStripActiveGroups(state,workflowId),ids);
  const nextColor=normalizeStripGroupColor(color);
  const groups=choice.kind==='recolor'?before.groups.map(group=>group.id===choice.group.id&&group.color!==nextColor
    ?{...group,color:nextColor,revision:group.revision+1}:group):editPaneStripColorGroups(before.groups,ids,color,newId);
  if(groups.every((group,index)=>group===before.groups[index]))return null;
  return state.spaces.map(space=>space.id===workflowId?{...space,
    stripColorGroups:{...before,revision:before.revision+1,groups}}:space);
}

/** CREATE gathers at first selected slot. Recolor never changes layout. */
export function preparePaneStripGroupColor(state,lease,color,newId) {
  const spaces=editPaneStripGroupColor(state,lease,color,newId);if(!spaces)return null;
  const choice=classifyPaneStripColorSelection(readPaneStripActiveGroups(state,lease.workflowId),lease.entries.map(entry=>entry.tabId));
  if(choice.kind!=='create')return {state:{...state,spaces},gather:undefined};
  const owner={windowId:lease.windowId,paneIndex:lease.paneIndex,centerKey:lease.paneIndex===null?(state.centerStripKey?.() || state.activeProjectId):null};
  const source=paneStripLayoutOwner(captureSpaceLayout(state),owner);if(!source)fail('strip_selection_changed');
  const slots=gatherPaneStripSlots(source.slots,lease.entries.map(entry=>entry.tabId));
  const patch=source.pane?{splitPanes:state.splitPanes.map((pane,index)=>index===source.paneIndex?{...pane,tabs:slots}:pane)}:
    {centerStrips:{...state.centerStrips,[source.centerKey]:slots}};
  return {state:{...state,...patch,spaces},gather:{owner,beforeSlots:source.slots}};
}

/** ACK may update order without taking focus or reusing a physical drag lease.
 * Apply just this window's slots while local order is still pre/accepted order;
 * keep newer local navigation/layout. Inactive workflow gets its saved layout. */
export function applyPaneStripGatherPublication(state,spaces,publishedSpaces,request) {
  let result={spaces};
  for(const edit of request?.stripColorGroupEdits||[]) {
    const placement=edit.gather||edit.arrange;if(!placement)continue;
    const space=spaces.find(space=>space.id===edit.workflowId),published=publishedSpaces.find(space=>space.id===edit.workflowId);
    if(!space||!published)continue;
    const layout=state.activeSpaceId===space.id?captureSpaceLayout(state):space.layout;
    const current=paneStripLayoutOwner(layout,placement.owner),incoming=paneStripLayoutOwner(published.layout,placement.owner);
    if(!current||!incoming)continue;
    const before=stableJson(paneStripSlotOrder(placement.beforeSlots)),proposed=paneStripLayoutOwner(request.spaces.find(item=>item.id===space.id)?.layout,placement.owner);
    if(stableJson(paneStripSlotOrder(current.slots))!==before&&stableJson(paneStripSlotOrder(current.slots))!==stableJson(paneStripSlotOrder(proposed?.slots||[])))continue;
    const key=slot=>JSON.stringify(paneStripSlotOrder([slot])[0]),local=new Map(current.slots.map(slot=>[key(slot),slot]));
    const slots=incoming.slots.map(slot=>({...slot,...local.get(key(slot))}));
    const patch=current.pane?{splitPanes:layout.splitPanes.map((pane,index)=>index===current.paneIndex?{...pane,tabs:slots}:pane)}:
      {centerStrips:{...layout.centerStrips,[current.centerKey]:slots}};
    result.spaces=result.spaces.map(candidate=>candidate.id===space.id?{...candidate,layout:{...layout,...patch}}:candidate);
    if(state.activeSpaceId===space.id)result={...result,...patch};
  }
  return result;
}

/** New metadata cannot outline old separated slots while retained props catch
 * the accepted gather. Already shown groups keep their outline during DnD. */
export function readyPaneStripOutlineGroups(groups,displayed,canonical,known) {
  const ids=new Set(groups.map(group=>group.id));for(const id of known)if(!ids.has(id))known.delete(id);
  const caught=!!canonical&&entriesKey(displayed)===entriesKey(canonical);
  return groups.filter(group=>{if(caught)known.add(group.id);return known.has(group.id);});
}
