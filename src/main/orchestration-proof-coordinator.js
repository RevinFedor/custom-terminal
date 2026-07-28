'use strict';

function normalizeToolType(toolType) {
  return toolType === 'codex' ? 'codex' : 'claude';
}

function proofSessionKey(toolType, sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return null;
  return normalizeToolType(toolType) + ':' + normalizedSessionId;
}

function createOrchestrationProofCoordinator({
  label,
  subscribe,
  unsubscribe,
  onWake,
  log = console,
}) {
  if (typeof subscribe !== 'function') throw new Error('subscribe required');
  if (typeof unsubscribe !== 'function') throw new Error('unsubscribe required');
  if (typeof onWake !== 'function') throw new Error('onWake required');

  const coordinatorLabel = String(label || 'proof').replace(/[^a-z0-9_-]/gi, '-');
  const byRun = new Map();
  const runIdsBySession = new Map();
  const wakeInflight = new Set();
  const wakeTrailing = new Map();
  let stopped = false;

  function addToSession(entry) {
    let runIds = runIdsBySession.get(entry.sessionKey);
    if (!runIds) {
      runIds = new Set();
      runIdsBySession.set(entry.sessionKey, runIds);
    }
    runIds.add(entry.runId);
  }

  function removeFromSession(entry) {
    const runIds = runIdsBySession.get(entry.sessionKey);
    if (!runIds) return;
    runIds.delete(entry.runId);
    if (runIds.size === 0) runIdsBySession.delete(entry.sessionKey);
  }

  async function release(runId, reason = 'released') {
    const normalizedRunId = String(runId || '').trim();
    const entry = byRun.get(normalizedRunId);
    if (!entry) return false;
    byRun.delete(normalizedRunId);
    removeFromSession(entry);
    wakeTrailing.delete(normalizedRunId);
    try {
      await unsubscribe({ consumerId: entry.consumerId });
    } catch (error) {
      log.warn?.('[OrchestrationProof] unsubscribe failed kind=' + coordinatorLabel
        + ' run=' + normalizedRunId + ' error=' + (error?.message || error));
    }
    log.log?.('[OrchestrationProof] disarm kind=' + coordinatorLabel
      + ' run=' + normalizedRunId + ' reason=' + reason);
    return true;
  }

  async function arm({ runId, toolType, sessionId, cwd = null }) {
    if (stopped) return { success: false, error: 'coordinator-stopped' };
    const normalizedRunId = String(runId || '').trim();
    const sessionKey = proofSessionKey(toolType, sessionId);
    if (!normalizedRunId || !sessionKey) {
      return { success: false, error: 'runId and sessionId required' };
    }
    const existing = byRun.get(normalizedRunId);
    if (existing?.sessionKey === sessionKey && existing.cwd === (cwd || null)) {
      return { success: true, armed: existing.armed === true, idempotent: true };
    }
    if (existing) await release(normalizedRunId, 'identity-changed');

    const normalizedToolType = normalizeToolType(toolType);
    const normalizedSessionId = String(sessionId).trim();
    const entry = {
      runId: normalizedRunId,
      toolType: normalizedToolType,
      sessionId: normalizedSessionId,
      sessionKey,
      cwd: cwd || null,
      consumerId: 'orchestration-' + coordinatorLabel + ':' + normalizedRunId,
      armed: false,
    };

    // Register before awaiting subscribe. A file event can arrive immediately
    // after fs.watch is armed but before subscribe() resolves; dropping that
    // edge recreates the exact Stop→JSONL race this coordinator closes.
    byRun.set(normalizedRunId, entry);
    addToSession(entry);
    try {
      const result = await subscribe({
        consumerId: entry.consumerId,
        toolType: entry.toolType,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
      });
      if (result?.success === false) {
        if (byRun.get(normalizedRunId) === entry) {
          byRun.delete(normalizedRunId);
          removeFromSession(entry);
        }
        return { success: false, error: result.error || 'transcript-subscribe-failed' };
      }
      if (byRun.get(normalizedRunId) === entry) entry.armed = true;
      log.log?.('[OrchestrationProof] arm kind=' + coordinatorLabel
        + ' run=' + normalizedRunId
        + ' tool=' + entry.toolType
        + ' session=' + entry.sessionId.slice(0, 8));
      return { success: true, armed: true, consumerId: entry.consumerId };
    } catch (error) {
      if (byRun.get(normalizedRunId) === entry) {
        byRun.delete(normalizedRunId);
        removeFromSession(entry);
      }
      return { success: false, error: String(error?.message || error) };
    }
  }

  function handleTranscriptChanged(meta = {}) {
    if (stopped) return 0;
    const sessionKey = proofSessionKey(meta.toolType, meta.sessionId);
    const runIds = sessionKey ? runIdsBySession.get(sessionKey) : null;
    if (!runIds?.size) return 0;
    let woken = 0;
    for (const runId of [...runIds]) {
      const entry = byRun.get(runId);
      if (!entry || entry.sessionKey !== sessionKey) continue;
      woken += 1;
      scheduleWake(runId, meta);
    }
    return woken;
  }

  function scheduleWake(runId, meta) {
    if (stopped || !byRun.has(runId)) return;
    if (wakeInflight.has(runId)) {
      // A transcript may append several JSONL records in one turn. Preserve
      // the newest edge, but never run concurrent full-result probes for the
      // same durable run.
      wakeTrailing.set(runId, meta);
      return;
    }
    wakeInflight.add(runId);
    Promise.resolve(onWake(runId, meta))
      .catch((error) => {
        log.warn?.('[OrchestrationProof] wake failed kind=' + coordinatorLabel
          + ' run=' + runId + ' error=' + (error?.message || error));
      })
      .finally(() => {
        wakeInflight.delete(runId);
        const trailing = wakeTrailing.get(runId);
        wakeTrailing.delete(runId);
        if (trailing && byRun.has(runId)) scheduleWake(runId, trailing);
      });
  }

  async function stop() {
    stopped = true;
    const runIds = [...byRun.keys()];
    for (const runId of runIds) await release(runId, 'coordinator-stop');
  }

  function snapshot() {
    return [...byRun.values()].map((entry) => ({ ...entry }));
  }

  return {
    arm,
    release,
    handleTranscriptChanged,
    stop,
    snapshot,
  };
}

module.exports = {
  createOrchestrationProofCoordinator,
  proofSessionKey,
};
