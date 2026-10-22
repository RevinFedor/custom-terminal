'use strict';

// Existing provider readers retain source authority. The restart owner only
// composes their exact identities; a live generation is never historical proof.
async function readBuildContinueOriginal(target, state, { readObserved, readClaude }) {
  if (target.source.provider === 'codex') {
    const response = await readObserved({ tabId: target.source.tabId, expectedSessionId: state.sessionId,
      subject: { kind: 'codex-historical-execution', toolType: 'codex', sessionId: state.sessionId,
        targetExecutionContext: { ...target.subject.targetExecutionContext, generation: null, processId: null } }, maxChars: 500 });
    return response?.result || { found: false, sourceVerified: false, error: response?.code || response?.error };
  }
  return readClaude({ toolType: 'claude', sessionId: target.source.sessionId, cwd: target.source.cwd,
    targetExecutionContext: target.subject.targetExecutionContext, promptUserUuid: target.subject.providerPromptId,
    forceFresh: true, resultReadMode: 'source-proof', maxChars: 500 });
}

function capturedCodexSubject(view) {
  const context = view?.executionContext;
  if (view?.known !== true || view.busy !== true || view.toolType !== 'codex'
    || context?.provider !== 'codex' || context.sessionId !== view.sessionId || !context.turnId
    || !Number.isSafeInteger(context.generation) || context.generation <= 0) return null;
  return { kind: 'codex-execution', toolType: 'codex', sessionId: view.sessionId,
    targetExecutionContext: { ...context } };
}

module.exports = { readBuildContinueOriginal, capturedCodexSubject };
