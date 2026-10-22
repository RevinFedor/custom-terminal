'use strict';

const { randomUUID } = require('node:crypto');
const { inspectCodexUsagePrompt } = require('./codex-usage-prompt');
const { inspectCodexResumeGoalPrompt, resolveCodexResumeGoalPreference } = require('./codex-resume-goal-prompt');

function inspectCodexPolicyDialog(text) {
  const usage = inspectCodexUsagePrompt(text);
  if (usage.visible) return { ...usage, type: 'usage-exhaustion' };
  const goal = inspectCodexResumeGoalPrompt(text);
  return goal.visible && !goal.missing.includes('footer') ? { type: 'resume-goal', visible: true,
    interactive: goal.interactiveVisible, selectedIndex: goal.firstOptionSelected === goal.secondOptionSelected
      ? null : goal.firstOptionSelected ? 1 : 2,
    options: [{ index: 1, label: 'Resume goal' }, { index: 2, label: 'Leave paused' }] } : null;
}

const sameOwner = (a, b) => !!a?.terminal && !!b?.live && a.terminal === b.terminal
  && a.lifecycleGeneration === b.lifecycleGeneration && a.runSeq === b.runSeq;

function goalDialogKey(frame) {
  const goal = inspectCodexResumeGoalPrompt(frame.text);
  if (!goal.visible) return null;
  // Committed main frames are plain text. Selection/wrapping may change, the
  // actual Goal must not change underneath an operation authorizing Enter.
  return frame.text.slice(goal.titleIndex).replace(/^[\t ]*[›❯»>][\t ]*(?=(?:1\.[\t ]*Resume|2\.[\t ]*Leave)\b)/gm, '')
    .replace(/\s+/g, ' ').trim();
}

