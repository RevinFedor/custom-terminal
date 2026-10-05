import { pickHistoryGestureAnchorCandidate } from './historyGestureAnchor.mjs';

const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const HISTORY_TERMINAL_PREVIEW_LIVE_LABEL =
  'Live response · not yet saved to history';
export const HISTORY_TERMINAL_PREVIEW_SYNC_LABEL =
  'Response · synchronizing view';
export const HISTORY_TERMINAL_PREVIEW_UNCONFIRMED_LABEL =
  'Response · history not confirmed';

export function historyTerminalPreviewStatusLabel({
  canonicalMaterialized = false, phase = 'streaming', deliveryState = 'pending',
} = {}) {
  if (canonicalMaterialized) return HISTORY_TERMINAL_PREVIEW_SYNC_LABEL;
  return phase === 'settled' || deliveryState === 'unknown'
    ? HISTORY_TERMINAL_PREVIEW_UNCONFIRMED_LABEL : HISTORY_TERMINAL_PREVIEW_LIVE_LABEL;
}

export function historyTerminalPreviewHandoffOwnsWrite(handoff, {
  ownerKey = '',
  ownerGeneration = 0,
  presentationVisit = 0,
  presented = false,
} = {}) {
  return !!handoff
    && handoff.ownerKey === ownerKey
    && Number(handoff.ownerGeneration) === Number(ownerGeneration)
    && Number(handoff.presentationVisit) === Number(presentationVisit)
    && presented === true;
}

// A receipt can outlive a renderer data-owner generation (e.g. a hidden
// durable refresh). Do not let the old transaction write into the new scope;
// admit a NEW transaction only on exact canonical data and integrity proof.
export function historyTerminalPreviewHandoffRebaseVerdict(handoff, {
  previewId = '', ownerKey = '', ownerGeneration = 0, presentationVisit = 0,
  presented = false, canonicalInPresentation = false, canonicalTextHash = null,
} = {}) {
  if (!handoff) return 'idle';
  if (handoff.ownerKey !== ownerKey) return 'foreign-owner';
  if ((previewId && handoff.previewId !== previewId)
    || (!previewId && handoff.phase === 'waiting-row')) return 'foreign-preview';
  const generationChanged = Number(handoff.ownerGeneration) !== Number(ownerGeneration);
  if (!generationChanged && Number(handoff.presentationVisit) === Number(presentationVisit)) return 'current';
  if (!presented) return 'hidden';
  if (!canonicalInPresentation) return 'waiting-canonical';
  // Codex source offsets are positional: a replacement document can reuse
  // one. The receipt's exact full-record hash is an ADDITIONAL guard after
  // identity, never a way to join different records by prose.
  if ((generationChanged && String(handoff.canonicalIdentity).startsWith('codex-assistant-source-')
      && !handoff.canonicalTextHash)
    || (handoff.canonicalTextHash && canonicalTextHash !== handoff.canonicalTextHash)) {
    return 'waiting-canonical-integrity';
  }
  return 'rebase';
}

export function historyTerminalPreviewHandoffCoversPreview(handoff, preview) {
  if (!handoff || handoff.previewId !== preview?.previewId) return false;
  if (!Array.isArray(handoff.previewItemIds) || !Array.isArray(preview.responseSegments)) return true;
  const covered = new Set(handoff.previewItemIds);
  return preview.responseSegments.every(segment => covered.has(segment.itemId));
}

export function historyTerminalPreviewHasNewUserGesture(handoff, {
  gestureGeneration = 0,
  gestureAt = 0,
  pointerActive = false,
} = {}) {
  if (pointerActive) return true;
  if (!handoff) return false;
  // Generation alone is not a physical input proof: a stale/concurrent render
  // can carry an older transaction generation. The timestamp is advanced only
  // by wheel/touch/scroll-key/native-scrollbar intent, so both facts must move
  // before layout is allowed to replace the reader's saved anchor.
  return Number(gestureGeneration) !== Number(handoff.gestureGeneration)
    && Number(gestureAt) > Number(handoff.gestureAt || 0);
}

