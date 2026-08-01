const GROUP_PREFIX = 'tab-group:';
const TAB_PREFIX = 'tab:';

export const tabOutlineGroupId = id => `${GROUP_PREFIX}${id}`;
export const tabOutlineTabId = id => `${TAB_PREFIX}${id}`;

const childrenOf = node => Array.isArray(node?.children) ? node.children : [];

function nodePath(nodes, targetId, ancestors = []) {
  for (const node of nodes) {
    const path = [...ancestors, node];
    if (node.id === targetId) return path;
    const nested = nodePath(childrenOf(node), targetId, path);
    if (nested) return nested;
  }
  return null;
}

function validVisualParentByTab(tabs) {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const result = new Map();

  for (const tab of tabs) {
    const requested = tab.visualParentTabId;
    const parent = requested ? byId.get(requested) : null;
    if (!parent || parent === tab || parent.groupId !== tab.groupId) {
      result.set(tab.id, null);
      continue;
    }

    const seen = new Set([tab.id]);
    let cursor = parent;
    let valid = true;
    while (cursor) {
      if (seen.has(cursor.id)) {
        valid = false;
        break;
      }
      seen.add(cursor.id);
      const nextId = cursor.visualParentTabId;
      cursor = nextId ? byId.get(nextId) : null;
    }
    result.set(tab.id, valid ? parent.id : null);
  }

  return result;
}

