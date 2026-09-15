'use strict';

// Single owner of Claude startup settings (`/model` then `/effort`).
//
// The prod scar this replaces: two independent renderer handlers
// (`claude:process-started` / Bridge:Fresh fallback and `claude:tui-ready`)
// each decided on their own whether to send startup slash commands, guarding
// on module-level sentinels the OTHER handler set asynchronously. That is a
// TOCTOU window equal to the gap between the two events, and in production it
// split one startup across two owners: `/model` went out from the bridge path
// while `/effort` went out from the tui-ready path (tab-2055, 2026-07-25).
// The split itself then produced a paste collision on one PTY — `/effort` was
// pasted while Claude still rendered `/model` stdout, was swallowed by the TUI,
// and the missing proof surfaced as a hard failure.
//
// The model here is deliberately different: a transaction is OPENED once per
// launch generation and both readiness signals are merely INPUTS to it. Whoever
// arrives first opens it; every later arrival joins the same transaction. The
// commands are strictly sequential — the second is not sent until the first is
// proven — so two startup pastes can never overlap on the same PTY.
//
// This module is pure orchestration: no Electron, no fs, no IPC. The host
// injects `sendCommand`, `proveCommand`, `now`, `log`. That keeps the whole
// event-ordering matrix unit-testable, which is exactly what the sentinel
// design could not offer (the bug lived in the glue, so the glue is now a
// module with an explicit contract).

const PHASE = {
  IDLE: 'idle',
  MODEL: 'model',
  EFFORT: 'effort',
  DONE: 'done',
  FAILED: 'failed',
};

// Proof outcomes. `unresolved` is NOT a failure: it means the prover could not
// answer (transcript unreadable, scan error, file truncated under it). Treating
// it as failure was how a transient read error turned into "startup failed";
// treating it as success would silently skip settings. It is its own state and
// it is the one case that must never be auto-retried — re-sending a command
// whose delivery is unknown risks applying the setting twice.
const PROOF = {
  FOUND: 'found',
  ABSENT: 'absent',
  UNRESOLVED: 'unresolved',
};

function normalizeProof(raw) {
  if (raw === true) return { outcome: PROOF.FOUND };
  if (raw === false) return { outcome: PROOF.ABSENT };
  if (!raw || typeof raw !== 'object') return { outcome: PROOF.UNRESOLVED, reason: 'no-result' };
  const outcome = raw.outcome === PROOF.FOUND || raw.outcome === PROOF.ABSENT || raw.outcome === PROOF.UNRESOLVED
    ? raw.outcome
    : (raw.success === true ? PROOF.FOUND : PROOF.UNRESOLVED);
  return { ...raw, outcome };
}

function describeStep(step) {
  return step && step.command ? step.command : '(unknown command)';
}

class ClaudeStartupTransaction {
  constructor({ tabId, generation, attemptId = null, steps, resolveSteps, deps }) {
    this.tabId = tabId;
    this.generation = generation;
    this.attemptId = attemptId;
    this.steps = Array.isArray(steps) ? steps : [];
    this.resolveSteps = typeof resolveSteps === 'function' ? resolveSteps : null;
    this.deps = deps;
    this.phase = PHASE.IDLE;
    this.openedBy = null;
    this.openedAt = deps.now();
    this.joinCount = 0;
    this.retryUsed = false;
    this.result = null;
    this.promise = null;
    this.executionRevision = 0;
    this.resultRevision = 0;
    this.stepStates = [];
    this.stepsResolved = !this.resolveSteps;
    this.stepsResolution = new Promise((resolve) => { this.finishStepsResolution = resolve; });
    if (this.stepsResolved) this.initializeSteps();
  }

  log(message) {
    if (this.deps.log) this.deps.log(message);
  }

  // One structured line per phase change. Without it "exactly one owner" is
  // only provable indirectly (by reading `source=` on every send), which is how
  // the original split stayed invisible for so long.
  trace(event, detail = '') {
    this.log('[StartupTx] ' + event
      + ' tab=' + String(this.tabId).slice(-12)
      + ' gen=' + this.generation
      + ' owner=' + (this.openedBy || '-')
      + ' phase=' + this.phase
      + (detail ? ' ' + detail : ''));
  }

