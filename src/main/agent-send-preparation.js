'use strict';

const { randomUUID } = require('node:crypto');
const PREPARATION_MS = 60_000;

// Issued by the existing active HEAD executor. Queue residence, renderer reads
// and settings acknowledgements cannot create or renew this deadline.
function createSendPreparationScope(identity, startedAt = Date.now()) {
  return Object.freeze({ ...identity, version: 1, id: randomUUID(),
    preparation: Object.freeze({ version: 1, startedAt, deadlineAt: startedAt + PREPARATION_MS }) });
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
  if (window.version !== 1 || !Number.isFinite(window.startedAt)
    || window.deadlineAt !== window.startedAt + PREPARATION_MS
    || !scope.id || scope.version !== 1) return refused('agent_send_preparation_superseded');
  const deadlineAt = Math.min(window.deadlineAt, startup?.deadlineAt ?? Infinity);
  const matches = value => value?.tabId === tabId && value.handoffId === handoffId
    && value.attemptId === attemptId && value.operationKey === scope.operationKey
    && scope.tabId === tabId && scope.handoffId === handoffId && scope.attemptId === attemptId
    && value.receipt?.preflightScope?.id === scope.id
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
  return Object.freeze({ scope, ...createInputPreparation(deadlineAt, reason, now) });
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

module.exports = { PREPARATION_MS, createSendPreparationScope, createInputPreparation,
  readAgentSendPreparation, deferPreparedInput, mapPreparedInput };
