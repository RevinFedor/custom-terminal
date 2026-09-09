'use strict';

const {
  CODEX_ACTION_PROFILE_NATIVE_REWIND,
  compareCodexActionAuthorityIdentity,
} = require('./codex-action-authority');
const { PROTOCOL_VERSION } = require('./agent-input-capture-protocol');

// This wait starts AFTER the one confirm Enter. A deadline, cancellation, or
// lost scope cannot turn that already-written action into an unwritten one.
// The caller owns the PTY boundary and supplies its immutable physical scope.
function waitForCodexRewindInitializedComposer({
  readSnapshot,
  inspectReady,
  isCurrent,
  subscribe,
  cancelPromise,
  timeoutMs = 90_000,
  scope,
} = {}) {
  const expectedScope = scope && typeof scope === 'object'
    ? Object.freeze({ ...scope })
    : scope;
  return new Promise(resolve => {
    let settled = false;
    let checkScheduled = false;
    let eventSequence = 0;
    let unsubscribe = () => {};
    let timer;
    let lastReason = 'frame-unavailable';
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsubscribe(); } catch {}
      resolve({
        ...result,
        pending: result.success !== true,
        rollbackMayHaveApplied: true,
      });
    };
    const observationFailed = error => finish({
      success: false,
      error: 'codex_rewind_initialized_composer_observation_failed',
      reason: error?.message || String(error),
    });
    const scopeChanged = () => finish({
      success: false,
      error: 'codex_rewind_post_enter_scope_changed',
    });
    const check = () => {
      if (settled) return;
      try {
        if (isCurrent(expectedScope) !== true) {
          scopeChanged();
          return;
        }
        const snapshot = readSnapshot();
        if (snapshot?.success !== true
          || snapshot.authoritativeFrameCommitted !== true
          || snapshot.currentSnapshot === false
          || snapshot.fresh === false
          || snapshot.committed === false) {
          lastReason = snapshot ? 'frame-not-current' : 'frame-unavailable';
          return;
        }
        const inspected = inspectReady(snapshot);
        // Send-ready can legitimately ignore MCP startup. Post-Rewind Ctrl+G
        // needs the initialized composer instead, without changing Send's
        // broader readiness contract or interpreting old scrollback here.
        const blockers = [
          ...(Array.isArray(inspected?.blockers) ? inspected.blockers : []),
          ...(Array.isArray(inspected?.ignoredBlockers) ? inspected.ignoredBlockers : []),
        ];
        const startup = blockers.includes('mcp-startup');
        lastReason = startup ? 'mcp-startup' : (inspected?.reason || 'not-ready');
        if (isCurrent(expectedScope) !== true) {
          scopeChanged();
          return;
        }
        if (inspected?.ready === true && !startup) {
          const readyEventSequence = eventSequence;
          // A cancellation resolved in the same event turn (or during the
          // observation) gets its reaction before success. A newer frame
          // event also invalidates this candidate instead of borrowing it.
          queueMicrotask(() => {
            if (settled || readyEventSequence !== eventSequence) return;
            try {
              if (isCurrent(expectedScope) !== true) scopeChanged();
              else finish({ success: true });
            } catch (error) {
              observationFailed(error);
            }
          });
        }
      } catch (error) {
        observationFailed(error);
      }
    };
    const requestCheck = () => {
      eventSequence += 1;
      if (settled || checkScheduled) return;
      checkScheduled = true;
      queueMicrotask(() => {
        checkScheduled = false;
        check();
      });
    };
    const cancel = () => finish({
      success: false,
      cancelled: true,
      error: 'codex_rewind_post_enter_cancelled',
    });
    // Register cancellation before scheduling the initial read. An already
    // cancelled operation must not win a same-tick race with an idle frame.
    if (cancelPromise) Promise.resolve(cancelPromise).then(cancel, cancel);
    const deadlineMs = Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Number(timeoutMs))
      : 90_000;
    timer = setTimeout(() => finish({
      success: false,
      error: 'codex_rewind_initialized_composer_timeout',
      reason: lastReason,
    }), deadlineMs);
    try {
      const cleanup = subscribe(requestCheck);
      if (typeof cleanup === 'function') unsubscribe = cleanup;
      // Subscribe first, then close the already-ready/event-registration race.
      // A synchronous event inside subscribe is coalesced with this read.
      requestCheck();
    } catch (error) {
      observationFailed(error);
    }
  });
}

