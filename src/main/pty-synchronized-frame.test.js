'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SYNCHRONIZED_OUTPUT_END,
  waitForNextPtySynchronizedFrame,
} = require('./pty-synchronized-frame');

function fakeTerm() {
  const listeners = new Set();
  let disposed = 0;
  return {
    term: {
      onData(listener) {
        listeners.add(listener);
        return {
          dispose() {
            if (listeners.delete(listener)) disposed += 1;
          },
        };
      },
    },
    emit(chunk) {
      for (const listener of [...listeners]) listener(chunk);
    },
    listenerCount() {
      return listeners.size;
    },
    disposedCount() {
      return disposed;
    },
  };
}

test('resolves only after a synchronized frame observed after subscription', async () => {
  const pty = fakeTerm();
  const pending = waitForNextPtySynchronizedFrame(pty.term, { timeoutMs: 1000 });

  pty.emit('ordinary output');
  assert.equal(pty.listenerCount(), 1);
  pty.emit(SYNCHRONIZED_OUTPUT_END);

  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.reason, 'synchronized-frame');
  assert.equal(pty.listenerCount(), 0);
  assert.equal(pty.disposedCount(), 1);
});

test('recognizes a marker split across PTY chunks', async () => {
  const pty = fakeTerm();
  const pending = waitForNextPtySynchronizedFrame(pty.term, { timeoutMs: 1000 });

  pty.emit('prefix' + SYNCHRONIZED_OUTPUT_END.slice(0, 4));
  pty.emit(SYNCHRONIZED_OUTPUT_END.slice(4));

  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(pty.listenerCount(), 0);
});

test('timeout is unresolved proof and disposes the listener', async () => {
  const pty = fakeTerm();
  let timeoutCallback = null;
  const pending = waitForNextPtySynchronizedFrame(pty.term, {
    setTimer(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimer() {},
  });

  timeoutCallback();
  const result = await pending;
  assert.equal(result.ready, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, 'synchronized-frame-timeout');
  assert.equal(pty.listenerCount(), 0);
  assert.equal(pty.disposedCount(), 1);
});

test('missing PTY subscription fails without pretending readiness', async () => {
  const result = await waitForNextPtySynchronizedFrame(null);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'pty_subscription_unavailable');
});
