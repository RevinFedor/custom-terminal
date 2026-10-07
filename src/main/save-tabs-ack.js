'use strict';

const { validateForceCleanupTabIds } = require('./save-tabs-precondition');

function normalizeSaveTabsAck(result) {
  if (result?.success === true) return result;
  return {
    success: false,
    error: typeof result?.error === 'string' && result.error.trim()
      ? result.error
      : 'save_tabs_not_committed',
  };
}

function runSaveTabsWithAck(save) {
  if (typeof save !== 'function') {
    return { success: false, error: 'save_tabs_callback_required' };
  }
  try {
    return normalizeSaveTabsAck(save());
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
      ...(error?.code==='execution_storage_revision_changed'?{revisionConflict:{tabId:error.tabId,
        expectedRevision:error.expectedRevision,actualRevision:error.actualRevision}}:{}),
    };
  }
}

// All catalogs touched by one close must commit or roll back together.
function runSaveTabsBatchWithAck({ snapshots, transaction, getTabIds, save,beforeSave,afterSave } = {}) {
  if (!Array.isArray(snapshots) || snapshots.length === 0
    || snapshots.some(row => !row || typeof row.projectId !== 'string' || !row.projectId || !Array.isArray(row.tabs))
    || new Set(snapshots.map(row => row.projectId)).size !== snapshots.length) {
    return { success: false, error: 'save_tabs_batch_invalid' };
  }
  return runSaveTabsWithAck(() => transaction(() => {
    const closeProof=beforeSave?.(snapshots);
    if(closeProof?.then)throw new Error('save_tabs_batch_sync_required');
    for (const row of snapshots) {
      const precondition = validateForceCleanupTabIds({ forceCleanup: true,
        expectedTabIds: row.expectedTabIds, actualTabIds: getTabIds(row.projectId) });
      if (!precondition.ok) throw new Error(precondition.error);
    }
    for (const row of snapshots) {
      const result = normalizeSaveTabsAck(save(row));
      if (result.success !== true) throw new Error(result.error);
    }
    const completion=afterSave?.(closeProof,snapshots);
    if(completion?.then)throw new Error('save_tabs_batch_sync_required');
    return { success: true, projectIds: snapshots.map(row => row.projectId) };
  })());
}

module.exports = {
  normalizeSaveTabsAck,
  runSaveTabsWithAck,
  runSaveTabsBatchWithAck,
};
