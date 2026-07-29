const fs = require('fs');
const path = require('path');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set([
  'creating',
  'starting',
  'sending',
  'sent',
  'queued',
  'running',
  'waiting_descendants',
  'waiting_recovery',
]);
const SOURCE_FOLLOWUP_DELIVERY_STATUSES = new Set(['pending', 'sending', 'sent', 'queued']);
const SOURCE_FOLLOWUP_RECONCILABLE_STATUSES = new Set([
  ...SOURCE_FOLLOWUP_DELIVERY_STATUSES,
  'unconfirmed',
]);
const SOURCE_FOLLOWUP_PROBLEM_STATUSES = new Set(['waiting-for-input', 'failed', 'unconfirmed']);
const ORCHESTRATION_TARGET_HANDOFF_PREFIX = 'orchestration:';
const ORCHESTRATION_TARGET_SOURCE_PREFIX = 'orchestration:';
const ORCHESTRATION_COMPLETION_HANDOFF_PREFIX = 'orchestration-complete:';
const ORCHESTRATION_COMPLETION_SOURCE_PREFIX = 'orchestration-completion:';
const MAX_SETTLED_RUNS = 200;
const SETTLED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_POLICY_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ORCHESTRATION_SETTINGS = Object.freeze({
  failureGraceMs: 5 * 60 * 1000,
  successAutoStopMs: 5 * 60 * 1000,
  reactToManualInterrupt: false,
  autoStopCreatedTargets: true,
});

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function canNotifySource(run) {
  return run?.notifySource !== false
    && !!run?.sourceTabId
    && run.sourceTabId !== run.targetTabId
    && run.notificationSuppressed !== true;
}

function isSourceFollowupPending(run) {
  return isTerminalStatus(run?.status)
    && canNotifySource(run)
    && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt
    && SOURCE_FOLLOWUP_DELIVERY_STATUSES.has(run.notificationStatus);
}

function isSourceNotificationBlocked(run) {
  return isTerminalStatus(run?.status)
    && canNotifySource(run)
    && SOURCE_FOLLOWUP_PROBLEM_STATUSES.has(run.notificationStatus);
}

function shouldMarkSourceFollowupUnconfirmed(run, reconciliation) {
  return reconciliation?.confirmed !== true
    && isTerminalStatus(run?.status)
    && canNotifySource(run)
    && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt
    && (run.notificationStatus === 'sent' || run.notificationStatus === 'queued');
}

function isTrackedOrchestrationRun(run) {
  return isActiveStatus(run?.status)
    // A Stop edge can beat the final JSONL append. Keep the durable run in
    // startup reconciliation even when it has no separate source notification;
    // otherwise a restart removes the only owner capable of proving the result.
    || (run?.status === 'completed' && run.resultComplete === false)
    || isSourceFollowupPending(run)
    || isSourceNotificationBlocked(run);
}

function isCompleteOrchestrationResult(result) {
  return result?.found === true && result?.resultComplete === true;
}

function shouldScheduleCreatedTargetAutoStop(run) {
  return run?.status === 'completed'
    && run.targetCreatedByOrchestration === true
    && run.autoStopCreatedTargets !== false
    && Number(run.successAutoStopMs) > 0
    && !run.autoStopAt
    && !run.autoStopFinishedAt;
}

function requiresExactLifecycleGeneration(run) {
  return run?.targetToolType === 'codex';
}

function lifecycleGenerationCheck(run, observedGeneration) {
  if (!requiresExactLifecycleGeneration(run)) {
    return { verdict: 'not-required', reason: null };
  }
  const expected = typeof run?.targetLifecycleGeneration === 'string'
    ? run.targetLifecycleGeneration.trim()
    : '';
  const observed = typeof observedGeneration === 'string'
    ? observedGeneration.trim()
    : '';
  if (!expected) return { verdict: 'unknown', reason: 'expected-generation-unproven' };
  if (!observed) return { verdict: 'unknown', reason: 'observed-generation-unproven' };
  return expected === observed
    ? { verdict: 'match', reason: null }
    : { verdict: 'changed', reason: 'process-generation-changed' };
}

function shouldRetryWaitingNotificationForSourceLifecycle(payload) {
  return payload?.type === 'done'
    || (payload?.type === 'busy' && payload?.busy === true)
    || (payload?.type === 'snapshot'
      && payload?.inputReady === true
      && payload?.busy !== true
      && payload?.starting !== true
      && payload?.stopping !== true);
}

function canonicalPromptAuditSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source.startsWith('codex-') ? source.slice('codex-'.length) : source;
}

function orchestrationTargetRunIdFromAudit(payload) {
  if (payload?.success !== true) return null;
  const handoffId = typeof payload?.handoffId === 'string' ? payload.handoffId.trim() : '';
  if (!handoffId.startsWith(ORCHESTRATION_TARGET_HANDOFF_PREFIX)) return null;
  const runId = handoffId.slice(ORCHESTRATION_TARGET_HANDOFF_PREFIX.length).trim();
  if (!runId || handoffId !== ORCHESTRATION_TARGET_HANDOFF_PREFIX + runId) return null;
  return runId;
}

function orchestrationCompletionRunIdFromAudit(payload) {
  if (payload?.success !== true) return null;
  const handoffId = typeof payload?.handoffId === 'string' ? payload.handoffId.trim() : '';
  if (!handoffId.startsWith(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX)) return null;
  const runId = handoffId.slice(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX.length).trim();
  if (!runId || handoffId !== ORCHESTRATION_COMPLETION_HANDOFF_PREFIX + runId) return null;
  const source = typeof payload?.source === 'string' ? payload.source.trim() : '';
  // Codex normalizes every PTY source with one `codex-` prefix before staging
  // its rollout audit. The handoff remains provider-neutral. Canonicalize only
  // that one known transport prefix; arbitrary suffix/prefix matches are still
  // rejected so an audit cannot confirm a neighboring run.
  const canonicalSource = canonicalPromptAuditSource(source);
  if (canonicalSource !== ORCHESTRATION_COMPLETION_SOURCE_PREFIX + runId) return null;
  return runId;
}

