'use strict';

const { inspectCodexUsagePrompt } = require('./codex-usage-prompt');
const { inspectCodexResumeGoalPrompt, resolveCodexResumeGoalPreference } = require('./codex-resume-goal-prompt');

function inspectCodexPolicyDialog(text) {
  const usage = inspectCodexUsagePrompt(text);
  if (usage.visible) return { ...usage, type: 'usage-exhaustion' };
  const goal = inspectCodexResumeGoalPrompt(text);
  return goal.visible && !goal.missing.includes('footer') ? { type: 'resume-goal', visible: true,
    interactive: goal.interactiveVisible, selectedIndex: goal.firstOptionSelected ? 1 : goal.secondOptionSelected ? 2 : null,
    options: [{ index: 1, label: 'Resume goal' }, { index: 2, label: 'Leave paused' }] } : null;
}

const sameOwner = (a, b) => !!a?.terminal && !!b?.live && a.terminal === b.terminal
  && a.lifecycleGeneration === b.lifecycleGeneration && a.runSeq === b.runSeq;

function createCodexRuntimePolicyController({ capture, readFrame, withWriteLock, sendKey,
  readPolicy, isComposer, stopAll, publish, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, confirmationMs = 3000, actionMs = 10000, log = () => {} }) {
  const states = new Map();
  let sequence = 0;
  let stopAllWork = null;
  const current = (tabId, state, input = false) => {
    const owner = capture(tabId);
    return states.get(tabId) === state && sameOwner(state.owner, owner)
      && (!input || owner.inputRevision === state.owner.inputRevision);
  };
  function setPhase(tabId, state, phase, reason) {
    if (!current(tabId, state)) return;
    if (state.phase === phase && state.reason === reason) return;
    state.phase = phase; state.reason = reason;
    if ((phase === 'manual' || phase === 'handled') && state.timer) clearTimer(state.timer);
    if ((phase === 'manual' || phase === 'handled') && state.deadlineTimer) clearTimer(state.deadlineTimer);
    publish(tabId, { operationId: state.id, type: state.type, policy: state.policy,
      phase, reason, actionWritten: state.actionWritten, detectedAt: state.detectedAt,
      frameSeq: state.frameSeq, resultFrameSeq: state.resultFrameSeq || null });
    log('[CodexRuntimePolicy] tab=' + tabId + ' operation=' + state.id + ' type=' + state.type
      + ' policy=' + state.policy + ' phase=' + phase + ' reason=' + reason
      + ' actionWritten=' + state.actionWritten + ' frame=' + state.frameSeq);
  }
  function clear(tabId) {
    const old = states.get(tabId);
    if (old?.timer) clearTimer(old.timer);
    if (old?.deadlineTimer) clearTimer(old.deadlineTimer);
    states.delete(tabId);
  }
  function awaitUnwrittenFrame(tabId, state, reason) {
    setPhase(tabId, state, 'awaiting-frame', reason);
    if (!state.timer) {
      state.timer = setTimer(() => {
        if (current(tabId, state) && state.phase === 'awaiting-frame') setPhase(tabId, state, 'manual', 'current-frame-unavailable');
      }, confirmationMs);
      state.timer?.unref?.();
    }
  }
  async function act(tabId, state) {
    if (state.phase === 'manual' || state.phase === 'handled' || state.actionWritten) return;
    if (!current(tabId, state, true)) { setPhase(tabId, state, 'manual', 'input-owner-changed'); return; }
    if (state.policy === 'stop-all') {
      setPhase(tabId, state, 'applying', 'common-process-stop');
      if (!stopAllWork) {
        stopAllWork = Promise.resolve().then(stopAll);
        stopAllWork.finally(() => { stopAllWork = null; }).catch(() => {});
      }
      const result = await stopAllWork.catch(error => ({ success: false, error: error.message }));
      setPhase(tabId, state, result?.success === true ? 'handled' : 'manual',
        result?.success === true ? 'processes-stopped' : 'stop-unconfirmed');
      return;
    }
    try {
      await withWriteLock(state.owner.terminal, async owner => {
        if (!current(tabId, state, true)) { setPhase(tabId, state, 'manual', 'input-owner-changed'); return; }
        if (state.phase === 'manual' || state.phase === 'handled' || state.actionWritten) return;
        if (state.timer) { clearTimer(state.timer); state.timer = null; }
        setPhase(tabId, state, 'applying', 'select-provider-option');
        for (let step = 0; step < 4; step++) {
          const frame = await readFrame(tabId);
          if (!current(tabId, state, true)) { setPhase(tabId, state, 'manual', 'input-owner-changed'); return; }
          if (state.phase === 'manual' || state.phase === 'handled') return;
          if (!frame?.valid) { awaitUnwrittenFrame(tabId, state, 'current-frame-unavailable'); return; }
          const dialog = inspectCodexPolicyDialog(frame.text);
          if (!dialog || dialog.type !== state.type) {
            if (isComposer(frame)) { state.resultFrameSeq = frame.seq; setPhase(tabId, state, 'handled', 'composer-already-ready'); }
            else awaitUnwrittenFrame(tabId, state, 'dialog-changed-before-action');
            return;
          }
          if (!dialog.interactive || !dialog.selectedIndex) { setPhase(tabId, state, 'manual', 'option-unproven'); return; }
          const target = state.type === 'usage-exhaustion' ? dialog.targetIndex : state.policy === 'leave-paused' ? 2 : 1;
          const key = dialog.selectedIndex === target ? '\r' : dialog.selectedIndex < target ? '\x1b[B' : '\x1b[A';
          const allowed = () => current(tabId, state, true) && state.phase !== 'manual' && state.phase !== 'handled';
          const written = await sendKey(tabId, key, { owner, expectedFrame: frame, guard: allowed, dialogType: state.type });
          if (!written?.written) {
            if (current(tabId, state, true)) awaitUnwrittenFrame(tabId, state, written?.reason || 'write-not-proven');
            else setPhase(tabId, state, 'manual', 'input-owner-changed');
            return;
          }
          if (key === '\r') {
            state.actionWritten = true;
            if (state.deadlineTimer) clearTimer(state.deadlineTimer);
            state.actionFrameSeq = frame.seq;
            // A committed reply can arrive synchronously from the write/await.
            // Do not resurrect its already settled operation as confirming.
            if (!current(tabId, state) || state.phase === 'handled') return;
            setPhase(tabId, state, 'confirming', 'waiting-committed-composer');
            state.timer = setTimer(async () => {
              if (!current(tabId, state) || state.phase !== 'confirming') return;
              const latest = await readFrame(tabId).catch(() => null);
              if (!current(tabId, state) || state.phase !== 'confirming') return;
              if (latest?.valid && latest.seq > state.actionFrameSeq && isComposer(latest)) {
                state.resultFrameSeq = latest.seq;
                setPhase(tabId, state, 'handled', 'committed-composer');
              } else setPhase(tabId, state, 'manual', 'provider-choice-not-confirmed');
            }, confirmationMs);
            state.timer?.unref?.();
            return;
          }
        }
        setPhase(tabId, state, 'manual', 'option-selection-incomplete');
      });
    } catch (error) { setPhase(tabId, state, 'manual', error.code || error.message || 'policy-action-failed'); }
  }
  function observe(tabId, frame) {
    const owner = capture(tabId);
    if (!owner?.live || !frame?.valid) return;
    let state = states.get(tabId);
    if (state && !sameOwner(state.owner, owner)) { clear(tabId); state = null; }
    if (state && Number(frame.seq) < Number(state.lastSeenSeq)) return;
    if (state) state.lastSeenSeq = frame.seq;
    const dialog = inspectCodexPolicyDialog(frame.text);
    if (!dialog) {
      if (state && frame.seq > state.frameSeq && isComposer(frame)) {
        if (state.timer) clearTimer(state.timer);
        state.resultFrameSeq = frame.seq;
        setPhase(tabId, state, 'handled', 'committed-composer');
      }
      return;
    }
    if (state && state.type === dialog.type && state.phase !== 'handled') {
      if (state.phase === 'awaiting-frame' && !state.actionWritten && frame.seq > state.frameSeq) void act(tabId, state);
      return;
    }
    if (state?.phase === 'handled' && state.operationalTurnId && !state.resultFrameSeq && state.actionWritten) {
      // A live turn permits normal queued-input behavior, but does not prove
      // the old modal choice. If it reappears, never choose it a second time.
      setPhase(tabId, state, 'manual', 'dialog-remains-after-operational-turn');
      return;
    }
    if (state?.phase === 'handled' && frame.seq <= state.resultFrameSeq) return;
    if (state?.timer) clearTimer(state.timer);
    if (state?.deadlineTimer) clearTimer(state.deadlineTimer);
    const preferences = readPolicy(tabId);
    const policy = dialog.type === 'usage-exhaustion'
      ? preferences.usage === 'stop-all' ? 'stop-all' : 'continue'
      : resolveCodexResumeGoalPreference(preferences.resumeOverride, preferences.resumeGoal) ? 'resume' : 'leave-paused';
    state = { id: 'codex-policy-' + (++sequence), owner, type: dialog.type, policy,
      detectedAt: now(), frameSeq: frame.seq, lastSeenSeq: frame.seq, phase: null, actionWritten: false, timer: null };
    states.set(tabId, state);
    setPhase(tabId, state, 'detected', 'committed-provider-dialog');
    state.deadlineTimer = setTimer(() => {
      if (current(tabId, state) && !state.actionWritten && state.phase !== 'handled') {
        setPhase(tabId, state, 'manual', 'policy-action-deadline');
      }
    }, actionMs);
    state.deadlineTimer?.unref?.();
    if (!dialog.interactive) { setPhase(tabId, state, 'manual', 'dialog-options-unproven'); return; }
    void act(tabId, state);
  }
  function read(tabId) {
    const state = states.get(tabId);
    if (!state || !current(tabId, state) || state.phase === 'handled') return null;
    return { type: state.type, phase: state.phase, policy: state.policy, operationId: state.id,
      reason: state.reason, actionWritten: state.actionWritten, manualActionRequired: state.phase === 'manual' };
  }
  function observeOperationalTurn(tabId, turnId) {
    const state = states.get(tabId);
    if (!state || !state.actionWritten || !turnId || turnId === state.owner.turnId
      || !current(tabId, state, true) || state.phase === 'handled') return false;
    state.operationalTurnId = turnId;
    // Not an acknowledgement of the selected Goal/fallback, and never a
    // delivery confirmation. Preserve the established turn-ready contract.
    setPhase(tabId, state, 'handled', 'current-turn-operational:' + turnId);
    return true;
  }
  return { observe, observeOperationalTurn, read, clear };
}

