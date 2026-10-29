// Request strength belongs to the existing History flight, not another queue.
export function normalizeHistoryPrimaryRequestClass(value) {
  return value === 'view' || value === 'semantic' ? value : 'source';
}

export function mergeHistoryPrimaryRequestClass(pending, requested) {
  const next = normalizeHistoryPrimaryRequestClass(requested);
  if (pending == null) return next;
  const prior = normalizeHistoryPrimaryRequestClass(pending);
  return prior === 'source' || next === 'source' ? 'source'
    : prior === 'semantic' || next === 'semantic' ? 'semantic' : 'view';
}

// Local authoring, live payloads/results and Rewind are externally owned. Their
// nested immutability is not certified by UUID/count or an array reference.
// For now, only their absence proves that a view can retain the semantic bundle.
// Settings pairs are panel-owned copies of primitive strings, replaced on change.
export function historyPrimaryViewInputsReusable(applied, current, suppressions) {
  if (!applied || !current || suppressions?.size !== 0) return false;
  for (const value of [applied, current]) {
    if (!Array.isArray(value.localEntries) || value.localEntries.length
      || !Array.isArray(value.liveEntries) || value.liveEntries.length
      || !Array.isArray(value.settingsPresentationKeys)
      || (value.liveToolResults != null && value.liveToolResults.size !== 0) || value.rewindPreview) return false;
  }
  return applied.settingsPresentationKeys === current.settingsPresentationKeys;
}

export function historyPrimaryCompositionRequestClass(applied, current, suppressions, header, appliedSuppressionCount) {
  return header?.metadataSchema === 1 && typeof header.semanticIdentity === 'string' && header.semanticIdentity
    && typeof header.metadataIdentity === 'string' && header.metadataIdentity
    && appliedSuppressionCount === 0
    && historyPrimaryViewInputsReusable(applied, current, suppressions) ? 'view' : 'semantic';
}

export function historyPrimaryRequestPayload(address, requestClass, presentation, suppressions, header) {
  const primaryRequestClass = normalizeHistoryPrimaryRequestClass(requestClass);
  if (primaryRequestClass === 'view') {
    return { ...address, primaryRequestClass,
      localRootLease: { leaseId: header.leaseId, ownerKey: header.ownerKey,
        revision: header.revision, generation: header.generation },
      expectedSemanticIdentity: header.semanticIdentity,
      primaryViewOptions: { grouping: presentation.grouping, captionSelections: presentation.captionSelections } };
  }
  return { ...address, primaryRequestClass, primaryPresentation: presentation,
    primaryPresentationOnly: primaryRequestClass === 'semantic', suppressions: Array.from(suppressions.values()) };
}
