const boot = Date.now().toString(36);
let sequence = 0;

export function nextGitDiffDiagnosticId() {
  sequence += 1;
  return `git-diff-${boot}-${sequence.toString(36)}`;
}

export function acceptsGitDiffDiagnosticResult({ cancelled, capturedGeneration, currentGeneration,
  requestId, responseRequestId }) {
  return acceptsGitDiffResultGeneration({ cancelled, capturedGeneration, currentGeneration })
    && typeof requestId === 'string' && responseRequestId === requestId;
}

// Diagnostic echoes are optional metadata, never a new admission requirement
// for an already-owned IPC response (including an older Main response).
export function acceptsGitDiffResultGeneration({ cancelled, capturedGeneration, currentGeneration }) {
  return cancelled !== true && capturedGeneration === currentGeneration;
}

export function bindGitDiffDiagnosticResponse(result, requestId) {
  if (result?.diagnosticRequestId === requestId) return result;
  return { ...result, diagnosticRequestId: null, diagnosticActionId: null, diagnosticMetrics: undefined };
}
