'use strict';

// ESM twin: prompt-origin.mjs. Keep both formats aligned (parity test).
function systemPromptSource(value) {
  const source = String(value || '').trim();
  const supported = ['build-install-return', 'codex-capacity-retry'];
  if (supported.includes(source)) return source;
  const unprefixed = source.replace(/^(?:claude|codex)-/, '');
  return supported.includes(unprefixed) ? unprefixed : null;
}

function promptOriginTagForSource(source) {
  if (source === 'prompt-loop') return { kind: 'prompt-origin', source: 'loop' };
  const ownedSource = String(source || '').replace(/^(?:claude|codex)-/, '');
  if (ownedSource === 'terminal-mcp' || /^tab-message:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(ownedSource)) {
    return { kind: 'prompt-origin', source: 'terminal-mcp' };
  }
  const systemSource = systemPromptSource(source);
  return systemSource ? { kind: 'prompt-origin', source: 'system', systemSource } : null;
}

function isSystemPromptEntry(entry) {
  return Array.isArray(entry?.semanticTags) && entry.semanticTags.some(tag => (
    tag?.kind === 'prompt-origin' && tag.source === 'system'
    && !!systemPromptSource(tag.systemSource)
  ));
}

function isServicePromptEntry(entry) {
  return isSystemPromptEntry(entry) || !!getTerminalMcpTag(entry);
}

function getLoopPromptOriginTag(entry) {
  return (Array.isArray(entry?.semanticTags) && entry.semanticTags.find(tag => (
    tag?.kind === 'prompt-origin' && tag.source === 'loop'
  ))) || null;
}

function getAutomaticContinuationKind(entry) {
  // Presentation only; do not change execution/counting or infer from body.
  if (entry?.type === 'continued' || entry?.role === 'continued' || getTerminalMcpTag(entry)) return null;
  const tags = Array.isArray(entry?.semanticTags) ? entry.semanticTags : [];
  if (tags.some(tag => tag?.kind === 'prompt-origin' && tag.source === 'system'
    && systemPromptSource(tag.systemSource) === 'codex-capacity-retry')) return 'continue';
  return getLoopPromptOriginTag(entry) ? 'loop' : null;
}

function getTerminalMcpTag(entry) {
  const tags = Array.isArray(entry?.semanticTags) ? entry.semanticTags : [];
  return getTabMessageTag(entry) || tags.find(tag => tag?.kind === 'orchestration')
    || tags.find(tag => tag?.kind === 'prompt-origin' && tag.source === 'terminal-mcp') || null;
}

function getTabMessageTag(entry) {
  return (Array.isArray(entry?.semanticTags) && entry.semanticTags.find(tag => (
    tag?.kind === 'tab-message'
    && typeof tag.messageId === 'string' && tag.messageId.trim().length > 0
    && (tag.phase === 'question' || tag.phase === 'reply')
    && typeof tag.sourceTabId === 'string' && tag.sourceTabId.trim().length > 0
    && typeof tag.targetTabId === 'string' && tag.targetTabId.trim().length > 0
  ))) || null;
}

function withPromptOriginPresentation(snapshot, source) {
  const tag = promptOriginTagForSource(source);
  if (!tag) return snapshot || null;
  const semanticTags = Array.isArray(snapshot?.semanticTags) ? snapshot.semanticTags : [];
  if (semanticTags.some(item => item?.kind === tag.kind && item.source === tag.source
    && item.systemSource === tag.systemSource)) return snapshot;
  return { ...(snapshot || {}), semanticTags: [...semanticTags, tag] };
}

module.exports = {
  systemPromptSource,
  promptOriginTagForSource,
  isSystemPromptEntry,
  isServicePromptEntry,
  getLoopPromptOriginTag,
  getAutomaticContinuationKind,
  getTabMessageTag,
  getTerminalMcpTag,
  withPromptOriginPresentation,
};
