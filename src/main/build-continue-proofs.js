'use strict';

const { createHash } = require('node:crypto');

function buildContinueTaskBoundary({ owner, watcher, lifecycleGeneration, runSeq, inputRevision, stopRevision, stopping, inputPending }) {
  return createHash('sha256').update(JSON.stringify([
    owner?.known, owner?.archived || false, owner?.provider, owner?.sessionId,
    owner?.projectId, owner?.cwd, owner?.terminalId, owner?.executionScope || null,
    lifecycleGeneration, runSeq, inputRevision, stopRevision, !!stopping, !!inputPending,
    watcher?.sessionId, watcher?.processGeneration, watcher?.filePath,
    watcher?.processGenerationBoundaryOffset, watcher?.loopCanonicalInputOffset ?? null,
    !!watcher?.catchUpPending, !!watcher?.publicTurnStateSuppressed, !!watcher?.catchUpPublicationsSuppressed,
    !!watcher?.deferredUntilComposer, watcher?.sourceObservationLaunchId || null, !!watcher?.manualBindingConflict,
  ])).digest('hex');
}

// A pre-cut task reference, NOT a writer/readiness/input proof. All inputs are
// supplied by Main's existing task registry, enrolled live source and physical
// owner; no saved SID or background-work count can create a task here.
function captureBuildContinueCodexTask(facts) {
  const { view, owner, turn, watcher, writer, terminal,
    lifecycleGeneration, runSeq, inputRevision, stopRevision, command, stopping, inputPending } = facts;
  const detail = { taskGeneration: turn?.generation || null, taskTurnId: turn?.turnId || null,
    watcherTurnId: watcher?.currentTurnId || null, lifecycleGeneration: lifecycleGeneration || null,
    writerState: writer?.sessionId ? 'observed' : 'unconfirmed' };
  const refuse = reason => ({ version: 1, known: false, reason, detail });
  if (view?.known !== true || view.exists === false || owner?.known !== true || owner.archived
    || owner.provider !== 'codex') return refuse('capture-owner-unavailable');
  if (stopping) return refuse('capture-stop-requested');
  if (inputPending) return refuse('capture-input-pending');
  if (!turn?.active || turn.provider !== 'codex' || !turn.sessionId || !turn.turnId
    || !Number.isSafeInteger(turn.generation) || turn.generation <= 0) return refuse('capture-own-task-unavailable');
  if (writer?.sessionId && writer.sessionId !== turn.sessionId) return refuse('capture-foreign-writer');
  if (owner.sessionId !== turn.sessionId || !owner.projectId || !owner.cwd) return refuse('capture-task-source-mismatch');
  if (!terminal || !owner.terminalId || !lifecycleGeneration || !Number.isSafeInteger(runSeq)
    || !Number.isSafeInteger(inputRevision) || !Number.isSafeInteger(stopRevision)) return refuse('capture-physical-owner-unavailable');
  if (!watcher || watcher.sessionId !== turn.sessionId || watcher.currentTurnId !== turn.turnId) return refuse('capture-task-watcher-mismatch');
  if (watcher.busy !== true || watcher.outcomeKnown === true) return refuse('capture-own-task-ended');
  if (watcher.catchUpPending || watcher.publicTurnStateSuppressed || watcher.catchUpPublicationsSuppressed
    || watcher.deferredUntilComposer || watcher.sourceObservationLaunchId || watcher.manualBindingConflict) return refuse('capture-source-unproven');
  if (watcher.processGeneration !== lifecycleGeneration || watcher.sourceObservationTerminal !== terminal
    || watcher.sourceObservationRunSeq !== runSeq || !watcher.filePath
    || !Number.isSafeInteger(watcher.processGenerationBoundaryOffset) || watcher.processGenerationBoundaryOffset < 0
    || !(watcher.liveTurnEvents > 0)) return refuse('capture-source-owner-mismatch');
  if (command?.isRunning === false && command.processLookupUnknown !== true) return refuse('capture-process-inactive');
  const context = { provider: 'codex', sessionId: turn.sessionId, turnId: turn.turnId,
    processId: turn.processId || null, generation: turn.generation, startedAt: turn.startedAt || null };
  // Writer observation/launch-label refinement and ordinary tool output do not
  // change this task. Physical input, Stop, source, task and owner changes do.
  const sourceRevision = buildContinueTaskBoundary(facts);
  const revision = 'build-task-v1:' + createHash('sha256').update(JSON.stringify([context, sourceRevision])).digest('hex');
  return { version: 1, known: true, reason: 'exact-main-task-source', detail, revision,
    sourceRevision, executionContext: context };
}

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

module.exports = { readBuildContinueOriginal, capturedCodexSubject, captureBuildContinueCodexTask, buildContinueTaskBoundary };
