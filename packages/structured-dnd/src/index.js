const DEFAULT_IGNORE_SELECTOR = '[data-no-card-drag],button,input,textarea,select,a';

export const entityKey = (entity) => `${entity.type}:${String(entity.id)}`;

export function snapRect(element, { compensateTransform = false } = {}) {
  const rect = element.getBoundingClientRect();
  let translateX = 0;
  let translateY = 0;
  if (compensateTransform && typeof window !== 'undefined' && typeof window.DOMMatrixReadOnly === 'function') {
    const transform = window.getComputedStyle(element).transform;
    if (transform && transform !== 'none') {
      try {
        const matrix = new window.DOMMatrixReadOnly(transform);
        const isTranslation = Math.abs(matrix.a - 1) < 0.001 && Math.abs(matrix.b) < 0.001 &&
          Math.abs(matrix.c) < 0.001 && Math.abs(matrix.d - 1) < 0.001;
        if (isTranslation) {
          translateX = matrix.e;
          translateY = matrix.f;
        }
      } catch {
        // Intermediate CSS matrices are ignored; a later geometry revision repairs it.
      }
    }
  }
  const left = rect.left - translateX;
  const top = rect.top - translateY;
  return {
    left,
    right: left + rect.width,
    top,
    bottom: top + rect.height,
    width: rect.width,
    height: rect.height,
    midX: left + rect.width / 2,
    midY: top + rect.height / 2,
    translateX,
    translateY,
  };
}

const byPosition = (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0);

export function normalizeStructuredModel(raw = {}) {
  return {
    containers: (raw.containers || []).map((item, index) => ({
      ...item,
      id: String(item.id),
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
    })),
    items: (raw.items || []).map((item, index) => ({
      ...item,
      id: String(item.id),
      containerId: item.containerId == null ? null : String(item.containerId),
      parentId: item.parentId == null ? null : String(item.parentId),
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
    })),
  };
}

function hierarchyParentId(item, parentKey = 'parentId') {
  const value = item?.[parentKey];
  return value == null || value === '' ? null : String(value);
}

function hierarchyContainerId(item, containerKey = 'containerId') {
  const value = item?.[containerKey];
  return value == null || value === '' ? null : String(value);
}

export function orderVisualHierarchyItems(rawItems = [], options = {}) {
  const parentKey = options.parentKey || 'parentId';
  const items = rawItems
    .map((item) => ({ ...item, id: String(item.id) }))
    .sort(byPosition);
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map();
  const roots = [];

  for (const item of items) {
    const parentId = hierarchyParentId(item, parentKey);
    if (!parentId || parentId === item.id || !byId.has(parentId)) {
      roots.push(item);
      continue;
    }
    const list = children.get(parentId) || [];
    list.push(item);
    children.set(parentId, list);
  }

  const ordered = [];
  const seen = new Set();
  const visit = (item) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    ordered.push(item);
    for (const child of children.get(item.id) || []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const item of items) visit(item);
  return ordered;
}

