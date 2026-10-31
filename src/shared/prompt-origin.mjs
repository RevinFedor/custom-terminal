// CommonJS twin: prompt-origin.cjs. Vite serves source CJS raw, so keep this
// browser-safe twin aligned through prompt-origin.test.cjs.
export function systemPromptSource(value) {
  const source = String(value || '').trim();
  const supported = ['build-install-return', 'codex-capacity-retry', 'tab-message-outcome'];
  if (supported.includes(source)) return source;
  const unprefixed = source.replace(/^(?:claude|codex)-/, '');
  if (/^tab-message-outcome:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?::reply)?$/i.test(unprefixed)) return 'tab-message-outcome';
  return supported.includes(unprefixed) ? unprefixed : null;
}

export function promptOriginTagForSource(source) {
  if (source === 'prompt-loop') return { kind: 'prompt-origin', source: 'loop' };
  const ownedSource = String(source || '').replace(/^(?:claude|codex)-/, '');
  if (/^self-rewind:[A-Za-z0-9_.:-]{1,160}$/.test(ownedSource)) return {
    kind: 'prompt-origin', source: 'terminal-mcp', selfRewindOperationId: ownedSource.slice('self-rewind:'.length) };
  if (ownedSource === 'terminal-mcp' || /^tab-message:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(ownedSource)) {
    return { kind: 'prompt-origin', source: 'terminal-mcp' };
  }
  const systemSource = systemPromptSource(source);
  return systemSource ? { kind: 'prompt-origin', source: 'system', systemSource } : null;
}

export function isSystemPromptEntry(entry) {
  return Array.isArray(entry?.semanticTags) && entry.semanticTags.some(tag => (
    tag?.kind === 'prompt-origin' && tag.source === 'system'
    && !!systemPromptSource(tag.systemSource)
  ));
}

export function isServicePromptEntry(entry) {
  if (isSelfRewindOriginTag(getTerminalMcpTag(entry))) return false;
  return isSystemPromptEntry(entry) || !!getTerminalMcpTag(entry);
}

export function getLoopPromptOriginTag(entry) {
  return (Array.isArray(entry?.semanticTags) && entry.semanticTags.find(tag => (
    tag?.kind === 'prompt-origin' && tag.source === 'loop'
  ))) || null;
}

export function getAutomaticContinuationKind(entry) {
  // Presentation only. Capacity retry remains a system/service origin for
  // execution, counting and titles; a typed literal "continue" is not proof.
  if (entry?.type === 'continued' || entry?.role === 'continued' || getTerminalMcpTag(entry)) return null;
  const tags = Array.isArray(entry?.semanticTags) ? entry.semanticTags : [];
  if (tags.some(tag => tag?.kind === 'prompt-origin' && tag.source === 'system'
    && systemPromptSource(tag.systemSource) === 'codex-capacity-retry')) return 'continue';
  return getLoopPromptOriginTag(entry) ? 'loop' : null;
}

export function getTerminalMcpTag(entry) {
  const tags = Array.isArray(entry?.semanticTags) ? entry.semanticTags : [];
  return getTabMessageTag(entry) || tags.find(tag => tag?.kind === 'orchestration')
    || tags.find(isSelfRewindOriginTag)
    || tags.find(tag => tag?.kind === 'prompt-origin' && tag.source === 'terminal-mcp') || null;
}

export function isSelfRewindOriginTag(tag) {
  return tag?.kind === 'prompt-origin' && tag.source === 'terminal-mcp'
    && typeof tag.selfRewindOperationId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(tag.selfRewindOperationId);
}

export function getTabMessageTag(entry) {
  return (Array.isArray(entry?.semanticTags) && entry.semanticTags.find(tag => (
    tag?.kind === 'tab-message'
    && typeof tag.messageId === 'string' && tag.messageId.trim().length > 0
    && (tag.phase === 'question' || tag.phase === 'reply')
    && typeof tag.sourceTabId === 'string' && tag.sourceTabId.trim().length > 0
    && typeof tag.targetTabId === 'string' && tag.targetTabId.trim().length > 0
  ))) || null;
}

export function withPromptOriginPresentation(snapshot, source) {
  const tag = promptOriginTagForSource(source);
  if (!tag) return snapshot || null;
  const semanticTags = Array.isArray(snapshot?.semanticTags) ? snapshot.semanticTags : [];
  if (semanticTags.some(item => item?.kind === tag.kind && item.source === tag.source
    && item.systemSource === tag.systemSource && item.selfRewindOperationId === tag.selfRewindOperationId)) return snapshot;
  return { ...(snapshot || {}), semanticTags: [...semanticTags, tag] };
}
