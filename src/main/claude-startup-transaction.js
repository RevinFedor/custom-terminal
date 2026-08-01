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
  constructor({ tabId, generation, steps, resolveSteps, deps }) {
    this.tabId = tabId;
    this.generation = generation;
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

  async runStep(step) {
    this.phase = step.phase;
    this.trace('step-start', 'command="' + describeStep(step) + '"');

    const startedAt = this.deps.now();
    const send = await this.deps.sendCommand({
      tabId: this.tabId,
      generation: this.generation,
      command: step.command,
      source: step.source,
      label: step.label,
    });
    if (!send || send.success !== true) {
      const error = (send && (send.error || send.reason)) || 'send-failed';
      this.trace('step-send-failed', 'error=' + error);
      return { ok: false, error, step, sendFailed: true };
    }
    if (send.skipped === true) {
      this.trace('step-skipped', 'command="' + describeStep(step)
        + '" reason=' + (send.reason || 'host-skip'));
      return { ok: true, step, skipped: true };
    }

    let proof = normalizeProof(await this.deps.proveCommand({
      tabId: this.tabId,
      generation: this.generation,
      command: step.command,
      // Per-command epoch. The old code captured `afterMs` for `/effort` before
      // `/model` had even started pasting, so both proof windows overlapped and
      // only the per-command matcher kept them apart.
      afterMs: startedAt,
      label: step.label,
      attempt: 1,
      sendResult: send,
    }));
    this.trace('step-proof', 'outcome=' + proof.outcome + (proof.reason ? ' reason=' + proof.reason : ''));

    if (proof.outcome === PROOF.ABSENT && !this.retryUsed) {
      // Automatic retry is allowed for exactly one case: the command provably
      // was not submitted. The prover requires both facts: the send path
      // explicitly reports that Enter was not written, and the current
      // composer still contains the exact command. A missing JSONL row,
      // an empty/unknown composer, or an uncertain Enter is unresolved because
      // the command may already have applied.
      this.retryUsed = true;
      this.deps.log('[StartupRetry] decision=absent action=auto-retry'
        + ' tab=' + String(this.tabId).slice(-12)
        + ' gen=' + this.generation
        + ' command="' + describeStep(step) + '"');
      const retryStartedAt = this.deps.now();
      const retrySend = await this.deps.sendCommand({
        tabId: this.tabId,
        generation: this.generation,
        command: step.command,
        source: step.source + ':retry',
        label: step.label + ':retry',
        retry: true,
        recovery: proof.recovery || null,
      });
      if (!retrySend || retrySend.success !== true) {
        const error = (retrySend && (retrySend.error || retrySend.reason)) || 'retry-send-failed';
        this.trace('step-retry-send-failed', 'error=' + error);
        return { ok: false, error, step, sendFailed: true };
      }
      proof = normalizeProof(await this.deps.proveCommand({
        tabId: this.tabId,
        generation: this.generation,
        command: step.command,
        afterMs: retryStartedAt,
        label: step.label + ':retry',
        attempt: 2,
        sendResult: retrySend,
      }));
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

    if (proof.outcome === PROOF.FOUND) return { ok: true, step, proof };
    const explicitCommandError = proof.terminal === true
      ? String(proof.outputPreview || proof.error || proof.reason || '').trim()
      : '';
    return {
      ok: false,
      step,
      proof,
      error: explicitCommandError || (step.command + ' was not confirmed (' + proof.outcome
        + (proof.reason ? '/' + proof.reason : '') + ')'),
      retryable: proof.outcome === PROOF.ABSENT,
    };
  }

  async run() {
    if (this.resolveSteps) {
      this.trace('steps-resolve-start');
      this.steps = await this.resolveSteps({
        tabId: this.tabId,
        generation: this.generation,
        openedBy: this.openedBy,
      });
      if (!Array.isArray(this.steps)) this.steps = [];
      this.trace('steps-resolve-done', 'steps=' + this.steps.length);
    }
    for (const step of this.steps) {
      if (this.deps.isCancelled && this.deps.isCancelled(this.generation)) {
        this.phase = PHASE.FAILED;
        this.result = { status: 'cancelled', generation: this.generation };
        this.trace('cancelled');
        return this.result;
      }
      const outcome = await this.runStep(step);
      if (!outcome.ok) {
        this.phase = PHASE.FAILED;
        this.result = {
          status: 'failed',
          generation: this.generation,
          // The card must name the command that failed instead of the generic
          // "terminal input did not become ready", which contradicted the
          // actual cause in the incident.
          failedCommand: step.command,
          proofOutcome: outcome.proof ? outcome.proof.outcome : null,
          error: outcome.error,
          // `absent` after the single retry is still user-retryable; an
          // unresolved proof is too (the user decides), but neither is retried
          // automatically again.
          userRetryable: true,
        };
        this.trace('failed', 'command="' + describeStep(step) + '" error=' + outcome.error);
        return this.result;
      }
    }
    this.phase = PHASE.DONE;
    this.result = { status: 'ready', generation: this.generation };
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
    trigger,
    steps,
    resolveSteps,
    sendCommand,
    proveCommand,
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
      steps,
      resolveSteps,
      deps: {
        now,
        log,
        sendCommand,
        proveCommand,
        isCancelled: (gen) => isCancelled(tabId, gen),
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
    const promise = transaction.run().finally(() => {
      const current = byTab.get(tabId);
      if (current && current.transaction === transaction) {
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

  function snapshot(tabId) {
    const entry = byTab.get(tabId);
    if (!entry) return null;
    const tx = entry.transaction;
    return {
      tabId,
      generation: tx.generation,
      phase: tx.phase,
      openedBy: tx.openedBy,
      openedAt: tx.openedAt,
      joinCount: tx.joinCount,
      retryUsed: tx.retryUsed,
      settled: entry.settled,
      result: tx.result,
    };
  }

  return {
    ensureTransaction,
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
