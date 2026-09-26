'use strict';

// A `spawn_agent` record proves that a child exists, but it does not prove
// that the child belongs to the Codex process which is alive *now*. Rollout
// files survive process restarts and unresolved cards remain `running` on
// disk, so process ownership is recorded only when the live watcher observes
// the exact record after its launch boundary.

const MAX_OWNERSHIP_RECORDS = 4096;
const ownershipByExactRecord = new Map();
const ownershipObservers = new Set();
const runtimeId = require('node:crypto').randomBytes(8).toString('hex');
function getCodexProcessActionOwnershipRevision(sessionIds) {
  const sessions = new Set(sessionIds);
  const hash = require('node:crypto').createHash('sha256').update(runtimeId);
  for (const [key, generation] of ownershipByExactRecord) if (sessions.has(key.split('\u0000')[0])) {
    hash.update(JSON.stringify([key, generation]));
  }
  return hash.digest('hex');
}
function observeCodexProcessActionOwnership(listener) {
  ownershipObservers.add(listener);
  return () => ownershipObservers.delete(listener);
}
function getCodexProcessActionOwnershipSnapshot() {
  return [...ownershipByExactRecord].map(([key, lifecycleGeneration]) => {
    const [sessionId, callId, sourceByteOffset] = key.split('\u0000');
    return { sessionId, callId, sourceByteOffset: Number(sourceByteOffset), lifecycleGeneration };
  });
}

function normalizeOffset(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const offset = Number(value);
  return Number.isFinite(offset) && offset >= 0 ? offset : null;
}

function exactRecordKey({ sessionId, callId, sourceByteOffset }) {
  const session = String(sessionId || '').trim();
  const call = String(callId || '').trim();
  const offset = normalizeOffset(sourceByteOffset);
  if (!session || !call || offset === null) return null;
  return session + '\u0000' + call + '\u0000' + offset;
}

function recordCodexProcessActionOwnership({
  sessionId,
  callId,
  sourceByteOffset,
  lifecycleGeneration,
}) {
  const key = exactRecordKey({ sessionId, callId, sourceByteOffset });
  const generation = String(lifecycleGeneration || '').trim();
  if (!key || !generation) return false;
  // Refresh insertion order without allowing a historical parser pass to
  // overwrite the proof: only the live watcher calls this function.
  ownershipByExactRecord.delete(key);
  ownershipByExactRecord.set(key, generation);
  for (const observer of ownershipObservers) observer({ sessionId, callId, sourceByteOffset, lifecycleGeneration: generation });
  while (ownershipByExactRecord.size > MAX_OWNERSHIP_RECORDS) {
    const oldest = ownershipByExactRecord.keys().next().value;
    if (oldest === undefined) break;
    ownershipByExactRecord.delete(oldest);
  }
  return true;
}

function getCodexProcessActionGeneration({ sessionId, callId, sourceByteOffset }) {
  const key = exactRecordKey({ sessionId, callId, sourceByteOffset });
  return key ? (ownershipByExactRecord.get(key) || null) : null;
}

function resetCodexProcessActionOwnershipForTests() {
  ownershipByExactRecord.clear();
}

module.exports = {
  getCodexProcessActionOwnershipRevision,
  observeCodexProcessActionOwnership,
  getCodexProcessActionOwnershipSnapshot,
  MAX_OWNERSHIP_RECORDS,
  exactRecordKey,
  getCodexProcessActionGeneration,
  recordCodexProcessActionOwnership,
  resetCodexProcessActionOwnershipForTests,
};