const RECOVERABLE_JOURNAL_PHASES = new Set([
  'confirm-enter-boundary',
  'branch-draft-restored',
  'rollback-applied',
  'stable-source-settled',
]);

function presentString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// A positive verdict grants only continuation/settlement of this old action.
// It does NOT arm an Enter, mutate/revive authority, or prove a restored draft.
// current: authority.identity + actionGeneration/isRunning/stopping/busy and
//          optional sourceFilePath/mirrorGeneration.
// record: an optional main-owned continuation with exact operationId,
//         requestId, actionGeneration, expectedInputRevision; originalLaunchId,
//         terminalToken, mirrorGeneration and sourceFilePath are additive guards.
//         A legacy owned +1 revision additionally needs admitted recovery
//         metadata and the actual protocol intent supplied by onCaptureArmed.
function classifyCodexRewindPostEnterRecovery({
  journal,
  authority,
  current,
  record = null,
} = {}) {
  const deny = reason => ({ accepted: false, reason });
  if (!journal || journal.invalid === true || journal.version !== 2) {
    return deny('rewind-journal-unavailable');
  }
  if (!RECOVERABLE_JOURNAL_PHASES.has(journal.phase)) {
    return deny('rewind-journal-phase-not-recoverable');
  }
  if (!authority || authority.profile !== CODEX_ACTION_PROFILE_NATIVE_REWIND
    || !presentString(authority.authorityId)) {
    return deny('rewind-authority-unavailable');
  }
  const legacyRevoked = authority.phase === 'revoked';
  if (legacyRevoked) {
    if (authority.reason !== 'codex_input_not_ready'
      || !Number.isFinite(authority.consumedAt)
      || authority.consumedAt <= 0) {
      return deny('rewind-authority-revocation-not-recoverable');
    }
  } else if (authority.phase !== 'consumed' && authority.phase !== 'committed') {
    return deny('rewind-authority-not-consumed');
  }
  const identity = authority.identity;
  const identityVerdict = compareCodexActionAuthorityIdentity(identity, identity);
  if (!identityVerdict.matches) return deny(identityVerdict.reason);
  if (!current || current.isRunning !== true) return deny('process-not-running');
  if (current.stopping !== false) return deny('process-stopping-or-unknown');
  if (current.busy !== false) return deny('turn-busy-or-unknown');

  const journalIdentityChecks = [
    ['operation-changed', journal.operationId === identity.operationId],
    ['request-changed', journal.requestId === identity.requestId],
    ['project-owner-changed', journal.projectId === identity.projectId],
    ['origin-project-changed', journal.originProjectId === undefined
      || journal.originProjectId === identity.projectId],
    ['tab-owner-changed', journal.tabId === identity.tabId],
    ['source-session-changed', journal.sourceSessionId === identity.sourceSessionId],
    ['persisted-session-changed', (journal.expectedBindingSessionId || journal.sourceSessionId)
      === identity.persistedSessionId],
    ['lifecycle-generation-changed', journal.sourceLifecycleGeneration === identity.lifecycleGeneration],
    ['run-generation-changed', Number(journal.sourceRunSeq) === Number(identity.runSeq)],
    ['action-generation-changed', presentString(authority.actionGeneration)
      && journal.actionGeneration === authority.actionGeneration
      && current.actionGeneration === authority.actionGeneration],
  ];
  const journalMismatch = journalIdentityChecks.find(([, matches]) => !matches);
  if (journalMismatch) return deny(journalMismatch[0]);

  const target = authority.target;
  if (!target || !presentString(journal.targetUuid)
    || !presentString(journal.targetPhysicalSessionId)
    || !Number.isInteger(journal.targetSourceLine) || journal.targetSourceLine < 1
    || !/^[a-f0-9]{64}$/i.test(String(journal.targetTextHash || ''))
    || !Number.isInteger(journal.rollbackTurns) || journal.rollbackTurns < 1) {
    return deny('rewind-target-unproven');
  }
  for (const field of [
    'targetUuid', 'targetPhysicalSessionId', 'targetSourceLine', 'targetTextHash',
  ]) {
    if ((journal[field] ?? null) !== (target[field] ?? null)) {
      return deny('rewind-target-changed:' + field);
    }
  }
  // Older programmatic authorities carry the exact four-field target only.
  // Their producer could persist Number(null) as ordinal 0 in the journal;
  // that diagnostic must not invent a missing authority field or block the
  // already-owned operation. Explicitly bound navigation fields stay exact.
  for (const field of ['targetUserOrdinal', 'targetDerivation']) {
    if (target[field] !== undefined && target[field] !== null
      && target[field] !== journal[field]) {
      return deny('rewind-target-changed:' + field);
    }
  }
  if (target.rollbackTurns !== undefined && target.rollbackTurns !== journal.rollbackTurns) {
    return deny('rewind-target-changed:rollbackTurns');
  }

  let expectedInputRevision = identity.inputRevision;
  if (record !== null) {
    if (!record || typeof record !== 'object'
      || record.operationId !== journal.operationId
      || record.requestId !== journal.requestId
      || record.actionGeneration !== journal.actionGeneration) {
      return deny('rewind-recovery-record-changed');
    }
    if (!Number.isInteger(record.expectedInputRevision) || record.expectedInputRevision < 0) {
      return deny('rewind-recovery-input-unproven');
    }
    for (const [field, expected] of [
      ['originalLaunchId', identity.launchId],
      ['terminalToken', identity.terminalToken],
      ['mirrorGeneration', current.mirrorGeneration],
      ['sourceFilePath', current.sourceFilePath],
    ]) {
      if (record[field] !== undefined && (!record[field] || record[field] !== expected)) {
        return deny('rewind-recovery-scope-changed:' + field);
      }
    }
    // A legacy lease remains revoked. Only the separately admitted main-owned
    // recovery can account for ONE revision reserved by its actual Ctrl+G.
    // Neither a later manual revision nor an arbitrary renderer-supplied
    // capture-shaped object is a continuation record from onCaptureArmed.
    if (legacyRevoked && record.expectedInputRevision !== identity.inputRevision) {
      const capture = record.captureOperation;
      const generation = capture?.generation;
      const ownedCaptureRevision = record.expectedInputRevision === identity.inputRevision + 1
        && Number.isFinite(record.authorizedLegacyRecoveryAt)
        && record.authorizedLegacyRecoveryAt > 0
        && record.authorizedLegacyRecoveryInputRevision === identity.inputRevision
        && capture?.protocol === PROTOCOL_VERSION
        && capture.mode === 'grab'
        && capture.agent === 'codex'
        && capture.tabId === identity.tabId
        && presentString(capture.operationId)
        && presentString(capture.terminalId)
        && capture.terminalId === current.terminalToken?._notedGrabTerminalId
        && generation?.terminalIdentityStable === true
        && generation.inputRevision === identity.inputRevision
        && generation.terminalRunSeq === identity.runSeq
        && generation.terminalLifecycleGeneration === identity.lifecycleGeneration
        && presentString(record.mirrorGeneration)
        && generation.mirrorGeneration === record.mirrorGeneration
        && generation.mirrorGeneration === current.mirrorGeneration;
      if (!ownedCaptureRevision) return deny('input-revision-changed');
    }
    expectedInputRevision = record.expectedInputRevision;
  }
  const currentVerdict = compareCodexActionAuthorityIdentity({
    ...identity,
    inputRevision: expectedInputRevision,
  }, current);
  if (!currentVerdict.matches) return deny(currentVerdict.reason);
  return { accepted: true, reason: legacyRevoked ? 'legacy-post-enter-recovery' : 'same-operation-post-enter' };
}

module.exports = {
  waitForCodexRewindInitializedComposer,
  classifyCodexRewindPostEnterRecovery,
};