function orchestrationInstallBlockers(run) {
  if (!run?.runId) return [];
  const blockers = [];
  const separateSource = Boolean(
    run.sourceTabId
    && run.sourceTabId !== run.targetTabId
    && run.notifySource !== false
    && run.notificationSuppressed !== true,
  );
  const active = isActiveStatus(run.status);

  if (active && separateSource) {
    blockers.push({
      tabId: run.sourceTabId,
      kind: 'orchestration',
      status: run.status === 'waiting_recovery' ? 'recovery' : 'inherited-busy',
      role: 'source',
      runId: run.runId,
      orchestrationStatus: run.status,
      notificationStatus: run.notificationStatus || null,
      projectId: run.sourceProjectId || null,
      project: run.sourceProjectName || null,
      name: run.sourceTabName || ('tab ' + String(run.sourceTabId).slice(-6)),
      cwd: run.sourceProjectPath || null,
    });
  }

  if (active && run.targetTabId) {
    blockers.push({
      tabId: run.targetTabId,
      kind: 'orchestration',
      status: run.status === 'waiting_recovery' ? 'recovery' : run.status,
      role: 'target',
      runId: run.runId,
      orchestrationStatus: run.status,
      notificationStatus: run.notificationStatus || null,
      projectId: run.targetProjectId || null,
      project: run.targetProjectName || null,
      name: run.targetTabName || ('tab ' + String(run.targetTabId).slice(-6)),
      cwd: run.targetCwd || run.targetProjectPath || null,
    });
  }

  if (!active && separateSource && (isSourceFollowupPending(run) || isSourceNotificationBlocked(run))) {
    blockers.push({
      tabId: run.sourceTabId,
      kind: 'orchestration',
      status: isSourceFollowupPending(run) ? 'completion-handoff' : 'notification-blocked',
      role: 'source',
      runId: run.runId,
      orchestrationStatus: run.status,
      notificationStatus: run.notificationStatus || null,
      projectId: run.sourceProjectId || null,
      project: run.sourceProjectName || null,
      name: run.sourceTabName || ('tab ' + String(run.sourceTabId).slice(-6)),
      cwd: run.sourceProjectPath || null,
    });
  }

  return blockers;
}

function mergeActiveLoadersWithOrchestrations(runtimeSnapshot = {}, runs = []) {
  const loaders = [];
  const seen = new Set();
  for (const loader of Array.isArray(runtimeSnapshot?.loaders) ? runtimeSnapshot.loaders : []) {
    if (!loader?.tabId || seen.has(loader.tabId)) continue;
    loaders.push(loader);
    seen.add(loader.tabId);
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    for (const blocker of orchestrationInstallBlockers(run)) {
      if (seen.has(blocker.tabId)) continue;
      loaders.push(blocker);
      seen.add(blocker.tabId);
    }
  }
  return {
    ...runtimeSnapshot,
    idle: runtimeSnapshot?.idle === false ? false : loaders.length === 0,
    count: loaders.length,
    loaders,
    ts: Date.now(),
  };
}

function hasNewerTargetRun(runs, scheduledRun) {
  if (!scheduledRun?.runId || !scheduledRun?.targetTabId) return false;
  const completedAt = Number(scheduledRun.completedAt);
  return (Array.isArray(runs) ? runs : []).some((candidate) => {
    if (!candidate || candidate.runId === scheduledRun.runId) return false;
    if (candidate.targetTabId !== scheduledRun.targetTabId) return false;
    if (isActiveStatus(candidate.status)) return true;
    if (!Number.isFinite(completedAt)) return false;
    return [candidate.deliveryAcceptedAt, candidate.startedAt, candidate.ownCompletedAt]
      .map(Number)
      .some((timestamp) => Number.isFinite(timestamp) && timestamp >= completedAt);
  });
}

function isAbortedReason(reason) {
  const value = String(reason || '').toLowerCase();
  return value.includes('abort') ||
    value.includes('interrupt') ||
    value.includes('manual-stop') ||
    value.includes('killed') ||
    value.includes('failed') ||
    value.includes('error') ||
    value.includes('exited') ||
    value.includes('closed');
}

function outcomeForReason(reason) {
  const value = String(reason || '').toLowerCase();
  if (value.includes('target_closed') || value.includes('target-closed') || value === 'close') return 'target_closed';
  if (value.includes('startup')) return 'startup_failed';
  if (value.includes('process') && (value.includes('exit') || value.includes('killed'))) return 'process_exited';
  if (value.includes('abort') || value.includes('interrupt') || value.includes('manual-stop')) return 'interrupted';
  if (value.includes('failed') || value.includes('error')) return 'failed';
  return isAbortedReason(value) ? 'unknown' : 'success';
}

function clampDelay(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_POLICY_DELAY_MS, Math.round(number)));
}

function normalizeSettings(value = {}) {
  return {
    failureGraceMs: clampDelay(value.failureGraceMs, DEFAULT_ORCHESTRATION_SETTINGS.failureGraceMs),
    successAutoStopMs: clampDelay(value.successAutoStopMs, DEFAULT_ORCHESTRATION_SETTINGS.successAutoStopMs),
    reactToManualInterrupt: value.reactToManualInterrupt === true,
    autoStopCreatedTargets: value.autoStopCreatedTargets !== false,
  };
}

