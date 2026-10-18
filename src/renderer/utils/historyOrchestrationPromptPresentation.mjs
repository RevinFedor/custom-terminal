import { getTabMessageTag, getTerminalMcpTag, promptOriginTagForSource } from '../../shared/prompt-origin.mjs';
import { projectNativeQuestionReply } from '../../shared/native-question-reply.mjs';

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
  if (getTerminalMcpTag(entry)?.source === 'terminal-mcp') {
    return { kind: 'terminal-mcp', phase: 'prompt' };
  }
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
  const questionReply = projectNativeQuestionReply(entry, fingerprint);
  if (questionReply) return { text: questionReply.text, projected: true, questionReply };
  const serviceTag = resolveHistoryOrchestrationPromptPresentation(entry);
  const contexts = ['user', 'queued'].includes(entry?.role) && Array.isArray(entry?.semanticTags)
    ? entry.semanticTags.filter(tag => tag.kind === 'context-prefix' && tag.contextKind === 'orchestration-state') : [];
  const ranges = [];
  for (const tag of [serviceTag, ...(contexts.length === 1 ? contexts : [])].filter(Boolean)) {
    const { envelopeStart, envelopeText, bodyStart, bodyEnd, bodyProjectionHash } = tag;
    // All offsets refer to the FULL immutable transport, including other
    // prefixes. Never recalculate a service range from already-shortened text.
    if (![envelopeStart, bodyStart, bodyEnd].every(Number.isSafeInteger)
      || envelopeStart < 0 || envelopeStart > bodyStart || bodyStart > bodyEnd || bodyEnd !== text.length
      || (envelopeText !== undefined && (typeof envelopeText !== 'string'
        || envelopeText !== text.slice(envelopeStart, bodyStart)))
      || typeof bodyProjectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyProjectionHash)
      || tag.kind === 'context-prefix' && (envelopeStart !== 0 || typeof envelopeText !== 'string' || bodyStart <= 0)
      || typeof fingerprint !== 'function') continue;
    ranges.push({ start: envelopeStart, end: bodyStart, hash: bodyProjectionHash, service: tag === serviceTag });
  }
  if (!ranges.length) return { text, projected: false };
  let actual;
  try { actual = fingerprint(text); } catch { return { text, projected: false }; }
  const proven = ranges.filter(range => range.hash === actual).sort((a, b) => b.start - a.start);
  if (!proven.length) return { text, projected: false };
  let result = text, boundary = text.length;
  for (const range of proven) {
    if (range.end > boundary) return { text, projected: false };
    result = result.slice(0, range.start) + result.slice(range.end);
    boundary = range.start;
  }
  // Removing quiet context does not turn an ordinary literal user into a
  // Markdown service message or change its sender/origin.
  return { text: result, projected: true, ...(!proven.some(range => range.service) ? { markdown: false } : {}) };
}

export function resolveHistoryPromptSender(presentation) {
  if (!presentation) return null;
  const completion = presentation.kind !== 'tab-message'
    && (presentation.phase === 'completion' || presentation.phase === 'failure');
  if (completion && presentation.runKind === 'external-research') {
    return { label: presentation.targetTabName || 'Browser research',
      ...(presentation.runId ? { researchRunId: presentation.runId } : {}) };
  }
  const sourceTabId = completion ? presentation.targetTabId : presentation.sourceTabId;
  if (!sourceTabId) return null;
  return {
    sourceTabId,
    ...(presentation.kind === 'tab-message' && presentation.messageId ? { messageId: presentation.messageId } : {}),
    sourceTabName: completion ? presentation.targetTabName : presentation.sourceTabName,
    sourceProjectId: completion ? presentation.targetProjectId : presentation.sourceProjectId,
  };
}

const normalizeOwnedHandoffSource = (value) =>
  String(value || '').replace(/^(?:claude|codex)-/, '');

export function resolveHistoryPromptHandoffSemanticTags(handoff) {
  if (Array.isArray(handoff?.semanticTags) && handoff.semanticTags.length) {
    return handoff.semanticTags.map(tag => ({ ...tag }));
  }
  const presentation = resolveHistoryOrchestrationHandoffPresentation(handoff);
  if (presentation?.kind === 'terminal-mcp') return [{ kind: 'prompt-origin', source: 'terminal-mcp' }];
  return presentation ? [{ kind: 'orchestration', runId: presentation.runId,
    phase: presentation.phase }] : undefined;
}

/** Exact app-owned source/handoff pairs let the optimistic row use the same
 * colour before its audited durable semantic tag arrives. */
export function resolveHistoryOrchestrationHandoffPresentation(handoff) {
  const handoffId = String(handoff?.handoffId || '');
  const source = normalizeOwnedHandoffSource(handoff?.source);
  if (handoffId && promptOriginTagForSource(source)?.source === 'terminal-mcp') {
    const messagePrefix = 'tab-message:';
    if (source.startsWith(messagePrefix) && handoffId !== source) return null;
    return { kind: 'terminal-mcp', phase: 'prompt' };
  }

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
