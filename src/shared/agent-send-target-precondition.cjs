'use strict';

// Shared by renderer readiness and the authoritative main write boundary.
// acceptedResumeSourceSessionId is supplied by main's exact CURRENT launch
// proof, never by generic lineage or a saved/history session hint.
function agentSendTargetPreconditionFailure(expected, actual) {
  if (!expected?.sessionId && !expected?.toolType) return null;
  const providerMatches = !expected.toolType || expected.toolType === actual?.toolType;
  const sessionMatches = !expected.sessionId || expected.sessionId === actual?.sessionId
    || expected.sessionId === actual?.acceptedResumeSourceSessionId;
  const generationMatches = !expected.lifecycleGeneration || !Object.hasOwn(actual || {}, 'lifecycleGeneration')
    || expected.lifecycleGeneration === actual.lifecycleGeneration;
  const turnMatches = !expected.turnId || !Object.hasOwn(actual || {}, 'turnId')
    || expected.turnId === actual.turnId;
  const instanceMatches = !expected.terminalInstanceId || expected.terminalInstanceId === actual?.terminalInstanceId;
  const launchMatches = !expected.launchId || expected.launchId === actual?.launchId;
  if (providerMatches && sessionMatches && generationMatches && turnMatches && instanceMatches && launchMatches) return null;
  return {
    success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
    status: 'not-submitted', code: 'agent_send_target_changed',
    error: 'The target conversation changed before submission; input was not touched.', httpStatus: 409,
  };
}

function createAgentSendTargetExpectation(toolType, sessionId) {
  const targetSession = typeof sessionId === 'string' ? sessionId.trim() : '';
  return Object.freeze({ toolType, ...(targetSession ? { sessionId: targetSession } : {}) });
}

function resolveReadyAgentSendTarget(expected, presence, toolType) {
  const actual = presence?.sendTarget || presence?.runtimeSnapshot?.sendTarget
    || { toolType, sessionId: presence?.sessionId || null };
  // A first prompt or provisional Resume can be input-ready before public
  // writer identity exists. Keep the original expectation for main's later
  // authoritative admission instead of replacing it with a history hint or
  // denying an otherwise supported first-turn/background send.
  const failure = agentSendTargetPreconditionFailure(
    actual?.sessionId ? expected : { ...expected, sessionId: null }, actual,
  );
  if (failure) throw Object.assign(new Error(failure.error), failure);
  const provisionalLaunchScope = !actual?.sessionId && actual?.terminalInstanceId && actual?.launchId;
  return Object.freeze({
    ...expected,
    ...(!expected.sessionId && actual?.sessionId ? { sessionId: actual.sessionId } : {}),
    ...(actual?.terminalInstanceId ? { terminalInstanceId: expected.terminalInstanceId || actual.terminalInstanceId } : {}),
    ...(actual?.launchId ? { launchId: expected.launchId || actual.launchId } : {}),
    // A first OSC-B may advance runSeq after provisional TUI readiness without
    // replacing this accepted launch. Preserve its exact instance/launch, not
    // an incidental pre-OSC run alias. Known writers retain the stronger check.
    ...(!provisionalLaunchScope && actual?.lifecycleGeneration ? { lifecycleGeneration: actual.lifecycleGeneration } : {}),
  });
}

module.exports = { agentSendTargetPreconditionFailure, createAgentSendTargetExpectation, resolveReadyAgentSendTarget };
