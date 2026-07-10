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

  const depthById = buildVisualHierarchyDepthMap(items, { parentKey, maxDepth });
  const sourceDepth = depthById.get(sourceKey) || 0;
  const currentParentId = hierarchyParentId(source, parentKey);
  if (direction === 'left') {
    if (!currentParentId || !byId.has(currentParentId)) {
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

  if (sourceDepth >= maxDepth) {
    return { ok: false, disabled: true, direction, reason: 'max-depth', sourceDepth, items };
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

function visualSubtreeIds(items, sourceId) {
  const sourceKey = String(sourceId);
  const ids = new Set([sourceKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      const parentId = hierarchyParentId(item);
      if (!parentId || ids.has(item.id) || !ids.has(parentId)) continue;
      ids.add(item.id);
      changed = true;
    }
  }
  return ids;
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
    const movingIds = visualSubtreeIds(model.items, normalizedDrag.id);
    const movingBlock = orderVisualHierarchyItems(
      model.items.filter((item) => movingIds.has(item.id)).sort(byPosition),
    );
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
  return reindexFlat(model, without);
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
  const dragId = String(drag.id);
  const list = geometry.list;
  if (clientX < list.left - 28 || clientX > list.right + 28 || clientY < list.top - 80 || clientY > list.bottom + 80) return null;

  if (drag.type === 'item') {
    for (const group of geometry.groups) {
      const flatGroup = geometry.flat.find((row) => row.type === 'container' && row.id === group.containerId);
      if (flatGroup && group.header && clientX >= group.header.left && clientX <= group.header.right && clientY >= group.header.top && clientY <= group.header.bottom) {
        return clientY >= group.header.midY
          ? { key: `container:${group.containerId}:0`, kind: 'container', containerId: group.containerId, index: 0, reason: 'container-header-lower' }
          : { key: `flat:${flatGroup.index}`, kind: 'flat', index: flatGroup.index, reason: 'container-header-upper' };
      }
      if (group.rows.length === 0) {
        const empty = group.empty;
        if (empty && clientY >= empty.top && clientY <= empty.bottom && clientX >= empty.left - 18 && clientX <= empty.right + 18) {
          return { key: `container:${group.containerId}:0`, kind: 'container', containerId: group.containerId, index: 0, reason: 'container-empty' };
        }
        continue;
      }
      const first = group.rows[0].rect;
      const last = group.rows[group.rows.length - 1].rect;
      if (clientY < Math.min(group.body.top, first.top - 8) || clientY > last.bottom) continue;
      if (clientX < (group.rowLeft ?? group.body.left) - 12 || clientX > (group.rowRight ?? group.body.right) + 18) continue;
      let index = 0;
      for (const row of group.rows) {
        if (row.id === dragId) continue;
        if (clientY < row.rect.midY) break;
        index += 1;
      }
      return { key: `container:${group.containerId}:${index}`, kind: 'container', containerId: group.containerId, index, reason: 'container-rows' };
    }
  }

  let index = geometry.flat.length;
  for (const row of geometry.flat) {
    if (clientY < row.rect.midY) {
      index = row.index;
      break;
    }
    index = row.index + 1;
  }
  return { key: `flat:${index}`, kind: 'flat', index, reason: 'flat-block' };
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
    lastKey: null,
    prevCursor: document.body.style.cursor,
    prevUserSelect: document.body.style.userSelect,
  };
  let finished = false;

  const refreshGeometry = async (reason) => {
    if (finished || session.refreshing) return;
    session.refreshing = true;
    const expectedRevision = ++session.geometryRevision;
    await nextFrame();
    await nextFrame();
    if (!finished && expectedRevision === session.geometryRevision) {
      session.geometry = options.captureGeometry(session.base, reason);
      session.refreshing = false;
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
    const scrolled = options.autoScroll?.(event.clientY, session) === true;
    if (session.refreshing) return;
    const result = options.onPreview({ session, clientX: event.clientX, clientY: event.clientY });
    if (result?.key) session.lastKey = result.key;
    if (scrolled || result?.changed) refreshGeometry(scrolled ? 'scroll' : 'preview');
  };
  const onUp = () => finish(true);
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