export function historyTerminalPreviewHandoffAnchor({
  followBottom = false,
  previewOffsetPx = null,
  previewHeightPx = null,
  viewportHeightPx = null,
  readingRows = [],
} = {}) {
  const stationary = {
    anchorKind: 'stationary', readingUnitKey: null,
    anchorOffsetPx: null, bottomGapPx: null,
  };
  if (followBottom) return { ...stationary, anchorKind: 'tail', bottomGapPx: 0 };
  const previewOffset = finiteOrNull(previewOffsetPx);
  const previewHeight = finiteOrNull(previewHeightPx);
  const previewIdentity = '\u0000terminal-preview';
  const candidates = Array.isArray(readingRows) ? [...readingRows] : [];
  if (previewOffset !== null && previewHeight !== null && previewHeight > 0) {
    candidates.push({ identity: previewIdentity, top: previewOffset, bottom: previewOffset + previewHeight });
  }
  // The same reading-area selection as ordinary History geometry. Being away
  // from the tail is not proof that the reader is looking at the preview.
  const chosen = pickHistoryGestureAnchorCandidate(candidates, 0, viewportHeightPx);
  if (!chosen) return stationary;
  return {
    anchorKind: chosen.identity === previewIdentity ? 'preview' : 'reading-row',
    readingUnitKey: chosen.identity === previewIdentity ? null : chosen.identity,
    anchorOffsetPx: Number(chosen.top),
    bottomGapPx: null,
  };
}

// Capture from committed DOM identity, not the next render's index map: an
// inserted canonical row can change that map before Virtuoso updates its DOM.
export function captureHistoryTerminalPreviewHandoffAnchor({ scroller, previewNode, followBottom = false } = {}) {
  if (followBottom || !scroller) return historyTerminalPreviewHandoffAnchor({ followBottom });
  const viewport = scroller.getBoundingClientRect();
  const preview = previewNode?.getBoundingClientRect();
  const readingRows = Array.from(scroller.querySelectorAll('[data-item-index]')).flatMap((wrapper) => {
    const row = wrapper.querySelector('[data-history-row-real][data-history-unit-key]');
    const identity = row?.getAttribute('data-history-unit-key');
    if (!identity) return [];
    const rect = wrapper.getBoundingClientRect();
    return [{ identity, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top }];
  });
  return historyTerminalPreviewHandoffAnchor({
    followBottom, readingRows, viewportHeightPx: scroller.clientHeight,
    previewOffsetPx: preview ? preview.top - viewport.top : null,
    previewHeightPx: preview?.height ?? null,
  });
}

