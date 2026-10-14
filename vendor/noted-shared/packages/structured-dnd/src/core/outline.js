export const ROOT_PARENT_ID = null;

const childrenOf = (node) => Array.isArray(node?.children) ? node.children : [];
const isCollapsible = (node) => node?.collapsible === true;
const exposesChildren = (node) => !isCollapsible(node) || node.expanded !== false;

const clampIndex = (rawIndex, length) => {
  const numericIndex = Number(rawIndex);
  const index = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : 0;
  return Math.max(0, Math.min(index, length));
};

const normalizeDepth = (value) => {
  const numericDepth = Number(value);
  return Number.isFinite(numericDepth) ? Math.max(0, numericDepth) : 0;
};

export function cloneTree(nodes = []) {
  return nodes.map((node) => ({
    ...node,
    children: cloneTree(childrenOf(node)),
  }));
}

export function flattenVisible(nodes = []) {
  const rows = [];

  const visit = (siblings, parentId, depth, ancestors, ancestorContinuationDepths) => {
    siblings.forEach((node, index) => {
      const path = [...ancestors, node.id];
      const hasNextSibling = index < siblings.length - 1;
      rows.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        collapsible: isCollapsible(node),
        parentId,
        index,
        depth,
        expanded: exposesChildren(node),
        hasChildren: childrenOf(node).length > 0 || node?.hasChildren === true,
        hasNextSibling,
        ancestorContinuationDepths: [...ancestorContinuationDepths],
        path,
      });
      if (exposesChildren(node) && childrenOf(node).length > 0) {
        const nextContinuationDepths = depth > 0 && hasNextSibling
          ? [...ancestorContinuationDepths, depth - 1]
          : ancestorContinuationDepths;
        visit(childrenOf(node), node.id, depth + 1, path, nextContinuationDepths);
      }
    });
  };

  visit(nodes, ROOT_PARENT_ID, 0, [], []);
  return rows;
}

export function flattenSubtree(node) {
  return node ? flattenVisible([node]) : [];
}

export function getSubtreeIds(node) {
  const ids = [];
  const visit = (current) => {
    ids.push(current.id);
    childrenOf(current).forEach(visit);
  };
  if (node) visit(node);
  return ids;
}

export function findNodeLocation(nodes, targetId) {
  let found = null;

  const visit = (siblings, parentId, depth, ancestors) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index];
      if (node.id === targetId) {
        found = {
          node,
          parentId,
          index,
          depth,
          ancestors: [...ancestors],
        };
        return true;
      }
      if (visit(childrenOf(node), node.id, depth + 1, [...ancestors, node.id])) {
        return true;
      }
    }
    return false;
  };

  visit(nodes, ROOT_PARENT_ID, 0, []);
  return found;
}

export function detachNode(nodes, targetId) {
  const visit = (siblings, parentId, depth, ancestors) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index];
      if (node.id === targetId) {
        return {
          tree: [...siblings.slice(0, index), ...siblings.slice(index + 1)],
          detached: node,
          location: {
            parentId,
            index,
            depth,
            ancestors: [...ancestors],
          },
          changed: true,
        };
      }

      const nested = visit(childrenOf(node), node.id, depth + 1, [...ancestors, node.id]);
      if (nested.changed) {
        const nextSiblings = [...siblings];
        nextSiblings[index] = { ...node, children: nested.tree };
        return {
          ...nested,
          tree: nextSiblings,
        };
      }
    }

    return {
      tree: siblings,
      detached: null,
      location: null,
      changed: false,
    };
  };

  return visit(nodes, ROOT_PARENT_ID, 0, []);
}

export function insertNode(nodes, node, parentId, rawIndex, { expandParent = false } = {}) {
  if (!node) throw new Error('insertNode requires a node');

  if (parentId == null) {
    const next = [...nodes];
    next.splice(clampIndex(rawIndex, nodes.length), 0, node);
    return next;
  }

  let inserted = false;
  const visit = (siblings) => siblings.map((current) => {
    if (current.id === parentId) {
      const children = [...childrenOf(current)];
      children.splice(clampIndex(rawIndex, children.length), 0, node);
      inserted = true;
      return {
        ...current,
        ...(expandParent && isCollapsible(current) ? { expanded: true } : {}),
        children,
      };
    }
    if (childrenOf(current).length === 0) return current;
    return { ...current, children: visit(childrenOf(current)) };
  });

  const next = visit(nodes);
  if (!inserted) throw new Error(`Unknown parent: ${String(parentId)}`);
  return next;
}

