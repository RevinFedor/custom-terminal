// Only currently awaited recovery reads subscribe here. There is no persistent
// revision table or retained draft copy for every tab. Exact writer notification
// distinguishes same-text writes and clear/retype ABA within one Date.now tick.
const activeReaders = new WeakMap();

export function noteHistoryComposerDraftWrite(store, tabId) {
  const readers = activeReaders.get(store)?.get(tabId);
  if (readers) for (const invalidate of readers) invalidate();
}

const selectOwner = (state, tabId) => [
  state.historyPromptDrafts?.[tabId],
  state.historyPromptDraftImages?.[tabId],
  state.historyPromptDraftChips?.[tabId],
  state.historyPromptDraftPendingImages?.[tabId],
  state.historyPromptDraftUpdatedAt?.[tabId],
  state.historyPromptReturnedSends?.[tabId],
  state.promptQueueInputSurfaceTabs?.[tabId],
  state.historyRewindPreviews?.[tabId],
  state.historyComposerAvailability?.[tabId],
  state.promptPickerOpen,
];

export function captureHistoryComposerDraftOwner({ store, tabId }) {
  if (!store || typeof store.getState !== 'function' || typeof store.subscribe !== 'function'
    || typeof tabId !== 'string' || !tabId) throw new TypeError('exact composer owner required');
  const captured = selectOwner(store.getState(), tabId);
  let current = true;
  let disposed = false;
  const invalidate = () => { current = false; };
  let tabs = activeReaders.get(store);
  if (!tabs) { tabs = new Map(); activeReaders.set(store, tabs); }
  let readers = tabs.get(tabId);
  if (!readers) { readers = new Set(); tabs.set(tabId, readers); }
  readers.add(invalidate);
  const unchanged = state => selectOwner(state, tabId).every((value, index) => Object.is(value, captured[index]));
  const unsubscribe = store.subscribe(state => { if (!unchanged(state)) invalidate(); });
  return {
    isCurrent: () => !disposed && current && unchanged(store.getState()),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      readers.delete(invalidate);
      if (readers.size === 0) tabs.delete(tabId);
      if (tabs.size === 0) activeReaders.delete(store);
    },
  };
}
