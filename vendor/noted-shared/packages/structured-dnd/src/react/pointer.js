import { advanceCollapsibleDwell } from '../core/index.js';

export const DEFAULT_POINTER_THRESHOLD = 4;

let sessionSequence = 0;

const childrenOf = (node) => Array.isArray(node?.children) ? node.children : [];

export function createOutlineDndSessionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  sessionSequence += 1;
  return `outline-dnd-${Date.now().toString(36)}-${sessionSequence.toString(36)}`;
}

export function isAcceptedCallbackResult(result) {
  return result !== false && result?.ok !== false;
}

export function shouldTrackExpansionPromise(requestDrag, activeDrag) {
  return !!requestDrag
    && requestDrag.phase !== 'pending'
    && activeDrag?.sessionId === requestDrag.sessionId;
}

export function shouldToggleFolderRowClick({
  collapsible = false,
  hasChildren = false,
  defaultPrevented = false,
  insideIgnoredControl = false,
} = {}) {
  return collapsible === true
    && hasChildren === true
    && !defaultPrevented
    && !insideIgnoredControl;
}

export function nextFolderRowExpansion(outline, nodeId) {
  const node = findOutlineNode(outline, nodeId);
  if (!node || node.collapsible !== true) return null;
  return node.expanded === false;
}

export function resolveHorizontalMovePolicy(decision) {
  if (decision === false) {
    return { ok: false, reason: 'host-policy' };
  }
  if (decision && typeof decision === 'object' && decision.ok === false) {
    return {
      ok: false,
      reason: typeof decision.reason === 'string' && decision.reason
        ? decision.reason
        : 'host-policy',
    };
  }
  return { ok: true, reason: null };
}

export function isPointInsideRect(clientX, clientY, rect) {
  return !!rect
    && clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom;
}

export function normalizeOutsidePointerPolicy(policy) {
  return policy === 'horizontal-corridor' ? policy : 'cancel';
}

export function isPointInsideGestureRegion(clientX, clientY, rect, policy = 'cancel') {
  if (!rect) return false;
  if (normalizeOutsidePointerPolicy(policy) === 'horizontal-corridor') {
    return clientY >= rect.top && clientY <= rect.bottom;
  }
  return isPointInsideRect(clientX, clientY, rect);
}

export function reserveForScrollTarget({
  currentReserve = 0,
  physicalMax = 0,
  naturalMax,
  targetScrollTop = 0,
} = {}) {
  const reserve = Math.max(0, Number(currentReserve) || 0);
  const max = Math.max(0, Number(physicalMax) || 0);
  const measuredNaturalMax = Number(naturalMax);
  const baseline = Number.isFinite(measuredNaturalMax)
    ? measuredNaturalMax
    : max - reserve;
  const target = Math.max(0, Number(targetScrollTop) || 0);
  const requiredReserve = Math.max(0, target - baseline);
  return Math.max(reserve, Math.ceil(requiredReserve));
}

export function leaseForScrollPosition({
  naturalMax = 0,
  scrollTop = 0,
  ceiling = null,
} = {}) {
  const rawNaturalMax = Number(naturalMax) || 0;
  const requestedTop = Math.max(0, Number(scrollTop) || 0);
  const previousCeiling = Number(ceiling);
  const top = ceiling != null && Number.isFinite(previousCeiling)
    ? Math.min(requestedTop, Math.max(0, previousCeiling))
    : requestedTop;
  const naturalCeiling = Math.max(0, rawNaturalMax);
  if (top <= naturalCeiling + 0.5) return null;

  return {
    height: Math.ceil(top - rawNaturalMax),
    naturalMax: rawNaturalMax,
    ceiling: top,
  };
}

export function advanceFolderDwell(dwell, {
  targetId,
  blocked = false,
  pending = false,
  now = 0,
  interval,
} = {}) {
  if (targetId == null) return { dwell: null, shouldToggle: false };

  if (
    !dwell
    || dwell.targetId !== targetId
    || dwell.blocked !== blocked
  ) {
    return {
      dwell: {
        targetId,
        blocked,
        pending,
        startedAt: now,
        progress: 0,
        cycle: 0,
      },
      shouldToggle: false,
    };
  }

  if (dwell.pending !== pending) {
    return {
      dwell: {
        ...dwell,
        pending,
        startedAt: now,
        progress: 0,
      },
      shouldToggle: false,
    };
  }

  if (pending) {
    return {
      dwell: {
        ...dwell,
        startedAt: now,
        progress: 0,
      },
      shouldToggle: false,
    };
  }

  const result = advanceCollapsibleDwell(dwell, {
    targetId,
    blocked,
    now,
    interval,
  });
  return {
    ...result,
    dwell: result.dwell ? { ...result.dwell, pending: false } : null,
  };
}

export function setOutlineExpanded(nodes, targetId, expanded) {
  let changed = false;

  const visit = (siblings) => {
    let siblingsChanged = false;
    const next = siblings.map((node) => {
      let nextNode = node;
      if (
        node.id === targetId
        && node.collapsible === true
        && node.expanded !== expanded
      ) {
        nextNode = { ...nextNode, expanded };
      }

      const children = childrenOf(nextNode);
      if (children.length > 0) {
        const nextChildren = visit(children);
        if (nextChildren !== children) nextNode = { ...nextNode, children: nextChildren };
      }

      if (nextNode !== node) siblingsChanged = true;
      return nextNode;
    });

    if (siblingsChanged) {
      changed = true;
      return next;
    }
    return siblings;
  };

  const nextOutline = visit(nodes);
  return { outline: nextOutline, changed };
}

export function findOutlineNode(nodes, targetId) {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    const nested = findOutlineNode(childrenOf(node), targetId);
    if (nested) return nested;
  }
  return null;
}

export function mergeControlledOutline(currentOutline, incomingOutline, expansionOverrides = new Map()) {
  const incomingById = new Map();
  const currentIds = new Set();

  const indexIncoming = (nodes) => {
    for (const node of nodes) {
      incomingById.set(node.id, node);
      indexIncoming(childrenOf(node));
    }
  };
  const indexCurrent = (nodes) => {
    for (const node of nodes) {
      currentIds.add(node.id);
      indexCurrent(childrenOf(node));
    }
  };
  indexIncoming(incomingOutline);
  indexCurrent(currentOutline);

  const cloneIncoming = (node) => ({
    ...node,
    children: childrenOf(node).map(cloneIncoming),
  });

  const mergeNodes = (nodes) => nodes.map((current) => {
    const incoming = incomingById.get(current.id);
    let children = mergeNodes(childrenOf(current));
    if (incoming) {
      const additions = childrenOf(incoming)
        .filter((child) => !currentIds.has(child.id))
        .map(cloneIncoming);
      if (additions.length > 0) children = [...children, ...additions];
    }

    const merged = incoming
      ? { ...current, ...incoming, id: current.id, children }
      : { ...current, children };
    return expansionOverrides.has(current.id)
      ? { ...merged, expanded: expansionOverrides.get(current.id) }
      : merged;
  });

  const mergedRoots = mergeNodes(currentOutline);
  const rootAdditions = incomingOutline
    .filter((node) => !currentIds.has(node.id))
    .map(cloneIncoming);
  return rootAdditions.length > 0 ? [...mergedRoots, ...rootAdditions] : mergedRoots;
}
