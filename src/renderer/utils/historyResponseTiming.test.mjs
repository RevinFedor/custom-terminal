import test from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedHistoryResponseDurationMs,
  formatHistoryResponseDuration,
  historyResponseTailLabel,
  latestCompletedHistoryResponseTiming,
  normalizeHistoryResponseDurationMs,
  resolveHistoryResponseTailTiming,
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

test('tail wording distinguishes a live response from a completed response', () => {
  assert.equal(historyResponseTailLabel({
    state: 'running',
    startTs: 1_000,
  }, 66_000), 'Working · 01:05');
  assert.equal(historyResponseTailLabel({
    state: 'completed',
    durationMs: 65_000,
  }), 'Worked for 01:05');
});

test('latest completed timing belongs to the newest final assistant response', () => {
  const timing = { intervalId: 7, startTs: 1_000, endTs: 4_000, durationMs: 3_000 };
  assert.deepEqual(latestCompletedHistoryResponseTiming([
    { role: 'assistant', content: 'older', responseTiming: timing },
    { role: 'assistant', content: 'caption', textPhase: 'commentary' },
  ]), { ...timing, state: 'completed' });

  assert.equal(latestCompletedHistoryResponseTiming([
    { role: 'assistant', content: 'older', responseTiming: timing },
    { role: 'assistant', content: 'newer answer without a timing' },
  ]), null, 'an older duration must not be shown under a newer response');
});

test('live and pending activity own the tail before durable transcript timing', () => {
  const durable = {
    role: 'assistant',
    content: 'previous response',
    responseTiming: { intervalId: 2, startTs: 1_000, endTs: 2_000, durationMs: 1_000 },
  };
  assert.equal(resolveHistoryResponseTailTiming({
    state: 'running',
    startTs: 10_000,
  }, [durable])?.state, 'running');
  assert.deepEqual(resolveHistoryResponseTailTiming({
    state: 'pending',
    intervalId: 3,
    startTs: 10_000,
    endTs: 14_000,
    durationMs: 4_000,
  }, [durable]), {
    state: 'completed',
    intervalId: 3,
    startTs: 10_000,
    endTs: 14_000,
    durationMs: 4_000,
  });
});
