import { historyRootIdentity } from './historyRootReadClient.mjs';
// Scalar capability discovery only. History remains the lifetime owner; no
// metadata/body/UUID graph or cached label is transferred to Timeline.
const held = new Map();
const keyFor = owner => JSON.stringify([owner.tabId, owner.toolType, owner.sessionId, owner.cwd || '']);
export function registerHeldHistoryPrimaryRoot(owner, getHeader) {
  const key = keyFor(owner), record = { getHeader }; held.set(key, record);
  return () => { if (held.get(key) === record) held.delete(key); };
}
export function heldHistoryPrimaryRootLease(owner) {
  const header = held.get(keyFor(owner))?.getHeader();
  if (header?.readProfile !== 'history-primary-v1') return null;
  try { return historyRootIdentity(header); } catch { return null; }
}