function createCodexRuntimePolicyController({ capture, readFrame, withWriteLock, sendKey,
  readPolicy, isComposer, stopAll, publish, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, confirmationMs = 3000, actionMs = 10000,
  maxGoalActionRequests = 1024, log = () => {} }) {
  const states = new Map();
  const goalRequests = new Map();
  const operationNamespace = randomUUID();
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
    if (phase === 'manual' || phase === 'handled') {
      if (state.timer) clearTimer(state.timer);
      if (state.deadlineTimer) clearTimer(state.deadlineTimer);
      state.timer = state.deadlineTimer = null;
    }
    const failed = state.type === 'resume-goal'
      && (phase === 'manual' && reason !== 'user-choice-required' || reason === 'provider-result-unobserved');
    const captureDiagnostic = failed && !state.failureReported;
    if (captureDiagnostic) state.failureReported = true;
    publish(tabId, { operationId: state.id, type: state.type, policy: state.policy,
      phase, reason, actionWritten: state.actionWritten, detectedAt: state.detectedAt,
      frameSeq: state.frameSeq, resultFrameSeq: state.resultFrameSeq || null,
      actionAttempted: !!state.actionAttempted, requestId: state.goalRequest?.requestId || null,
      actionFrameSeq: state.actionFrameSeq || null,
      writeAttemptAt: state.writeAttemptAt || null, writeReturnedAt: state.writeReturnedAt || null,
      captureDiagnostic, owner: { lifecycleGeneration: state.owner.lifecycleGeneration,
        runSeq: state.owner.runSeq, inputRevision: state.owner.inputRevision } });
    log('[CodexRuntimePolicy] tab=' + tabId + ' operation=' + state.id + ' type=' + state.type
      + ' policy=' + state.policy + ' phase=' + phase + ' reason=' + reason
      + ' actionWritten=' + state.actionWritten + ' frame=' + state.frameSeq
      + ' request=' + (state.goalRequest?.requestId || '-') + ' attempted=' + !!state.actionAttempted
      + ' choiceConfirmed=' + !!state.choiceConfirmed);
  }
  function clear(tabId) {
    const old = states.get(tabId);
    if (old?.timer) clearTimer(old.timer);
    if (old?.deadlineTimer) clearTimer(old.deadlineTimer);
    states.delete(tabId);
    if (old?.goalRequest && !old.goalRequest.result) {
      old.goalRequest.result = goalRequestState(old.goalRequest);
      old.goalRequest.state = null;
    }
  }
  function armDeadline(tabId, state) {
    if (state.deadlineTimer) clearTimer(state.deadlineTimer);
    const token = state.actionToken;
    state.deadlineTimer = setTimer(() => {
      if (current(tabId, state) && state.actionToken === token && state.phase !== 'handled') {
        setPhase(tabId, state, 'manual', state.actionAttempted ? 'policy-key-outcome-unknown' : 'policy-action-deadline');
      }
    }, actionMs);
    state.deadlineTimer?.unref?.();
  }
  function confirmComposer(tabId, state, frame, reason) {
    state.resultFrameSeq = frame.seq;
    if (current(tabId, state, true)) state.composerProofSeq = frame.seq;
    state.choiceConfirmed = state.actionWritten && state.composerProofSeq > state.actionFrameSeq;
    setPhase(tabId, state, 'handled', reason);
  }
  function awaitUnwrittenFrame(tabId, state, reason) {
    setPhase(tabId, state, 'awaiting-frame', reason);
    if (!state.timer) {
      const token = state.actionToken;
      state.timer = setTimer(() => {
        if (current(tabId, state) && state.actionToken === token && state.phase === 'awaiting-frame') {
          setPhase(tabId, state, 'manual', 'current-frame-unavailable');
        }
      }, confirmationMs);
      state.timer?.unref?.();
    }
  }
  async function act(tabId, state) {
    const token = state.actionToken;
    if (state.phase === 'manual' || state.phase === 'handled' || state.actionAttempted || state.inflightToken === token) return;
    if (!current(tabId, state, true)) { setPhase(tabId, state, 'manual', 'input-owner-changed'); return; }
    state.inflightToken = token;
    if (state.policy === 'stop-all') {
      setPhase(tabId, state, 'applying', 'common-process-stop');
      if (!stopAllWork) {
        stopAllWork = Promise.resolve().then(stopAll);
        stopAllWork.finally(() => { stopAllWork = null; }).catch(() => {});
      }
      const result = await stopAllWork.catch(error => ({ success: false, error: error.message }));
      setPhase(tabId, state, result?.success === true ? 'handled' : 'manual',
        result?.success === true ? 'processes-stopped' : 'stop-unconfirmed');
      state.inflightToken = null;
      return;
    }
    try {
      await withWriteLock(state.owner.terminal, async owner => {
        if (state.actionToken !== token) return;
        if (!current(tabId, state, true)) { setPhase(tabId, state, 'manual', 'input-owner-changed'); return; }
        if (state.phase === 'manual' || state.phase === 'handled' || state.actionAttempted) return;
        if (state.timer) { clearTimer(state.timer); state.timer = null; }
        setPhase(tabId, state, 'applying', 'select-provider-option');
        for (let step = 0; step < 4; step++) {
          const frame = await readFrame(tabId);
          if (state.actionToken !== token) return;
          if (!current(tabId, state, true)) { setPhase(tabId, state, 'manual', 'input-owner-changed'); return; }
          if (state.phase === 'manual' || state.phase === 'handled') return;
          if (!frame?.valid) { awaitUnwrittenFrame(tabId, state, 'current-frame-unavailable'); return; }
          if (!Number.isSafeInteger(frame.seq) || frame.seq < state.lastSeenSeq
            || (frame.seq === state.lastSeenSeq && frame.text !== state.lastFrame.text)) {
            setPhase(tabId, state, 'manual', 'stale-current-frame'); return;
          }
          const dialog = inspectCodexPolicyDialog(frame.text);
          if (!dialog || dialog.type !== state.type) {
            if (isComposer(frame)) confirmComposer(tabId, state, frame, 'composer-already-ready');
            else awaitUnwrittenFrame(tabId, state, 'dialog-changed-before-action');
            return;
          }
          if (state.type === 'resume-goal' && goalDialogKey(frame) !== state.goalKey) {
            setPhase(tabId, state, 'manual', 'goal-dialog-changed'); return;
          }
          if (!dialog.interactive || !dialog.selectedIndex) { setPhase(tabId, state, 'manual', 'option-unproven'); return; }
          if (state.selectionFrameSeq != null && (frame.seq <= state.selectionFrameSeq
            || dialog.selectedIndex !== state.expectedSelectedIndex)) {
            setPhase(tabId, state, 'manual', 'option-selection-not-confirmed'); return;
          }
          state.lastSeenSeq = frame.seq;
          state.lastFrame = { seq: frame.seq, text: frame.text };
          const target = state.type === 'usage-exhaustion' ? dialog.targetIndex : state.policy === 'leave-paused' ? 2 : 1;
          const key = dialog.selectedIndex === target ? '\r' : dialog.selectedIndex < target ? '\x1b[B' : '\x1b[A';
          const allowed = () => current(tabId, state, true) && state.actionToken === token
            && state.phase !== 'manual' && state.phase !== 'handled';
          if (key === '\r') {
            state.actionAttempted = true; state.actionFrameSeq = frame.seq;
            state.writeAttemptAt = now(); state.writeReturnedAt = null;
          }
          else {
            state.selectionFrameSeq = frame.seq;
            state.expectedSelectedIndex = dialog.selectedIndex + (key === '\x1b[B' ? 1 : -1);
          }
          const written = await sendKey(tabId, key, { owner, expectedFrame: frame, guard: allowed, dialogType: state.type });
          if (key === '\r') state.writeReturnedAt = now();
          if (written?.written !== true && written?.written !== false) {
            setPhase(tabId, state, 'manual', 'policy-key-outcome-unknown'); return;
          }
          if (written.written === false) {
            if (key === '\r') state.actionAttempted = false;
            else state.selectionFrameSeq = null;
            if (state.actionToken !== token || state.phase === 'manual' || state.phase === 'handled') return;
            if (current(tabId, state, true)) awaitUnwrittenFrame(tabId, state, written?.reason || 'write-not-proven');
            else setPhase(tabId, state, 'manual', 'input-owner-changed');
            return;
          }
          state.keyWritten = true;
          if (key === '\r') {
            state.actionWritten = true;
            state.choiceConfirmed = state.composerProofSeq > state.actionFrameSeq;
            if (state.deadlineTimer) clearTimer(state.deadlineTimer);
            state.actionFrameSeq = frame.seq;
            // A committed reply can arrive synchronously from the write/await.
            // Do not resurrect its already settled operation as confirming.
            if (!current(tabId, state) || state.phase === 'handled' || state.phase === 'manual') return;
            setPhase(tabId, state, 'confirming', 'waiting-committed-composer');
            state.timer = setTimer(async () => {
              if (!current(tabId, state) || state.actionToken !== token || state.phase !== 'confirming') return;
              const latest = await readFrame(tabId).catch(() => null);
              if (!current(tabId, state) || state.actionToken !== token || state.phase !== 'confirming') return;
              state.timer = null;
              if (current(tabId, state, true) && latest?.valid && latest.seq > state.actionFrameSeq
                && latest.seq >= state.lastSeenSeq && isComposer(latest)) {
                confirmComposer(tabId, state, latest, 'committed-composer');
              } else {
                if (state.type === 'resume-goal' && current(tabId, state, true)) {
                  const fresh = latest?.valid && Number.isSafeInteger(latest.seq)
                    && latest.seq > state.actionFrameSeq && latest.seq >= state.lastSeenSeq
                    && (latest.seq !== state.lastSeenSeq || latest.text === state.lastFrame.text);
                  const dialog = fresh ? inspectCodexPolicyDialog(latest.text) : null;
                  if (dialog?.type === 'resume-goal' && goalDialogKey(latest) !== state.goalKey) {
                    setPhase(tabId, state, 'manual', 'goal-dialog-changed'); return;
                  }
                  if (dialog?.type !== 'resume-goal' || !dialog.interactive || !dialog.selectedIndex) {
                    // A pre-Enter frame or unfinished redraw does not prove a
                    // live menu requiring user action. Keep the same unwritten
                    // Send waiting on events within its ORIGINAL preparation
                    // scope. No new timer, readiness grant or repeat Enter.
                    state.confirmationUnobserved = true;
                    setPhase(tabId, state, 'confirming', 'provider-result-unobserved');
                    return;
                  }
                }
                if (current(tabId, state, true) && latest?.valid && Number.isSafeInteger(latest.seq)
                  && latest.seq > state.lastSeenSeq && state.type === 'resume-goal'
                  && inspectCodexPolicyDialog(latest.text)?.type === state.type && goalDialogKey(latest) === state.goalKey) {
                  state.lastSeenSeq = latest.seq;
                  state.lastFrame = { seq: latest.seq, text: latest.text };
                }
                setPhase(tabId, state, 'manual', 'provider-choice-not-confirmed');
              }
            }, confirmationMs);
            state.timer?.unref?.();
            return;
          }
        }
        setPhase(tabId, state, 'manual', 'option-selection-incomplete');
      });
    } catch (error) {
      if (state.actionToken === token) setPhase(tabId, state, 'manual',
        state.actionAttempted ? 'policy-key-outcome-unknown' : error.code || error.message || 'policy-action-failed');
    } finally {
      if (state.inflightToken === token) state.inflightToken = null;
    }
  }
  function observe(tabId, frame) {
    const owner = capture(tabId);
    if (!owner?.live || !frame?.valid || !Number.isSafeInteger(frame.seq)) return;
    let state = states.get(tabId);
    if (state && !sameOwner(state.owner, owner)) { clear(tabId); state = null; }
    if (state && Number(frame.seq) < Number(state.lastSeenSeq)) return;
    if (state && frame.seq === state.lastSeenSeq && frame.text !== state.lastFrame.text) return;
    const dialog = inspectCodexPolicyDialog(frame.text);
    let manualReason = null;
    if (state?.type === 'resume-goal' && dialog?.type === 'resume-goal' && state.phase !== 'handled'
      && (owner.inputRevision !== state.owner.inputRevision || goalDialogKey(frame) !== state.goalKey)) {
      manualReason = owner.inputRevision !== state.owner.inputRevision ? 'input-owner-changed' : 'goal-dialog-changed';
      clear(tabId); state = null;
    }
    if (state) {
      state.lastSeenSeq = frame.seq;
      state.lastFrame = { seq: frame.seq, text: frame.text };
    }
    if (!dialog) {
      if (state && frame.seq > state.frameSeq && isComposer(frame)) {
        confirmComposer(tabId, state, frame, 'committed-composer');
      }
      return;
    }
    if (state && state.type === dialog.type && state.phase !== 'handled') {
      if (state.type === 'resume-goal' && state.actionWritten && state.confirmationUnobserved
        && frame.seq > state.actionFrameSeq && dialog.interactive && dialog.selectedIndex) {
        setPhase(tabId, state, 'manual', 'provider-choice-not-confirmed');
      }
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
    if (state) clear(tabId);
    const preferences = readPolicy(tabId);
    const resume = resolveCodexResumeGoalPreference(preferences.resumeOverride, preferences.resumeGoal);
    const policy = dialog.type === 'usage-exhaustion'
      ? preferences.usage === 'stop-all' ? 'stop-all' : 'continue'
      : resume === null ? 'manual' : resume ? 'resume' : 'leave-paused';
    state = { id: 'codex-policy-' + operationNamespace + '-' + (++sequence), owner, type: dialog.type, policy,
      detectedAt: now(), frameSeq: frame.seq, lastSeenSeq: frame.seq, phase: null, actionWritten: false,
      actionAttempted: false, actionToken: {}, timer: null,
      lastFrame: { seq: frame.seq, text: frame.text }, goalKey: dialog.type === 'resume-goal' ? goalDialogKey(frame) : null };
    states.set(tabId, state);
    setPhase(tabId, state, 'detected', 'committed-provider-dialog');
    if (manualReason) { setPhase(tabId, state, 'manual', manualReason); return; }
    if (!dialog.interactive) { setPhase(tabId, state, 'manual', 'dialog-options-unproven'); return; }
    if (policy === 'manual') { setPhase(tabId, state, 'manual', 'user-choice-required'); return; }
    armDeadline(tabId, state);
    void act(tabId, state);
  }
  function read(tabId) {
    const state = states.get(tabId);
    if (!state || !current(tabId, state) || state.phase === 'handled') return null;
    return { type: state.type, phase: state.phase, policy: state.policy, operationId: state.id,
      reason: state.reason, actionWritten: state.actionWritten, manualActionRequired: state.phase === 'manual' };
  }

  function goalActionState(tabId, state) {
    const owner = capture(tabId);
    if (!state || state.type !== 'resume-goal') return {
      operationId: null, status: 'unavailable', reason: owner?.live ? 'no-goal-dialog' : 'runtime-not-live',
      availableActions: [], actionWritten: false, actionAttempted: false, keyWritten: false,
      composerReady: false, choiceConfirmed: false,
    };
    const owned = states.get(tabId) === state && sameOwner(state.owner, owner);
    const inputOwned = owned && state.owner.inputRevision === owner.inputRevision;
    const dialog = inspectCodexPolicyDialog(state.lastFrame.text);
    const provenDialog = inputOwned && dialog?.type === 'resume-goal' && dialog.interactive && !!dialog.selectedIndex
      && goalDialogKey(state.lastFrame) === state.goalKey;
    const recoveryAvailable = !!(state.actionAttempted && state.phase === 'manual' && !state.inflightToken
      && provenDialog && state.lastSeenSeq > Math.max(state.actionFrameSeq || 0, state.selectionFrameSeq || 0));
    let status = 'unavailable';
    let reason = state.reason;
    if (state.choiceConfirmed) status = 'confirmed';
    else if (state.actionAttempted) status = inputOwned && (state.phase === 'applying'
      || state.phase === 'confirming' && !state.confirmationUnobserved)
      ? 'pending' : 'unknown';
    else if (!owned) reason = owner?.live ? 'goal-owner-changed' : 'runtime-not-live';
    else if (!inputOwned) reason = 'input-owner-changed';
    else if (state.phase !== 'manual' && state.phase !== 'handled') status = 'pending';
    else if (state.phase === 'manual' && provenDialog
      && (state.selectionFrameSeq == null || (state.lastSeenSeq > state.selectionFrameSeq
        && dialog.selectedIndex === state.expectedSelectedIndex))) status = 'available';
    return { operationId: state.id, status, reason, phase: state.phase, policy: state.policy,
      requestId: state.goalRequest?.requestId || null,
      action: state.goalRequest?.action || (state.policy === 'manual' ? null : state.policy),
      availableActions: status === 'available' || recoveryAvailable ? ['resume', 'leave-paused'] : [],
      recoveryAvailable, recoveryFrameSeq: recoveryAvailable ? state.lastSeenSeq : null,
      selectedIndex: dialog?.type === 'resume-goal' ? dialog.selectedIndex : null,
      initialFrameSeq: state.frameSeq, frameSeq: state.lastSeenSeq, resultFrameSeq: state.resultFrameSeq || null,
      actionWritten: state.actionWritten, actionAttempted: state.actionAttempted, keyWritten: !!state.keyWritten,
      writeAttemptAt: state.writeAttemptAt || null, writeReturnedAt: state.writeReturnedAt || null,
      composerReady: !!state.composerProofSeq, choiceConfirmed: !!state.choiceConfirmed,
      runtimeLive: !!owner?.live, currentOperation: owned,
      owner: { lifecycleGeneration: state.owner.lifecycleGeneration, runSeq: state.owner.runSeq,
        inputRevision: state.owner.inputRevision, sessionId: state.owner.sessionId || null } };
  }
  function goalRequestState(record) {
    return record.result ? { ...record.result, availableActions: [...record.result.availableActions],
      ...(record.result.owner ? { owner: { ...record.result.owner } } : {}) }
      : { ...goalActionState(record.tabId, record.state), accepted: true,
        requestId: record.requestId, operationId: record.operationId, action: record.action };
  }
  // Pure snapshots only: in particular, a GET never observes a frame, starts
  // an automatic policy or revives a stopped runtime.
  function readGoalAction(tabId, { requestId } = {}) {
    if (requestId != null) {
      const record = goalRequests.get(requestId);
      if (record?.tabId === tabId) return goalRequestState(record);
      return { operationId: null, requestId, status: 'unavailable', reason: 'goal-request-not-found',
        availableActions: [], actionWritten: false, actionAttempted: false, keyWritten: false,
        composerReady: false, choiceConfirmed: false };
    }
    return goalActionState(tabId, states.get(tabId));
  }
  function applyGoalAction(tabId, { operationId, requestId, action } = {}) {
    const reject = reason => ({ operationId: operationId || null, requestId: requestId || null,
      action, accepted: false, status: 'rejected', reason, availableActions: [],
      actionWritten: false, actionAttempted: false, keyWritten: false, composerReady: false, choiceConfirmed: false });
    const validId = (value, maxLength = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
      && !/[\x00-\x1f\x7f]/.test(value);
    if (!validId(tabId, 4096) || !validId(operationId) || !validId(requestId)
      || (action !== 'resume' && action !== 'leave-paused')) return reject('invalid-goal-action');
    const prior = goalRequests.get(requestId);
    if (prior) {
      if (prior.tabId !== tabId || prior.operationId !== operationId || prior.action !== action) {
        log('[CodexGoalAction] tab=' + tabId + ' request=' + requestId + ' rejected=goal-request-conflict');
        return reject('goal-request-conflict');
      }
      return { ...goalRequestState(prior), replayed: true };
    }
    // Never evict an idempotency receipt and make an old request executable.
    // A new controller has a fresh operation namespace, including after restart.
    if (goalRequests.size >= maxGoalActionRequests) return reject('goal-request-capacity');
    const state = states.get(tabId);
    const record = { tabId, operationId, requestId, action, state };
    goalRequests.set(requestId, record);
    const fail = reason => {
      record.result = reject(reason);
      record.state = null;
      log('[CodexGoalAction] tab=' + tabId + ' operation=' + operationId + ' request=' + requestId + ' rejected=' + reason);
      return goalRequestState(record);
    };
    if (!state || state.type !== 'resume-goal') return fail('no-goal-dialog');
    if (state.id !== operationId) return fail('stale-goal-operation');
    const view = goalActionState(tabId, state);
    if (view.status !== 'available' && !view.recoveryAvailable) return fail(view.status === 'pending' ? 'goal-action-pending'
      : view.status === 'unknown' ? 'goal-action-outcome-unknown'
        : view.status === 'confirmed' ? 'goal-choice-already-confirmed' : view.reason || 'goal-action-unavailable');
    if (state.goalRequest) {
      state.goalRequest.result = { ...goalRequestState(state.goalRequest),
        availableActions: [], recoveryAvailable: false, recoveryFrameSeq: null, supersededByRequestId: requestId };
      state.goalRequest.state = null;
    }
    // This is a new explicit action, never a retry of the old unknown receipt.
    // The newer committed dialog is re-read under the same PTY lock; the
    // lastSeenSeq/content and final sendKey frame guard remain authoritative.
    if (view.recoveryAvailable) {
      state.actionWritten = state.actionAttempted = state.choiceConfirmed = state.keyWritten = false;
      state.confirmationUnobserved = false;
      state.actionFrameSeq = state.resultFrameSeq = state.composerProofSeq = state.selectionFrameSeq = null;
      state.writeAttemptAt = state.writeReturnedAt = null;
      state.expectedSelectedIndex = null;
    }
    state.goalRequest = record;
    state.policy = action;
    state.actionToken = {};
    state.failureReported = false;
    setPhase(tabId, state, 'detected', view.recoveryAvailable ? 'explicit-goal-recovery' : 'explicit-goal-action');
    armDeadline(tabId, state);
    void act(tabId, state);
    return goalRequestState(record);
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
  return { observe, observeOperationalTurn, read, readGoalAction, applyGoalAction, clear };
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
