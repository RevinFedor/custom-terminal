'use strict';

const { randomUUID } = require('node:crypto');
const { desktopHistorySendReplayResult } = require('./agent-history-send-receipt');

// Presentation only: an unfinished send is not a busy provider turn or a PTY
// write lock. Keep only compact identities, never prompt bodies or DB rows.
function createAgentSendActivity({ onChanged = () => {}, generation = randomUUID() } = {}) {
  const operations = new Map();
  let revision = 0;
  let current = { generation, revision, pendingTabIds: [] };
  // Reserved/preparing can be a persisted, retryable request with no running
  // attempt (e.g. preparation already refused). They are not live activity.
  const pendingStates = new Set(['in-flight', 'enter-armed', 'audit-pending']);
  const update = (record) => {
    if (!record?.operationKey) return;
    const before = operations.get(record.operationKey);
    // A committed native queue remains QUEUED even when the old caller timed
    // out. Reuse the receipt's existing public interpretation, not a second
    // text matcher or a new delivery rule for the loader.
    const queued = record.state === 'delivery-unknown'
      && desktopHistorySendReplayResult(record).status === 'queued';
    const tabId = (pendingStates.has(record.state) || queued) && record.tabId ? record.tabId : null;
    if (tabId === (before || null)) return;
    if (tabId) operations.set(record.operationKey, tabId);
    else operations.delete(record.operationKey);
    const pendingTabIds = [...new Set(operations.values())].sort();
    if (pendingTabIds.length === current.pendingTabIds.length
      && pendingTabIds.every((id, index) => id === current.pendingTabIds[index])) return;
    current = { generation, revision: ++revision, pendingTabIds };
    onChanged(current);
  };
  return { update, snapshot: () => current };
}

module.exports = { createAgentSendActivity };
