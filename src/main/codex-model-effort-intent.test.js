'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  nextCodexModelEffortIntent,
  planCodexModelEffortIntentReconcile,
} = require('./codex-model-effort-intent');

test('model/effort intent is a complete revisioned last-click-wins pair', () => {
  assert.deepEqual(nextCodexModelEffortIntent({ model: 'sol', effort: '' }), {
    valid: false,
    reason: 'model-effort-intent-incomplete',
  });
  assert.deepEqual(nextCodexModelEffortIntent({
    currentModel: 'terra',
    currentEffort: 'max',
    currentRevision: 3,
    model: 'sol',
    effort: 'MAX',
  }), {
    valid: true,
    changed: true,
    model: 'sol',
    effort: 'max',
    revision: 4,
  });
  assert.equal(nextCodexModelEffortIntent({
    currentModel: 'sol',
    currentEffort: 'max',
    currentRevision: 4,
    model: 'sol',
    effort: 'max',
  }).revision, 4);
});

test('starting queues without timeout and exact current writer settles once', () => {
  const base = { model: 'sol', effort: 'max', revision: 4 };
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: true,
  }).reason, 'writer-not-adopted');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: false,
    writerOwnerId: 'writer-a',
  }).reason, 'tui-not-ready');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'writer-a',
  }).action, 'apply');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    appliedRevision: 4,
    appliedOwnerId: 'writer-a',
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'writer-a',
  }).action, 'settled');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    appliedRevision: 4,
    appliedOwnerId: 'writer-a',
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'writer-b',
  }).action, 'apply', 'a replacement writer must prove/apply the pair again');
});
