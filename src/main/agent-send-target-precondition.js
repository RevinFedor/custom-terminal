'use strict';

// A callback targets a conversation, not whichever conversation happens to
// occupy its tab later. Resume may create a new physical writer: only the
// provider's current accepted launch proof may authorize that source -> writer
// transition. Saved sibling/provider fields are never such proof.
function agentSendTargetPreconditionFailure(expected, actual) {
  if (!expected?.sessionId && !expected?.toolType) return null;
  const providerMatches = !expected.toolType || expected.toolType === actual?.toolType;
  const sessionMatches = !expected.sessionId || expected.sessionId === actual?.sessionId
    || expected.sessionId === actual?.acceptedResumeSourceSessionId;
  const generationMatches = !expected.lifecycleGeneration || !Object.hasOwn(actual || {}, 'lifecycleGeneration')
    || expected.lifecycleGeneration === actual.lifecycleGeneration;
  const turnMatches = !expected.turnId || !Object.hasOwn(actual || {}, 'turnId')
    || expected.turnId === actual.turnId;
  if (providerMatches && sessionMatches && generationMatches && turnMatches) return null;
  return {
    success: false,
    accepted: false,
    submitted: false,
    pasteWritten: false,
    enterWritten: false,
    status: 'not-submitted',
    code: 'agent_send_target_changed',
    error: 'The target conversation changed before submission; input was not touched.',
    httpStatus: 409,
  };
}

module.exports = { agentSendTargetPreconditionFailure };
