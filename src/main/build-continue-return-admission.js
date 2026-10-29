'use strict';

const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
// Only reserves already-ready returns of the captured dependencies. It never
// sends a task again, moves a FIFO item, or interprets UNKNOWN as no input.
function createBuildContinueReturnAdmission({ snapshot, readQueued, readReceipt, reserve, wake }) {
  const preparing = new Map();
  const attempts = new Map();
  const key = value => fingerprintAgentSendRequest(value);
  function admitted(ref) {
    const item = readQueued(ref.operationKey);
    if (item) {
      let request; try { request = JSON.parse(item.request_json); } catch { return false; }
      return item.tab_id === ref.tabId && item.operation_key === ref.operationKey
        && item.request_hash === key(request) && request.tabId === ref.tabId
        && request.handoffId === ref.handoffId && request.source === ref.source;
    }
    const record = readReceipt(ref.operationKey);
    return record?.state === 'confirmed' && record.tabId === ref.tabId && record.handoffId === ref.handoffId
      && record.auditIdentity?.attemptId === record.attemptId && !!record.attemptId;
  }
  return {
    async prepare(operation, target) {
      const current = snapshot(operation, target);
      if (current.known !== true) return { ready: false, reason: current.reason || 'return-authority-unknown' };
      const ownerKey = JSON.stringify([operation.id || null, target.source?.tabId || null]), revision = key(current);
      let attempted = attempts.get(ownerKey);
      if (attempted?.revision !== revision) {
        attempted = { revision, keys: new Set() }; attempts.set(ownerKey, attempted);
      }
      let pending = false;
      for (const ref of current.returns) if (!admitted(ref)) {
        pending = true;
        const record = readReceipt(ref.operationKey);
        if (record?.attemptId || ['delivery-unknown', 'audit-pending'].includes(record?.state)
          || record?.receipt?.deliveryUnknown) continue;
        if (!preparing.has(ref.operationKey) && !attempted.keys.has(ref.operationKey)) {
          attempted.keys.add(ref.operationKey);
          const work = Promise.resolve().then(() => reserve(ref)).catch(() => {})
            .finally(() => { preparing.delete(ref.operationKey); wake(); });
          preparing.set(ref.operationKey, work);
        }
      }
      if (pending) return { ready: false, reason: 'captured-return-reservation-pending' };
      return { ready: true, isCurrent: () => {
        const next = snapshot(operation, target);
        return next.known === true && key(next) === revision && next.returns.every(admitted);
      } };
    },
    forget(operationId) {
      for (const ownerKey of attempts.keys()) if (JSON.parse(ownerKey)[0] === operationId) attempts.delete(ownerKey);
    },
  };
}
module.exports = { createBuildContinueReturnAdmission };