  initializeSteps() {
    this.stepStates = this.steps.map(step => ({
      ...step,
      kind: step.phase,
      status: 'unattempted',
      startupStep: true,
    }));
    this.stepsResolved = true;
    this.finishStepsResolution();
  }

  isObsolete(revision) {
    return revision !== this.executionRevision || this.deps.isCancelled?.(this.generation);
  }

  setResult(result) {
    this.result = {
      ...result,
      generation: this.generation,
      attemptId: this.attemptId,
      resultRevision: ++this.resultRevision,
    };
    return this.result;
  }

  async runStep(step, executionRevision) {
    this.phase = step.phase;
    this.trace('step-start', 'command="' + describeStep(step) + '"');
    const sentIdentity = Object.freeze({
      command: step.command,
      source: step.source,
      label: step.label,
      explicitRetry: step.explicitRetry === true,
      retryClaimFence: step.retryClaimFence,
      retryFailedClaimId: step.retryFailedClaimId,
      retryFailedClaimOrder: step.retryFailedClaimOrder,
    });

    const startedAt = this.deps.now();
    const send = await this.deps.sendCommand({
      tabId: this.tabId,
      generation: this.generation,
      ...sentIdentity,
      attemptId: this.attemptId,
      executionRevision,
      onWaitingForManual: () => { if (!this.isObsolete(executionRevision)) step.status = 'unattempted'; },
      onSendAdmitted: () => { if (!this.isObsolete(executionRevision)) step.status = 'pending'; },
    });
    if (this.isObsolete(executionRevision)) {
      if (sentIdentity.explicitRetry && send?.success === true && send?.submitted !== false) {
        void Promise.resolve(this.deps.proveCommand({
          tabId: this.tabId,
          generation: this.generation,
          command: sentIdentity.command,
          afterMs: startedAt,
          label: sentIdentity.label + ':superseded-observer',
          attempt: 1,
          sendResult: send,
          explicitRetry: true,
          retryClaimFence: sentIdentity.retryClaimFence,
          retryFailedClaimId: sentIdentity.retryFailedClaimId,
          retryFailedClaimOrder: sentIdentity.retryFailedClaimOrder,
          attemptId: this.attemptId,
          executionRevision,
          observationOnly: true,
        })).catch(error => this.log('[StartupTx] superseded-retry-proof-error error=' + String(error?.message || error)));
      }
      return { ok: false, error: 'superseded-settings-attempt', step };
    }
    if (!send || send.success !== true) {
      const error = (send && (send.error || send.reason)) || 'send-failed';
      this.trace('step-send-failed', 'error=' + error);
      return { ok: false, error, step, sendFailed: true, send };
    }
    if (send.skipped === true) {
      this.trace('step-skipped', 'command="' + describeStep(step)
        + '" reason=' + (send.reason || 'host-skip'));
      return { ok: true, step, skipped: true };
    }

    let proof = normalizeProof(await this.deps.proveCommand({
      tabId: this.tabId,
      generation: this.generation,
      command: sentIdentity.command,
      // Per-command epoch. The old code captured `afterMs` for `/effort` before
      // `/model` had even started pasting, so both proof windows overlapped and
      // only the per-command matcher kept them apart.
      afterMs: startedAt,
      label: sentIdentity.label,
      attempt: 1,
      sendResult: send,
      explicitRetry: sentIdentity.explicitRetry,
      retryClaimFence: sentIdentity.retryClaimFence,
      retryFailedClaimId: sentIdentity.retryFailedClaimId,
      retryFailedClaimOrder: sentIdentity.retryFailedClaimOrder,
      attemptId: this.attemptId,
      executionRevision,
    }));
    if (this.isObsolete(executionRevision)) return { ok: false, error: 'superseded-settings-attempt', step };
    this.trace('step-proof', 'outcome=' + proof.outcome + (proof.reason ? ' reason=' + proof.reason : ''));

    if (proof.outcome === PROOF.ABSENT && !this.retryUsed) {
      // Automatic retry is allowed for exactly one case: the command provably
      // was not submitted. The prover requires both facts: the send path
      // explicitly reports that Enter was not written, plus either (a) the
      // current composer still contains the exact command, or (b) the command
      // disappeared before Enter and an exact Ctrl+G read proved an empty
      // composer across the same terminal/run/lifecycle generation. A missing
      // JSONL row, an unowned empty/unknown composer, or an uncertain Enter is
      // unresolved because the command may already have applied.
      this.retryUsed = true;
      this.deps.log('[StartupRetry] decision=absent action=auto-retry'
        + ' tab=' + String(this.tabId).slice(-12)
        + ' gen=' + this.generation
        + ' command="' + describeStep(step) + '"');
      const retryStartedAt = this.deps.now();
      const retrySend = await this.deps.sendCommand({
        tabId: this.tabId,
        generation: this.generation,
        command: sentIdentity.command,
        source: sentIdentity.source + ':retry',
        label: sentIdentity.label + ':retry',
        retry: true,
        recovery: proof.recovery || null,
        attemptId: this.attemptId,
        executionRevision,
        explicitRetry: sentIdentity.explicitRetry,
        retryClaimFence: sentIdentity.retryClaimFence,
        retryFailedClaimId: sentIdentity.retryFailedClaimId,
        retryFailedClaimOrder: sentIdentity.retryFailedClaimOrder,
      });
      if (this.isObsolete(executionRevision)) return { ok: false, error: 'superseded-settings-attempt', step };
      if (!retrySend || retrySend.success !== true) {
        const error = (retrySend && (retrySend.error || retrySend.reason)) || 'retry-send-failed';
        this.trace('step-retry-send-failed', 'error=' + error);
        return { ok: false, error, step, sendFailed: true };
      }
      proof = normalizeProof(await this.deps.proveCommand({
        tabId: this.tabId,
        generation: this.generation,
        command: sentIdentity.command,
        afterMs: retryStartedAt,
        label: sentIdentity.label + ':retry',
        attempt: 2,
        sendResult: retrySend,
        explicitRetry: sentIdentity.explicitRetry,
        retryClaimFence: sentIdentity.retryClaimFence,
        retryFailedClaimId: sentIdentity.retryFailedClaimId,
        retryFailedClaimOrder: sentIdentity.retryFailedClaimOrder,
        attemptId: this.attemptId,
        executionRevision,
      }));
      if (this.isObsolete(executionRevision)) return { ok: false, error: 'superseded-settings-attempt', step };
      this.trace('step-retry-proof', 'outcome=' + proof.outcome);
    } else if (proof.outcome === PROOF.UNRESOLVED) {
      // Delivery unknown: never auto-retry, hand the decision to the user.
      this.deps.log('[StartupRetry] decision=unresolved action=await-user'
        + ' tab=' + String(this.tabId).slice(-12)
        + ' gen=' + this.generation
        + ' command="' + describeStep(step) + '"'
        + ' reason=' + (proof.reason || 'unknown'));
    } else if (proof.outcome === PROOF.ABSENT) {
      this.deps.log('[StartupRetry] decision=absent action=await-user'
        + ' tab=' + String(this.tabId).slice(-12)
        + ' gen=' + this.generation
        + ' command="' + describeStep(step) + '"'
        + ' reason=retry-already-used');
    }

    if (proof.outcome === PROOF.FOUND && proof.requestSatisfied !== false) return { ok: true, step, proof };
    const explicitCommandError = proof.terminal === true
      ? String(proof.outputText || proof.outputPreview || proof.error || proof.reason || '').trim()
      : '';
    return {
      ok: false,
      step,
      proof,
      error: explicitCommandError || (proof.requestSatisfied === false
        ? step.command + ' applied a different setting'
        : step.command + ' was not confirmed (' + proof.outcome
        + (proof.reason ? '/' + proof.reason : '') + ')'),
      errorCode: proof.failureCode
        || (proof.requestSatisfied === false ? 'claude_setting_value_mismatch' : null)
        || (proof.terminal === true ? 'claude_startup_setting_rejected' : null),
      retryable: proof.outcome === PROOF.ABSENT,
    };
  }

