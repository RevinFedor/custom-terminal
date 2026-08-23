// Renderer-only presentation cache. A durable tab that has once owned a pane
// keeps that exact pane placement while it is temporarily absent from every
// live/dormant layout. The workspace model remains the source of truth for
// where a tab is SHOWN; this cache answers only which stable React parent and
// geometry keep its already-warmed Terminal/History/Timeline alive.

export function resolveRetainedTabPanePlacement(cache, tabId, livePlacement, enabled = true) {
  if (!enabled || !tabId) return null;
  if (livePlacement) {
    cache.set(tabId, livePlacement);
    return livePlacement;
  }
  return cache.get(tabId) || null;
}

export function pruneRetainedTabPanePlacements(cache, liveTabIds) {
  let removed = 0;
  for (const tabId of cache.keys()) {
    if (liveTabIds.has(tabId)) continue;
    cache.delete(tabId);
    removed += 1;
  }
  return removed;
}
