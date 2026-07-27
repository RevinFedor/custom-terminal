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

function isRetryableCodexDescriptorProbeTimeout(error) {
  if (!error) return false;
  const code = String(error.code || '').toUpperCase();
  if (code === 'ETIMEDOUT') return true;
  return error.killed === true
    && (error.signal === 'SIGTERM' || error.signal === 'SIGKILL');
}

function shouldRetryCodexDescriptorProbePass(result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  return result?.status === 'unknown'
    && failures.length > 0
    && failures.every((failure) => failure?.retryableTimeout === true);
}

async function runCodexDescriptorProbeWithSingleRetry(inspect, {
  isGenerationCurrent = () => true,
  onRetry = null,
} = {}) {
  if (typeof inspect !== 'function') throw new TypeError('inspect must be a function');
  if (typeof isGenerationCurrent !== 'function') {
    throw new TypeError('isGenerationCurrent must be a function');
  }

  const first = await inspect(1);
  if (!shouldRetryCodexDescriptorProbePass(first)) return first;
  if (!isGenerationCurrent()) {
    return {
      ...first,
      status: 'unknown',
      error: 'writer_process_generation_changed_before_descriptor_retry',
      descriptorRetry: {
        attempted: false,
        skippedReason: 'generation-changed-before-retry',
        firstError: first?.error || null,
      },
    };
  }

  if (typeof onRetry === 'function') onRetry({ attempt: 2, first });
  const second = await inspect(2);
  if (!isGenerationCurrent()) {
    return {
      ...second,
      status: 'unknown',
      error: 'writer_process_generation_changed_after_descriptor_retry',
      descriptorRetry: {
        attempted: true,
        skippedReason: 'generation-changed-after-retry',
        firstError: first?.error || null,
        secondError: second?.error || null,
      },
    };
  }

  return {
    ...second,
    descriptorRetry: {
      attempted: true,
      firstError: first?.error || null,
      secondError: second?.error || null,
      recovered: second?.status !== 'unknown',
    },
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
  stableSourceProof = null,
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
  if (stableSourceProof) {
    const soleCandidate = allCandidates.length === 1 ? allCandidates[0] : null;
    const soleMeta = candidateSessionMeta(soleCandidate);
    const stableJournalPhase = stableSourceProof.journalPhase === 'rollback-applied'
      || String(stableSourceProof.journalPhase || '').startsWith('stable-source');
    const stableSourceSelected = stableSourceProof.kind === 'native-rewind-stable-source'
      && stableSourceProof.rollbackDurable === true
      && stableJournalPhase
      && stableSourceProof.terminalGenerationMatches === true
      && stableSourceProof.runSeqMatches === true
      && stableSourceProof.boundSessionMatches === true
      && String(stableSourceProof.sessionId || '') === String(sourceSessionId)
      && String(stableSourceProof.actionGeneration || '') === String(actionGeneration)
      && Number(stableSourceProof.appliedAtMs) >= startedAt
      && String(soleMeta.id || '') === String(sourceSessionId);
    if (stableSourceSelected) {
      return {
        status: 'selected',
        candidate: soleCandidate,
        sessionId: String(sourceSessionId),
        sourceSessionId: String(sourceSessionId),
        actionGeneration,
        lineageDepth: 0,
        lineageRelation: 'stable-source',
        stableSourceProof,
        candidates: allCandidates,
        rejected: [],
      };
    }
  }
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

/**
 * Reuse the exact writer established by a completed native Rewind when the
 * process still has both the source and the child rollout open writable.
 *
 * This is not a recency or "last known session" fallback. The caller must
 * prove that the in-memory settlement belongs to the current PTY command
 * generation and that SQLite still binds the tab to the same session. Every
 * other writable user rollout must be an ancestor of the settled writer;
 * siblings, descendants, unrelated sessions, duplicate IDs, and incomplete
 * lineage all remain ambiguous.
 */
function selectCodexSettledRewindWriter(candidates, {
  kind = null,
  valid = false,
  sessionId = null,
  filePath = null,
  sourceSessionId = null,
  actionGeneration = null,
  observerGeneration = null,
  terminalToken = null,
  observerTerminalToken = null,
  runSeq = null,
  observerRunSeq = null,
  boundSessionId = null,
  lineage = [],
} = {}) {
  const allCandidates = Array.isArray(candidates) ? candidates : [];
  const supportedKind = kind === 'native-rewind-settled-writer'
    || kind === 'native-rewind-delayed-child';
  if (!supportedKind || valid !== true) {
    return {
      status: 'unresolved',
      reason: supportedKind
        ? 'settled-writer-proof-invalid'
        : 'not-native-rewind-settled-writer',
      candidates: allCandidates,
    };
  }
  if (!sessionId
    || !filePath
    || !sourceSessionId
    || !actionGeneration
    || !observerGeneration
    || !terminalToken
    || !observerTerminalToken
    || !Number.isInteger(runSeq)
    || runSeq <= 0
    || !Number.isInteger(observerRunSeq)
    || observerRunSeq <= 0
    || !boundSessionId) {
    return {
      status: 'unresolved',
      reason: 'settled-writer-context-missing',
      candidates: allCandidates,
    };
  }
  if (actionGeneration !== observerGeneration) {
    return {
      status: 'unresolved',
      reason: 'stale-settled-writer-generation',
      candidates: allCandidates,
    };
  }
  if (terminalToken !== observerTerminalToken) {
    return {
      status: 'unresolved',
      reason: 'stale-settled-writer-terminal',
      candidates: allCandidates,
    };
  }
  if (runSeq !== observerRunSeq) {
    return {
      status: 'unresolved',
      reason: 'stale-settled-writer-run',
      candidates: allCandidates,
    };
  }
  if (String(boundSessionId) !== String(sessionId)) {
    return {
      status: 'unresolved',
      reason: 'settled-writer-binding-mismatch',
      candidates: allCandidates,
    };
  }

  const canonicalProofPath = canonicalizeExistingPath(filePath);
  const exactCandidates = allCandidates.filter((candidate) => {
    const meta = candidateSessionMeta(candidate);
    return String(meta.id || '') === String(sessionId)
      && canonicalizeExistingPath(candidate.filePath) === canonicalProofPath;
  });
  if (exactCandidates.length !== 1) {
    return {
      status: 'unresolved',
      reason: exactCandidates.length > 1
        ? 'duplicate-settled-writer-candidate'
        : 'settled-writer-candidate-missing',
      candidates: allCandidates,
    };
  }

  // Codex may apply native Rewind to the live thread without creating the
  // replacement rollout until the next Enter. During that interval the
  // settled writer is intentionally the source itself. Preserve that proof
  // only while it remains the sole writable user rollout; the appearance of
  // any competitor requires the separate exact post-Enter audit transaction.
  if (String(sessionId) === String(sourceSessionId)) {
    if (allCandidates.length !== 1) {
      return {
        status: 'unresolved',
        reason: 'settled-stable-source-competitor-present',
        candidates: allCandidates,
      };
    }
    return {
      status: 'selected',
      candidate: exactCandidates[0],
      sessionId: String(sessionId),
      sourceSessionId: String(sourceSessionId),
      actionGeneration,
      lineageDepth: 0,
      lineageRelation: 'stable-source',
      ancestors: [],
      candidates: allCandidates,
    };
  }

  // A delayed child is committed only after an exact post-Enter audit and an
  // atomic source→child DB CAS. Codex does not write `forked_from_id` for this
  // variant, so later lsof revalidation preserves that already-committed
  // identity while the only competing user rollout is the exact source.
  if (kind === 'native-rewind-delayed-child') {
    const competitors = allCandidates.filter((candidate) => candidate !== exactCandidates[0]);
    const invalidCompetitor = competitors.find((candidate) => {
      const meta = candidateSessionMeta(candidate);
      return String(meta.id || '') !== String(sourceSessionId);
    });
    if (invalidCompetitor) {
      return {
        status: 'unresolved',
        reason: 'delayed-settled-writer-unrelated-competitor',
        rejectedSessionId: candidateSessionMeta(invalidCompetitor).id || null,
        candidates: allCandidates,
      };
    }
    return {
      status: 'selected',
      candidate: exactCandidates[0],
      sessionId: String(sessionId),
      sourceSessionId: String(sourceSessionId),
      actionGeneration,
      lineageDepth: null,
      lineageRelation: 'delayed-stable-source-child',
      ancestors: competitors.map(() => ({
        sessionId: String(sourceSessionId),
        lineageDepth: null,
      })),
      candidates: allCandidates,
    };
  }

  const { parents, conflicts } = buildCodexHandoffParentMap(allCandidates, lineage);
  const sourceAncestry = resolveCodexHandoffLineage(
    sessionId,
    sourceSessionId,
    parents,
    conflicts,
  );
  if (!sourceAncestry.proven) {
    return {
      status: 'unresolved',
      reason: 'settled-writer-source-lineage-' + sourceAncestry.reason,
      candidates: allCandidates,
    };
  }

  const ancestors = [];
  for (const candidate of allCandidates) {
    if (candidate === exactCandidates[0]) continue;
    const meta = candidateSessionMeta(candidate);
    const competitorSessionId = meta.id ? String(meta.id) : '';
    if (!competitorSessionId || competitorSessionId === String(sessionId)) {
      return {
        status: 'unresolved',
        reason: competitorSessionId
          ? 'duplicate-settled-writer-session'
          : 'settled-writer-competitor-id-missing',
        candidates: allCandidates,
      };
    }
    const ancestry = resolveCodexHandoffLineage(
      sessionId,
      competitorSessionId,
      parents,
      conflicts,
    );
    if (!ancestry.proven) {
      return {
        status: 'unresolved',
        reason: 'settled-writer-competitor-not-ancestor',
        rejectedSessionId: competitorSessionId,
        rejectedReason: ancestry.reason,
        candidates: allCandidates,
      };
    }
    ancestors.push({
      sessionId: competitorSessionId,
      lineageDepth: ancestry.depth,
    });
  }

  return {
    status: 'selected',
    candidate: exactCandidates[0],
    sessionId: String(sessionId),
    sourceSessionId: String(sourceSessionId),
    actionGeneration,
    lineageDepth: sourceAncestry.depth,
    lineageRelation: sourceAncestry.relation,
    ancestors,
    candidates: allCandidates,
  };
}

/**
 * Select the writer that Codex materializes on the first Enter after a
 * stable-source native Rewind.
 *
 * Codex 0.145 can create this rollout without `forked_from_id`, so ancestry is
 * not authority here. The replacement is accepted only when the retained
 * Rewind transaction, current PTY/run/binding, durable submit record, and one
 * exact causal `user_message` audit all agree. No recency/mtime fallback is
 * permitted.
 */
function selectCodexDelayedStableSourceWriter(candidates, {
  kind = null,
  valid = false,
  sourceSessionId = null,
  sourceFilePath = null,
  actionGeneration = null,
  observerGeneration = null,
  actionStartedAtMs = null,
  stableSourceSettledAtMs = null,
  journalPhase = null,
  terminalToken = null,
  observerTerminalToken = null,
  runSeq = null,
  observerRunSeq = null,
  boundSessionId = null,
  cwd = null,
  submitProof = null,
  liveProofs = [],
} = {}) {
  const allCandidates = Array.isArray(candidates) ? candidates : [];
  const unresolved = (reason, extra = {}) => ({
    status: 'unresolved',
    reason,
    sourceSessionId: sourceSessionId ? String(sourceSessionId) : null,
    actionGeneration: actionGeneration || null,
    candidates: allCandidates,
    ...extra,
  });
  if (kind !== 'native-rewind-delayed-stable-source' || valid !== true) {
    return unresolved('delayed-stable-source-proof-invalid');
  }
  if (!sourceSessionId
    || !sourceFilePath
    || !actionGeneration
    || !observerGeneration
    || !terminalToken
    || !observerTerminalToken
    || !Number.isInteger(runSeq)
    || runSeq <= 0
    || !Number.isInteger(observerRunSeq)
    || observerRunSeq <= 0
    || !boundSessionId
    || !cwd) {
    return unresolved('delayed-stable-source-context-missing');
  }
  if (actionGeneration !== observerGeneration) {
    return unresolved('stale-delayed-action-generation');
  }
  if (terminalToken !== observerTerminalToken) {
    return unresolved('stale-delayed-terminal');
  }
  if (runSeq !== observerRunSeq) {
    return unresolved('stale-delayed-run');
  }
  if (String(boundSessionId) !== String(sourceSessionId)) {
    return unresolved('delayed-source-binding-mismatch');
  }
  const actionStartedAt = Number(actionStartedAtMs);
  const settledAt = Number(stableSourceSettledAtMs);
  if (!Number.isFinite(actionStartedAt)
    || actionStartedAt <= 0
    || !Number.isFinite(settledAt)
    || settledAt < actionStartedAt) {
    return unresolved('delayed-stable-source-boundary-missing');
  }
  if (journalPhase !== 'stable-source-submit-written') {
    return unresolved('delayed-submit-not-written');
  }

  const sentAt = Number(submitProof?.sentAtMs);
  const writtenAt = Number(submitProof?.submitWrittenAtMs);
  const expectedLen = Number(submitProof?.expectedLen);
  const expectedHash = String(submitProof?.expectedHash || '');
  const submitId = String(submitProof?.submitId || '');
  if (!submitId
    || String(submitProof?.sourceSessionId || '') !== String(sourceSessionId)
    || String(submitProof?.actionGeneration || '') !== String(actionGeneration)
    || !Number.isSafeInteger(expectedLen)
    || expectedLen < 0
    || !/^[a-f0-9]{16}$/i.test(expectedHash)
    || !Number.isFinite(sentAt)
    || sentAt < settledAt
    || !Number.isFinite(writtenAt)
    || writtenAt < sentAt) {
    return unresolved('delayed-submit-proof-invalid');
  }

  const canonicalSourcePath = canonicalizeExistingPath(sourceFilePath);
  const sourceCandidates = allCandidates.filter((candidate) => {
    const meta = candidateSessionMeta(candidate);
    return String(meta.id || '') === String(sourceSessionId)
      && canonicalizeExistingPath(candidate.filePath) === canonicalSourcePath;
  });
  // The live process is allowed to close the source descriptor as soon as it
  // opens the delayed child. The retained journal + exact pre-Enter source
  // boundary still prove where this submit began, so zero source candidates
  // is valid. More than one exact source descriptor remains ambiguous.
  if (sourceCandidates.length > 1) {
    return unresolved('duplicate-delayed-source-candidate');
  }

  const expectedCwd = path.resolve(String(cwd));
  for (const candidate of allCandidates) {
    const meta = candidateSessionMeta(candidate);
    if (!meta.id || !meta.cwd || path.resolve(String(meta.cwd)) !== expectedCwd) {
      return unresolved('delayed-candidate-cwd-mismatch', {
        rejectedSessionId: meta.id || null,
      });
    }
  }

  const proven = [];
  const rejected = [];
  for (const candidate of allCandidates) {
    const meta = candidateSessionMeta(candidate);
    const sessionId = meta.id ? String(meta.id) : '';
    if (!sessionId || sessionId === String(sourceSessionId)) continue;
    const matchingProofs = (Array.isArray(liveProofs) ? liveProofs : []).filter((proof) => {
      if (proof?.kind !== 'user-message-audit') return false;
      if (String(proof.sessionId || '') !== sessionId) return false;
      if (String(proof.sourceSessionId || '') !== String(sourceSessionId)) return false;
      if (String(proof.actionGeneration || '') !== String(actionGeneration)) return false;
      if (String(proof.submitId || '') !== submitId) return false;
      if (Number(proof.expectedLen) !== expectedLen) return false;
      if (String(proof.expectedHash || '') !== expectedHash) return false;
      const auditSentAt = Number(proof.auditSentAtMs);
      const recordAt = Number(proof.recordTimestampMs);
      const createdAt = Number(proof.candidateCreatedAtMs);
      const observedAt = Number(proof.observedAtMs);
      return Number.isFinite(auditSentAt)
        && auditSentAt === sentAt
        && Number.isFinite(recordAt)
        && recordAt >= sentAt
        && Number.isFinite(createdAt)
        && createdAt >= sentAt
        && Number.isFinite(observedAt)
        && observedAt >= recordAt;
    });
    if (matchingProofs.length === 0) {
      rejected.push({ sessionId, reason: 'exact-post-enter-audit-missing' });
      continue;
    }
    proven.push({
      candidate,
      sessionId,
      liveProof: matchingProofs[0],
    });
  }

  if (proven.length !== 1) {
    return unresolved(
      proven.length > 1
        ? 'multiple-delayed-audit-writers'
        : 'delayed-audit-writer-missing',
      { proven, rejected },
    );
  }
  return {
    status: 'selected',
    ...proven[0],
    sourceSessionId: String(sourceSessionId),
    actionGeneration,
    lineageDepth: null,
    lineageRelation: 'delayed-stable-source-child',
    submitId,
    candidates: allCandidates,
    rejected,
  };
}

/**
 * Recognize a second reconciliation of the exact native-Rewind commit that
 * already won the per-writer transaction. The durable handoff journal is
 * intentionally consumed by the first commit, so absence alone cannot make a
 * queued observer revoke the writer it just committed.
 *
 * This is deliberately narrower than an idempotent "binding already equals
 * candidate" shortcut: the live PTY token, command run, action generation,
 * source, child and current SQLite binding must all still match.
 */
function isCommittedCodexNativeRewindReplay({
  intent = null,
  candidateSessionId = null,
  proof = null,
  boundSessionId = null,
  terminalToken = null,
  runSeq = null,
  currentIntentGeneration = null,
  observerCurrent = false,
} = {}) {
  if (intent?.sourceMode !== 'writer-handoff'
    || !intent?.sourceSessionId
    || !intent?.launchId
    || !candidateSessionId
    || proof?.kind !== 'native-rewind-settled-writer'
    || proof?.valid !== true
    || observerCurrent !== true) {
    return false;
  }
  return String(candidateSessionId) !== String(intent.sourceSessionId)
    && String(proof.sessionId || '') === String(candidateSessionId)
    && String(proof.sourceSessionId || '') === String(intent.sourceSessionId)
    && String(proof.actionGeneration || proof.launchId || '') === String(intent.launchId)
    && String(currentIntentGeneration || '') === String(intent.launchId)
    && String(boundSessionId || '') === String(candidateSessionId)
    && !!terminalToken
    && proof.terminalToken === terminalToken
    && Number.isInteger(Number(runSeq))
    && Number(runSeq) > 0
    && Number(proof.runSeq) === Number(runSeq);
}

/**
 * Select the durable completion proof after a native Rewind restored prompt
 * has been verified and removed from the TUI composer.
 *
 * The child may commit before this point and consume the handoff journal. If
 * it has not, the source-in-place path must durably advance that journal. A
 * failed source CAS is reclassified only when the exact child commit became
 * visible during that CAS; journal absence by itself is never sufficient.
 */
function resolveCodexRewindCompletionProof({
  committedChildBeforeStableProof = false,
  stableSourceProof = null,
  committedChildAfterStableProof = false,
} = {}) {
  if (committedChildBeforeStableProof === true) {
    return {
      success: true,
      proofMode: 'committed-child',
      racedWithStableSourceProof: false,
    };
  }
  if (stableSourceProof?.success === true) {
    return {
      success: true,
      proofMode: 'stable-source',
      racedWithStableSourceProof: false,
    };
  }
  if (committedChildAfterStableProof === true) {
    return {
      success: true,
      proofMode: 'committed-child',
      racedWithStableSourceProof: true,
    };
  }
  return {
    success: false,
    proofMode: 'unresolved',
    error: stableSourceProof?.error || 'codex_rewind_completion_proof_missing',
  };
}

function shouldCloseCodexRewindProtocolUi({
  protocolUiOpen = false,
  handoffMutationStarted = false,
} = {}) {
  return protocolUiOpen === true && handoffMutationStarted !== true;
}

function classifyCodexWriterObservationScope({
  capturedIntentGeneration = null,
  currentIntentGeneration = null,
  capturedObservationGeneration = null,
  currentObservationGeneration = null,
  expectedObserver = null,
  currentObserver = null,
} = {}) {
  if (capturedObservationGeneration !== currentObservationGeneration) {
    return {
      status: 'stale-observation-generation',
      expectedObservationGeneration: capturedObservationGeneration,
      currentObservationGeneration,
    };
  }
  const captured = capturedIntentGeneration || null;
  const current = currentIntentGeneration || null;
  if (captured !== current) {
    return {
      status: 'stale-generation',
      expectedLaunchId: captured,
      currentLaunchId: current,
    };
  }
  if (expectedObserver && currentObserver !== expectedObserver) {
    return { status: 'stale-observer' };
  }
  return { status: 'current' };
}

function deriveCodexSettledWriterProofScope({
  nativeRewindHandoffProven = false,
  settledRewindWriterProven = false,
  intent = null,
  settledWriterProof = null,
} = {}) {
  if (nativeRewindHandoffProven) {
    return {
      actionGeneration: intent?.launchId || null,
      sourceSessionId: intent?.sourceSessionId || null,
    };
  }
  if (settledRewindWriterProven) {
    return {
      actionGeneration: settledWriterProof?.actionGeneration || null,
      sourceSessionId: settledWriterProof?.sourceSessionId || null,
    };
  }
  return {
    actionGeneration: null,
    sourceSessionId: null,
  };
}

function shouldUseSettledCodexRewindWriterProof({
  sourceMode = null,
  handoffActionStartedAtMs = null,
} = {}) {
  const hasActionBoundary = handoffActionStartedAtMs !== null
    && handoffActionStartedAtMs !== undefined
    && handoffActionStartedAtMs !== ''
    && Number.isFinite(Number(handoffActionStartedAtMs));
  return sourceMode !== 'writer-handoff'
    || !hasActionBoundary;
}

async function resolveCodexUserWriterProof(proof, {
  readMetadata,
  isUserSession,
  handoff = null,
  settledWriter = null,
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
    const settledSelection = !handoff && settledWriter
      ? selectCodexSettledRewindWriter(userCandidates, settledWriter)
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
    if (!handoff && settledWriter && settledSelection?.status !== 'selected') {
      return {
        status: 'ambiguous',
        reason: 'settled-writer-unresolved',
        candidates: userCandidates,
        ignoredCandidates,
        allCandidates: classified,
        settledWriterProof: settledSelection,
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
      ...(settledSelection ? { settledWriterProof: settledSelection } : {}),
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
    // A currently active handoff always wins over an incumbent settlement.
    // If the new handoff is unresolved, remain ambiguous instead of falling
    // back to the writer from the previous Rewind.
    const settledSelection = !handoff && settledWriter
      ? selectCodexSettledRewindWriter(userCandidates, settledWriter)
      : null;
    if (settledSelection?.status === 'selected') {
      const selected = settledSelection.candidate;
      return {
        status: 'owned',
        filePath: selected.filePath,
        pids: selected.pids || [],
        fds: selected.fds || [],
        metadata: selected.metadata,
        candidates: userCandidates,
        ignoredCandidates,
        allCandidates: classified,
        settledWriterProof: settledSelection,
      };
    }
    return {
      status: 'ambiguous',
      candidates: userCandidates,
      ignoredCandidates,
      allCandidates: classified,
      ...(handoffSelection ? { handoffProof: handoffSelection } : {}),
      ...(settledSelection ? { settledWriterProof: settledSelection } : {}),
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
  const selectionProven = selection?.status === 'selected'
    && !!actionGeneration
    && actionGeneration === observerGeneration
    && selection.actionGeneration === actionGeneration
    && selection.sessionId === adoptedSessionId;
  const stableWriterProven = selectionProven
    && selection.lineageRelation === 'stable-source'
    && selection.stableSourceProof?.rollbackDurable === true;
  const branchWriterProven = selectionProven && !stableWriterProven;
  const settlement = classifyCodexWriterHandoffSettlement({
    adoptionStatus,
    processRunning,
    turnBusy,
    tuiReady,
    writerChanged: branchWriterProven,
    stableWriterProven,
  });
  return {
    ...settlement,
    branchWriterProven,
    stableWriterProven,
    writerHandoffProven: branchWriterProven || stableWriterProven,
    handoffReason: stableWriterProven
      ? 'proven-stable-source'
      : branchWriterProven
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
  sourceSubmitAuditPending = false,
} = {}) {
  // A process-owned source rollout plus task_started proves where Codex began
  // writing, but it does not prove that an automated paste supplied that turn's
  // user text. While the exact launch-scoped user_message audit is pending, keep
  // the old Resume source provisional. Manual Enter has no such reservation and
  // continues to settle from the normal append/task boundary.
  if (
    sourceMode === 'resume'
    && sourceMatch === 'source-in-place'
    && sourceSubmitAuditPending === true
  ) {
    return {
      status: 'provisional-source',
      sourceSettled: false,
      reason: 'awaiting-user-message-audit',
    };
  }
  const sourceSettled = sourceMatch !== 'source-in-place'
    || linkedBoundaryFound === true
    || sourceAppendObserved === true;
  if (sourceMode === 'resume' && !sourceSettled) {
    return { status: 'provisional-source', sourceSettled: false };
  }
  return { status: 'commit', sourceSettled };
}

function isCodexResumeSourceAuditPending({
  sourceMode = null,
  sourceSessionId = null,
  launchId = null,
  discovery = null,
} = {}) {
  const reservation = discovery?.provisionalSubmitReservation || null;
  return sourceMode === 'resume'
    && !!sourceSessionId
    && !!launchId
    && discovery?.sourceMode === 'resume'
    && discovery?.sourceSessionId === sourceSessionId
    && discovery?.launchId === launchId
    && reservation?.sourceSessionId === sourceSessionId
    && reservation?.launchId === launchId
    && reservation?.requiresUserMessageAudit === true
    && reservation?.auditMatched !== true;
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
  if (
    precedingOperation?.submitted === true
    && (
      precedingOperation?.identityPending === true
      || precedingOperation?.kind === 'safe-paste'
    )
  ) {
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
  isCodexResumeSourceAuditPending,
  classifyCodexProvisionalActionAuthorization,
  classifyCodexWriterHandoffSettlement,
  claimExclusiveActionReservation,
  claimCodexResumeSourceLease,
  isRetryableCodexDescriptorProbeTimeout,
  runCodexDescriptorProbeWithSingleRetry,
  shouldRetryCodexDescriptorProbePass,
  parseLsofFieldRecords,
  releaseExclusiveActionReservation,
  releaseCodexResumeSourceLeases,
  resolveCompleteCodexWriterProof,
  resolveCodexUserWriterProof,
  resolveCodexWriterProof,
  isCommittedCodexNativeRewindReplay,
  resolveCodexRewindCompletionProof,
  shouldCloseCodexRewindProtocolUi,
  classifyCodexWriterObservationScope,
  deriveCodexSettledWriterProofScope,
  shouldUseSettledCodexRewindWriterProof,
  selectCodexNativeRewindWriter,
  selectCodexDelayedStableSourceWriter,
  selectCodexSettledRewindWriter,
  runKeyedExclusive,
  runKeyedSingleFlight,
  isCodexWriterProofOwnershipQuarantined,
  writableCodexRolloutsFromLsof,
};
