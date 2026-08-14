import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commitArchiveBeforeClose,
  isDurableSaveTabsAck,
} from './tabPersistenceTransactions.mjs';

test('close archive gate accepts only a committed history row', async () => {
  assert.deepEqual(
    await commitArchiveBeforeClose({
      shouldArchive: true,
      archive: async () => ({ success: true, historyId: 41 }),
    }),
    { ok: true, skipped: false, result: { success: true, historyId: 41 } },
  );

  const rejected = await commitArchiveBeforeClose({
    shouldArchive: true,
    archive: async () => ({ success: false, error: 'sqlite_busy' }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'sqlite_busy');

  const missingId = await commitArchiveBeforeClose({
    shouldArchive: true,
    archive: async () => ({ success: true }),
  });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.reason, 'archive_history_id_missing');

  const thrown = await commitArchiveBeforeClose({
    shouldArchive: true,
    archive: async () => { throw new Error('ipc disconnected'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'archive_ipc_failed');
  assert.match(thrown.error.message, /ipc disconnected/);
});

test('explicit no-history close bypasses archive, while save ACK stays strict', async () => {
  let archiveCalls = 0;
  assert.deepEqual(
    await commitArchiveBeforeClose({
      shouldArchive: false,
      archive: async () => {
        archiveCalls += 1;
        return { success: true, historyId: 1 };
      },
    }),
    { ok: true, skipped: true, result: null },
  );
  assert.equal(archiveCalls, 0);

  assert.equal(isDurableSaveTabsAck({ success: true }), true);
  assert.equal(isDurableSaveTabsAck({ success: false }), false);
  assert.equal(isDurableSaveTabsAck(undefined), false);
  assert.equal(isDurableSaveTabsAck({}), false);
});

// ── Codex close: stop the process, then retry the History write ───────────

import {
  commitArchiveWithStopRetry,
  shouldStopBeforeArchiveRetry,
} from './tabPersistenceTransactions.mjs';

test('only the unproven-writer refusal on a Codex tab triggers the stop', () => {
  assert.equal(shouldStopBeforeArchiveRetry({
    reason: 'codex_archive_live_writer_unproven', commandType: 'codex',
  }), true);
  // Every other refusal is genuinely unknown state — stopping would not make
  // it known, so it stays a hard stop.
  for (const reason of [
    'codex_archive_binding_read_failed',
    'codex_archive_runtime_unknown',
    'codex_archive_generation_changed',
    'codex_archive_project_mismatch',
    'sqlite_busy',
  ]) {
    assert.equal(shouldStopBeforeArchiveRetry({ reason, commandType: 'codex' }), false, reason);
  }
  // …and the rule is Codex-only: Claude's archive cannot refuse this way.
  assert.equal(shouldStopBeforeArchiveRetry({
    reason: 'codex_archive_live_writer_unproven', commandType: 'claude',
  }), false);
});

test('the reported bug: idle live Codex → stop, retry, close proceeds', async () => {
  // First archive refuses (live process, saved session, no writer proof);
  // after the stop the same call commits.
  let archiveCalls = 0;
  let stopped = false;
  const res = await commitArchiveWithStopRetry({
    shouldArchive: true,
    commandType: 'codex',
    archive: async () => {
      archiveCalls += 1;
      return stopped
        ? { success: true, historyId: 7 }
        : { success: false, error: 'codex_archive_live_writer_unproven' };
    },
    stopProcess: async () => { stopped = true; return { success: true }; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.stoppedForRetry, true, 'caller must know the process is already down');
  assert.equal(archiveCalls, 2);
});

test('a failed stop keeps the original refusal — tab and process stay', async () => {
  const failedStop = await commitArchiveWithStopRetry({
    shouldArchive: true,
    commandType: 'codex',
    archive: async () => ({ success: false, error: 'codex_archive_live_writer_unproven' }),
    stopProcess: async () => ({ success: false, error: 'stop_not_confirmed' }),
  });
  assert.equal(failedStop.ok, false);
  assert.equal(failedStop.reason, 'codex_archive_live_writer_unproven');
  assert.equal(failedStop.stoppedForRetry, false);

  const threwStop = await commitArchiveWithStopRetry({
    shouldArchive: true,
    commandType: 'codex',
    archive: async () => ({ success: false, error: 'codex_archive_live_writer_unproven' }),
    stopProcess: async () => { throw new Error('ipc gone'); },
  });
  assert.equal(threwStop.ok, false);
  assert.equal(threwStop.stoppedForRetry, false);
});

test('a retry that still refuses reports the RETRY reason and the stop', async () => {
  // E.g. the process died mid-flight and the generation moved: the second
  // answer describes the state the caller must react to now.
  let calls = 0;
  const res = await commitArchiveWithStopRetry({
    shouldArchive: true,
    commandType: 'codex',
    archive: async () => {
      calls += 1;
      return { success: false, error: calls === 1 ? 'codex_archive_live_writer_unproven' : 'codex_archive_generation_changed' };
    },
    stopProcess: async () => ({ success: true }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'codex_archive_generation_changed');
  assert.equal(res.stoppedForRetry, true);
});

test('non-Codex tabs and success paths never call stop', async () => {
  let stopCalls = 0;
  const ok = await commitArchiveWithStopRetry({
    shouldArchive: true,
    commandType: 'claude',
    archive: async () => ({ success: true, historyId: 3 }),
    stopProcess: async () => { stopCalls += 1; return { success: true }; },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.stoppedForRetry, false);

  const claudeRefusal = await commitArchiveWithStopRetry({
    shouldArchive: true,
    commandType: 'claude',
    archive: async () => ({ success: false, error: 'codex_archive_live_writer_unproven' }),
    stopProcess: async () => { stopCalls += 1; return { success: true }; },
  });
  assert.equal(claudeRefusal.ok, false);
  assert.equal(stopCalls, 0);
});