// Stop is the existing authoritative process scenario, not composer Escape.
// Freeze the applicable jobs once; a replacement on the same tab is not a target.
async function stopCodexPolicyTargets({ tabIds, capture, stop }) {
  const targets = [...new Set(tabIds)].map(tabId => ({ tabId, owner: capture(tabId) }))
    .filter(target => target.owner?.live);
  const results = await Promise.all(targets.map(async ({ tabId, owner }) => {
    const guard = () => sameOwner(owner, capture(tabId));
    if (!guard()) return { tabId, success: false, error: 'policy-stop-owner-changed' };
    try { return { tabId, ...await stop(tabId, guard) }; }
    catch (error) { return { tabId, success: false, error: error.code || error.message }; }
  }));
  return { success: results.every(result => result.success === true), results };
}

function projectCodexPolicyRuntime(base, policy) {
  if (!policy || base.manualActionType === 'auth-required') return base;
  const manual = policy.manualActionRequired === true;
  const message = policy.type === 'usage-exhaustion'
    ? manual ? 'Codex ждёт выбора после исчерпания лимита. Откройте терминал.' : 'Codex: обрабатывается лимит использования'
    : manual ? 'Завершите выбор для Goal в терминале.' : 'Codex: выбирается действие для Goal';
  return { ...base, runtimePolicy: policy, inputReady: false, textReady: false,
    // A live modal is not an absent process. Only a known unhandled modal
    // terminates the starting presentation; it never invents input readiness.
    ...(manual && base.sessionStatus === 'starting' ? { sessionStatus: base.busy ? 'busy' : 'active' } : {}),
    startupFailed: false, startupError: null,
    manualActionRequired: manual, manualActionType: manual ? policy.type : null,
    lastNotReady: { reason: 'codex_' + policy.type.replace(/-/g, '_') + (manual ? '_action_required' : '_pending'),
      blockers: [policy.type], message, operationId: policy.operationId, policy: policy.policy,
      actionWritten: policy.actionWritten, resultReason: policy.reason } };
}

module.exports = { inspectCodexPolicyDialog, sameCodexPolicyOwner: sameOwner,
  createCodexRuntimePolicyController, stopCodexPolicyTargets, projectCodexPolicyRuntime };
