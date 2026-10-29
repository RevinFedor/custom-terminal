import policy from '../../shared/message-loop-waits.cjs';
import loopPolicy from '../../shared/loop-dependencies.cjs';
const { ipcRenderer } = window.require('electron');
const entries = new Map(), versions = new Map(), listeners = new Set();
let known = false, initialization = null, listening = false;
function valid(entry) { return typeof entry?.id === 'string' && typeof entry.source?.tabId === 'string'
  && ['waiting', 'returning', 'settled', 'cancelled', 'source-replaced'].includes(entry.state); }
function apply(entry, revision) {
  if (!valid(entry) || !Number.isSafeInteger(revision) || revision < 0 || revision < (versions.get(entry.id) ?? -1)) return false;
  entries.set(entry.id, entry); versions.set(entry.id, revision); return true;
}
export function messageLoopWaitsBlock(tabId, queue, cause = null) {
  if (loopPolicy.loopPromptMode(queue) !== 'all-work') return false;
  if (!known) return true;
  return [...entries.values()].some(entry => policy.messageWaitBlocks(entry, tabId, cause));
}
export function subscribeMessageLoopWaits(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function initializeMessageLoopWaits() {
  if (!listening) {
    listening = true;
    ipcRenderer.on('message-loop-waits:changed', (_event, value) => {
      if (apply(value?.entry, value?.revision)) for (const listener of listeners) listener(value.entry);
    });
  }
  if (!initialization) initialization = ipcRenderer.invoke('message-loop-waits:list').then(snapshot => {
    if (snapshot?.version !== 1 || snapshot.known !== true || !Number.isSafeInteger(snapshot.revision)
      || !Array.isArray(snapshot.entries) || !snapshot.entries.every(valid)) throw Error('message_wait_snapshot_unknown');
    for (const entry of snapshot.entries) apply(entry, snapshot.revision);
    known = true;
    for (const entry of entries.values()) for (const listener of listeners) listener(entry);
  }).catch(error => { known = false; initialization = null; throw error; });
  return initialization;
}
