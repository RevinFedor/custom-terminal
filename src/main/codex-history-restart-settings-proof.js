'use strict';

const clean = (value) => typeof value === 'string' ? value.trim() : '';
const positiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
const nonNegativeInteger = (value) => Number.isInteger(Number(value)) && Number(value) >= 0;

function buildCodexStopCapturedSettingsProof(input = {}) {
  const model = clean(input.model);
  const effort = clean(input.effort).toLowerCase();
  const ownerKind = input.ownerKind === 'writer' || input.ownerKind === 'launch'
    ? input.ownerKind
    : '';
  const ownerId = clean(input.ownerId);
  const lifecycleGeneration = clean(input.lifecycleGeneration);
  const mirrorGeneration = clean(input.mirrorGeneration);
  if (!model || !effort) return { valid: false, reason: 'settings-missing' };
  if (!ownerKind || !ownerId) return { valid: false, reason: 'owner-missing' };
  if (!lifecycleGeneration || !positiveInteger(input.runSeq)) {
    return { valid: false, reason: 'runtime-generation-missing' };
  }
  if (!nonNegativeInteger(input.inputRevision)
    || !nonNegativeInteger(input.committedFrameGeneration)
    || !positiveInteger(input.writeSeq)
    || !mirrorGeneration) {
    return { valid: false, reason: 'frame-authority-missing' };
  }
  const observedAt = Number(input.observedAt);
  return {
    valid: true,
    proof: {
      kind: 'codex-stop-captured-settings',
      model,
      effort,
      scope: effort === 'ultra' ? 'conversation-only' : 'persistent-default',
      owner: { kind: ownerKind, id: ownerId },
      observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
      authority: {
        lifecycleGeneration,
        runSeq: Number(input.runSeq),
        inputRevision: Number(input.inputRevision),
        mirrorGeneration,
        committedFrameGeneration: Number(input.committedFrameGeneration),
        writeSeq: Number(input.writeSeq),
      },
    },
  };
}

function validateCodexStopCapturedSettingsAuthority(proof, current = {}) {
  if (!proof || proof.kind !== 'codex-stop-captured-settings') {
    return { valid: false, reason: 'proof-missing' };
  }
  if (clean(current.lifecycleGeneration) !== proof.authority.lifecycleGeneration) {
    return { valid: false, reason: 'lifecycle-generation-changed' };
  }
  if (Number(current.runSeq) !== proof.authority.runSeq) {
    return { valid: false, reason: 'run-sequence-changed' };
  }
  if (Number(current.inputRevision) !== proof.authority.inputRevision) {
    return { valid: false, reason: 'input-revision-changed' };
  }
  if (clean(current.mirrorGeneration) !== proof.authority.mirrorGeneration) {
    return { valid: false, reason: 'mirror-generation-changed' };
  }
  if (Number(current.committedFrameGeneration) !== proof.authority.committedFrameGeneration) {
    return { valid: false, reason: 'committed-frame-changed' };
  }
  if (Number(current.writeSeq) !== proof.authority.writeSeq) {
    return { valid: false, reason: 'terminal-output-changed' };
  }
  if (clean(current.ownerKind) !== proof.owner.kind || clean(current.ownerId) !== proof.owner.id) {
    return { valid: false, reason: 'settings-owner-changed' };
  }
  if (clean(current.model) !== proof.model || clean(current.effort).toLowerCase() !== proof.effort) {
    return { valid: false, reason: 'composer-settings-changed' };
  }
  if (current.turnBusy === true) return { valid: false, reason: 'turn-became-busy' };
  return { valid: true, reason: 'exact-stop-settings-authority' };
}

function classifyCodexStopSettingsCapture(input = {}) {
  if (input.screenSuccess !== true) return { allowed: false, reason: input.screenError || 'screen-unavailable' };
  if (input.destructiveProofAvailable !== true) return { allowed: false, reason: 'committed-headless-frame-unavailable' };
  if (input.synchronizedOutputOpen === true) return { allowed: false, reason: 'synchronized-output-open' };
  if (input.liveSynchronizedOutputOpen === true) return { allowed: false, reason: 'live-synchronized-output-open' };
  if (input.committedFrameReplay === true) return { allowed: false, reason: 'committed-frame-replay' };
  if (input.inspectedReady !== true) return { allowed: false, reason: input.inspectedReason || 'composer-not-ready' };
  if (input.terminalOwnerMatches !== true) return { allowed: false, reason: 'terminal-owner-changed' };
  if (input.draftSuccess !== true || input.draftHasDraft === null || input.draftHasDraft === undefined) {
    return { allowed: false, reason: 'terminal-draft-unknown' };
  }
  if (input.draftHasDraft === true) return { allowed: false, reason: 'terminal-draft-present' };
  if (input.draftSourceOwned !== true) return { allowed: false, reason: 'terminal-draft-source-unowned' };
  if (input.turnBusy === true || input.promptOrTurnInFlight === true) {
    return { allowed: false, reason: 'turn-or-prompt-in-flight' };
  }
  if (input.settingsProofValid !== true) return { allowed: false, reason: input.settingsProofReason || 'settings-proof-invalid' };
  return { allowed: true, reason: 'exact-committed-empty-composer-settings' };
}

module.exports = {
  buildCodexStopCapturedSettingsProof,
  classifyCodexStopSettingsCapture,
  validateCodexStopCapturedSettingsAuthority,
};
