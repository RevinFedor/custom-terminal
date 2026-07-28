'use strict';

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalGeneration(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createHistoryPresenceTestGate(options = {}) {
  const enabled = options.enabled === true;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  let sequence = 0;
  const records = new Map();

  const makeArmId = typeof options.makeArmId === 'function'
    ? options.makeArmId
    : () => `history-presence-${now()}-${++sequence}`;

  function publicRecord(record) {
    if (!record) return null;
    return {
      armId: record.armId,
      tabId: record.tabId,
      requestedOwnerKey: record.requestedOwnerKey,
      requestedGeneration: record.requestedGeneration,
      ownerKey: record.ownerKey,
      generation: record.generation,
      state: record.state,
      armedAt: record.armedAt,
      heldAt: record.heldAt,
      releasedAt: record.releasedAt,
      releaseReason: record.releaseReason,
    };
  }

  function snapshot() {
    return Array.from(records.values()).map(publicRecord);
  }

  function arm(request = {}) {
    if (!enabled) return { success: false, error: 'disabled' };
    const tabId = normalizeRequiredString(request.tabId);
    if (!tabId) return { success: false, error: 'tabId required' };
    const requestedOwnerKey = normalizeRequiredString(request.ownerKey);
    const requestedGeneration = normalizeOptionalGeneration(request.generation);
    const armId = normalizeRequiredString(request.armId) || makeArmId();
    if (records.has(armId)) return { success: false, error: 'armId already exists', armId };

    const record = {
      armId,
      tabId,
      requestedOwnerKey,
      requestedGeneration,
      ownerKey: null,
      generation: null,
      state: 'armed',
      armedAt: now(),
      heldAt: null,
      releasedAt: null,
      releaseReason: null,
      resolve: null,
    };
    records.set(armId, record);
    onEvent('arm', publicRecord(record));
    return { success: true, arm: publicRecord(record) };
  }

  function matches(record, request) {
    if (record.state !== 'armed') return false;
    if (request.consumer !== 'history-panel') return false;
    if (record.tabId !== request.tabId) return false;
    if (!request.ownerKey || !Number.isFinite(request.generation)) return false;
    if (record.requestedOwnerKey && record.requestedOwnerKey !== request.ownerKey) return false;
    if (record.requestedGeneration !== null
      && record.requestedGeneration !== request.generation) return false;
    return true;
  }

  async function waitIfArmed(request = {}) {
    if (!enabled) return { held: false, reason: 'disabled' };
    const normalized = {
      tabId: normalizeRequiredString(request.tabId),
      consumer: normalizeRequiredString(request.consumer),
      ownerKey: normalizeRequiredString(request.ownerKey),
      generation: normalizeOptionalGeneration(request.generation),
    };
    const record = Array.from(records.values()).find((candidate) => matches(candidate, normalized));
    if (!record) return { held: false, reason: 'not-armed' };

    record.ownerKey = normalized.ownerKey;
    record.generation = normalized.generation;
    record.state = 'held';
    record.heldAt = now();
    const released = new Promise((resolve) => {
      record.resolve = resolve;
    });
    onEvent('hold', publicRecord(record));
    await released;
    onEvent(record.state === 'cancelled' ? 'cancelled' : 'release', publicRecord(record));
    return {
      held: true,
      armId: record.armId,
      state: record.state,
      ownerKey: record.ownerKey,
      generation: record.generation,
    };
  }

  function release(request = {}) {
    if (!enabled) return { success: false, error: 'disabled' };
    const armId = normalizeRequiredString(request.armId);
    if (!armId) return { success: false, error: 'armId required' };
    const record = records.get(armId);
    if (!record) return { success: false, error: 'arm not found', armId };
    if (record.state !== 'held' || typeof record.resolve !== 'function') {
      return { success: false, error: 'arm is not held', arm: publicRecord(record) };
    }
    record.state = 'released';
    record.releasedAt = now();
    record.releaseReason = normalizeRequiredString(request.reason) || 'test-release';
    const resolve = record.resolve;
    record.resolve = null;
    resolve();
    return { success: true, arm: publicRecord(record) };
  }

  function clear(reason = 'test-clear') {
    let released = 0;
    for (const record of records.values()) {
      if (record.state === 'held' && typeof record.resolve === 'function') {
        record.state = 'cancelled';
        record.releasedAt = now();
        record.releaseReason = reason;
        const resolve = record.resolve;
        record.resolve = null;
        resolve();
        released += 1;
      } else if (record.state === 'armed') {
        record.state = 'cancelled';
        record.releasedAt = now();
        record.releaseReason = reason;
      }
    }
    return { success: true, released, arms: snapshot() };
  }

  return {
    enabled,
    arm,
    waitIfArmed,
    release,
    clear,
    snapshot,
  };
}

module.exports = {
  createHistoryPresenceTestGate,
};
