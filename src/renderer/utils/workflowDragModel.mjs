import {normalizeDragRoots,getSubtreeIds} from '@noted/structured-dnd/core';
import {workflowTabCatalog,workflowReserveOutline} from './workflowReserve.mjs';
import {captureSpaceLayout} from './workspaceSpacesModel.mjs';
import {moveTabsToPane} from './splitPanesModel.mjs';
import {moveEntriesToIndex} from './horizontalReorder.mjs';
import {removeLayoutTabs,stableJson,layoutReferences} from '../../shared/workflow-organization.cjs';
import {dragPlacement,dragRelation,dragFamily} from '../../shared/workflow-drag.cjs';
import {projectPaneStripLayoutRows} from '../../shared/pane-strip-row-layout.cjs';

const freeze = value => {
  if(value && typeof value==='object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const json = value => JSON.parse(JSON.stringify(value));
const visit = (nodes,fn,parent=null,group=null) => nodes.forEach(node=>{
  fn(node,parent,group); visit(node.children || [],fn,node.tabId || parent,node.groupId || group);
});

export function captureWorkflowDrag(state,{gestureId,outline,sourceId,selectedTabIds=[],entries,origin='sidebar',sourcePaneKey=null,sourceWorkflowId=state.activeSpaceId}) {
  const catalog=workflowTabCatalog(state), guards={};
  for(const [id,owner] of catalog) {
    if(!owner.active || owner.tab.archived || owner.tab.isArchived || owner.tab.archivedAt || owner.tab.deleted)continue;
    const member=state.tabWorkflowMembership[id]; if(!member)continue;
    guards[id]={...dragRelation(owner.tab),namespace:owner.projectId,workflowId:member.workflowId,
      membershipRevision:member.revision,groupId:state.globalGroups?.tabGroups[id] || null,
      groupRevision:state.globalGroups?.membershipRevisions?.[id] || 0,
      storageId:state.tabCatalog?.[id]?.storageId ?? state.tabCatalog?.[id]?.executionSubject?.legacyStorageId ?? null,
      subjectId:state.tabCatalog?.[id]?.executionSubject?.subjectId || null};
  }
  let tree=outline;
  if(!tree) tree=workflowReserveOutline({catalog,reserve:[...catalog.values()].filter(owner=>guards[owner.tabId]),
    visibleGroups:new Map(),globalTabGroups:new Map()});
  const nodes=new Map(); visit(tree,node=>nodes.set(String(node.id),node));
  const picked=nodes.get(sourceId); if(!picked)return null;
  const requested=entries ? entries.map(entry=>`reserve-tab:${entry.tabId}`)
    : picked.tabId && selectedTabIds.includes(picked.tabId) ? selectedTabIds.map(id=>`reserve-tab:${id}`) : [sourceId];
  const sourceRootIds=normalizeDragRoots(tree,requested), sourceNodes=sourceRootIds.map(id=>nodes.get(id));
  const outlineIds=sourceNodes.flatMap(getSubtreeIds);
  if(!outlineIds.includes(sourceId))return null;
  const rootTabIds=sourceNodes.flatMap(node=>node.tabId ? [node.tabId] : (node.children || []).map(child=>child.tabId).filter(Boolean));
  const familyIds=dragFamily(guards,rootTabIds);
  if(!familyIds.length && !picked.groupId)return null;
  const paneEntries=[...new Set(rootTabIds.map(id=>guards[id]?.parentTabId || id))]
    .map(id=>({projectId:guards[id]?.namespace,tabId:id}));
  if(paneEntries.some(entry=>!entry.projectId))return null;
  // Window placement follows the established typed family: visual AI children
  // stay independent; physical subagents/files follow the represented owner.
  const paneFamilyIds=dragFamily(guards,paneEntries.map(entry=>entry.tabId),{physicalOnly:true});
  // The final JSON snapshot below detaches every layout before freezing it.
  // Cloning each layout here would traverse the same payload a second time.
  const workflows=Object.fromEntries(state.spaces.map(space=>[space.id,{
    layout:space.id===state.activeSpaceId ? captureSpaceLayout(state):space.layout || {},
    reserveOrder:[...(space.reserveOrder || [])],
    reserveRootOrder:[...(space.reserveRootOrder || [])],
    kind:space.kind || 'user',
  }]));
  if(!workflows[sourceWorkflowId])return null;
  return freeze(json({version:1,gestureId,origin,sourceWorkflowId,sourceId,sourcePaneKey,
    multiSelected:requested.length>1,
    presentationRootOrder:origin==='sidebar' ? tree.map(node=>node.id):[],
    sourceRootIds,sourceNodes,rootTabIds,familyIds,paneEntries,paneFamilyIds,guards,workflows,
    groupDefinitions:(state.globalGroups?.groups || []).map(group=>({id:group.id,revision:group.revision,reserveWorkflowId:group.reserveWorkflowId || null})),
    groupMembers:Object.fromEntries((state.globalGroups?.groups || []).map(group=>[group.id,
      Object.entries(state.globalGroups?.tabGroups || {}).filter(([,id])=>id===group.id).map(([id])=>id)])),
    expectedRevision:state.organizationRevision}));
}

export function workflowDragSourceValid(admission,state) {
  if(!admission)return false;
  const catalog=workflowTabCatalog(state);
  const source=state.spaces.find(space=>space.id===admission.sourceWorkflowId);
  if(!source || (source.kind || 'user')!==admission.workflows[admission.sourceWorkflowId]?.kind)return false;
  const active=owner=>owner.active && !owner.tab.archived && !owner.tab.isArchived && !owner.tab.archivedAt && !owner.tab.deleted;
  const records=Object.fromEntries([...catalog].filter(([,owner])=>active(owner)).map(([id,owner])=>[id,owner.tab]));
  const sameIds=(a,b)=>stableJson([...a].sort())===stableJson([...b].sort());
  if(!sameIds(dragFamily(records,admission.rootTabIds),admission.familyIds)
    || !sameIds(dragFamily(records,admission.paneEntries.map(entry=>entry.tabId),{physicalOnly:true}),admission.paneFamilyIds))return false;
  if(!admission.familyIds.every(id=>{
    const owner=catalog.get(id),expected=admission.guards[id],member=state.tabWorkflowMembership[id];
    return owner && active(owner)
      && member?.revision===expected?.membershipRevision && member?.workflowId===expected.workflowId
      && owner.projectId===expected.namespace && stableJson(dragRelation(owner.tab))===stableJson(dragRelation(expected))
      && (state.tabCatalog?.[id]?.storageId ?? state.tabCatalog?.[id]?.executionSubject?.legacyStorageId ?? null)===expected.storageId
      && (state.tabCatalog?.[id]?.executionSubject?.subjectId || null)===expected.subjectId
      && (state.globalGroups?.tabGroups[id] || null)===expected.groupId
      && (state.globalGroups?.membershipRevisions?.[id] || 0)===expected.groupRevision;
  }))return false;
  for(const node of admission.sourceNodes)if(node.groupId) {
    const expected=admission.groupDefinitions.find(group=>group.id===node.groupId);
    const group=state.globalGroups?.groups.find(group=>group.id===node.groupId);
    const members=Object.entries(state.globalGroups?.tabGroups || {}).filter(([,id])=>id===node.groupId).map(([id])=>id);
    if(!group || !expected || !sameIds(members,admission.groupMembers[node.groupId] || []))return false;
    if(!admission.groupMembers[node.groupId]?.length && (group.revision!==expected.revision
      || (group.reserveWorkflowId || null)!==expected.reserveWorkflowId))return false;
  }
  const family=new Set([...admission.familyIds,...admission.paneFamilyIds]);
  const liveSpaces=new Map(state.spaces.map(space=>[space.id,space]));
  for(const id of new Set([...Object.keys(admission.workflows),...liveSpaces.keys()])) {
    const space=liveSpaces.get(id),before=admission.workflows[id]?.layout || {};
    const current=id===state.activeSpaceId ? captureSpaceLayout(state):space?.layout || {};
    if([...layoutReferences(before),...layoutReferences(current)].some(ref=>family.has(ref.tabId))
      && stableJson(dragPlacement(current))!==stableJson(dragPlacement(before)))return false;
  }
  return true;
}

/** Compile one painted command without reading selection or changing the store. */
export function workflowDragRequest(admission,{workflowId,previewOutline,target=null}) {
  if(!admission?.workflows[workflowId])return null;
  const incoming=admission.origin==='pane' || workflowId!==admission.sourceWorkflowId;
  const moveMembership=target ? workflowId!==admission.sourceWorkflowId : incoming;
  const movingFamilyIds=target ? admission.paneFamilyIds : admission.familyIds;
  const guardedFamilyIds=[...new Set([...admission.familyIds,...(target ? admission.paneFamilyIds:[])])];
  const emptyGroupMoves=!target && workflowId!==admission.sourceWorkflowId ? admission.sourceNodes
    .filter(node=>node.groupId && !node.children?.length && !admission.groupMembers[node.groupId]?.length)
    .map(node=>({groupId:node.groupId,sourceWorkflowId:admission.sourceWorkflowId,workflowId,
      expectedGroupRevision:admission.groupDefinitions.find(group=>group.id===node.groupId)?.revision,
      expectedReserveWorkflowId:admission.groupDefinitions.find(group=>group.id===node.groupId)?.reserveWorkflowId || null})) : [];
  const tabs=[],order=[];
  if(!target) visit(previewOutline,node=>{if(node.tabId)order.push(node.tabId);});
  const wanted=new Map();
  if(!target) visit(previewOutline,(node,parent,group)=>{
    if(node.tabId)wanted.set(node.tabId,{parent:parent || node.contextParent?.tabId || null,groupId:group});
  });
  const memberIds=new Set([...guardedFamilyIds,...wanted.keys()]);
  for(const id of memberIds) {
    const guard=admission.guards[id]; if(!guard)return null;
    const proposed=wanted.get(id);
    const moves=movingFamilyIds.includes(id);
    const parent=proposed ? proposed.parent:guard.visualParentTabId;
    // Physical execution ownership is immutable; a file's visual link is editable.
    if(guard.parentTabId && proposed && parent!==(guard.visualParentTabId || guard.parentTabId))return null;
    tabs.push({tabId:id,expected:guard,workflowId:moves && moveMembership ? workflowId:guard.workflowId,
      groupId:proposed ? proposed.groupId:guard.groupId,
      visualParentTabId:guard.parentTabId ? guard.visualParentTabId:parent});
  }
  const workflows=[];
  for(const [id,baseline] of Object.entries(admission.workflows)) {
    let layout=structuredClone(baseline.layout);
    if(incoming || target)layout=removeLayoutTabs(layout,target && !moveMembership
      ? admission.paneEntries.map(entry=>entry.tabId):movingFamilyIds);
    let reserveOrder=baseline.reserveOrder;
    if(id===workflowId && !target) {
      const subset=new Set(order);let at=0;
      reserveOrder=baseline.reserveOrder.map(id=>subset.has(id)?order[at++]:id);
      reserveOrder.push(...order.slice(at));
    }
    if(id===workflowId && target) {
      const entries=admission.paneEntries;
      const samePane=admission.origin==='pane' && admission.sourceWorkflowId===workflowId && admission.sourcePaneKey===target.paneKey;
      const prior=target.paneIndex==null ? baseline.layout.activeSpaceTab : baseline.layout.splitPanes?.[target.paneIndex];
      const shown=samePane && prior?.tabId ? {projectId:prior.projectId,tabId:prior.tabId}
        : entries.find(entry=>`reserve-tab:${entry.tabId}`===admission.sourceId) || entries[0];
      if(target.paneIndex==null) {
        const key=baseline.layout.activeProjectId || shown.projectId;
        const previous=baseline.layout.centerStrips?.[key] || (baseline.layout.activeSpaceTab?[baseline.layout.activeSpaceTab]:[]);
        const strip=moveEntriesToIndex(previous,entries,target.at);
        layout={...layout,centerStrips:{...layout.centerStrips,[key]:strip},activeSpaceTab:shown,
          activeProjectId:shown.projectId,focusedProjectId:shown.projectId};
      } else {
        const pane=baseline.layout.splitPanes?.[target.paneIndex];
        if(!pane || pane.displayHidden)return null;
        const index=(layout.splitPanes || []).findIndex(item=>item.windowId===pane.windowId);
        const moved=moveTabsToPane(layout.splitPanes,index,entries,target.at,shown.tabId);
        if(!moved)return null;
        layout={...layout,splitPanes:moved.panes,splitFocusedIndex:index,activeSpaceTab:shown,
          activeProjectId:shown.projectId,focusedProjectId:shown.projectId};
      }
    }
    if(target) {
      const targetPane=id===workflowId && target.paneIndex!=null ? baseline.layout.splitPanes?.[target.paneIndex] : null;
      const targetKey=id===workflowId && target.paneIndex==null
        ? baseline.layout.activeProjectId || admission.paneEntries[0]?.projectId : null;
      layout=projectPaneStripLayoutRows(baseline.layout,layout,{
        sourceIds:admission.paneEntries.map(entry=>entry.tabId),
        target:id===workflowId ? {windowId:targetPane?.windowId,paneIndex:target.paneIndex,centerKey:targetKey,
          rowStartId:target.rowStartId,width:target.stripWidth}:null,
      });
    }
    const preserveSourceOrder=!!target && admission.origin==='sidebar' && id===admission.sourceWorkflowId;
    let rootOrder=baseline.reserveRootOrder;
    if(preserveSourceOrder && admission.presentationRootOrder?.length){
      const visible=new Set(admission.presentationRootOrder);let at=0;
      // Preserve hidden persisted ranks while materializing the pickup order.
      // Window placement must not reorder containers by their new first member.
      rootOrder=rootOrder.map(id=>visible.has(id)?admission.presentationRootOrder[at++]:id);
      rootOrder.push(...admission.presentationRootOrder.slice(at));
    }
    if(id===workflowId || preserveSourceOrder || emptyGroupMoves.length && id===admission.sourceWorkflowId
      || stableJson(layout)!==stableJson(baseline.layout))workflows.push({workflowId:id,
      expectedKind:baseline.kind,
      expectedPlacement:dragPlacement(baseline.layout),expectedReserveOrder:baseline.reserveOrder,
      expectedReserveRootOrder:baseline.reserveRootOrder,
      reserveRootOrder:id===workflowId && !target ? previewOutline.map(node=>node.id) : rootOrder,
      beforeLayout:baseline.layout,layout, reserveOrder});
  }
  const involvedGroups=new Set([...tabs.flatMap(tab=>[tab.groupId,tab.expected.groupId]),
    ...admission.sourceNodes.map(node=>node.groupId)].filter(Boolean));
  const groupScopes=Object.fromEntries([...involvedGroups].map(id=>[id,admission.groupMembers[id]]));
  if(Object.values(groupScopes).some(value=>!value))return null;
  const family=new Set(guardedFamilyIds);
  const sourcePlacements=Object.fromEntries(Object.entries(admission.workflows).map(([id,space])=>[id,
    layoutReferences(space.layout).filter(ref=>family.has(ref.tabId)).map(({tabId,namespace,path,kind})=>({tabId,namespace,path,kind}))])
    .filter(([,refs])=>refs.length));
  return {version:1,mutationId:`workflow-drag:${admission.gestureId}`,expectedRevision:admission.expectedRevision,
    gestureId:admission.gestureId,sourceRootTabIds:admission.rootTabIds,sourceFamilyIds:admission.familyIds,
    paneRootTabIds:admission.paneEntries.map(entry=>entry.tabId),paneFamilyIds:admission.paneFamilyIds,guardedFamilyIds,movingFamilyIds,
    tabs,workflows,groupScopes,sourcePlacements,emptyGroupMoves,targetWorkflowId:workflowId,destinationKind:target?'window':'reserve'};
}
