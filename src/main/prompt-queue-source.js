'use strict';

/**
 * Run After and Prompt Loop are two product modes of the same automatic
 * continuation pipeline.  Both must cross the same readiness, image and audit
 * admission boundaries.  Keep that identity in one predicate so a new label
 * cannot silently bypass the queue contract.
 */
function isPromptQueueAutomationSource(source) {
  if (typeof source !== 'string') return false;
  return source.includes('prompt-queue') || source.includes('prompt-loop');
}

module.exports = {
  isPromptQueueAutomationSource,
};
