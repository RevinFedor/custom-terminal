import test from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedHistoryResponseDurationMs,
  formatHistoryResponseDuration,
  normalizeHistoryResponseDurationMs,
} from './historyResponseTiming.mjs';

test('response duration formatter uses mm:ss below an hour and h:mm:ss afterwards', () => {
  assert.equal(formatHistoryResponseDuration(0), '00:00');
  assert.equal(formatHistoryResponseDuration(65_999), '01:05');
  assert.equal(formatHistoryResponseDuration(3_661_900), '1:01:01');
});

test('running timing derives elapsed wall-clock duration from the app interval start', () => {
  assert.equal(elapsedHistoryResponseDurationMs({
    state: 'running',
    startTs: 1_000,
  }, 5_250), 4_250);
});

test('pending and durable durations are frozen and invalid values fail closed', () => {
  assert.equal(elapsedHistoryResponseDurationMs({
    state: 'pending',
    durationMs: 8_500,
  }, 99_000), 8_500);
  assert.equal(normalizeHistoryResponseDurationMs(-1), 0);
  assert.equal(normalizeHistoryResponseDurationMs(Number.NaN), 0);
});
