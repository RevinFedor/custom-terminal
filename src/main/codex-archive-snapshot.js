'use strict';

function finalizeCodexArchiveSnapshot({
  projectId,
  rowState,
  runtime,
  generationBefore,
  generationAfter,
} = {}) {
  if (generationBefore !== generationAfter) {
    return { success: false, error: 'codex_archive_generation_changed' };
  }
  if (rowState?.status === 'error') {
    // A failed read is genuinely unknown: the row may hold a session id we
    // would silently drop. Refusing is correct here.
    return { success: false, error: 'codex_archive_binding_read_failed' };
  }
  if (!runtime || runtime.liveLifecycle === null || runtime.liveLifecycle === undefined) {
    return { success: false, error: 'codex_archive_runtime_unknown' };
  }
  const rowFound = rowState?.status === 'found';
  if (!rowFound) {
    // No row at all means the tab was never persisted — a tab created in this
    // session and closed before its first save. There is no durable session to
    // protect, so refusing to archive only strands the tab: close aborts, the
    // tab and its process stay, and the user gets no dialog explaining why.
    // A LIVE process is the one case still worth refusing, because closing
    // would kill work whose identity we cannot record.
    if (runtime.liveLifecycle === true) {
      return { success: false, error: 'codex_archive_source_row_missing' };
    }
    return {
      success: true,
      processWasRunning: false,
      codexSessionId: null,
      generation: generationAfter,
      source: 'unpersisted-tab',
    };
  }
  if (runtime.projectId && runtime.projectId !== projectId) {
    return { success: false, error: 'codex_archive_project_mismatch' };
  }

  const live = runtime.liveLifecycle === true;
  const provenWriterSessionId = live && typeof runtime.provenWriterSessionId === 'string'
    ? runtime.provenWriterSessionId.trim()
    : '';
  // A live process with a durable resumable session but no current writer
  // proof may already have handed off A -> B. Archiving A would make close kill
  // the only live B process while History permanently points at the stale
  // source. A genuinely fresh live tab (real row + NULL) has no resumable
  // history to lose, so it may still close and archive NULL.
  if (live && rowState.sessionId && !provenWriterSessionId) {
    return { success: false, error: 'codex_archive_live_writer_unproven' };
  }
  return {
    success: true,
    processWasRunning: live,
    codexSessionId: provenWriterSessionId || rowState.sessionId || null,
    generation: generationAfter,
    source: provenWriterSessionId ? 'writer-proof' : 'tabs-row',
  };
}

module.exports = {
  finalizeCodexArchiveSnapshot,
};
