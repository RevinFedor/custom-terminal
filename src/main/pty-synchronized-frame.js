'use strict';

const SYNCHRONIZED_OUTPUT_END = '\x1b[?2026l';

function waitForNextPtyOutput(term, {
  timeoutMs = 1500,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!term || typeof term.onData !== 'function') {
    return Promise.resolve({
      ready: false,
      timedOut: false,
      reason: 'pty_subscription_unavailable',
    });
  }

  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    let subscription = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      try { subscription?.dispose?.(); } catch {}
      resolve({
        ...result,
        elapsedMs: Math.max(0, now() - startedAt),
      });
    };

    try {
      subscription = term.onData((chunk) => {
        if (!String(chunk || '')) return;
        finish({ ready: true, timedOut: false, reason: 'pty-output' });
      });
    } catch (error) {
      finish({
        ready: false,
        timedOut: false,
        reason: 'pty_subscription_failed',
        error: error?.message || String(error),
      });
      return;
    }

    timer = setTimer(() => {
      finish({ ready: false, timedOut: true, reason: 'pty-output-timeout' });
    }, timeoutMs);
  });
}

/**
 * Wait for the next Ink/xterm synchronized-output frame after subscription.
 *
 * PTY onData is edge-triggered and does not replay old chunks. This makes the
 * first marker observed after a known async boundary (for example, the
 * external-editor helper acknowledgement) an authoritative proof that Claude
 * has returned to its TUI and rendered a new frame.
 */
function waitForNextPtySynchronizedFrame(term, {
  timeoutMs = 1500,
  marker = SYNCHRONIZED_OUTPUT_END,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!term || typeof term.onData !== 'function') {
    return Promise.resolve({
      ready: false,
      timedOut: false,
      reason: 'pty_subscription_unavailable',
    });
  }

  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let subscription = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      try { subscription?.dispose?.(); } catch {}
      resolve({
        ...result,
        elapsedMs: Math.max(0, now() - startedAt),
      });
    };

    try {
      subscription = term.onData((chunk) => {
        if (settled) return;
        buffer += String(chunk || '');
        if (buffer.includes(marker)) {
          finish({ ready: true, timedOut: false, reason: 'synchronized-frame' });
          return;
        }
        // Preserve only a possible marker prefix across chunk boundaries.
        const keep = Math.max(0, marker.length - 1);
        if (buffer.length > keep) buffer = buffer.slice(-keep);
      });
    } catch (error) {
      finish({
        ready: false,
        timedOut: false,
        reason: 'pty_subscription_failed',
        error: error?.message || String(error),
      });
      return;
    }

    timer = setTimer(() => {
      finish({ ready: false, timedOut: true, reason: 'synchronized-frame-timeout' });
    }, timeoutMs);
  });
}

module.exports = {
  SYNCHRONIZED_OUTPUT_END,
  waitForNextPtyOutput,
  waitForNextPtySynchronizedFrame,
};
