import { selectWorkflowGlobalGroups, workflowGroupDisplayName } from './workflowGlobalGroups.mjs';
// Organization only. Legacy namespaces address cards/actions, never membership.
const entries = value => value instanceof Map ? [...value] : Object.entries(value || {});
const list = value => Array.isArray(value) ? value : [];
const idOf = value => typeof value === 'string' ? value : value?.tabId;
export const workflowGroupKey = (projectId, groupId) => JSON.stringify([projectId, groupId]);

/** Current layout supersedes its stale saved projection; profiles still count.
 * Read only placement fields, never return history/detached tabs/chooser IDs.
 * Geometry-only monitor profiles naturally add no new content references.
 */
export function workflowPlacedTabIds(state) {
  const placed = new Set(), seen = new Set();
  const add = ref => { const id = idOf(ref); if (typeof id === 'string' && id) placed.add(id); };
  const visit = layout => {
    if (!layout || typeof layout !== 'object' || seen.has(layout)) return;
    seen.add(layout);
    for (const pane of list(layout.splitPanes)) {
      add(pane);
      for (const ref of list(pane?.tabs)) add(ref);
    }
    for (const [, strip] of entries(layout.centerStrips)) for (const ref of list(strip)) add(ref);
    add(layout.activeSpaceTab);
    for (const [, profile] of entries(layout.windowDisplayLayouts)) visit(profile);
  };
  const active = list(state.spaces).find(space => space.id === state.activeSpaceId);
  // If a caller has only a durable snapshot, its active space is authoritative.
  const live = ['splitPanes', 'centerStrips', 'activeSpaceTab'].some(key => Object.hasOwn(state, key));
  visit(live ? { ...state, windowDisplayLayouts: state.windowDisplayLayouts ?? active?.layout?.windowDisplayLayouts } : active?.layout);
  for (const space of list(state.spaces)) if (space.id !== state.activeSpaceId) visit(space.layout);
  return placed;
}

export function workflowTabCatalog(state) {
  const catalog = new Map();
  for (const [projectId, bucket] of entries(state.openProjects)) {
    for (const [key, tab] of entries(bucket?.tabs)) {
      const tabId = tab?.id || key;
      if (!tabId || catalog.has(tabId)) continue;
      const physicalParent=tab.parentTabId || state.tabCatalog?.[tabId]?.physicalParentTabId;
      catalog.set(tabId, { projectId, tabId, tab:physicalParent && !tab.parentTabId ? {...tab,parentTabId:physicalParent}:tab,
        active:state.tabCatalog?.[tabId]?.active !== false });
    }
  }
  return catalog;
}

