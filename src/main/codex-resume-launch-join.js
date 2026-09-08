'use strict';

const path = require('node:path');

// Joining means waiting for a command already written by this exact lifecycle;
// it is not permission to write another command, paste a prompt, or claim ready.
function reusableCodexResumeLaunch({ request = {}, terminal, commandState,
  lifecycleGeneration, stopping = false, pendingLaunch = null,
  pendingAcceptanceId = null, writer = null, acceptedResume = null,
  resumeLease = null, tuiReady = false, cwd = null } = {}) {
  if (request.command !== 'codex-c' || !request.sessionId || !terminal
    || stopping || commandState?.isRunning !== true || !lifecycleGeneration
    || request.materializedFresh === true || request.settingsIntent === 'next-launch'
    || request.modelMigrationPending === true || request._mcpStartupRecoveryHandoff
    || (request.restartReason && request.restartReason !== 'direct')
    || request.developerInstructions || request.resumePausedGoal === false) return null;
  if (request.cwd && (!cwd || path.resolve(request.cwd) !== path.resolve(cwd))) return null;
  const current = proof => proof && proof.terminalToken === terminal
    && proof.lifecycleGeneration === lifecycleGeneration
    && Number(proof.runSeq) > 0 && Number(proof.runSeq) === Number(commandState.runSeq)
    && proof.launchId && (!request.launchId || request.launchId === proof.launchId);
  if (current(pendingLaunch) && pendingLaunch.command === 'codex-c'
    && pendingLaunch.materializedFresh !== true
    && pendingLaunch.sessionId === request.sessionId
    && pendingLaunch.resumePausedGoal !== false
    && pendingAcceptanceId === pendingLaunch.launchId) {
    return { launchId: pendingLaunch.launchId, pending: true, writerSessionId: null };
  }
  if (current(writer) && writer.valid === true && writer.sessionId
    && current(acceptedResume) && acceptedResume.command === 'codex-c'
    && acceptedResume.materializedFresh !== true && acceptedResume.launchId === writer.launchId
    && (request.sessionId === writer.sessionId || request.sessionId === acceptedResume.sessionId)) {
    return { launchId: writer.launchId, pending: false, writerSessionId: writer.sessionId };
  }
  if (!writer && tuiReady === true && current(resumeLease) && resumeLease.command === 'codex-c'
    && resumeLease.materializedFresh !== true && resumeLease.sessionId === request.sessionId) {
    return { launchId: resumeLease.launchId, pending: false, writerSessionId: null };
  }
  return null;
}

module.exports = { reusableCodexResumeLaunch };
