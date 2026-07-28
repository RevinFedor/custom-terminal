'use strict';

// A `spawn_agent` record proves that a child exists, but it does not prove
// that the child belongs to the Codex process which is alive *now*. Rollout
// files survive process restarts and unresolved cards remain `running` on
// disk, so process ownership is recorded only when the live watcher observes
// the exact record after its launch boundary.

const MAX_OWNERSHIP_RECORDS = 4096;
const ownershipByExactRecord = new Map();

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
  MAX_OWNERSHIP_RECORDS,
  exactRecordKey,
  getCodexProcessActionGeneration,
  recordCodexProcessActionOwnership,
  resetCodexProcessActionOwnershipForTests,
};
