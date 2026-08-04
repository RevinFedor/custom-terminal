'use strict';

const VALID_ACTIONS = new Set(['hold', 'reject', 'drop', 'inject']);

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(label + ' must be a non-empty string');
  return normalized;
}

function cloneScalarMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object');
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || raw === null || raw === undefined || raw === '') continue;
    if (!['string', 'number', 'boolean'].includes(typeof raw)) {
      throw new TypeError(label + '.' + key + ' must be a scalar');
    }
    result[key] = raw;
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError(label + ' must contain at least one scalar');
  }
  return result;
}

function optionalScalarMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || raw === null || raw === undefined) continue;
    if (!['string', 'number', 'boolean'].includes(typeof raw)) continue;
    result[key] = raw;
  }
  return result;
}

function identityMatches(expected, actual) {
  return Object.entries(expected).every(([key, value]) => Object.is(actual[key], value));
}

function buildResidualEmptyFrameAnsi(markerValue) {
  const marker = requiredText(markerValue, 'marker');
  if (!/^[\x21-\x7e]+$/.test(marker)) {
    throw new TypeError('marker must contain printable single-width ASCII only');
  }
  return '\x1b[?2026h' + marker + '\x1b[' + marker.length + 'D\x1b[?2026l';
}

function buildMissingPromptEmptyFrameAnsi(cursorXValue) {
  const cursorX = Number(cursorXValue);
  if (!Number.isInteger(cursorX) || cursorX < 0 || cursorX > 9999) {
    throw new TypeError('cursorX must be a non-negative integer');
  }
  return '\x1b[?2026h\r\x1b[2K'
    + (cursorX > 0 ? ('\x1b[' + cursorX + 'C') : '')
    + '\x1b[?2026l';
}

