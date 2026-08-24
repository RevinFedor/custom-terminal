const finiteOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const HISTORY_TERMINAL_PREVIEW_LIVE_LABEL =
  'Live response · not yet saved to history';
export const HISTORY_TERMINAL_PREVIEW_SYNC_LABEL =
  'Live response · synchronizing view';

export function historyTerminalPreviewStatusLabel({ canonicalMaterialized = false } = {}) {
  return canonicalMaterialized
    ? HISTORY_TERMINAL_PREVIEW_SYNC_LABEL
    : HISTORY_TERMINAL_PREVIEW_LIVE_LABEL;
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
    const duplicate = identitiesForEntry(entry).includes(identity);
    if (duplicate) changed = true;
    return !duplicate;
  });
  return changed ? filtered : liveEntries;
}

export function historyTerminalPreviewHandoffAction({
  handoff = null,
  ownsWrite = false,
  canonicalTarget = null,
  targetMounted = false,
} = {}) {
  if (!handoff) return 'idle';
  if (!ownsWrite) return 'stale';
  if (!canonicalTarget) return 'waiting-canonical';
  if (!targetMounted) return 'waiting-mounted-range';
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
    identitiesForEntry(entry).includes(identity)
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
  if (!unitEntries.some((entry) => identitiesForEntry(entry).includes(identity))) {
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
  bottomGapPx = null,
} = {}) {
  const currentTop = Math.max(0, finiteOrNull(scrollTop) ?? 0);
  const maxTop = Math.max(
    0,
    (finiteOrNull(scrollHeight) ?? 0) - (finiteOrNull(clientHeight) ?? 0),
  );
  const targetOffset = finiteOrNull(targetOffsetPx);
  const anchorOffset = finiteOrNull(anchorOffsetPx);
  if (targetOffset !== null && anchorOffset !== null) {
    return Math.min(maxTop, Math.max(0, currentTop + targetOffset - anchorOffset));
  }
  const bottomGap = finiteOrNull(bottomGapPx);
  if (bottomGap !== null) {
    return Math.min(maxTop, Math.max(0, maxTop - Math.max(0, bottomGap)));
  }
  return Math.min(maxTop, currentTop);
}
