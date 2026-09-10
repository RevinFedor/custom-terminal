'use strict';

const COMPACT_OPERATION_PHASE = 'compacting';
const COMPACT_OPERATION_KIND = 'compact';
const VALID_PROVIDERS = new Set(['claude', 'codex']);
const VALID_OUTCOMES = new Set(['completed', 'aborted', 'failed', 'unknown']);

function normalizeCompactCommand(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function isExactCompactCommand(value) {
  return normalizeCompactCommand(value) === '/compact';
}

function claudeCompactOutcomeFromReason(reasonValue) {
  const reason = String(reasonValue || 'unknown');
  if (
    reason === 'compact_boundary'
    || reason === 'compact_summary'
    || reason === 'compact_stdout'
  ) {
    return 'completed';
  }
  if (
    reason === 'compact-cancelled'
    || reason === 'input-escape'
    || reason === 'input-ctrl-c'
    || reason === 'interrupt'
    || reason === 'manual-stop'
    || reason === 'bridge-clear'
  ) {
    return 'aborted';
  }
  if (
    reason === 'stop-failure'
    || reason === 'compact-not-enough-messages'
    || reason === 'compact-provider-error'
  ) return 'failed';
  return 'unknown';
}

function codexCompactOutcomeFromReason(reasonValue) {
  const reason = String(reasonValue || 'unknown');
  if (reason === 'compacted') return 'completed';
  if (
    reason === 'turn_aborted'
    || reason === 'manual-stop'
    || reason === 'terminal-kill'
    || reason === 'pty-exit'
  ) {
    return 'aborted';
  }
  if (
    reason === 'task_complete'
    || reason === 'codex-no-final-result'
    || reason === 'command-finished'
  ) return 'failed';
  return 'unknown';
}

function codexCompactCommandText(record) {
  const payload = record?.payload || {};
  if (typeof payload.message === 'string') return payload.message;
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.value || part?.message || '';
  }).filter(Boolean).join('\n');
}

function classifyCodexCompactEvidence(record) {
  if (!record || typeof record !== 'object') return { kind: 'none' };
  if (record.type === 'compacted') {
    return { kind: 'terminal', outcome: 'completed', reason: 'compacted' };
  }
  if (record.type !== 'event_msg') return { kind: 'none' };
  const event = String(record.payload?.type || '');
  if (event === 'user_message') {
    const command = codexCompactCommandText(record);
    return isExactCompactCommand(command)
      ? { kind: 'start', command: '/compact', reason: 'user_message' }
      : { kind: 'none' };
  }
  if (event === 'context_compacted') {
    return { kind: 'telemetry', reason: 'context_compacted' };
  }
  if (event === 'turn_aborted' || event === 'task_complete') {
    return {
      kind: 'terminal',
      outcome: codexCompactOutcomeFromReason(event),
      reason: event,
    };
  }
  if (event === 'error' || event === 'turn_failed' || event === 'task_failed') {
    return { kind: 'terminal', outcome: 'failed', reason: 'compact-provider-error' };
  }
  return { kind: 'none' };
}

// A successful explicit /compact has a durable compact record, not an
// assistant final answer. Reuse that operation's exact owner/boundary proof
// before publishing a generic no-final-result to workflow consumers.
function projectCodexCompactTurnOutcome({ outcome, operation, record, state,
  lifecycleGeneration, terminal } = {}) {
  if (outcome?.reason !== 'codex-no-final-result'
    || record?.payload?.type !== 'task_complete'
    || record.payload.error
    || operation?.active !== true || operation.provider !== 'codex'
    || operation.command !== '/compact'
    || operation.tabId !== state?.tabId
    || !operation.sessionId || operation.sessionId !== state?.sessionId
    || !operation.generation || operation.generation !== state?.processGeneration
    || operation.generation !== lifecycleGeneration
    || (operation.terminal && operation.terminal !== terminal)
    || !record.payload.turn_id || record.payload.turn_id !== state?.currentTurnId
    || (operation.turnId && operation.turnId !== record.payload.turn_id)
    || !Number.isSafeInteger(operation.sourceByteOffset)
    || !Number.isSafeInteger(operation.codexCompactedOffset)
    || !Number.isSafeInteger(record.__byteOffset)
    || operation.codexCompactedOffset <= operation.sourceByteOffset
    || operation.codexCompactedOffset >= record.__byteOffset) return outcome;
  return { ...outcome, reason: 'task_complete', hasFinalResult: false,
    completionKind: 'compact', compactOperationId: operation.operationId };
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(label + ' must be a non-empty string');
  return normalized;
}

function optionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function cloneOperation(value) {
  return value ? Object.freeze({ ...value }) : null;
}

function finiteOffset(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function sameOperationIdentity(left, right) {
  return !!left && !!right
    && left.tabId === right.tabId
    && left.provider === right.provider
    && left.operationId === right.operationId;
}

function ownerMatches(active, expected = {}) {
  if (!active) return false;
  if (expected.provider && active.provider !== expected.provider) return false;
  if (expected.operationId && active.operationId !== expected.operationId) return false;
  if (expected.sessionId && active.sessionId !== expected.sessionId) return false;
  if (expected.generation && active.generation !== expected.generation) return false;
  if (Number.isFinite(expected.promptGeneration)
    && active.promptGeneration !== Number(expected.promptGeneration)) return false;
  return true;
}

function pendingOwnerMatches(pending, expected = {}) {
  if (!ownerMatches(pending, expected)) return false;
  if (Object.prototype.hasOwnProperty.call(expected, 'terminal')
    && pending.terminal !== expected.terminal) return false;
  return true;
}

/**
 * Main-owned, non-persistent operational state for explicit context compaction.
 *
 * Public starts are provider-start facts; terminal outcomes are
 * provider-specific transcript/lifecycle facts. Manual Codex Enter first arms
 * an internal pending intent, which is promoted only by a causal task_started.
 * Historical transcript rows never rehydrate this registry, so an app restart
 * cannot resurrect a completed operation. A small count-bounded settled ledger
 * exists only so a remounted renderer can consume the exact delivery handoff
 * it missed while unmounted.
 */
class CompactOperationRegistry {
  constructor({
    now = () => Date.now(),
    publish = () => {},
    maxSettledPerTab = 8,
    beforeFinish = null,
  } = {}) {
    if (!Number.isSafeInteger(maxSettledPerTab) || maxSettledPerTab <= 0) {
      throw new RangeError('maxSettledPerTab must be a positive safe integer');
    }
    this.now = now;
    this.publish = publish;
    this.maxSettledPerTab = maxSettledPerTab;
    this.beforeFinish = typeof beforeFinish === 'function' ? beforeFinish : null;
    this.pendingByTab = new Map();
    this.activeByTab = new Map();
    this.settledByTab = new Map();
    this.heldFinishByTab = new Map();
    this.sequence = 0;
  }

  begin(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const provider = requireText(input.provider, 'provider');
    if (!VALID_PROVIDERS.has(provider)) throw new TypeError('unsupported compact provider');
    if (!isExactCompactCommand(input.command)) return null;

    const sessionId = optionalText(input.sessionId);
    const generation = optionalText(input.generation);
    const operationId = optionalText(input.operationId)
      || provider + ':' + (generation || 'generation-unknown') + ':' + (++this.sequence);
    const acceptedAt = Number.isFinite(input.acceptedAt) ? Number(input.acceptedAt) : this.now();
    const candidate = {
      kind: COMPACT_OPERATION_KIND,
      phase: COMPACT_OPERATION_PHASE,
      active: true,
      tabId,
      provider,
      command: '/compact',
      operationId,
      sessionId,
      generation,
      promptGeneration: Number.isFinite(input.promptGeneration)
        ? Number(input.promptGeneration)
        : null,
      turnId: optionalText(input.turnId),
      sourceByteOffset: Number.isFinite(input.sourceByteOffset)
        ? Number(input.sourceByteOffset)
        : null,
      causalBoundaryEventSequence: Number.isFinite(input.causalBoundaryEventSequence)
        ? Number(input.causalBoundaryEventSequence)
        : null,
      causalStartRequired: input.causalStartRequired === true,
      causalStartConfirmed: input.causalStartRequired !== true,
      codexCompactedOffset: null,
      codexCompactedEventSequence: null,
      codexTaskCompleteOffset: null,
      codexTaskCompleteEventSequence: null,
      handoffId: optionalText(input.handoffId),
      source: optionalText(input.source),
      acceptedAt,
      startedAt: acceptedAt,
    };

    const settled = this.settledByTab.get(tabId) || [];
    if (settled.some((item) => sameOperationIdentity(item, candidate))) {
      return null;
    }

    const current = this.activeByTab.get(tabId) || null;
    if (sameOperationIdentity(current, candidate)) return cloneOperation(current);
    if (current) {
      this.finish({
        tabId,
        provider: current.provider,
        operationId: current.operationId,
        outcome: 'unknown',
        reason: 'superseded-by-new-compact',
      });
    }

    // A separately audited public start supersedes any invisible manual
    // intent for this tab. The main wiring deliberately avoids this path for
    // the matching manual user_message, because only task_started may promote
    // that intent.
    this.pendingByTab.delete(tabId);

    const active = cloneOperation(candidate);
    this.activeByTab.set(tabId, active);
    this.publish(active);
    return active;
  }

  /**
   * Record one exact manual Codex /compact Enter without publishing UI state.
   * The PTY object is retained only as an internal ownership token and is
   * stripped before an operation is promoted to the public active registry.
   */
  armPending(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const provider = requireText(input.provider, 'provider');
    if (provider !== 'codex') throw new TypeError('pending compact is only supported for codex');
    if (!isExactCompactCommand(input.command)) return null;

    const sessionId = optionalText(input.sessionId);
    const generation = optionalText(input.generation);
    const operationId = optionalText(input.operationId)
      || provider + ':manual:' + (generation || 'generation-unknown') + ':' + (++this.sequence);
    const acceptedAt = Number.isFinite(input.acceptedAt) ? Number(input.acceptedAt) : this.now();
    const candidate = cloneOperation({
      kind: COMPACT_OPERATION_KIND,
      phase: null,
      active: false,
      pending: true,
      tabId,
      provider,
      command: '/compact',
      operationId,
      sessionId,
      generation,
      promptGeneration: Number.isFinite(input.promptGeneration)
        ? Number(input.promptGeneration)
        : null,
      terminal: input.terminal || null,
      turnId: optionalText(input.turnId),
      sourceByteOffset: finiteOffset(input.sourceByteOffset),
      causalBoundaryEventSequence: finiteOffset(input.causalBoundaryEventSequence),
      causalStartRequired: true,
      causalStartConfirmed: false,
      codexCompactedOffset: null,
      codexCompactedEventSequence: null,
      codexTaskCompleteOffset: null,
      codexTaskCompleteEventSequence: null,
      handoffId: optionalText(input.handoffId),
      source: optionalText(input.source) || 'manual-xterm-enter',
      acceptedAt,
      startedAt: null,
    });

    const settled = this.settledByTab.get(tabId) || [];
    if (settled.some((item) => sameOperationIdentity(item, candidate))) return null;
    const active = this.activeByTab.get(tabId) || null;
    if (active) return sameOperationIdentity(active, candidate) ? cloneOperation(active) : null;

    const current = this.pendingByTab.get(tabId) || null;
    if (sameOperationIdentity(current, candidate)) return cloneOperation(current);
    this.pendingByTab.set(tabId, candidate);
    return cloneOperation(candidate);
  }

  /** Cancel an invisible intent. Cancellation itself is intentionally private. */
  cancelPending(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const pending = this.pendingByTab.get(tabId) || null;
    if (!pendingOwnerMatches(pending, input)) return null;
    this.pendingByTab.delete(tabId);
    return cloneOperation({
      ...pending,
      pending: false,
      cancelReason: optionalText(input.reason) || 'cancelled',
      cancelledAt: Number.isFinite(input.cancelledAt) ? Number(input.cancelledAt) : this.now(),
    });
  }

  /**
   * Settle a provider refusal that happened before the causal compact task
   * started. Unlike cancelPending this is user-visible: the exact rejected
   * command owns a handoff and History must replace it with the provider notice.
   */
  rejectPending(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const pending = this.pendingByTab.get(tabId) || null;
    if (!pendingOwnerMatches(pending, input)) return null;
    this.pendingByTab.delete(tabId);
    const { terminal: _terminal, pending: _pending, ...publicOperation } = pending;
    const endedAt = Number.isFinite(input.endedAt) ? Number(input.endedAt) : this.now();
    const settled = cloneOperation({
      ...publicOperation,
      active: false,
      phase: null,
      outcome: 'failed',
      reason: optionalText(input.reason) || 'provider-rejected-before-start',
      completionProof: optionalText(input.completionProof),
      message: optionalText(input.message),
      endedAt,
    });
    const ledger = [...(this.settledByTab.get(tabId) || []), settled];
    if (ledger.length > this.maxSettledPerTab) {
      ledger.splice(0, ledger.length - this.maxSettledPerTab);
    }
    this.settledByTab.set(tabId, ledger);
    this.publish(settled);
    return settled;
  }

  confirmStart(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const active = this.activeByTab.get(tabId) || null;
    if (ownerMatches(active, input) && active.causalStartConfirmed === true) {
      return cloneOperation(active);
    }
    const pending = this.pendingByTab.get(tabId) || null;
    if (!pendingOwnerMatches(pending, input)) return null;
    const eventSequence = Number(input.eventSequence);
    const boundarySequence = Number(pending.causalBoundaryEventSequence);
    if (Number.isFinite(boundarySequence)
      && (!Number.isFinite(eventSequence) || eventSequence <= boundarySequence)) {
      return null;
    }
    if (Number.isFinite(pending.sourceByteOffset)
      && (!Number.isFinite(input.sourceByteOffset)
        || Number(input.sourceByteOffset) < Number(pending.sourceByteOffset))) {
      return null;
    }
    const { terminal: _terminal, pending: _pending, ...publicOperation } = pending;
    const confirmed = cloneOperation({
      ...publicOperation,
      phase: COMPACT_OPERATION_PHASE,
      active: true,
      causalStartConfirmed: true,
      causalStartEventSequence: Number.isFinite(eventSequence) ? eventSequence : null,
      causalStartByteOffset: Number.isFinite(input.sourceByteOffset)
        ? Number(input.sourceByteOffset)
        : null,
      causalStartProof: optionalText(input.proof) || 'post-boundary-event',
      startedAt: Number.isFinite(input.startedAt) ? Number(input.startedAt) : this.now(),
    });
    this.pendingByTab.delete(tabId);
    this.activeByTab.set(tabId, confirmed);
    this.publish(confirmed);
    return confirmed;
  }

  finish(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const active = this.activeByTab.get(tabId) || null;
    if (!ownerMatches(active, input)) return null;
    // A copied marker from the historical rollout prefix cannot settle a new
    // operation merely because tab/session/generation still match.
    if (Number.isFinite(input.completionByteOffset)
      && Number.isFinite(active.sourceByteOffset)
      && Number(input.completionByteOffset) <= Number(active.sourceByteOffset)) {
      return null;
    }
    if (input.outcome === 'completed'
      && active.causalStartRequired === true
      && active.causalStartConfirmed !== true) {
      return null;
    }
    const alreadyHeld = this.heldFinishByTab.get(tabId) || null;
    if (alreadyHeld && sameOperationIdentity(alreadyHeld.active, active)) {
      return cloneOperation(active);
    }
    if (input._e2eBypass !== true && this.beforeFinish) {
      const boundary = this.beforeFinish({
        active: cloneOperation(active),
        input: { ...input },
      });
      if (boundary?.hold === true && boundary.released?.then) {
        const held = {
          active,
          input: { ...input },
          boundary,
        };
        this.heldFinishByTab.set(tabId, held);
        void Promise.resolve(boundary.released).then((release) => {
          if (this.heldFinishByTab.get(tabId) !== held) return;
          this.heldFinishByTab.delete(tabId);
          const settled = this.finish({ ...held.input, _e2eBypass: true });
          try {
            boundary.complete?.({
              release,
              settled: cloneOperation(settled),
              stale: settled == null,
            });
          } catch {}
        });
        return cloneOperation(active);
      }
    }
    const outcome = VALID_OUTCOMES.has(input.outcome) ? input.outcome : 'unknown';
    const endedAt = Number.isFinite(input.endedAt) ? Number(input.endedAt) : this.now();
    this.heldFinishByTab.delete(tabId);
    this.activeByTab.delete(tabId);
    const settled = cloneOperation({
      ...active,
      active: false,
      phase: null,
      outcome,
      reason: optionalText(input.reason) || 'unknown',
      completionProof: optionalText(input.completionProof),
      endedAt,
    });
    const ledger = [...(this.settledByTab.get(tabId) || []), settled];
    if (ledger.length > this.maxSettledPerTab) {
      ledger.splice(0, ledger.length - this.maxSettledPerTab);
    }
    this.settledByTab.set(tabId, ledger);
    this.publish(settled);
    return settled;
  }

  /**
   * Consume Codex evidence in rollout order. `task_complete` is only a
   * candidate failure for an accepted compact: the canonical rollout consumer
   * must first reach the end of that record's offset. This lets a provider
   * `compacted` record win for manual, History, Run after and API sources even
   * when its delivery callback is observed after the generic task callback.
   */
  observeCodexEvidence(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const active = this.activeByTab.get(tabId) || null;
    if (!ownerMatches(active, { ...input, provider: 'codex' })) return null;
    const offset = finiteOffset(input.rolloutOffset ?? input.completionByteOffset);
    const eventSequence = finiteOffset(input.eventSequence);
    if (active.provider !== 'codex' || !Number.isFinite(offset)) return null;
    if (Number.isFinite(active.sourceByteOffset) && offset <= active.sourceByteOffset) return null;
    if (Number.isFinite(active.codexCompactedOffset)
      && offset === active.codexCompactedOffset
      && input.kind === 'compacted') {
      return cloneOperation(active);
    }

    if (input.kind === 'compacted') {
      // A compacted record after task_complete is not a completion proof for
      // that task. It is either a later operation or stale/out-of-order data.
      if (Number.isFinite(active.codexTaskCompleteOffset)
        && offset >= active.codexTaskCompleteOffset) return null;
      const updated = cloneOperation({
        ...active,
        codexCompactedOffset: offset,
        codexCompactedEventSequence: eventSequence,
      });
      this.activeByTab.set(tabId, updated);
      this.publish(updated);
      if (Number.isFinite(updated.codexTaskCompleteOffset)
        && offset < updated.codexTaskCompleteOffset) {
        return this.finish({
          tabId,
          provider: 'codex',
          operationId: updated.operationId,
          sessionId: updated.sessionId,
          generation: updated.generation,
          outcome: 'completed',
          reason: 'compacted',
          completionProof: optionalText(input.proof) || 'rollout-compacted',
          completionByteOffset: offset,
        });
      }
      return updated;
    }

    if (input.kind !== 'task_complete') return cloneOperation(active);
    if (Number.isFinite(active.codexTaskCompleteOffset)
      && offset === active.codexTaskCompleteOffset) return cloneOperation(active);
    const updated = cloneOperation({
      ...active,
      codexTaskCompleteOffset: offset,
      codexTaskCompleteEventSequence: eventSequence,
    });
    this.activeByTab.set(tabId, updated);
    this.publish(updated);
    return updated;
  }

  /** Settle the deferred generic fallback after the canonical consumer caught up. */
  finalizeCodexTaskComplete(input = {}) {
    const tabId = requireText(input.tabId, 'tabId');
    const active = this.activeByTab.get(tabId) || null;
    if (!ownerMatches(active, { ...input, provider: 'codex' })) return null;
    if (!Number.isFinite(active.codexTaskCompleteOffset)) return null;
    if (Number.isFinite(active.codexCompactedOffset)
      && active.codexCompactedOffset < active.codexTaskCompleteOffset) {
      return this.finish({
        tabId,
        provider: 'codex',
        operationId: active.operationId,
        sessionId: active.sessionId,
        generation: active.generation,
        outcome: 'completed',
        reason: 'compacted',
        completionProof: 'rollout-compacted-before-task-complete',
        completionByteOffset: active.codexCompactedOffset,
      });
    }
    return this.finish({
      tabId,
      provider: 'codex',
      operationId: active.operationId,
      sessionId: active.sessionId,
      generation: active.generation,
      outcome: 'failed',
      reason: 'task_complete',
      completionProof: optionalText(input.proof) || 'task-complete-catch-up',
      completionByteOffset: active.codexTaskCompleteOffset,
    });
  }

  getActive(tabIdValue, provider = null) {
    const tabId = String(tabIdValue || '').trim();
    const active = tabId ? (this.activeByTab.get(tabId) || null) : null;
    if (provider && active?.provider !== provider) return null;
    return cloneOperation(active);
  }

  getPending(tabIdValue, provider = null) {
    const tabId = String(tabIdValue || '').trim();
    const pending = tabId ? (this.pendingByTab.get(tabId) || null) : null;
    if (provider && pending?.provider !== provider) return null;
    return cloneOperation(pending);
  }

  snapshot(tabIdValue, provider = null) {
    const tabId = String(tabIdValue || '').trim();
    const active = this.getActive(tabId, provider);
    const settled = (this.settledByTab.get(tabId) || [])
      .filter((item) => !provider || item.provider === provider)
      .map(cloneOperation);
    return Object.freeze({
      success: true,
      tabId,
      active,
      settled: Object.freeze(settled),
    });
  }
}

function createCompactOperationRegistry(options) {
  return new CompactOperationRegistry(options);
}

module.exports = {
  COMPACT_OPERATION_KIND,
  COMPACT_OPERATION_PHASE,
  CompactOperationRegistry,
  claudeCompactOutcomeFromReason,
  classifyCodexCompactEvidence,
  codexCompactOutcomeFromReason,
  createCompactOperationRegistry,
  isExactCompactCommand,
  normalizeCompactCommand,
  projectCodexCompactTurnOutcome,
};
