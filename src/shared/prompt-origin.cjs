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
  return isSystemPromptEntry(entry) || !!getTabMessageTag(entry) || (Array.isArray(entry?.semanticTags)
    && entry.semanticTags.some(tag => tag?.kind === 'orchestration'));
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
  getTabMessageTag,
  withPromptOriginPresentation,
};
