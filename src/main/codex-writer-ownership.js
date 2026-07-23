'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseLsofFieldRecords(output) {
  const records = [];
  let pid = null;
  let current = null;

  const flush = () => {
    if (current) records.push(current);
    current = null;
  };

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const field = rawLine[0];
    const value = rawLine.slice(1);
    if (field === 'p') {
      flush();
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (field === 'f') {
      flush();
      current = { pid, fd: value || null, access: null, name: null };
      continue;
    }
    if (!current) continue;
    if (field === 'a') current.access = value || null;
    if (field === 'n') current.name = value || null;
  }
  flush();
  return records;
}

function canonicalizeExistingPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(candidatePath, parentPath) {
  if (!candidatePath || !parentPath || !path.isAbsolute(candidatePath)) return false;
  const candidate = canonicalizeExistingPath(candidatePath);
  const parent = canonicalizeExistingPath(parentPath);
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function writableCodexRolloutsFromLsof(output, sessionsDir) {
  return parseLsofFieldRecords(output).filter((record) => {
    if (record.access !== 'u' && record.access !== 'w') return false;
    if (!record.name || !record.name.endsWith('.jsonl')) return false;
    return isPathInside(record.name, sessionsDir);
  });
}

function resolveCodexWriterProof(reports, sessionsDir) {
  const byPath = new Map();
  for (const report of Array.isArray(reports) ? reports : []) {
    for (const record of writableCodexRolloutsFromLsof(report?.output, sessionsDir)) {
      const filePath = canonicalizeExistingPath(record.name);
      let entry = byPath.get(filePath);
      if (!entry) {
        entry = { filePath, pids: new Set(), fds: new Set() };
        byPath.set(filePath, entry);
      }
      const pid = Number(record.pid || report?.pid);
      if (Number.isInteger(pid) && pid > 0) entry.pids.add(pid);
      if (record.fd) entry.fds.add(record.fd);
    }
  }

  const candidates = Array.from(byPath.values()).map((entry) => ({
    filePath: entry.filePath,
    pids: Array.from(entry.pids).sort((a, b) => a - b),
    fds: Array.from(entry.fds),
  }));
  if (candidates.length === 1) {
    return { status: 'owned', ...candidates[0], candidates };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', candidates };
  }
  return { status: 'pending', candidates: [] };
}

function resolveCompleteCodexWriterProof(reports, failures, sessionsDir) {
  const proof = resolveCodexWriterProof(reports, sessionsDir);
  const failed = Array.isArray(failures) ? failures.filter(Boolean) : [];
  if (failed.length === 0) return proof;
  return {
    status: 'unknown',
    error: failed.map((failure) => String(failure.pid || '?') + ':' + String(failure.error || 'inspection_failed')).join(', '),
    candidates: proof.candidates || [],
    partialProofStatus: proof.status,
    failures: failed,
  };
}

const CODEX_HANDOFF_LIVE_PROOF_KINDS = new Set([
  'rollout-created',
  'rollout-live-append',
  'task-started',
  'thread-rolled-back',
  'user-message-audit',
]);

function candidateSessionMeta(candidate) {
  return candidate?.meta || candidate?.metadata?.meta || {};
}

function buildCodexHandoffParentMap(candidates, lineage) {
  const parents = new Map();
  const conflicts = new Set();
  const add = (sessionId, forkedFromId) => {
    const id = sessionId ? String(sessionId) : '';
    const parentId = forkedFromId ? String(forkedFromId) : '';
    if (!id || !parentId) return;
    const previous = parents.get(id);
    if (previous && previous !== parentId) {
      conflicts.add(id);
      return;
    }
    parents.set(id, parentId);
  };

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const meta = candidateSessionMeta(candidate);
    add(meta.id, meta.forked_from_id);
  }
  if (lineage instanceof Map) {
    for (const [sessionId, forkedFromId] of lineage) add(sessionId, forkedFromId);
  } else {
    for (const edge of Array.isArray(lineage) ? lineage : []) {
      add(
        edge?.sessionId || edge?.id,
        edge?.forkedFromId || edge?.forked_from_id || edge?.parentSessionId,
      );
    }
  }
  return { parents, conflicts };
}

