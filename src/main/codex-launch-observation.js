'use strict';

function planCodexLaunchObservation(command, sessionId) {
  const normalizedCommand = command || 'codex';
  const sourceSessionId = sessionId || null;

  if (normalizedCommand === 'codex-c' && sourceSessionId) {
    return {
      mode: 'resume',
      sourceSessionId,
      attachSource: true,
      discoverLinked: true,
      discoverFresh: false,
    };
  }

  if (normalizedCommand === 'codex-f' && sourceSessionId) {
    return {
      mode: 'fork',
      sourceSessionId,
      attachSource: false,
      discoverLinked: true,
      discoverFresh: false,
    };
  }

  return {
    mode: 'new',
    sourceSessionId: null,
    attachSource: false,
    discoverLinked: false,
    discoverFresh: true,
  };
}

async function executeCodexLaunchObservation(input, adapters) {
  const plan = planCodexLaunchObservation(input?.command, input?.sessionId);
  let sourceAttached = null;

  if (plan.attachSource) {
    adapters.setProvisionalSession?.(plan.sourceSessionId, plan);
    sourceAttached = await adapters.attachSource?.(plan.sourceSessionId, plan);
  }

  if (plan.discoverLinked) {
    adapters.startDiscovery?.({
      sourceSessionId: plan.sourceSessionId,
      sourceMode: plan.mode,
      plan,
    });
  } else if (plan.discoverFresh) {
    adapters.startDiscovery?.({
      sourceSessionId: null,
      sourceMode: null,
      plan,
    });
  }

  return { ...plan, sourceAttached };
}

module.exports = {
  executeCodexLaunchObservation,
  planCodexLaunchObservation,
};
