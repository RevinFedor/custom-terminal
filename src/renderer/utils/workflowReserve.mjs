import { selectWorkflowGlobalGroups } from './workflowGlobalGroups.mjs';
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
      catalog.set(tabId, { projectId, tabId, tab, active:state.tabCatalog?.[tabId]?.active !== false });
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
  }
  return { workflowId, catalog, members, reserve, placed, groups, visibleGroups, filesByOwner, globalTabGroups:global?.tabGroups };
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
    const parent = !byId.has(parentId) && selection.catalog.get(parentId);
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
        projectId: group.projectId, groupId: group.id, label: group.name,
        collapsible: true, expanded: !group.collapsed, children: [] };
      groupNodes.set(key, groupNode); result.push(groupNode);
    }
    groupNodes.get(key).children.push(node);
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
