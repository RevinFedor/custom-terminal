import policy from '../../shared/loop-dependencies.cjs';
const { sameLoopTurn, loopEpoch, loopPromptMode } = policy;
const { ipcRenderer } = window.require('electron');
let known = false, initialization = null, listening = false, revision = -1;
const entries = new Map(), listeners = new Set();
const versions = new Map();
function validEntry(entry) { return typeof entry?.id === 'string' && typeof entry.source?.tabId === 'string'
  && typeof entry.epoch === 'string' && ['intent', 'waiting', 'ready', 'released', 'cancelled', 'superseded'].includes(entry.state); }
function apply(entry, incoming) {
  if (!validEntry(entry) || !Number.isSafeInteger(incoming) || incoming < 0) return false;
  if (incoming < (versions.get(entry.id) ?? -1)) return false;
  entries.set(entry.id, entry); versions.set(entry.id, incoming); revision = Math.max(revision, incoming);
  return true;
}
export function loopDependencyEntry(tabId, queue) {
  if (!queue?.loopPromptEnabled || loopPromptMode(queue) !== 'own-turn') return null;
  return [...entries.values()].reverse().find(entry => entry.source.tabId === tabId
    && entry.epoch === loopEpoch(queue) && !['released', 'superseded', 'cancelled'].includes(entry.state)) || null;
}
export function loopDependenciesBlock(tabId, queue, cause = null) {
  if (loopPromptMode(queue) !== 'own-turn') return false;
  if (!known) return true;
  const entry = loopDependencyEntry(tabId, queue);
  return !!entry && entry.state !== 'ready'
    && (!cause || sameLoopTurn(entry.subject.targetExecutionContext, cause));
}
export function loopDependencyResumeText(tabId, queue) {
  const entry = loopDependencyEntry(tabId, queue);
  if (entry?.state !== 'ready') return '';
  return '\n\n<loop_dependency_ready>\nНаступило событие ожидаемой зависимости: '
    + JSON.stringify(entry.readyDependency) + '. Обработай её точный результат/исход и весь оставшийся план.'
    + '\n</loop_dependency_ready>';
}
export function subscribeLoopDependencies(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function initializeLoopDependencies() {
  if (!listening) {
    listening = true;
    ipcRenderer.on('loop-dependencies:changed', (_event, value) => {
      if (apply(value.entry, value.revision)) for (const listener of listeners) listener(value.entry);
    });
  }
  if (!initialization) initialization = ipcRenderer.invoke('loop-dependencies:list').then(snapshot => {
    if (snapshot?.version !== 1 || snapshot.known !== true || !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision < 0 || !Array.isArray(snapshot.entries) || !snapshot.entries.every(validEntry)) throw Error('loop_wait_snapshot_unknown');
    // Hydration cannot overwrite a newer event; merge by operation identity.
    for (const entry of snapshot.entries) apply(entry, snapshot.revision);
    known = true;
    for (const entry of entries.values()) for (const listener of listeners) listener(entry);
  }).catch(error => { known = false; initialization = null; throw error; });
  return initialization;
}