function publicRun(run) {
  if (!run) return null;
  const {
    promptHash: _promptHash,
    resultPromptHash: _resultPromptHash,
    notificationPromptHash: _notificationPromptHash,
    targetPromptProofHash: _targetPromptProofHash,
    targetPromptProofExpectedHash: _targetPromptProofExpectedHash,
    targetPromptAuditHash: _targetPromptAuditHash,
    targetBusySeen: _targetBusySeen,
    waitingForPriorTurn: _waitingForPriorTurn,
    ...safe
  } = run;
  return { ...safe };
}

class OrchestrationRunStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.runs = new Map();
    this.createdTargetTabIds = new Set();
    this.settings = { ...DEFAULT_ORCHESTRATION_SETTINGS };
    this.initialized = false;
    this.initializePromise = null;
    this.persistChain = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      try {
        const raw = await fs.promises.readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.settings = normalizeSettings(parsed?.settings);
        const storedRuns = Array.isArray(parsed?.runs) ? parsed.runs : [];
        for (const tabId of Array.isArray(parsed?.createdTargetTabIds) ? parsed.createdTargetTabIds : []) {
          if (typeof tabId === 'string' && tabId) this.createdTargetTabIds.add(tabId);
        }
        // Backfill ownership from v2 stores before settled-run pruning removes
        // the original run which physically created the executor tab.
        for (const stored of storedRuns) {
          if (stored?.targetCreated === true && stored?.targetTabId) {
            this.createdTargetTabIds.add(stored.targetTabId);
          }
        }
        let migrationNeeded = !Array.isArray(parsed?.createdTargetTabIds);
        for (const stored of storedRuns) {
          if (!stored?.runId || !stored?.targetTabId) continue;
          const run = {
            waitForDescendants: stored.waitForDescendants !== false,
            failureGraceMs: clampDelay(stored.failureGraceMs, this.settings.failureGraceMs),
            successAutoStopMs: clampDelay(stored.successAutoStopMs, this.settings.successAutoStopMs),
            reactToManualInterrupt: stored.reactToManualInterrupt === true,
            autoStopCreatedTargets: stored.autoStopCreatedTargets !== false,
            ...stored,
          };
          run.targetCreatedByOrchestration = stored.targetCreatedByOrchestration === true
            || this.createdTargetTabIds.has(stored.targetTabId);
          if (stored.targetCreatedByOrchestration !== run.targetCreatedByOrchestration) {
            migrationNeeded = true;
          }
          // Legacy notification failures predate the persistent attention flag.
          // Surface only failures that still block the source, not every old run.
          if (isSourceNotificationBlocked(run) && !run.attentionRequiredAt) {
            run.attentionRequiredAt = run.notificationAttemptedAt || run.updatedAt || run.completedAt || Date.now();
          }
          this.runs.set(run.runId, run);
        }
        migrationNeeded = this._backfillCreatedTargetAutoStops() || migrationNeeded;
        this._pruneInMemory();
        if (migrationNeeded) this._schedulePersist();
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn('[OrchestrationRuns] load failed:', error?.message || error);
        }
      }
      this.initialized = true;
    })();
    return this.initializePromise;
  }

  async create(input) {
    await this.initialize();
    if (!input?.runId) throw new Error('runId required');
    if (this.runs.has(input.runId)) throw new Error('runId already exists');
    const predecessor = this._activeForTarget(input.targetTabId).at(-1) || null;
    const parentRunId = input.parentRunId || this._inferParentRunId(input.sourceTabId);
    if (parentRunId) this._validateParent(parentRunId, input);
    if (input.targetCreated === true && input.targetTabId) {
      this.createdTargetTabIds.add(input.targetTabId);
    }
    const now = Date.now();
    const run = {
      ...input,
      targetCreatedByOrchestration: this.createdTargetTabIds.has(input.targetTabId),
      status: 'creating',
      createdAt: now,
      updatedAt: now,
      notifySource: input.notifySource !== false,
      notificationStatus: 'pending',
      resultAvailable: false,
      resultComplete: false,
      predecessorRunId: predecessor?.runId || null,
      parentRunId: parentRunId || null,
      waitForDescendants: input.waitForDescendants !== false,
      failureGraceMs: clampDelay(input.failureGraceMs, this.settings.failureGraceMs),
      successAutoStopMs: clampDelay(input.successAutoStopMs, this.settings.successAutoStopMs),
      reactToManualInterrupt: typeof input.reactToManualInterrupt === 'boolean'
        ? input.reactToManualInterrupt
        : this.settings.reactToManualInterrupt,
      autoStopCreatedTargets: typeof input.autoStopCreatedTargets === 'boolean'
        ? input.autoStopCreatedTargets
        : this.settings.autoStopCreatedTargets,
      targetBusySeen: false,
      waitingForPriorTurn: false,
      outcome: null,
      ownCompletedAt: null,
      resultPromptHash: null,
      resultAfterAt: null,
      resultPromptRequestedAt: null,
      recoveryDeadlineAt: null,
      waitingOnRunIds: [],
      notificationHandoffId: null,
      sourceFollowupPending: false,
      sourceFollowupStartedAt: null,
      sourceFollowupProofKind: null,
    };
    this.runs.set(run.runId, run);
    this._schedulePersist();
    return publicRun(run);
  }

  async patch(runId, patch) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    Object.assign(run, patch, { updatedAt: Date.now() });
    this._schedulePersist();
    return publicRun(run);
  }

  async markDelivery(runId, {
    baselineBusy = false,
    sessionId = null,
    lifecycleGeneration = null,
  } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return publicRun(run);
    const predecessor = run.predecessorRunId ? this.runs.get(run.predecessorRunId) : null;
    const waitingForPredecessor = Boolean(predecessor && !isTerminalStatus(predecessor.status));
    run.waitingForPriorTurn = !waitingForPredecessor && baselineBusy;
    run.status = (waitingForPredecessor || run.waitingForPriorTurn) ? 'queued' : 'sent';
    run.sessionId = sessionId || run.sessionId || null;
    run.targetLifecycleGeneration = lifecycleGeneration || run.targetLifecycleGeneration || null;
    run.deliveryAcceptedAt = Date.now();
    if (run.targetPromptProofAt && !waitingForPredecessor) {
      run.waitingForPriorTurn = false;
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= run.targetPromptProofAt;
    }
    run.updatedAt = Date.now();
    this._schedulePersist();
    return publicRun(run);
  }

  async confirmTargetPromptDelivery(runId, proof = {}, options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    const changed = [];
    if (!run) return { confirmed: false, reason: 'run-not-found', changed };
    if (run.targetPromptProofAt) {
      const sameProof = proof.actualHash === run.targetPromptProofHash
        && proof.expectedHash === run.targetPromptProofExpectedHash
        && (!proof.userUuid || !run.targetPromptProofUserUuid || proof.userUuid === run.targetPromptProofUserUuid);
      return {
        confirmed: sameProof,
        idempotent: sameProof,
        reason: sameProof ? null : 'target-prompt-proof-conflict',
        run: publicRun(run),
        changed,
      };
    }
    if (isTerminalStatus(run.status)) {
      return { confirmed: false, reason: 'run-already-settled', run: publicRun(run), changed };
    }
    if (proof.targetTabId !== run.targetTabId) {
      return { confirmed: false, reason: 'target-tab-mismatch', run: publicRun(run), changed };
    }
    const expectedHandoffId = ORCHESTRATION_TARGET_HANDOFF_PREFIX + run.runId;
    const expectedSource = ORCHESTRATION_TARGET_SOURCE_PREFIX + run.sourceTabId;
    if (proof.handoffId !== expectedHandoffId
      || canonicalPromptAuditSource(proof.source) !== expectedSource) {
      return { confirmed: false, reason: 'target-prompt-identity-mismatch', run: publicRun(run), changed };
    }
    // promptHash is the full transcript lookup identity (SHA-256). PasteAudit
    // emits a separate short transport identity. Comparing those two domains
    // made every real audit fail even though unit fixtures used equal strings.
    if (!run.targetPromptAuditHash || proof.expectedHash !== run.targetPromptAuditHash) {
      return { confirmed: false, reason: 'target-prompt-hash-mismatch', run: publicRun(run), changed };
    }
    if (proof.toolType && run.targetToolType && proof.toolType !== run.targetToolType) {
      return { confirmed: false, reason: 'target-tool-mismatch', run: publicRun(run), changed };
    }

    const parsedAuditAt = Date.parse(String(proof.auditTimestamp || ''));
    const requestedNow = Number(options.now);
    const now = Number.isFinite(requestedNow)
      ? requestedNow
      : (Number.isFinite(parsedAuditAt) ? parsedAuditAt : Date.now());
    run.targetPromptProofAt = now;
    run.targetPromptProofKind = 'prompt-audit';
    run.targetPromptProofHash = proof.actualHash;
    run.targetPromptProofExpectedHash = proof.expectedHash;
    run.targetPromptProofCanonicalized = proof.canonicalized === true;
    run.targetPromptProofActualLen = Number.isFinite(proof.actualLen) ? Number(proof.actualLen) : null;
    run.targetPromptProofExpectedLen = Number.isFinite(proof.expectedLen) ? Number(proof.expectedLen) : null;
    run.targetPromptProofSessionId = proof.sessionId || null;
    run.targetPromptProofUserUuid = proof.userUuid || null;
    run.sessionId = proof.sessionId || run.sessionId || null;

    const predecessor = run.predecessorRunId ? this.runs.get(run.predecessorRunId) : null;
    if (run.deliveryAcceptedAt && (!predecessor || isTerminalStatus(predecessor.status))) {
      run.waitingForPriorTurn = false;
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= now;
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
    this._schedulePersist();
    return { confirmed: true, run: publicRun(run), changed };
  }

  async markNotification(runId, status, patch = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    // Exact prompt/transcript proof is stronger than the transport's earlier
    // `queued` reply. The reply can resolve after the audit event, so never
    // regress an already materialized source notification back to queued.
    run.notificationStatus = run.sourceFollowupStartedAt
      && (status === 'sent' || status === 'queued')
      ? 'sent'
      : status;
    Object.assign(run, patch);
    if (status === 'sent' || status === 'queued') {
      run.notificationDeliveredAt ||= Date.now();
      run.parentFollowupPending = Boolean(run.parentRunId && run.notifySource !== false);
    } else if (status === 'suppressed') {
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= Date.now();
    }
    this._syncSourceFollowupState(run);
    run.updatedAt = Date.now();
    const changed = [];
    this._pushChanged(changed, run);
    const settled = [];
    this._refreshAncestors(run.parentRunId, changed, settled, Date.now());
    this._schedulePersist();
    return { run: publicRun(run), changed, settled };
  }

  async applyLifecycle(tabId, payload = {}) {
    await this.initialize();
    const head = this._headForTarget(tabId);
    const changed = [];
    const settled = [];
    const now = Date.now();

    if (head?.deliveryAcceptedAt) {
      const generationCheck = lifecycleGenerationCheck(head, payload.lifecycleGeneration);
      if (generationCheck.verdict === 'changed' || generationCheck.verdict === 'unknown') {
        return {
          changed,
          settled,
          completed: [],
          ignored: true,
          generationVerdict: generationCheck.verdict,
          ignoreReason: generationCheck.reason,
          expectedLifecycleGeneration: head.targetLifecycleGeneration || null,
          observedLifecycleGeneration: payload.lifecycleGeneration || null,
        };
      }
      const sessionId = payload.sessionId || head.sessionId || null;
      if (payload.type === 'busy' && payload.busy === true) {
        if (!head.waitingForPriorTurn) {
          // A generic busy edge cannot identify which completion notification
          // started this turn. A waiting parent is reopened only by the exact
          // PasteAudit/transcript proof in confirmSourceFollowup().
          if (head.status === 'waiting_descendants') {
            return { changed, settled, completed: [] };
          }
          // A generic busy edge proves only that the tab is working again. It
          // does not prove that this turn continues the interrupted delegation.
          // The explicit recovery action arms the next causal turn by moving
          // the run back to queued and recording its result boundary.
          if (head.status === 'waiting_recovery' || head.outcome) {
            return {
              changed,
              settled,
              completed: [],
              ignored: true,
              ignoreReason: 'recovery-continuation-unproven',
            };
          }
          head.targetBusySeen = true;
          head.status = 'running';
          head.startedAt ||= now;
          head.sessionId = sessionId;
          head.updatedAt = now;
          this._pushChanged(changed, head);
        }
      } else if (payload.type === 'done') {
        if (head.waitingForPriorTurn) {
          head.waitingForPriorTurn = false;
          head.status = 'queued';
          head.updatedAt = now;
          this._pushChanged(changed, head);
        } else if (head.targetBusySeen) {
          const outcome = outcomeForReason(payload.reason);
          head.targetBusySeen = false;
          head.sessionId = sessionId;
          head.ownCompletedAt = now;
          head.completionReason = payload.reason || 'turn-complete';
          if (outcome === 'success') {
            head.outcome = 'success';
            this._settleSuccessfulRun(head, changed, settled, now);
          } else {
            this._beginRecovery(head, outcome, payload.reason || 'target turn aborted', changed, settled, now);
          }
          this._refreshAncestors(head.parentRunId, changed, settled, now);
        }
      }
    }

    if (changed.length) this._schedulePersist();
    return {
      changed,
      settled,
      completed: settled.filter((run) => run.status === 'completed'),
    };
  }

  async confirmSourceFollowup(runId, proof = {}, options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    const changed = [];
    const settled = [];
    if (!run) return { confirmed: false, reason: 'run-not-found', changed, settled };
    if (run.sourceFollowupStartedAt) {
      return { confirmed: true, idempotent: true, run: publicRun(run), changed, settled };
    }
    if (!isTerminalStatus(run.status) || !canNotifySource(run)) {
      return { confirmed: false, reason: 'run-not-awaiting-source-followup', run: publicRun(run), changed, settled };
    }
    this._syncSourceFollowupState(run);
    if (!run.sourceFollowupPending) {
      return { confirmed: false, reason: 'source-followup-not-pending', run: publicRun(run), changed, settled };
    }
    if (!proof.sourceTabId || proof.sourceTabId !== run.sourceTabId) {
      return { confirmed: false, reason: 'source-tab-mismatch', run: publicRun(run), changed, settled };
    }

    const proofKind = proof.kind === 'transcript' ? 'transcript' : 'prompt-audit';
    if (proofKind === 'prompt-audit') {
      const expectedHandoffId = run.notificationHandoffId
        || ORCHESTRATION_COMPLETION_HANDOFF_PREFIX + run.runId;
      const expectedSource = ORCHESTRATION_COMPLETION_SOURCE_PREFIX + run.runId;
      if (proof.handoffId !== expectedHandoffId
        || canonicalPromptAuditSource(proof.source) !== expectedSource) {
        return { confirmed: false, reason: 'notification-identity-mismatch', run: publicRun(run), changed, settled };
      }
    } else if (!run.notificationPromptHash
      || proof.notificationPromptHash !== run.notificationPromptHash) {
      return { confirmed: false, reason: 'notification-prompt-hash-mismatch', run: publicRun(run), changed, settled };
    }

    const parsedAuditAt = Date.parse(String(proof.auditTimestamp || ''));
    const requestedNow = Number(options.now);
    const now = Number.isFinite(requestedNow)
      ? requestedNow
      : (Number.isFinite(parsedAuditAt) ? parsedAuditAt : Date.now());
    run.sourceFollowupPending = false;
    run.sourceFollowupStartedAt = now;
    run.sourceFollowupProofKind = proofKind;
    run.sourceFollowupSessionId = proof.sessionId || null;
    run.sourceFollowupUserUuid = proof.userUuid || null;
    run.sourceFollowupAuditHash = proof.actualHash || null;
    // A causal prompt audit or transcript match proves that the notification
    // has materialized in the source session. `queued` describes only the
    // earlier Enter transport; after exact proof the durable delivery state is
    // unambiguously sent.
    run.notificationStatus = 'sent';
    run.notificationDeliveredAt ||= now;
    run.notificationError = null;
    run.notificationUnconfirmedAt = null;
    run.notificationUnconfirmedReason = null;
    if (run.status === 'completed') run.attentionRequiredAt = null;
    run.updatedAt = now;

    const parent = run.parentRunId ? this.runs.get(run.parentRunId) : null;
    if (parent && parent.targetTabId === run.sourceTabId) {
      run.parentConsumedAt = now;
      run.parentFollowupPending = false;
      parent.resultPromptHash = run.notificationPromptHash || parent.resultPromptHash || null;
      parent.resultAfterAt = null;
      parent.resultPromptRequestedAt = run.notificationAttemptedAt
        || run.notificationDeliveredAt
        || now;
      if (!isTerminalStatus(parent.status)) {
        parent.outcome = null;
        parent.ownCompletedAt = null;
        parent.completedAt = null;
        parent.completionReason = null;
        parent.error = null;
        parent.recoveryDeadlineAt = null;
        parent.waitingOnRunIds = this._unresolvedChildren(parent).map((child) => child.runId);
        parent.targetBusySeen = true;
        parent.status = 'running';
        parent.startedAt ||= now;
        parent.sessionId = proof.sessionId || parent.sessionId || null;
        parent.updatedAt = now;
        this._pushChanged(changed, parent);
      }
    }
    this._pushChanged(changed, run);
    this._schedulePersist();
    return { confirmed: true, run: publicRun(run), changed, settled };
  }

  async reconcile(runId, observation = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return { changed: null, completed: false, settled: [] };
    const changed = [];
    const settled = [];
    const resultFound = observation.resultFound === true;
    const resultComplete = observation.resultComplete === true;
    const busy = observation.busy === true;
    const now = Date.now();
    const generationCheck = lifecycleGenerationCheck(run, observation.lifecycleGeneration);

    if (resultFound && resultComplete) {
      run.waitingForPriorTurn = false;
      run.targetBusySeen = true;
      run.resultAvailable = observation.resultAvailable !== false;
      run.resultTurnIndex = Number.isInteger(observation.turnIndex) ? observation.turnIndex : run.resultTurnIndex;
      if (busy) {
        run.status = 'running';
        run.startedAt ||= now;
      } else {
        run.targetBusySeen = false;
        run.outcome = 'success';
        run.ownCompletedAt ||= now;
        run.completionReason ||= 'recovered-from-transcript';
        this._settleSuccessfulRun(run, changed, settled, now);
      }
    } else if (generationCheck.verdict === 'changed') {
      if (run.status !== 'waiting_recovery') {
        this._beginRecovery(
          run,
          'process_replaced',
          'target process ownership changed: ' + generationCheck.reason,
          changed,
          settled,
          now,
        );
        this._refreshAncestors(run.parentRunId, changed, settled, now);
      }
      run.observedLifecycleGeneration = observation.lifecycleGeneration || null;
      run.updatedAt = now;
    } else if (generationCheck.verdict === 'unknown') {
      // An unavailable process observation is neither a match nor proof that
      // ownership changed. Keep the existing run untouched until an exact
      // generation or transcript result arrives.
    } else if (busy && !run.waitingForPriorTurn && run.status !== 'waiting_descendants') {
      if (run.status === 'waiting_recovery') {
        return {
          changed: publicRun(run),
          completed: false,
          generationVerdict: generationCheck.verdict,
          ignored: true,
          ignoreReason: 'recovery-continuation-unproven',
        };
      }
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= now;
      this._pushChanged(changed, run);
    }
    const canAdoptObservedSession = (resultFound && resultComplete)
      || generationCheck.verdict === 'match'
      || generationCheck.verdict === 'not-required';
    if (observation.sessionId && canAdoptObservedSession) {
      run.sessionId = observation.sessionId;
    }
    run.updatedAt = now;
    this._schedulePersist();
    return {
      changed: publicRun(run),
      completed: settled.some((item) => item.runId === run.runId && item.status === 'completed'),
      settled,
      generationVerdict: generationCheck.verdict,
    };
  }

  async handleTargetClosed(tabId, { now = Date.now(), failureGraceMs } = {}) {
    await this.initialize();
    const changed = [];
    const settled = [];
    for (const run of this._activeForTarget(tabId)) {
      this._beginRecovery(
        run,
        'target_closed',
        'target tab closed',
        changed,
        settled,
        now,
        failureGraceMs,
      );
      this._refreshAncestors(run.parentRunId, changed, settled, now);
    }
    if (changed.length) this._schedulePersist();
    return changed;
  }

  async beginRecovery(runId, outcome = 'failed', reason = 'agent run failed', options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) {
      return { changed: run ? [publicRun(run)] : [], settled: [] };
    }
    const now = Number(options.now) || Date.now();
    const changed = [];
    const settled = [];
    this._beginRecovery(run, outcome, reason, changed, settled, now, options.failureGraceMs);
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { changed, settled };
  }

  async handleSourceClosed(tabId) {
    await this.initialize();
    const changed = [];
    const now = Date.now();
    for (const run of this.runs.values()) {
      if (run.sourceTabId !== tabId) continue;
      this._syncSourceFollowupState(run);
      if (['suppressed', 'source-closed'].includes(run.notificationStatus)) continue;
      // `sent`/`queued` means only that Enter was attempted. Until exact
      // prompt-audit/transcript proof arrives, closing the source makes that
      // handoff impossible to consume and must release the inherited blocker.
      if (['sent', 'queued'].includes(run.notificationStatus)
        && (run.sourceFollowupStartedAt || run.sourceFollowupPending !== true)) continue;
      run.notificationStatus = 'source-closed';
      run.notificationSuppressed = true;
      run.sourceFollowupPending = false;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
    }
    if (changed.length) this._schedulePersist();
    return changed;
  }

  async resolveRecovery(runId, action, proof = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || run.status !== 'waiting_recovery') {
      return { run: publicRun(run), changed: [], settled: [] };
    }
    const now = Date.now();
    const changed = [];
    const settled = [];
    if (action === 'dismiss') {
      run.status = 'cancelled';
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      run.notificationStatus = 'suppressed';
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
      settled.push(publicRun(run));
    } else if (action === 'report') {
      run.status = 'failed';
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      run.notificationStatus = 'pending';
      run.notificationSuppressed = false;
      run.updatedAt = now;
      this._pushChanged(changed, run);
      settled.push(publicRun(run));
    } else if (action === 'reopen') {
      const continuationAfterAt = run.ownCompletedAt || now;
      run.status = 'queued';
      run.resultPromptHash = null;
      run.resultAfterAt = continuationAfterAt;
      run.resultPromptRequestedAt = continuationAfterAt;
      run.outcome = null;
      run.ownCompletedAt = null;
      run.completedAt = null;
      run.recoveryDeadlineAt = null;
      run.error = null;
      run.targetBusySeen = false;
      run.waitingForPriorTurn = false;
      run.sessionId = proof.sessionId || run.sessionId || null;
      run.targetLifecycleGeneration = proof.lifecycleGeneration
        || run.targetLifecycleGeneration
        || null;
      run.recoveryAttempt = (run.recoveryAttempt || 0) + 1;
      run.recoveryReopenedAt = now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
    } else {
      throw new Error('unsupported recovery action');
    }
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled };
  }

  async cancel(runId, { reason = 'cancelled-by-api', suppressNotification = true } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) {
      return { run: publicRun(run), changed: [], settled: [] };
    }
    const now = Date.now();
    const changed = [];
    const settled = [];
    run.status = 'cancelled';
    run.outcome = 'interrupted';
    run.completedAt = now;
    run.completionReason = reason;
    run.recoveryDeadlineAt = null;
    if (suppressNotification) {
      run.notificationStatus = 'suppressed';
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
    settled.push(publicRun(run));
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled };
  }

  async expireRecoveryDeadlines(now = Date.now()) {
    await this.initialize();
    const changed = [];
    const settled = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'waiting_recovery' || !run.recoveryDeadlineAt || run.recoveryDeadlineAt > now) continue;
      run.status = 'failed';
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      run.notificationStatus = 'pending';
      run.updatedAt = now;
      this._pushChanged(changed, run);
      settled.push(publicRun(run));
      this._refreshAncestors(run.parentRunId, changed, settled, now);
    }
    if (changed.length) this._schedulePersist();
    return { changed, settled, completed: [] };
  }

  async nextRecoveryDeadline() {
    await this.initialize();
    let next = null;
    for (const run of this.runs.values()) {
      if (run.status !== 'waiting_recovery' || !run.recoveryDeadlineAt) continue;
      if (next === null || run.recoveryDeadlineAt < next) next = run.recoveryDeadlineAt;
    }
    return next;
  }

  async get(runId) {
    await this.initialize();
    return publicRun(this.runs.get(runId));
  }

  async getInternal(runId) {
    await this.initialize();
    return this.runs.get(runId) || null;
  }

  async acknowledge(runId, tabId) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    const now = Date.now();
    if (run.sourceTabId === tabId) {
      run.sourceAcknowledgedAt = now;
    }
    if (run.targetTabId === tabId) {
      run.targetAcknowledgedAt = now;
    }
    run.updatedAt = now;
    this._schedulePersist();
    return publicRun(run);
  }

  async dismissAttention(runId, tabId) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return { run: null, changed: [], settled: [], dismissed: false };
    if (run.sourceTabId !== tabId && run.targetTabId !== tabId) {
      return { run: publicRun(run), changed: [], settled: [], dismissed: false };
    }

    const now = Date.now();
    const changed = [];
    const settled = [];
    if (run.sourceTabId === tabId) {
      run.sourceAcknowledgedAt = now;
      run.sourceAttentionDismissedAt = now;
    }
    if (run.targetTabId === tabId) {
      run.targetAcknowledgedAt = now;
      run.targetAttentionDismissedAt = now;
    }

    // Closing a source-side delivery error is an explicit decision not to inject
    // that old completion into the composer. Persist it and release descendants.
    if (run.sourceTabId === tabId && isSourceNotificationBlocked(run)) {
      run.notificationStatus = 'suppressed';
      run.notificationSuppressed = true;
      run.notificationDismissedAt = now;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
    }

    run.updatedAt = now;
    this._pushChanged(changed, run);
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled, dismissed: true };
  }

  async listForTab(tabId, { activeOnly = false } = {}) {
    await this.initialize();
    return Array.from(this.runs.values())
      .filter((run) => run.sourceTabId === tabId || run.targetTabId === tabId)
      .filter((run) => !activeOnly || isTrackedOrchestrationRun(run))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(publicRun);
  }

  async listActive() {
    await this.initialize();
    return Array.from(this.runs.values())
      .filter(isTrackedOrchestrationRun)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map(publicRun);
  }

  async listAll() {
    await this.initialize();
    return Array.from(this.runs.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(publicRun);
  }

  async getSettings() {
    await this.initialize();
    return { ...this.settings };
  }

  async updateSettings(patch = {}) {
    await this.initialize();
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    this.settings = normalizeSettings({ ...this.settings, ...definedPatch });
    this._schedulePersist();
    return { ...this.settings };
  }

  async flush() {
    await this.persistChain;
  }

  _activeForTarget(tabId) {
    return Array.from(this.runs.values())
      .filter((run) => run.targetTabId === tabId && isActiveStatus(run.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  _headForTarget(tabId) {
    for (const run of this._activeForTarget(tabId)) {
      if (!run.predecessorRunId) return run;
      const predecessor = this.runs.get(run.predecessorRunId);
      if (!predecessor || isTerminalStatus(predecessor.status)) return run;
    }
    return null;
  }

  _inferParentRunId(sourceTabId) {
    if (!sourceTabId) return null;
    return this._headForTarget(sourceTabId)?.runId || null;
  }

  _validateParent(parentRunId, input) {
    const parent = this.runs.get(parentRunId);
    if (!parent) throw new Error('parent run not found');
    if (parent.runId === input.runId) throw new Error('run cannot parent itself');
    if (isTerminalStatus(parent.status)) throw new Error('parent run is already settled');
    if (parent.targetTabId !== input.sourceTabId) {
      throw new Error('parent target must be the child source tab');
    }
    let cursor = parent;
    while (cursor?.parentRunId) {
      if (cursor.parentRunId === input.runId) throw new Error('orchestration run cycle');
      cursor = this.runs.get(cursor.parentRunId);
    }
  }

  _children(parentRunId) {
    return Array.from(this.runs.values())
      .filter((run) => run.parentRunId === parentRunId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  _unresolvedChildren(run) {
    if (run.waitForDescendants === false) return [];
    return this._children(run.runId).filter((child) => {
      if (!isTerminalStatus(child.status)) return true;
      if (child.notificationSuppressed || child.notifySource === false || child.sourceTabId === child.targetTabId) return false;
      return !child.parentConsumedAt;
    });
  }

  _settleSuccessfulRun(run, changed, settled, now) {
    const unresolved = this._unresolvedChildren(run);
    run.waitingOnRunIds = unresolved.map((child) => child.runId);
    if (unresolved.length > 0) {
      run.status = 'waiting_descendants';
      run.completedAt = null;
    } else {
      run.status = 'completed';
      run.completedAt = now;
      settled.push(publicRun(run));
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
  }

  _beginRecovery(run, outcome, reason, changed, settled, now, graceOverride) {
    const graceMs = clampDelay(graceOverride, run.failureGraceMs);
    const manualIgnored = outcome === 'interrupted' && run.reactToManualInterrupt !== true;
    run.status = 'waiting_recovery';
    run.outcome = outcome;
    run.error = String(reason || outcome || 'agent run failed');
    run.ownCompletedAt = now;
    run.completedAt = null;
    run.recoveryDeadlineAt = manualIgnored ? null : now + graceMs;
    run.waitingOnRunIds = [];
    run.updatedAt = now;
    if (!manualIgnored && graceMs === 0) {
      run.status = 'failed';
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      settled.push(publicRun(run));
    }
    this._pushChanged(changed, run);
  }

  _refreshAncestors(parentRunId, changed, settled, now) {
    const visited = new Set();
    let currentId = parentRunId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parent = this.runs.get(currentId);
      if (!parent) break;
      if (parent.outcome === 'success' && !isTerminalStatus(parent.status)) {
        this._settleSuccessfulRun(parent, changed, settled, now);
      }
      currentId = parent.parentRunId;
    }
  }

  _pushChanged(changed, run) {
    if ((run.status === 'failed' || isSourceNotificationBlocked(run)) && !run.attentionRequiredAt) {
      run.attentionRequiredAt = run.updatedAt || Date.now();
    }
    this._syncSourceFollowupState(run);
    const item = publicRun(run);
    const index = changed.findIndex((candidate) => candidate.runId === item.runId);
    if (index === -1) changed.push(item);
    else changed[index] = item;
  }

  _syncSourceFollowupState(run) {
    if (!isTerminalStatus(run?.status)
      || !canNotifySource(run)
      || run.sourceFollowupStartedAt
      || !SOURCE_FOLLOWUP_RECONCILABLE_STATUSES.has(run.notificationStatus)) {
      run.sourceFollowupPending = false;
      return;
    }
    run.sourceFollowupPending = true;
  }

  _pruneInMemory() {
    const now = Date.now();
    const settled = Array.from(this.runs.values())
      .filter((run) => isTerminalStatus(run.status))
      .sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0));
    const keepSettled = new Set(settled
      .filter((run, index) => index < MAX_SETTLED_RUNS && now - (run.completedAt || run.updatedAt || now) <= SETTLED_RETENTION_MS)
      .map((run) => run.runId));
    for (const [runId, run] of this.runs) {
      if (isTerminalStatus(run.status) && !keepSettled.has(runId)) this.runs.delete(runId);
    }
  }

  _backfillCreatedTargetAutoStops() {
    const latestCompletedByTarget = new Map();
    for (const run of this.runs.values()) {
      if (run.status !== 'completed' || run.targetCreatedByOrchestration !== true) continue;
      const previous = latestCompletedByTarget.get(run.targetTabId);
      if (!previous || Number(run.createdAt || 0) > Number(previous.createdAt || 0)) {
        latestCompletedByTarget.set(run.targetTabId, run);
      }
    }

    let changed = false;
    for (const run of latestCompletedByTarget.values()) {
      if (!shouldScheduleCreatedTargetAutoStop(run)) continue;
      run.autoStopAt = Number(run.completedAt || Date.now()) + run.successAutoStopMs;
      run.autoStopStatus = 'scheduled';
      changed = true;
    }
    return changed;
  }

  _schedulePersist() {
    this._pruneInMemory();
    const snapshot = JSON.stringify({
      version: 3,
      settings: this.settings,
      createdTargetTabIds: Array.from(this.createdTargetTabIds),
      runs: Array.from(this.runs.values()),
    }, null, 2);
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = this.filePath + '.tmp-' + process.pid;
        await fs.promises.writeFile(tempPath, snapshot, 'utf8');
        await fs.promises.rename(tempPath, this.filePath);
      })
      .catch((error) => {
        console.warn('[OrchestrationRuns] persist failed:', error?.message || error);
      });
  }
}

module.exports = {
  OrchestrationRunStore,
  DEFAULT_ORCHESTRATION_SETTINGS,
  isActiveStatus,
  isTerminalStatus,
  isCompleteOrchestrationResult,
  shouldScheduleCreatedTargetAutoStop,
  shouldRetryWaitingNotificationForSourceLifecycle,
  shouldMarkSourceFollowupUnconfirmed,
  orchestrationTargetRunIdFromAudit,
  orchestrationCompletionRunIdFromAudit,
  orchestrationInstallBlockers,
  mergeActiveLoadersWithOrchestrations,
  hasNewerTargetRun,
  isAbortedReason,
  outcomeForReason,
};
