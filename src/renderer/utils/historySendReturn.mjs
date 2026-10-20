import { mergeFailedHistoryAuthoringSnapshot } from './historyDraftOwnership.mjs';
import { buildComposerDraftMemory } from './composerDraftPersistence.mjs';

// Persist authoring and the exact adoption receipt in ONE existing draft
// envelope before publishing it to React. Retrying after reload cannot prepend
// the same handoff twice; storage failure keeps the original card/assets owned.
export function restoreHistorySendDraft(state, input, persist, now = Date.now()) {
  const { tabId, token, handoffId, text, images = [], chips = [] } = input;
  if (!tabId || !token || !handoffId || typeof text !== 'string') throw new Error('History return snapshot unavailable');
  if (state.historyPromptReturnedSends?.[tabId]?.includes(token)) {
    // Retry the same storage mirror after a lost/failed durable ACK, never the
    // prepend. The user may have edited the recovered draft in the meantime.
    persist(JSON.stringify(buildComposerDraftMemory({ drafts: state.historyPromptDrafts,
      images: state.historyPromptDraftImages, chips: state.historyPromptDraftChips,
      updatedAtByTab: state.historyPromptDraftUpdatedAt, returnedByTab: state.historyPromptReturnedSends })));
    return { adopted: false, patch: null };
  }
  const merged = mergeFailedHistoryAuthoringSnapshot({
    currentText: state.historyPromptDrafts[tabId] || '',
    currentImages: state.historyPromptDraftImages[tabId] || [],
    currentChips: state.historyPromptDraftChips[tabId] || [],
    currentPendingImages: state.historyPromptDraftPendingImages?.[tabId] || [],
    snapshotText: text, snapshotImages: images, snapshotChips: chips,
  });
  const patch = {
    historyPromptDrafts: { ...state.historyPromptDrafts, [tabId]: merged.text },
    historyPromptDraftImages: { ...state.historyPromptDraftImages, [tabId]: merged.images },
    historyPromptDraftChips: { ...state.historyPromptDraftChips, [tabId]: merged.chips },
    historyPromptDraftPendingImages: { ...state.historyPromptDraftPendingImages, [tabId]: merged.pendingImages },
    historyPromptDraftUpdatedAt: { ...state.historyPromptDraftUpdatedAt, [tabId]: now },
    historyPromptReturnedSends: { ...state.historyPromptReturnedSends,
      [tabId]: [...(state.historyPromptReturnedSends?.[tabId] || []), token] },
  };
  const memory = buildComposerDraftMemory({ drafts: patch.historyPromptDrafts,
    images: patch.historyPromptDraftImages, chips: patch.historyPromptDraftChips,
    updatedAtByTab: patch.historyPromptDraftUpdatedAt, returnedByTab: patch.historyPromptReturnedSends });
  if (!memory[tabId]?.returned?.includes(token)) throw new Error('History return could not be retained');
  persist(JSON.stringify(memory)); // MUST throw on failure; no asset-owner ACK yet.
  return { adopted: true, patch };
}

export function historySendReturnEnabled(entry) {
  return !!entry?.historyReturn?.token && ['registering', 'available', 'returned'].includes(entry.historyReturn.state)
    && !entry.enterAttemptAt && !['sent', 'audit-pending'].includes(entry.queueStatus)
    && (entry.queueStatus !== 'queued' || ['send-ready-queued', 'send-queued'].includes(entry.statusReason))
    && (entry.queueStatus !== 'delivery-unknown' || entry.historyReturn.state === 'returned');
}

// Failed and unconfirmed cards may be hidden, never returned/replayed. Hiding
// an unknown is not a negative receipt, cancellation, or input-slot release.
// Pending sends keep the exact Main pre-write return fence and disabled state.
export function historySendPresentationAction(entry) {
  if (['failed', 'cancelled'].includes(entry?.queueStatus)
    || entry?.queueStatus === 'delivery-unknown' && !historySendReturnEnabled(entry)) return { kind: 'dismiss', enabled: true };
  return { kind: 'return', enabled: historySendReturnEnabled(entry) };
}
