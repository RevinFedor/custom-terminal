'use strict';

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

module.exports = {
  nextCodexModelEffortIntent,
  planCodexModelEffortIntentReconcile,
};