  async run() {
    const executionRevision = this.executionRevision;
    const settingsOperation = this.deps.currentSettingsOperation?.();
    const operationChanged = () => this.deps.currentSettingsOperation?.() !== settingsOperation;
    const supersededResult = () => ({ status: 'cancelled', generation: this.generation, attemptId: this.attemptId });
    if (!this.stepsResolved) {
      this.trace('steps-resolve-start');
      try {
        this.steps = await this.resolveSteps({
          tabId: this.tabId,
          generation: this.generation,
          openedBy: this.openedBy,
        });
        if (!Array.isArray(this.steps)) this.steps = [];
        this.initializeSteps();
      } catch (error) {
        this.finishStepsResolution();
        throw error;
      }
      this.trace('steps-resolve-done', 'steps=' + this.steps.length);
    }
    if (this.isObsolete(executionRevision)) {
      if (executionRevision !== this.executionRevision) return { status: 'cancelled', generation: this.generation, attemptId: this.attemptId };
      this.phase = PHASE.FAILED;
      this.result = { status: 'cancelled', generation: this.generation, attemptId: this.attemptId };
      return this.result;
    }
    for (const step of this.stepStates) {
      if (step.status !== 'unattempted') continue;
      if (this.isObsolete(executionRevision)) {
        if (executionRevision !== this.executionRevision) return { status: 'cancelled', generation: this.generation, attemptId: this.attemptId };
        this.phase = PHASE.FAILED;
        this.result = { status: 'cancelled', generation: this.generation };
        this.trace('cancelled');
        return this.result;
      }
      step.status = 'pending';
      const outcome = await this.runStep(step, executionRevision);
      if (this.isObsolete(executionRevision)) {
        if (executionRevision !== this.executionRevision) return { status: 'cancelled', generation: this.generation, attemptId: this.attemptId };
        this.phase = PHASE.FAILED;
        this.result = { status: 'cancelled', generation: this.generation, attemptId: this.attemptId };
        return this.result;
      }
      if (!outcome.ok) {
        step.status = outcome.proof?.requestSatisfied === false ? 'applied-different'
          : (outcome.proof?.terminal === true || (outcome.sendFailed && outcome.send?.submitted !== null)
            ? 'rejected' : 'unknown');
        step.error = outcome.error;
        step.errorCode = outcome.errorCode || null;
        step.proof = outcome.proof || null;
        step.claimId = outcome.proof?.claimId || step.claimId || step.retryFailedClaimId || null;
        step.claimOrder = outcome.proof?.claimOrder || step.claimOrder
          || step.retryFailedClaimOrder || step.retryClaimFence || null;
        if (operationChanged()) return supersededResult();
        this.phase = PHASE.FAILED;
        this.setResult({
          status: 'failed',
          generation: this.generation,
          // The card must name the command that failed instead of the generic
          // "terminal input did not become ready", which contradicted the
          // actual cause in the incident.
          failedCommand: step.command,
          proofOutcome: outcome.proof ? outcome.proof.outcome : null,
          error: outcome.error,
          errorCode: outcome.errorCode || null,
          // `absent` after the single retry is still user-retryable; an
          // unresolved proof is too (the user decides), but neither is retried
          // automatically again.
          userRetryable: true,
        });
        this.trace('failed', 'command="' + describeStep(step) + '" error=' + outcome.error);
        return this.result;
      }
      step.status = 'applied';
      step.proof = outcome.proof || null;
      if (operationChanged()) return supersededResult();
    }
    if (operationChanged()) return supersededResult();
    this.phase = PHASE.DONE;
    this.setResult({ status: 'ready' });
    this.trace('ready');
    return this.result;
  }
}

