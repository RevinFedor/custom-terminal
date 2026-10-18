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
  const next = { input, phase };
  const index = records.findIndex(record => record.input.tabId === input.tabId && record.input.handoffId === input.handoffId);
  if (index < 0) records.push(next); else records[index] = next;
  // A quota/error must leave the composer intact, not silently evict an
  // earlier accepted authoring snapshot to make room for this one.
  storage.setItem(KEY, JSON.stringify(records));
}

export function removeHistorySendRecovery(tabId, handoffId, storage = globalThis.localStorage) {
  try {
    const records = readHistorySendRecovery(storage);
    const next = records.filter(record => record.input.tabId !== tabId || record.input.handoffId !== handoffId);
    if (next.length === records.length) return;
    if (next.length) storage.setItem(KEY, JSON.stringify(next)); else storage.removeItem(KEY);
  } catch (error) { console.warn('[HistorySendRecovery] cleanup failed:', error?.message || error); }
}
