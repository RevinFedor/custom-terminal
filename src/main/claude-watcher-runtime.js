'use strict';

function toolTypeOf(status) {
  const value = String(status?.toolType || status?.commandType || '').trim().toLowerCase();
  return value === 'claude' || value === 'codex' ? value : null;
}

/**
 * Resolve the two independent facts needed when a mobile subscriber starts a
 * Claude JSONL watcher:
 *
 * - renderer status supplies presentation-only metadata such as cwd;
 * - main runtime supplies the current lifecycle/session owner.
 *
 * A renderer answer may have been captured before startup defaults committed.
 * It is therefore safe for locating a legacy file only when main is
 * unavailable, but it must never be broadcast as current lifecycle truth.
 */
async function resolveClaudeWatcherRuntime({
  tabId,
  readRendererStatus,
  readMainRuntime,
  isCurrent = () => true,
}) {
  const rendererStatus = await readRendererStatus(tabId);
  if (!isCurrent()) return {
    cancelled: true,
    rendererStatus,
    watcherStatus: null,
    publicSnapshot: null,
  };

  let mainRuntime = null;
  let mainError = null;
  if (typeof readMainRuntime === 'function') {
    try {
      mainRuntime = await readMainRuntime(tabId);
    } catch (error) {
      mainError = error;
    }
  }
  if (!isCurrent()) return {
    cancelled: true,
    rendererStatus,
    watcherStatus: null,
    publicSnapshot: null,
    mainError,
  };

  if (!mainRuntime || typeof mainRuntime !== 'object') {
    return {
      cancelled: false,
      rendererStatus,
      // Preserve the JSONL watcher capability when the main read is
      // temporarily unavailable. No lifecycle snapshot is emitted from this
      // fallback; the next authoritative event/read will describe it.
      watcherStatus: rendererStatus,
      publicSnapshot: null,
      mainError,
      reason: typeof readMainRuntime === 'function'
        ? 'main-runtime-unavailable'
        : 'main-runtime-reader-unavailable',
    };
  }

  const mainToolType = toolTypeOf(mainRuntime);
  const hasWriterField = Object.prototype.hasOwnProperty.call(mainRuntime, 'writerSessionId');
  const currentSessionId = hasWriterField
    ? (mainRuntime.writerSessionId || null)
    : (mainRuntime.sessionId || rendererStatus?.sessionId || null);
  const watcherStatus = {
    ...(rendererStatus || {}),
    ...mainRuntime,
    cwd: mainRuntime.cwd || rendererStatus?.cwd || null,
    sessionId: currentSessionId,
    ...(mainToolType ? { toolType: mainToolType, commandType: mainToolType } : {}),
  };

  if (mainToolType !== 'claude') {
    return {
      cancelled: false,
      rendererStatus,
      watcherStatus,
      publicSnapshot: null,
      mainError,
      reason: 'current-provider-not-claude',
    };
  }

  return {
    cancelled: false,
    rendererStatus,
    watcherStatus,
    publicSnapshot: {
      ...watcherStatus,
      type: 'snapshot',
      tabId,
      coherent: true,
    },
    mainError,
    reason: 'main-runtime-current',
  };
}

module.exports = { resolveClaudeWatcherRuntime, toolTypeOf };
