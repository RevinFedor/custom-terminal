import { historyEntryHasExactIdentity } from './historyPromptPresentation.mjs';

const TIMELINE_SENT_HANDOFF_PREVIEW_MAX_CHARS = 2048;

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

function timelineSentHandoffPreview(value) {
  const text = String(value || '').trim();
  if (text.length <= TIMELINE_SENT_HANDOFF_PREVIEW_MAX_CHARS) return text;
  return text.slice(0, TIMELINE_SENT_HANDOFF_PREVIEW_MAX_CHARS).trimEnd() + '\n…';
}

function timelineEntryMatchesSentHandoff(entry, handoffEntry) {
  if (historyEntryHasExactIdentity(entry, handoffEntry?.uuid)) return true;
  return historyEntryHasExactIdentity(entry, handoffEntry?.sourceIdentity);
}

/**
 * A confirmed History send already owns an exact durable user record even
 * while Timeline's expensive transcript refresh remains deferred by a busy
 * turn. Project only that one addressable point; never infer it from text or
 * timestamps and never project queue/provider acceptance without audit proof.
 */
export function projectTimelineSentHandoff(handoff, {
  toolType,
  sessionId,
} = {}) {
  if (!handoff || handoff.queueStatus !== 'sent') return null;
  if (handoff.toolType !== toolType) return null;
  const proof = handoff.auditProof;
  if (!proof || typeof proof !== 'object') return null;
  const exactSessionId = String(proof.sessionId || '').trim();
  const currentSessionId = String(sessionId || '').trim();
  if (!exactSessionId || !currentSessionId || exactSessionId !== currentSessionId) return null;

  // Timeline actions address the canonical row by UUID. Source identity is
  // retained for response_item → event_msg alias reconciliation, but it is not
  // converted into a made-up UUID when an older receipt lacks that address.
  const entryUuid = String(proof.entryUuid || '').trim();
  if (!entryUuid) return null;
  const sourceIdentity = String(proof.sourceIdentity || '').trim();
  const submittedAt = Number(handoff.submittedAt);
  const timestamp = String(proof.auditTimestamp || '').trim()
    || new Date(Number.isFinite(submittedAt) ? submittedAt : Date.now()).toISOString();
  const semanticTags = handoff.source === 'prompt-loop'
    ? [{ kind: 'prompt-origin', source: 'loop' }]
    : undefined;

  return {
    uuid: entryUuid,
    type: 'user',
    timestamp,
    content: timelineSentHandoffPreview(handoff.text),
    sessionId: exactSessionId,
    hasImage: Array.isArray(handoff.imagePaths) && handoff.imagePaths.length > 0,
    handoffId: String(handoff.handoffId || ''),
    isSentHandoffProjection: true,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    ...(semanticTags ? { semanticTags } : {}),
  };
}

export function projectTimelineSentHandoffs(handoffs, owner = {}) {
  if (!Array.isArray(handoffs)) return [];
  return handoffs
    .map((handoff) => projectTimelineSentHandoff(handoff, owner))
    .filter(Boolean);
}

/** Keep captured SENT points after History consumes its local card. */
export function upsertTimelineSentHandoffEntries(current, incoming) {
  const next = Array.isArray(current) ? [...current] : [];
  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    if (!candidate?.handoffId) continue;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (next[index]?.handoffId === candidate.handoffId
        || timelineEntryMatchesSentHandoff(next[index], candidate)) {
        next.splice(index, 1);
      }
    }
    next.push(candidate);
  }
  next.sort((left, right) => {
    const timeDelta = Date.parse(left?.timestamp || '') - Date.parse(right?.timestamp || '');
    if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
    return String(left?.handoffId || '').localeCompare(String(right?.handoffId || ''));
  });
  return next;
}

export function retainUnmaterializedTimelineSentHandoffs(canonicalEntries, handoffEntries) {
  const canonical = Array.isArray(canonicalEntries) ? canonicalEntries : [];
  return upsertTimelineSentHandoffEntries([], handoffEntries)
    .filter((handoffEntry) => !canonical.some((entry) => (
      timelineEntryMatchesSentHandoff(entry, handoffEntry)
    )));
}

/**
 * Canonical transcript rows always win. UUID/source aliases remove the light
 * point in the same render, so the later durable refresh cannot create a
 * duplicate even when a response_item was promoted to event_msg.
 */
export function mergeTimelineEntriesWithSentHandoffs(canonicalEntries, handoffEntries) {
  const canonical = Array.isArray(canonicalEntries) ? canonicalEntries : [];
  const projected = retainUnmaterializedTimelineSentHandoffs(canonical, handoffEntries);
  return projected.length > 0 ? [...canonical, ...projected] : canonical;
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
