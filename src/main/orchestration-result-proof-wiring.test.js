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

test('known Codex result uses the provider cursor before the generic loader and legacy fallback', () => {
  const start = mainSource.indexOf('async function _getAgentTurnResultForOrchestration');
  const end = mainSource.indexOf('\nasync function handleOverseerRequest', start);
  assert.ok(start >= 0 && end > start, 'could not isolate orchestration result reader');
  const reader = mainSource.slice(start, end);
  const exactAt = reader.indexOf('codexDataModule._api.loadCodexProviderResult(');
  const genericAt = reader.indexOf('const data = await _loadSessionTurns(');
  const legacyAt = reader.indexOf('findMatchingClaudePromptTurn({');

  assert.match(reader, /targetExecutionContext/);
  assert.match(reader.slice(0, reader.indexOf('}) {')), /\btoolType\b/);
  assert.match(reader, /errorCode: codexResult\?\.errorCode \|\| null/);
  assert.ok(exactAt >= 0 && genericAt > exactAt && legacyAt > genericAt,
    'the cheap exact branch must precede both generic loading and legacy matching');
  const routingAt = reader.indexOf('const codexResultProof =');
  assert.ok(routingAt >= 0 && routingAt < exactAt);
  const routing = reader.slice(routingAt, exactAt);
  assert.match(routing, /targetExecutionContext\?\.provider\s*\?\s*targetExecutionContext\.provider === 'codex'\s*:\s*toolType === 'codex'/);
  assert.doesNotMatch(routing, /targetExecutionContext\??\.turnId/,
    'a declared Codex provider must reach bootstrap even without a bound turn');
  const exactBranch = reader.slice(0, genericAt);
  assert.match(exactBranch, /resolveSource: request => transcriptService\.resolveCodexResultSource\(request\)/);
  assert.match(exactBranch, /forceFresh,/);
  assert.match(exactBranch, /resultAfterAt: latestAfter,/);
  assert.match(exactBranch, /resultBeforeAt,/);
  assert.match(exactBranch, /maxChars,/);
  assert.doesNotMatch(exactBranch, /_loadSessionTurns\(|loadSessionRecords\(|buildCodexTimeline\(/);
  assert.match(exactBranch, /return \{\s*found: false,/);
  assert.match(exactBranch, /return \{\s*found: true,/);
  assert.match(exactBranch, /executionContext: targetExecutionContext \|\| codexResult\.executionContext \|\| null/);
  assert.match(reader.slice(genericAt), /_loadSessionTurns\(sessionId, cwd, \{ forceFresh \}\)/);
  assert.match(reader, /\[OrchestrationResultProof\]/);
  assert.match(reader, /terminalEvent: codexResult\.terminalEvent \|\| null/);
  assert.match(reader, /terminalOutcomeReason: codexResult\.terminalOutcomeReason \|\| null/);
  assert.match(reader, /hasFinalResult: codexResult\.hasFinalResult === true/);
  assert.match(reader, /proofDefinitive: codexResult\.proofDefinitive === true/);
  assert.match(reader, /errorCode: codexResult\.errorCode \|\| null/);
});

test('result probing reads the persisted target session instead of a replaced live session', () => {
  const probe = block(
    'async function probeOrchestrationResult',
    '\nfunction emitOrchestrationChanges',
  );
  assert.match(probe, /buildOrchestrationResultLookup\(run\)/);
  assert.match(probe, /resultAttempt\?\.targetToolType \|\| lookup\.targetExecutionContext\?\.provider/);
  assert.match(probe, /getAgentTurnResult\(\{\s*toolType,/);
  assert.doesNotMatch(probe, /info\?*\.(?:toolType|commandType|provider)/);
  assert.match(probe, /lookup\.targetExecutionContext\?\.sessionId \|\| storedSessionId \|\| info\?\.sessionId/);
  assert.match(probe, /const cwd = targetCwd \|\| info\?\.cwd \|\| targetProjectPath/);
  const reconcile = block(
    'async function reconcileOrchestrationRun',
    '\nasync function admitAgentLifecycleLaunch',
  );
  assert.match(reconcile, /resultTerminalEvent: probe\.terminalEvent \|\| null/);
  assert.match(reconcile, /resultTerminalReason: probe\.terminalOutcomeReason \|\| null/);
  assert.match(reconcile, /resultHasFinalResult: probe\.hasFinalResult === true/);
  assert.match(reconcile, /internalContinuationCount: Math\.max\(0, Number\(probe\.internalContinuationCount\) \|\| 0\)/);
});

test('Claude internal-work lifecycle is routed through the same durable store', () => {
  const lifecycle = block(
    'async function processOrchestrationLifecycle',
    '\nasync function performE2eBoundaryAction',
  );
  assert.match(lifecycle, /store\.applyLifecycle\(tabId, payload\)/);
  assert.match(lifecycle, /waitingForInternalDescendants/);
  assert.match(lifecycle, /\[OrchestrationInternalWork\]/);
});

test('settled result proof terminalizes exact abort or no-final-result before arming a watcher', () => {
  const finalize = block(
    'async function finalizeSettledOrchestration',
    '\nasync function finalizeSettledOrchestrations',
  );
  assert.match(finalize, /runOrchestrationCompletionFlow\(\{/);
  assert.match(finalize, /classifyOrchestrationResultProbe\(probe,[\s\S]*authoritativeCompletion: true/);
  assert.match(finalize, /armProof: async \(probe\)[\s\S]*orchestrationResultAttemptMatches\(latest, probe\.resultAttempt\)/);
  assert.match(finalize, /return armOrchestrationResultProof\(current, probe\)/);
  assert.match(finalize, /markResultProofTerminalFailure\(/);
  assert.match(finalize, /releaseOrchestrationResultProof\(current\.runId, 'exact-terminal-result-failure'\)/);
  assert.match(finalize, /completion\.outcome === 'terminal-failure'/);
  assert.match(finalize, /sendOrchestrationCompletionNotification\(finalized\)/);
});

test('only exact pre-submit or provider-not-accepted proof bypasses orchestration recovery grace', () => {
  const applyReceipt = block(
    'async function applyOrchestrationTargetSendReceipt',
    '\nasync function dispatchDeferredOrchestrationRun',
  );
  assert.match(applyReceipt, /orchestrationSendFailureRecoveryPolicy\(sendResult\)/);
  assert.match(applyReceipt, /resetDeferredDelivery\(runId, 'send-refused-before-submit'\)/);
  assert.match(applyReceipt, /failureGraceMs: recoveryPolicy\.failureGraceMs/);
  assert.match(applyReceipt, /finalizeSettledOrchestrations\(failed\.settled, reason \+ '-send-failed'\)/);
  assert.match(applyReceipt, /\[OrchestrationDelivery\] exact pre-submit failure/);
  assert.match(applyReceipt, /AGENT_SEND_RECEIPT_STATES\.PROVIDER_NOT_ACCEPTED/);
  assert.match(applyReceipt, /\[OrchestrationDelivery\] exact provider-not-accepted after Enter/);
  assert.match(applyReceipt, /current\.targetPromptProofAt/);
  assert.doesNotMatch(
    applyReceipt,
    /PROVIDER_NOT_ACCEPTED[\s\S]{0,900}resetDeferredDelivery/,
    'post-Enter provider refusal must not be rewritten as a pre-Enter retryable refusal',
  );
});