// Registry: one live transaction per tab. A new launch generation supersedes
// the previous one; a stale proof or readiness event from an older generation
// can no longer close (or fail) the current transaction. That is the structural
// answer to "attempt-meta covered a different transaction than the one running".
function createClaudeStartupCoordinator(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const byTab = new Map();
  let attemptSequence = 0;

  function currentGeneration(tabId) {
    const entry = byTab.get(tabId);
    return entry ? entry.transaction.generation : null;
  }

  function isCancelled(tabId, generation) {
    const entry = byTab.get(tabId);
    if (!entry) return true;
    return entry.transaction.generation !== generation;
  }

  // `trigger` is the readiness signal that arrived ('tui-ready' |
  // 'process-started' | 'manual'). It is recorded for diagnostics but it does
  // NOT decide ownership — the generation does.
  function ensureTransaction({
    tabId,
    generation,
    attemptId = null,
    trigger,
    steps,
    resolveSteps,
    sendCommand,
    proveCommand,
    currentSettingsOperation,
  }) {
    if (!tabId || !generation) {
      return { started: false, reason: 'missing-identity' };
    }
    const existing = byTab.get(tabId);
    if (existing) {
      if (existing.transaction.generation === generation) {
        existing.transaction.joinCount += 1;
        existing.transaction.trace('join', 'trigger=' + trigger
          + ' joins=' + existing.transaction.joinCount);
        return { started: false, joined: true, promise: existing.promise, transaction: existing.transaction };
      }
      // Newer launch wins. The older transaction keeps running to completion in
      // its own promise but can no longer publish: its generation is stale.
      existing.transaction.trace('superseded', 'byGeneration=' + generation);
    }

    const transaction = new ClaudeStartupTransaction({
      tabId,
      generation,
      attemptId: attemptId || generation + ':settings:' + (++attemptSequence),
      steps,
      resolveSteps,
      deps: {
        now,
        log,
        sendCommand,
        proveCommand,
        currentSettingsOperation,
        isCancelled: (gen) => isCancelled(tabId, gen) || byTab.get(tabId)?.transaction !== transaction,
      },
    });
    transaction.openedBy = trigger;
    transaction.trace(
      'open',
      'trigger=' + trigger + ' steps=' + (Array.isArray(steps) ? steps.length : 'deferred'),
    );

    // Register BEFORE running: `run()` executes synchronously up to its first
    // await and immediately asks `isCancelled(generation)`, which resolves
    // through this map. Starting the run first made every transaction cancel
    // itself on its own opening tick.
    const entry = { transaction, promise: null, settled: false };
    byTab.set(tabId, entry);
    const executionRevision = transaction.executionRevision;
    const promise = transaction.run().finally(() => {
      const current = byTab.get(tabId);
      if (current && current.transaction === transaction && transaction.executionRevision === executionRevision) {
        current.settled = true;
      }
    });
    transaction.promise = promise;
    entry.promise = promise;
    return { started: true, promise, transaction };
  }

  function clear(tabId, reason = 'clear') {
    const entry = byTab.get(tabId);
    if (!entry) return false;
    entry.transaction.trace('clear', 'reason=' + reason);
    byTab.delete(tabId);
    return true;
  }

  // Reduce the complete manual operation into this transaction. This is not a
  // retry: attempted/rejected/unknown steps remain barriers, and a late read has
  // no authority to write. Only a fully successful explicit replacement may
  // resume original startup steps that have never reached send admission.
  async function reconcileSettingsOutcome({
    tabId, generation, attemptId, steps = [], status, failedCommand,
    error, errorCode, settingsOperationId, settingsOperationOrder,
    allowUnattemptedContinuation = false, isApplicable = () => true,
  } = {}) {
    const entry = byTab.get(tabId);
    const tx = entry?.transaction;
    const applicable = () => tx && byTab.get(tabId) === entry
      && tx.generation === generation && tx.attemptId === attemptId && isApplicable();
    if (!applicable()) return { reconciled: false, reason: 'stale-settings-attempt' };
    await tx.stepsResolution;
    if (!applicable()) return { reconciled: false, reason: 'stale-settings-attempt' };
    if (!tx.stepsResolved) return { reconciled: false, reason: 'settings-resolution-failed' };
    if (tx.result?.status === 'ready') return { reconciled: false, reason: 'startup-already-ready' };

    // Invalidate callbacks from the previous run of this *same* attempt before
    // changing the result. Generation/attempt alone cannot distinguish them.
    tx.executionRevision += 1;
    for (const step of tx.stepStates) {
      if (step.status === 'pending') step.status = 'unknown';
    }
    for (const outcome of steps) {
      const kind = outcome.kind || String(outcome.command || '').match(/^\/(model|effort)\s/)?.[1];
      if (!['model', 'effort'].includes(kind)) continue;
      if (!['applied', 'applied-different', 'rejected', 'unknown', 'unattempted'].includes(outcome.status)) continue;
      let step = tx.stepStates.find(item => item.kind === kind);
      if (!step) {
        step = { kind, phase: kind, command: outcome.command, startupStep: false, status: 'unattempted' };
        tx.stepStates.push(step);
      }
      // An unsent suffix cannot erase a rejection or an uncertain earlier send.
      if (outcome.status === 'unattempted' && step.status !== 'unattempted') continue;
      const startupStep = step.startupStep;
      Object.assign(step, { error: null, errorCode: null, proof: null }, outcome, {
        kind, phase: kind, startupStep,
        error: outcome.error || (outcome.command === failedCommand ? error : null) || null,
        errorCode: outcome.errorCode || (outcome.command === failedCommand ? errorCode : null) || null,
      });
    }

    const isBarrier = step => ['rejected', 'unknown', 'applied-different'].includes(step.status);
    const failure = tx.stepStates.find(step => step.command === failedCommand && isBarrier(step))
      || tx.stepStates.find(isBarrier);
    const unattempted = tx.stepStates.filter(step => step.status === 'unattempted');
    const fullExplicitSuccess = status === 'applied' && steps.length > 0
      && steps.every(step => step.status === 'applied');
    const canContinue = !failure && fullExplicitSuccess && allowUnattemptedContinuation === true
      && unattempted.length > 0 && unattempted.every(step => step.startupStep === true);
    const revision = tx.executionRevision;
    const operation = { settingsOperationId, settingsOperationOrder };
    if (canContinue) {
      tx.phase = PHASE.IDLE;
      tx.result = null;
      entry.settled = false;
      const promise = tx.run().then(result => {
        if (byTab.get(tabId) === entry && tx.executionRevision === revision) entry.settled = true;
        return result;
      });
      tx.promise = promise;
      entry.promise = promise;
      tx.trace('manual-outcome-continue', 'operation=' + settingsOperationId);
      return { reconciled: true, started: true, promise, executionRevision: revision, ...operation };
    }
    const residual = failure || unattempted[0];
    tx.phase = residual ? PHASE.FAILED : PHASE.DONE;
    const result = tx.setResult(residual ? {
      status: 'failed',
      failedCommand: residual.command || failedCommand || null,
      proofOutcome: residual.proof?.outcome || PROOF.UNRESOLVED,
      error: residual.error || (residual.command === failedCommand ? error : null)
        || (residual.status === 'unattempted'
          ? residual.command + ' was not attempted; explicit settings action required'
          : residual.command + ' was not confirmed (' + residual.status + ')'),
      errorCode: residual.errorCode || (residual.command === failedCommand ? errorCode : null)
        || (residual.status === 'unattempted' ? 'claude_startup_setting_unattempted' : null),
      userRetryable: true,
      ...operation,
    } : { status: 'ready', ...operation });
    entry.settled = true;
    entry.promise = Promise.resolve(result);
    tx.promise = entry.promise;
    tx.trace('manual-outcome-reconciled', 'operation=' + settingsOperationId + ' status=' + result.status);
    return { reconciled: true, started: false, result, promise: entry.promise, executionRevision: revision, ...operation };
  }

  function snapshot(tabId) {
    const entry = byTab.get(tabId);
    if (!entry) return null;
    const tx = entry.transaction;
    return {
      tabId,
      generation: tx.generation,
      attemptId: tx.attemptId,
      phase: tx.phase,
      openedBy: tx.openedBy,
      openedAt: tx.openedAt,
      joinCount: tx.joinCount,
      retryUsed: tx.retryUsed,
      executionRevision: tx.executionRevision,
      resultRevision: tx.resultRevision,
      steps: tx.stepStates.map(step => ({ ...step })),
      settled: entry.settled,
      result: tx.result,
    };
  }

  return {
    ensureTransaction,
    reconcileSettingsOutcome,
    currentGeneration,
    clear,
    snapshot,
    PHASE,
    PROOF,
  };
}

module.exports = {
  createClaudeStartupCoordinator,
  normalizeProof,
  PHASE,
  PROOF,
};
