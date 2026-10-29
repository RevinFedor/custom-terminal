'use strict';

const { withPromptOriginPresentation } = require('../shared/prompt-origin.cjs');

// Caller identity travels outside the immutable Send body/fingerprints. Names
// come from the application's tab catalog, never caller-supplied display text.
function withTerminalMcpPromptSource(snapshot, source, headers, describeTab, frozenRequest = null) {
  const mcp = String(source || '').replace(/^(?:claude|codex)-/, '') === 'terminal-mcp';
  // Existing queue snapshots own their original presentation, even if a retry
  // arrives through a newer MCP or after the sender was renamed/closed.
  if (mcp && frozenRequest) return frozenRequest.presentationSnapshot || null;
  const presentation = withPromptOriginPresentation(snapshot, source);
  if (!mcp) return presentation;
  const encoded = headers?.['x-noted-terminal-source'];
  if (encoded == null) {
    console.warn('[TerminalMcpPromptSource] sender unavailable reason=missing-header');
    return presentation;
  }
  let sender;
  try {
    if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[\w-]+$/.test(encoded)) {
      throw Error('invalid-header');
    }
    const meta = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (meta.server !== 'terminal' || meta.mode !== 'internal' || typeof meta.tabId !== 'string'
      || !meta.tabId.trim() || meta.tabId.length > 1024 || /[\u0000-\u001f]/.test(meta.tabId)
      || typeof meta.projectId !== 'string' || meta.projectId.length > 1024) throw Error('source-unavailable');
    const tab = typeof describeTab === 'function' ? describeTab(meta.tabId) : null;
    if (!tab || tab.tabId !== meta.tabId || meta.projectId && tab.projectId !== meta.projectId) {
      throw Error('source-not-resolved');
    }
    sender = { sourceTabId: tab.tabId,
      ...(typeof tab.tabName === 'string' && tab.tabName.trim() && tab.tabName.length <= 1024
        ? { sourceTabName: tab.tabName.trim() } : {}),
      ...(typeof tab.projectId === 'string' && tab.projectId.trim()
        ? { sourceProjectId: tab.projectId.trim() } : {}) };
  } catch (error) {
    const reason = ['invalid-header', 'source-unavailable', 'source-not-resolved'].includes(error.message)
      ? error.message : 'source-lookup-failed';
    console.warn('[TerminalMcpPromptSource] sender unavailable reason=' + reason);
    return presentation;
  }
  return { ...presentation, semanticTags: presentation.semanticTags.map(tag => (
    tag.kind === 'prompt-origin' && tag.source === 'terminal-mcp' ? { ...tag, ...sender } : tag
  )) };
}

module.exports = { withTerminalMcpPromptSource };
