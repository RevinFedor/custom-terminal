'use strict';
// CJS twin; nested worker copy is kept byte-identical.
const {getTerminalMcpTag,isServicePromptEntry}=require('./prompt-origin.cjs');
const {historyEntryHasExactIdentity}=require('./history-entry-identity.cjs');
const TIMELINE_TITLE_COMMAND_RE = /^\s*(#(?:pack|effort|usage|help|model|status|clear)\b|\/(?:model|help|status|usage|compact|clear|exit|quit|login|logout|cost|rewind|init)\b)/i;
const TITLE_BOOTSTRAP_RE = /^\s*Continue from where you left off\.?\s*$/i;
const CODEX_BOOTSTRAP_RE = /^\s*(?:#\s*)?(?:AGENTS|GEMINI)\.md instructions for\b/i;
function isCodexBootstrapInstructionPrompt(text) { return CODEX_BOOTSTRAP_RE.test(text); }
function isTimelineAttributeEntry(entry) {
  return !!entry.isCompactSummary || ['compact','continued','docs_edit','docs_search'].includes(entry.type);
}
function timelineAutomaticGroupKind(entry) {
  const tag=getTerminalMcpTag(entry);
  if(tag)return tag.kind==='orchestration'&&tag.runKind==='external-research'
    &&typeof tag.runId==='string'&&!!tag.runId.trim()?null:'orchestration';
  return entry?.isSubAgent||entry?.isSubAgentTimeout?'subagent':null;
}
function isEligibleTimelineTitleEntry(entry) {
  if(entry.type!=='user'||entry.isCompactSummary||isServicePromptEntry(entry))return false;
  const text=String(entry.content||'').trim();
  if(text.length<2||TIMELINE_TITLE_COMMAND_RE.test(text)||TITLE_BOOTSTRAP_RE.test(text)
    ||isCodexBootstrapInstructionPrompt(text))return false;
  if(text.startsWith('This session is being continued from a previous conversation'))return false;
  return !text.startsWith('[Request interrupted')&&text!=='[User cancelled]';
}

// Presentation only. Recognizing a native carrier changes neither Goal/turn
// completion nor Send/Input authority; exact question/MCP proofs take priority.
function codexGoalPresentation(entry, toolType) {
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

function timelineEntryMatchesSentHandoff(entry, handoffEntry) {
  const candidateIdentities = [
    handoffEntry?.uuid,
    handoffEntry?.sourceIdentity,
    ...(Array.isArray(handoffEntry?.sourceIdentityAliases)
      ? handoffEntry.sourceIdentityAliases
      : []),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return candidateIdentities.some((identity) => (
    historyEntryHasExactIdentity(entry, identity)
  ));
}

module.exports={TIMELINE_TITLE_COMMAND_RE,isCodexBootstrapInstructionPrompt,isTimelineAttributeEntry,timelineAutomaticGroupKind,isEligibleTimelineTitleEntry,codexGoalPresentation,timelineEntryMatchesSentHandoff};
