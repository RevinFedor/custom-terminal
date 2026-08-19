'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCodexStopCapturedSettingsProof,
  classifyCodexStopSettingsCapture,
  validateCodexStopCapturedSettingsAuthority,
} = require('./codex-history-restart-settings-proof');

const base = {
  model: 'gpt-5.6-sol',
  effort: 'max',
  ownerKind: 'writer',
  ownerId: 'writer-a',
  lifecycleGeneration: 'lifecycle-a',
  runSeq: 7,
  inputRevision: 11,
  mirrorGeneration: 'mirror-a',
  committedFrameGeneration: 17,
  writeSeq: 31,
  observedAt: 1000,
};

test('builds persistent and conversation-only proofs from an exact composer frame', () => {
  const persistent = buildCodexStopCapturedSettingsProof(base);
  assert.equal(persistent.valid, true);
  assert.equal(persistent.proof.scope, 'persistent-default');

  const ultra = buildCodexStopCapturedSettingsProof({ ...base, effort: 'ultra' });
  assert.equal(ultra.valid, true);
  assert.equal(ultra.proof.scope, 'conversation-only');
  assert.equal(ultra.proof.effort, 'ultra');
});

test('requires complete owner, runtime generation, and committed-frame authority', () => {
  assert.equal(buildCodexStopCapturedSettingsProof({ ...base, ownerId: '' }).reason, 'owner-missing');
  assert.equal(buildCodexStopCapturedSettingsProof({ ...base, runSeq: 0 }).reason, 'runtime-generation-missing');
  assert.equal(buildCodexStopCapturedSettingsProof({ ...base, mirrorGeneration: '' }).reason, 'frame-authority-missing');
});

test('manual input, owner handoff, new run, and busy edge invalidate before signal', () => {
  const proof = buildCodexStopCapturedSettingsProof(base).proof;
  assert.equal(validateCodexStopCapturedSettingsAuthority(proof, {
    lifecycleGeneration: 'lifecycle-a', runSeq: 7, inputRevision: 11,
    mirrorGeneration: 'mirror-a', committedFrameGeneration: 17, writeSeq: 31,
    ownerKind: 'writer', ownerId: 'writer-a', model: 'gpt-5.6-sol', effort: 'max', turnBusy: false,
  }).valid, true);
  assert.equal(validateCodexStopCapturedSettingsAuthority(proof, {
    lifecycleGeneration: 'lifecycle-a', runSeq: 7, inputRevision: 12,
    mirrorGeneration: 'mirror-a', committedFrameGeneration: 17, writeSeq: 31,
    ownerKind: 'writer', ownerId: 'writer-a', model: 'gpt-5.6-sol', effort: 'max', turnBusy: false,
  }).reason, 'input-revision-changed');
  assert.equal(validateCodexStopCapturedSettingsAuthority(proof, {
    lifecycleGeneration: 'lifecycle-a', runSeq: 8, inputRevision: 11,
    mirrorGeneration: 'mirror-a', committedFrameGeneration: 17, writeSeq: 31,
    ownerKind: 'writer', ownerId: 'writer-a', model: 'gpt-5.6-sol', effort: 'max', turnBusy: false,
  }).reason, 'run-sequence-changed');
  assert.equal(validateCodexStopCapturedSettingsAuthority(proof, {
    lifecycleGeneration: 'lifecycle-a', runSeq: 7, inputRevision: 11,
    mirrorGeneration: 'mirror-a', committedFrameGeneration: 17, writeSeq: 31,
    ownerKind: 'writer', ownerId: 'writer-b', model: 'gpt-5.6-sol', effort: 'max', turnBusy: false,
  }).reason, 'settings-owner-changed');
  assert.equal(validateCodexStopCapturedSettingsAuthority(proof, {
    lifecycleGeneration: 'lifecycle-a', runSeq: 7, inputRevision: 11,
    mirrorGeneration: 'mirror-a', committedFrameGeneration: 17, writeSeq: 31,
    ownerKind: 'writer', ownerId: 'writer-a', model: 'gpt-5.6-sol', effort: 'max', turnBusy: true,
  }).reason, 'turn-became-busy');

  for (const [patch, reason] of [
    [{ mirrorGeneration: 'mirror-b' }, 'mirror-generation-changed'],
    [{ committedFrameGeneration: 18 }, 'committed-frame-changed'],
    [{ writeSeq: 32 }, 'terminal-output-changed'],
    [{ effort: 'ultra' }, 'composer-settings-changed'],
  ]) {
    assert.equal(validateCodexStopCapturedSettingsAuthority(proof, {
      lifecycleGeneration: 'lifecycle-a', runSeq: 7, inputRevision: 11,
      mirrorGeneration: 'mirror-a', committedFrameGeneration: 17, writeSeq: 31,
      ownerKind: 'writer', ownerId: 'writer-a', model: 'gpt-5.6-sol', effort: 'max', turnBusy: false,
      ...patch,
    }).reason, reason);
  }
});

test('capture admission rejects redraw replay and any nonempty or unknown draft', () => {
  const ready = {
    screenSuccess: true,
    destructiveProofAvailable: true,
    synchronizedOutputOpen: false,
    liveSynchronizedOutputOpen: false,
    committedFrameReplay: false,
    inspectedReady: true,
    terminalOwnerMatches: true,
    draftSuccess: true,
    draftHasDraft: false,
    draftSourceOwned: true,
    turnBusy: false,
    promptOrTurnInFlight: false,
    settingsProofValid: true,
  };
  assert.equal(classifyCodexStopSettingsCapture(ready).allowed, true);
  assert.equal(classifyCodexStopSettingsCapture({
    ...ready, synchronizedOutputOpen: true,
  }).reason, 'synchronized-output-open');
  assert.equal(classifyCodexStopSettingsCapture({
    ...ready, liveSynchronizedOutputOpen: true,
  }).reason, 'live-synchronized-output-open');
  assert.equal(classifyCodexStopSettingsCapture({
    ...ready, committedFrameReplay: true,
  }).reason, 'committed-frame-replay');
  assert.equal(classifyCodexStopSettingsCapture({
    ...ready, draftHasDraft: true,
  }).reason, 'terminal-draft-present');
  assert.equal(classifyCodexStopSettingsCapture({
    ...ready, draftHasDraft: null,
  }).reason, 'terminal-draft-unknown');
});
