'use strict';

const crypto = require('node:crypto');
const {
  classifyAgentPromptAuditIdentity,
} = require('./agent-prompt-audit-identity');

const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PER_TAB = 32;

const RECEIPT_STATES = Object.freeze({
  IN_FLIGHT: 'in-flight',
  NOT_SUBMITTED: 'not-submitted',
  DELIVERY_UNKNOWN: 'delivery-unknown',
  AUDIT_PENDING: 'audit-pending',
  CONFIRMED: 'confirmed',
  EVICTED_UNKNOWN: 'evicted-unknown',
  CONFLICT: 'conflict',
  CAPACITY: 'capacity',
});

const UNRESOLVED_STATES = new Set([
  RECEIPT_STATES.DELIVERY_UNKNOWN,
  RECEIPT_STATES.AUDIT_PENDING,
  RECEIPT_STATES.EVICTED_UNKNOWN,
]);

function requiredString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(label + ' must be a non-empty string');
  return normalized;
}

function optionalString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function stableSerialize(value, seen = new Set()) {
  if (value === null) return 'null';
  if (value === undefined) return '["undefined"]';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '["number","NaN"]';
    if (value === Infinity) return '["number","Infinity"]';
    if (value === -Infinity) return '["number","-Infinity"]';
    if (Object.is(value, -0)) return '["number","-0"]';
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return '["bigint",' + JSON.stringify(String(value)) + ']';
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('request fingerprint input must be data-only');
  }
  if (value instanceof Date) return '["date",' + JSON.stringify(value.toISOString()) + ']';
  if (Buffer.isBuffer(value)) return '["buffer",' + JSON.stringify(value.toString('base64')) + ']';
  if (seen.has(value)) throw new TypeError('request fingerprint input must not be cyclic');
  seen.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = '[' + value.map((item) => stableSerialize(item, seen)).join(',') + ']';
  } else {
    const keys = Object.keys(value).sort();
    serialized = '{' + keys.map((key) => (
      JSON.stringify(key) + ':' + stableSerialize(value[key], seen)
    )).join(',') + '}';
  }
  seen.delete(value);
  return serialized;
}

function fingerprintAgentSendRequest(value) {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function cloneValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], seen);
  return copy;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function immutableCopy(value) {
  return deepFreeze(cloneValue(value));
}

function classifyAgentSendRegistryReceipt(receipt = {}) {
  if (
    receipt?.deliveryUnknown === true
    || receipt?.status === 'delivery-unknown'
    || receipt?.status === 'delivery_unknown'
  ) {
    return RECEIPT_STATES.DELIVERY_UNKNOWN;
  }
  if (receipt?.submitted === true) {
    if (
      receipt?.auditPending === true
      || receipt?.status === 'audit-pending'
      || receipt?.status === 'submitted_unverified'
      || receipt?.success === false
      || receipt?.ok === false
    ) {
      return RECEIPT_STATES.AUDIT_PENDING;
    }
    return RECEIPT_STATES.CONFIRMED;
  }
  if (receipt?.submitted === false) return RECEIPT_STATES.NOT_SUBMITTED;
  if (
    receipt?.exactAuditConfirmed === true
    && (receipt?.status === 'sent' || receipt?.status === 'confirmed')
  ) {
    return RECEIPT_STATES.CONFIRMED;
  }
  return RECEIPT_STATES.DELIVERY_UNKNOWN;
}

function normalizeRequest(request) {
  return {
    tabId: requiredString(request?.tabId, 'tabId'),
    handoffId: requiredString(request?.handoffId, 'handoffId'),
    requestFingerprint: requiredString(request?.requestFingerprint, 'requestFingerprint'),
    // A first prompt can create the provider session itself, so the exact
    // session identity is legitimately unavailable before Enter. The late
    // transcript audit binds the missing identity once; known identities are
    // still compared strictly.
    provider: optionalString(request?.provider),
    sessionId: optionalString(request?.sessionId),
    promptHash: requiredString(request?.promptHash, 'promptHash'),
  };
}

