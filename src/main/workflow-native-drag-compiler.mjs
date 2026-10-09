// This entry is bundled for Main, using the same pure compiler and outline
// operations as desktop. It never imports a renderer store or starts a renderer.
import {captureWorkflowDrag,workflowDragRequest} from '../renderer/utils/workflowDragModel.mjs';
import {projectReservePaneSource} from '../renderer/utils/workflowReserve.mjs';
import {selectWorkflowMembers,workflowMemberOutline} from '../shared/workflow-tree.cjs';
import {catalogHydrationOrder} from '../shared/workflow-catalog-projection.cjs';
import {executionScopeForRow} from '../shared/workflow-organization.cjs';
import {prepareDrag,projectVerticalMove,enumerateVisibleSlots,findNodeLocation,
  indentNode,outdentNode} from '@noted/structured-dnd/core';
import {tabOutlineHorizontalPolicy,tabOutlineVerticalSlotPolicy} from '../renderer/components/Workspace/tabOutlineModel.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:409});};
const clone=value=>JSON.parse(JSON.stringify(value));
export const version=1;

export function captureNativeDrag({snapshot,dto,namespaceOrder,legacyNamespaces},input) {
  const workflow=snapshot.workflows.find(item=>item.id===input.workflowId);
  if(!workflow)fail('workflow_not_found');
  const catalog=new Map(),openProjects=new Map(),tabCatalog={},members={};
  for(const entry of catalogHydrationOrder(snapshot.tabs,namespaceOrder,legacyNamespaces)) {
    const row=dto.rows[entry.tabId],ref=dto.executionRefs[entry.tabId];
    if(!row || !ref)continue;
    const tab={...row,id:row.tabId};
    catalog.set(row.tabId,{projectId:ref.namespace,tabId:row.tabId,tab,active:true});
    if(!openProjects.has(ref.namespace))openProjects.set(ref.namespace,{tabs:new Map()});
    openProjects.get(ref.namespace).tabs.set(row.tabId,tab);
    tabCatalog[row.tabId]={active:true,storageId:ref.storageId,executionSubject:ref.subject};
    members[row.tabId]=entry.membership;
  }
  const spaces=snapshot.workflows.map(item=>({...item.metadata,id:item.id,kind:item.kind,layout:item.layout}));
  const state={spaces,activeSpaceId:workflow.id,...workflow.layout,openProjects,tabCatalog,
    tabWorkflowMembership:members,globalGroups:snapshot.globalGroups,organizationRevision:snapshot.publication.revision};
  const trees=Object.fromEntries(spaces.map(space=>[space.id,workflowMemberOutline(selectWorkflowMembers({
    catalog,membership:members,workflowId:space.id,globalGroups:snapshot.globalGroups,
    orderedTabIds:space.reserveOrder || [],rootOrder:space.reserveRootOrder || []}))]));
  if((input.selectedTabIds || []).some(id=>!catalog.has(id) || members[id]?.workflowId!==workflow.id))fail('workflow_drag_selection_invalid');
  const admission=captureWorkflowDrag(state,{gestureId:input.gestureId,outline:trees[workflow.id],
    sourceId:input.sourceId,selectedTabIds:input.selectedTabIds || []});
  if(!admission)fail('workflow_drag_source_missing');
  return clone({admission,trees,catalog:[...catalog],executionSubjects:Object.fromEntries(
    snapshot.tabs.filter(tab=>catalog.has(tab.tabId)).map(tab=>[tab.tabId,executionScopeForRow(tab.nativeRow || tab.legacyRow)]))});
}

export function previewNativeDrag(captured,destination) {
  const {admission}=captured,workflowId=destination?.workflowId;
  if(!Object.hasOwn(captured.trees,workflowId))fail('workflow_not_found');
  if(!Array.isArray(destination.actions) || destination.actions.length>64)fail('workflow_drag_actions_invalid');
  const projected=projectReservePaneSource({workflowId,catalog:new Map(captured.catalog)},clone(captured.trees[workflowId]),
    {owner:'sidebar',workflowDrag:admission});
  if(!projected)fail('workflow_drag_projection_conflict');
  const initial=projected.outline;
  let tree=initial;
  for(const action of destination.actions) {
    const source=findNodeLocation(tree,admission.sourceId)?.node;
    if(!source)fail('workflow_drag_source_missing');
    if(action.kind==='reorder') {
      if(!Number.isSafeInteger(action.index) || action.index<0 || !(action.parentId===null || typeof action.parentId==='string'))fail('workflow_drag_slot_invalid');
      const prepared=prepareDrag(tree,admission.sourceId,{sourceRootIds:admission.sourceRootIds});
      const slot=enumerateVisibleSlots(prepared.baseTree,{includeAllEmptyParents:true})
        .find(slot=>slot.parentId===action.parentId && slot.index===action.index);
      if(!slot)fail('workflow_drag_slot_invalid');
      const canUseSlot=target=>prepared.sourceNodes.every(node=>
        tabOutlineVerticalSlotPolicy({sourceNode:node,baseOutline:prepared.baseTree,slot:target})
        && (!admission.guards[node.tabId]?.parentTabId
          || findNodeLocation(initial,node.id)?.parentId===target.parentId));
      if(!canUseSlot(slot))fail('workflow_drag_host_policy');
      const result=projectVerticalMove({...prepared,boundary:slot.boundary,preferredDepth:slot.depth,
        currentParentId:slot.parentId,canUseSlot});
      if(result.slot.parentId!==slot.parentId || result.slot.index!==slot.index)fail('workflow_drag_slot_invalid');
      tree=result.tree;
    } else if(action.kind==='indent' || action.kind==='outdent') {
      if(admission.multiSelected || source.groupId || admission.guards[source.tabId]?.parentTabId)fail('workflow_drag_host_policy');
      const result=(action.kind==='indent'?indentNode:outdentNode)(tree,admission.sourceId);
      if(!result.ok || !tabOutlineHorizontalPolicy({sourceNode:source,result}).ok)fail('workflow_drag_host_policy');
      tree=result.tree;
      // An explicit outdent is distinct from preserving a contextual parent
      // during cross-workflow adoption. Do not resurrect that old visual link.
      if(action.kind==='outdent')findNodeLocation(tree,admission.sourceId).node.contextParent=null;
    } else fail('workflow_drag_action_unknown');
  }
  const request=workflowDragRequest(admission,{workflowId,previewOutline:tree});
  if(!request)fail('workflow_drag_plan_invalid');
  request.nativeScope={version:1,subjects:Object.fromEntries(request.tabs.map(tab=>[tab.tabId,captured.executionSubjects[tab.tabId]])),
    groupDefinitions:Object.fromEntries(Object.keys(request.groupScopes).map(id=>[id,admission.groupDefinitions.find(group=>group.id===id)?.revision])),
    treeScopes:Object.fromEntries([...new Set([admission.sourceWorkflowId,workflowId])].map(id=>[id,{
      activeTabIds:captured.catalog.filter(([,owner])=>owner.tab.membership.workflowId===id).map(([tabId])=>tabId).sort(),
      emptyGroupIds:captured.trees[id].filter(node=>node.groupId && !node.children.length).map(node=>node.groupId).sort(),
    }]))};
  return {request,tree};
}
