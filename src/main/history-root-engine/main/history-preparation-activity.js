'use strict';

const { randomUUID } = require('node:crypto');
const MIN_HEAVY_HISTORY_BYTES = 8 * 1024 * 1024;

// Presentation of known work, independent from CPU samples / agent busy.
// A lease belongs to its operation. Finishing A never clears concurrent B.
function createHistoryPreparationActivity({ epoch = randomUUID(), minBytes = MIN_HEAVY_HISTORY_BYTES,
  now = Date.now, progressIntervalMs = 250 } = {}) {
  const active = new Map(), listeners = new Set();
  let revision = 0, sequence = 0;
  let lastPublishedAt = -Infinity;
  let snapshot = Object.freeze({ epoch, revision, operations: Object.freeze([]) });
  const publish = () => {
    lastPublishedAt = now();
    snapshot = Object.freeze({ epoch, revision: ++revision,
      operations: Object.freeze([...active.values()]) });
    for (const listener of listeners) { try { listener(snapshot); } catch {} }
  };
  return {
    begin({ kind = 'history', tabId = null, sessionId = null, bytes, source = null } = {}) {
      if (Number.isFinite(bytes) && bytes < minBytes) {
        const noop = () => {}; noop.update = () => {}; return noop;
      }
      const id = epoch + ':' + (++sequence);
      active.set(id, Object.freeze({ id, kind: kind === 'resume' ? 'resume' : 'history',
        tabId, sessionId,
        ...(source && Number.isSafeInteger(bytes) && bytes > 0 ? {
          source: Object.freeze({ toolType: source.toolType, cwd: source.cwd || '' }),
          startedAt: now(), phase: 'reading', completedBytes: 0, totalBytes: bytes,
        } : {}),
      }));
      publish();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (active.delete(id)) publish();
      };
      finish.update = ({ completedBytes, phase } = {}) => {
        const previous = active.get(id);
        if (finished || !previous?.source) return;
        const nextPhase = phase === 'preparing' ? 'preparing' : previous.phase;
        const bytesDone = Number.isSafeInteger(completedBytes)
          ? Math.max(previous.completedBytes, Math.min(previous.totalBytes, completedBytes))
          : previous.completedBytes;
        if (bytesDone === previous.completedBytes && nextPhase === previous.phase) return;
        active.set(id, Object.freeze({ ...previous, completedBytes: bytesDone, phase: nextPhase }));
        // One global publication budget, not four IPCs/second per loaded tab.
        // Real phase changes remain immediate. There is no polling timer.
        if (nextPhase !== previous.phase || now() - lastPublishedAt >= progressIntervalMs) publish();
      };
      return finish;
    },
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const historyPreparationActivity = createHistoryPreparationActivity();

// Dedicated operation IPC: the resource chip's five-second memory sampler is
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
