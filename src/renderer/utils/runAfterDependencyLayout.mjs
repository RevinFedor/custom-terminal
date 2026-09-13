/**
 * Compact layered layout for the global Run After overview.
 *
 * The runtime queue remains a per-tab ordered list. This module only projects
 * its `on tab` relations into a readable graph: referenced tab -> queue owner.
 * Components are independent flex items, so short chains can share a row while
 * one wide/deep chain may scroll without reserving empty columns for its peers.
 */

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * @param {{
 *   nodeIds: string[],
 *   edges: Array<{ source: string, target: string, kind?: 'current'|'future' }>,
 *   nodeWidth?: number,
 *   nodeHeight?: number,
 *   columnGap?: number,
 *   rowGap?: number,
 *   padding?: number,
 * }} input
 */
export function layoutRunAfterDependencyGraph(input) {
  const nodeIds = [...new Set((input?.nodeIds || []).filter(Boolean))];
  const order = new Map(nodeIds.map((id, index) => [id, index]));
  const nodeSet = new Set(nodeIds);
  const edgeByPair = new Map();

  for (const raw of input?.edges || []) {
    if (!raw?.source || !raw?.target || raw.source === raw.target) continue;
    if (!nodeSet.has(raw.source) || !nodeSet.has(raw.target)) continue;
    const key = `${raw.source}\u0000${raw.target}`;
    const edge = { source: raw.source, target: raw.target, kind: raw.kind === 'current' ? 'current' : 'future' };
    const previous = edgeByPair.get(key);
    if (!previous || edge.kind === 'current') edgeByPair.set(key, edge);
  }
  const edges = [...edgeByPair.values()];

  const neighbours = new Map(nodeIds.map((id) => [id, new Set()]));
  for (const edge of edges) {
    neighbours.get(edge.source)?.add(edge.target);
    neighbours.get(edge.target)?.add(edge.source);
  }

  const components = [];
  const visited = new Set();
  for (const first of nodeIds) {
    if (visited.has(first)) continue;
    const ids = [];
    const pending = [first];
    visited.add(first);
    while (pending.length) {
      const id = pending.shift();
      ids.push(id);
      const adjacent = [...(neighbours.get(id) || [])]
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      for (const next of adjacent) {
        if (visited.has(next)) continue;
        visited.add(next);
        pending.push(next);
      }
    }
    components.push(ids);
  }

  const nodeWidth = Math.max(180, finite(input?.nodeWidth, 260));
  const nodeHeight = Math.max(26, finite(input?.nodeHeight, 34));
  const columnGap = Math.max(24, finite(input?.columnGap, 42));
  const rowGap = Math.max(7, finite(input?.rowGap, 12));
  const padding = Math.max(4, finite(input?.padding, 8));

  return components.map((ids, componentIndex) => {
    const idSet = new Set(ids);
    const componentEdges = edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target));
    const incoming = new Map(ids.map((id) => [id, []]));
    const outgoing = new Map(ids.map((id) => [id, []]));
    for (const edge of componentEdges) {
      incoming.get(edge.target).push(edge.source);
      outgoing.get(edge.source).push(edge.target);
    }

    // Longest-path depth for the acyclic contract. A damaged legacy cycle is
    // still rendered: its unprocessed nodes remain in column zero rather than
    // making the whole overview disappear.
    const indegree = new Map(ids.map((id) => [id, incoming.get(id).length]));
    const depth = new Map(ids.map((id) => [id, 0]));
    const ready = ids.filter((id) => indegree.get(id) === 0)
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const processed = new Set();
    while (ready.length) {
      const id = ready.shift();
      if (processed.has(id)) continue;
      processed.add(id);
      const targets = [...(outgoing.get(id) || [])]
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      for (const target of targets) {
        depth.set(target, Math.max(depth.get(target) || 0, (depth.get(id) || 0) + 1));
        indegree.set(target, (indegree.get(target) || 0) - 1);
        if (indegree.get(target) === 0) ready.push(target);
      }
      ready.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }

    const columns = new Map();
    for (const id of ids) {
      const d = processed.has(id) ? depth.get(id) || 0 : 0;
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d).push(id);
    }
    const depths = [...columns.keys()].sort((a, b) => a - b);
    const maxRows = Math.max(1, ...depths.map((d) => columns.get(d).length));
    const pitch = nodeHeight + rowGap;
    const positions = new Map();
    for (const d of depths) {
      const column = columns.get(d);
      // Parents/children remain near one another while the input order is the
      // deterministic tie-breaker. One source with many dependants therefore
      // sits vertically centred beside them instead of at the top of a void.
      column.sort((a, b) => {
        const parentRank = (id) => {
          const parents = incoming.get(id) || [];
          if (!parents.length) return order.get(id) ?? 0;
          return parents.reduce((sum, parent) => sum + (order.get(parent) ?? 0), 0) / parents.length;
        };
        return parentRank(a) - parentRank(b) || (order.get(a) ?? 0) - (order.get(b) ?? 0);
      });
      const yOffset = ((maxRows - column.length) * pitch) / 2;
      column.forEach((id, index) => positions.set(id, {
        id,
        x: padding + d * (nodeWidth + columnGap),
        y: padding + yOffset + index * pitch,
        width: nodeWidth,
        height: nodeHeight,
      }));
    }

    const maxDepth = Math.max(0, ...depths);
    return {
      id: `component-${componentIndex}-${ids[0]}`,
      width: padding * 2 + (maxDepth + 1) * nodeWidth + maxDepth * columnGap,
      height: padding * 2 + maxRows * nodeHeight + (maxRows - 1) * rowGap,
      nodes: ids.map((id) => positions.get(id)),
      edges: componentEdges,
    };
  });
}

