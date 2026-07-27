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
const SOURCE_FOLLOWUP_PROBLEM_STATUSES = new Set(['waiting-for-input', 'failed']);
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

function isTrackedOrchestrationRun(run) {
  return isActiveStatus(run?.status)
    || isSourceFollowupPending(run)
    || isSourceNotificationBlocked(run);
}

function isCompleteOrchestrationResult(result) {
  return result?.found === true && result?.resultComplete === true;
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
        for (const stored of Array.isArray(parsed?.runs) ? parsed.runs : []) {
          if (!stored?.runId || !stored?.targetTabId) continue;
          const run = {
            waitForDescendants: stored.waitForDescendants !== false,
            failureGraceMs: clampDelay(stored.failureGraceMs, this.settings.failureGraceMs),
            successAutoStopMs: clampDelay(stored.successAutoStopMs, this.settings.successAutoStopMs),
            reactToManualInterrupt: stored.reactToManualInterrupt === true,
            autoStopCreatedTargets: stored.autoStopCreatedTargets !== false,
            ...stored,
          };
          this.runs.set(run.runId, run);
        }
        this._pruneInMemory();
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
    const now = Date.now();
    const run = {
      ...input,
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
      sourceFollowupPending: false,
      sourceFollowupStartedAt: null,
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

  async markDelivery(runId, { baselineBusy = false, sessionId = null } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return publicRun(run);
    const predecessor = run.predecessorRunId ? this.runs.get(run.predecessorRunId) : null;
    const waitingForPredecessor = Boolean(predecessor && !isTerminalStatus(predecessor.status));
    run.waitingForPriorTurn = !waitingForPredecessor && baselineBusy;
    run.status = (waitingForPredecessor || run.waitingForPriorTurn) ? 'queued' : 'sent';
    run.sessionId = sessionId || run.sessionId || null;
    run.deliveryAcceptedAt = Date.now();
    run.updatedAt = Date.now();
    this._schedulePersist();
    return publicRun(run);
  }

  async markNotification(runId, status, patch = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    run.notificationStatus = status;
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
    const changed = [publicRun(run)];
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
      const sessionId = payload.sessionId || head.sessionId || null;
      if (payload.type === 'busy' && payload.busy === true) {
        if (!head.waitingForPriorTurn) {
          if (head.status === 'waiting_descendants' || head.status === 'waiting_recovery' || head.outcome) {
            const continuationAfterAt = head.ownCompletedAt || now;
            const consumedChild = this._consumeTerminalChildren(head, changed, now);
            if (!consumedChild?.notificationPromptHash) {
              head.resultPromptHash = null;
              head.resultAfterAt = continuationAfterAt;
              head.resultPromptRequestedAt = continuationAfterAt;
            }
            head.outcome = null;
            head.ownCompletedAt = null;
            head.completedAt = null;
            head.completionReason = null;
            head.error = null;
            head.recoveryDeadlineAt = null;
            head.waitingOnRunIds = [];
            head.recoveryAttempt = (head.recoveryAttempt || 0) + 1;
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

    // A terminal run still owns visible/completion activity while its result is
    // being delivered back to the source. Release that handoff only when the
    // source actually starts the follow-up turn; this bridges child completion,
    // queue insertion and the authoritative runtime busy edge without a timer.
    if (payload.type === 'busy' && payload.busy === true) {
      this._consumeSourceFollowup(tabId, changed, now);
    }

    if (changed.length) this._schedulePersist();
    return {
      changed,
      settled,
      completed: settled.filter((run) => run.status === 'completed'),
    };
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
    } else if (busy && !run.waitingForPriorTurn) {
      if (run.status === 'waiting_recovery' || run.status === 'waiting_descendants') {
        const continuationAfterAt = run.ownCompletedAt || now;
        const consumedChild = this._consumeTerminalChildren(run, changed, now);
        if (!consumedChild?.notificationPromptHash) {
          run.resultPromptHash = null;
          run.resultAfterAt = continuationAfterAt;
          run.resultPromptRequestedAt = continuationAfterAt;
        }
        run.outcome = null;
        run.ownCompletedAt = null;
        run.recoveryDeadlineAt = null;
        run.error = null;
      }
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= now;
      this._pushChanged(changed, run);
    }
    if (observation.sessionId) run.sessionId = observation.sessionId;
    run.updatedAt = now;
    this._schedulePersist();
    return {
      changed: publicRun(run),
      completed: settled.some((item) => item.runId === run.runId && item.status === 'completed'),
      settled,
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
      if (['sent', 'queued', 'suppressed', 'source-closed'].includes(run.notificationStatus)) continue;
      run.notificationStatus = 'source-closed';
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
    }
    if (changed.length) this._schedulePersist();
    return changed;
  }

  async resolveRecovery(runId, action) {
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
      run.status = 'queued';
      run.outcome = null;
      run.ownCompletedAt = null;
      run.completedAt = null;
      run.recoveryDeadlineAt = null;
      run.error = null;
      run.targetBusySeen = false;
      run.waitingForPriorTurn = false;
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
    if (run.sourceTabId === tabId) run.sourceAcknowledgedAt = now;
    if (run.targetTabId === tabId) run.targetAcknowledgedAt = now;
    run.updatedAt = now;
    this._schedulePersist();
    return publicRun(run);
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

  _consumeTerminalChildren(parent, changed, now) {
    const child = this._children(parent.runId)
      .filter((candidate) => (
        isTerminalStatus(candidate.status)
        && !candidate.parentConsumedAt
        && ['sending', 'sent', 'queued'].includes(candidate.notificationStatus)
      ))
      .sort((a, b) => (
        (a.notificationAttemptedAt || a.notificationDeliveredAt || a.updatedAt || 0)
        - (b.notificationAttemptedAt || b.notificationDeliveredAt || b.updatedAt || 0)
      ))[0];
    if (!child) return null;
    child.parentConsumedAt = now;
    child.parentFollowupPending = false;
    child.updatedAt = now;
    this._pushChanged(changed, child);
    if (child.notificationPromptHash) {
      parent.resultPromptHash = child.notificationPromptHash;
      parent.resultAfterAt = null;
      parent.resultPromptRequestedAt = child.notificationAttemptedAt
        || child.notificationDeliveredAt
        || now;
    }
    return child;
  }

  _consumeSourceFollowup(sourceTabId, changed, now) {
    const run = Array.from(this.runs.values())
      .filter((candidate) => (
        candidate.sourceTabId === sourceTabId
        && isSourceFollowupPending(candidate)
        && ['sending', 'sent', 'queued'].includes(candidate.notificationStatus)
      ))
      .sort((a, b) => (
        (a.notificationAttemptedAt || a.notificationDeliveredAt || a.updatedAt || 0)
        - (b.notificationAttemptedAt || b.notificationDeliveredAt || b.updatedAt || 0)
      ))[0];
    if (!run) return null;
    run.sourceFollowupPending = false;
    run.sourceFollowupStartedAt = now;
    run.updatedAt = now;
    this._pushChanged(changed, run);
    return run;
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
      || !SOURCE_FOLLOWUP_DELIVERY_STATUSES.has(run.notificationStatus)) {
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

  _schedulePersist() {
    this._pruneInMemory();
    const snapshot = JSON.stringify({
      version: 2,
      settings: this.settings,
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
  hasNewerTargetRun,
  isAbortedReason,
  outcomeForReason,
};
