const childrenOf = (node) => Array.isArray(node?.children) ? node.children : [];

/**
 * Resolve the two deliberately different payloads of one sidebar selection.
 *
 * - projectIds: selected visual roots plus every descendant (ownership move);
 * - paneIds: selected visual roots only (window placement).
 */
export function resolveTabSelectionDragPayload(tabs = [], requestedIds = [], sourceId = '') {
  const ordered = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab?.id && !tab.parentTabId);
  const byId = new Map(ordered.map((tab) => [tab.id, tab]));
  const requested = new Set(
    (Array.isArray(requestedIds) && requestedIds.includes(sourceId) ? requestedIds : [sourceId])
      .filter((id) => byId.has(id)),
  );
  const hasSelectedAncestor = (id) => {
    const seen = new Set([id]);
    let cursor = byId.get(id)?.visualParentTabId || null;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      if (requested.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.visualParentTabId || null;
    }
    return false;
  };
  let rootIds = ordered
    .map((tab) => tab.id)
    .filter((id) => requested.has(id) && !hasSelectedAncestor(id));
  // A malformed cycle must not turn a visible selection into an empty payload.
  if (rootIds.length === 0 && requested.size > 0) {
    rootIds = ordered.map((tab) => tab.id).filter((id) => requested.has(id));
  }

  const children = new Map();
  ordered.forEach((tab) => {
    const parentId = tab.visualParentTabId;
    if (!parentId || !byId.has(parentId)) return;
    const list = children.get(parentId) || [];
    list.push(tab.id);
    children.set(parentId, list);
  });
  const projectIds = [];
  const emitted = new Set();
  const visit = (id) => {
    if (!byId.has(id) || emitted.has(id)) return;
    emitted.add(id);
    projectIds.push(id);
    (children.get(id) || []).forEach(visit);
  };
  rootIds.forEach(visit);

  return {
    rootIds,
    projectIds,
    descendantIds: projectIds.filter((id) => !rootIds.includes(id)),
  };
}

export function resolveOutlineTabDragPayload(sourceNode) {
  const projectIds = [];
  const rootIds = [];
  const emitted = new Set();
  const visit = (node, root = false) => {
    if (!node) return;
    if (node.entityType === 'tab' && node.tabId && !emitted.has(node.tabId)) {
      emitted.add(node.tabId);
      projectIds.push(node.tabId);
      if (root) rootIds.push(node.tabId);
    }
    childrenOf(node).forEach((child) => visit(child, node.entityType === 'group'));
  };
  visit(sourceNode, sourceNode?.entityType === 'tab');
  return { rootIds, projectIds, descendantIds: projectIds.filter((id) => !rootIds.includes(id)) };
}
