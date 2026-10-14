export const COMPOSER_VIEW_STATE_LIMIT = 200;

export function normalizeComposerViewState(value) {
  if (!value || typeof value !== 'object') return null;
  const start = Number(value.selectionStart);
  const end = Number(value.selectionEnd);
  const scrollTop = Number(value.scrollTop);
  const updatedAt = Number(value.updatedAt);
  if (!Number.isFinite(start) || start < 0
      || !Number.isFinite(end) || end < 0
      || !Number.isFinite(scrollTop) || scrollTop < 0) return null;
  const normalized = {
    selectionStart: Math.floor(start),
    selectionEnd: Math.floor(end),
    scrollTop,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
  };
  const { selectionAnchor, selectionHead } = value;
  if (Number.isSafeInteger(selectionAnchor) && selectionAnchor >= 0
      && Number.isSafeInteger(selectionHead) && selectionHead >= 0
      && Math.min(selectionAnchor, selectionHead) === Math.min(normalized.selectionStart, normalized.selectionEnd)
      && Math.max(selectionAnchor, selectionHead) === Math.max(normalized.selectionStart, normalized.selectionEnd)) {
    normalized.selectionAnchor = selectionAnchor;
    normalized.selectionHead = selectionHead;
  }
  return normalized;
}

export function readComposerViewMemory(value) {
  if (!value || typeof value !== 'object') return {};
  const entries = [];
  for (const [tabId, candidate] of Object.entries(value)) {
    const normalized = normalizeComposerViewState(candidate);
    if (tabId && normalized) entries.push([tabId, normalized]);
  }
  entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  return Object.fromEntries(entries.slice(-COMPOSER_VIEW_STATE_LIMIT));
}

export function rememberComposerView(memory, tabId, patch, now = Date.now()) {
  if (!tabId) return memory || {};
  const current = normalizeComposerViewState(memory?.[tabId]) || {
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    updatedAt: 0,
  };
  const candidate = {
    ...current,
    updatedAt: now,
  };
  // Selection patches must supply their own complete direction pair, even
  // when the range is unchanged. Scroll-only patches preserve the saved pair.
  const selectionFields = ['selectionStart', 'selectionEnd', 'selectionAnchor', 'selectionHead'];
  if (selectionFields.some(field => Object.prototype.hasOwnProperty.call(patch || {}, field))) {
    delete candidate.selectionAnchor;
    delete candidate.selectionHead;
  }
  const nextValue = normalizeComposerViewState({ ...candidate, ...patch, updatedAt: now });
  if (!nextValue) return memory || {};
  if (current.selectionStart === nextValue.selectionStart
      && current.selectionEnd === nextValue.selectionEnd
      && current.selectionAnchor === nextValue.selectionAnchor
      && current.selectionHead === nextValue.selectionHead
      && current.scrollTop === nextValue.scrollTop) return memory || {};
  return readComposerViewMemory({ ...(memory || {}), [tabId]: nextValue });
}

/**
 * A shared ComposerEditor instance briefly reports its transitional selection
 * and scroll while React swaps the document to another tab. Those events do
 * not belong to either authored view state and must not overwrite the snapshot
 * that the host is about to restore.
 */
export function shouldRecordComposerViewEvent(eventTabId, activeTabId, restoringTabId = null) {
  return Boolean(
    eventTabId
    && eventTabId === activeTabId
    && restoringTabId !== eventTabId,
  );
}
