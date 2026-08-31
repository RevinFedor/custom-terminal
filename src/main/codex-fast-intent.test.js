'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextCodexFastIntent,
  planCodexFastIntentReconcile,
} = require('./codex-fast-intent');

test('first Fast click enables it and later clicks toggle the saved intent', () => {
  assert.equal(nextCodexFastIntent({ currentIntent: null, serviceTier: null }), true);
  assert.equal(nextCodexFastIntent({ currentIntent: null, serviceTier: 'priority' }), false);
  assert.equal(nextCodexFastIntent({ currentIntent: true, serviceTier: 'default' }), false);
  assert.equal(nextCodexFastIntent({ currentIntent: false, serviceTier: 'priority' }), true);
});

test('stopped and starting Codex queue the desired Fast state', () => {
  assert.equal(planCodexFastIntentReconcile({
    desiredFast: true,
    revision: 1,
    processRunning: false,
    tuiReady: false,
  }).action, 'queue');
  assert.equal(planCodexFastIntentReconcile({
    desiredFast: false,
    revision: 2,
    processRunning: true,
    tuiReady: false,
  }).reason, 'tui-not-ready');
});

test('ready Codex toggles only when exact service tier differs', () => {
  assert.equal(planCodexFastIntentReconcile({
    desiredFast: true,
    revision: 3,
    processRunning: true,
    tuiReady: true,
    serviceTier: 'priority',
  }).action, 'settled');
  assert.deepEqual(planCodexFastIntentReconcile({
    desiredFast: false,
    revision: 4,
    processRunning: true,
    tuiReady: true,
    serviceTier: 'priority',
  }), {
    action: 'toggle',
    reason: 'desired-tier-differs',
    desiredFast: false,
    serviceTier: 'priority',
  });
  assert.equal(planCodexFastIntentReconcile({
    desiredFast: true,
    revision: 5,
    processRunning: true,
    tuiReady: true,
    serviceTier: null,
  }).reason, 'service-tier-unproven');
});