export function enumerateVisibleSlots(nodes, {
  includeEmptyParentIds = [],
  includeAllEmptyParents = false,
} = {}) {
  const includeEmpty = new Set(includeEmptyParentIds.filter((id) => id != null));
  const slots = [];
  let boundary = 0;

  const scan = (siblings, parentId, depth) => {
    slots.push({
      parentId,
      index: 0,
      depth,
      boundary,
    });

    siblings.forEach((node, index) => {
      boundary += 1;
      const children = childrenOf(node);
      const exposesChildSlots = exposesChildren(node) && (
        children.length > 0 || includeAllEmptyParents || includeEmpty.has(node.id)
      );
      if (exposesChildSlots) scan(children, node.id, depth + 1);
      slots.push({
        parentId,
        index: index + 1,
        depth,
        boundary,
      });
    });
  };

  scan(nodes, ROOT_PARENT_ID, 0);
  return slots;
}

const slotIdentity = (slot) => [
  slot.parentId == null ? 'root' : String(slot.parentId),
  slot.index,
  slot.boundary,
].join(':');

export function chooseVerticalSlot(slots, {
  boundary,
  preferredDepth,
  previousDepth,
} = {}) {
  const numericBoundary = Number(boundary);
  const targetBoundary = Number.isFinite(numericBoundary) ? numericBoundary : 0;
  const exactBoundary = slots.filter((slot) => slot.boundary === targetBoundary);
  const candidates = exactBoundary.length > 0
    ? exactBoundary
    : slots
        .map((slot) => ({
          ...slot,
          boundaryDistance: Math.abs(slot.boundary - targetBoundary),
        }))
        .sort((a, b) => a.boundaryDistance - b.boundaryDistance)
        .filter((slot, _, all) => slot.boundaryDistance === all[0]?.boundaryDistance);

  const preferred = normalizeDepth(preferredDepth);
  const previous = previousDepth == null ? preferred : normalizeDepth(previousDepth);
  return [...candidates].sort((a, b) => (
    Math.abs(a.depth - preferred) - Math.abs(b.depth - preferred) ||
    Math.abs(a.depth - previous) - Math.abs(b.depth - previous) ||
    a.depth - b.depth ||
    slotIdentity(a).localeCompare(slotIdentity(b))
  ))[0] || null;
}

/** Selection is normalized against the whole tree, including collapsed children. */
export function normalizeDragRoots(tree, requestedIds = []) {
  const selected = new Set(requestedIds), roots = [];
  const visit = nodes => {
    for (const node of nodes) {
      if (selected.has(node.id)) roots.push(node.id);
      else visit(childrenOf(node));
    }
  };
  visit(tree);
  return roots;
}

export function prepareDrag(tree, sourceId, { sourceRootIds } = {}) {
  if (sourceRootIds) {
    const roots = normalizeDragRoots(tree, sourceRootIds);
    const locations = roots.map(id => findNodeLocation(tree, id));
    const sourceNodes = locations.map(location => location.node);
    const sourceIds = sourceNodes.flatMap(getSubtreeIds);
    const anchorIndex = sourceNodes.findIndex(node => getSubtreeIds(node).includes(sourceId));
    if (anchorIndex < 0) throw new Error(`Unknown source: ${String(sourceId)}`);
    let baseTree = tree;
    for (const id of roots) baseTree = detachNode(baseTree, id).tree;
    const location = locations[anchorIndex];
    const index = location.index - locations.filter(other => other.parentId === location.parentId && other.index < location.index).length;
    const slots = enumerateVisibleSlots(baseTree, { includeEmptyParentIds: locations.map(item => item.parentId) });
    const slot = slots.find(item => item.parentId === location.parentId && item.index === index);
    if (!slot) throw new Error(`Cannot resolve source slot: ${String(sourceId)}`);
    return { baseTree, sourceNode: findNodeLocation(tree, sourceId).node, sourceLocation: location,
      sourceRootIds: roots, sourceNodes, sourceIds, sourceLocations: locations,
      slot, preferredDepth: location.depth };
  }
  const detached = detachNode(tree, sourceId);
  if (!detached.changed || !detached.detached || !detached.location) {
    throw new Error(`Unknown source: ${String(sourceId)}`);
  }

  const slots = enumerateVisibleSlots(detached.tree, {
    includeEmptyParentIds: [detached.location.parentId],
  });
  const currentSlot = slots.find((slot) => (
    slot.parentId === detached.location.parentId &&
    slot.index === detached.location.index
  ));
  if (!currentSlot) throw new Error(`Cannot resolve source slot: ${String(sourceId)}`);

  return {
    baseTree: detached.tree,
    sourceNode: detached.detached,
    sourceLocation: detached.location,
    slot: currentSlot,
    preferredDepth: detached.location.depth,
  };
}

