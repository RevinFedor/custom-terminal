'use strict';

const { randomUUID } = require('node:crypto');
const PREPARATION_MS = 60_000;
const COLD_PREPARATION_MS = 120_000;

// Private Main-only result. A renderer/HTTP object cannot manufacture this
// proof that preparation returned before beginAttempt or bridge dispatch.
class SendPreparationDeferred extends Error {
  constructor(code, reason = code) {
    super(code);
    this.code = code;
    this.reason = String(reason || code).slice(0, 160);
  }
}
const deferSendPreparation = (code, reason) => new SendPreparationDeferred(code, reason);
const isSendPreparationDeferred = value => value instanceof SendPreparationDeferred;

function activeHeadPreparation(record) {
  const value = record?.receipt?.activeHeadPreparation;
  const duration = value?.mode === 'cold-codex' && record?.provider === 'codex' ? COLD_PREPARATION_MS
    : value?.mode === 'warm' ? PREPARATION_MS : null;
  return duration && value.version === 1 && value.operationKey === record.operationKey
    && value.requestFingerprint === record.requestFingerprint && value.tabId === record.tabId
    && value.handoffId === record.handoffId && Number.isFinite(value.startedAt)
    && value.deadlineAt === value.startedAt + duration ? value : null;
}

// Main's existing event inspection chooses only a budget, never input rights.
// Unknown/active (including a live picker) retains the warm policy. Capture
// once at ACTIVE HEAD, before restore/prepareSend can change that observation.
function selectSendPreparationMode(provider, inspection) {
  if (provider !== 'codex' || inspection?.known !== true) return 'warm';
  if (inspection.exists === false) return 'cold-codex';
  return inspection.toolType === 'codex' && inspection.runtime?.known === true
    && ['inactive', 'starting'].includes(inspection.runtime.status) ? 'cold-codex' : 'warm';
}

// Issued by the existing active HEAD executor. Queue residence, renderer reads
// and settings acknowledgements cannot create or renew this deadline.
function createSendPreparationScope(identity, startedAt = Date.now(), mode = 'warm') {
  const cold = identity.provider === 'codex' && mode === 'cold-codex';
  return Object.freeze({ ...identity, version: 1, id: randomUUID(),
    preparation: Object.freeze({ version: cold ? 2 : 1,
      ...(cold ? { kind: 'cold-codex' } : {}), startedAt,
      deadlineAt: startedAt + (cold ? COLD_PREPARATION_MS : PREPARATION_MS) }) });
}

function createInputPreparation(deadlineAt, currentReason = () => null, now = Date.now) {
  let revoked = null;
  const reason = () => (revoked ||= currentReason()
    || (now() >= deadlineAt ? 'agent_send_preparation_expired' : null));
  return Object.freeze({ deadlineAt, remainingMs: () => Math.max(0, deadlineAt - now()),
    isCurrent: () => { const why = reason(); return !why || why === 'agent_send_preparation_expired'; },
    failure(pasteWritten = false) {
      const code = reason();
      return code ? { success: false, accepted: false, submitted: false, pasteWritten,
        enterWritten: false, status: 'not-submitted', code, error: code,
        ...(code === 'agent_send_cancelled' ? { cancelled: true } : {}) } : null;
    },
  });
}

