'use strict';

const { randomUUID } = require('node:crypto');
// Presentation only. Writing/preparation and read-only delivery confirmation
// are different phases; neither one is authority for the provider turn.
function createAgentSendActivity({ onChanged = () => {}, generation = randomUUID() } = {}) {
  const operations = new Map();
  let revision = 0;
  let current = { generation, revision, pendingTabIds: [], observingHandoffs: [] };
  // Reserved/preparing can be a persisted, retryable request with no running
  // attempt (e.g. preparation already refused). They are not live activity.
  const pendingStates = new Set(['in-flight', 'enter-armed']);
  const update = (record) => {
    if (!record?.operationKey) return;
    const before = operations.get(record.operationKey);
    const active = pendingStates.has(record.state);
    const observing = record.state === 'audit-pending';
    const operation = { tabId: record.tabId, handoffId: record.handoffId,
      attemptId: record.attemptId, active };
    if (before && before.tabId === operation.tabId && before.handoffId === operation.handoffId
      && before.attemptId === operation.attemptId && before.active === active && (active || observing)) return;
    if ((active || observing) && record.tabId) operations.set(record.operationKey, operation);
    else operations.delete(record.operationKey);
    const values = [...operations.values()];
    const pendingTabIds = [...new Set(values.filter(item => item.active).map(item => item.tabId))].sort();
    const observingHandoffs = values.filter(item => !item.active && item.handoffId);
    // Exact handoff phase also releases local promises still awaiting their
    // receipt response. A terminal result must not resurrect that local spinner.
    current = { generation, revision: ++revision, pendingTabIds, observingHandoffs,
      lastOperation: ['reserved', 'preparing'].includes(record.state) ? null : operation };
    onChanged(current);
  };
  return { update, snapshot: () => current };
}

module.exports = { createAgentSendActivity };
