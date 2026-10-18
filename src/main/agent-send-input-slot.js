'use strict';

// Delivery receipts describe history. A slot is only permission to serialize
// writes into one physical input owner; retiring it never confirms delivery.
function inputLeaseForRecord(record) {
  if (record?.inputLease?.version === 1) return record.inputLease;
  const evidence = record?.receipt?.providerQueue?.evidence;
  if (!evidence?.lifecycleGeneration || !Number.isSafeInteger(evidence.runSeq)) return null;
  return { version: 1, tabId: record.tabId, provider: record.provider,
    lifecycleGeneration: evidence.lifecycleGeneration, runSeq: evidence.runSeq, legacy: true };
}

function classifyInputSlotRetirement(record, observation) {
  if (!record?.attemptId || !['audit-pending', 'delivery-unknown', 'enter-armed', 'confirmed'].includes(record.state)) {
    return { retire: false, reason: 'attempt-not-settled' };
  }
  const rendererLost = record.deliveryControl?.cancelledAt
    && record.deliveryControl.reason === 'send-renderer-owner-lost';
  if (record.deliveryControl?.cancelledAt && !rendererLost) {
    // An automatic lost-renderer fence revokes future input only. It is not
    // the user's explicit permission to move past an uncertain earlier Enter,
    // but the existing independent physical absence/replacement proof remains valid.
    return { retire: true, reason: 'user-cancelled-intent' };
  }
  if (observation?.version !== 1 || observation.kind !== 'main-input-slot'
    || observation.tabId !== record.tabId || observation.known !== true
    || observation.ownerStable !== true) return { retire: false,
      reason: rendererLost ? 'renderer-lost-delivery-unknown' : 'input-owner-unknown' };
  if (observation.processStatus === 'absent') return { retire: true, reason: 'physical-process-absent' };
  if (observation.processStatus !== 'found' || observation.inputReady !== true) {
    return { retire: false, reason: 'current-input-not-ready' };
  }
  const lease = inputLeaseForRecord(record), owner = observation.owner;
  if (!lease || !owner?.lifecycleGeneration || !Number.isSafeInteger(owner.runSeq) || owner.runSeq <= 0) {
    return { retire: false, reason: 'input-lease-unavailable' };
  }
  if (owner.lifecycleGeneration !== lease.lifecycleGeneration || owner.runSeq !== lease.runSeq) {
    return { retire: true, reason: 'physical-input-owner-replaced' };
  }
  return { retire: false, reason: 'same-input-owner' };
}

function sendInputSlot(record, item) {
  const release = item?.slot_release_json ? JSON.parse(item.slot_release_json)
    : item?.release_json ? JSON.parse(item.release_json) : null;
  return { version: 1, state: release ? 'retired'
    : ['dispatching', 'awaiting-receipt'].includes(item?.state) ? 'held' : 'none',
  reason: release?.reason || release?.kind || null, retiredAt: release?.retiredAt || release?.releasedAt || null };
}

module.exports = { inputLeaseForRecord, classifyInputSlotRetirement, sendInputSlot };
