'use strict';

// A picker result is an observation of one live PTY generation, not a setting
// persisted for the tab. Reads never open a picker or turn an intent into proof.
function createClaudeThinkingProofStore({ now = Date.now } = {}) {
  const proofs = new WeakMap();
  const validScope = scope => scope?.terminal
    && (typeof scope.terminal === 'object' || typeof scope.terminal === 'function')
    && Number.isSafeInteger(scope.runSeq) && scope.runSeq > 0
    && typeof scope.lifecycleGeneration === 'string' && !!scope.lifecycleGeneration
    && Number.isSafeInteger(scope.inputRevision) && scope.inputRevision >= 0;
  const publicProof = proof => ({
    source: 'native-thinking-picker', confirmedAt: proof.confirmedAt,
    sessionId: proof.sessionId, runSeq: proof.runSeq,
    lifecycleGeneration: proof.lifecycleGeneration, inputRevision: proof.inputRevision,
  });
  return {
    confirm(scope, thinking) {
      if (!validScope(scope) || typeof thinking !== 'boolean') return null;
      const proof = { thinking, confirmedAt: now(), sessionId: scope.sessionId || null,
        runSeq: scope.runSeq, lifecycleGeneration: scope.lifecycleGeneration, inputRevision: scope.inputRevision };
      proofs.set(scope.terminal, proof);
      return publicProof(proof);
    },
    read(scope) {
      const unknown = reason => ({ success: true, known: false, thinking: null,
        thinkingProof: null, lastConfirmedThinking: null, lastConfirmedAt: null, reason });
      if (!validScope(scope)) return unknown('runtime-scope-unavailable');
      if (scope.processAlive !== true) return unknown('process-inactive');
      const proof = proofs.get(scope.terminal);
      if (!proof) return unknown('thinking-not-observed');
      if (proof.runSeq !== scope.runSeq || proof.lifecycleGeneration !== scope.lifecycleGeneration
        || proof.sessionId !== (scope.sessionId || null)) return unknown('runtime-scope-changed');
      if (proof.inputRevision !== scope.inputRevision) {
        // Manual meta+t is not reflected in JSONL. Without another current
        // picker proof, input after the observation makes the value historical.
        return { ...unknown('input-changed-since-proof'), lastConfirmedThinking: proof.thinking,
          lastConfirmedAt: proof.confirmedAt };
      }
      return { success: true, known: true, thinking: proof.thinking,
        thinkingProof: publicProof(proof), lastConfirmedThinking: proof.thinking,
        lastConfirmedAt: proof.confirmedAt, reason: null };
    },
  };
}

module.exports = { createClaudeThinkingProofStore };
