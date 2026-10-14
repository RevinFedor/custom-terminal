'use strict';

const { agentSendTargetPreconditionFailure } = require('../shared/agent-send-target-precondition.cjs');

// This private adapter supplies INPUT admission evidence, never response-idle
// evidence. Both ports already belong to Main; public display flags alone are
// insufficient. Keep response busy=null visible to every response consumer.
function createContinuationInputReader({ readResponseState, readRuntimeSnapshot, readSendDestination } = {}) {
  return async tabId => {
    const before = await readResponseState(tabId);
    const decorate = (state, destination) => destination?.sessionId === state.sessionId
      && destination?.toolType === state.toolType
      ? { ...state, acceptedResumeSourceSessionId: destination.acceptedResumeSourceSessionId || null } : state;
    const legacy = () => decorate(before, before.known && before.processStatus === 'found'
      ? readSendDestination?.(tabId, before.toolType, before.sessionId) : null);
    if (!before.known || before.exists === false || before.toolType !== 'codex'
      || before.processStatus !== 'found' || before.busy === true) return legacy();
    if (typeof readRuntimeSnapshot !== 'function') return { ...legacy(),
      continuationInput: { ready: false, reason: 'continuation_runtime_reader_unavailable' } };

    let runtime;
    try { runtime = await readRuntimeSnapshot(tabId); }
    catch { return { ...before, continuationInput: { ready: false, reason: 'continuation_runtime_snapshot_unavailable' } }; }
    const after = await readResponseState(tabId);
    if (after.known !== true || after.exists === false || !before.revision
      || before.revision !== after.revision || before.sessionId !== after.sessionId
      || before.toolType !== after.toolType || before.cwd !== after.cwd
      || before.busy !== after.busy || before.processStatus !== after.processStatus) {
      return { ...after, known: false, continuationInput: { ready: false, reason: 'continuation_runtime_changed' } };
    }
    const destination = runtime?.sendTarget;
    const scoped = runtime?.coherent === true && runtime.toolType === 'codex'
      && runtime.processStatus === 'found' && destination?.toolType === 'codex'
      && !!destination.sessionId && destination.sessionId === after.sessionId
      && !!runtime.lifecycleGeneration
      && (!!destination.terminalInstanceId && !!destination.launchId
        || destination.lifecycleGeneration === runtime.lifecycleGeneration)
      && (!destination.lifecycleGeneration || destination.lifecycleGeneration === runtime.lifecycleGeneration);
    const target = scoped ? { toolType: destination.toolType, sessionId: destination.sessionId,
      acceptedResumeSourceSessionId: destination.acceptedResumeSourceSessionId || null,
      ...(destination.terminalInstanceId ? { terminalInstanceId: destination.terminalInstanceId } : {}),
      ...(destination.launchId ? { launchId: destination.launchId } : {}),
      lifecycleGeneration: runtime.lifecycleGeneration } : null;
    const reason = !scoped ? 'continuation_writer_scope_unproven'
      : after.transitioning !== false ? 'continuation_response_transition'
      : runtime.inputReady !== true || runtime.status !== 'active' || runtime.busy !== false
        || runtime.starting === true || runtime.stopping === true ? 'continuation_input_not_ready'
      : after.busy === null && after.error !== 'response_busy_unknown' ? 'continuation_response_state_unproven' : null;
    const continuationInput = { ready: reason === null, reason, target };
    return { ...decorate(after, destination), continuationInput,
      // The response revision includes input/Stop/turn/background/owner ABA.
      // Also fence the independent writer, readiness and coherent lookup scope.
      revision: JSON.stringify([after.revision, continuationInput, runtime?.conversationOwner,
        runtime?.lifecycleGeneration, runtime?.terminalRunSeq, runtime?.processPid, runtime?.inputRevision,
        runtime?.status, runtime?.inputReady, runtime?.busy, runtime?.starting, runtime?.stopping]) };
  };
}

function canSubmitContinuationInput(state) {
  if (!['found', 'absent'].includes(state?.processStatus)) return false;
  if (state.busy === false) return true; // Existing stopped/authoritative-idle path.
  return state.busy === null && state.toolType === 'codex' && state.processStatus === 'found'
    && state.transitioning === false && state.error === 'response_busy_unknown'
    && state.continuationInput?.ready === true && !!state.continuationInput.target;
}

function continuationTargetExpectation(expected, state) {
  // Only the new restored-ready path acquires an additional launch lease.
  // Stopped targets must still be able to launch their original saved session.
  if (state.busy !== null || !canSubmitContinuationInput(state)) return expected;
  const target = state.continuationInput.target;
  return { ...expected,
    ...(target.terminalInstanceId ? { terminalInstanceId: target.terminalInstanceId } : {}),
    ...(target.launchId ? { launchId: target.launchId } : {}),
    lifecycleGeneration: target.lifecycleGeneration };
}

function continuationTargetScopeMatches(expected, state) {
  if (!expected?.terminalInstanceId && !expected?.launchId && !expected?.lifecycleGeneration) return true;
  const target = state?.continuationInput?.target;
  return !!target && !agentSendTargetPreconditionFailure(expected, target);
}

module.exports = { createContinuationInputReader, canSubmitContinuationInput,
  continuationTargetExpectation, continuationTargetScopeMatches };