function buildTabForest(tabs) {
  const validParent = validVisualParentByTab(tabs);
  const childrenByParent = new Map();
  const roots = [];

  for (const tab of tabs) {
    const parentId = validParent.get(tab.id);
    if (!parentId) {
      roots.push(tab.id);
      continue;
    }
    const children = childrenByParent.get(parentId) || [];
    children.push(tab.id);
    childrenByParent.set(parentId, children);
  }

  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const makeNode = id => {
    const tab = byId.get(id);
    return {
      id: tabOutlineTabId(id),
      kind: 'tab',
      collapsible: false,
      expanded: true,
      label: tab?.name || '',
      entityType: 'tab',
      tabId: id,
      rawTab: tab,
      children: (childrenByParent.get(id) || []).map(makeNode),
    };
  };

  return {
    roots: roots.map(makeNode),
    rootByTabId: new Map(tabs.map(tab => {
      let cursor = tab.id;
      const seen = new Set();
      while (validParent.get(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = validParent.get(cursor);
      }
      return [tab.id, cursor];
    })),
  };
}

export function buildTabOutline(tabs = [], groups = []) {
  const mainTabs = tabs.filter(tab => !tab.parentTabId);
  const groupById = new Map(groups.map(group => [group.id, group]));
  const normalizedTabs = mainTabs.map(tab => ({
    ...tab,
    groupId: tab.groupId && groupById.has(tab.groupId) ? tab.groupId : undefined,
  }));
  const tabsByGroup = new Map();
  for (const tab of normalizedTabs) {
    if (!tab.groupId) continue;
    const members = tabsByGroup.get(tab.groupId) || [];
    members.push(tab);
    tabsByGroup.set(tab.groupId, members);
  }

  const forestByGroup = new Map();
  for (const group of groups) {
    forestByGroup.set(group.id, buildTabForest(tabsByGroup.get(group.id) || []));
  }
  const ungrouped = normalizedTabs.filter(tab => !tab.groupId);
  const ungroupedForest = buildTabForest(ungrouped);

  const rootByTabId = new Map(ungroupedForest.rootByTabId);
  for (const forest of forestByGroup.values()) {
    for (const entry of forest.rootByTabId) rootByTabId.set(...entry);
  }

  const emptyGroupsByAnchor = new Map();
  const trailingEmptyGroups = [];
  for (const group of groups) {
    if ((tabsByGroup.get(group.id) || []).length > 0) continue;
    const anchorRootId = group.anchorTabId ? rootByTabId.get(group.anchorTabId) : null;
    if (!anchorRootId) {
      trailingEmptyGroups.push(group);
      continue;
    }
    const anchored = emptyGroupsByAnchor.get(anchorRootId) || [];
    anchored.push(group);
    emptyGroupsByAnchor.set(anchorRootId, anchored);
  }

  const rootNodesByTabId = new Map([
    ...ungroupedForest.roots.map(node => [node.tabId, node]),
    ...Array.from(forestByGroup.values()).flatMap(forest => forest.roots.map(node => [node.tabId, node])),
  ]);
  const result = [];
  const renderedGroups = new Set();
  const renderedTabs = new Set();

  const groupNode = group => ({
    id: tabOutlineGroupId(group.id),
    kind: 'group',
    collapsible: true,
    expanded: !group.collapsed,
    hasChildren: (tabsByGroup.get(group.id) || []).length > 0,
    label: group.name || '',
    entityType: 'group',
    groupId: group.id,
    rawGroup: group,
    children: forestByGroup.get(group.id)?.roots || [],
  });

  const pushAnchoredEmptyGroups = anchorRootId => {
    for (const group of emptyGroupsByAnchor.get(anchorRootId) || []) {
      if (renderedGroups.has(group.id)) continue;
      renderedGroups.add(group.id);
      result.push(groupNode(group));
    }
  };

  for (const tab of normalizedTabs) {
    const rootId = rootByTabId.get(tab.id);
    if (!rootId || rootId !== tab.id || renderedTabs.has(rootId)) continue;
    pushAnchoredEmptyGroups(rootId);
    renderedTabs.add(rootId);
    if (tab.groupId) {
      if (renderedGroups.has(tab.groupId)) continue;
      const group = groupById.get(tab.groupId);
      if (!group) continue;
      renderedGroups.add(group.id);
      result.push(groupNode(group));
      continue;
    }
    const node = rootNodesByTabId.get(rootId);
    if (node) result.push(node);
  }

  for (const group of trailingEmptyGroups) {
    if (renderedGroups.has(group.id)) continue;
    renderedGroups.add(group.id);
    result.push(groupNode(group));
  }
  for (const group of groups) {
    if (renderedGroups.has(group.id)) continue;
    renderedGroups.add(group.id);
    result.push(groupNode(group));
  }
  return result;
}

export function tabOutlineSubtreeTabIds(outline = [], tabId) {
  const path = nodePath(outline, tabOutlineTabId(tabId));
  const source = path?.[path.length - 1];
  if (!source || source.entityType !== 'tab') return [];

  const result = [];
  const visit = node => {
    if (node?.entityType === 'tab' && node.tabId) result.push(node.tabId);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(source);
  return result;
}

function firstTabId(node) {
  if (node?.entityType === 'tab') return node.tabId;
  for (const child of childrenOf(node)) {
    const found = firstTabId(child);
    if (found) return found;
  }
  return null;
}

export function tabOutlineToLayout(outline = []) {
  const orderedIds = [];
  const groupAssignments = {};
  const visualParentAssignments = {};
  const groupAnchorAssignments = {};
  const seenTabs = new Set();
  const seenGroups = new Set();

  const visitTab = (node, groupId, parentTabId) => {
    if (!node || node.entityType !== 'tab' || !node.tabId) {
      return { ok: false, reason: 'group-must-stay-root' };
    }
    if (seenTabs.has(node.tabId)) return { ok: false, reason: 'duplicate-tab' };
    seenTabs.add(node.tabId);
    orderedIds.push(node.tabId);
    groupAssignments[node.tabId] = groupId || null;
    visualParentAssignments[node.tabId] = parentTabId || null;
    for (const child of childrenOf(node)) {
      const nested = visitTab(child, groupId, node.tabId);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  };

  for (const root of outline) {
    if (root?.entityType === 'group') {
      if (!root.groupId || seenGroups.has(root.groupId)) return { ok: false, reason: 'duplicate-group' };
      seenGroups.add(root.groupId);
      for (const child of childrenOf(root)) {
        const nested = visitTab(child, root.groupId, null);
        if (!nested.ok) return nested;
      }
      continue;
    }
    const nested = visitTab(root, null, null);
    if (!nested.ok) return nested;
  }

  outline.forEach((root, index) => {
    if (root?.entityType !== 'group') return;
    if (childrenOf(root).length > 0) return;
    let anchor = null;
    for (let cursor = index + 1; cursor < outline.length && !anchor; cursor += 1) {
      anchor = firstTabId(outline[cursor]);
    }
    groupAnchorAssignments[root.groupId] = anchor;
  });

  return {
    ok: true,
    orderedIds,
    groupAssignments,
    visualParentAssignments,
    groupAnchorAssignments,
  };
}

export function tabOutlineHorizontalPolicy({ sourceNode, result }) {
  if (sourceNode?.entityType === 'group') {
    return { ok: false, reason: 'group-depth-locked' };
  }
  const proposedPath = result?.ok
    ? nodePath(result.tree || [], sourceNode?.id) || []
    : [];
  const visualDepth = proposedPath.slice(0, -1)
    .filter(node => node?.entityType === 'tab').length;
  if (result?.ok && visualDepth > 4) {
    return { ok: false, reason: 'max-depth' };
  }
  return { ok: true };
}

export function tabOutlineVerticalSlotPolicy({ sourceNode, baseOutline, slot }) {
  if (sourceNode?.entityType === 'group') return slot?.parentId == null;
  if (sourceNode?.entityType !== 'tab') return false;
  if (slot?.parentId == null) return true;
  const parentPath = nodePath(baseOutline || [], slot.parentId);
  if (!parentPath) return false;
  return parentPath.filter(node => node?.entityType === 'tab').length <= 4;
}
