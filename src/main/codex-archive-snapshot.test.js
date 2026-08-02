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
  assert.equal(finalizeCodexArchiveSnapshot({ ...base, rowState: { status: 'error' } }).error, 'codex_archive_binding_read_failed');

  const stoppedNull = finalizeCodexArchiveSnapshot(base);
  assert.equal(stoppedNull.success, true);
  assert.equal(stoppedNull.processWasRunning, false);
  assert.equal(stoppedNull.codexSessionId, null, 'a real row with NULL remains authoritative');
});

test('a tab that was never persisted still closes when nothing is running', () => {
  // Measured live: a Codex tab created and closed before its first save has no
  // row at all. Refusing here stranded the tab — close aborted, tab and process
  // stayed, and no dialog explained why (the refusal happens after the confirm
  // step, so the user saw a middle-click that simply did nothing).
  const result = finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: { status: 'missing' },
    runtime: { projectId: 'project-a', liveLifecycle: false, provenWriterSessionId: null },
    generationBefore: 'generation-a',
    generationAfter: 'generation-a',
  });
  assert.equal(result.success, true);
  assert.equal(result.processWasRunning, false);
  assert.equal(result.codexSessionId, null);
  assert.equal(result.source, 'unpersisted-tab');
});

test('an unpersisted tab with a live process is still refused', () => {
  // Nothing records what this process was, so closing it would kill work whose
  // identity History can never recover. This is the case the guard was for.
  assert.equal(finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: { status: 'missing' },
    runtime: { projectId: 'project-a', liveLifecycle: true, provenWriterSessionId: null },
    generationBefore: 'generation-a',
    generationAfter: 'generation-a',
  }).error, 'codex_archive_source_row_missing');
});

test('an unpersisted tab is still bound to one generation and a known runtime', () => {
  const missing = { status: 'missing' };
  assert.equal(finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: missing,
    runtime: { projectId: 'project-a', liveLifecycle: false },
    generationBefore: 'generation-a',
    generationAfter: 'generation-b',
  }).error, 'codex_archive_generation_changed');
  assert.equal(finalizeCodexArchiveSnapshot({
    projectId: 'project-a',
    rowState: missing,
    runtime: { projectId: 'project-a', liveLifecycle: null },
    generationBefore: 'generation-a',
    generationAfter: 'generation-a',
  }).error, 'codex_archive_runtime_unknown');
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
