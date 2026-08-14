import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAgentDraftCaptureResolution,
  buildExactDraftCaptureProof,
  classifyAgentDraftPreflight,
  classifyExactEmptyDraftGrab,
  resolveAgentDraftConflict,
} from './agentDraftPreflight.mjs';

test('exact capture proof carries renderer diagnostics without changing decision fields', () => {
  const rendererDiagnostic = {
    success: true,
    rendererGeneration: 'mirror-a',
    rendererWriteSeq: 42,
  };
  const proof = buildExactDraftCaptureProof({
    proofOutcome: 'found',
    inputRevision: 7,
    mirrorGeneration: 'mirror-a',
  }, rendererDiagnostic);
  assert.equal(proof.proofOutcome, 'found');
  assert.equal(proof.inputRevision, 7);
  assert.equal(proof.rendererDiagnostic, rendererDiagnostic);
});

test('current-frame found and absent proofs keep their exact decisions', () => {
  assert.equal(classifyAgentDraftPreflight({
    proofOutcome: 'found',
    hasDraft: true,
  }).decision, 'conflict');
  assert.equal(classifyAgentDraftPreflight({
    proofOutcome: 'absent',
    hasDraft: false,
  }).decision, 'clear');
});

test('unknown proof never becomes permission to send from source strings or busy state', () => {
  assert.deepEqual(classifyAgentDraftPreflight({
    proofOutcome: 'unknown',
    proofReason: 'terminal-or-input-generation-changed',
    hasDraft: null,
    source: 'headless-main:claude-composer:unknown:generation-changed',
  }), {
    decision: 'unknown',
    reason: 'terminal-or-input-generation-changed',
  });
  assert.equal(classifyAgentDraftPreflight({
    hasDraft: null,
    source: 'claude-composer:presence-not-live',
  }).decision, 'unknown');
});

test('successful empty Ctrl+G overrides a screen false-positive only through its owned revision transition', () => {
  const identity = {
    terminalRunSeq: 4,
    inputRevision: 9,
    terminalLifecycleGeneration: 'life:4',
    mirrorGeneration: 'mirror:4',
  };
  assert.deepEqual(classifyExactEmptyDraftGrab(
    { proofOutcome: 'found', hasDraft: true, ...identity },
    {
      success: true,
      text: '',
      images: 0,
      proofOutcome: 'absent',
      terminalIdentityStable: true,
      editorReturnReady: true,
      ...identity,
      inputRevision: 10,
      screenContradiction: true,
      inputRevisionTransition: 'ctrl-g-exact-capture',
      inputRevisionTransitionOwned: true,
      screenProofInputRevision: 9,
    },
  ), {
    confirmed: true,
    reason: 'exact-empty-grab-owned-input-transition',
  });

  assert.equal(classifyExactEmptyDraftGrab(
    { proofOutcome: 'found', hasDraft: true, ...identity },
    {
      success: true,
      text: '',
      images: 0,
      proofOutcome: 'absent',
      terminalIdentityStable: true,
      editorReturnReady: true,
      ...identity,
    },
  ).confirmed, false);

  assert.equal(classifyExactEmptyDraftGrab(
    { proofOutcome: 'found', hasDraft: true, ...identity },
    {
      success: true,
      text: '',
      images: 0,
      proofOutcome: 'absent',
      terminalIdentityStable: true,
      editorReturnReady: true,
      ...identity,
      inputRevision: 11,
      screenContradiction: true,
      inputRevisionTransition: 'ctrl-g-exact-capture',
      inputRevisionTransitionOwned: true,
      screenProofInputRevision: 9,
    },
  ).reason, 'screen-grab-identity-mismatch:inputRevision');
});

test('empty text without an exact successful Ctrl+G proof remains fail-closed', () => {
  assert.equal(classifyExactEmptyDraftGrab(
    {
      terminalRunSeq: 1,
      inputRevision: 1,
      terminalLifecycleGeneration: 'life',
      mirrorGeneration: 'mirror',
    },
    { success: true, text: '', images: 0 },
  ).confirmed, false);
});

test('shared send conflict coordinator proceeds only for the exact main-owned Ctrl+G transition', () => {
  const identity = {
    terminalRunSeq: 7,
    inputRevision: 12,
    terminalLifecycleGeneration: 'life:7',
    mirrorGeneration: 'mirror:7',
  };
  const proof = { proofOutcome: 'found', hasDraft: true, ...identity };
  assert.equal(resolveAgentDraftConflict(proof, {
    success: true,
    text: '',
    images: 0,
    proofOutcome: 'absent',
    terminalIdentityStable: true,
    editorReturnReady: true,
    ...identity,
    inputRevision: 13,
    screenContradiction: true,
    inputRevisionTransition: 'ctrl-g-exact-capture',
    inputRevisionTransitionOwned: true,
    screenProofInputRevision: 12,
  }, { attemptedCapture: true }).decision, 'clear');

  const realDraft = resolveAgentDraftConflict(proof, {
    success: true,
    text: 'keep me',
    images: 0,
    proofOutcome: 'found',
    terminalIdentityStable: true,
    editorReturnReady: false,
    ...identity,
  }, { attemptedCapture: true });
  assert.equal(realDraft.decision, 'conflict');
  assert.equal(realDraft.draftText, 'keep me');

  assert.equal(resolveAgentDraftConflict(proof, {
    success: false,
    error: 'helper unavailable',
  }, { attemptedCapture: true }).decision, 'capture-failed');
});

test('exact empty capture replaces the stale initial unknown before send continues', () => {
  const initial = {
    decision: 'unknown',
    reason: 'composer-content-after-cursor',
  };
  assert.deepEqual(applyAgentDraftCaptureResolution(initial, {
    decision: 'clear',
    reason: 'exact-empty-grab-owned-input-transition',
  }), {
    decision: 'clear',
    reason: 'exact-empty-grab-owned-input-transition',
  });
  assert.equal(applyAgentDraftCaptureResolution(initial, {
    decision: 'conflict',
    reason: 'grab-returned-draft',
  }), initial);
});
