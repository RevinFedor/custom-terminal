'use strict';

function persistCodexWriterBinding({
  projectId,
  tabId,
  sessionId,
  readBinding,
  writeBinding,
} = {}) {
  if (!projectId) return { success: false, error: 'codex_tab_project_unresolved', retryable: true };
  if (!tabId || !sessionId) return { success: false, error: 'codex_writer_identity_invalid', retryable: false };
  if (typeof readBinding !== 'function' || typeof writeBinding !== 'function') {
    return { success: false, error: 'scoped_codex_persistence_unavailable', retryable: true };
  }

  try {
    const currentSessionId = readBinding(projectId, tabId);
    if (currentSessionId === undefined) {
      return { success: false, error: 'codex_tab_row_missing', retryable: true };
    }
    if (currentSessionId === sessionId) {
      return { success: true, updated: false, currentSessionId };
    }
    const updated = writeBinding(projectId, tabId, sessionId);
    if (updated !== true) {
      return { success: false, error: 'codex_writer_binding_not_committed', retryable: true };
    }
    return { success: true, updated: true, currentSessionId };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
      retryable: true,
    };
  }
}

module.exports = {
  persistCodexWriterBinding,
};
