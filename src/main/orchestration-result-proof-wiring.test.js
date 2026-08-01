const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');

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
