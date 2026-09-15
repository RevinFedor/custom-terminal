const ORCHESTRATION_PHASES = new Set(['request', 'completion', 'failure']);

/**
 * Orchestration provenance is durable presentation metadata written after the
 * exact prompt audit. Never infer it from a visible "[Оркестрация]" phrase:
 * ordinary user text may quote the same words.
 */
export function resolveHistoryOrchestrationPromptPresentation(entry) {
  if (!['user', 'queued'].includes(entry?.role) || !Array.isArray(entry?.semanticTags)) return null;
  const tag = entry.semanticTags.find((candidate) => (
    candidate?.kind === 'orchestration'
    && typeof candidate.runId === 'string'
    && candidate.runId.trim().length > 0
  ));
  if (!tag) return null;

  return {
    runId: tag.runId.trim(),
    phase: ORCHESTRATION_PHASES.has(tag.phase) ? tag.phase : 'unknown',
  };
}

const normalizeOwnedHandoffSource = (value) =>
  String(value || '').replace(/^(?:claude|codex)-/, '');

/** Exact app-owned source/handoff pairs let the optimistic row use the same
 * colour before its audited durable semantic tag arrives. */
export function resolveHistoryOrchestrationHandoffPresentation(handoff) {
  const handoffId = String(handoff?.handoffId || '');
  const source = normalizeOwnedHandoffSource(handoff?.source);

  const completionPrefix = 'orchestration-complete:';
  if (handoffId.startsWith(completionPrefix)) {
    const runId = handoffId.slice(completionPrefix.length).trim();
    if (runId && source === 'orchestration-completion:' + runId) {
      return { runId, phase: 'unknown' };
    }
  }

  const requestPrefix = 'orchestration:';
  if (handoffId.startsWith(requestPrefix)) {
    const runId = handoffId.slice(requestPrefix.length).trim();
    const sourceTabId = source.startsWith(requestPrefix)
      ? source.slice(requestPrefix.length).trim()
      : '';
    if (runId && sourceTabId) return { runId, phase: 'request' };
  }

  return null;
}
