'use strict';

const { selectWorkflowGlobalGroups, workflowGroupDisplayName } = require('./workflow-groups-projection.cjs');
const workflowGroupKey = (projectId,groupId) => JSON.stringify([projectId,groupId]);

// Membership selection is independent of desktop window placement.
function selectWorkflowMembers({catalog,membership,workflowId,orderedTabIds=[],excludedTabIds=new Set(),
  legacyGroups=new Map(),globalGroups=null,rootOrder=[]}) {
  const rank=new Map(orderedTabIds.map((id,index)=>[id,index]));
  const members=[...catalog.values()].filter(owner=>{
    const tab=owner.tab;
    return membership?.[owner.tabId]?.workflowId===workflowId && owner.active!==false
      && tab.archived!==true && tab.isArchived!==true && !tab.archivedAt && tab.deleted!==true;
  });
  if(rank.size)members.sort((a,b)=>(rank.get(a.tabId) ?? Infinity)-(rank.get(b.tabId) ?? Infinity));
  const items=members.filter(owner=>!excludedTabIds.has(owner.tabId));
  const groups=new Map(legacyGroups),visibleGroups=new Map();
  for(const owner of items){
    const key=workflowGroupKey(owner.projectId,owner.tab.groupId);
    if(groups.has(key))visibleGroups.set(key,groups.get(key));
  }
  const global=globalGroups && selectWorkflowGlobalGroups({publication:globalGroups,catalog,
    membership,workflowId,reserveTabIds:items.map(owner=>owner.tabId),orderedTabIds});
  if(global){
    groups.clear();visibleGroups.clear();
    for(const group of global.groups.values())groups.set(workflowGroupKey('__tab_catalog_v2__',group.id),{...group,projectId:'__tab_catalog_v2__'});
    for(const group of global.visibleGroups.values())visibleGroups.set(workflowGroupKey('__tab_catalog_v2__',group.id),{...group,projectId:'__tab_catalog_v2__'});
    const assignedGroups=new Set(global.tabGroups.values());
    for(const group of global.groups.values())if(group.reserveWorkflowId===workflowId && !assignedGroups.has(group.id))
      visibleGroups.set(workflowGroupKey('__tab_catalog_v2__',group.id),{...group,projectId:'__tab_catalog_v2__'});
  }
  return {workflowId,catalog,members,items,groups,visibleGroups,globalTabGroups:global?.tabGroups,rootOrder};
}

/** Stable node IDs survive reorder, partial groups and workflows. No cloning
 * or reparenting of the underlying catalog records occurs in this projection.
 */
function workflowMemberOutline(selection) {
  const byId = new Map(selection.items.map(owner => [owner.tabId, owner]));
  const parentOf = new Map();
  const groupOf = owner => {
    const globalId = selection.globalTabGroups?.get(owner.tabId);
    const key = globalId ? workflowGroupKey('__tab_catalog_v2__',globalId) : workflowGroupKey(owner.projectId, owner.tab.groupId);
    return selection.visibleGroups.has(key) ? key : null;
  };
  for (const owner of selection.items) {
    const parentId = owner.tab.visualParentTabId || owner.tab.parentTabId;
    const parent = byId.get(parentId);
    if (!parent || parent === owner || groupOf(parent) !== groupOf(owner)) continue;
    const visited = new Set([owner.tabId]);
    let cursor = parentId, cyclic = false;
    while (byId.has(cursor)) {
      if (visited.has(cursor)) { cyclic = true; break; }
      visited.add(cursor);
      const tab = byId.get(cursor).tab;
      cursor = tab.visualParentTabId || tab.parentTabId;
    }
    if (!cyclic) parentOf.set(owner.tabId, parentId);
  }
  const contextFor = owner => {
    const parentId = owner.tab.visualParentTabId || owner.tab.parentTabId;
    const parent = !parentOf.has(owner.tabId) && selection.catalog.get(parentId);
    return parent ? { projectId: parent.projectId, tabId: parent.tabId, name: parent.tab.name || '' } : null;
  };
  const nodes = new Map(selection.items.map(owner => [owner.tabId, {
    id: `reserve-tab:${owner.tabId}`, kind: 'tab', entityType: 'tab', label: owner.tab.name || '',
    projectId: owner.projectId, tabId: owner.tabId, children: [], expanded: true,
    contextParent: contextFor(owner),
  }]));
  const result = [], groupNodes = new Map();
  for (const owner of selection.items) {
    const node = nodes.get(owner.tabId), parent = nodes.get(parentOf.get(owner.tabId));
    if (parent) { parent.children.push(node); continue; }
    const key = groupOf(owner);
    if (!key) { result.push(node); continue; }
    if (!groupNodes.has(key)) {
      const group = selection.visibleGroups.get(key);
      const groupNode = { id: `reserve-group:${key}`, kind: 'group', entityType: 'group',
        projectId: group.projectId, groupId: group.id, label: workflowGroupDisplayName(group),
        collapsible: true, expanded: !group.collapsed, children: [] };
      groupNodes.set(key, groupNode); result.push(groupNode);
    }
    groupNodes.get(key).children.push(node);
  }
  for (const [key, group] of selection.visibleGroups) if (!groupNodes.has(key)) result.push({
    id: `reserve-group:${key}`, kind: 'group', entityType: 'group',
    projectId: group.projectId, groupId: group.id, label: workflowGroupDisplayName(group),
    collapsible: true, expanded: !group.collapsed, children: [],
  });
  if(selection.rootOrder?.length) {
    const rank=new Map(selection.rootOrder.map((id,index)=>[id,index]));
    result.sort((a,b)=>(rank.get(a.id) ?? Infinity)-(rank.get(b.id) ?? Infinity));
  }
  return result;
}

module.exports = {workflowGroupKey,selectWorkflowMembers,workflowMemberOutline};
