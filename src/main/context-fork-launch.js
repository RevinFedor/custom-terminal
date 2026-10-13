'use strict';

// Preparation belongs to the existing launch transaction, not to the menu
// which happened to request it. No PTY writes, queues or readiness are owned
// here. The caller keeps its lifecycle lock and checks its Stop/terminal fence.
async function prepareContextForkLaunch({ payload, toolType, assertCurrent,
  captureSource, readSource, materializeCompact, commitReadBinding, onPhase }) {
  const fork = payload.contextFork;
  if (!fork) return payload;
  const sourceId = toolType === 'codex' ? payload.sessionId : payload.forkSessionId;
  if (payload.command !== toolType + '-f' || !fork.sourceTabId
    || fork.sourceTabId === payload.tabId || !sourceId
    || fork.sourceSessionId !== sourceId || typeof fork.fromLatestCompact !== 'boolean') {
    throw new Error('context_fork_identity_invalid');
  }
  assertCurrent(true);
  const source = captureSource(fork.sourceTabId, toolType);
  if (!source || source.sessionId !== sourceId) throw new Error('context_fork_source_changed');
  const assertSource = () => {
    assertCurrent(true);
    const current = captureSource(fork.sourceTabId, toolType);
    if (!current || Object.keys(source).some(key => source[key] !== current[key])) {
      throw new Error('context_fork_source_changed');
    }
  };
  onPhase('forking-history');
  const proof = await readSource(fork.sourceTabId, sourceId, source.cwd, toolType);
  assertSource();
  if (proof?.allowed !== true) throw new Error(proof?.reason || 'context_fork_source_unavailable');
  if (!fork.fromLatestCompact) return payload;

  const result = await materializeCompact(sourceId, source.cwd, toolType);
  assertSource();
  if (result?.success !== true || !result.newSessionId || result.newSessionId === sourceId) {
    const error = new Error(result?.error || result?.reason || 'compact_fork_failed');
    error.code = result?.reason || 'compact_fork_failed';
    throw error;
  }
  // This is a readable, committed child, NOT a live writer. Bind only the
  // still-empty exact target before Resume; failure/Stop must not lose a
  // successfully bound branch or turn it back into its source conversation.
  commitReadBinding(result.newSessionId);
  onPhase('repairing-history', result.newSessionId);
  return { ...payload, command: toolType + '-c', sessionId: result.newSessionId,
    ...(toolType === 'claude' ? { cdTo: source.cwd } : {}),
    contextForkBinding: { tabId: payload.tabId, toolType, sessionId: result.newSessionId,
      sourceSessionId: sourceId, committed: true } };
}

module.exports = { prepareContextForkLaunch };