function resolveCodexHandoffLineage(sessionId, sourceSessionId, parents, conflicts) {
  const source = sourceSessionId ? String(sourceSessionId) : '';
  let current = sessionId ? String(sessionId) : '';
  if (!source || !current || current === source) {
    return { proven: false, reason: current === source ? 'source-is-not-child' : 'lineage-id-missing' };
  }

  const seen = new Set([current]);
  let depth = 0;
  while (current) {
    if (conflicts.has(current)) {
      return { proven: false, reason: 'lineage-conflict', conflictSessionId: current };
    }
    const parent = parents.get(current);
    if (!parent) return { proven: false, reason: 'lineage-incomplete' };
    depth += 1;
    if (parent === source) {
      return {
        proven: true,
        depth,
        relation: depth === 1 ? 'direct-child' : 'descendant',
      };
    }
    if (seen.has(parent)) {
      return { proven: false, reason: 'lineage-cycle' };
    }
    seen.add(parent);
    current = parent;
  }
  return { proven: false, reason: 'lineage-incomplete' };
}

/**
 * Select a new Codex writer while an explicit native Rewind handoff is active.
 *
 * This is deliberately stricter than the normal process-open resolver. A fork
 * edge alone proves history ancestry, not that the current Rewind created or
 * activated that branch. The caller must also provide a live boundary tied to
 * the exact action generation. `boundaryAtMs` must come from a creation marker,
 * a post-baseline append, task `started_at`, rollback marker, or a matched
 * post-Enter user-message audit — never from file mtime or copied record time.
 */
function selectCodexNativeRewindWriter(candidates, {
  kind = null,
  sourceSessionId = null,
  actionGeneration = null,
  observerGeneration = null,
  actionStartedAtMs = null,
  liveProofs = [],
  lineage = [],
} = {}) {
  const allCandidates = Array.isArray(candidates) ? candidates : [];
  if (kind !== 'native-rewind') {
    return { status: 'unresolved', reason: 'not-native-rewind', candidates: allCandidates };
  }
  if (!sourceSessionId || !actionGeneration || !observerGeneration) {
    return { status: 'unresolved', reason: 'handoff-context-missing', candidates: allCandidates };
  }
  if (actionGeneration !== observerGeneration) {
    return { status: 'unresolved', reason: 'stale-action-generation', candidates: allCandidates };
  }
  const startedAt = Number(actionStartedAtMs);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return { status: 'unresolved', reason: 'action-boundary-missing', candidates: allCandidates };
  }

  const { parents, conflicts } = buildCodexHandoffParentMap(allCandidates, lineage);
  const proven = [];
  const rejected = [];
  for (const candidate of allCandidates) {
    const meta = candidateSessionMeta(candidate);
    const sessionId = meta.id ? String(meta.id) : '';
    const ancestry = resolveCodexHandoffLineage(
      sessionId,
      sourceSessionId,
      parents,
      conflicts,
    );
    if (!ancestry.proven) {
      rejected.push({ sessionId: sessionId || null, reason: ancestry.reason });
      continue;
    }

    const matchingProofs = (Array.isArray(liveProofs) ? liveProofs : []).filter((proof) => {
      if (String(proof?.sessionId || '') !== sessionId) return false;
      if (proof?.actionGeneration !== actionGeneration) return false;
      if (!CODEX_HANDOFF_LIVE_PROOF_KINDS.has(proof?.kind)) return false;
      const observedAt = Number(proof?.observedAtMs);
      const boundaryAt = Number(proof?.boundaryAtMs);
      return Number.isFinite(observedAt)
        && Number.isFinite(boundaryAt)
        && observedAt >= startedAt
        && boundaryAt >= startedAt;
    });
    if (matchingProofs.length === 0) {
      rejected.push({ sessionId, reason: 'post-action-live-proof-missing' });
      continue;
    }
    matchingProofs.sort((a, b) => Number(b.boundaryAtMs) - Number(a.boundaryAtMs));
    proven.push({
      candidate,
      sessionId,
      lineageDepth: ancestry.depth,
      lineageRelation: ancestry.relation,
      liveProof: matchingProofs[0],
    });
  }

  if (proven.length === 1) {
    return {
      status: 'selected',
      ...proven[0],
      sourceSessionId: String(sourceSessionId),
      actionGeneration,
      candidates: allCandidates,
      rejected,
    };
  }
  return {
    status: 'unresolved',
    reason: proven.length > 1 ? 'multiple-proven-descendants' : 'no-proven-descendant',
    sourceSessionId: String(sourceSessionId),
    actionGeneration,
    candidates: allCandidates,
    proven,
    rejected,
  };
}

