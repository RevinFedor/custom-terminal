export function isDurableSaveTabsAck(result) {
  return result?.success === true;
}

// Close STOPS the Codex process and retries the History write — for exactly
// one refusal, and here is why that refusal exists at all:
//
// Codex can hand a session off A → B on resume: the saved row still names A
// while the live process may already be writing B. Archiving A and then killing
// the process would leave History pointing at the stale source while the only
// live copy of B dies. So the archive refuses
// ('codex_archive_live_writer_unproven') whenever the process is ALIVE, the row
// HAS a session, and the current writer is NOT proven — note "alive", not
// "answering": an idle open Codex is enough, which is why the middle-click did
// nothing visible on a quiet tab.
//
// The user's manual workaround was exactly the missing step: stop the process
// first (right-click → Стоп), then close. A stopped process cannot hand
// anything off, the proof question disappears, and the archive can commit the
// row's session. This automates that same order. Every OTHER refusal reason
// stays a hard stop: there the state is genuinely unknown, and stopping the
// process would not make it any more known.
export function shouldStopBeforeArchiveRetry({ reason, commandType } = {}) {
  return commandType === 'codex' && reason === 'codex_archive_live_writer_unproven';
}

/**
 * The close-time archive with the stop-then-retry rule applied.
 *
 * Returns commitArchiveBeforeClose's shape plus `stoppedForRetry`: true means
 * the process was ALREADY stopped here — the later stop-before-kill step will
 * find no process and succeed trivially (that path is idempotent by design).
 */
export async function commitArchiveWithStopRetry({
  shouldArchive,
  archive,
  commandType,
  stopProcess,
} = {}) {
  const first = await commitArchiveBeforeClose({ shouldArchive, archive });
  if (first.ok || !shouldStopBeforeArchiveRetry({ reason: first.reason, commandType })) {
    return { ...first, stoppedForRetry: false };
  }
  if (typeof stopProcess !== 'function') {
    return { ...first, stoppedForRetry: false };
  }
  let stopResult = null;
  try {
    stopResult = await stopProcess();
  } catch (error) {
    // The stop itself failed → the original refusal stands; the caller keeps
    // the tab and the process, exactly as before this rule existed.
    return { ...first, stoppedForRetry: false, stopError: error };
  }
  if (stopResult?.success !== true) {
    return { ...first, stoppedForRetry: false, stopResult };
  }
  const retried = await commitArchiveBeforeClose({ shouldArchive, archive });
  return { ...retried, stoppedForRetry: true, stopResult };
}

export async function commitArchiveBeforeClose({ shouldArchive, archive } = {}) {
  if (!shouldArchive) {
    return { ok: true, skipped: true, result: null };
  }
  if (typeof archive !== 'function') {
    return { ok: false, skipped: false, reason: 'archive_callback_required', result: null };
  }

  let result;
  try {
    result = await archive();
  } catch (error) {
    return { ok: false, skipped: false, reason: 'archive_ipc_failed', error, result: null };
  }

  if (result?.success !== true) {
    return {
      ok: false,
      skipped: false,
      reason: result?.error || 'archive_not_committed',
      result,
    };
  }
  if (result.historyId === null || result.historyId === undefined) {
    return { ok: false, skipped: false, reason: 'archive_history_id_missing', result };
  }

  return { ok: true, skipped: false, result };
}
