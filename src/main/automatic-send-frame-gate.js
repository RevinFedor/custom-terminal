'use strict';
const { getCodexDraftFrameBlocker } = require('./codex-draft-authority');

// One-shot wake on the existing mirror's flush signal. This owns no Send,
// receipt, timer or input permission; every wake goes back through admission.
function createAutomaticSendFrameGate({ getMirror }) {
  const waiting = new Map();
  const clear = tabId => {
    const old = waiting.get(tabId);
    if (!old) return;
    old.mirror.synchronizedFrameWaiters.delete(old.check);
    waiting.delete(tabId);
  };
  const reasonFor = mirror => {
    if (!mirror || mirror.failed || mirror.disposed || mirror.complete !== true) return 'mirror-unavailable';
    return getCodexDraftFrameBlocker({ synchronizedOutputOpen: mirror.redrawTrace?.synchronizedOutputOpen === true,
      writeSeq: mirror.writeSeq, flushedSeq: mirror.flushedSeq, pendingResizeWriteSeq: mirror.pendingResizeWriteSeq });
  };
  function read(tabId, wake) {
    const mirror = getMirror(tabId), reason = reasonFor(mirror);
    if (!reason) { clear(tabId); return { ready: true, reason: null }; }
    if (!mirror?.synchronizedFrameWaiters || reason === 'mirror-unavailable') {
      clear(tabId); return { ready: false, reason };
    }
    if (waiting.get(tabId)?.mirror !== mirror) {
      clear(tabId);
      const check = () => {
        const current = getMirror(tabId);
        if (current === mirror && !mirror.failed && !mirror.disposed && reasonFor(mirror)) return;
        clear(tabId);
        wake(); // replacement/loss wakes a recheck, never authorizes input
      };
      waiting.set(tabId, { mirror, check });
      mirror.synchronizedFrameWaiters.add(check);
    }
    return { ready: false, reason };
  }
  return { read, clear, dispose: () => { for (const tabId of waiting.keys()) clear(tabId); } };
}
module.exports = { createAutomaticSendFrameGate };
