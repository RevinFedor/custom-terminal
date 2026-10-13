import { buildHistoryComposerPresentationParts } from './composerChips.mjs';
import { codexGoalPresentation } from './codexGoalPresentation.mjs';
import { researchReplyFromProjection } from './researchResultPresentation.mjs';
import { collectTimelineDocs } from './timelineMarkerPresentation.mjs';
import { getAutomaticContinuationKind, getTerminalMcpTag, isSystemPromptEntry, systemPromptSource } from '../../shared/prompt-origin.mjs';
import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';
import { projectHistoryServicePromptBody, resolveHistoryOrchestrationPromptPresentation,
  resolveHistoryPromptSender } from './historyOrchestrationPromptPresentation.mjs';

export function timelineFinalPreview(entry) {
  const value = entry?.responsePreview;
  if (value?.version !== 1 || typeof value.uuid !== 'string' || !value.uuid
    || typeof value.content !== 'string' || !value.content.trim()
    || !Number.isSafeInteger(value.contentLength) || value.contentLength < value.content.length) return null;
  return value;
}

export function timelineFinalNavigationIdentity(preview) {
  return preview?.sourceIdentity || preview?.uuid || null;
}

export function resolveTimelinePromptImages(entries, prompt) {
  const identity = prompt?.sourceIdentity || prompt?.uuid;
  const matches = (Array.isArray(entries) ? entries : []).filter(entry => (
    ['user', 'goal'].includes(entry?.role) && historyEntryHasExactIdentity(entry, identity)
  ));
  return matches.length === 1 && Array.isArray(matches[0].imagePaths) ? matches[0].imagePaths : [];
}

/** Exact record and bounded-prefix proof. A stale full read cannot replace
 * a new final, a neighbouring assistant or an edited equal-length message. */
export function resolveTimelineFullResponse(entries, preview, fingerprint) {
  if (!preview) return null;
  const matches = (Array.isArray(entries) ? entries : []).filter(entry => (
    entry?.role === 'assistant' && historyEntryHasExactIdentity(entry, timelineFinalNavigationIdentity(preview))
  ));
  if (matches.length !== 1) return null;
  const entry = matches[0];
  if (entry.textPhase === 'commentary' || entry.textPhase === 'partial_answer' || entry.isApiErrorMessage
    || typeof entry.content !== 'string' || entry.content.length !== preview.contentLength
    || !entry.content.startsWith(preview.content)) return null;
  if (preview.contentHash && (typeof fingerprint !== 'function'
    || fingerprint(entry.content) !== preview.contentHash)) return null;
  return entry.content;
}

/** Same audited service-body projection as History. No envelope regex or
 * classification by quoted text; full canonical content stays untouched. */
export function timelinePromptPreview(entry, fingerprint) {
  const record = { ...entry, role: entry?.type === 'user' ? 'user' : entry?.role };
  const service = resolveHistoryOrchestrationPromptPresentation(record);
  const goal = codexGoalPresentation(record);
  const projected = goal ? { text: goal.text, projected: true }
    : projectHistoryServicePromptBody(record, fingerprint);
  const research = researchReplyFromProjection(record, service, projected);
  const parts = research ? research.parts : projected.questionReply ? [{ kind: 'text', text: projected.text }]
    : buildHistoryComposerPresentationParts({ text: projected.text,
      chips: entry?.promptChips, imagePaths: entry?.imagePaths }).parts;
  const text = research ? research.previewText : parts.filter(part => part.kind === 'text').map(part => part.text).join('')
    .replace(/\s+/g, ' ').trim();
  return { service, source: resolveHistoryPromptSender(service), parts, text,
    projected: projected.projected, questionReply: projected.questionReply || null, goal, research };
}

export function timelineGroupPreview(entries, kind) {
  const rows = Array.isArray(entries) ? entries : [];
  const docs = collectTimelineDocs(rows);
  let sc = 0, mcp = 0, failed = 0;
  for (const row of rows) {
    if (kind === 'subagent') { if (row.isSubAgentTimeout) failed++; continue; }
    const service = resolveHistoryOrchestrationPromptPresentation({ ...row, role: 'user' });
    if (service?.runKind === 'external-research') sc++;
    else if (service || getTerminalMcpTag(row)) mcp++;
  }
  return { count: rows.length, kind, sc, mcp, failed, docs };
}

export function timelinePreviewModelLabel(entry, toolType) {
  const raw = String(entry?.responseModel || '').trim();
  if (!raw || raw === '<synthetic>') return null;
  const effort = String(entry?.responseEffort || '').trim();
  return { icon: toolType === 'codex' ? 'codex' : toolType === 'claude' ? 'claude' : null,
    text: [raw, effort || (entry.responseHasThinking ? 'think' : '')].filter(Boolean).join(' · ') };
}

export function timelineAutomaticPromptVariant(entry) {
  const continuation = getAutomaticContinuationKind(entry);
  if (continuation) return { kind: continuation, title: continuation === 'loop' ? 'Loop' : 'Continue' };
  if (isSystemPromptEntry(entry)) {
    const tag = entry.semanticTags.find(tag => tag?.kind === 'prompt-origin' && tag.source === 'system'
      && systemPromptSource(tag.systemSource));
    return { kind: 'system', title: systemPromptSource(tag.systemSource) === 'build-install-return'
      ? 'Build Install return' : 'Capacity retry' };
  }
  return null;
}

// Inputs must come from the saved external-research request of this run.
// Unknown stays empty; do not use toolbar/model defaults or source label text.
export function timelineResearchModelLabel(saved) {
  if (!saved || typeof saved.model !== 'string' || !saved.model.trim()) return null;
  const model = saved.model.trim().replace(/^ChatGPT\s*[·:—-]?\s*/i, '').replace(/^gpt-/i, '');
  const effort = typeof saved.effort === 'string' ? saved.effort.trim() : '';
  const mode = typeof saved.mode === 'string' && !['chat', ''].includes(saved.mode.trim()) ? saved.mode.trim() : '';
  return [model, effort || mode].filter(Boolean).join(' · ');
}