export function buildVisualHierarchyDepthMap(rawItems = [], options = {}) {
  const parentKey = options.parentKey || 'parentId';
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 4;
  const items = rawItems.map((item) => ({ ...item, id: String(item.id) }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const cache = new Map();
  const depthOf = (item, trail = new Set()) => {
    if (!item) return 0;
    if (cache.has(item.id)) return cache.get(item.id);
    const parentId = hierarchyParentId(item, parentKey);
    if (!parentId || parentId === item.id || trail.has(item.id) || !byId.has(parentId)) {
      cache.set(item.id, 0);
      return 0;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(item.id);
    const depth = Math.min(maxDepth, depthOf(byId.get(parentId), nextTrail) + 1);
    cache.set(item.id, depth);
    return depth;
  };
  for (const item of items) depthOf(item);
  return cache;
}

export function visualHierarchyAncestorIds(rawItems = [], itemId, options = {}) {
  const parentKey = options.parentKey || 'parentId';
  const byId = new Map(rawItems.map((item) => [String(item.id), item]));
  const result = [];
  const seen = new Set([String(itemId)]);
  let cursor = hierarchyParentId(byId.get(String(itemId)), parentKey);
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    result.push(cursor);
    seen.add(cursor);
    cursor = hierarchyParentId(byId.get(cursor), parentKey);
  }
  return result;
}

function visualHierarchySubtreeIdSet(rawItems, sourceId, parentKey) {
  const sourceKey = String(sourceId ?? '');
  const children = new Map();
  let hasSource = false;

  for (const item of rawItems) {
    const itemId = String(item.id);
    if (itemId === sourceKey) hasSource = true;
    const parentId = hierarchyParentId(item, parentKey);
    if (!parentId) continue;
    const list = children.get(parentId) || [];
    list.push(itemId);
    children.set(parentId, list);
  }
  if (!hasSource) return new Set();

  const result = new Set([sourceKey]);
  const pending = [sourceKey];
  while (pending.length) {
    const parentId = pending.pop();
    for (const childId of children.get(parentId) || []) {
      if (result.has(childId)) continue;
      result.add(childId);
      pending.push(childId);
    }
  }
  return result;
}

export function visualHierarchySubtreeItems(rawItems = [], sourceId, options = {}) {
  const parentKey = options.parentKey || 'parentId';
  const ordered = orderVisualHierarchyItems(rawItems, { parentKey });
  const subtreeIds = visualHierarchySubtreeIdSet(ordered, sourceId, parentKey);
  return ordered.filter((item) => subtreeIds.has(item.id));
}

export function normalizeSelectedVisualRootIds(rawItems = [], selectedIds = [], options = {}) {
  const parentKey = options.parentKey || 'parentId';
  const ordered = orderVisualHierarchyItems(rawItems, { parentKey });
  const existingIds = new Set(ordered.map((item) => item.id));
  const selected = new Set(Array.from(selectedIds || [], (id) => String(id)).filter((id) => existingIds.has(id)));
  const covered = new Set();
  const roots = [];

  for (const item of ordered) {
    if (!selected.has(item.id) || covered.has(item.id)) continue;
    roots.push(item.id);
    const subtreeIds = visualHierarchySubtreeIdSet(ordered, item.id, parentKey);
    for (const id of subtreeIds) covered.add(id);
  }
  return roots;
}

export function resolveVisualBlockMove({
  items: rawItems = [],
  sourceId,
  selectedIds = [],
  targetId,
  placement = 'before',
  parentKey = 'parentId',
  containerKey = 'containerId',
} = {}) {
  const items = rawItems.map((item, index) => ({
    ...item,
    id: String(item.id),
    position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
  }));
  const sourceKey = String(sourceId ?? '');
  const targetKey = String(targetId ?? '');
  const byId = new Map(items.map((item) => [item.id, item]));
  if (!byId.has(sourceKey) || !byId.has(targetKey) || (placement !== 'before' && placement !== 'after')) {
    return { ok: false, disabled: true, reason: 'invalid-source-or-target', items };
  }

  const requestedIds = Array.from(selectedIds || [], (id) => String(id));
  const effectiveSelection = requestedIds.includes(sourceKey) ? requestedIds : [sourceKey];
  const sourceRootIds = normalizeSelectedVisualRootIds(items, effectiveSelection, { parentKey });
  if (sourceRootIds.length === 0) {
    return { ok: false, disabled: true, reason: 'empty-source', items };
  }

  const sourceParentIds = new Set(sourceRootIds.map((id) => hierarchyParentId(byId.get(id), parentKey)));
  if (sourceParentIds.size !== 1) {
    return {
      ok: false,
      disabled: true,
      reason: 'mixed-parent-context',
      sourceRootIds,
      items,
    };
  }
  const sourceParentId = sourceParentIds.values().next().value || null;

  const sourceIds = [];
  const sourceSet = new Set();
  for (const rootId of sourceRootIds) {
    for (const item of visualHierarchySubtreeItems(items, rootId, { parentKey })) {
      if (sourceSet.has(item.id)) continue;
      sourceSet.add(item.id);
      sourceIds.push(item.id);
    }
  }

  let targetRootId = targetKey;
  const targetTrail = new Set();
  while (targetRootId && !targetTrail.has(targetRootId)) {
    targetTrail.add(targetRootId);
    const targetParentId = hierarchyParentId(byId.get(targetRootId), parentKey);
    if (targetParentId === sourceParentId) break;
    if (!targetParentId || !byId.has(targetParentId)) {
      targetRootId = '';
      break;
    }
    targetRootId = targetParentId;
  }
  if (!targetRootId) {
    return {
      ok: false,
      disabled: true,
      reason: 'different-parent-context',
      sourceRootIds,
      sourceIds,
      items,
    };
  }

  const targetItems = visualHierarchySubtreeItems(items, targetRootId, { parentKey });
  const targetIds = targetItems.map((item) => item.id);
  if (targetIds.some((id) => sourceSet.has(id))) {
    return {
      ok: false,
      disabled: true,
      reason: 'target-inside-source',
      sourceRootIds,
      sourceIds,
      targetRootId,
      targetIds,
      items,
    };
  }

  const targetContainerId = hierarchyContainerId(byId.get(targetRootId), containerKey);
  if (sourceParentId) {
    const parentContainerId = hierarchyContainerId(byId.get(sourceParentId), containerKey);
    if (parentContainerId !== targetContainerId) {
      return {
        ok: false,
        disabled: true,
        reason: 'different-container-context',
        sourceRootIds,
        sourceIds,
        targetRootId,
        targetIds,
        items,
      };
    }
  }

  const orderedIds = orderVisualHierarchyItems(items, { parentKey }).map((item) => item.id);
  const sourceBlock = orderedIds.filter((id) => sourceSet.has(id));
  const withoutSource = orderedIds.filter((id) => !sourceSet.has(id));
  const targetIndexes = targetIds
    .map((id) => withoutSource.indexOf(id))
    .filter((index) => index >= 0);
  if (targetIndexes.length === 0) {
    return { ok: false, disabled: true, reason: 'missing-target-block', sourceRootIds, sourceIds, items };
  }
  const insertionIndex = placement === 'before'
    ? Math.min(...targetIndexes)
    : Math.max(...targetIndexes) + 1;
  const nextOrder = [...withoutSource];
  nextOrder.splice(insertionIndex, 0, ...sourceBlock);
  const targetSiblingRootIds = orderVisualHierarchyItems(items, { parentKey })
    .filter((item) => (
      !sourceSet.has(item.id)
      && hierarchyParentId(item, parentKey) === sourceParentId
      && hierarchyContainerId(item, containerKey) === targetContainerId
    ))
    .map((item) => item.id);
  const targetSiblingIndex = targetSiblingRootIds.indexOf(targetRootId);
  if (targetSiblingIndex < 0) {
    return { ok: false, disabled: true, reason: 'missing-target-sibling', sourceRootIds, sourceIds, items };
  }
  targetSiblingRootIds.splice(
    targetSiblingIndex + (placement === 'after' ? 1 : 0),
    0,
    ...sourceRootIds,
  );
  const siblingPositionById = new Map(targetSiblingRootIds.map((id, index) => [id, index]));
  const containerAssignments = Object.fromEntries(sourceIds.map((id) => [id, targetContainerId]));
  const nextItems = items.map((item) => {
    const nextPosition = siblingPositionById.get(item.id);
    if (sourceSet.has(item.id)) {
      return {
        ...item,
        [containerKey]: targetContainerId,
        position: nextPosition ?? item.position,
      };
    }
    return nextPosition == null ? item : { ...item, position: nextPosition };
  });

  return {
    ok: true,
    disabled: false,
    reason: 'move-sibling-block',
    placement,
    sourceParentId,
    sourceRootIds,
    sourceIds,
    targetRootId,
    targetIds,
    containerId: targetContainerId,
    containerAssignments,
    // Render adapters need the cross-context projection, while persisted
    // positions remain scoped to their sibling/container namespace.
    orderedIds: nextOrder,
    items: nextItems,
  };
}

export function resolveVisualHierarchyStep({
  items: rawItems = [],
  sourceId,
  direction,
  parentKey = 'parentId',
  containerKey = 'containerId',
  maxDepth = 4,
} = {}) {
  const items = rawItems.map((item) => ({ ...item, id: String(item.id) }));
  const sourceKey = String(sourceId ?? '');
  const byId = new Map(items.map((item) => [item.id, item]));
  const source = byId.get(sourceKey);
  if (!source || (direction !== 'left' && direction !== 'right')) {
    return { ok: false, disabled: true, direction, reason: 'invalid-source', items };
  }

  const depthById = buildVisualHierarchyDepthMap(items, { parentKey, maxDepth: Number.MAX_SAFE_INTEGER });
  const sourceDepth = depthById.get(sourceKey) || 0;
  const sourceSubtreeItems = visualHierarchySubtreeItems(items, sourceKey, { parentKey });
  const sourceSubtreeMaxDepth = sourceSubtreeItems.reduce(
    (deepest, item) => Math.max(deepest, depthById.get(item.id) || 0),
    sourceDepth,
  );
  const currentParentId = hierarchyParentId(source, parentKey);
  if (direction === 'left') {
    if (!currentParentId || !byId.has(currentParentId)) {
      const currentContainerId = hierarchyContainerId(source, containerKey);
      if (currentContainerId) {
        const subtree = visualHierarchySubtreeItems(items, sourceKey, { parentKey });
        const subtreeIds = new Set(subtree.map((item) => item.id));
        const parentAssignments = Object.fromEntries(subtree.map((item) => [
          item.id,
          item.id === sourceKey ? null : hierarchyParentId(item, parentKey),
        ]));
        const containerAssignments = Object.fromEntries(subtree.map((item) => [item.id, null]));
        const next = items.map((item) => subtreeIds.has(item.id)
          ? {
              ...item,
              [parentKey]: item.id === sourceKey ? null : item[parentKey],
              [containerKey]: null,
            }
          : item);
        return {
          ok: true,
          disabled: false,
          direction,
          reason: 'detach-from-container',
          parentId: null,
          containerId: null,
          sourceDepth,
          nextDepth: 0,
          parentAssignments,
          containerAssignments,
          items: next,
        };
      }
      return { ok: false, disabled: true, direction, reason: 'already-root', sourceDepth, items };
    }
    const promotedParentId = hierarchyParentId(byId.get(currentParentId), parentKey);
    const next = items.map((item) => item.id === sourceKey
      ? { ...item, [parentKey]: promotedParentId }
      : item);
    return {
      ok: true,
      disabled: false,
      direction,
      reason: promotedParentId ? 'outdent-one-level' : 'detach-to-root',
      parentId: promotedParentId,
      sourceDepth,
      nextDepth: Math.max(0, sourceDepth - 1),
      parentAssignments: { [sourceKey]: promotedParentId },
      items: next,
    };
  }

  if (sourceSubtreeMaxDepth >= maxDepth) {
    return {
      ok: false,
      disabled: true,
      direction,
      reason: 'max-depth',
      sourceDepth,
      sourceSubtreeMaxDepth,
      items,
    };
  }
  const ordered = orderVisualHierarchyItems(items, { parentKey });
  const sourceIndex = ordered.findIndex((item) => item.id === sourceKey);
  const sourceContainerId = hierarchyContainerId(source, containerKey);
  const sourceSubtree = new Set([sourceKey]);
  for (const item of ordered.slice(sourceIndex + 1)) {
    const ancestors = visualHierarchyAncestorIds(items, item.id, { parentKey });
    if (!ancestors.includes(sourceKey)) break;
    sourceSubtree.add(item.id);
  }
  let candidate = null;
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    if (sourceSubtree.has(item.id)) continue;
    if ((depthById.get(item.id) || 0) !== sourceDepth) continue;
    if (hierarchyContainerId(item, containerKey) !== sourceContainerId) continue;
    candidate = item;
    break;
  }
  if (!candidate) {
    return { ok: false, disabled: true, direction, reason: 'no-previous-peer', sourceDepth, items };
  }
  const next = items.map((item) => item.id === sourceKey
    ? { ...item, [parentKey]: candidate.id, [containerKey]: hierarchyContainerId(candidate, containerKey) }
    : item);
  return {
    ok: true,
    disabled: false,
    direction,
    reason: 'attach-to-previous-peer',
    parentId: candidate.id,
    sourceDepth,
    nextDepth: sourceDepth + 1,
    parentAssignments: { [sourceKey]: candidate.id },
    containerAssignments: { [sourceKey]: hierarchyContainerId(candidate, containerKey) },
    items: next,
  };
}

export function flatStructuredEntities(raw) {
  const model = normalizeStructuredModel(raw);
  return [
    ...model.containers.map((item) => ({ type: 'container', id: item.id, position: item.position })),
    ...model.items.filter((item) => !item.containerId && !item.parentId).map((item) => ({ type: 'item', id: item.id, position: item.position })),
  ].sort(byPosition);
}

function reindexFlat(model, flat) {
  const containers = model.containers.map((item) => ({ ...item }));
  const items = model.items.map((item) => ({ ...item }));
  const containerById = new Map(containers.map((item) => [item.id, item]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  flat.forEach((entity, position) => {
    if (entity.type === 'container') {
      const target = containerById.get(String(entity.id));
      if (target) target.position = position;
    } else {
      const target = itemById.get(String(entity.id));
      if (target) {
        target.containerId = null;
        target.parentId = null;
        target.position = position;
      }
    }
  });
  return { containers, items };
}

export function moveStructuredEntity(raw, drag, target) {
  const model = normalizeStructuredModel(raw);
  const normalizedDrag = { type: drag.type, id: String(drag.id) };
  if (normalizedDrag.type === 'container' && !model.containers.some((item) => item.id === normalizedDrag.id)) return model;
  if (normalizedDrag.type === 'item' && !model.items.some((item) => item.id === normalizedDrag.id)) return model;

  if (target.kind === 'container') {
    if (normalizedDrag.type !== 'item') return model;
    const containerId = String(target.containerId);
    if (!model.containers.some((item) => item.id === containerId)) return model;
    const moving = model.items.find((item) => item.id === normalizedDrag.id);
    const movingBlock = visualHierarchySubtreeItems(model.items, normalizedDrag.id);
    const movingIds = new Set(movingBlock.map((item) => item.id));
    const siblings = model.items
      .filter((item) => item.containerId === containerId && !movingIds.has(item.id))
      .sort(byPosition);
    const index = Math.max(0, Math.min(Number(target.index) || 0, siblings.length));
    const sourceParentId = hierarchyParentId(moving);
    const ordered = [
      ...siblings.slice(0, index),
      ...movingBlock.map((item) => ({
        ...item,
        containerId,
        parentId: item.id === normalizedDrag.id
          && moving.containerId !== containerId
          && sourceParentId
          && !movingIds.has(sourceParentId)
          ? null
          : item.parentId,
      })),
      ...siblings.slice(index),
    ];
    const positionById = new Map(ordered.map((item, position) => [item.id, position]));
    const movedById = new Map(ordered.filter((item) => movingIds.has(item.id)).map((item) => [item.id, item]));
    const next = {
      containers: model.containers,
      items: model.items.map((item) => {
        if (movedById.has(item.id)) return { ...item, ...movedById.get(item.id), position: positionById.get(item.id) };
        if (item.containerId === containerId && positionById.has(item.id)) return { ...item, position: positionById.get(item.id) };
        return item;
      }),
    };
    return reindexFlat(next, flatStructuredEntities(next));
  }

  const entity = { type: normalizedDrag.type, id: normalizedDrag.id };
  const flat = flatStructuredEntities(model);
  const key = entityKey(entity);
  const existingIndex = flat.findIndex((item) => entityKey(item) === key);
  const without = flat.filter((item) => entityKey(item) !== key);
  const rawIndex = Math.max(0, Math.min(Number(target.index) || 0, flat.length));
  const index = Math.max(0, Math.min(existingIndex >= 0 && existingIndex < rawIndex ? rawIndex - 1 : rawIndex, without.length));
  without.splice(index, 0, entity);
  if (normalizedDrag.type !== 'item') return reindexFlat(model, without);

  const movingBlock = visualHierarchySubtreeItems(model.items, normalizedDrag.id);
  const movingIds = new Set(movingBlock.map((item) => item.id));
  const detached = {
    containers: model.containers,
    items: model.items.map((item) => movingIds.has(item.id)
      ? {
          ...item,
          containerId: null,
          parentId: item.id === normalizedDrag.id ? null : item.parentId,
        }
      : item),
  };
  return reindexFlat(detached, without);
}

function rectDistanceY(rect, clientY) {
  if (!rect) return Number.POSITIVE_INFINITY;
  if (clientY < rect.top) return rect.top - clientY;
  if (clientY > rect.bottom) return clientY - rect.bottom;
  return 0;
}

function unionRects(rects) {
  const existing = rects.filter(Boolean);
  if (existing.length === 0) return null;
  const top = Math.min(...existing.map((rect) => rect.top));
  const bottom = Math.max(...existing.map((rect) => rect.bottom));
  const left = Math.min(...existing.map((rect) => rect.left));
  const right = Math.max(...existing.map((rect) => rect.right));
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    midX: (left + right) / 2,
    midY: (top + bottom) / 2,
  };
}

function geometryItemRects(geometry) {
  const result = new Map();
  const append = (id, rect) => {
    const key = String(id ?? '');
    if (!key || !rect) return;
    result.set(key, [...(result.get(key) || []), rect]);
  };
  for (const row of geometry?.flat || []) {
    if (row.type === 'item') append(row.id, row.rect);
  }
  for (const group of geometry?.groups || []) {
    for (const row of group.rows || []) append(row.id, row.rect);
  }
  return result;
}

function nearestVerticalCandidate(candidates, clientY) {
  let nearest = null;
  for (const candidate of candidates) {
    const distance = rectDistanceY(candidate.rect, clientY);
    if (!nearest || distance < nearest.distance) nearest = { ...candidate, distance };
  }
  return nearest;
}

function sameIdOrder(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function reorderTopLevelEntity(model, drag, target, placement) {
  const sourceKey = entityKey(drag);
  const targetKey = entityKey(target);
  const flat = flatStructuredEntities(model);
  const sourceIndex = flat.findIndex((entity) => entityKey(entity) === sourceKey);
  const targetIndex = flat.findIndex((entity) => entityKey(entity) === targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceKey === targetKey) {
    return { ok: false, disabled: true, reason: 'invalid-top-level-target', model };
  }

  const withoutSource = flat.filter((entity) => entityKey(entity) !== sourceKey);
  const targetIndexWithoutSource = withoutSource.findIndex((entity) => entityKey(entity) === targetKey);
  const insertionIndex = targetIndexWithoutSource + (placement === 'after' ? 1 : 0);
  withoutSource.splice(insertionIndex, 0, flat[sourceIndex]);
  const beforeKeys = flat.map(entityKey);
  const afterKeys = withoutSource.map(entityKey);
  const positionByKey = new Map(withoutSource.map((entity, position) => [entityKey(entity), position]));
  const containers = model.containers.map((container) => ({
    ...container,
    position: positionByKey.get(entityKey({ type: 'container', id: container.id })) ?? container.position,
  }));
  const items = model.items.map((item) => {
    if (hierarchyContainerId(item) || hierarchyParentId(item)) return item;
    return {
      ...item,
      position: positionByKey.get(entityKey({ type: 'item', id: item.id })) ?? item.position,
    };
  });
  return {
    ok: true,
    disabled: false,
    changed: !sameIdOrder(beforeKeys, afterKeys),
    reason: 'move-top-level-block',
    orderedEntities: withoutSource,
    model: { containers, items },
  };
}

/**
 * Resolves the vertical part of a structured drag. Vertical movement changes
 * order only; container and parent assignments are deliberately untouched.
 */
export function resolveStructuredVerticalMove({
  model: rawModel,
  geometry,
  drag,
  clientX,
  clientY,
  parentKey = 'parentId',
  containerKey = 'containerId',
} = {}) {
  const model = normalizeStructuredModel(rawModel);
  if (!geometry || !drag) return { ok: false, disabled: true, reason: 'missing-geometry', model };
  const list = geometry.list;
  if (!list || clientX < list.left || clientX > list.right || clientY < list.top || clientY > list.bottom) {
    return { ok: false, disabled: true, outside: true, reason: 'outside-list', model };
  }

  const itemById = new Map(model.items.map((item) => [item.id, item]));
  const sourceItem = drag.type === 'item' ? itemById.get(String(drag.id)) : null;
  const sourceIsTopLevel = drag.type === 'container'
    || !!sourceItem && !hierarchyParentId(sourceItem, parentKey) && !hierarchyContainerId(sourceItem, containerKey);
  const itemRects = geometryItemRects(geometry);

  if (sourceIsTopLevel) {
    const sourceEntity = { type: drag.type, id: String(drag.id) };
    const candidates = [];
    for (const entity of flatStructuredEntities(model)) {
      if (entityKey(entity) === entityKey(sourceEntity)) continue;
      if (entity.type === 'container') {
        const flatRow = (geometry.flat || []).find((row) => row.type === 'container' && String(row.id) === entity.id);
        if (flatRow?.rect) {
          const memberIds = orderVisualHierarchyItems(
            model.items.filter((item) => hierarchyContainerId(item, containerKey) === entity.id),
            { parentKey },
          ).map((item) => item.id);
          candidates.push({
            entity,
            rect: flatRow.rect,
            targetIds: [`container:${entity.id}`, ...memberIds],
          });
        }
        continue;
      }
      const targetItems = visualHierarchySubtreeItems(model.items, entity.id, { parentKey });
      const rect = unionRects(targetItems.flatMap((item) => itemRects.get(item.id) || []));
      if (rect) candidates.push({ entity, rect, targetIds: targetItems.map((item) => item.id) });
    }
    const target = nearestVerticalCandidate(candidates, clientY);
    if (!target) return { ok: false, disabled: true, reason: 'no-target-block', model };
    const placement = clientY < target.rect.midY ? 'before' : 'after';
    const moved = reorderTopLevelEntity(model, sourceEntity, target.entity, placement);
    return {
      ...moved,
      key: `block:${entityKey(target.entity)}:${placement}`,
      placement,
      targetEntity: target.entity,
      targetIds: target.targetIds,
      targetRect: target.rect,
    };
  }

  if (!sourceItem) return { ok: false, disabled: true, reason: 'invalid-source', model };
  const sourceParentId = hierarchyParentId(sourceItem, parentKey);
  const sourceContainerId = hierarchyContainerId(sourceItem, containerKey);
  const sourceIds = new Set(visualHierarchySubtreeItems(model.items, sourceItem.id, { parentKey }).map((item) => item.id));
  const siblingRoots = model.items.filter((item) => (
    item.id !== sourceItem.id
    && hierarchyParentId(item, parentKey) === sourceParentId
    && hierarchyContainerId(item, containerKey) === sourceContainerId
  ));
  const candidates = siblingRoots.map((item) => {
    const targetItems = visualHierarchySubtreeItems(model.items, item.id, { parentKey });
    return {
      item,
      targetItems,
      rect: unionRects(targetItems.flatMap((targetItem) => itemRects.get(targetItem.id) || [])),
    };
  }).filter((candidate) => candidate.rect && !candidate.targetItems.some((item) => sourceIds.has(item.id)));
  const target = nearestVerticalCandidate(candidates, clientY);
  if (!target) return { ok: false, disabled: true, reason: 'no-sibling-target', model };
  const placement = clientY < target.rect.midY ? 'before' : 'after';
  const moved = resolveVisualBlockMove({
    items: model.items,
    sourceId: sourceItem.id,
    targetId: target.item.id,
    placement,
    parentKey,
    containerKey,
  });
  if (!moved.ok) return { ...moved, model };
  return {
    ...moved,
    changed: !sameIdOrder(
      orderVisualHierarchyItems(model.items, { parentKey }).map((item) => item.id),
      moved.orderedIds,
    ),
    key: `block:item:${moved.targetRootId}:${placement}`,
    placement,
    targetEntity: { type: 'item', id: moved.targetRootId },
    targetIds: moved.targetIds,
    targetRect: target.rect,
    model: { containers: model.containers, items: moved.items },
  };
}

/** Horizontal hierarchy step, including an explicit step into the preceding group. */
export function resolveStructuredHierarchyStep({
  model: rawModel,
  sourceId,
  direction,
  parentKey = 'parentId',
  containerKey = 'containerId',
  maxDepth = 4,
} = {}) {
  const model = normalizeStructuredModel(rawModel);
  const source = model.items.find((item) => item.id === String(sourceId));
  const flat = direction === 'right' && source && !hierarchyParentId(source, parentKey) && !hierarchyContainerId(source, containerKey)
    ? flatStructuredEntities(model)
    : [];
  const sourceIndex = flat.findIndex((entity) => entity.type === 'item' && entity.id === source?.id);
  const previous = sourceIndex > 0 ? flat[sourceIndex - 1] : null;

  if (!previous || previous.type !== 'container') {
    const result = resolveVisualHierarchyStep({
      items: model.items,
      sourceId,
      direction,
      parentKey,
      containerKey,
      maxDepth,
    });
    return { ...result, model: result.ok ? { containers: model.containers, items: result.items } : model };
  }

  const subtree = visualHierarchySubtreeItems(model.items, source.id, { parentKey });
  const sourceIds = new Set(subtree.map((item) => item.id));
  const existing = orderVisualHierarchyItems(
    model.items.filter((item) => hierarchyContainerId(item, containerKey) === previous.id && !sourceIds.has(item.id)),
    { parentKey },
  );
  const nextOrder = [...existing, ...subtree];
  const positionById = new Map(nextOrder.map((item, position) => [item.id, position]));
  const nextItems = model.items.map((item) => sourceIds.has(item.id)
    ? {
        ...item,
        [containerKey]: previous.id,
        [parentKey]: item.id === source.id ? null : item[parentKey],
        position: positionById.get(item.id),
      }
    : positionById.has(item.id) ? { ...item, position: positionById.get(item.id) } : item);
  const parentAssignments = Object.fromEntries(subtree.map((item) => [item.id, item.id === source.id ? null : hierarchyParentId(item, parentKey)]));
  const containerAssignments = Object.fromEntries(subtree.map((item) => [item.id, previous.id]));
  return {
    ok: true,
    disabled: false,
    direction,
    reason: 'enter-previous-container',
    parentId: null,
    containerId: previous.id,
    sourceDepth: 0,
    nextDepth: 1,
    parentAssignments,
    containerAssignments,
    items: nextItems,
    model: { containers: model.containers, items: nextItems },
  };
}

export function captureGroupedListGeometry(root, flatEntities, options = {}) {
  if (!root) return null;
  const flatIndex = new Map((flatEntities || []).map((item, index) => [entityKey(item), index]));
  const flat = [];
  for (const container of root.querySelectorAll('[data-dnd-flat-container]')) {
    const rawType = container.dataset.dndType;
    const id = container.dataset.dndId;
    const type = rawType === 'group' || rawType === 'container' ? 'container' : rawType === 'prompt' || rawType === 'item' ? 'item' : null;
    if (!type || id == null) continue;
    const index = flatIndex.get(entityKey({ type, id }));
    if (index == null) continue;
    const headerElement = type === 'container'
      ? container.querySelector('[data-dnd-kind="flat"]') || container
      : container;
    flat.push({ type, id: String(id), index, rect: snapRect(container, options), header: snapRect(headerElement, options) });
  }

  const groups = [];
  for (const body of root.querySelectorAll('[data-dnd-kind="group-body"]')) {
    const containerId = body.dataset.groupId;
    if (containerId == null) continue;
    const wrapper = body.closest('[data-dnd-flat-container]');
    const headerElement = wrapper?.querySelector('[data-dnd-kind="flat"]') || null;
    const rows = Array.from(body.querySelectorAll('[data-dnd-kind="group-item"], [data-dnd-kind="group-prompt"]'))
      .map((row) => ({ id: String(row.dataset.dndId ?? row.dataset.promptId ?? row.dataset.promptIndex ?? ''), rect: snapRect(row, options) }))
      .filter((row) => row.id);
    const emptyElement = body.querySelector('[data-dnd-kind="group-empty"]');
    groups.push({
      containerId: String(containerId),
      header: headerElement ? snapRect(headerElement, options) : null,
      body: snapRect(body, options),
      rows,
      empty: emptyElement ? snapRect(emptyElement, options) : null,
      rowLeft: rows.length ? Math.min(...rows.map((row) => row.rect.left)) : null,
      rowRight: rows.length ? Math.max(...rows.map((row) => row.rect.right)) : null,
    });
  }
  flat.sort((a, b) => a.index - b.index);
  return { list: snapRect(root, options), flat, groups };
}

export function resolveGroupedListTarget({ geometry, drag, clientX, clientY }) {
  if (!geometry) return null;
  const list = geometry.list;
  if (clientX < list.left || clientX > list.right || clientY < list.top || clientY > list.bottom) return null;
  const dragKey = entityKey({ type: drag.type, id: String(drag.id) });
  const target = nearestVerticalCandidate(
    (geometry.flat || [])
      .filter((row) => entityKey({ type: row.type, id: String(row.id) }) !== dragKey)
      .map((row) => ({ row, rect: row.rect })),
    clientY,
  );
  if (!target) return null;
  const placement = clientY < target.rect.midY ? 'before' : 'after';
  return {
    key: `block:${target.row.type}:${target.row.id}:${placement}`,
    kind: 'block',
    targetType: target.row.type,
    targetId: String(target.row.id),
    placement,
    reason: 'atomic-flat-block',
  };
}

export function autoScrollNearEdge(element, clientY, { edge = 34, minStep = 6, divisor = 3 } = {}) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const before = element.scrollTop;
  if (clientY < rect.top + edge) element.scrollTop -= Math.ceil((rect.top + edge - clientY) / divisor) + minStep;
  else if (clientY > rect.bottom - edge) element.scrollTop += Math.ceil((clientY - (rect.bottom - edge)) / divisor) + minStep;
  return before !== element.scrollTop;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export function startPointerDragSession(pointerEvent, options) {
  if (pointerEvent.button !== 0) return null;
  const target = pointerEvent.target;
  if (target?.closest?.(options.ignoreSelector || DEFAULT_IGNORE_SELECTOR)) return null;
  pointerEvent.preventDefault();
  pointerEvent.stopPropagation();

  const session = {
    item: options.item,
    base: options.getBase(),
    startX: pointerEvent.clientX,
    startY: pointerEvent.clientY,
    active: false,
    geometry: null,
    geometryRevision: 0,
    refreshing: false,
    pointerRevision: 0,
    processedPointerRevision: -1,
    lastClientX: pointerEvent.clientX,
    lastClientY: pointerEvent.clientY,
    processedClientX: null,
    processedClientY: null,
    lastKey: null,
    prevCursor: document.body.style.cursor,
    prevUserSelect: document.body.style.userSelect,
  };
  let finished = false;

  const runPreview = (clientX, clientY) => {
    if (finished || session.refreshing) return;
    const processedRevision = session.pointerRevision;
    const result = options.onPreview({ session, clientX, clientY });
    session.processedPointerRevision = processedRevision;
    session.processedClientX = clientX;
    session.processedClientY = clientY;
    if (result?.key) session.lastKey = result.key;
    if (result?.changed) refreshGeometry('preview');
  };

  const refreshGeometry = async (reason) => {
    if (finished || session.refreshing) return;
    session.refreshing = true;
    const expectedRevision = ++session.geometryRevision;
    const pointerRevision = session.pointerRevision;
    await nextFrame();
    await nextFrame();
    if (!finished && expectedRevision === session.geometryRevision) {
      const snapshot = options.getGeometrySnapshot?.(session) ?? session.pendingNext ?? session.base;
      session.geometry = options.captureGeometry(snapshot, reason);
      session.refreshing = false;
      if (session.pointerRevision !== pointerRevision) {
        runPreview(session.lastClientX, session.lastClientY);
      }
    }
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('blur', onBlur);
    document.body.style.cursor = session.prevCursor;
    document.body.style.userSelect = session.prevUserSelect;
  };

  const finish = (commit) => {
    if (finished) return;
    finished = true;
    session.geometryRevision += 1;
    cleanup();
    if (session.active) {
      if (commit) options.onCommit(session);
      else options.onCancel(session);
    } else if (commit) {
      options.onClick?.();
    }
    options.onFinish?.(session, commit);
  };

  const beginIfNeeded = (event) => {
    if (session.active) return true;
    if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < (options.threshold ?? 4)) return false;
    session.geometry = options.captureGeometry(session.base, 'start');
    session.active = true;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    options.onStart?.(session);
    return true;
  };

  const onMove = (event) => {
    if (finished) return;
    event.preventDefault();
    if (!beginIfNeeded(event)) return;
    session.lastClientX = event.clientX;
    session.lastClientY = event.clientY;
    session.pointerRevision += 1;
    const scrolled = options.autoScroll?.(event.clientY, session) === true;
    if (session.refreshing) return;
    runPreview(event.clientX, event.clientY);
    if (scrolled) refreshGeometry('scroll');
  };
  const onUp = (event) => {
    if (!session.active) {
      finish(true);
      return;
    }
    const sameProcessedPointer = !session.refreshing
      && session.processedPointerRevision === session.pointerRevision
      && Number.isFinite(session.processedClientX)
      && Number.isFinite(session.processedClientY)
      && Math.abs(event.clientX - session.processedClientX) <= 0.5
      && Math.abs(event.clientY - session.processedClientY) <= 0.5;
    finish(sameProcessedPointer);
  };
  const onCancel = () => finish(false);
  const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
  const onBlur = () => finish(false);

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('blur', onBlur);
  return { session, cancel: () => finish(false) };
}