async function resolveCodexUserWriterProof(proof, {
  readMetadata,
  isUserSession,
  handoff = null,
} = {}) {
  if (!proof || proof.status === 'unknown' || proof.status === 'pending') return proof;
  if (typeof readMetadata !== 'function' || typeof isUserSession !== 'function') {
    throw new TypeError('readMetadata and isUserSession are required');
  }
  const classified = [];
  for (const candidate of proof.candidates || []) {
    let metadata;
    try {
      metadata = await readMetadata(candidate.filePath);
    } catch (error) {
      return {
        status: 'unknown',
        error: 'writer_candidate_metadata_read_failed:' + (error?.message || String(error)),
        failedCandidate: candidate,
        candidates: proof.candidates || [],
      };
    }
    const meta = metadata?.meta || {};
    if (!meta.id || !path.basename(candidate.filePath).includes(String(meta.id))) {
      return {
        status: 'unknown',
        error: !meta.id ? 'writer_candidate_metadata_missing_id' : 'writer_candidate_filename_metadata_mismatch',
        failedCandidate: candidate,
        candidates: proof.candidates || [],
      };
    }
    classified.push({ ...candidate, metadata, meta, userTui: isUserSession(meta) === true });
  }

  const userCandidates = classified.filter((candidate) => candidate.userTui);
  const ignoredCandidates = classified.filter((candidate) => !candidate.userTui);
  if (userCandidates.length === 1) {
    const selected = userCandidates[0];
    const handoffSelection = handoff
      ? selectCodexNativeRewindWriter(userCandidates, handoff)
      : null;
    // Once the native-Rewind action boundary has been crossed, even a single
    // open rollout is not automatically the new writer. It may simply be the
    // still-open source. Require the same ancestry + exact-generation live
    // proof used for the two-open-rollout case.
    if (handoff && handoffSelection?.status !== 'selected') {
      return {
        status: 'ambiguous',
        reason: 'handoff-branch-unresolved',
        candidates: userCandidates,
        ignoredCandidates,
        allCandidates: classified,
        handoffProof: handoffSelection,
      };
    }
    return {
      status: 'owned',
      filePath: selected.filePath,
      pids: selected.pids || [],
      fds: selected.fds || [],
      metadata: selected.metadata,
      candidates: userCandidates,
      ignoredCandidates,
      allCandidates: classified,
      ...(handoffSelection ? { handoffProof: handoffSelection } : {}),
    };
  }
  if (userCandidates.length > 1) {
    const handoffSelection = handoff
      ? selectCodexNativeRewindWriter(userCandidates, handoff)
      : null;
    if (handoffSelection?.status === 'selected') {
      const selected = handoffSelection.candidate;
      return {
        status: 'owned',
        filePath: selected.filePath,
        pids: selected.pids || [],
        fds: selected.fds || [],
        metadata: selected.metadata,
        candidates: userCandidates,
        ignoredCandidates,
        allCandidates: classified,
        handoffProof: handoffSelection,
      };
    }
    return {
      status: 'ambiguous',
      candidates: userCandidates,
      ignoredCandidates,
      allCandidates: classified,
      ...(handoffSelection ? { handoffProof: handoffSelection } : {}),
    };
  }
  return {
    status: 'pending',
    candidates: [],
    ignoredCandidates,
    allCandidates: classified,
    reason: ignoredCandidates.length > 0 ? 'only-subagent-rollouts-open' : 'no-user-rollout-open',
  };
}

function classifyCodexBranchWriterHandoffSettlement({
  selection = null,
  actionGeneration = null,
  observerGeneration = null,
  adoptedSessionId = null,
  adoptionStatus = 'unknown',
  processRunning = false,
  turnBusy = false,
  tuiReady = false,
} = {}) {
  const branchWriterProven = selection?.status === 'selected'
    && !!actionGeneration
    && actionGeneration === observerGeneration
    && selection.actionGeneration === actionGeneration
    && selection.sessionId === adoptedSessionId;
  const settlement = classifyCodexWriterHandoffSettlement({
    adoptionStatus,
    processRunning,
    turnBusy,
    tuiReady,
    writerChanged: branchWriterProven,
  });
  return {
    ...settlement,
    branchWriterProven,
    handoffReason: branchWriterProven
      ? 'proven-descendant'
      : selection?.status !== 'selected'
        ? (selection?.reason || 'branch-selection-unresolved')
        : actionGeneration !== observerGeneration
          ? 'stale-action-generation'
          : selection.actionGeneration !== actionGeneration
            ? 'selection-generation-mismatch'
            : selection.sessionId !== adoptedSessionId
              ? 'adopted-session-mismatch'
              : 'branch-writer-unproven',
  };
}

function classifyCodexWriterAdoption({
  sourceMode = null,
  sourceMatch = null,
  linkedBoundaryFound = false,
  sourceAppendObserved = false,
} = {}) {
  const sourceSettled = sourceMatch !== 'source-in-place'
    || linkedBoundaryFound === true
    || sourceAppendObserved === true;
  if (sourceMode === 'resume' && !sourceSettled) {
    return { status: 'provisional-source', sourceSettled: false };
  }
  return { status: 'commit', sourceSettled };
}

