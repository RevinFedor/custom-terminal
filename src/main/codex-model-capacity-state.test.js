'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CODEX_MODEL_CAPACITY_CODE,
  decideCodexModelCapacityObservation,
  inspectCodexModelCapacityFrame,
} = require('./codex-model-capacity-state');

function committedFrame({ warning = true, highlighted = true, composer = true } = {}) {
  const lines = [
    { row: 90, text: '• Ran 8 commands', hasNonDefaultFg: true },
  ];
  if (warning) {
    lines.push({
      row: 91,
      text: '⚠ Selected model is at capacity. Please try a different model.',
      hasNonDefaultFg: highlighted,
    });
  }
  lines.push({ row: 92, text: '─ Conversation recap ─', hasNonDefaultFg: false });
  if (composer) {
    lines.push(
      { row: 96, text: '› Ask Codex to do anything', hasNonDefaultFg: true },
      { row: 97, text: 'gpt-5.6-sol max · Context 21% used', hasNonDefaultFg: true },
    );
  }
  return {
    success: true,
    authoritativeFrameCommitted: true,
    liveSynchronizedOutputOpen: false,
    writeSeq: 12,
    flushedSeq: 12,
    lines,
  };
}

test('capacity requires the exact highlighted sentence and a ready composer in one committed frame', () => {
  const capacity = inspectCodexModelCapacityFrame(committedFrame());
  assert.equal(capacity.capacity, true);
  assert.equal(capacity.code, CODEX_MODEL_CAPACITY_CODE);

  const repeated = committedFrame();
  repeated.lines.unshift({
    row: 40,
    text: '⚠ Selected model is at capacity. Please try a different model.',
    hasNonDefaultFg: true,
  });
  assert.equal(inspectCodexModelCapacityFrame(repeated).startRow, 91,
    'the newest repeated capacity row owns the outcome');

  assert.equal(inspectCodexModelCapacityFrame(committedFrame({ highlighted: false })).capacity, false);
  assert.equal(inspectCodexModelCapacityFrame(committedFrame({ composer: false })).capacity, false);
  assert.equal(inspectCodexModelCapacityFrame({
    ...committedFrame(),
    authoritativeFrameCommitted: false,
  }).capacity, false);
});

test('an old capacity line in the baseline cannot terminate the next request', () => {
  const capacity = inspectCodexModelCapacityFrame(committedFrame());
  assert.deepEqual(decideCodexModelCapacityObservation({
    identityCurrent: true,
    committedFrameGeneration: 11,
    armedCommittedFrameGeneration: 10,
    capacity,
    baselineFingerprint: capacity.fingerprint,
    baselineStartRow: capacity.startRow,
    sawNonCapacityFrame: false,
  }), {
    action: 'wait',
    reason: 'capacity-only-in-baseline-scrollback',
  });

  assert.deepEqual(decideCodexModelCapacityObservation({
    identityCurrent: true,
    committedFrameGeneration: 12,
    armedCommittedFrameGeneration: 10,
    capacity,
    baselineFingerprint: capacity.fingerprint,
    baselineStartRow: capacity.startRow,
    sawNonCapacityFrame: true,
  }), {
    action: 'accept',
    reason: 'fresh-capacity-with-ready-composer',
  });

  assert.equal(decideCodexModelCapacityObservation({
    identityCurrent: true,
    committedFrameGeneration: 12,
    armedCommittedFrameGeneration: 10,
    capacity: { ...capacity, startRow: Number(capacity.startRow) + 20 },
    baselineFingerprint: capacity.fingerprint,
    baselineStartRow: capacity.startRow,
    sawNonCapacityFrame: false,
  }).action, 'accept', 'the same sentence on a newer terminal row is a new provider outcome');
});

test('capacity proof is bound to the exact terminal attempt and a newer frame', () => {
  const capacity = inspectCodexModelCapacityFrame(committedFrame());
  assert.equal(decideCodexModelCapacityObservation({
    identityCurrent: false,
    committedFrameGeneration: 12,
    armedCommittedFrameGeneration: 10,
    capacity,
  }).action, 'cancel');
  assert.equal(decideCodexModelCapacityObservation({
    identityCurrent: true,
    committedFrameGeneration: 10,
    armedCommittedFrameGeneration: 10,
    capacity,
  }).action, 'wait');
  assert.equal(decideCodexModelCapacityObservation({
    identityCurrent: true,
    committedFrameGeneration: 11,
    armedCommittedFrameGeneration: 10,
    capacity: { capacity: false, reason: 'capacity-surface-absent' },
  }).action, 'observe-non-capacity');
});
