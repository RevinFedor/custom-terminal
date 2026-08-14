import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldDisarmAfterTriggerClear } from './runAfterTriggerClear.mjs';

test('single item: clearing its trigger switches Run after off', () => {
  // Nothing is left holding a condition, so an armed queue would fire on the
  // next plain turn end — the opposite of "I removed the condition".
  assert.equal(shouldDisarmAfterTriggerClear({ runnableCount: 1 }), true);
});

test('two items: Run after keeps working exactly as it was', () => {
  // The user's rule, verbatim: «если два пункта и первый без таймера, то Run
  // after продолжает работать как работал».
  assert.equal(shouldDisarmAfterTriggerClear({ runnableCount: 2 }), false);
  assert.equal(shouldDisarmAfterTriggerClear({ runnableCount: 5 }), false);
});

test('an empty queue also lands off, never armed-with-nothing', () => {
  assert.equal(shouldDisarmAfterTriggerClear({ runnableCount: 0 }), true);
});

test('an unusable count never disarms', () => {
  // A missing count must not be read as "empty" — that would switch the queue
  // off on a render glitch.
  assert.equal(shouldDisarmAfterTriggerClear({ runnableCount: undefined }), false);
  assert.equal(shouldDisarmAfterTriggerClear({ runnableCount: NaN }), false);
});
