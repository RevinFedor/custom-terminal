'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { finalizeCodexArchiveSnapshot } = require('./codex-archive-snapshot');

test('archive snapshot binds running state and writer identity to one generation', () => {
  assert.deepEqual(finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: { status: 'found', sessionId: 'saved-source' },
    runtime: {
      projectId: 'project-a',
      liveLifecycle: true,
      provenWriterSessionId: 'live-writer',
    },
    generationBefore: 'pty-10:run-3:launch-7',
    generationAfter: 'pty-10:run-3:launch-7',
  }), {
    success: true,
    processWasRunning: true,
    codexSessionId: 'live-writer',
    generation: 'pty-10:run-3:launch-7',
    source: 'writer-proof',
  });
});

test('archive rejects mixed generations, unknown runtime, and missing source rows', () => {
  const base = {
    projectId: 'project-a',
    rowState: { status: 'found', sessionId: null },
    runtime: { projectId: 'project-a', liveLifecycle: false, provenWriterSessionId: null },
    generationBefore: 'generation-a',
    generationAfter: 'generation-a',
  };
  assert.equal(finalizeCodexArchiveSnapshot({ ...base, generationAfter: 'generation-b' }).error, 'codex_archive_generation_changed');
  assert.equal(finalizeCodexArchiveSnapshot({ ...base, runtime: { ...base.runtime, liveLifecycle: null } }).error, 'codex_archive_runtime_unknown');
  assert.equal(finalizeCodexArchiveSnapshot({ ...base, rowState: { status: 'missing' } }).error, 'codex_archive_source_row_missing');
  assert.equal(finalizeCodexArchiveSnapshot({ ...base, rowState: { status: 'error' } }).error, 'codex_archive_binding_read_failed');

  const stoppedNull = finalizeCodexArchiveSnapshot(base);
  assert.equal(stoppedNull.success, true);
  assert.equal(stoppedNull.processWasRunning, false);
  assert.equal(stoppedNull.codexSessionId, null, 'a real row with NULL remains authoritative');
});

test('live resumable session without writer proof is not archived as its stale source', () => {
  const result = finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: { status: 'found', sessionId: 'saved-source-a' },
    runtime: {
      projectId: 'project-a',
      liveLifecycle: true,
      provenWriterSessionId: null,
    },
    generationBefore: 'pty-10:run-3:launch-7',
    generationAfter: 'pty-10:run-3:launch-7',
  });
  assert.deepEqual(result, {
    success: false,
    error: 'codex_archive_live_writer_unproven',
  });

  const fresh = finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: { status: 'found', sessionId: null },
    runtime: {
      projectId: 'project-a',
      liveLifecycle: true,
      provenWriterSessionId: null,
    },
    generationBefore: 'fresh-generation',
    generationAfter: 'fresh-generation',
  });
  assert.equal(fresh.success, true);
  assert.equal(fresh.processWasRunning, true);
  assert.equal(fresh.codexSessionId, null);
});
