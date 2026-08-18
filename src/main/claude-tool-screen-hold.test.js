'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createClaudeToolScreenHoldTracker } = require('./claude-tool-screen-hold');

test('tool screen remains held after PostToolUse until exact JSONL id releases it', () => {
  const tracker = createClaudeToolScreenHoldTracker();
  assert.equal(tracker.start({ tabId: 'tab-a', toolUseId: 'tool-1', toolName: 'Edit' }), true);
  assert.equal(tracker.complete({ tabId: 'tab-a', toolUseId: 'tool-1' }), true);
  assert.equal(tracker.isHeld('tab-a'), true);
  assert.equal(tracker.release({ tabId: 'tab-a', toolUseIds: ['tool-1'] }), 1);
  assert.equal(tracker.isHeld('tab-a'), false);
});

test('legacy exact tool result releases only completed holds', () => {
  const tracker = createClaudeToolScreenHoldTracker();
  tracker.start({ tabId: 'tab-a', toolUseId: 'tool-1' });
  tracker.start({ tabId: 'tab-a', toolUseId: 'tool-2' });
  tracker.complete({ tabId: 'tab-a', toolUseId: 'tool-1' });
  assert.equal(tracker.releaseCompleted('tab-a'), 1);
  assert.deepEqual(tracker.snapshot('tab-a').map((tool) => tool.toolUseId), ['tool-2']);
});
