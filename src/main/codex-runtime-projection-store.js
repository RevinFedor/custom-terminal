'use strict';

function createCodexRuntimeProjectionStore() {
  const snapshots = new Map();
  const revisions = new Map();

  function sameProjection(previous, next) {
    if (!previous) return false;
    const structuralKey = (key) => key !== 'tabId' && !key.startsWith('runtime');
    const previousKeys = Object.keys(previous).filter(structuralKey);
    const nextKeys = Object.keys(next).filter(structuralKey);
    if (previousKeys.length !== nextKeys.length) return false;
    return nextKeys.every((key) => Object.is(previous[key], next[key]));
  }

  function publish(tabId, projection, reason = 'runtime-event') {
    if (!tabId || !projection || typeof projection !== 'object') return null;
    const previous = snapshots.get(tabId) || null;
    if (sameProjection(previous, projection)) return previous;
    const revision = Number(revisions.get(tabId) || 0) + 1;
    revisions.set(tabId, revision);
    const snapshot = Object.freeze({
      ...projection,
      tabId,
      runtimeRevision: revision,
      runtimeObservedAt: Date.now(),
      runtimeProjectionReason: reason,
    });
    snapshots.set(tabId, snapshot);
    return snapshot;
  }

  function read(tabId) {
    return snapshots.get(tabId) || null;
  }

  function readBatch(tabIds) {
    const result = {};
    for (const tabId of Array.isArray(tabIds) ? tabIds : []) {
      const snapshot = read(tabId);
      if (snapshot) result[tabId] = snapshot;
    }
    return result;
  }

  function remove(tabId) {
    revisions.delete(tabId);
    return snapshots.delete(tabId);
  }

  return { publish, read, readBatch, remove };
}

module.exports = { createCodexRuntimeProjectionStore };