function createE2eBoundaryTestGate(options = {}) {
  const enabled = options.enabled === true;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  let armSequence = 0;
  let operationSequence = 0;
  const records = new Map();
  const makeArmId = typeof options.makeArmId === 'function'
    ? options.makeArmId
    : () => 'ai-boundary-arm-' + now() + '-' + (++armSequence);
  const makeOperationId = typeof options.makeOperationId === 'function'
    ? options.makeOperationId
    : () => 'ai-boundary-op-' + now() + '-' + (++operationSequence);

  function publicRecord(record) {
    if (!record) return null;
    return {
      armId: record.armId,
      operationId: record.operationId,
      kind: record.kind,
      action: record.action,
      requestedIdentity: { ...record.requestedIdentity },
      boundIdentity: record.boundIdentity ? { ...record.boundIdentity } : null,
      state: record.state,
      armedAt: record.armedAt,
      heldAt: record.heldAt,
      releasedAt: record.releasedAt,
      completedAt: record.completedAt,
      reason: record.reason,
      result: record.result ? { ...record.result } : null,
    };
  }

  function emit(kind, record) {
    onEvent(kind, publicRecord(record));
  }

  function snapshot() {
    return Array.from(records.values()).map(publicRecord);
  }

  function arm(request = {}) {
    if (!enabled) return { success: false, error: 'test_hook_disabled' };
    let kind;
    let requestedIdentity;
    try {
      kind = requiredText(request.kind, 'kind');
      requestedIdentity = cloneScalarMap(request.identity, 'identity');
    } catch (error) {
      return { success: false, error: error.message };
    }
    const action = String(request.action || 'hold').trim();
    if (!VALID_ACTIONS.has(action)) {
      return { success: false, error: 'unsupported action' };
    }
    const armId = typeof request.armId === 'string' && request.armId.trim()
      ? request.armId.trim()
      : makeArmId();
    if (records.has(armId)) return { success: false, error: 'armId already exists', armId };
    const record = {
      armId,
      operationId: null,
      kind,
      action,
      requestedIdentity,
      boundIdentity: null,
      payload: optionalScalarMap(request.payload),
      state: 'armed',
      armedAt: now(),
      heldAt: null,
      releasedAt: null,
      completedAt: null,
      reason: null,
      result: null,
      resolve: null,
    };
    records.set(armId, record);
    emit('arm', record);
    return { success: true, arm: publicRecord(record) };
  }

  function findCandidate(kind, identity) {
    const matches = Array.from(records.values()).filter((record) => (
      record.state === 'armed'
      && record.kind === kind
      && identityMatches(record.requestedIdentity, identity)
    ));
    if (matches.length > 1) return { error: 'ambiguous_test_hook', matches };
    return { record: matches[0] || null };
  }

  function claim(request = {}) {
    if (!enabled) return { claimed: false, reason: 'test_hook_disabled' };
    let kind;
    let identity;
    try {
      kind = requiredText(request.kind, 'kind');
      identity = cloneScalarMap(request.identity, 'identity');
    } catch (error) {
      return { claimed: false, reason: error.message };
    }
    const selected = findCandidate(kind, identity);
    if (selected.error) {
      return { claimed: false, reason: selected.error };
    }
    const record = selected.record;
    if (!record) return { claimed: false, reason: 'not-armed' };
    record.operationId = makeOperationId();
    record.boundIdentity = { ...identity };
    record.state = record.action === 'hold' ? 'held' : 'claimed';
    record.heldAt = now();
    let released = null;
    if (record.action === 'hold') {
      released = new Promise((resolve) => { record.resolve = resolve; });
    }
    emit(record.state === 'held' ? 'hold' : 'claim', record);
    return {
      claimed: true,
      action: record.action,
      arm: publicRecord(record),
      payload: { ...record.payload },
      released,
    };
  }

  async function waitIfArmed(request = {}) {
    const claimed = claim(request);
    if (!claimed.claimed || claimed.action !== 'hold') return claimed;
    const record = records.get(claimed.arm.armId);
    if (!record || record.state !== 'held' || !claimed.released) {
      return { claimed: false, reason: 'held_record_missing' };
    }
    const release = await claimed.released;
    emit(record.state === 'cancelled' ? 'cancel' : 'release', record);
    return {
      ...claimed,
      state: record.state,
      release,
    };
  }

  function release(request = {}) {
    if (!enabled) return { success: false, error: 'test_hook_disabled' };
    const armId = typeof request.armId === 'string' ? request.armId.trim() : '';
    const operationId = typeof request.operationId === 'string'
      ? request.operationId.trim()
      : '';
    if (!armId || !operationId) {
      return { success: false, error: 'armId and operationId required' };
    }
    const record = records.get(armId);
    if (!record) return { success: false, error: 'arm not found' };
    if (record.operationId !== operationId) {
      return { success: false, error: 'operationId mismatch', arm: publicRecord(record) };
    }
    if (record.state !== 'held' || typeof record.resolve !== 'function') {
      return { success: false, error: 'arm is not held', arm: publicRecord(record) };
    }
    const releaseIdentity = optionalScalarMap(request.identity);
    if (Object.keys(releaseIdentity).length > 0
      && !identityMatches(releaseIdentity, record.boundIdentity || {})) {
      return { success: false, error: 'release identity mismatch', arm: publicRecord(record) };
    }
    record.state = 'released';
    record.releasedAt = now();
    record.reason = typeof request.reason === 'string' && request.reason.trim()
      ? request.reason.trim()
      : 'test-release';
    const resolve = record.resolve;
    record.resolve = null;
    resolve({ reason: record.reason });
    return { success: true, arm: publicRecord(record) };
  }

  function complete(request = {}) {
    if (!enabled) return { success: false, error: 'test_hook_disabled' };
    const armId = typeof request.armId === 'string' ? request.armId.trim() : '';
    const operationId = typeof request.operationId === 'string'
      ? request.operationId.trim()
      : '';
    const record = records.get(armId);
    if (!record || !armId || record.operationId !== operationId) {
      return { success: false, error: record ? 'operationId mismatch' : 'arm not found' };
    }
    if (!['claimed', 'released'].includes(record.state)) {
      return { success: false, error: 'arm is not completable', arm: publicRecord(record) };
    }
    record.state = 'completed';
    record.completedAt = now();
    record.reason = typeof request.reason === 'string' && request.reason.trim()
      ? request.reason.trim()
      : record.reason;
    record.result = optionalScalarMap(request.result);
    emit('complete', record);
    return { success: true, arm: publicRecord(record) };
  }

  function cancelRecord(record, reason) {
    if (!record || ['completed', 'cancelled'].includes(record.state)) return false;
    record.state = 'cancelled';
    record.releasedAt = now();
    record.reason = reason;
    const resolve = record.resolve;
    record.resolve = null;
    if (typeof resolve === 'function') resolve({ reason, cancelled: true });
    emit('cancel', record);
    return true;
  }

  function cancelMatching(identity = {}, reason = 'test-identity-replaced') {
    const match = optionalScalarMap(identity);
    if (Object.keys(match).length === 0) return { success: false, error: 'identity required' };
    let cancelled = 0;
    for (const record of records.values()) {
      const candidate = record.boundIdentity || record.requestedIdentity;
      if (identityMatches(match, candidate) && cancelRecord(record, reason)) cancelled += 1;
    }
    return { success: true, cancelled, arms: snapshot() };
  }

  function clear(reason = 'e2e-rollback') {
    let cancelled = 0;
    for (const record of records.values()) {
      if (cancelRecord(record, reason)) cancelled += 1;
    }
    return { success: true, cancelled, arms: snapshot() };
  }

  return {
    enabled,
    arm,
    claim,
    waitIfArmed,
    release,
    complete,
    cancelMatching,
    clear,
    snapshot,
  };
}

module.exports = {
  buildMissingPromptEmptyFrameAnsi,
  buildResidualEmptyFrameAnsi,
  createE2eBoundaryTestGate,
  identityMatches,
};
