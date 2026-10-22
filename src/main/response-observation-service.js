'use strict';
const { hasPendingAgentGoalWork } = require('../shared/agent-work-completion.cjs');

const { createOrchestrationProofCoordinator } = require('./orchestration-proof-coordinator');
const { isOrchestrationCompletionBlocking, isSourceNotificationBlocked } = require('../shared/orchestration-activity.cjs');
const { isResponseObservation, normalizeResponseSubject } = require('./orchestration-response-observation');
const { classifyOrchestrationResultProbe } = require('./orchestration-result-proof');
const { responseObservationSubjectKey } = require('./response-observation-evidence');
const { lifecycleExecutionContext, executionContextsMatch, isAbortedReason } = require('./orchestration-runs');

const terminal = run => ['completed', 'failed', 'cancelled'].includes(run?.status);
const childRuns = (runs, targetTabId) => runs.filter(run => run.sourceTabId === targetTabId
  && isOrchestrationCompletionBlocking(run));
const childRevision = runs => JSON.stringify(runs.map(run => [run.runId, run.status, run.updatedAt,
  run.notificationStatus, run.sourceFollowupPending, run.resultComplete]).sort((a, b) => a[0].localeCompare(b[0])));

function createResponseObservationService({ store, readState, readResponse, evidence,
  subscribe, unsubscribe, onChanged, onSettled, readRestartBinding = null, log = console }) {
  const inflight = new Map();
  const trailing = new Set();
  const responseReads = new Map();
  let stopped = false;
  const evidenceKey = run => run.restartBinding?.evidenceKey || run.runId;
  function restartFor(run) {
    const original = evidence.readSelected(run.runId);
    // A real original final wins, even if a restart was captured concurrently.
    if (original?.result?.complete === true && original.result.sourceVerified === true) return null;
    if (original?.failure && !isAbortedReason(original.failure.code)) return null;
    return readRestartBinding?.(run) || null;
  }
  const restartKey = binding => binding ? JSON.stringify([binding.operationId, binding.pending,
    binding.evidenceKey, binding.subject || null]) : null;
  const effectiveRun = (run, binding) => binding && !binding.pending ? { ...run,
    observationTarget: binding.target, observationSubject: binding.subject,
    observationCurrentTurnSubject: binding.subject, restartBinding: binding } : run;
  async function refresh(run) {
    const current = await store.getInternal(run.runId);
    if (!current || terminal(current)) return null;
    const binding = restartFor(current);
    if (current.observationRevision !== run.observationRevision
      || restartKey(binding) !== restartKey(run.restartBinding || null)) {
      trailing.add(run.runId); return null;
    }
    return effectiveRun(current, binding);
  }
  const coordinator = createOrchestrationProofCoordinator({
    label: 'response-observation', subscribe, unsubscribe,
    onWake: runId => reconcile(runId, 'transcript'), log,
  });

  async function publish(result, reason) {
    if (result?.changed?.length) onChanged(result.changed, reason);
    for (const run of result?.settled || []) {
      await coordinator.release(run.runId, 'settled');
      await onSettled(run, reason);
    }
    return result?.run;
  }

  async function settle(run, result, failure) {
    const saved = failure ? evidence.freezeFailure(evidenceKey(run), failure) : evidence.readSelected(evidenceKey(run));
    if (saved?.failure) failure = saved.failure;
    else if (saved?.result) { result = saved.result; failure = null; }
    if (!failure && result?.complete !== true) {
      const verdict = classifyOrchestrationResultProbe(result, { authoritativeCompletion: true });
      failure = { code: verdict.code || 'response_unavailable', error: verdict.message || 'Ответ не завершён' };
    }
    return publish(await store.settleResponseObservation(run.runId, {
      expectedRevision: run.observationRevision, result,
      error: failure?.error, code: failure?.code, evidenceCommitted: !!saved,
    }), failure ? 'response-observation-failed' : 'response-observation-completed');
  }

  async function wait(run, children, reason) {
    const ids = children.map(child => child.runId).sort();
    const uncertain = reason.startsWith('runtime-unknown') || reason === 'response_busy_unknown' || reason === 'child-attention';
    const status = uncertain ? 'waiting_recovery' : ids.length ? 'waiting_descendants' : 'running';
    if (run.status === status && JSON.stringify(run.waitingOnRunIds) === JSON.stringify(ids)
      && run.observationWaitReason === reason) return;
    const updated = await store.setResponseObservationWait(run.runId, {
      expectedRevision: run.observationRevision, status, waitingOnRunIds: ids, observationWaitReason: reason,
      error: reason === 'child-attention' ? 'Связанный запрос наблюдаемой вкладки требует внимания'
        : uncertain ? 'Не удалось подтвердить состояние наблюдаемой вкладки' : null });
    if (updated) onChanged([updated], 'response-observation-waiting');
  }

  async function readOnce(request, revision) {
    const key = JSON.stringify([request.tabId, request.expectedSessionId, request.subject, request.maxChars, revision]);
    let work = responseReads.get(key);
    if (!work) {
      work = Promise.resolve().then(() => readResponse(request));
      responseReads.set(key, work);
      void work.finally(() => { if (responseReads.get(key) === work) responseReads.delete(key); }).catch(() => {});
    }
    return work;
  }

  async function readRuntime(run, phase) {
    const state = await readState(run.targetTabId);
    if (stopped || state?.known === true
      || (state?.code || state?.error) !== 'response_state_changed') return state;
    // A failed compare-and-set is not an unavailable process. Acquire one
    // fresh transaction on that observed change, without a timer or a loop.
    // The fresh result still passes every owner/work/result guard below.
    log.log('[ResponseObservation] runtime read invalidated run=' + run.runId
      + ' phase=' + phase + ' recheck=1');
    return readState(run.targetTabId);
  }

  async function pass(runId, reason) {
    let run = await store.getInternal(runId);
    if (stopped || !isResponseObservation(run)) return;
    if (terminal(run)) { await coordinator.release(runId, 'terminal'); return; }
    const binding = restartFor(run);
    if (binding?.pending) {
      await coordinator.release(runId, 'build-continue-pending');
      return wait(run, [], 'build-continue:' + binding.operationId);
    }
    run = effectiveRun(run, binding);
    const selected = evidence.readSelected(evidenceKey(run));
    if (selected?.failure) return settle(run, null, selected.failure);
    const target = run.observationTarget;
    if (!target?.sessionId) return settle(run, null, { code: 'response_target_unresolved', error: 'Не удалось определить наблюдаемую сессию' });
    if (selected?.subject && (selected.subject.sessionId !== target.sessionId || selected.subject.toolType !== target.toolType)) {
      throw new Error('response_observation_evidence_owner_mismatch');
    }
    let subject = selected?.subject || run.observationSubject;
    const currentTurnOnly = run.waitForDescendants === false && !!run.observationCurrentTurnSubject;
    let result = selected?.result;
    if (subject || currentTurnOnly) result = evidence.read(evidenceKey(run), subject || run.observationCurrentTurnSubject)?.result;
    if (!result) {
      const state = await readRuntime(run, 'admission');
      if (stopped) return;
      if (state?.exists === false || state?.code === 'tab_not_found') {
        return settle(run, null, { code: 'response_target_closed', error: 'Наблюдаемая вкладка закрыта' });
      }
      if (state?.known !== true) return wait(run, [], 'runtime-unknown:' + (state?.code || state?.error || 'unavailable'));
      if (state.sessionId !== target.sessionId || state.toolType !== target.toolType) {
        return settle(run, null, { code: 'response_target_changed', error: 'Сессия наблюдаемой вкладки изменилась' });
      }
      const children = run.waitForDescendants === false ? [] : childRuns(await store.listAll(), run.targetTabId);
      const backgroundBusy = run.waitForDescendants !== false && Number(state.backgroundWorkCount) > 0;
      const observedExecution = run.observationCurrentTurnSubject?.targetExecutionContext;
      const liveExecution = state.currentSubject?.targetExecutionContext || state.executionContext;
      const ownTurnStillBusy = currentTurnOnly && state.busy === true
        && executionContextsMatch(observedExecution, liveExecution)
        && observedExecution.generation === liveExecution.generation;
      if (ownTurnStillBusy || ((!subject || run.restartBinding) && !currentTurnOnly
        && (state.busy === true || backgroundBusy || children.length || hasPendingAgentGoalWork(state)))) {
        await coordinator.release(runId, 'waiting-lifecycle');
        return wait(run, children, !state.busy && children.some(child => child.status === 'waiting_recovery' || isSourceNotificationBlocked(child))
          ? 'child-attention' : state.busy ? 'target-busy'
            : hasPendingAgentGoalWork(state) ? 'target-goal-' + (state.goalWork.phase || 'pending') : 'target-child-work');
      }
      const watched = await coordinator.arm({ runId, toolType: target.toolType, sessionId: target.sessionId,
        cwd: run.targetCwd || run.targetProjectPath });
      if (watched?.success !== true) throw new Error(watched?.error || 'response_observation_watch_unavailable');
      const response = await readOnce({ tabId: run.targetTabId, expectedSessionId: target.sessionId,
        subject: subject || run.observationCurrentTurnSubject || null, maxChars: 250_000 }, state.revision);
      if (stopped) return;
      run = await refresh(run);
      if (!run) return;
      if (run.restartBinding && currentTurnOnly) {
        const current = await readRuntime(run, 'after-restart-response');
        if (current?.known !== true) return wait(run, [], 'runtime-unknown:restart-read');
        if (current.sessionId !== target.sessionId || current.toolType !== target.toolType) {
          return settle(run, null, { code: 'response_target_changed', error: 'Продолженная вкладка изменилась во время чтения ответа' });
        }
        if (current.revision !== state.revision) { trailing.add(runId); return wait(run, [], 'target-changed-during-read'); }
      }
      if (response?.pending) return wait(run, children, response.reason || response.code || 'response-not-materialized');
      if (response?.error && !response.result) {
        return settle(run, null, { code: response.code || 'response_read_failed', error: response.error });
      }
      if (!response?.subject) {
        if (response?.error) return settle(run, null, { code: response.code || 'response_unavailable', error: response.error });
        return wait(run, children, 'response-subject-unavailable');
      }
      if ((!subject || run.restartBinding) && !currentTurnOnly) {
        const current = await readRuntime(run, 'after-response');
        const currentChildren = run.waitForDescendants === false ? [] : childRuns(await store.listAll(), run.targetTabId);
        if (current?.known !== true) return wait(run, currentChildren, 'runtime-unknown:changed-during-read');
        if (current.sessionId !== target.sessionId || current.toolType !== target.toolType) {
          return settle(run, null, { code: 'response_target_changed', error: 'Сессия изменилась во время чтения ответа' });
        }
        if (current.busy || hasPendingAgentGoalWork(current) || (run.waitForDescendants !== false && Number(current.backgroundWorkCount) > 0)
          || current.revision !== state.revision || childRevision(children) !== childRevision(currentChildren)) {
          trailing.add(runId);
          return wait(run, currentChildren, 'target-changed-during-read');
        }
      }
      result = response.result;
      const classification = classifyOrchestrationResultProbe(result, { authoritativeCompletion: true });
      if (result?.sourceVerified !== true || classification.kind === 'pending'
        || (classification.kind === 'complete' && result.found !== true)) {
        return wait(run, children, 'response-proof-pending');
      }
      subject = normalizeResponseSubject(response.subject);
      if (currentTurnOnly && responseObservationSubjectKey(subject)
        !== responseObservationSubjectKey(run.observationCurrentTurnSubject)) {
        return settle(run, null, { code: 'response_subject_changed', error: 'Чтение вернуло другой ход вместо выбранного' });
      }
      if (subject.sessionId !== target.sessionId || subject.toolType !== target.toolType) {
        return settle(run, null, { code: 'response_subject_mismatch', error: 'Ответ принадлежит другой сессии' });
      }
      run = await refresh(run);
      if (!run) return;
      if (run.restartBinding) result = { ...result, restartProvenance: run.restartBinding.provenance };
      const committed = evidence.freeze(evidenceKey(run), subject, result);
      if (committed.failure) return settle(run, null, committed.failure);
      subject = committed.subject;
      result = committed.result;
    }
    if (!run.observationSubject && !run.restartBinding) {
      await store.bindResponseObservationSubject(runId, subject || run.observationCurrentTurnSubject);
      run = await store.getInternal(runId);
      if (stopped || !run || terminal(run)) return;
    }
    if (result.complete !== true) {
      const classification = classifyOrchestrationResultProbe(result, { authoritativeCompletion: true });
      return settle(run, result, { code: classification.code || 'response_not_completed',
        error: classification.message || 'Наблюдаемая работа завершилась без успешного ответа' });
    }
    if (run.restartBinding && !await refresh(run)) return;
    log.log('[ResponseObservation] ready run=' + runId + ' target=' + run.targetTabId
      + ' session=' + target.sessionId.slice(0, 12) + ' reason=' + reason);
    return settle(run, result);
  }

  function reconcile(runId, reason = 'event') {
    if (stopped) return Promise.resolve();
    if (inflight.has(runId)) { trailing.add(runId); return inflight.get(runId); }
    const work = (async () => {
      do {
        trailing.delete(runId);
        await pass(runId, reason);
      } while (!stopped && trailing.delete(runId));
    })().catch(async error => {
      log.warn('[ResponseObservation] read failed run=' + runId + ' error=' + (error?.code || error?.message));
      const run = await store.getInternal(runId);
      if (!stopped && run && !terminal(run) && String(error?.code || error?.message).startsWith('build_continue_')) {
        await wait(run, [], 'runtime-unknown:' + (error.code || error.message)); return;
      }
      if (!stopped && run && !terminal(run)) await settle(run, null, {
        code: error?.code || 'response_observation_read_failed',
        error: 'Не удалось прочитать ожидаемый ответ: ' + String(error?.message || error),
      });
    }).finally(() => inflight.delete(runId));
    inflight.set(runId, work);
    return work;
  }

  async function arm(run) {
    if (!isResponseObservation(run) || terminal(run)) return;
    await reconcile(run.runId, 'registered');
  }

  async function wakeTarget(tabId, reason = 'target-event') {
    const runs = (await store.listForTab(tabId)).filter(run => isResponseObservation(run) && run.targetTabId === tabId);
    for (const run of runs) void reconcile(run.runId, reason);
  }

  function handleLifecycle(tabId, payload) {
    if (stopped) return Promise.resolve();
    const context = lifecycleExecutionContext(payload);
    const failures = [];
    for (const run of store.responseObservationsForTarget(tabId)) {
      try {
        if (restartFor(run)) { void reconcile(run.runId, 'restart-lifecycle'); continue; }
      } catch (error) {
        log.warn('[ResponseObservation] restart authority unavailable run=' + run.runId);
        void reconcile(run.runId, 'restart-authority'); continue;
      }
      if (!isResponseObservation(run) || terminal(run) || run.observationSubject || run.targetTabId !== tabId
        || !context || context.sessionId !== run.observationTarget?.sessionId
        || context.provider !== run.observationTarget?.toolType) continue;
      if (payload.type === 'busy' && payload.busy === true
        && (run.waitForDescendants !== false || !run.observationLiveContext)) {
        store.recordResponseObservationContext(run.runId, context);
      }
      if (payload.type === 'done' && isAbortedReason(payload.reason)
        && executionContextsMatch(run.observationLiveContext, context)
        && context.generation != null && run.observationLiveContext.generation === context.generation) {
        failures.push(settle(run, null, { code: payload.providerErrorCode || payload.reason,
          error: payload.providerErrorMessage || 'Наблюдаемая работа завершилась с ошибкой: ' + payload.reason }));
      }
    }
    return Promise.allSettled(failures).then(() => wakeTarget(tabId, 'lifecycle-' + payload.type));
  }

  async function restore() {
    const runs = await store.listAll();
    if (store.activityReadError) throw Object.assign(new Error('Observation registry could not be loaded'), {
      code: 'response_observation_registry_unavailable',
    });
    // Missing/unreadable metadata is not proof that old SQLite results are orphaned.
    if (store.loadedFromDisk === true) evidence.retainRuns(runs.filter(isResponseObservation)
      .flatMap(run => [run.runId, restartFor(run)?.evidenceKey].filter(Boolean)));
    for (const run of runs) if (isResponseObservation(run) && !terminal(run)) await arm(run);
  }

  function recordCompletion({ tabId, subject, result, backgroundWorkCount, goalWork } = {}) {
    if (stopped || !tabId || !subject || result?.sourceVerified !== true) return;
    const verdict = classifyOrchestrationResultProbe(result, { authoritativeCompletion: true });
    if (verdict.kind === 'pending') return;
    const runs = [...store.runs.values()];
    for (const run of store.responseObservationsForTarget(tabId)) {
      try {
        const binding = restartFor(run);
        if (binding && !binding.pending) { void reconcile(run.runId, 'restart-provider-final'); continue; }
        if (binding?.pending && verdict.kind === 'terminal-failure' && isAbortedReason(result.terminalOutcomeReason)) {
          void reconcile(run.runId, 'restart-original-abort'); continue;
        }
      } catch (error) {
        log.warn('[ResponseObservation] restart authority unavailable run=' + run.runId);
        void reconcile(run.runId, 'restart-authority'); continue;
      }
      if (!isResponseObservation(run) || terminal(run) || run.observationSubject || run.targetTabId !== tabId
        || run.observationTarget?.sessionId !== subject.sessionId || run.observationTarget?.toolType !== subject.toolType) continue;
      if (run.waitForDescendants === false) {
        if (!run.observationCurrentTurnSubject
          || responseObservationSubjectKey(run.observationCurrentTurnSubject) !== responseObservationSubjectKey(subject)) continue;
      } else if (subject.toolType === 'codex' && verdict.kind !== 'terminal-failure'
        && (goalWork?.version !== 1 || goalWork.pending !== false)) {
        // An exact turn final is still valid evidence for explicit current-turn
        // reads. Default whole-work selection needs the Main Goal proof too;
        // without it, use the existing guarded readState/pass, not this freeze.
        void reconcile(run.runId, 'goal-proof-required');
        continue;
      } else if (verdict.kind !== 'terminal-failure'
        && (backgroundWorkCount !== 0 || childRuns(runs, tabId).length)) continue;
      try {
        const committed = evidence.freeze(run.runId, subject, result);
        if (!committed.subject) continue;
        void store.bindResponseObservationSubject(run.runId, committed.subject)
          .then(() => reconcile(run.runId, 'provider-final'))
          .catch(error => log.warn('[ResponseObservation] final binding failed run=' + run.runId + ' error=' + error.message));
      } catch (error) {
        log.warn('[ResponseObservation] final evidence failed run=' + run.runId + ' error=' + error.message);
      }
    }
  }

  return { arm, reconcile, wakeTarget, handleLifecycle, restore,
    recordCompletion,
    handleTranscriptChanged: coordinator.handleTranscriptChanged,
    readResult: run => run ? evidence.readSelected(restartFor(run)?.evidenceKey || run.runId)?.result || null : null,
    async dispose() { stopped = true; await coordinator.stop(); await Promise.allSettled([...inflight.values()]); },
  };
}

module.exports = { createResponseObservationService };
