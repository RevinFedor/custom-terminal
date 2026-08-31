'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTerminalShellDraftProof,
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

  assert.equal(tracker.markPromptFrame('tab-a', firstPty, 5000, {
    mirrorGeneration: 'mirror-1',
    bufferType: 'normal',
    lineText: 'user@host project % ',
    cursorX: 20,
    inputRevision: 4,
  }), true);
  assert.equal(tracker.promptFrameSnapshot('tab-a', firstPty).lineText, 'user@host project % ');

  tracker.markCommandBoundary('tab-a', firstPty);
  assert.equal(tracker.snapshot('tab-a', firstPty).ready, false);
  assert.equal(tracker.promptFrameSnapshot('tab-a', firstPty), null);
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

test('unchanged shell frame overrides a stale key counter but a changed frame preserves the draft', () => {
  const baseline = {
    mirrorGeneration: 'mirror-1',
    bufferType: 'normal',
    lineText: 'user@host project % ',
    cursorX: 20,
    inputRevision: 4,
  };
  assert.deepEqual(classifyTerminalShellDraftProof({
    baseline,
    current: { ...baseline },
  }), {
    status: 'empty',
    reason: 'prompt-input-revision-unchanged',
  });
  assert.deepEqual(classifyTerminalShellDraftProof({
    baseline,
    current: {
      ...baseline,
      lineText: 'user@host project % npm test',
      cursorX: 28,
      inputRevision: 5,
    },
  }), {
    status: 'draft',
    reason: 'prompt-frame-changed',
  });
  assert.equal(classifyTerminalShellDraftProof({
    baseline,
    current: { ...baseline, inputRevision: 5 },
  }).status, 'empty');
  assert.equal(classifyTerminalShellDraftProof({ baseline, current: null }).status, 'unknown');
});
