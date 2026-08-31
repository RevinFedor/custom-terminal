'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCodexCompactUnconfirmedResult,
  inspectCodexCompactPostEnterFrame,
  planCodexCompactPostEnterAction,
} = require('./codex-compact-slash-submit');

function committedFrame(overrides = {}) {
  return {
    success: true,
    authoritativeFrameCommitted: true,
    synchronizedOutputOpen: false,
    writeSeq: 42,
    flushedSeq: 42,
    committedFrameGeneration: 9,
    ...overrides,
  };
}

function exactDraft(overrides = {}) {
  return {
    success: true,
    hasDraft: true,
    preview: '/compact',
    source: 'headless-main:cursor:17:draft',
    ...overrides,
  };
}

test('one-Enter autocomplete selection permits exactly one second Enter from a newer exact owned frame', () => {
  const frameProof = inspectCodexCompactPostEnterFrame({
    snapshot: committedFrame(),
    draftState: exactDraft(),
    afterWriteSeq: 41,
  });
  assert.equal(frameProof.owned, true);
  assert.deepEqual(planCodexCompactPostEnterAction({
    startConfirmed: false,
    identityCurrent: true,
    pendingCurrent: true,
    frameProof,
    allowSecondEnter: true,
  }), {
    action: 'second-enter',
    writeSecondEnter: true,
    success: false,
    reason: 'exact-owned-compact-still-in-composer',
  });

  const afterSecondEnter = planCodexCompactPostEnterAction({
    startConfirmed: true,
    identityCurrent: true,
    pendingCurrent: false,
    frameProof: null,
    allowSecondEnter: false,
  });
  assert.equal(afterSecondEnter.action, 'confirmed');
  assert.equal(afterSecondEnter.writeSecondEnter, false);
});

test('first Enter causal task_started wins and never permits a second Enter', () => {
  assert.deepEqual(planCodexCompactPostEnterAction({
    startConfirmed: true,
    identityCurrent: true,
    pendingCurrent: false,
    frameProof: inspectCodexCompactPostEnterFrame({
      snapshot: committedFrame(),
      draftState: exactDraft(),
      afterWriteSeq: 41,
    }),
    allowSecondEnter: true,
  }), {
    action: 'confirmed',
    writeSecondEnter: false,
    success: true,
    reason: 'causal-compact-task-started',
  });
});

test('manual takeover or generation change never permits the second Enter', () => {
  const frameProof = inspectCodexCompactPostEnterFrame({
    snapshot: committedFrame(),
    draftState: exactDraft(),
    afterWriteSeq: 41,
  });
  for (const identityReason of ['terminal-input-changed', 'terminal-generation-changed']) {
    const decision = planCodexCompactPostEnterAction({
      startConfirmed: false,
      identityCurrent: false,
      identityReason,
      pendingCurrent: true,
      frameProof,
      allowSecondEnter: true,
    });
    assert.equal(decision.writeSecondEnter, false);
    assert.equal(decision.reason, identityReason);
  }
});

test('stale, renderer-only, or changed draft cannot authorize a second Enter', () => {
  assert.equal(inspectCodexCompactPostEnterFrame({
    snapshot: committedFrame({ writeSeq: 41, flushedSeq: 41 }),
    draftState: exactDraft(),
    afterWriteSeq: 41,
  }).owned, false);
  assert.equal(inspectCodexCompactPostEnterFrame({
    snapshot: committedFrame(),
    draftState: exactDraft({ source: 'renderer' }),
    afterWriteSeq: 41,
  }).owned, false);
  assert.equal(inspectCodexCompactPostEnterFrame({
    snapshot: committedFrame(),
    draftState: exactDraft({ preview: '/compact user edit' }),
    afterWriteSeq: 41,
  }).owned, false);
});

test('an Enter without causal compact start is explicit delivery-unknown, never SENT', () => {
  assert.deepEqual(buildCodexCompactUnconfirmedResult({
    reason: 'codex_compact_start_unconfirmed',
    enterCount: 1,
  }), {
    success: false,
    error: 'codex_compact_start_unconfirmed',
    submitted: true,
    slashInserted: true,
    compactStartConfirmed: false,
    deliveryUnconfirmed: true,
    compactEnterCount: 1,
    manualTakeover: false,
    admissionRejected: false,
    postEnterProof: null,
  });
});
