'use strict';

const {
  createOrchestrationProofCoordinator,
} = require('./orchestration-proof-coordinator');

/**
 * Event-driven owner for one exact Claude startup slash-command proof.
 *
 * A submitted `/model` or `/effort` command has no safe wall-clock deadline:
 * Claude may queue the local command behind restore/recovery work and append
 * its wrapper + stdout much later. The only positive outcome is the exact
 * transcript proof for the same session. The only cancellation is an exact
 * launch-generation change. This registry deliberately has no polling loop
 * and no timeout that can manufacture a negative result.
 */
function createClaudeStartupProofSession({
  subscribe,
  unsubscribe,
  readProof,
  resolveBinding,
  currentGeneration,
  holdSuccessfulProofForTest = null,
  log = console,
} = {}) {
  if (typeof subscribe !== 'function') throw new TypeError('subscribe is required');
  if (typeof unsubscribe !== 'function') throw new TypeError('unsubscribe is required');
  if (typeof readProof !== 'function') throw new TypeError('readProof is required');
  if (typeof resolveBinding !== 'function') throw new TypeError('resolveBinding is required');
  if (typeof currentGeneration !== 'function') throw new TypeError('currentGeneration is required');

  const pending = new Map();
  const idsByTab = new Map();
  const bindingHintsByTab = new Map();
  let sequence = 0;

  function addToTab(entry) {
    let ids = idsByTab.get(entry.tabId);
    if (!ids) {
      ids = new Set();
      idsByTab.set(entry.tabId, ids);
    }
    ids.add(entry.id);
  }

  function removeFromTab(entry) {
    const ids = idsByTab.get(entry.tabId);
    if (!ids) return;
    ids.delete(entry.id);
    if (ids.size === 0) idsByTab.delete(entry.tabId);
  }

  function settle(entry, result, reason) {
    if (!entry || entry.settled || pending.get(entry.id) !== entry) return false;
    entry.settled = true;
    pending.delete(entry.id);
    removeFromTab(entry);
    // release() removes coordinator ownership synchronously before its first
    // await, so a trailing fs.watch edge cannot re-enter this proof.
    void coordinator.release(entry.id, reason || result?.reason || 'settled');
    entry.resolve(result);
    return true;
  }

  async function evaluate(entry, wakeReason) {
    if (!entry || entry.settled || pending.get(entry.id) !== entry) return;
    if (currentGeneration(entry.tabId) !== entry.generation) {
      settle(entry, {
        success: false,
        outcome: 'unresolved',
        reason: 'stale-generation',
      }, 'stale-generation');
      return;
    }
    if (!entry.binding?.sessionId) return;

    let proof;
    try {
      proof = await readProof({
        ...entry.request,
        sessionId: entry.binding.sessionId,
        wakeReason,
      });
    } catch (error) {
      log.warn?.('[ClaudeStartupProofWait] read failed tab='
        + String(entry.tabId).slice(-12)
        + ' gen=' + entry.generation
        + ' command=' + JSON.stringify(entry.request.command)
        + ' error=' + (error?.message || error));
      return;
    }

    if (proof?.outcome === 'found') {
      if (typeof holdSuccessfulProofForTest === 'function') {
        try {
          await holdSuccessfulProofForTest({
            id: entry.id,
            tabId: entry.tabId,
            generation: entry.generation,
            command: entry.request.command,
            sessionId: entry.binding.sessionId,
            proof,
          });
        } catch (error) {
          log.warn?.('[ClaudeStartupProofWait] test proof hold failed tab='
            + String(entry.tabId).slice(-12)
            + ' gen=' + entry.generation
            + ' command=' + JSON.stringify(entry.request.command)
            + ' error=' + (error?.message || error));
        }
      }
      if (entry.settled || pending.get(entry.id) !== entry) return;
      if (currentGeneration(entry.tabId) !== entry.generation) {
        settle(entry, {
          success: false,
          outcome: 'unresolved',
          reason: 'stale-generation',
        }, 'stale-generation');
        return;
      }
      settle(entry, proof, 'exact-proof-found');
      return;
    }
    // A paired local-command stdout is a terminal event even when it is not
    // the requested success text. Surface it as unknown/failure; never wait
    // forever and never retry a command whose Enter was already written.
    if (proof?.terminal === true) {
      settle(entry, proof, proof.reason || 'terminal-command-output');
    }
  }

  const coordinator = createOrchestrationProofCoordinator({
    label: 'claude-startup-slash',
    subscribe,
    unsubscribe,
    onWake: async (id, meta) => {
      const entry = pending.get(id);
      if (!entry) return;
      log.log?.('[ClaudeStartupProofWait] wake tab=' + String(entry.tabId).slice(-12)
        + ' gen=' + entry.generation
        + ' command=' + JSON.stringify(entry.request.command)
        + ' session=' + String(meta?.sessionId || '').slice(0, 8)
        + ' version=' + (meta?.version ?? '-'));
      await evaluate(entry, 'transcript-changed');
    },
    log,
  });

  async function bind(entry, reason, bindingHint = null) {
    if (!entry || entry.settled || pending.get(entry.id) !== entry) return;
    if (bindingHint?.sessionId) {
      entry.pendingBindingHint = {
        sessionId: String(bindingHint.sessionId),
        cwd: bindingHint.cwd || null,
      };
    }
    if (entry.bindInflight) return entry.bindInflight;
    entry.bindInflight = (async () => {
      if (currentGeneration(entry.tabId) !== entry.generation) {
        settle(entry, {
          success: false,
          outcome: 'unresolved',
          reason: 'stale-generation',
        }, 'stale-generation');
        return;
      }
      const resolvedBinding = await resolveBinding({
        tabId: entry.tabId,
        generation: entry.generation,
      });
      const hintedBinding = entry.pendingBindingHint;
      entry.pendingBindingHint = null;
      const binding = hintedBinding?.sessionId
        ? {
            ...(resolvedBinding || {}),
            sessionId: String(hintedBinding.sessionId),
            cwd: hintedBinding.cwd || resolvedBinding?.cwd || null,
          }
        : resolvedBinding;
      if (!binding?.sessionId) {
        log.log?.('[ClaudeStartupProofWait] binding-pending tab='
          + String(entry.tabId).slice(-12)
          + ' gen=' + entry.generation
          + ' command=' + JSON.stringify(entry.request.command)
          + ' reason=' + reason);
        return;
      }

      const unchanged = entry.binding?.sessionId === binding.sessionId
        && (entry.binding?.cwd || null) === (binding.cwd || null)
        && entry.armed === true;
      entry.binding = {
        sessionId: String(binding.sessionId),
        cwd: binding.cwd || null,
      };
      if (!unchanged) {
        const armed = await coordinator.arm({
          runId: entry.id,
          toolType: 'claude',
          sessionId: entry.binding.sessionId,
          cwd: entry.binding.cwd,
        });
        if (entry.settled || pending.get(entry.id) !== entry) return;
        if (armed?.success !== true) {
          settle(entry, {
            success: false,
            outcome: 'unresolved',
            reason: armed?.error || 'transcript-subscribe-failed',
          }, 'subscribe-failed');
          return;
        }
        entry.armed = true;
      }
      // Scan after watcher admission. This closes both races: proof already
      // existed before subscribe, or it arrived while subscribe was resolving.
      await evaluate(entry, unchanged ? reason : 'binding-armed');
    })().finally(() => {
      if (!entry) return;
      entry.bindInflight = null;
      if (
        entry.pendingBindingHint?.sessionId
        && !entry.settled
        && pending.get(entry.id) === entry
      ) {
        void bind(entry, 'binding-changed-during-bind').catch((error) => {
          settle(entry, {
            success: false,
            outcome: 'unresolved',
            reason: error?.message || String(error),
          }, 'binding-failed');
        });
      }
    });
    return entry.bindInflight;
  }

  function wait(request = {}) {
    const tabId = String(request.tabId || '');
    const generation = String(request.generation || '');
    if (!tabId || !generation || !request.command) {
      return Promise.resolve({
        success: false,
        outcome: 'unresolved',
        reason: 'missing-proof-identity',
      });
    }
    sequence += 1;
    const id = 'claude-startup:' + generation + ':' + sequence;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const entry = {
      id,
      tabId,
      generation,
      request: { ...request, tabId, generation },
      resolve,
      promise,
      binding: null,
      bindInflight: null,
      pendingBindingHint: null,
      armed: false,
      settled: false,
    };
    pending.set(id, entry);
    addToTab(entry);
    log.log?.('[ClaudeStartupProofWait] open tab=' + tabId.slice(-12)
      + ' gen=' + generation
      + ' command=' + JSON.stringify(request.command));
    const rememberedBinding = bindingHintsByTab.get(tabId);
    const bindingHint = rememberedBinding?.generation === generation
      ? rememberedBinding
      : null;
    void bind(entry, 'wait-open', bindingHint).catch((error) => {
      settle(entry, {
        success: false,
        outcome: 'unresolved',
        reason: error?.message || String(error),
      }, 'bind-failed');
    });
    return promise;
  }

  function handleTranscriptChanged(meta = {}) {
    return coordinator.handleTranscriptChanged(meta);
  }

  function handleBindingChanged(tabId, bindingHint = null) {
    const normalizedTabId = String(tabId || '');
    const hintGeneration = String(
      bindingHint?.generation || currentGeneration(normalizedTabId) || '',
    );
    if (normalizedTabId && bindingHint?.sessionId && hintGeneration) {
      bindingHintsByTab.set(normalizedTabId, {
        sessionId: String(bindingHint.sessionId),
        cwd: bindingHint.cwd || null,
        generation: hintGeneration,
      });
    }
    const ids = idsByTab.get(normalizedTabId);
    if (!ids?.size) return 0;
    let count = 0;
    for (const id of [...ids]) {
      const entry = pending.get(id);
      if (!entry) continue;
      count += 1;
      void bind(entry, 'binding-changed', bindingHint).catch((error) => {
        settle(entry, {
          success: false,
          outcome: 'unresolved',
          reason: error?.message || String(error),
        }, 'binding-failed');
      });
    }
    return count;
  }

  function cancel(tabId, generation = null, reason = 'cancelled') {
    const normalizedTabId = String(tabId || '');
    const rememberedBinding = bindingHintsByTab.get(normalizedTabId);
    if (!generation || rememberedBinding?.generation === generation) {
      bindingHintsByTab.delete(normalizedTabId);
    }
    const ids = idsByTab.get(normalizedTabId);
    if (!ids?.size) return 0;
    let count = 0;
    for (const id of [...ids]) {
      const entry = pending.get(id);
      if (!entry || (generation && entry.generation !== generation)) continue;
      if (settle(entry, {
        success: false,
        outcome: 'unresolved',
        reason,
      }, reason)) count += 1;
    }
    return count;
  }

  function snapshot() {
    return [...pending.values()].map((entry) => ({
      id: entry.id,
      tabId: entry.tabId,
      generation: entry.generation,
      command: entry.request.command,
      sessionId: entry.binding?.sessionId || null,
      armed: entry.armed,
    }));
  }

  return {
    wait,
    handleTranscriptChanged,
    handleBindingChanged,
    cancel,
    snapshot,
    stop: () => coordinator.stop(),
  };
}

module.exports = {
  createClaudeStartupProofSession,
};
