/** Presentation only: an edge reads "owner waits for target", per queue item. */
import { pendingPromptTabIds } from './promptQueueDependencies.mjs';
export const RUN_AFTER_GROUP_INSET = 14;
export const RUN_AFTER_DEPTH_INSET = 16;
export const runAfterEdgeKey = edge => JSON.stringify([edge.source, edge.itemId, edge.target]);
export function queueItemDependencyTarget(queue, item) {
  if (item?.trigger?.kind === 'onTab') return pendingPromptTabIds(item.trigger)[0] || null;
  const head = queue?.items?.find(candidate => candidate.enabled !== false);
  return item && head && item.id === head.id ? queue.runAfterTabId || null : null;
}

export function collectQueueRelations(ownerId, queue) {
  const head = queue?.items?.find(item => item.enabled !== false);
  const edges = (queue?.items || []).flatMap(item => {
    const targets = item.trigger?.kind === 'onTab' ? pendingPromptTabIds(item.trigger) : [queueItemDependencyTarget(queue, item)].filter(Boolean);
    return targets.map(target => ({ source: ownerId, target, itemId: item.id,
      kind: item.enabled !== false && item.id === head?.id ? 'current' : 'future',
      enabled: item.enabled !== false }));
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

/** Row-major placement with shared column gutters. Cards keep their measured
 * size; only their positions change. A connected group is an ordering hint,
 * not an indivisible vertical stack. breakBefore reserves the disabled shelf
 * while keeping the same safe vertical lanes in both sections. */
export function layoutRunAfterCards({ nodeIds, edges, sizes, availableWidth, gap = 14, groups = null, breakBefore = new Map() }) {
  const sizeMap = new Map(sizes.map(size => [size.id, size]));
  const ordered = (groups || groupRunAfterDependencies({ nodeIds, edges })).flatMap(group => group.nodes)
    .filter(node => sizeMap.has(node.id)).map(node => ({ ...node, ...sizeMap.get(node.id),
      inset: RUN_AFTER_GROUP_INSET + node.depth * RUN_AFTER_DEPTH_INSET }));
  if (!ordered.length) return { nodes: [], rows: [], columns: 0, routes: [], separators: new Map(), width: 0, height: 0 };
  const measureColumns = columns => {
    const widths = Array(columns).fill(0), rows = [];
    let row = null;
    for (const node of ordered) {
      if (!row || row.nodes.length === columns || breakBefore.has(node.id)) {
        row = { nodes: [], height: 0, topOutset: 0, tracks: [], breakId: breakBefore.has(node.id) ? node.id : null };
        rows.push(row);
      }
      const column = row.nodes.length;
      row.nodes.push({ ...node, column, row: rows.length - 1 });
      widths[column] = Math.max(widths[column], node.inset + node.width);
      row.height = Math.max(row.height, node.height);
      row.topOutset = Math.max(row.topOutset, node.topOutset || 0);
    }
    const byId = new Map(rows.flatMap(row => row.nodes).map(node => [node.id, node]));
    const verticalTracks = Array.from({ length: columns }, () => []);
    const reserve = (column, first, last) => {
      const tracks = verticalTracks[column];
      let track = tracks.findIndex(spans => spans.every(([from, to]) => last < from || first > to));
      if (track < 0) { track = tracks.length; tracks.push([]); }
      tracks[track].push([first, last]);
      return track;
    };
    const connections = edges.flatMap(edge => {
      const source = byId.get(edge.source), target = byId.get(edge.target);
      if (!source || !target) return [];
      const first = Math.min(source.row, target.row), last = Math.max(source.row, target.row);
      const sourceTrack = reserve(source.column, first, source.column === target.column ? last : source.row);
      const targetTrack = source.column === target.column ? sourceTrack : reserve(target.column, first, target.row);
      return [{ ...edge, sourceTrack, targetTrack }];
    });
    const extra = verticalTracks.map(tracks => Math.max(0, tracks.length - 2) * 5);
    for (const row of rows) for (const node of row.nodes) node.inset += extra[node.column];
    for (let column = 0; column < columns; column++) widths[column] += extra[column];
    return { widths, rows, connections, width: widths.reduce((sum, value) => sum + value, 0) + gap * (columns - 1) };
  };
  const width = Math.max(1, availableWidth);
  const smallest = Math.min(...ordered.map(node => node.inset + node.width));
  let sectionLength = 0, longestSection = 0;
  for (const node of ordered) {
    if (breakBefore.has(node.id)) sectionLength = 0;
    longestSection = Math.max(longestSection, ++sectionLength);
  }
  let columns = Math.min(longestSection, Math.max(1, Math.floor((width + gap) / (smallest + gap))));
  let grid = measureColumns(columns);
  while (columns > 1 && grid.width > width + 0.5) grid = measureColumns(--columns);
  const byId = new Map(grid.rows.flatMap(row => row.nodes).map(node => [node.id, node]));
  const crossings = [];
  for (const edge of grid.connections) {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (source.column === target.column) continue;
    const row = Math.min(source.row, target.row), tracks = grid.rows[row].tracks;
    const span = [Math.min(source.column, target.column), Math.max(source.column, target.column)];
    // Disjoint spans can share a horizontal track; overlapping ones remain
    // separate, including multiple items that wait for the same prerequisite.
    let track = tracks.findIndex(occupied => occupied.every(([left, right]) => span[1] < left || span[0] > right));
    if (track < 0) { track = tracks.length; tracks.push([]); }
    tracks[track].push(span);
    crossings.push({ ...edge, row, track });
  }
  let height = 0;
  const separators = new Map();
  for (let index = 0; index < grid.rows.length; index++) {
    const row = grid.rows[index];
    if (row.breakId) { separators.set(row.breakId, height); height += breakBefore.get(row.breakId); }
    const clearance = row.tracks.length ? row.topOutset + 8 + row.tracks.length * 5 : row.topOutset;
    row.y = height + Math.max(index && !row.breakId ? gap : 0, clearance);
    height = row.y + row.height;
    let left = 0;
    for (const node of row.nodes) {
      node.x = left + node.inset; node.y = row.y; node.lane = left + 3;
      left += grid.widths[node.column] + gap;
    }
  }
  const corridors = new Map(crossings.map(edge => [runAfterEdgeKey(edge), edge]));
  const oneColumn = columns === 1 ? grid : measureColumns(1);
  return { nodes: grid.rows.flatMap(row => row.nodes), rows: grid.rows, columns, separators,
    minimumInset: Math.max(...oneColumn.rows.flatMap(row => row.nodes).map(node => node.inset)),
    routes: grid.connections.map(edge => {
      const crossing = corridors.get(runAfterEdgeKey(edge));
      return { ...edge, sourceLane: byId.get(edge.source).lane + edge.sourceTrack * 5,
        targetLane: byId.get(edge.target).lane + edge.targetTrack * 5,
        ...(crossing ? { row: crossing.row, viaY: grid.rows[crossing.row].y - grid.rows[crossing.row].topOutset - 6 - crossing.track * 5 } : {}) };
    }),
    width: grid.width, height };
}

function roundedOrthogonalPath(points) {
  const clean = points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  const line = (a, b) => a.x === b.x ? ` V ${b.y}` : ` H ${b.x}`;
  let d = `M ${clean[0].x} ${clean[0].y}`, cursor = clean[0];
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue;
    const before = Math.abs(b.x - a.x) + Math.abs(b.y - a.y), after = Math.abs(c.x - b.x) + Math.abs(c.y - b.y);
    const radius = Math.min(4, before / 2, after / 2);
    const enter = { x: b.x - Math.sign(b.x - a.x) * radius, y: b.y - Math.sign(b.y - a.y) * radius };
    const leave = { x: b.x + Math.sign(c.x - b.x) * radius, y: b.y + Math.sign(c.y - b.y) * radius };
    d += line(cursor, enter) + ` Q ${b.x} ${b.y} ${leave.x} ${leave.y}`; cursor = leave;
  }
  return d + line(cursor, clean.at(-1));
}

/** Anchors come from the real step/header DOM, never from a tab's title or an
 * assumed row height. Horizontal travel between columns only uses a reserved
 * corridor above a row; the source/target gutters stay outside every card. */
export function routeRunAfterEdges({ nodes, edges, routes, anchors }) {
  const positions = new Map(nodes.map(node => [node.id, node]));
  const corridors = new Map(routes.map(route => [runAfterEdgeKey(route), route]));
  return edges.flatMap(edge => {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    const sourceAnchor = anchors.get(edge.source), targetAnchor = anchors.get(edge.target);
    const origin = sourceAnchor?.stepAnchors.get(edge.itemId);
    if (!source || !target || !origin || !targetAnchor) return [];
    const start = { x: source.x + origin.x, y: source.y + origin.y };
    const end = { x: target.x + targetAnchor.headerX - 3, y: target.y + targetAnchor.headerY };
    const corridor = corridors.get(runAfterEdgeKey(edge));
    const points = [start, { x: corridor.sourceLane, y: start.y }];
    if (source.column !== target.column) {
      points.push({ x: corridor.sourceLane, y: corridor.viaY }, { x: corridor.targetLane, y: corridor.viaY });
    }
    points.push({ x: corridor.targetLane, y: end.y }, end);
    return [{ ...edge, start, end, points, d: roundedOrthogonalPath(points) }];
  });
}
