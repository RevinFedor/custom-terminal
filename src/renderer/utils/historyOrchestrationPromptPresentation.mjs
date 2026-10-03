import { getTabMessageTag } from '../../shared/prompt-origin.mjs';

const ORCHESTRATION_PHASES = new Set(['request', 'completion', 'failure']);
const PRESENTATION_FIELDS = ['envelopeStart', 'envelopeText', 'bodyStart', 'bodyEnd', 'bodyProjectionHash', 'sourceTabId', 'sourceTabName', 'sourceProjectId', 'targetTabId', 'targetTabName', 'targetProjectId', 'runKind'];
const presentationFields = tag => Object.fromEntries(PRESENTATION_FIELDS.filter(key => tag[key] !== undefined).map(key => [key, tag[key]]));

/**
 * Orchestration provenance is durable presentation metadata written after the
 * exact prompt audit. Never infer it from a visible "[Оркестрация]" phrase:
 * ordinary user text may quote the same words.
 */
export function resolveHistoryOrchestrationPromptPresentation(entry) {
  if (!['user', 'queued'].includes(entry?.role) || !Array.isArray(entry?.semanticTags)) return null;
  const message = getTabMessageTag(entry);
  if (message) return {
    kind: 'tab-message',
    messageId: message.messageId,
    replyTo: message.replyTo || null,
    phase: message.phase,
    sourceTabId: message.sourceTabId,
    sourceTabName: message.sourceTabName,
    sourceProjectId: message.sourceProjectId,
    targetTabId: message.targetTabId,
    targetTabName: message.targetTabName,
    targetProjectId: message.targetProjectId,
    ...presentationFields(message),
  };
  const tag = entry.semanticTags.find((candidate) => (
    candidate?.kind === 'orchestration'
    && typeof candidate.runId === 'string'
    && candidate.runId.trim().length > 0
  ));
  if (!tag) return null;

  return {
    runId: tag.runId.trim(),
    phase: ORCHESTRATION_PHASES.has(tag.phase) ? tag.phase : 'unknown',
    ...presentationFields(tag),
  };
}

/** Offsets address the audited FULL transport text in JS UTF-16 characters.
 * Keep deferred context before the generated envelope; never mutate the entry
 * that Copy, Rewind and exact receipt/context lookups still need. */
export function projectHistoryServicePromptBody(entry, fingerprint) {
  const text = typeof entry?.content === 'string' ? entry.content : '';
  const tag = resolveHistoryOrchestrationPromptPresentation(entry);
  const { envelopeStart, envelopeText, bodyStart, bodyEnd, bodyProjectionHash } = tag || {};
  // Generated bodies are suffixes. Canonical TAB/CRLF transforms may shift
  // offsets, so reject a length or saved-header mismatch instead of cutting.
  if (![envelopeStart, bodyStart, bodyEnd].every(Number.isSafeInteger)
    || envelopeStart < 0 || envelopeStart > bodyStart || bodyStart > bodyEnd || bodyEnd !== text.length
    || (envelopeText !== undefined && (typeof envelopeText !== 'string'
      || envelopeText !== text.slice(envelopeStart, bodyStart)))
    || typeof bodyProjectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyProjectionHash)
    || typeof fingerprint !== 'function') {
    return { text, projected: false };
  }
  // A reused UUID or equal-length edit can satisfy all positional guards.
  // Bind the entire displayed UTF-8 text to the prepared prompt synchronously.
  try {
    if (fingerprint(text) !== bodyProjectionHash) return { text, projected: false };
  } catch {
    return { text, projected: false };
  }
  return { text: text.slice(0, envelopeStart) + text.slice(bodyStart, bodyEnd), projected: true };
}

export function resolveHistoryPromptSender(presentation) {
  if (!presentation) return null;
  const completion = presentation.kind !== 'tab-message'
    && (presentation.phase === 'completion' || presentation.phase === 'failure');
  if (completion && presentation.runKind === 'external-research') {
    return { label: presentation.targetTabName || 'Browser research' };
  }
  const sourceTabId = completion ? presentation.targetTabId : presentation.sourceTabId;
  if (!sourceTabId) return null;
  return {
    sourceTabId,
    sourceTabName: completion ? presentation.targetTabName : presentation.sourceTabName,
    sourceProjectId: completion ? presentation.targetProjectId : presentation.sourceProjectId,
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
