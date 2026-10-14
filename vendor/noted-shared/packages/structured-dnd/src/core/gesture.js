export const ROW_HEIGHT = 44;
export const HORIZONTAL_THRESHOLD = 40;
export const HORIZONTAL_PREVIEW_START = 7;
export const HORIZONTAL_Y_TOLERANCE = 3;
export const VERTICAL_REBASE_DISTANCE = 7;
export const EDGE_ZONE_SIZE = 72;
export const MAX_SCROLL_STEP = 14;
export const EDGE_ACTIVATION_DISTANCE = 5;
export const COLLAPSIBLE_DWELL_INTERVAL = 900;

export function boundaryFromPointer({
  clientY,
  grabOffsetY,
  containerTop,
  scrollTop,
  rowHeight = ROW_HEIGHT,
  visibleCount,
} = {}) {
  const sourceTop = clientY - grabOffsetY - containerTop + scrollTop;
  return Math.max(
    0,
    Math.min(Math.round(sourceTop / rowHeight), Math.max(0, visibleCount)),
  );
}

export function detachedBoundaryTops({
  rows = [],
  sourceIds = [],
  currentBoundary,
  allowDisjoint = false,
} = {}) {
  const sourceIdSet = new Set(sourceIds);
  const measuredRows = rows.filter((row) => (
    row
    && Number.isFinite(row.top)
    && Number.isFinite(row.bottom)
    && row.bottom >= row.top
  ));
  const sourceIndexes = measuredRows
    .map((row, index) => sourceIdSet.has(row.id) ? index : -1)
    .filter((index) => index >= 0);

  if (sourceIndexes.length === 0) return [];
  if (allowDisjoint) {
    const gaps = measuredRows.slice(0, -1).map((row, index) => measuredRows[index + 1].top - row.bottom)
      .filter(gap => gap >= 0).sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)] || 0;
    const base = [];
    let removed = 0;
    for (let index = 0; index < measuredRows.length; index++) {
      const row = measuredRows[index];
      if (sourceIdSet.has(row.id)) {
        removed += (measuredRows[index + 1]?.top ?? row.bottom + gap) - row.top;
      } else base.push({ top: row.top - removed, bottom: row.bottom - removed });
    }
    return base.length ? [...base.map(row => row.top), base.at(-1).bottom + gap] : [measuredRows[0].top];
  }
  const sourceStartIndex = sourceIndexes[0];
  const sourceEndIndex = sourceIndexes.at(-1);
  if (sourceIndexes.some((index, offset) => index !== sourceStartIndex + offset)) return [];

  const rowsBeforeSource = measuredRows
    .slice(0, sourceStartIndex)
    .filter((row) => !sourceIdSet.has(row.id));
  const baseRows = measuredRows.filter((row) => !sourceIdSet.has(row.id));
  const numericBoundary = Number(currentBoundary);
  if (
    !Number.isFinite(numericBoundary)
    || Math.trunc(numericBoundary) !== rowsBeforeSource.length
  ) return [];

  const boundary = rowsBeforeSource.length;
  const sourceTop = measuredRows[sourceStartIndex].top;
  if (baseRows.length === 0) return [sourceTop];

  const nextBaseRow = baseRows[boundary] || null;
  const sourceFootprint = nextBaseRow ? nextBaseRow.top - sourceTop : 0;
  if (nextBaseRow && sourceFootprint < 0) return [];

  const gaps = [];
  for (let index = 0; index < measuredRows.length - 1; index += 1) {
    const gap = measuredRows[index + 1].top - measuredRows[index].bottom;
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const trailingGap = gaps.length === 0
    ? 0
    : gaps[Math.floor(gaps.length / 2)];

  const boundaryTops = [];
  for (let index = 0; index <= baseRows.length; index += 1) {
    if (index < boundary) {
      boundaryTops.push(baseRows[index].top);
    } else if (index === boundary) {
      boundaryTops.push(sourceTop);
    } else if (index < baseRows.length) {
      boundaryTops.push(baseRows[index].top - sourceFootprint);
    } else {
      const lastBaseRow = baseRows.at(-1);
      boundaryTops.push(lastBaseRow.bottom - sourceFootprint + trailingGap);
    }
  }

  if (boundaryTops.some((top, index) => (
    !Number.isFinite(top)
    || (index > 0 && top < boundaryTops[index - 1])
  ))) return [];
  return boundaryTops;
}

/** Offset of the clicked row inside the compacted moving forest. */
export function forestAnchorOffset({ rows = [], sourceIds = [], anchorId } = {}) {
  const sources = new Set(sourceIds);
  const gaps = rows.slice(0, -1).map((row, index) => rows[index + 1].top - row.bottom)
    .filter(gap => gap >= 0).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)] || 0;
  let offset = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.id === anchorId) return offset;
    if (sources.has(row.id)) offset += (rows[index + 1]?.top ?? row.bottom + gap) - row.top;
  }
  return offset;
}

