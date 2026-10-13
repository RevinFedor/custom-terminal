import { isNaturalAgentTurnEndReason } from './agentCompletionOutcome.mjs';
import { hasPendingAgentGoalWork } from '../../shared/agent-work-completion.mjs';

/** One app-wide owner, independent of TabBar instances and UI focus. */
export function createRestartAfterCoordinator(deps) {
  const sources = new Map(), jobs = new Map(), receipts = new Set(), finishes = new Map();
  let serial = 0;
  const log = (action, details) => deps.log?.(action, details);
  const current = job => jobs.get(job.tabId) === job && deps.allowed(job.request);

  function cancel(tabId, reason = 'manual-stop') {
    const job = jobs.get(tabId);
    jobs.delete(tabId); // synchronous, before any IPC/await or command-finished
    if (job) deps.cancel?.(tabId, job.operationId, reason);
    log('cancel', { tabId, reason, operationId: job?.operationId });
  }

  function finish(job, exitCode) {
    if (jobs.get(job.tabId) !== job) return;
    jobs.delete(job.tabId);
    const pending = job.pending;
    log('finished', { tabId: job.tabId, operationId: job.operationId, exitCode, pending: !!pending });
    // A script exit never creates work. A pending *new AI completion* may
    // continue even after a build error; an explicit Stop has already removed
    // this job and its pending intent, independent of the script's exit code.
    if (pending && deps.allowed(pending)) request(pending);
  }

  async function launch(job) {
    try {
      const prepared = await deps.prepare(job.request, () => current(job), job.operationId);
      if (!current(job)) return;
      if (!prepared) { jobs.delete(job.tabId); deps.cancel?.(job.tabId, job.operationId, 'prepare-rejected'); return; }
      job.finite = prepared.finite;
      // A renderer reload can rejoin a finite script already owned by main.
      if (job.request.automatic && prepared.finite && prepared.runningOperationId) {
        job.operationId = prepared.runningOperationId;
        job.phase = 'running'; job.pending = job.request;
        log('rejoined', { tabId: job.tabId, operationId: job.operationId });
        if (finishes.has(job.operationId)) finish(job, finishes.get(job.operationId));
        return;
      }
      job.phase = 'launching';
      const result = await deps.launch(job.request, prepared, job.operationId, () => current(job));
      if (!current(job)) return;
      if (!result?.success) {
        jobs.delete(job.tabId);
        deps.cancel?.(job.tabId, job.operationId, 'launch-rejected');
        log('rejected', { tabId: job.tabId, operationId: job.operationId, reason: result?.reason || 'launch-failed' });
        return;
      }
      job.phase = 'running';
      log('started', { tabId: job.tabId, operationId: job.operationId });
      if (job.earlyFinish !== undefined) finish(job, job.earlyFinish);
      else if (!job.finite && job.pending) request(job.pending);
    } catch (error) {
      if (jobs.get(job.tabId) === job) jobs.delete(job.tabId);
      deps.cancel?.(job.tabId, job.operationId, 'launch-error');
      log('error', { tabId: job.tabId, operationId: job.operationId, error: String(error) });
    }
  }

  function request(input) {
    if (!deps.allowed(input)) return;
    const previous = jobs.get(input.tabId);
    if (previous) {
      if (input.automatic && (previous.finite !== false || previous.phase !== 'running')) {
        previous.pending = input; // last genuine completion, never a FIFO
        log('pending', { tabId: input.tabId, operationId: previous.operationId });
        return;
      }
      cancel(input.tabId, 'superseded');
    }
    const job = { tabId: input.tabId, request: input, operationId: deps.id?.() || 'restart-after-' + ++serial,
      phase: 'preparing', finite: null, pending: null, earlyFinish: undefined };
    jobs.set(input.tabId, job); // admission before the first async lookup
    void launch(job);
  }

  function complete(tabId, identity) {
    const key = tabId + ':' + identity;
    if (receipts.has(key)) return;
    receipts.add(key);
    if (receipts.size > 4096) receipts.delete(receipts.values().next().value);
    for (const target of deps.targets(tabId)) request({ ...target, triggerTabId: tabId, proof: key, automatic: true });
  }

  function busy(data) {
    if (!data?.tabId || data.reason === 'spinner' || data.reason === 'local-command') return;
    const state = sources.get(data.tabId) || { busy: false, cycle: 0, deferred: null, deliveredCycle: -1 };
    sources.set(data.tabId, state);
    if (data.busy) {
      if (!state.busy) state.cycle++;
      state.busy = true; state.deferred = null;
      return;
    }
    const wasBusy = state.busy;
    state.busy = false;
    state.goalPending = hasPendingAgentGoalWork(data);
    if (state.goalPending) { state.deferred = null; return; }
    if (!isNaturalAgentTurnEndReason(data.reason)) { state.deferred = null; return; }
    if (!wasBusy) return;
    const identity = data.outcomeTs ?? data.turnId ?? ('cycle-' + state.cycle);
    if (deps.blocked?.(data.tabId)) { state.deferred = identity; return; }
    state.deliveredCycle = state.cycle;
    state.directCompletedAt = Number(data.outcomeTs) || Date.now();
    complete(data.tabId, identity);
  }

  function orchestration(change) {
    if (!change.releaseKind) return;
    const state = sources.get(change.sourceTabId);
    if (change.releaseKind !== 'success') { if (state) state.deferred = null; return; }
    if (state?.busy || state?.goalPending || deps.blocked?.(change.sourceTabId)) return;
    const runId = change.run?.runId;
    if (!runId) return;
    const runIdentity = 'run-' + runId;
    if (receipts.has(change.sourceTabId + ':' + runIdentity)) return;
    // A late release of an already covered run is not another completion;
    // a newly created background run after that result is a genuine event.
    if (state?.deferred === null && Number.isFinite(change.run.createdAt)
      && state.directCompletedAt >= change.run.createdAt) return;
    const identity = state?.deferred ?? runIdentity;
    if (state) { state.deferred = null; state.deliveredCycle = state.cycle; }
    complete(change.sourceTabId, identity);
    receipts.add(change.sourceTabId + ':' + runIdentity);
  }

  return {
    busy, orchestration, request, cancel,
    seedBusy(tabId) { if (!sources.has(tabId)) sources.set(tabId, { busy: true, cycle: 1, deferred: null, deliveredCycle: -1 }); },
    cancelAll(reason) { for (const tabId of jobs.keys()) cancel(tabId, reason); },
    started(data) {
      const job = jobs.get(data.tabId);
      if (job?.phase === 'running' && data.commandOperationId !== job.operationId) cancel(data.tabId, 'command-replaced');
    },
    finished(data) {
      if (data.commandOperationId) {
        finishes.set(data.commandOperationId, data.exitCode);
        if (finishes.size > 4096) finishes.delete(finishes.keys().next().value);
      }
      const job = jobs.get(data.tabId);
      if (!job || !data.commandOperationId || data.commandOperationId !== job.operationId) return;
      if (job.phase === 'launching') job.earlyFinish = data.exitCode;
      else if (job.phase === 'running') finish(job, data.exitCode);
    },
    reconcile() { for (const job of jobs.values()) if (!deps.allowed(job.request)) cancel(job.tabId, 'configuration-changed'); },
    snapshot: () => [...jobs.values()].map(job => ({ tabId: job.tabId, phase: job.phase, operationId: job.operationId, pending: !!job.pending })),
  };
}
