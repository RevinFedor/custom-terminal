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

/**
 * Replayable record of the LAST presented History surface per tab.
 *
 * The presentation proof is a one-shot window event, and Timeline releases
 * its gate by listening for it. A Timeline instance that MOUNTS after the
 * proof already fired (HMR remount, deferred owner handoff, any future
 * remount) subscribes to a bus that will stay silent — History is happily
 * on screen and has nothing new to announce — so the gate never opened, the
 * initial load never ran, and the panel expanded to a permanent
 * "Loading timeline…" with zero rows (live 05.08: WAVE_DONE entries=0 while
 * History showed the full session). Subscribe-after-publish needs a replay,
 * so the publisher also records the latest proof here and a fresh subscriber
 * checks it synchronously before waiting.
 *
 * Keyed by tabId only: a new presentation for the same tab overwrites the
 * previous one, so a stale (session/tool changed) record simply fails the
 * identity match and the subscriber falls back to waiting for the live event.
 */
const lastPresentedHistorySurfaceByTab = new Map();

export function recordHistorySurfacePresented(detail) {
  if (!detail || typeof detail !== 'object' || !detail.tabId) return;
  lastPresentedHistorySurfaceByTab.set(detail.tabId, {
    tabId: detail.tabId,
    sessionId: detail.sessionId || null,
    toolType: detail.toolType,
    proof: detail.proof || 'unknown',
  });
}

export function readPresentedHistorySurface({ tabId, sessionId, toolType } = {}) {
  const detail = lastPresentedHistorySurfaceByTab.get(tabId);
  if (!detail) return null;
  return matchesHistorySurfacePresented({ detail, tabId, sessionId, toolType })
    ? detail
    : null;
}

export function __resetPresentedHistorySurfacesForTest() {
  lastPresentedHistorySurfaceByTab.clear();
}
