/**
 * Keeps one trailing transcript refresh until both the turn and the Timeline
 * surface are ready. An invalidation is never consumed merely because its
 * surface is currently hidden.
 */
export function planTimelineTranscriptRefresh({
  pending = false,
  invalidation = false,
  isTurnBusy = false,
  documentVisible = true,
  surfaceVisible = true,
} = {}) {
  const nextPending = pending || invalidation;
  const refresh = nextPending
    && !isTurnBusy
    && documentVisible
    && surfaceVisible;
  return {
    pending: refresh ? false : nextPending,
    refresh,
  };
}

/**
 * A primary History surface and its Timeline are siblings. During an owner
 * switch Timeline may hydrate its cached rail only after History proves that
 * the same tab/session/tool has reached a painted presentation boundary.
 * Matching every identity field prevents a late event from the previous tab
 * from releasing the next owner's heavier render.
 */
export function matchesHistorySurfacePresented({
  detail,
  tabId,
  sessionId,
  toolType,
} = {}) {
  if (!detail || typeof detail !== 'object') return false;
  return detail.tabId === tabId
    && (detail.sessionId || null) === (sessionId || null)
    && detail.toolType === toolType;
}
