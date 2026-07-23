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
  if (!rowState || rowState.status !== 'found') {
    return {
      success: false,
      error: rowState?.status === 'error'
        ? 'codex_archive_binding_read_failed'
        : 'codex_archive_source_row_missing',
    };
  }
  if (!runtime || runtime.liveLifecycle === null || runtime.liveLifecycle === undefined) {
    return { success: false, error: 'codex_archive_runtime_unknown' };
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
