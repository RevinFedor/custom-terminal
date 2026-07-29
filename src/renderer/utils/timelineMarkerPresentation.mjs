export function collectTimelineDocs(entries) {
  const edited = new Set();
  const searched = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const file of Array.isArray(entry?.docsEdited) ? entry.docsEdited : []) {
      if (typeof file === 'string' && file.trim()) edited.add(file);
    }
    for (const query of Array.isArray(entry?.docsSearchQueries) ? entry.docsSearchQueries : []) {
      if (typeof query === 'string' && query.trim()) searched.add(query);
    }
    if (entry?.type === 'docs_edit' && typeof entry.content === 'string' && entry.content.trim()) {
      edited.add(entry.content);
    }
    if (entry?.type === 'docs_search' && typeof entry.content === 'string' && entry.content.trim()) {
      searched.add(entry.content);
    }
  }

  return { edited: [...edited], searched: [...searched] };
}

export function isTimelineGroupExpanded(isExpandedLayout, requestedExpanded) {
  return isExpandedLayout === true && requestedExpanded === true;
}

const markerGeometryCache = new Map();

export function timelineMarkerGeometry({
  isOrchestration,
  displaysAsCompact,
  showAsChild,
  isHovered,
  isInViewport,
}) {
  const cacheKey = [
    isOrchestration,
    displaysAsCompact,
    showAsChild,
    isHovered,
    isInViewport,
  ].map(Boolean).map(Number).join('');
  const cached = markerGeometryCache.get(cacheKey);
  if (cached) return cached;

  if (isOrchestration) {
    const side = isHovered ? 10 : showAsChild ? 7 : isInViewport ? 8 : 6;
    const geometry = { width: `${side}px`, height: `${side}px`, radius: '2px' };
    markerGeometryCache.set(cacheKey, geometry);
    return geometry;
  }

  const geometry = {
    width: displaysAsCompact
      ? (isHovered ? '10px' : '7px')
      : showAsChild
        ? (isHovered ? '8px' : (isInViewport ? '8px' : '4px'))
        : (isHovered ? '10px' : (isInViewport ? '10px' : '5px')),
    height: displaysAsCompact
      ? (isHovered ? '10px' : '7px')
      : showAsChild
        ? (isHovered ? '8px' : (isInViewport ? '3px' : '4px'))
        : (isHovered ? '10px' : (isInViewport ? '3px' : '5px')),
    radius: displaysAsCompact ? '50%' : (isInViewport && !isHovered ? '1px' : '50%'),
  };
  markerGeometryCache.set(cacheKey, geometry);
  return geometry;
}

const cornerBadgeCache = new Map();

export function buildTimelineCornerBadges({
  isLoop = false,
  docsEditedCount = 0,
  docsSearchCount = 0,
  collapsedGroupSize = 0,
} = {}) {
  const count = collapsedGroupSize > 1 ? String(collapsedGroupSize) : null;
  const cacheKey = `${isLoop ? 1 : 0}${docsEditedCount > 0 ? 1 : 0}${docsSearchCount > 0 ? 1 : 0}:${count || ''}`;
  const cached = cornerBadgeCache.get(cacheKey);
  if (cached) return cached;

  const icons = [];
  if (isLoop) icons.push('loop');
  if (docsEditedCount > 0) icons.push('docs-edit');
  if (docsSearchCount > 0) icons.push('docs-search');

  const items = [];
  if (icons[0]) items.push({ kind: icons[0], slot: 'top-right' });
  if (count) {
    items.push({ kind: 'count', slot: 'bottom-right', text: count });
  } else if (icons[1]) {
    items.push({ kind: icons[1], slot: 'bottom-right' });
  }
  const remainingIcons = icons.slice(count ? 1 : 2);
  const remainingSlots = ['top-left', 'bottom-left'];
  remainingIcons.forEach((kind, index) => {
    if (remainingSlots[index]) items.push({ kind, slot: remainingSlots[index] });
  });

  const result = {
    icons,
    count,
    items,
  };
  cornerBadgeCache.set(cacheKey, result);
  return result;
}