function classifyCodexProvisionalActionAuthorization({
  sourceMode = null,
  writerStatus = null,
  writerSessionId = null,
  sourceSessionId = null,
  launchId = null,
  discovery = null,
  sourceTurn = null,
  lease = null,
  tabId = null,
  tuiReady = false,
  processRunning = false,
  processPids = [],
  hasInflight = false,
} = {}) {
  const checks = [
    ['not-resume', sourceMode === 'resume'],
    ['writer-not-provisional-source', writerStatus === 'provisional-source'],
    ['source-missing', !!sourceSessionId],
    ['writer-source-mismatch', writerSessionId === sourceSessionId],
    ['launch-missing', !!launchId],
    ['discovery-mode-mismatch', discovery?.sourceMode === 'resume'],
    ['discovery-source-mismatch', discovery?.sourceSessionId === sourceSessionId],
    ['discovery-launch-mismatch', discovery?.launchId === launchId],
    ['turn-source-mismatch', sourceTurn?.sessionId === sourceSessionId],
    ['turn-launch-mismatch', sourceTurn?.sourceObservationLaunchId === launchId],
    ['lease-source-mismatch', lease?.sourceSessionId === sourceSessionId],
    ['lease-tab-mismatch', lease?.tabId === tabId],
    ['lease-launch-mismatch', lease?.launchId === launchId],
    ['tui-not-ready', tuiReady === true],
    ['process-not-running', processRunning === true],
    ['process-writer-not-open', Array.isArray(processPids) && processPids.length > 0],
    ['action-inflight', hasInflight !== true],
    ['provisional-submit-already-reserved', !discovery?.provisionalSubmitReservation],
  ];
  const failed = checks.find(([, passed]) => !passed);
  return failed
    ? { authorized: false, reason: failed[0] }
    : { authorized: true, reason: 'launch-scoped-source-observers' };
}

function classifyManualCodexSubmitAfterWriteQueue({
  precedingOperation = null,
  activeOperation = null,
  competingReservation = null,
  ownReservation = null,
} = {}) {
  // TUI-control automation is advisory UI control, not ownership of the
  // user's keyboard. A physical Enter must reach the screen that the user is
  // looking at immediately; terminalInputRevision makes the automation yield
  // before its next write. Keep the kind fallback for older picker callers,
  // while new callers declare the policy explicitly.
  if (activeOperation?.manualInputYields === true
    || activeOperation?.kind === 'codex-model-effort-picker') {
    return {
      suppress: false,
      bypassQueue: true,
      reason: 'manual-input-takes-picker',
    };
  }
  // A physical Enter that arrived while a serialized first submit was already
  // in progress must not become a second submit after that operation releases
  // the PTY lock. The operation object is intentionally observed by reference:
  // it is queued first, then marks `submitted` at the exact term.write boundary.
  if (precedingOperation?.identityPending === true && precedingOperation?.submitted === true) {
    return { suppress: true, bypassQueue: false, reason: 'preceding-first-submit-won' };
  }
  // Resume has an additional launch-scoped reservation. A reservation owned by
  // another path means arbitration is unresolved even if its write result has
  // not been published yet; fail closed instead of interleaving two Enters.
  if (competingReservation && competingReservation !== ownReservation) {
    return { suppress: true, bypassQueue: false, reason: 'provisional-submit-reserved-by-other' };
  }
  return { suppress: false, bypassQueue: false, reason: 'manual-submit-owns-boundary' };
}

function classifyCodexWriterHandoffSettlement({
  adoptionStatus = 'unknown',
  processRunning = false,
  turnBusy = false,
  tuiReady = false,
  writerChanged = false,
  stableWriterProven = false,
} = {}) {
  const adopted = adoptionStatus === 'adopted';
  // `pending` means the Codex process exists but has not opened a writable
  // rollout yet.  Only an explicit `absent` result comes from a successful,
  // empty process-tree inspection and may settle the lifecycle as stopped.
  const absent = adoptionStatus === 'absent' && processRunning !== true;
  // Seeing the pre-action writer again immediately after Rewind does not prove
  // that the handoff has finished.  A changed writer settles automatically;
  // a successful operation may explicitly accept a freshly revalidated stable
  // writer when Codex intentionally keeps writing the same rollout.
  const writerSettled = adopted && (writerChanged || stableWriterProven);
  const busy = writerSettled && turnBusy === true;
  const inputReady = writerSettled && !busy && tuiReady === true;
  const sessionStatus = absent
    ? 'inactive'
    : !writerSettled
      ? 'starting'
      : busy
        ? 'busy'
        : inputReady
          ? 'active'
          : 'starting';
  return {
    sessionStatus,
    busy,
    inputReady,
    settled: writerSettled || absent,
    absent,
  };
}

