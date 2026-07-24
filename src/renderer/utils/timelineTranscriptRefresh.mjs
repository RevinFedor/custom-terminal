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
