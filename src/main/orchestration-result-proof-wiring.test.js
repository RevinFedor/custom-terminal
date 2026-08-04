const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function block(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, 'missing start marker: ' + start);
  assert.notEqual(to, -1, 'missing end marker: ' + end);
  return source.slice(from, to);
}

test('startup gives a removed target one final result read before terminalizing its proof', () => {
  const reconcile = block(
    'async function reconcileActiveOrchestrations()',
    '\nasync function performOrchestrationAction',
  );
  assert.match(reconcile, /findOrchestrationTabDescriptor\(run\.targetTabId\)/);
  assert.match(reconcile, /finalizeSettledOrchestration\(run, 'startup-result-proof-reconcile'\)/);
  assert.match(reconcile, /finalizeClosedTargetResultProof\(run\.runId,[\s\S]*knownTargetClosed: true/);
});

test('closing a target resolves completed incomplete proofs instead of leaving a ghost loader', () => {
  const resolver = block(
    'async function finalizeClosedTargetResultProof',
    '\nasync function handleOrchestrationTabClosed',
  );
  assert.ok(
    resolver.indexOf('finalizeSettledOrchestration(before')
      < resolver.indexOf('markResultProofUnavailable('),
    'the final transcript read must happen before terminal resolution',
  );
  assert.match(resolver, /releaseOrchestrationResultProof\(runId, 'closed-target-result-unavailable'\)/);

  const close = block(
    'async function handleOrchestrationTabClosed',
    '\nfunction mobileTimelineColor',
  );
  assert.match(close, /pendingResultRuns/);
  assert.match(close, /finalizeClosedTargetResultProof\(run\.runId,[\s\S]*knownTargetClosed: true/);
});

test('Codex orchestration result uses persisted execution identity before legacy turn grouping', () => {
  const start = mainSource.indexOf('async function _getAgentTurnResultForOrchestration');
  const end = mainSource.indexOf('\nasync function handleOverseerRequest', start);
  assert.ok(start >= 0 && end > start, 'could not isolate orchestration result reader');
  const reader = mainSource.slice(start, end);
  const exactAt = reader.indexOf('buildCodexProviderTurnAssistantResult(');
  const legacyAt = reader.indexOf('findMatchingClaudePromptTurn({');

  assert.match(reader, /targetExecutionContext/);
  assert.match(reader, /promptUserUuid \|\| promptHash/);
  assert.ok(exactAt >= 0 && exactAt < legacyAt, 'exact provider turn proof must precede legacy grouping');
  assert.match(reader, /\[OrchestrationResultProof\]/);
  assert.match(reader, /terminalEvent: codexResult\.terminalEvent \|\| null/);
  assert.match(reader, /terminalOutcomeReason: codexResult\.terminalOutcomeReason \|\| null/);
  assert.match(reader, /hasFinalResult: codexResult\.hasFinalResult === true/);
});

test('result probing reads the persisted target session instead of a replaced live session', () => {
  const probe = block(
    'async function probeOrchestrationResult',
    '\nfunction emitOrchestrationChanges',
  );
  assert.match(probe, /buildOrchestrationResultLookup\(run\)/);
  assert.match(probe, /lookup\.targetExecutionContext\?\.sessionId \|\| info\?\.sessionId/);
  const reconcile = block(
    'async function reconcileOrchestrationRun',
    '\nasync function admitAgentLifecycleLaunch',
  );
  assert.match(reconcile, /resultTerminalEvent: probe\.terminalEvent \|\| null/);
  assert.match(reconcile, /resultTerminalReason: probe\.terminalOutcomeReason \|\| null/);
  assert.match(reconcile, /resultHasFinalResult: probe\.hasFinalResult === true/);
});

test('settled result proof terminalizes exact abort or no-final-result before arming a watcher', () => {
  const finalize = block(
    'async function finalizeSettledOrchestration',
    '\nasync function finalizeSettledOrchestrations',
  );
  assert.match(finalize, /exactOrchestrationTerminalFailure\(probe\)/);
  assert.ok(
    finalize.indexOf('if (!terminalFailureReason && !isCompleteOrchestrationResult(probe))')
      < finalize.indexOf('armOrchestrationResultProof(current, probe)'),
    'an exact terminal failure must be handled before waiting for more transcript bytes',
  );
  assert.match(finalize, /markResultProofTerminalFailure\(/);
  assert.match(finalize, /releaseOrchestrationResultProof\(current\.runId, 'exact-terminal-result-failure'\)/);
  assert.match(finalize, /sendOrchestrationCompletionNotification\(finalizedFailure\)/);
});

test('only explicit submitted false bypasses orchestration recovery grace', () => {
  const dispatch = block(
    'async function dispatchDeferredOrchestrationRun',
    '\nasync function dispatchNextDeferredOrchestrationForTarget',
  );
  assert.match(dispatch, /orchestrationSendFailureRecoveryPolicy\(sendResult\)/);
  assert.match(dispatch, /resetDeferredDelivery\(runId, 'send-refused-before-submit'\)/);
  assert.match(dispatch, /failureGraceMs: recoveryPolicy\.failureGraceMs/);
  assert.match(dispatch, /finalizeSettledOrchestrations\(failed\.settled, reason \+ '-send-failed'\)/);
  assert.match(dispatch, /\[OrchestrationRecovery\] immediate pre-submit failure/);
});
