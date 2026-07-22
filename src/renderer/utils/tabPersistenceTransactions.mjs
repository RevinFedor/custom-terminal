export function isDurableSaveTabsAck(result) {
  return result?.success === true;
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
