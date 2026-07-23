const fs = require('fs');
const path = require('path');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['creating', 'starting', 'sending', 'sent', 'queued', 'running']);
const MAX_SETTLED_RUNS = 200;
const SETTLED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function isAbortedReason(reason) {
  const value = String(reason || '').toLowerCase();
  return value.includes('abort') ||
    value.includes('interrupt') ||
    value.includes('manual-stop') ||
    value.includes('killed') ||
    value.includes('failed') ||
    value.includes('error');
}

function publicRun(run) {
  if (!run) return null;
  const {
    promptHash: _promptHash,
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
        for (const run of Array.isArray(parsed?.runs) ? parsed.runs : []) {
          if (!run?.runId || !run?.targetTabId) continue;
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
    const now = Date.now();
    const run = {
      status: 'creating',
      createdAt: now,
      updatedAt: now,
      notifySource: true,
      notificationStatus: 'pending',
      resultAvailable: false,
      predecessorRunId: predecessor?.runId || null,
      targetBusySeen: false,
      waitingForPriorTurn: false,
      ...input,
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
    // _headForTarget already withholds lifecycle events while a predecessor is
    // active, so counting it again here would consume the new run's own done.
    run.waitingForPriorTurn = !waitingForPredecessor && baselineBusy;
    run.status = (waitingForPredecessor || run.waitingForPriorTurn) ? 'queued' : 'sent';
    run.sessionId = sessionId || run.sessionId || null;
    run.deliveryAcceptedAt = Date.now();
    run.updatedAt = Date.now();
    this._schedulePersist();
    return publicRun(run);
  }

  async applyLifecycle(tabId, payload = {}) {
    await this.initialize();
    const head = this._headForTarget(tabId);
    if (!head) return { changed: [], completed: [] };
    // Agent startup may emit lifecycle events before the orchestration prompt is accepted.
    if (!head.deliveryAcceptedAt) return { changed: [], completed: [] };
    const changed = [];
    const completed = [];
    const sessionId = payload.sessionId || head.sessionId || null;

    if (payload.type === 'busy' && payload.busy === true) {
      if (!head.waitingForPriorTurn) {
        head.targetBusySeen = true;
        head.status = 'running';
        head.startedAt ||= Date.now();
        head.sessionId = sessionId;
        head.updatedAt = Date.now();
        changed.push(publicRun(head));
      }
    } else if (payload.type === 'done') {
      if (head.waitingForPriorTurn) {
        head.waitingForPriorTurn = false;
        head.status = 'queued';
        head.updatedAt = Date.now();
        changed.push(publicRun(head));
      } else if (head.targetBusySeen) {
        const aborted = isAbortedReason(payload.reason);
        head.status = aborted ? 'failed' : 'completed';
        head.completedAt = Date.now();
        head.sessionId = sessionId;
        head.completionReason = payload.reason || 'turn-complete';
        head.error = aborted ? (payload.reason || 'target turn aborted') : null;
        head.updatedAt = Date.now();
        const item = publicRun(head);
        changed.push(item);
        if (!aborted) completed.push(item);
      }
    }

    if (changed.length) this._schedulePersist();
    return { changed, completed };
  }

  async reconcile(runId, observation = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return { changed: null, completed: false };
    let completed = false;
    const resultFound = observation.resultFound === true;
    const busy = observation.busy === true;

    if (resultFound) {
      run.waitingForPriorTurn = false;
      run.targetBusySeen = true;
      run.resultAvailable = observation.resultAvailable !== false;
      run.resultTurnIndex = Number.isInteger(observation.turnIndex) ? observation.turnIndex : run.resultTurnIndex;
      if (busy) {
        run.status = 'running';
        run.startedAt ||= Date.now();
      } else {
        run.status = 'completed';
        run.completedAt ||= Date.now();
        run.completionReason ||= 'recovered-from-transcript';
        completed = true;
      }
    } else if (busy && !run.waitingForPriorTurn) {
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= Date.now();
    }
    if (observation.sessionId) run.sessionId = observation.sessionId;
    run.updatedAt = Date.now();
    this._schedulePersist();
    return { changed: publicRun(run), completed };
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
      .filter((run) => !activeOnly || isActiveStatus(run.status))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(publicRun);
  }

  async listActive() {
    await this.initialize();
    return Array.from(this.runs.values())
      .filter((run) => isActiveStatus(run.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map(publicRun);
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
    const snapshot = JSON.stringify({ version: 1, runs: Array.from(this.runs.values()) }, null, 2);
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
  isActiveStatus,
  isTerminalStatus,
  isAbortedReason,
};
