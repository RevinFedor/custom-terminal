'use strict';
const { randomUUID } = require('node:crypto');

// Scope and admission only. PTY, script and SDK owners keep their existing
// Stop implementations; this controller never signals a PID or sends input.
function activeMember(row, workflowId) {
  return row?.membership?.workflowId === workflowId && row.executionResolved === true
    && !!row.nativeRow && row.nativeRow.execution_archived !== 1
    && row.nativeRow.tab_type !== 'file';
}

function scopeKey(row) {
  return JSON.stringify([row.tabId, row.subjectVersion, row.executionSubject,
    row.membership.workflowId, row.membership.revision, row.nativeRow.id, row.nativeRow.tab_type]);
}

function createWorkflowSessionStop({ organization, captureOwner, sameOwner, readBusy, observe,
  stop, log = () => {} }) {
  const flights = new Map();
  const execute = async (request) => {
    const { workflowId, mode } = request;
    const actionId = typeof request.actionId === 'string' && request.actionId.length <= 128
      ? request.actionId : randomUUID();
    const startedAt = Date.now();
    if (!organization.ready() || !organization.service.getWorkflow(workflowId)) {
      return { success: false, error: 'workflow_not_found', results: [] };
    }
    const excluded = new Set(Array.isArray(request.busyTabIds) ? request.busyTabIds : []);
    // Entire canonical membership, including reserve and every display profile.
    // Freeze owners before the first await. Never expand an in-flight action.
    const targets = organization.service.listMembers(workflowId)
      .filter(row => activeMember(row, workflowId))
      .map(row => ({ tabId: row.tabId, scope: scopeKey(row), owner: captureOwner(row) }))
      .filter(target => target.owner?.live === true);
    log('begin', { actionId, workflowId, mode, targets: targets.length, startedAt });
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const index = next++, target = targets[index];
        const guard = () => {
          const row = organization.service.getTab(target.tabId);
          if (!activeMember(row, workflowId) || scopeKey(row) !== target.scope) {
            return { allowed: false, reason: 'workflow_stop_scope_changed' };
          }
          if (!sameOwner(target.owner, captureOwner(row))) {
            return { allowed: false, reason: 'workflow_stop_owner_changed' };
          }
          if (mode === 'idle') {
            const busy = readBusy(target.tabId, target.owner);
            if (excluded.has(target.tabId) || busy.known !== true || busy.busy !== false) {
              return { allowed: false, reason: busy.known === true
                ? 'workflow_stop_became_busy' : 'workflow_stop_idle_unknown' };
            }
          }
          return { allowed: true, reason: null };
        };
        try {
          let verdict = guard();
          let result;
          if (!verdict.allowed) result = { success: false, skipped: true, error: verdict.reason };
          else {
            const proof = await observe(target.tabId, target.owner);
            verdict = guard();
            if (!verdict.allowed) result = { success: false, skipped: true, error: verdict.reason };
            else if (proof?.known !== true) result = { success: false, error: 'workflow_stop_process_unknown' };
            else result = await stop(target.tabId, target.owner, proof, guard);
          }
          results[index] = { tabId: target.tabId, kind: target.owner.kind, ...result,
            ...(result?.guardRejected ? { skipped: true } : {}) };
        } catch (error) {
          results[index] = { tabId: target.tabId, kind: target.owner.kind, success: false,
            error: error?.message || String(error) };
        }
        log('target', { actionId, workflowId, mode, elapsedMs: Date.now() - startedAt, ...results[index] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    const stoppedCount = results.filter(result => result.success === true).length;
    const skippedCount = results.filter(result => result.skipped === true).length;
    const failedCount = results.length - stoppedCount - skippedCount;
    return { success: failedCount === 0, actionId, workflowId, mode, stoppedCount, skippedCount, failedCount, results };
  };
  return request => {
    if (!request || typeof request.workflowId !== 'string' || !['idle', 'all'].includes(request.mode)) {
      return Promise.resolve({ success: false, error: 'workflow_stop_request_invalid', results: [] });
    }
    const old = flights.get(request.workflowId);
    if (old) return old.mode === request.mode ? old.promise
      : Promise.resolve({ success: false, error: 'workflow_stop_in_progress', results: [] });
    const promise = execute(request).finally(() => {
      if (flights.get(request.workflowId)?.promise === promise) flights.delete(request.workflowId);
    });
    flights.set(request.workflowId, { mode: request.mode, promise });
    return promise;
  };
}

// These observations belong to the existing SDK query object, not a second
// executor. Only its channel/provider events can make it idle; no timer does.
function createSdkStopObservation(warm) {
  return { busy: !warm, operational: false, inputRevision: 0, tasks: new Set() };
}
function observeSdkStopMessage(state, message) {
  if (!state || !message) return;
  if (message.type === 'result') state.busy = false;
  if (message.type === 'assistant' || message.type === 'stream_event' || message.type === 'user') state.busy = true;
  if (message.type !== 'system') return;
  if (message.subtype === 'status' && message.status === 'compacting') state.operational = true;
  if (message.subtype === 'compact_boundary' || (message.subtype === 'status' && message.compact_result)) state.operational = false;
  if (message.subtype === 'task_started' && message.task_id) state.tasks.add(message.task_id);
  if (message.subtype === 'task_notification' && message.task_id
    && ['completed', 'failed', 'stopped'].includes(message.status)) state.tasks.delete(message.task_id);
}

module.exports = { createWorkflowSessionStop, createSdkStopObservation, observeSdkStopMessage };
