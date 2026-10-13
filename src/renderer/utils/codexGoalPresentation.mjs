import { getTerminalMcpTag } from '../../shared/prompt-origin.mjs';

/** Display only: do not widen the native audit/result matcher or rewrite
 * physical turns to hide a rail point. Quoted/partial/unknown wire is literal. */
export function codexGoalPresentation(entry, toolType) {
  if (!entry || getTerminalMcpTag(entry) || entry.questionReplyProof
    || (toolType && toolType !== 'codex')) return null;
  const native = toolType === 'codex' || /^codex-user(?:-source)?-/.test(String(entry.uuid || entry.sourceIdentity || ''))
    || entry.role === 'goal' || entry.serviceCarrier === 'goal-continuation' || entry.isGoalContinuation === true;
  if (!native) return null;
  if (entry.role === 'goal' || entry.serviceCarrier === 'goal-continuation' || entry.isGoalContinuation === true)
    return { kind: 'continuation', title: 'Goal continuation', text: 'Goal continued' };
  if (entry.role && entry.role !== 'user') return null;
  if (entry.type && entry.type !== 'user') return null;
  const text = typeof entry.content === 'string' ? entry.content.trim() : '';
  const status = text.match(/^<codex_internal_context\s+source=(["'])user_goal\1\s*>\s*User set goal status: "(paused|active)"\.\s*<\/codex_internal_context>$/);
  if (status) return { kind: 'status', status: status[2], title: 'Goal status',
    text: status[2] === 'paused' ? 'Goal paused' : 'Goal active' };
  const continuation = text.match(/^<codex_internal_context\s+source=(["'])goal\1\s*>([\s\S]+)<\/codex_internal_context>$/);
  if (continuation?.[2].trim() && !/<\/?codex_internal_context\b/.test(continuation[2]))
    return { kind: 'continuation', title: 'Goal continuation', text: 'Goal continued' };
  return null;
}

/** Applies after canonical/live/handoff merge AND note/working-file projection.
 * Copies no records, mutates no cache and leaves exact later turnIndex intact. */
export function filterTimelineGoalPresentation(entries, toolType) {
  if (toolType !== 'codex' || !Array.isArray(entries)) return entries;
  const visible = entries.filter(entry => !codexGoalPresentation(entry, toolType));
  return visible.length === entries.length ? entries : visible;
}