function readAgentSendPreparation(store, tabId, options = {}, startup = null, now = Date.now) {
  const attemptId = options.sendAttemptId || options.attemptId;
  const handoffId = options.handoffId;
  if (!attemptId || !handoffId) return null; // Unaddressed reads are observations only.
  const operationKey = options.sendOperationKey || options.operationKey;
  let record;
  try {
    record = operationKey ? store.get(operationKey)
      : store.list({ tabId, handoffId, limit: 16 }).find(row => row.attemptId === attemptId);
  } catch {
    return createInputPreparation(0, () => 'agent_send_preparation_storage_unavailable', now);
  }
  const refused = reason => createInputPreparation(0, () => reason, now);
  if (!record || record.tabId !== tabId || record.handoffId !== handoffId
    || record.attemptId !== attemptId || (operationKey && record.operationKey !== operationKey)
    || !['in-flight', 'enter-armed'].includes(record.state)) {
    return refused('agent_send_preparation_superseded');
  }
  if (record.deliveryControl?.cancelledAt) return refused('agent_send_cancelled');
  const scope = record?.receipt?.preflightScope, window = scope?.preparation;
  if (!window) return null; // Legacy active attempts keep their existing bounded observation.
  // Preserve every old v1 deadline exactly. Only a newly Main-issued v2 cold
  // scope may use120s; a caller's options, readiness or another read cannot
  // upgrade an old grant or renew the same attempt.
  const duration = window.version === 1 ? PREPARATION_MS
    : window.version === 2 && window.kind === 'cold-codex'
      && scope.provider === 'codex' && record.provider === 'codex' ? COLD_PREPARATION_MS : null;
  if (duration === null || !Number.isFinite(window.startedAt)
    || window.deadlineAt !== window.startedAt + duration
    || !scope.id || scope.version !== 1) return refused('agent_send_preparation_superseded');
  const deadlineAt = Math.min(window.deadlineAt, startup?.deadlineAt ?? Infinity);
  const matches = value => value?.tabId === tabId && value.handoffId === handoffId
    && value.attemptId === attemptId && value.operationKey === scope.operationKey
    && scope.tabId === tabId && scope.handoffId === handoffId && scope.attemptId === attemptId
    && value.receipt?.preflightScope?.id === scope.id
    && value.receipt?.preflightScope?.preparation?.version === window.version
    && value.receipt?.preflightScope?.preparation?.kind === window.kind
    && value.receipt?.preflightScope?.preparation?.startedAt === window.startedAt
    && value.receipt?.preflightScope?.preparation?.deadlineAt === window.deadlineAt;
  const reason = () => {
    let current;
    try { current = store.get(scope.operationKey); } catch { return 'agent_send_preparation_storage_unavailable'; }
    if (!matches(current) || !['in-flight', 'enter-armed'].includes(current.state)) return 'agent_send_preparation_superseded';
    if (current.deliveryControl?.cancelledAt) return 'agent_send_cancelled';
    if (now() >= deadlineAt) return 'agent_send_preparation_expired';
    return null;
  };
  const preparation = createInputPreparation(deadlineAt, reason, now);
  const readinessDeadline = Object.freeze({ version: 1, tabId, handoffId, operationKey: scope.operationKey,
    attemptId, scopeId: scope.id, scopeVersion: window.version,
    headStartedAt: window.startedAt, headDeadlineAt: window.deadlineAt,
    startupDeadlineAt: Number.isFinite(startup?.deadlineAt) ? startup.deadlineAt : null,
    effectiveDeadlineAt: deadlineAt,
    limitingDeadline: Number.isFinite(startup?.deadlineAt) && startup.deadlineAt <= window.deadlineAt ? 'startup' : 'active-head',
    launchId: startup?.launchId || null, lifecycleGeneration: startup?.lifecycleGeneration || null,
    stopRevision: Number.isSafeInteger(startup?.stopRevision) ? startup.stopRevision : null });
  return Object.freeze({ scope, ...preparation, readinessDeadline,
    failure(pasteWritten = false) {
      const result = preparation.failure(pasteWritten);
      return result ? { ...result, readinessDeadline } : null;
    } });
}

// This is the continuation of a prepared write, not a new executor/attempt.
// The owner supplies the existing PTY serializer; callers invoke finish only
// after releasing any outer settings/PTY locks. A duplicate finish joins once.
function deferPreparedInput({ wait, resume, cleanup = () => {} }) {
  let pending;
  return { continuePreparation() {
    if (!pending) pending = (async () => {
      try {
        for (;;) {
          const proof = await wait();
          if (proof?.success !== true) return proof;
          const result = await resume();
          if (!result?.waitForComposerPreparation) return result;
        }
      } finally { await cleanup(); }
    })();
    return pending;
  } };
}

function mapPreparedInput(pending, finish) {
  let result;
  return { continuePreparation() {
    return result ||= Promise.resolve().then(() => pending.continuePreparation()).then(finish);
  } };
}

module.exports = { PREPARATION_MS, COLD_PREPARATION_MS, selectSendPreparationMode,
  createSendPreparationScope, createInputPreparation,
  readAgentSendPreparation, deferPreparedInput, mapPreparedInput,
  deferSendPreparation, isSendPreparationDeferred, activeHeadPreparation };
