import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsGitDiffDiagnosticResult, acceptsGitDiffResultGeneration,
  bindGitDiffDiagnosticResponse, nextGitDiffDiagnosticId } from './gitDiffRequestDiagnostics.mjs';

test('Git diff correlation accepts only the live generation and exact response ID', () => {
  const requestId = nextGitDiffDiagnosticId();
  const captured = { cancelled: false, capturedGeneration: 7, currentGeneration: 7, requestId,
    responseRequestId: requestId };
  assert.equal(acceptsGitDiffDiagnosticResult(captured), true);
  assert.equal(acceptsGitDiffDiagnosticResult({ ...captured, currentGeneration: 8 }), false);
  assert.equal(acceptsGitDiffDiagnosticResult({ ...captured, cancelled: true }), false);
  assert.equal(acceptsGitDiffDiagnosticResult({ ...captured, responseRequestId: 'late-other-request' }), false);
  assert.equal(acceptsGitDiffDiagnosticResult({ ...captured, responseRequestId: null }), false);
});

test('Git diff diagnostic IDs are unique and path-free', () => {
  const one = nextGitDiffDiagnosticId();
  const two = nextGitDiffDiagnosticId();
  assert.notEqual(one, two);
  assert.match(one, /^git-diff-[\w-]+$/);
});

test('legacy and unmatched diagnostic echoes preserve the owned result without false trace correlation', () => {
  const owner = { cancelled: false, capturedGeneration: 7, currentGeneration: 7 };
  const requestId = nextGitDiffDiagnosticId();
  const legacy = { success: true, diff: 'full existing diff', files: [{ path: 'a' }] };
  assert.equal(acceptsGitDiffResultGeneration(owner), true);
  const accepted = bindGitDiffDiagnosticResponse(legacy, requestId);
  assert.equal(accepted.diff, legacy.diff);
  assert.equal(accepted.files, legacy.files);
  assert.equal(accepted.success, true);
  assert.equal(accepted.diagnosticRequestId, null);
  const wrong = bindGitDiffDiagnosticResponse({ ...legacy, diagnosticRequestId: 'another',
    diagnosticMetrics: { chars: 42 } }, requestId);
  assert.equal(wrong.diff, legacy.diff);
  assert.equal(wrong.diagnosticMetrics, undefined);
  assert.equal(acceptsGitDiffResultGeneration({ ...owner, currentGeneration: 8 }), false);
  assert.equal(acceptsGitDiffResultGeneration({ ...owner, cancelled: true }), false);
  const matching = { ...legacy, diagnosticRequestId: requestId };
  assert.equal(bindGitDiffDiagnosticResponse(matching, requestId), matching);
});