function claimCodexResumeSourceLease(leases, {
  sourceSessionId,
  tabId,
  launchId = null,
  provenOwner = null,
} = {}) {
  if (!sourceSessionId || !tabId) return { success: true, lease: null };
  const current = leases.get(sourceSessionId) || null;
  // A resume source is exclusive until the owning launch explicitly releases
  // it. Cached OSC/process flags have gaps and must not let another tab steal
  // the same source while the first launch is still resolving its writer.
  if (current && current.tabId !== tabId) {
    return { success: false, owner: current, reason: 'live-launch-lease' };
  }
  if (provenOwner && provenOwner.tabId !== tabId) {
    return { success: false, owner: provenOwner, reason: 'proven-writer' };
  }
  const lease = { tabId, launchId, at: Date.now() };
  leases.set(sourceSessionId, lease);
  return { success: true, lease };
}

function releaseCodexResumeSourceLeases(leases, {
  tabId,
  sourceSessionId = null,
  launchId = null,
} = {}) {
  if (!tabId) return [];
  const released = [];
  for (const [source, lease] of leases) {
    if (lease?.tabId !== tabId) continue;
    if (sourceSessionId && source !== sourceSessionId) continue;
    // Cleanup from an older asynchronous launch must not release the lease
    // already replaced by a newer launch in the same tab.
    if (launchId && lease?.launchId !== launchId) continue;
    leases.delete(source);
    released.push(source);
  }
  return released;
}

async function runKeyedExclusive(registry, key, task) {
  if (!(registry instanceof Map)) throw new TypeError('registry must be a Map');
  if (!key) throw new TypeError('key is required');
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  const previous = registry.get(key) || Promise.resolve();
  const current = previous
    .catch(() => null)
    .then(task);
  registry.set(key, current);
  try {
    return await current;
  } finally {
    if (registry.get(key) === current) registry.delete(key);
  }
}

async function runKeyedSingleFlight(registry, key, task) {
  if (!(registry instanceof Map)) throw new TypeError('registry must be a Map');
  if (!key) throw new TypeError('key is required');
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  const existing = registry.get(key);
  if (existing) return existing;
  const current = Promise.resolve().then(task);
  registry.set(key, current);
  try {
    return await current;
  } finally {
    if (registry.get(key) === current) registry.delete(key);
  }
}

function isCodexWriterProofOwnershipQuarantined(proof) {
  if (!proof?.sessionId) return false;
  if (proof.valid === true) return true;
  const reason = String(proof.invalidatedReason || '');
  return reason.includes('process-unknown')
    || reason.includes('writer-unknown')
    || reason.includes('revalidation-unknown');
}

function claimExclusiveActionReservation(registry, {
  key,
  requestId,
  action = 'action',
} = {}) {
  if (!(registry instanceof Map)) throw new TypeError('registry must be a Map');
  if (!key) throw new TypeError('key is required');
  if (!requestId) throw new TypeError('requestId is required');
  const active = registry.get(key) || null;
  if (active) {
    return { success: false, reason: 'already-reserved', active };
  }
  const reservation = {
    key,
    requestId,
    action,
    at: Date.now(),
  };
  registry.set(key, reservation);
  return { success: true, reservation };
}

function releaseExclusiveActionReservation(registry, reservation) {
  if (!(registry instanceof Map)) throw new TypeError('registry must be a Map');
  if (!reservation?.key) return false;
  if (registry.get(reservation.key) !== reservation) return false;
  registry.delete(reservation.key);
  return true;
}

module.exports = {
  classifyManualCodexSubmitAfterWriteQueue,
  classifyCodexBranchWriterHandoffSettlement,
  classifyCodexWriterAdoption,
  classifyCodexProvisionalActionAuthorization,
  classifyCodexWriterHandoffSettlement,
  claimExclusiveActionReservation,
  claimCodexResumeSourceLease,
  parseLsofFieldRecords,
  releaseExclusiveActionReservation,
  releaseCodexResumeSourceLeases,
  resolveCompleteCodexWriterProof,
  resolveCodexUserWriterProof,
  resolveCodexWriterProof,
  selectCodexNativeRewindWriter,
  runKeyedExclusive,
  runKeyedSingleFlight,
  isCodexWriterProofOwnershipQuarantined,
  writableCodexRolloutsFromLsof,
};