function normalizeAudit(audit) {
  const identity = classifyAgentPromptAuditIdentity(audit);
  return {
    tabId: requiredString(audit?.tabId, 'tabId'),
    handoffId: requiredString(audit?.handoffId, 'handoffId'),
    provider: requiredString(audit?.provider || audit?.toolType, 'provider'),
    sessionId: requiredString(audit?.sessionId, 'sessionId'),
    promptHash: optionalString(identity.identityHash),
    actualHash: requiredString(identity.actualHash, 'actualHash'),
    expectedHash: requiredString(identity.expectedHash, 'expectedHash'),
    identityAccepted: identity.accepted === true,
    identityReason: identity.reason || null,
    canonicalized: identity.canonicalized === true,
    canonicalReason: identity.canonicalReason || null,
    success: audit?.success === true,
    raw: audit,
  };
}

function identityMismatch(record, request) {
  const mismatches = [];
  if (record.requestFingerprint !== request.requestFingerprint) mismatches.push('requestFingerprint');
  if (record.promptHash !== request.promptHash) mismatches.push('promptHash');
  if (record.provider && request.provider && record.provider !== request.provider) {
    mismatches.push('provider');
  }
  if (record.sessionId && request.sessionId && record.sessionId !== request.sessionId) {
    mismatches.push('sessionId');
  }
  return mismatches;
}

function publicResult(record, overrides = {}) {
  return immutableCopy({
    state: record.state,
    tabId: record.tabId,
    handoffId: record.handoffId,
    requestFingerprint: record.requestFingerprint,
    provider: record.provider,
    sessionId: record.sessionId,
    promptHash: record.promptHash,
    attempt: record.attempt,
    attemptId: record.attemptId || null,
    replayed: false,
    joined: record.joinCount > 0,
    receipt: record.receipt ? cloneValue(record.receipt) : null,
    ...overrides,
  });
}

function createAgentSendReceiptRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retentionMs = Number.isFinite(options.retentionMs)
    ? Math.max(1, Number(options.retentionMs))
    : DEFAULT_RETENTION_MS;
  const maxPerTab = Number.isInteger(options.maxPerTab)
    ? Math.max(1, Number(options.maxPerTab))
    : DEFAULT_MAX_PER_TAB;
  const onEvict = typeof options.onEvict === 'function' ? options.onEvict : null;
  const recordsByTab = new Map();
  const tombstonesByTab = new Map();

  function tabMap(root, tabId, create = false) {
    let map = root.get(tabId);
    if (!map && create) {
      map = new Map();
      root.set(tabId, map);
    }
    return map || null;
  }

  function emitEviction(detail) {
    if (onEvict) {
      onEvict(immutableCopy(detail));
      return;
    }
    if (detail.unresolved === true) {
      console.warn('[AgentSendReceiptRegistry] unresolved handoff evicted tab='
        + String(detail.tabId).slice(-12)
        + ' handoff=' + String(detail.handoffId).slice(0, 32)
        + ' reason=' + detail.reason);
    }
  }

  function deleteFrom(root, tabId, handoffId) {
    const map = tabMap(root, tabId);
    if (!map) return false;
    const deleted = map.delete(handoffId);
    if (map.size === 0) root.delete(tabId);
    return deleted;
  }

  function expireTombstones(tabId, timestamp) {
    const tombstones = tabMap(tombstonesByTab, tabId);
    if (!tombstones) return;
    for (const [handoffId, tombstone] of tombstones) {
      // An unresolved physical delivery must never age back into retry
      // authority. Keep its minimal identity tombstone until an exact audit or
      // explicit operator resolution; otherwise the same handoff can be sent
      // again after two retention windows.
      if (UNRESOLVED_STATES.has(tombstone.state)) continue;
      if (tombstone.expiresAt > timestamp) continue;
      tombstones.delete(handoffId);
      emitEviction({
        tabId,
        handoffId,
        state: tombstone.state,
        previousState: tombstone.previousState || null,
        unresolved: UNRESOLVED_STATES.has(tombstone.state),
        reason: 'tombstone-expired',
      });
    }
    if (tombstones.size === 0) tombstonesByTab.delete(tabId);
  }

  function makeTombstone(record, reason, timestamp) {
    return {
      tabId: record.tabId,
      handoffId: record.handoffId,
      requestFingerprint: record.requestFingerprint,
      provider: record.provider,
      sessionId: record.sessionId,
      promptHash: record.promptHash,
      state: UNRESOLVED_STATES.has(record.state)
        ? RECEIPT_STATES.EVICTED_UNKNOWN
        : record.state,
      previousState: record.state,
      receipt: record.receipt,
      attempt: record.attempt,
      attemptId: record.attemptId || null,
      joinCount: record.joinCount || 0,
      createdAt: record.createdAt,
      updatedAt: timestamp,
      expiresAt: timestamp + retentionMs,
      sendPending: false,
    };
  }

  function evictRecord(record, reason, timestamp) {
    deleteFrom(recordsByTab, record.tabId, record.handoffId);
    const unresolved = UNRESOLVED_STATES.has(record.state);
    const tombstone = unresolved ? makeTombstone(record, reason, timestamp) : null;
    if (tombstone) {
      tabMap(tombstonesByTab, record.tabId, true).set(record.handoffId, tombstone);
    }
    emitEviction({
      tabId: record.tabId,
      handoffId: record.handoffId,
      state: tombstone?.state || record.state,
      previousState: record.state,
      unresolved,
      reason,
    });
    return true;
  }

  function pruneTab(tabId) {
    const timestamp = now();
    expireTombstones(tabId, timestamp);
    const records = tabMap(recordsByTab, tabId);
    if (!records) return;
    const expired = Array.from(records.values())
      .filter((record) => !record.sendPending && record.expiresAt <= timestamp)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    for (const record of expired) {
      if (!evictRecord(record, 'retention-expired', timestamp)) break;
    }
  }

  function reserveCapacity(tabId) {
    pruneTab(tabId);
    const records = tabMap(recordsByTab, tabId, true);
    const tombstones = tabMap(tombstonesByTab, tabId);
    const total = records.size + (tombstones?.size || 0);
    if (total < maxPerTab) return true;
    const candidates = [
      ...Array.from(records.values()).map((record) => ({ kind: 'record', record })),
      ...Array.from(tombstones?.values() || []).map((record) => ({ kind: 'tombstone', record })),
    ]
      .filter(({ record }) => !record.sendPending && !UNRESOLVED_STATES.has(record.state))
      .sort((a, b) => a.record.updatedAt - b.record.updatedAt);
    for (const candidate of candidates) {
      if (candidate.kind === 'record') {
        evictRecord(candidate.record, 'tab-capacity', now());
      } else {
        deleteFrom(tombstonesByTab, tabId, candidate.record.handoffId);
        emitEviction({
          tabId,
          handoffId: candidate.record.handoffId,
          state: candidate.record.state,
          unresolved: false,
          reason: 'tab-capacity',
        });
      }
      return true;
    }
    return false;
  }

  function conflict(record, request, mismatchedFields) {
    return Promise.resolve(immutableCopy({
      state: RECEIPT_STATES.CONFLICT,
      code: 'agent_send_handoff_conflict',
      ok: false,
      tabId: request.tabId,
      handoffId: request.handoffId,
      mismatchedFields,
      existingState: record.state,
      requestFingerprint: request.requestFingerprint,
      existingRequestFingerprint: record.requestFingerprint,
      replayed: false,
      receipt: null,
    }));
  }

  function capacityResult(request) {
    return Promise.resolve(immutableCopy({
      state: RECEIPT_STATES.CAPACITY,
      code: 'agent_send_receipt_registry_capacity',
      ok: false,
      tabId: request.tabId,
      handoffId: request.handoffId,
      replayed: false,
      receipt: null,
    }));
  }

  function evictedUnknownResult(tombstone) {
    return Promise.resolve(publicResult(tombstone, {
      state: RECEIPT_STATES.EVICTED_UNKNOWN,
      code: 'agent_send_receipt_evicted_unresolved',
      ok: false,
      replayed: true,
      previousState: tombstone.previousState,
    }));
  }

  function settleRecord(record, receipt) {
    record.sendPending = false;
    record.updatedAt = now();
    record.expiresAt = record.updatedAt + retentionMs;
    if (record.state !== RECEIPT_STATES.CONFIRMED) {
      record.state = classifyAgentSendRegistryReceipt(receipt);
      record.receipt = immutableCopy({
        ...(receipt || {}),
        attemptId: receipt?.attemptId || record.attemptId || null,
      });
    }
    const result = publicResult(record);
    if (!record.publicSettled) {
      record.publicSettled = true;
      record.resolve(result);
    }
    record.resolve = null;
    return result;
  }

  function startAttempt(record, send) {
    record.state = RECEIPT_STATES.IN_FLIGHT;
    record.receipt = null;
    record.sendPending = true;
    record.publicSettled = false;
    record.attempt += 1;
    record.attemptId = crypto.randomUUID();
    record.joinCount = 0;
    record.updatedAt = now();
    record.expiresAt = Infinity;
    record.promise = new Promise((resolve) => { record.resolve = resolve; });
    Promise.resolve()
      .then(() => send({ attempt: record.attempt, attemptId: record.attemptId }))
      .then((receipt) => settleRecord(record, receipt && typeof receipt === 'object'
        ? receipt
        : {
          success: null,
          submitted: null,
          status: 'delivery-unknown',
          deliveryUnknown: true,
          code: 'agent_send_invalid_receipt',
        }))
      .catch((error) => settleRecord(record, {
        success: null,
        submitted: null,
        status: 'delivery-unknown',
        deliveryUnknown: true,
        code: 'agent_send_executor_error',
        error: error?.message || String(error),
      }));
    return record.promise;
  }

  function run(requestInput, send) {
    if (typeof send !== 'function') throw new TypeError('send must be a function');
    const request = normalizeRequest(requestInput);
    pruneTab(request.tabId);

    const records = tabMap(recordsByTab, request.tabId);
    const existing = records?.get(request.handoffId) || null;
    if (existing) {
      const mismatches = identityMismatch(existing, request).filter((field) => (
        field !== 'sessionId' || existing.state !== RECEIPT_STATES.NOT_SUBMITTED
      ));
      if (mismatches.length > 0) return conflict(existing, request, mismatches);
      existing.updatedAt = now();
      if (existing.sendPending) {
        existing.joinCount += 1;
        return existing.promise;
      }
      if (existing.state === RECEIPT_STATES.NOT_SUBMITTED) {
        // No Enter crossed, so a repaired/restarted target may legitimately
        // expose a new session before the authorized retry. The immutable
        // prompt/settings fingerprint and provider still have to match.
        // Replace the attempt identity atomically, including the meaningful
        // null state: a new launch can be provisional until its exact audit
        // binds the session. Keeping the failed attempt's session here would
        // make that exact late audit look foreign.
        existing.sessionId = request.sessionId;
        return startAttempt(existing, send);
      }
      return Promise.resolve(publicResult(existing, { replayed: true }));
    }

    const tombstones = tabMap(tombstonesByTab, request.tabId);
    const tombstone = tombstones?.get(request.handoffId) || null;
    if (tombstone) {
      const mismatches = identityMismatch(tombstone, request);
      if (mismatches.length > 0) return conflict(tombstone, request, mismatches);
      if (tombstone.state === RECEIPT_STATES.EVICTED_UNKNOWN) {
        return evictedUnknownResult(tombstone);
      }
      if (tombstone.state !== RECEIPT_STATES.NOT_SUBMITTED) {
        return Promise.resolve(publicResult(tombstone, { replayed: true }));
      }
      deleteFrom(tombstonesByTab, request.tabId, request.handoffId);
    }

    if (!reserveCapacity(request.tabId)) return capacityResult(request);
    const record = {
      ...request,
      state: RECEIPT_STATES.IN_FLIGHT,
      receipt: null,
      attempt: tombstone?.attempt || 0,
      attemptId: null,
      joinCount: 0,
      createdAt: tombstone?.createdAt || now(),
      updatedAt: now(),
      expiresAt: Infinity,
      sendPending: false,
      publicSettled: false,
      promise: null,
      resolve: null,
    };
    tabMap(recordsByTab, request.tabId, true).set(request.handoffId, record);
    return startAttempt(record, send);
  }

  function auditMismatch(record, audit, reason, mismatchedFields = []) {
    return immutableCopy({
      matched: true,
      promoted: false,
      state: record.state,
      reason,
      mismatchedFields,
      tabId: audit.tabId,
      handoffId: audit.handoffId,
    });
  }

  function promoteFromAudit(auditInput) {
    let audit;
    try {
      audit = normalizeAudit(auditInput);
    } catch (error) {
      return immutableCopy({ matched: false, promoted: false, reason: 'invalid-audit', error: error.message });
    }
    pruneTab(audit.tabId);
    const active = tabMap(recordsByTab, audit.tabId)?.get(audit.handoffId) || null;
    const tombstone = tabMap(tombstonesByTab, audit.tabId)?.get(audit.handoffId) || null;
    const record = active || tombstone;
    if (!record) {
      return immutableCopy({
        matched: false,
        promoted: false,
        reason: 'handoff-not-found',
        tabId: audit.tabId,
        handoffId: audit.handoffId,
      });
    }
    if (!audit.success) return auditMismatch(record, audit, 'audit-not-successful');
    const mismatchedFields = [];
    if (record.provider && record.provider !== audit.provider) mismatchedFields.push('provider');
    if (record.sessionId && record.sessionId !== audit.sessionId) mismatchedFields.push('sessionId');
    if (!audit.identityAccepted) mismatchedFields.push('canonicalProof');
    if (record.promptHash !== audit.promptHash) mismatchedFields.push('promptHash');
    if (record.promptHash !== audit.expectedHash) {
      mismatchedFields.push('expectedHash');
    }
    if (mismatchedFields.length > 0) {
      return auditMismatch(record, audit, 'audit-identity-mismatch', mismatchedFields);
    }
    if (record.state === RECEIPT_STATES.NOT_SUBMITTED) {
      return auditMismatch(record, audit, 'not-submitted-cannot-be-promoted');
    }
    if (record.state === RECEIPT_STATES.CONFIRMED) {
      return immutableCopy({
        matched: true,
        promoted: false,
        idempotent: true,
        state: RECEIPT_STATES.CONFIRMED,
        reason: 'already-confirmed',
        tabId: audit.tabId,
        handoffId: audit.handoffId,
        receipt: cloneValue(record.receipt),
      });
    }
    const timestamp = now();
    record.provider ||= audit.provider;
    record.sessionId ||= audit.sessionId;
    record.state = RECEIPT_STATES.CONFIRMED;
    record.updatedAt = timestamp;
    record.expiresAt = timestamp + retentionMs;
    record.receipt = immutableCopy({
      ...(record.receipt || {}),
      ok: true,
      success: true,
      accepted: true,
      submitted: true,
      status: 'sent',
      deliveryUnknown: false,
      auditPending: false,
      exactAuditConfirmed: true,
      handoffId: record.handoffId,
      tabId: record.tabId,
      provider: record.provider,
      sessionId: record.sessionId,
      promptHash: record.promptHash,
      actualHash: audit.actualHash,
      expectedHash: audit.expectedHash,
      canonicalized: audit.canonicalized,
      canonicalReason: audit.canonicalReason,
      auditTimestamp: audit.raw?.auditTimestamp || timestamp,
      entryUuid: audit.raw?.entryUuid || null,
    });
    if (active && !record.publicSettled) {
      record.publicSettled = true;
      record.resolve(publicResult(record));
    }
    if (tombstone) {
      record.previousState = RECEIPT_STATES.CONFIRMED;
    }
    return immutableCopy({
      matched: true,
      promoted: true,
      state: RECEIPT_STATES.CONFIRMED,
      tabId: audit.tabId,
      handoffId: audit.handoffId,
      receipt: cloneValue(record.receipt),
    });
  }

  function sweep(tabId = null) {
    const tabs = tabId
      ? [requiredString(tabId, 'tabId')]
      : Array.from(new Set([...recordsByTab.keys(), ...tombstonesByTab.keys()]));
    for (const id of tabs) pruneTab(id);
    return snapshot(tabId);
  }

  function snapshot(tabId = null) {
    const tabs = tabId
      ? [requiredString(tabId, 'tabId')]
      : Array.from(new Set([...recordsByTab.keys(), ...tombstonesByTab.keys()]));
    const result = [];
    for (const id of tabs) {
      for (const record of tabMap(recordsByTab, id)?.values() || []) {
        result.push(publicResult(record, { kind: 'record', sendPending: record.sendPending }));
      }
      for (const tombstone of tabMap(tombstonesByTab, id)?.values() || []) {
        result.push(publicResult(tombstone, {
          kind: 'tombstone',
          replayed: true,
          previousState: tombstone.previousState || null,
        }));
      }
    }
    return immutableCopy(result);
  }

  function clear() {
    recordsByTab.clear();
    tombstonesByTab.clear();
  }

  return Object.freeze({
    run,
    promoteFromAudit,
    sweep,
    snapshot,
    clear,
    retentionMs,
    maxPerTab,
  });
}

module.exports = {
  DEFAULT_MAX_PER_TAB,
  DEFAULT_RETENTION_MS,
  RECEIPT_STATES,
  classifyAgentSendRegistryReceipt,
  createAgentSendReceiptRegistry,
  fingerprintAgentSendRequest,
};
