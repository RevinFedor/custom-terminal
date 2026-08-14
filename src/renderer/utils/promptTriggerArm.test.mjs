import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldArmQueueForTrigger } from './promptTriggerArm.mjs';

test('naming another tab on the next card arms the queue', () => {
  assert.equal(
    shouldArmQueueForTrigger({ trigger: { kind: 'onTab', tabId: 'tab-b' }, isHead: true }),
    true,
  );
});

test('an idle target arms just the same — "no loader" is not "nothing to wait for"', () => {
  // The rule cannot consult runtime state at all: whether the target is busy
  // right now is exactly the thing the user is asking us to wait for.
  assert.equal(
    shouldArmQueueForTrigger({ trigger: { kind: 'onTab', tabId: 'idle-tab' }, isHead: true }),
    true,
  );
});

test('a timer does not arm — the field is still being typed into', () => {
  assert.equal(
    shouldArmQueueForTrigger({ trigger: { kind: 'timer', seconds: 1800 }, isHead: true }),
    false,
  );
});

test('a later card never arms — the HEAD would fire on its own terms', () => {
  assert.equal(
    shouldArmQueueForTrigger({ trigger: { kind: 'onTab', tabId: 'tab-b' }, isHead: false }),
    false,
  );
});

test('clearing a condition is the opposite intent and never arms', () => {
  assert.equal(shouldArmQueueForTrigger({ trigger: null, isHead: true }), false);
  assert.equal(shouldArmQueueForTrigger({ trigger: undefined, isHead: true }), false);
});

test('a malformed onTab without a tab id does not arm', () => {
  assert.equal(shouldArmQueueForTrigger({ trigger: { kind: 'onTab' }, isHead: true }), false);
  assert.equal(shouldArmQueueForTrigger({ trigger: { kind: 'onTab', tabId: '' }, isHead: true }), false);
});
