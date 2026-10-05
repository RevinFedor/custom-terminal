/** Presentation only: an edge reads "owner waits for target", per queue item. */
export const RUN_AFTER_GROUP_INSET = 14;
export const RUN_AFTER_DEPTH_INSET = 16;
export function queueItemDependencyTarget(queue, item) {
  if (item?.trigger?.kind === 'onTab') return item.trigger.tabId || null;
  const head = queue?.items?.find(candidate => candidate.enabled !== false);
  return item && head && item.id === head.id ? queue.runAfterTabId || null : null;
}

export function collectQueueRelations(ownerId, queue) {
  const head = queue?.items?.find(item => item.enabled !== false);
  const edges = (queue?.items || []).flatMap(item => {
    const target = queueItemDependencyTarget(queue, item);
    return target ? [{ source: ownerId, target, itemId: item.id,
      kind: item.enabled !== false && item.id === head?.id ? 'current' : 'future',
      enabled: item.enabled !== false }] : [];
  });
  if (!head && queue?.runAfterTabId) edges.push({ source: ownerId, target: queue.runAfterTabId,
    itemId: 'queue-target', kind: 'current', enabled: true });
  return edges;
}

/**
 * Order connected queues top-down. Heights belong to the real DOM editor;
 * indentation is capped at one level, so deep chains never grow horizontally.
 * Edges retain item identity even when several steps await the same tab.
 */
export function groupRunAfterDependencies({ nodeIds, edges }) {
  const ids = [...new Set(nodeIds)];
  const known = new Set(ids);
  const relations = edges.filter(e => known.has(e.source) && known.has(e.target));
  const neighbours = new Map(ids.map(id => [id, new Set()]));
  for (const edge of relations) {
    neighbours.get(edge.source).add(edge.target);
    neighbours.get(edge.target).add(edge.source);
  }
  const visited = new Set();
  const components = [];
  for (const first of ids) {
    if (visited.has(first)) continue;
    const connected = new Set([first]), pending = [first];
    visited.add(first);
    for (let index = 0; index < pending.length; index++) {
      for (const next of neighbours.get(pending[index])) {
        if (visited.has(next)) continue;
        visited.add(next); connected.add(next); pending.push(next);
      }
    }
    const members = ids.filter(id => connected.has(id));
    const links = relations.filter(edge => connected.has(edge.source));
    const incoming = new Map(members.map(id => [id, new Set()]));
    const outgoing = new Map(members.map(id => [id, new Set()]));
    for (const { source, target } of links) {
      if (source === target) continue;
      outgoing.get(source).add(target); incoming.get(target).add(source);
    }
    const nodes = [], placed = new Set(), depths = new Map();
    while (nodes.length < members.length) {
      // Cyclic legacy data stays visible; no recursion and no disappearing queue.
      const next = members.find(id => !placed.has(id) && [...incoming.get(id)].every(parent => placed.has(parent)))
        || members.find(id => !placed.has(id));
      const depth = Math.min(1, depths.get(next) || 0);
      placed.add(next); nodes.push({ id: next, depth });
      for (const target of outgoing.get(next)) depths.set(target, 1);
    }
    components.push({ id: first, nodes, edges: links });
  }
  return components;
}

/** Keep already inspected groups/order/indentation for this overview. A new
 * target may join its owner, but adding/removing a link never reparents an
 * existing visible card. Resize still packs the same content-sized groups. */
export function retainRunAfterGroups(previous, { nodeIds, edges }) {
  if (previous === null) return groupRunAfterDependencies({ nodeIds, edges });
  const known = new Set(nodeIds);
  const groups = previous.map(group => ({ ...group, nodes: group.nodes.filter(node => known.has(node.id)) }))
    .filter(group => group.nodes.length);
  const assigned = new Map(groups.flatMap(group => group.nodes.map(node => [node.id, group])));
  for (const id of nodeIds) {
    if (assigned.has(id)) continue;
    const parent = edges.find(edge => edge.target === id && assigned.has(edge.source));
    const group = parent ? assigned.get(parent.source) : { id, nodes: [], edges: [] };
    if (!parent) groups.push(group);
    group.nodes.push({ id, depth: parent ? 1 : 0 });
    assigned.set(id, group);
  }
  return groups;
}

/** Pack content-sized groups. Only positions depend on viewport width. */
export function layoutRunAfterCards({ nodeIds, edges, sizes, availableWidth, gap = 14, groups = null }) {
  const width = Math.max(1, availableWidth);
  const sizeMap = new Map(sizes.map(size => [size.id, size]));
  const placed = [], nodes = [], components = [];
  for (const group of groups || groupRunAfterDependencies({ nodeIds, edges })) {
    let y = 0, componentWidth = 0;
    const local = group.nodes.flatMap(node => {
      const size = sizeMap.get(node.id);
      if (!size) return [];
      const x = RUN_AFTER_GROUP_INSET + node.depth * RUN_AFTER_DEPTH_INSET;
      const result = { ...node, x, y, width: size.width, height: size.height };
      y += size.height + gap;
      componentWidth = Math.max(componentWidth, x + size.width);
      return [result];
    });
    if (!local.length) continue;
    const height = Math.max(0, y - gap);
    const candidates = [...new Set([0, ...placed.flatMap(rect => [rect.x, rect.x + rect.width + gap])])]
      .filter(x => x === 0 || x + componentWidth <= width + 0.5).sort((a, b) => a - b);
    let position = null;
    for (const x of candidates) {
      let top = 0, collision;
      do {
        collision = placed.find(rect => x < rect.x + rect.width + gap && x + componentWidth + gap > rect.x
          && top < rect.y + rect.height + gap && top + height + gap > rect.y);
        if (collision) top = collision.y + collision.height + gap;
      } while (collision);
      if (!position || top < position.y || (top === position.y && x < position.x)) position = { x, y: top };
    }
    const rect = { ...position, width: componentWidth, height };
    placed.push(rect); components.push({ ...rect, id: group.id });
    nodes.push(...local.map(node => ({ ...node, x: node.x + rect.x, y: node.y + rect.y, lane: rect.x + 3 })));
  }
  return { nodes, components, width: Math.max(0, ...placed.map(rect => rect.x + rect.width)),
    height: Math.max(0, ...placed.map(rect => rect.y + rect.height)) };
}