export function boundaryFromGeometry({
  sourceTop,
  boundaryTops = [],
  fallbackBoundary = 0,
} = {}) {
  if (!Number.isFinite(sourceTop) || boundaryTops.length === 0) {
    return Math.max(0, Math.trunc(Number(fallbackBoundary) || 0));
  }
  if (boundaryTops.length === 1) return 0;

  for (let index = 0; index < boundaryTops.length - 1; index += 1) {
    const threshold = (boundaryTops[index] + boundaryTops[index + 1]) / 2;
    if (sourceTop < threshold) return index;
  }
  return boundaryTops.length - 1;
}

export function horizontalIntent({
  clientX,
  baseX,
  threshold = HORIZONTAL_THRESHOLD,
  previewStart = HORIZONTAL_PREVIEW_START,
} = {}) {
  const deltaX = clientX - baseX;
  const distance = Math.abs(deltaX);
  if (distance < previewStart) {
    return {
      direction: null,
      deltaX,
      progress: 0,
      crossed: false,
    };
  }
  return {
    direction: deltaX < 0 ? 'left' : 'right',
    deltaX,
    progress: Math.min(1, distance / threshold),
    crossed: distance >= threshold,
  };
}

export function edgeScrollVelocity({
  clientY,
  top,
  bottom,
  zoneSize = EDGE_ZONE_SIZE,
  maxStep = MAX_SCROLL_STEP,
} = {}) {
  if (clientY < top + zoneSize) {
    const pressure = Math.max(0, Math.min(1, (top + zoneSize - clientY) / zoneSize));
    return -Math.max(1, Math.round(maxStep * pressure));
  }
  if (clientY > bottom - zoneSize) {
    const pressure = Math.max(0, Math.min(1, (clientY - (bottom - zoneSize)) / zoneSize));
    return Math.max(1, Math.round(maxStep * pressure));
  }
  return 0;
}

export function edgeZoneFromPointer({
  clientY,
  top,
  bottom,
  zoneSize = EDGE_ZONE_SIZE,
} = {}) {
  if (clientY < top + zoneSize) return 'top';
  if (clientY > bottom - zoneSize) return 'bottom';
  return null;
}

export function createEdgeGesture({ clientY, top, bottom, zoneSize } = {}) {
  return {
    zone: edgeZoneFromPointer({ clientY, top, bottom, zoneSize }),
    active: false,
    anchorY: clientY,
  };
}

export function updateEdgeGesture(gesture, {
  clientY,
  top,
  bottom,
  zoneSize,
  activationDistance = EDGE_ACTIVATION_DISTANCE,
} = {}) {
  const zone = edgeZoneFromPointer({ clientY, top, bottom, zoneSize });
  const current = gesture || { zone: null, active: false, anchorY: clientY };

  if (zone !== current.zone) {
    return {
      zone,
      active: zone != null,
      anchorY: clientY,
    };
  }
  if (!zone) return { zone: null, active: false, anchorY: clientY };

  if (current.active) {
    const inwardDistance = zone === 'bottom'
      ? current.anchorY - clientY
      : clientY - current.anchorY;
    if (inwardDistance >= activationDistance) {
      return { zone, active: false, anchorY: clientY };
    }
    return {
      zone,
      active: true,
      anchorY: zone === 'bottom'
        ? Math.max(current.anchorY, clientY)
        : Math.min(current.anchorY, clientY),
    };
  }

  const edgewardDistance = zone === 'bottom'
    ? clientY - current.anchorY
    : current.anchorY - clientY;
  if (edgewardDistance >= activationDistance) {
    return { zone, active: true, anchorY: clientY };
  }
  return {
    zone,
    active: false,
    anchorY: zone === 'bottom'
      ? Math.min(current.anchorY, clientY)
      : Math.max(current.anchorY, clientY),
  };
}

export function advanceCollapsibleDwell(dwell, {
  targetId,
  blocked = false,
  now = 0,
  interval = COLLAPSIBLE_DWELL_INTERVAL,
} = {}) {
  if (targetId == null) return { dwell: null, shouldToggle: false };

  if (!dwell || dwell.targetId !== targetId || dwell.blocked !== blocked) {
    return {
      dwell: {
        targetId,
        blocked,
        startedAt: now,
        progress: 0,
        cycle: 0,
      },
      shouldToggle: false,
    };
  }

  if (blocked) {
    return {
      dwell: {
        ...dwell,
        startedAt: now,
        progress: 0,
      },
      shouldToggle: false,
    };
  }

  const numericInterval = Number(interval);
  const duration = numericInterval > 0 ? numericInterval : COLLAPSIBLE_DWELL_INTERVAL;
  const elapsed = Math.max(0, now - dwell.startedAt);
  if (elapsed < duration) {
    return {
      dwell: {
        ...dwell,
        progress: elapsed / duration,
      },
      shouldToggle: false,
    };
  }

  return {
    dwell: {
      ...dwell,
      startedAt: now,
      progress: 0,
      cycle: dwell.cycle + 1,
    },
    shouldToggle: true,
  };
}
