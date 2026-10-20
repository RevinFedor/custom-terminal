const KEY = 'noted-terminal-history-send-recovery';

// Only the short gap before Main owns the immutable request. This is saved
// authoring, not a second delivery queue: loading it NEVER executes a Send.
export function readHistorySendRecovery(storage = globalThis.localStorage) {
  const raw = storage?.getItem(KEY);
  if (!raw) return [];
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error('Invalid History Send recovery data');
  return records.filter(record => record?.input?.tabId && record.input.handoffId);
}

export function saveHistorySendRecovery(input, phase = 'preparing', storage = globalThis.localStorage) {
  if (!storage) throw new Error('History Send recovery storage is unavailable');
  const records = readHistorySendRecovery(storage);
  const index = records.findIndex(record => record.input.tabId === input.tabId && record.input.handoffId === input.handoffId);
  const next = { ...(index < 0 ? {} : records[index]), input, phase };
  if (index < 0) records.push(next); else records[index] = next;
  // A quota/error must leave the composer intact, not silently evict an
  // earlier accepted authoring snapshot to make room for this one.
  storage.setItem(KEY, JSON.stringify(records));
}

// No Main receipt is NOT no-send proof. Keep the existing authoring/asset
// snapshot and dispatched phase; only its local card is hidden on reload.
export function hideHistorySendRecoveryPresentation(input, storage = globalThis.localStorage) {
  if (!storage) throw new Error('History Send recovery storage is unavailable');
  if (!input?.tabId || !input.handoffId || input.queueStatus !== 'delivery-unknown'
    || input.sendOperationKey || input.sendAttemptId) throw new Error('Exact receiptless unknown required');
  const records = readHistorySendRecovery(storage);
  const index = records.findIndex(record => record.input.tabId === input.tabId && record.input.handoffId === input.handoffId);
  const previous = index < 0 ? { input, phase: 'dispatched' } : records[index];
  const next = { ...previous, presentationDismissedAt: previous.presentationDismissedAt || Date.now(),
    presentationDismissedReturnToken: previous.presentationDismissedReturnToken || input.historyReturn?.token || null };
  if (index < 0) records.push(next); else records[index] = next;
  storage.setItem(KEY, JSON.stringify(records)); // Failure keeps the card visible.
  return next;
}

export function removeHistorySendRecovery(tabId, handoffId, storage = globalThis.localStorage) {
  try {
    const records = readHistorySendRecovery(storage);
    const next = records.filter(record => record.input.tabId !== tabId || record.input.handoffId !== handoffId);
    if (next.length === records.length) return;
    if (next.length) storage.setItem(KEY, JSON.stringify(next)); else storage.removeItem(KEY);
  } catch (error) { console.warn('[HistorySendRecovery] cleanup failed:', error?.message || error); }
}