export function readHistoryTerminalPreviewReadingTop(scroller, readingUnitKey) {
  if (!scroller?.isConnected || !readingUnitKey) return null;
  const row = Array.from(scroller.querySelectorAll('[data-history-row-real][data-history-unit-key]'))
    .find((node) => node.getAttribute('data-history-unit-key') === readingUnitKey);
  if (!row) return null;
  const wrapper = row.closest('[data-item-index]');
  if (!wrapper || !scroller.contains(wrapper)) return null;
  return wrapper.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

// Main's native Claude receipt carries the JSONL UUID. History wraps that
// same UUID in assistant-uuid: for live/durable reconciliation. Accept both
// exact representations at this boundary without changing global row keys,
// comparing text, or treating an arbitrary user UUID as an assistant receipt.
export function historyTerminalPreviewHasCanonicalIdentity(entry, identity, identitiesForEntry = () => []) {
  const canonical = String(identity || '');
  if (!canonical) return false;
  const identities = identitiesForEntry(entry);
  if (identities.includes(canonical)) return true;
  return entry?.role === 'assistant' && (
    String(entry.uuid || '') === canonical
    || identities.includes('assistant-uuid:' + canonical)
  );
}

export function filterHistoryTerminalPreviewLiveDuplicate({
  liveEntries = [],
  canonicalIdentity = '',
  identitiesForEntry = () => [],
} = {}) {
  const identity = String(canonicalIdentity || '');
  if (!identity || !Array.isArray(liveEntries) || liveEntries.length === 0) {
    return liveEntries;
  }
  let changed = false;
  const filtered = liveEntries.filter((entry) => {
    const duplicate = historyTerminalPreviewHasCanonicalIdentity(entry, identity, identitiesForEntry);
    if (duplicate) changed = true;
    return !duplicate;
  });
  return changed ? filtered : liveEntries;
}

export function historyTerminalPreviewHandoffAction({
  handoff = null,
  ownsWrite = false,
  canonicalTarget = null,
  canonicalInPresentation = false,
  targetMounted = false,
} = {}) {
  if (!handoff) return 'idle';
  if (!ownsWrite) return 'stale';
  const needsCanonicalNode = (handoff.anchorKind ?? (handoff.followBottom ? 'tail' : 'preview')) === 'preview';
  if (
    !canonicalTarget
    && (needsCanonicalNode || canonicalInPresentation !== true)
  ) return 'waiting-canonical';
  // A reader of another row has no reason to wait for off-screen canonical
  // DOM. Only reading the preview itself requires its replacement's geometry.
  if (!targetMounted && needsCanonicalNode) return 'waiting-mounted-range';
  if (handoff.phase === 'settling-row') return 'settling';
  return handoff.phase === 'clearing-preview' ? 'start-settle' : 'clear-preview';
}

/**
 * Resolve one exact durable identity through the entry projection and the
 * final grouped Virtuoso projection. A collapsed group has no DOM row for
 * each member; its header is the mounted presentation unit for every exact
 * member identity it contains.
 */
export function resolveHistoryTerminalPreviewCanonicalTarget({
  canonicalIdentity = '',
  displayEntries = [],
  displayUnits = [],
  unitIndexByUuid = new Map(),
  identitiesForEntry = () => [],
} = {}) {
  const identity = String(canonicalIdentity || '');
  if (!identity) return null;
  const canonicalEntry = displayEntries.find((entry) => (
    historyTerminalPreviewHasCanonicalIdentity(entry, identity, identitiesForEntry)
  ));
  const canonicalUuid = String(canonicalEntry?.uuid || '');
  if (!canonicalUuid) return null;
  const unitIndex = unitIndexByUuid.get(canonicalUuid);
  if (!Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex >= displayUnits.length) {
    return null;
  }
  const unit = displayUnits[unitIndex];
  const unitEntries = unit?.kind === 'group'
    ? (Array.isArray(unit.entries) ? unit.entries : [])
    : unit?.entry
      ? [unit.entry]
      : [];
  if (!unitEntries.some((entry) => historyTerminalPreviewHasCanonicalIdentity(entry, identity, identitiesForEntry))) {
    return null;
  }
  if (unit?.kind === 'group') {
    const domUuid = String(unitEntries[0]?.uuid || '');
    if (!domUuid) return null;
    return {
      canonicalUuid,
      unitIndex,
      domUuid,
      groupKey: String(unit.key || ''),
      presentationKind: 'group',
    };
  }
  const domUuid = String(unit?.entry?.uuid || '');
  if (!domUuid) return null;
  return {
    canonicalUuid,
    unitIndex,
    domUuid,
    groupKey: null,
    presentationKind: 'entry',
  };
}

/**
 * Preserve one semantic row's viewport offset while a provisional Footer is
 * replaced by its canonical data row. The DOM writer still applies the result;
 * this rule is pure so the two pre-paint phases cannot drift apart.
 */
export function historyTerminalPreviewHandoffScrollTop({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  targetOffsetPx = null,
  anchorOffsetPx = null,
  anchorKind = 'stationary',
} = {}) {
  const currentTop = Math.max(0, finiteOrNull(scrollTop) ?? 0);
  const maxTop = Math.max(
    0,
    (finiteOrNull(scrollHeight) ?? 0) - (finiteOrNull(clientHeight) ?? 0),
  );
  const targetOffset = finiteOrNull(targetOffsetPx);
  const anchorOffset = finiteOrNull(anchorOffsetPx);
  if (anchorKind === 'tail') return maxTop;
  if (anchorKind !== 'stationary' && targetOffset !== null && anchorOffset !== null) {
    return Math.min(maxTop, Math.max(0, currentTop + targetOffset - anchorOffset));
  }
  // Missing row geometry never silently becomes bottom ownership.
  return Math.min(maxTop, currentTop);
}
