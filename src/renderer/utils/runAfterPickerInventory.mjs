import {aiKindForTab} from './runAfterTabScope.mjs';
import {selectWorkflowMembers,workflowMemberOutline} from '../../shared/workflow-tree.cjs';
import {resolveWorkflowIcon} from './workflowVisuals.mjs';

// Canonical picker inventory is a complete AI membership view, independent of
// Mac window placement and execution namespace. Callers still own all actions.
export function canonicalRunAfterPickerInventory(state,{ownerTabId,selectedTabIds=[],selectedWorkflowIds=[],projects={},includeEmptyWorkflows=false}) {
  const catalog=new Map();
  for(const [projectId,workspace] of state.openProjects)for(const tab of workspace.tabs.values()) {
    const kind=aiKindForTab(tab);
    if(!kind || tab.parentTabId || state.tabCatalog?.[tab.id]?.active===false
      || tab.archived || tab.isArchived || tab.archivedAt || tab.deleted)continue;
    catalog.set(tab.id,{projectId,tabId:tab.id,active:true,tab:{...tab,kind,projectId,
      name:tab.name || tab.id.slice(-6),groupId:state.globalGroups?.tabGroups?.[tab.id] || undefined}});
  }
  const memberOf=id=>state.tabWorkflowMembership?.[id]?.workflowId || null;
  const ownerWorkflowId=memberOf(ownerTabId) || state.activeSpaceId;
  const firstSelected=selectedTabIds.find(id=>catalog.has(id));
  const selectedTargetWorkflowId=firstSelected?memberOf(firstSelected):selectedWorkflowIds[0] || null;
  const groups=[];
  for(const space of state.spaces) {
    const selection=selectWorkflowMembers({catalog,membership:state.tabWorkflowMembership,workflowId:space.id,
      orderedTabIds:space.reserveOrder || [],rootOrder:space.reserveRootOrder || [],globalGroups:state.globalGroups});
    const tabs=selection.items.map(owner=>owner.tab),rows=[];
    if(!includeEmptyWorkflows && !tabs.length && space.id!==ownerWorkflowId && !selectedWorkflowIds.includes(space.id))continue;
    const flatten=nodes=>nodes.flatMap(node=>[...(node.tabId?[catalog.get(node.tabId).tab]:[]),...flatten(node.children || [])]);
    for(const root of workflowMemberOutline(selection)) {
      const members=flatten([root]);
      if(root.kind==='group') {
        const group=state.globalGroups?.groups.find(group=>group.id===root.groupId);
        if(group && members.length)rows.push({type:'group',projectId:root.projectId,group,tabs:members,index:rows.length});
      } else for(const tab of members)rows.push({type:'tab',tab,index:rows.length});
    }
    groups.push({workflowId:space.id,name:space.name || 'Workflow',icon:resolveWorkflowIcon(space,id=>projects[id]?.icon || null),
      unplaced:false,isOwnerWorkflow:space.id===ownerWorkflowId,tabs,rows});
  }
  return {groups,ownerWorkflowId,selectedTargetWorkflowId};
}
