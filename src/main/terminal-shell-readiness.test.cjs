'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTerminalShellReadinessTracker,
} = require('./terminal-shell-readiness.cjs');

test('late renderer mount can read the exact current shell prompt boundary', () => {
  const tracker = createTerminalShellReadinessTracker();
  const firstPty = {};

  tracker.reset('tab-a', firstPty, 101);
  assert.deepEqual(tracker.snapshot('tab-a', firstPty), {
    ready: false,
    pid: 101,
    readyAt: null,
  });

  tracker.markPromptReady('tab-a', firstPty, 101, 5000);
  assert.deepEqual(tracker.snapshot('tab-a', firstPty), {
    ready: true,
    pid: 101,
    readyAt: 5000,
  });

  tracker.markCommandBoundary('tab-a', firstPty);
  assert.equal(tracker.snapshot('tab-a', firstPty).ready, false);
});

test('a recreated PTY rejects a stale prompt-ready callback from the old generation', () => {
  const tracker = createTerminalShellReadinessTracker();
  const oldPty = {};
  const currentPty = {};

  tracker.reset('tab-a', oldPty, 101);
  tracker.reset('tab-a', currentPty, 202);

  assert.equal(tracker.markPromptReady('tab-a', oldPty, 101, 5000), false);
  assert.deepEqual(tracker.snapshot('tab-a', currentPty), {
    ready: false,
    pid: 202,
    readyAt: null,
  });
});
