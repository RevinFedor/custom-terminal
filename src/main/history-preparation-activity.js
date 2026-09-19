'use strict';

const { randomUUID } = require('node:crypto');
const MIN_HEAVY_HISTORY_BYTES = 8 * 1024 * 1024;

// Presentation of known work, independent from CPU samples / agent busy.
// A lease belongs to its operation. Finishing A never clears concurrent B.
function createHistoryPreparationActivity({ epoch = randomUUID(), minBytes = MIN_HEAVY_HISTORY_BYTES } = {}) {
  const active = new Map(), listeners = new Set();
  let revision = 0, sequence = 0;
  let snapshot = Object.freeze({ epoch, revision, operations: Object.freeze([]) });
  const publish = () => {
    snapshot = Object.freeze({ epoch, revision: ++revision,
      operations: Object.freeze([...active.values()]) });
    for (const listener of listeners) { try { listener(snapshot); } catch {} }
  };
  return {
    begin({ kind = 'history', tabId = null, sessionId = null, bytes } = {}) {
      if (Number.isFinite(bytes) && bytes < minBytes) return () => {};
      const id = epoch + ':' + (++sequence);
      active.set(id, Object.freeze({ id, kind: kind === 'resume' ? 'resume' : 'history',
        tabId, sessionId }));
      publish();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        if (active.delete(id)) publish();
      };
    },
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const historyPreparationActivity = createHistoryPreparationActivity();

// Dedicated edge-only IPC: the resource chip's five-second memory sampler is
// too late to explain a cold read, and must not acquire a second polling loop.
function installHistoryPreparationIpc({ ipcMain, activity = historyPreparationActivity }) {
  const subscribers = new Map();
  const remove = sender => {
    const cleanup = subscribers.get(sender);
    if (!cleanup) return;
    subscribers.delete(sender);
    sender.removeListener('destroyed', cleanup);
  };
  const unsubscribe = activity.subscribe(snapshot => {
    for (const sender of subscribers.keys()) {
      try {
        if (sender.isDestroyed()) remove(sender);
        else sender.send('history-preparation:changed', snapshot);
      } catch { remove(sender); }
    }
  });
  ipcMain.handle('history-preparation:subscribe', event => {
    const sender = event.sender;
    if (!subscribers.has(sender)) {
      const cleanup = () => remove(sender);
      subscribers.set(sender, cleanup);
      sender.once('destroyed', cleanup);
    }
    return activity.snapshot();
  });
  ipcMain.handle('history-preparation:unsubscribe', event => { remove(event.sender); });
  return () => {
    unsubscribe();
    for (const sender of subscribers.keys()) remove(sender);
    ipcMain.removeHandler('history-preparation:subscribe');
    ipcMain.removeHandler('history-preparation:unsubscribe');
  };
}

module.exports = { MIN_HEAVY_HISTORY_BYTES, createHistoryPreparationActivity,
  historyPreparationActivity, installHistoryPreparationIpc };
