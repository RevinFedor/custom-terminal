import { mergeFailedHistoryAuthoringSnapshot } from './historyDraftOwnership.mjs';

// This is ownership deduplication, not text deduplication: identical drafts
// captured by two different operations remain two different authoring intents.
const adoptedTransfers = new Map();

export function readAgentDraftTransfer(result, tabId = null) {
  const transfer = result?.draftTransfer;
  if (!transfer || typeof transfer.id !== 'string' || !transfer.id
    || typeof transfer.tabId !== 'string' || !transfer.tabId
    || (tabId && transfer.tabId !== tabId)) return null;
  return {
    id: transfer.id,
    tabId: transfer.tabId,
    text: typeof transfer.text === 'string' ? transfer.text : '',
    images: Number(transfer.images || 0),
    imagePaths: Array.isArray(transfer.imagePaths) ? transfer.imagePaths.map(ref => ({ ...ref })) : [],
  };
}

export async function adoptAgentDraftTransferOnce(transfer, owner, apply) {
  if (!transfer?.id) return { adopted: false, reason: 'no-transfer' };
  const existing = adoptedTransfers.get(transfer.id);
  if (existing) return { adopted: false, reason: 'already-owned', owner: existing.owner };
  const claim = { owner, complete: false };
  adoptedTransfers.set(transfer.id, claim);
  try {
    const result = await apply(transfer);
    claim.complete = true;
    return { adopted: true, owner, result };
  } catch (error) {
    if (adoptedTransfers.get(transfer.id) === claim) adoptedTransfers.delete(transfer.id);
    throw error;
  }
}

export function recoverAgentDraftTransferToHistory(result, tabId, uiStore) {
  const transfer = readAgentDraftTransfer(result, tabId);
  return adoptAgentDraftTransferOnce(transfer, 'history:' + tabId, snapshot => {
    const ui = uiStore.getState();
    const merged = mergeFailedHistoryAuthoringSnapshot({
      currentText: ui.historyPromptDrafts[tabId] || '',
      currentImages: ui.historyPromptDraftImages[tabId] || [],
      currentChips: ui.historyPromptDraftChips[tabId] || [],
      currentPendingImages: ui.historyPromptDraftPendingImages?.[tabId] || [],
      snapshotText: snapshot.text,
      snapshotImages: snapshot.imagePaths,
    });
    ui.setHistoryPromptDraft(tabId, merged.text, {
      images: merged.images, chips: merged.chips, pendingImages: merged.pendingImages,
    });
    return merged;
  });
}

export function draftTransferResultFields(result, tabId = null) {
  const draftTransfer = readAgentDraftTransfer(result, tabId);
  if (!draftTransfer) return {};
  return {
    draftTransfer,
    draftText: draftTransfer.text,
    draftImages: draftTransfer.images,
    draftImagePaths: draftTransfer.imagePaths,
  };
}
