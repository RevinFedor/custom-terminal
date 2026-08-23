import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CTRL_SWITCHER_STALE_INPUT_MS,
  inputEventAbsoluteTime,
  inputEventDelayMs,
  shouldCoalesceCtrlSwitcherRetry,
  shouldDeferCtrlSwitcherCommit,
} from './tabSwitcherInputCoalescing.mjs';

test('relative and epoch keyboard timestamps produce the same absolute delay', () => {
  assert.equal(inputEventAbsoluteTime(700, 1000), 1700);
  assert.equal(inputEventAbsoluteTime(1_787_499_852_707, 1000), 1_787_499_852_707);
  assert.equal(inputEventDelayMs({ eventTimeStamp: 700, timeOrigin: 1000, receivedAbs: 1875 }), 175);
});

test('only stale pre-paint delivery waits for a feedback frame', () => {
  assert.equal(shouldDeferCtrlSwitcherCommit({
    inputDelayMs: CTRL_SWITCHER_STALE_INPUT_MS - 1,
    feedbackPainted: false,
  }), false);
  assert.equal(shouldDeferCtrlSwitcherCommit({
    inputDelayMs: CTRL_SWITCHER_STALE_INPUT_MS,
    feedbackPainted: false,
  }), true);
  assert.equal(shouldDeferCtrlSwitcherCommit({
    inputDelayMs: 2000,
    feedbackPainted: true,
  }), false);
});

test('retry coalesces only after the first release is pending and before paint', () => {
  assert.equal(shouldCoalesceCtrlSwitcherRetry({ commitPending: false, feedbackPainted: false }), false);
  assert.equal(shouldCoalesceCtrlSwitcherRetry({ commitPending: true, feedbackPainted: false }), true);
  assert.equal(shouldCoalesceCtrlSwitcherRetry({ commitPending: true, feedbackPainted: true }), false);
});
