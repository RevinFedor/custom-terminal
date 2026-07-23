'use strict';

function normalizeTabIds(tabIds) {
  if (!Array.isArray(tabIds)) return [];
  return Array.from(new Set(tabIds.filter((id) => typeof id === 'string' && id.trim())));
}

function commitTabProjectTransfer({
  terminals,
  terminalProjectIds,
  tabIds,
  sourceProjectId,
  targetProjectId,
  transferRows,
} = {}) {
  const ids = normalizeTabIds(tabIds);
  if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId || ids.length === 0) {
    return { success: false, error: 'invalid_tab_project_transfer' };
  }
  if (!terminals || !terminalProjectIds || typeof transferRows !== 'function') {
    return { success: false, error: 'tab_project_transfer_dependencies_missing' };
  }

  // Validate every live owner before touching SQLite so a batch is all-or-none.
  for (const tabId of ids) {
    const owner = terminalProjectIds.get(tabId) || null;
    if (owner && owner !== sourceProjectId) {
      return {
        success: false,
        error: 'tab_project_owner_mismatch',
        tabId,
        owner,
        expectedOwner: sourceProjectId,
      };
    }
  }

  let persisted;
  try {
    persisted = transferRows({ sourceProjectId, targetProjectId, tabIds: ids });
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
    };
  }
  if (persisted?.success !== true) {
    return {
      success: false,
      error: persisted?.error || 'tab_project_rows_not_transferred',
      details: persisted || null,
    };
  }

  // Main is single-threaded: no process reconciliation can observe the DB move
  // without also observing this ownership update before the sync IPC returns.
  const liveTabIds = [];
  for (const tabId of ids) {
    if (terminals.has(tabId) || terminalProjectIds.has(tabId)) {
      terminalProjectIds.set(tabId, targetProjectId);
      liveTabIds.push(tabId);
    }
  }
  return {
    success: true,
    transferred: ids,
    liveTabIds,
  };
}

function commitTabGroupProjectTransfer({
  terminals,
  terminalProjectIds,
  tabIds,
  sourceProjectId,
  targetProjectId,
  groupId,
  targetGroupId,
  transferRows,
} = {}) {
  const ids = normalizeTabIds(tabIds);
  if (
    !sourceProjectId
    || !targetProjectId
    || sourceProjectId === targetProjectId
    || !groupId
    || !targetGroupId
  ) {
    return { success: false, error: 'invalid_tab_group_project_transfer' };
  }
  if (!terminals || !terminalProjectIds || typeof transferRows !== 'function') {
    return { success: false, error: 'tab_group_project_transfer_dependencies_missing' };
  }

  for (const tabId of ids) {
    const owner = terminalProjectIds.get(tabId) || null;
    if (owner && owner !== sourceProjectId) {
      return {
        success: false,
        error: 'tab_project_owner_mismatch',
        tabId,
        owner,
        expectedOwner: sourceProjectId,
      };
    }
  }

  let persisted;
  try {
    persisted = transferRows({
      sourceProjectId,
      targetProjectId,
      groupId,
      targetGroupId,
      tabIds: ids,
    });
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
  if (persisted?.success !== true) {
    return {
      success: false,
      error: persisted?.error || 'tab_group_project_rows_not_transferred',
      details: persisted || null,
    };
  }

  const liveTabIds = [];
  for (const tabId of ids) {
    if (terminals.has(tabId) || terminalProjectIds.has(tabId)) {
      terminalProjectIds.set(tabId, targetProjectId);
      liveTabIds.push(tabId);
    }
  }
  return {
    success: true,
    transferred: ids,
    liveTabIds,
    sourceGroupId: groupId,
    targetGroupId,
  };
}

module.exports = {
  commitTabGroupProjectTransfer,
  commitTabProjectTransfer,
  normalizeTabIds,
};
