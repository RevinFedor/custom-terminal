const { ipcRenderer } = window.require('electron');
import activity from '../../shared/build-install-activity.cjs';
let known = false, initialization = null, installed = false;
const entries = new Map(), listeners = new Set();

function apply(entry, notify = true) {
  if (!entry?.requestId || !entry.source?.tabId) return;
  const old = entries.get(entry.requestId);
  if (old && old.fingerprint !== entry.fingerprint) { known = false; return false; }
  if (activity.olderProjection(old, entry)) return;
  if (old && !activity.pending(old) && entry.state !== old.state) return;
  entries.set(entry.requestId, entry);
  if (notify) for (const listener of listeners) listener(entry);
  return true;
}
export function buildInstallContinuationBlocks(tabId) {
  return !known || [...entries.values()].some(entry => entry.source.tabId === tabId && activity.pending(entry));
}
export function buildInstallContinuationFloor(tabId) {
  return Math.max(0, ...[...entries.values()].filter(entry => entry.source.tabId === tabId && !activity.pending(entry))
    .map(entry => Number(entry.outcomeFloorAt) || 0));
}
export function buildInstallPendingSources() {
  return [...entries.values()].filter(activity.pending)
    .map(entry => entry.source);
}
export function buildInstallInheritedSources() {
  // Old Main has no separate projection. New Main explicitly distinguishes
  // a retained proof guard from a currently running installer.
  return [...entries.values()].filter(entry => activity.pending(entry) && entry.inheritedActive !== false)
    .map(entry => entry.source);
}
export function subscribeBuildInstallContinuations(listener) {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function initializeBuildInstallContinuations() {
  if (!installed) {
    installed = true;
    ipcRenderer.on('build-install:continuation', (_event, entry) => {
      apply(entry);
      if (!known) void initializeBuildInstallContinuations().catch(() => {});
    });
    ipcRenderer.on('build-install:status', (_event, snapshot) => {
      if (snapshot?.continuationsKnown !== true || !Array.isArray(snapshot.continuations)) return;
      for (const entry of snapshot.continuations) apply(entry);
    });
  }
  if (!initialization) initialization = ipcRenderer.invoke('build-install:list-continuations').then(snapshot => {
    if (snapshot?.version !== 1 || snapshot.known !== true || !Array.isArray(snapshot.entries)) throw Error('install continuation snapshot unavailable');
    for (const entry of snapshot.entries) if (apply(entry, false) === false) throw Error('install continuation owner conflict');
    known = true;
    for (const entry of entries.values()) for (const listener of listeners) listener(entry);
  }).catch(error => { initialization = null; known = false; throw error; });
  return initialization;
}
