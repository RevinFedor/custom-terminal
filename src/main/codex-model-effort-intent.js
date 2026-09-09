'use strict';

const { isCodexSettingsApplicationProven } = require('./codex-runtime-contract');

const clean = (value) => typeof value === 'string' ? value.trim() : '';

function nextCodexModelEffortIntent({
  currentModel,
  currentEffort,
  currentRevision,
  model,
  effort,
} = {}) {
  const desiredModel = clean(model);
  const desiredEffort = clean(effort).toLowerCase();
  if (!desiredModel || !desiredEffort) {
    return { valid: false, reason: 'model-effort-intent-incomplete' };
  }
  const previousRevision = Number(currentRevision || 0);
  const samePair = clean(currentModel) === desiredModel
    && clean(currentEffort).toLowerCase() === desiredEffort
    && Number.isInteger(previousRevision)
    && previousRevision > 0;
  return {
    valid: true,
    changed: !samePair,
    model: desiredModel,
    effort: desiredEffort,
    revision: samePair ? previousRevision : (
      Number.isInteger(previousRevision) && previousRevision > 0
        ? previousRevision + 1
        : 1
    ),
  };
}

function planCodexModelEffortIntentReconcile({
  model,
  effort,
  revision,
  appliedRevision,
  appliedOwnerId,
  writerOwnerId,
  processRunning,
  tuiReady,
} = {}) {
  const desiredModel = clean(model);
  const desiredEffort = clean(effort).toLowerCase();
  const desiredRevision = Number(revision || 0);
  if (!desiredModel || !desiredEffort
    || !Number.isInteger(desiredRevision)
    || desiredRevision <= 0) {
    return { action: 'none', reason: 'intent-missing' };
  }
  if (processRunning !== true) {
    return { action: 'queue', reason: 'process-not-running' };
  }
  const writer = clean(writerOwnerId);
  if (!writer) {
    return { action: 'queue', reason: 'writer-not-adopted' };
  }
  if (tuiReady !== true) {
    return { action: 'queue', reason: 'tui-not-ready' };
  }
  if (Number(appliedRevision) === desiredRevision
    && clean(appliedOwnerId) === writer) {
    return {
      action: 'settled',
      reason: 'intent-applied-to-current-writer',
      model: desiredModel,
      effort: desiredEffort,
      revision: desiredRevision,
      writerOwnerId: writer,
    };
  }
  return {
    action: 'apply',
    reason: 'intent-awaits-current-writer',
    model: desiredModel,
    effort: desiredEffort,
    revision: desiredRevision,
    writerOwnerId: writer,
  };
}

function planCodexModelEffortIntentOwnerHandoff({
  model,
  effort,
  revision,
  appliedRevision,
  appliedOwnerId,
  launchOwnerId,
  writerOwnerId,
  provenModel,
  provenEffort,
} = {}) {
  const desiredModel = clean(model);
  const desiredEffort = clean(effort).toLowerCase();
  const fromOwner = clean(launchOwnerId);
  const toOwner = clean(writerOwnerId);
  if (!desiredModel || !desiredEffort || !fromOwner || !toOwner) {
    return { transfer: false, reason: 'owner-handoff-incomplete' };
  }
  if (Number(appliedRevision) !== Number(revision) || clean(appliedOwnerId) !== fromOwner) {
    return { transfer: false, reason: 'intent-not-applied-to-launch-owner' };
  }
  if (clean(provenModel) !== desiredModel
    || clean(provenEffort).toLowerCase() !== desiredEffort) {
    return { transfer: false, reason: 'writer-settings-proof-mismatch' };
  }
  return {
    transfer: true,
    reason: 'exact-launch-owner-adopted-by-writer',
    fromOwnerId: fromOwner,
    toOwnerId: toOwner,
  };
}

function codexModelEffortIntentApplicationProven(intent, result) {
  // A preserved-draft error does not undo a proven native model selection.
  // Conversely, echoing the requested UI pair is not evidence of application.
  const proofSource = clean(result?.applicationProofSource || result?.configProofSource);
  const nativeProof = proofSource.startsWith('config:')
    || ['tui-model-ack', 'tui-conversation-ack'].includes(proofSource);
  return isCodexSettingsApplicationProven(result)
    && nativeProof
    && result?.effortSkipped !== true
    && !!clean(intent?.model)
    && !!clean(intent?.effort)
    && clean(result?.model) === clean(intent.model)
    && clean(result?.effort).toLowerCase() === clean(intent.effort).toLowerCase();
}

function planCodexNativeModelEffortIntent(current, observation) {
  if (!observation?.scope?.ownerId
    || Number(current?.revision || 0) !== Number(observation.intentRevision)
    || Number(current?.actionSequence || 0) !== Number(observation.intentActionSequence)) {
    return { valid: false, reason: 'newer-intent-present' };
  }
  if (!['tui-model-ack', 'tui-conversation-ack'].includes(observation.proof)
    || (observation.effort === 'ultra' && observation.applicationMode !== 'conversation-only')) {
    return { valid: false, reason: 'native-setting-proof-missing' };
  }
  return nextCodexModelEffortIntent({
    currentModel: current?.model, currentEffort: current?.effort,
    currentRevision: current?.revision, model: observation.model, effort: observation.effort,
  });
}

module.exports = {
  planCodexNativeModelEffortIntent,
  codexModelEffortIntentApplicationProven,
  nextCodexModelEffortIntent,
  planCodexModelEffortIntentOwnerHandoff,
  planCodexModelEffortIntentReconcile,
};