export function projectVerticalMove({
  baseTree,
  sourceNode,
  sourceNodes,
  boundary,
  preferredDepth,
  previousDepth,
  currentParentId,
  canUseSlot,
} = {}) {
  const visibleCount = flattenVisible(baseTree).length;
  const numericBoundary = Number(boundary);
  const safeBoundary = Number.isFinite(numericBoundary) ? numericBoundary : 0;
  const boundedBoundary = Math.max(0, Math.min(safeBoundary, visibleCount));
  const allSlots = enumerateVisibleSlots(baseTree, {
    includeEmptyParentIds: [currentParentId],
    includeAllEmptyParents: true,
  });
  const slots = typeof canUseSlot === 'function'
    ? allSlots.filter((slot) => canUseSlot(slot) !== false)
    : allSlots;
  const slot = chooseVerticalSlot(slots, {
    boundary: boundedBoundary,
    preferredDepth,
    previousDepth,
  });
  if (!slot) throw new Error('No allowed vertical slot');

  let tree = baseTree;
  (sourceNodes || [sourceNode]).forEach((node, offset) => {
    tree = insertNode(tree, node, slot.parentId, slot.index + offset);
  });
  assertValidOutline(tree);
  return {
    tree,
    slot,
    boundary: slot.boundary,
    resolvedDepth: slot.depth,
    autoDepthDelta: slot.depth - normalizeDepth(preferredDepth),
  };
}

/** A host append target is a regular painted projection, never a drop rewrite. */
export function projectForestToRootEnd(tree, sourceId, sourceRootIds = [sourceId]) {
  const prepared = prepareDrag(tree, sourceId, { sourceRootIds });
  if(tree.slice(-prepared.sourceNodes.length).every((node,index)=>node===prepared.sourceNodes[index]))return tree;
  return [...prepared.baseTree, ...prepared.sourceNodes];
}

export function indentNode(tree, sourceId) {
  const location = findNodeLocation(tree, sourceId);
  if (!location) return { ok: false, reason: 'missing-source', tree };

  const parentLocation = location.parentId == null
    ? null
    : findNodeLocation(tree, location.parentId);
  const siblings = parentLocation ? childrenOf(parentLocation.node) : tree;
  const previousSibling = siblings[location.index - 1] || null;
  if (!previousSibling) {
    return { ok: false, reason: 'missing-previous-sibling', tree };
  }
  if (
    isCollapsible(previousSibling) &&
    childrenOf(previousSibling).length > 0 &&
    previousSibling.expanded === false
  ) {
    return { ok: false, reason: 'closed-parent', tree };
  }

  const detached = detachNode(tree, sourceId);
  const next = insertNode(
    detached.tree,
    detached.detached,
    previousSibling.id,
    childrenOf(previousSibling).length,
    { expandParent: childrenOf(previousSibling).length === 0 },
  );
  assertValidOutline(next);
  return {
    ok: true,
    tree: next,
    parentId: previousSibling.id,
    index: childrenOf(previousSibling).length,
    depth: location.depth + 1,
    reason: 'indent',
  };
}

export function outdentNode(tree, sourceId) {
  const location = findNodeLocation(tree, sourceId);
  if (!location) return { ok: false, reason: 'missing-source', tree };
  if (location.parentId == null) {
    return { ok: false, reason: 'root-boundary', tree };
  }

  const parentLocation = findNodeLocation(tree, location.parentId);
  if (!parentLocation) return { ok: false, reason: 'missing-parent', tree };

  const detached = detachNode(tree, sourceId);
  const next = insertNode(
    detached.tree,
    detached.detached,
    parentLocation.parentId,
    parentLocation.index + 1,
  );
  assertValidOutline(next);
  return {
    ok: true,
    tree: next,
    parentId: parentLocation.parentId,
    index: parentLocation.index + 1,
    depth: Math.max(0, location.depth - 1),
    reason: 'outdent',
  };
}

export function outlineSnapshot(nodes) {
  return flattenVisible(nodes).map((row) => ({
    id: row.id,
    parentId: row.parentId,
    depth: row.depth,
    index: row.index,
  }));
}

export function assertValidOutline(nodes) {
  if (!Array.isArray(nodes)) throw new TypeError('Outline root must be an array');

  const ids = new Set();
  const objectStack = new Set();

  const visit = (node) => {
    if (!node || typeof node !== 'object' || node.id == null || node.id === '') {
      throw new Error('Outline node is missing id');
    }
    if (objectStack.has(node)) throw new Error(`Cyclic outline object: ${String(node.id)}`);
    if (ids.has(node.id)) throw new Error(`Duplicate outline id: ${String(node.id)}`);
    ids.add(node.id);
    objectStack.add(node);
    childrenOf(node).forEach(visit);
    objectStack.delete(node);
  };

  nodes.forEach(visit);
  return true;
}