export function selectWorkflowReserve(state, workflowId = state.activeSpaceId, orderedTabIds = []) {
  const catalog = workflowTabCatalog(state), placed = workflowPlacedTabIds(state);
  const rank = new Map(orderedTabIds.map((id, index) => [id, index]));
  const members = [...catalog.values()].filter(owner => {
    const tab = owner.tab;
    return state.tabWorkflowMembership?.[owner.tabId]?.workflowId === workflowId
      && owner.active && tab.archived !== true && tab.isArchived !== true && !tab.archivedAt && tab.deleted !== true;
  });
  if (rank.size) members.sort((a, b) => (rank.get(a.tabId) ?? Infinity) - (rank.get(b.tabId) ?? Infinity));
  const reserve = members.filter(owner => !placed.has(owner.tabId));
  const groups = new Map();
  for (const [projectId, bucket] of entries(state.openProjects)) {
    for (const group of list(bucket?.tabGroups)) groups.set(workflowGroupKey(projectId, group.id), { ...group, projectId });
  }
  const filesByOwner = new Map();
  for (const owner of catalog.values()) {
    const file = owner.tab;
    if (file.tabType !== 'file' || !file.filePath || !file.visualParentTabId) continue;
    const files = filesByOwner.get(file.visualParentTabId) || [];
    files.push({ ...owner, path: file.filePath });
    filesByOwner.set(file.visualParentTabId, files);
  }
  // Definitions remain global; only populated reserve group projections render.
  const visibleGroups = new Map();
  for (const owner of reserve) {
    const key = workflowGroupKey(owner.projectId, owner.tab.groupId);
    if (groups.has(key)) visibleGroups.set(key, groups.get(key));
  }
  const global = state.globalGroups && selectWorkflowGlobalGroups({publication:state.globalGroups,catalog,
    membership:state.tabWorkflowMembership,workflowId,reserveTabIds:reserve.map(owner => owner.tabId),orderedTabIds});
  if (global) {
    groups.clear(); visibleGroups.clear();
    for (const group of global.groups.values()) groups.set(workflowGroupKey('__tab_catalog_v2__',group.id),{...group,projectId:'__tab_catalog_v2__'});
    for (const group of global.visibleGroups.values()) visibleGroups.set(workflowGroupKey('__tab_catalog_v2__',group.id),{...group,projectId:'__tab_catalog_v2__'});
    const assignedGroups = new Set(global.tabGroups.values());
    for (const group of global.groups.values()) if (group.reserveWorkflowId === workflowId && !assignedGroups.has(group.id))
      visibleGroups.set(workflowGroupKey('__tab_catalog_v2__',group.id),{...group,projectId:'__tab_catalog_v2__'});
  }
  const rootOrder=list(state.spaces).find(space=>space.id===workflowId)?.reserveRootOrder || [];
  return { workflowId, catalog, members, reserve, placed, groups, visibleGroups, filesByOwner, globalTabGroups:global?.tabGroups,rootOrder };
}

/** Stable node IDs survive reorder, partial groups and workflows. No cloning
 * or reparenting of the underlying catalog records occurs in this projection.
 */
