import {
  assertValidOutline,
  findNodeLocation,
  indentNode,
  outdentNode,
  prepareDrag,
  projectVerticalMove,
} from './outline.js';

const positionFromLocation = (location) => ({
  parentId: location.parentId,
  index: location.index,
  depth: location.depth,
});

const positionFromSlot = (slot) => ({
  parentId: slot.parentId,
  index: slot.index,
  depth: slot.depth,
});

const requireActiveSession = (session, operation) => {
  if (!session || session.phase !== 'active') {
    throw new Error(`${operation} requires an active outline session`);
  }
};

export function begin(tree, sourceId) {
  assertValidOutline(tree);
  const prepared = prepareDrag(tree, sourceId);

  return {
    phase: 'active',
    sourceId,
    baselineTree: tree,
    origin: positionFromLocation(prepared.sourceLocation),
    tree,
    baseTree: prepared.baseTree,
    sourceNode: prepared.sourceNode,
    slot: prepared.slot,
    boundary: prepared.slot.boundary,
    position: positionFromSlot(prepared.slot),
    preferredDepth: prepared.preferredDepth,
    resolvedDepth: prepared.preferredDepth,
    autoDepthDelta: 0,
    lastStep: null,
  };
}

export function project(session, { boundary } = {}) {
  requireActiveSession(session, 'project');
  const projected = projectVerticalMove({
    baseTree: session.baseTree,
    sourceNode: session.sourceNode,
    boundary,
    preferredDepth: session.preferredDepth,
    previousDepth: session.resolvedDepth,
    currentParentId: session.position.parentId,
  });

  return {
    ...session,
    tree: projected.tree,
    slot: projected.slot,
    boundary: projected.boundary,
    position: positionFromSlot(projected.slot),
    resolvedDepth: projected.resolvedDepth,
    autoDepthDelta: projected.autoDepthDelta,
    lastStep: null,
  };
}

export function step(session, direction) {
  requireActiveSession(session, 'step');
  if (direction !== 'left' && direction !== 'right') {
    throw new TypeError("step direction must be 'left' or 'right'");
  }

  const result = direction === 'right'
    ? indentNode(session.tree, session.sourceId)
    : outdentNode(session.tree, session.sourceId);
  if (!result.ok) {
    return {
      ...session,
      lastStep: {
        direction,
        ok: false,
        reason: result.reason,
      },
    };
  }

  const prepared = prepareDrag(result.tree, session.sourceId);
  return {
    ...session,
    tree: result.tree,
    baseTree: prepared.baseTree,
    sourceNode: prepared.sourceNode,
    slot: prepared.slot,
    boundary: prepared.slot.boundary,
    position: positionFromSlot(prepared.slot),
    preferredDepth: prepared.preferredDepth,
    resolvedDepth: prepared.preferredDepth,
    autoDepthDelta: 0,
    lastStep: {
      direction,
      ok: true,
      reason: result.reason,
    },
  };
}

export function commit(session) {
  requireActiveSession(session, 'commit');
  assertValidOutline(session.tree);
  const location = findNodeLocation(session.tree, session.sourceId);
  if (!location) throw new Error(`Unknown source: ${String(session.sourceId)}`);

  return {
    type: 'commit',
    committed: true,
    sourceId: session.sourceId,
    tree: session.tree,
    position: positionFromLocation(location),
  };
}

export function cancel(session) {
  requireActiveSession(session, 'cancel');
  return {
    type: 'cancel',
    committed: false,
    sourceId: session.sourceId,
    tree: session.baselineTree,
    position: session.origin,
  };
}
