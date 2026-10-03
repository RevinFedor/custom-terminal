'use strict';

function identityUnavailable(code = 'message_runtime_identity_unavailable') {
  return Object.assign(new Error('The current conversation identity is not proven; input was not touched.'), {
    code, statusCode: 503, submitted: false,
  });
}

function messageRuntimeIdentity(descriptor, snapshot) {
  if (!descriptor) return null;
  if (!snapshot || snapshot.coherent !== true) throw identityUnavailable();
  const status = snapshot.status || snapshot.sessionStatus;
  if (!status || status === 'unknown') throw identityUnavailable();
  const destination = snapshot.sendTarget;
  const provider = destination?.toolType || snapshot.toolType;
  if (!['claude', 'codex'].includes(provider)
    || (snapshot.toolType && snapshot.toolType !== provider)) throw identityUnavailable('message_runtime_provider_unavailable');
  const stopped = status === 'inactive' && snapshot.canResume === true;
  const sessionId = stopped ? snapshot.sessionId : destination?.sessionId;
  let sendTarget;
  if (sessionId) sendTarget = { toolType: provider, sessionId };
  else if (destination?.terminalInstanceId && destination?.launchId) {
    // A live first-turn source has no session yet. Its exact accepted launch
    // owns the future first message; pinning just the provider would retarget it.
    sendTarget = { toolType: provider, terminalInstanceId: destination.terminalInstanceId,
      launchId: destination.launchId };
  } else throw identityUnavailable();
  return { ...descriptor, provider, sessionId: sessionId || null, sendTarget,
    acceptedResumeSourceSessionId: destination?.acceptedResumeSourceSessionId || null };
}

function scenarioDestination(snapshot) {
  if (!snapshot || snapshot.coherent !== true) throw identityUnavailable();
  if (snapshot.status === 'inactive' && snapshot.canResume === true && snapshot.sessionId) {
    return { toolType: snapshot.toolType, sessionId: snapshot.sessionId };
  }
  if (!snapshot.sendTarget?.toolType) throw identityUnavailable();
  return snapshot.sendTarget;
}

module.exports = { messageRuntimeIdentity, scenarioDestination, identityUnavailable };
