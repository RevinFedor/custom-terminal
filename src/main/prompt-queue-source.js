'use strict';

/**
 * Run After and Prompt Loop are two product modes of the same automatic
 * continuation pipeline.  Both must cross the same readiness, image and audit
 * admission boundaries.  Keep that identity in one predicate so a new label
 * cannot silently bypass the queue contract.
 */
function isPromptQueueSource(source) {
  if (typeof source !== 'string') return false;
  return source.includes('prompt-queue') || source.includes('prompt-loop');
}

function isPromptQueueAutomationSource(source, options = {}) {
  if (!isPromptQueueSource(source)) return false;
  // Origin is still Run After for image/audit ownership. The explicit click
  // means ordinary Send now, not the automatic promise to wait for idle.
  const origin = source.replace(/^(?:claude|codex)-/, '');
  return !(origin === 'prompt-queue' && options?.promptQueueAction === 'send-now');
}

function isPromptLoopAutomationSource(source) {
  if (typeof source !== 'string') return false;
  return source.replace(/^(?:claude|codex)-/, '') === 'prompt-loop';
}

module.exports = {
  isPromptQueueSource,
  isPromptQueueAutomationSource,
  isPromptLoopAutomationSource,
};