export function workflowReserveOutline(selection) {
  const byId = new Map(selection.reserve.map(owner => [owner.tabId, owner]));
  const parentOf = new Map();
  const groupOf = owner => {
    const globalId = selection.globalTabGroups?.get(owner.tabId);
    const key = globalId ? workflowGroupKey('__tab_catalog_v2__',globalId) : workflowGroupKey(owner.projectId, owner.tab.groupId);
    return selection.visibleGroups.has(key) ? key : null;
  };
  for (const owner of selection.reserve) {
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
  const nodes = new Map(selection.reserve.map(owner => [owner.tabId, {
    id: `reserve-tab:${owner.tabId}`, kind: 'tab', entityType: 'tab', label: owner.tab.name || '',
    projectId: owner.projectId, tabId: owner.tabId, children: [], expanded: true,
    contextParent: contextFor(owner),
  }]));
  const result = [], groupNodes = new Map();
  for (const owner of selection.reserve) {
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

export function reserveNodeEntries(node) {
  const result = [];
  const walk = item => {
    if (item?.tabId) result.push({ projectId: item.projectId, tabId: item.tabId });
    for (const child of list(item?.children)) walk(child);
  };
  walk(node);
  return result;
}

/** Window placement transports visual roots, not their attached descendants. */
export function reservePaneEntries(selection, node, selectedTabIds = []) {
  let ids = node?.tabId ? [node.tabId] : list(node?.children).map(child => child.tabId).filter(Boolean);
  if (node?.tabId && selectedTabIds.includes(node.tabId)) {
    const selected = new Set(selectedTabIds);
    ids = selection.reserve.filter(owner => selected.has(owner.tabId)).map(owner => owner.tabId);
    ids = ids.filter(id => {
      const seen = new Set([id]); let cursor = selection.catalog.get(id)?.tab.visualParentTabId;
      while (cursor && !seen.has(cursor)) {
        if (selected.has(cursor)) return false;
        seen.add(cursor); cursor = selection.catalog.get(cursor)?.tab.visualParentTabId;
      }
      return true;
    });
  }
  const unique = new Map();
  for (const id of ids) {
    let owner = selection.catalog.get(id);
    // A physical subagent is presented through its real terminal parent.
    if (owner?.tab.parentTabId) owner = selection.catalog.get(owner.tab.parentTabId);
    if (owner) unique.set(owner.tabId, { projectId: owner.projectId, tabId: owner.tabId });
  }
  return [...unique.values()];
}

/** A placed source becomes a temporary outline row only. No catalog row,
 * membership or placement is changed until the shared drag commits. */
export function projectReservePaneSource(selection, outline, source) {
  const admission=source?.workflowDrag;
  if(admission) {
    const existing=new Map();const index=nodes=>nodes.forEach(node=>{existing.set(node.id,node);index(node.children || []);});index(outline);
    if(source.owner==='sidebar' && admission.sourceWorkflowId===selection.workflowId
      && admission.sourceRootIds.every(id=>existing.has(id))) {
      return {sourceId:admission.sourceId,sourceRootIds:admission.sourceRootIds,outline,metadata:admission};
    }
    const family=new Set(admission.familyIds),rootIds=new Set(admission.sourceRootIds);
    // A global group may have unrelated members in the destination. Never
    // turn that existing group into part of the transported selection.
    for(const node of admission.sourceNodes)if(node.groupId && existing.has(node.id)
      && reserveNodeEntries(existing.get(node.id)).some(entry=>!family.has(entry.tabId)))return null;
    const strip=nodes=>nodes.filter(node=>!family.has(node.tabId) && !rootIds.has(node.id))
      .map(node=>({...node,children:strip(node.children || [])}));
    const metadata={entries:admission.paneEntries,familyIds:admission.familyIds,gestureId:admission.gestureId};
    const incoming=admission.sourceNodes.map(node=>{
      const guard=admission.guards[node.tabId],parentId=guard?.parentTabId || guard?.visualParentTabId;
      const parent=parentId && selection.catalog.get(parentId);
      const contextParent=guard?.parentTabId || guard?.tabType==='file'
        ? node.contextParent || (parentId ? {tabId:parentId,projectId:admission.guards[parentId]?.namespace || parent?.projectId,
          name:parent?.tab.name || ''}:null) : null;
      return {...node,externalPaneSource:metadata,contextParent};
    });
    return {sourceId:admission.sourceId,sourceRootIds:admission.sourceRootIds,outline:[...strip(outline),...incoming],metadata};
  }
  if(source?.owner !== 'pane' || !source.entries?.length)return null;
  const roots=source.entries.filter(entry=>selection.catalog.get(entry.tabId)?.projectId===entry.projectId);
  if(roots.length !== source.entries.length)return null;
  const family=new Set(roots.map(entry=>entry.tabId));
  let added=true;
  while(added) {
    added=false;
    for(const owner of selection.catalog.values()) {
      const tab=owner.tab,parent=tab.parentTabId || tab.visualParentTabId;
      if(!family.has(owner.tabId) && family.has(parent) && tab.archived!==true && tab.isArchived!==true && !tab.deleted) {
        family.add(owner.tabId);added=true;
      }
    }
  }
  const forest=workflowReserveOutline({...selection,reserve:[...family].map(id=>selection.catalog.get(id)),
    groups:new Map(),visibleGroups:new Map(),globalTabGroups:new Map()});
  const sourceId=`reserve-tab:${source.rootTabId}`;
  const root=forest.find(node=>node.id===sourceId);
  if(!root)return null;
  const strip=nodes=>nodes.filter(node=>!family.has(node.tabId)).map(node=>({...node,children:strip(node.children || [])}));
  const metadata={entries:roots.map(entry=>({...entry})),familyIds:[...family]};
  const incoming=forest.map(node=>({...node,
    contextParent:selection.catalog.get(node.tabId)?.tab.parentTabId || selection.catalog.get(node.tabId)?.tab.tabType==='file'
      ? node.contextParent:null,
    externalPaneSource:metadata}));
  return{sourceId,outline:[...strip(outline),...incoming],metadata};
}
