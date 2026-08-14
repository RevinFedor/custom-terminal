'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  waitForCommittedSemanticFrame,
} = require('./committed-semantic-frame-wait');

function frame(writeSeq, state, committed = true) {
  return {
    success: true,
    authoritativeFrameCommitted: committed,
    writeSeq,
    flushedSeq: writeSeq,
    state,
  };
}

function frameSource(initial) {
  let current = initial;
  const listeners = new Set();
  return {
    read: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('waits across multiple committed frames until the semantic surface is complete', async () => {
  const source = frameSource(frame(10, 'composer'));
  const pending = waitForCommittedSemanticFrame({
    subscribe: source.subscribe,
    readSnapshot: source.read,
    inspectSnapshot: (snapshot) => ({ complete: snapshot.state === 'picker-complete' }),
    acceptInspection: (inspection) => inspection.complete,
    afterWriteSeq: 10,
    timeoutMs: 1000,
    trigger() {
      source.publish(frame(11, 'picker-without-footer'));
      source.publish(frame(12, 'picker-complete'));
    },
  });

  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.writeSeq, 12);
  assert.equal(result.observedFrames, 2);
  assert.deepEqual(result.inspection, { complete: true });
  assert.equal(source.listenerCount(), 0);
});

test('a committed but semantically incomplete frame times out without becoming proof', async () => {
  const source = frameSource(frame(20, 'composer'));
  let timeoutCallback = null;
  const pending = waitForCommittedSemanticFrame({
    subscribe: source.subscribe,
    readSnapshot: source.read,
    inspectSnapshot: (snapshot) => ({ state: snapshot.state }),
    acceptInspection: (inspection) => inspection.state === 'picker-complete',
    afterWriteSeq: 20,
    setTimer(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimer() {},
    trigger() {
      source.publish(frame(21, 'picker-without-footer'));
    },
  });

  timeoutCallback();
  const result = await pending;
  assert.equal(result.ready, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, 'semantic-frame-timeout');
  assert.deepEqual(result.lastInspection, { state: 'picker-without-footer' });
  assert.equal(result.observedFrames, 1);
  assert.equal(source.listenerCount(), 0);
});

test('open frames and stale frame notifications cannot satisfy the waiter', async () => {
  const source = frameSource(frame(30, 'composer'));
  const pending = waitForCommittedSemanticFrame({
    subscribe: source.subscribe,
    readSnapshot: source.read,
    inspectSnapshot: (snapshot) => snapshot.state,
    acceptInspection: (inspection) => inspection === 'picker-complete',
    afterWriteSeq: 30,
    timeoutMs: 1000,
    trigger() {
      source.publish(frame(30, 'picker-complete'));
      source.publish(frame(31, 'picker-complete', false));
      source.publish(frame(32, 'picker-complete'));
    },
  });

  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.writeSeq, 32);
  assert.equal(result.observedFrames, 1);
});

test('accepts a newer frame that committed immediately before subscription', async () => {
  const source = frameSource(frame(52, 'picker-complete'));
  const result = await waitForCommittedSemanticFrame({
    subscribe: source.subscribe,
    readSnapshot: source.read,
    inspectSnapshot: (snapshot) => snapshot.state,
    acceptInspection: (inspection) => inspection === 'picker-complete',
    afterWriteSeq: 51,
    timeoutMs: 1000,
  });

  assert.equal(result.ready, true);
  assert.equal(result.writeSeq, 52);
  assert.equal(result.observedFrames, 1);
  assert.equal(source.listenerCount(), 0);
});

test('identity loss aborts before a later frame can authorize input', async () => {
  const source = frameSource(frame(40, 'composer'));
  let owns = true;
  const pending = waitForCommittedSemanticFrame({
    subscribe: source.subscribe,
    readSnapshot: source.read,
    afterWriteSeq: 40,
    timeoutMs: 1000,
    getAbortReason: () => owns ? null : 'think_input_ownership_changed',
    trigger() {
      owns = false;
      source.publish(frame(41, 'picker-complete'));
    },
  });

  const result = await pending;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'think_input_ownership_changed');
  assert.equal(result.observedFrames, 0);
});
