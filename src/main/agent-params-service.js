'use strict';

const { paramsOperationId, paramsRequestFingerprint, normalizeParamsOwner,
  operationHttpStatus, PHASES } = require('./agent-params-operations');

const UNRESOLVED = new Set([PHASES.PENDING, PHASES.UNKNOWN, PHASES.PARTIAL_UNKNOWN]);
const OUTCOMES = new Set(Object.values(PHASES));
const SETTINGS = ['model', 'effort', 'thinking'];
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function failure(code, statusCode, cause = null) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code, statusCode });
}

function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !allowed.includes(key))) throw failure('settings_invalid_request', 400);
}

function text(value, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw failure('settings_invalid_request', 400);
  }
  return value.trim();
}

function submission(input) {
  object(input, ['tabId', 'requestId', ...SETTINGS]);
  const tabId = text(input.tabId), requestId = text(input.requestId);
  const requested = {};
  for (const key of SETTINGS) {
    if (input[key] === undefined) continue;
    if (key === 'thinking' && typeof input[key] === 'boolean') {
      requested.thinking = input[key] ? 'adaptive' : 'disabled';
    } else requested[key] = text(input[key]);
  }
  if (!Object.keys(requested).length || (requested.thinking !== undefined
    && !['adaptive', 'enabled', 'disabled'].includes(requested.thinking))) {
    throw failure('settings_invalid_request', 400);
  }
  return { tabId, requestId, requested };
}

function response(operation, action, extra = {}) {
  // Compatibility fields are projected ONLY from durable proven settings,
  // never from requested arguments, transport success, Enter, or current GET.
  const applied = copy(operation.appliedSettings) || {};
  const legacy = {};
  for (const key of SETTINGS) {
    if (applied[key] !== undefined) legacy[key] = key === 'thinking' && typeof applied[key] === 'boolean'
      ? applied[key] ? 'adaptive' : 'disabled' : applied[key];
  }
  return {
    statusCode: operationHttpStatus(operation), tabId: operation.tabId, action,
    accepted: operation.accepted === true, retryable: false,
    operation: copy(operation), code: operation.code,
    ...legacy,
    ...(Object.keys(applied).length ? { appliedSettings: applied } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.failedCommand ? { failedCommand: operation.failedCommand } : {}),
    ...extra,
  };
}

function conflict(result) {
  return { statusCode: result.statusCode || 409, tabId: result.operation?.tabId || null,
    action: 'conflict', accepted: false, retryable: false,
    code: result.code || 'settings_operation_conflict', operation: copy(result.operation) || null };
}

/**
 * Admission/receipt transport, NOT a settings executor or settings queue.
 *
 * submit({tabId,requestId,model?,effort?,thinking?}) is synchronous. Before any
 * dispatch it persists reserve + begin. Duplicate IDs are historical reads:
 * they do not require the old renderer/process and cannot begin another run.
 * Only a NEW Claude request calls synchronous captureTarget(tabId), returning
 * {provider:'claude', owner:<store owner codec>, executeContext?:<private>}.
 * The owner is durable; executeContext is passed privately and never persisted.
 *
 * execute({tabId,requested,operation,context,onOutcome}) is the existing main
 * scenario. It owns the final physical-owner recheck, queue and all PTY writes.
 * Both onOutcome(outcome) and the returned outcome use the store's explicit
 * phase codec. A generic success/submitted reply or rejection cannot prove an
 * application. The request-owned callback may settle late after the executor's
 * first return, transport/renderer loss, or a current-tab owner replacement.
 *
 * read({tabId,operationId?}) performs no recovery, settlement, or dispatch.
 * Found receipts are HTTP-resource-style 200 independent of operation phase;
 * a current read failure is separate currentError and never hides the receipt.
 * Auth, HTTP writing, restart recovery and the legacy SDK/Codex submit boundary
 * belong to main/web callers, not this adapter. No timers are installed here.
 */
function createAgentParamsService({ store, captureTarget, execute, readCurrent, onError = null } = {}) {
  if (!store || ['get', 'reserve', 'begin', 'settle'].some(name => typeof store[name] !== 'function')) {
    throw new TypeError('agent params operation store required');
  }
  if ([captureTarget, execute, readCurrent].some(value => typeof value !== 'function')) {
    throw new TypeError('captureTarget, execute and readCurrent are required');
  }

  const report = (error, operation, stage) => {
    if (typeof onError !== 'function') return;
    try {
      Promise.resolve(onError(error, { tabId: operation?.tabId || null,
        operationId: operation?.operationId || null, stage })).catch(() => {});
    } catch { /* Diagnostics do not own operation delivery or settlement. */ }
  };

  function dispatch(operation, context) {
    // This address is immutable even if the caller mutates its returned DTO or
    // the target adopts another session before a late proof is observed.
    const admitted = copy(operation);
    const exact = { operationId: admitted.operationId, attemptId: admitted.attemptId, owner: admitted.owner };
    const settle = outcome => {
      const result = store.settle({ ...exact, outcome });
      if (result.ok !== true) {
        report(failure(result.code || 'settings_settlement_failed', result.statusCode || 409), admitted, 'settlement');
        return conflict(result);
      }
      return response(result.operation, result.action);
    };
    const unknown = (code, error = null) => {
      const current = store.get(admitted.operationId, { tabId: admitted.tabId });
      const partial = Object.keys(current?.appliedSettings || {}).length > 0
        || current?.steps?.some(step => ['applied', 'applied-different'].includes(step.phase));
      return settle({ phase: partial ? PHASES.PARTIAL_UNKNOWN : PHASES.UNKNOWN, code,
        ...(error ? { error: String(error.message || error) } : {}) });
    };
    const onOutcome = outcome => {
      try {
        if (!OUTCOMES.has(outcome?.phase)) {
          report(failure('settings_outcome_unavailable', 503), admitted, 'outcome');
          return unknown('settings_outcome_unavailable');
        }
        return settle(outcome);
      } catch (error) {
        report(error, admitted, 'settlement');
        // A malformed result or failed write must not become success. If the
        // store itself is unavailable this second factual write may also fail;
        // keep the prior receipt and report it, never redispatch the executor.
        try { return unknown('settings_settlement_unavailable'); }
        catch (failure) { report(failure, admitted, 'settlement-unavailable'); return null; }
      }
    };

    // Store.begin already committed on the caller's synchronous stack. A thunk
    // and a rejecting async executor are handled identically; no unhandled
    // rejection, native queue, timer, or renderer-owned pending map is added.
    void Promise.resolve().then(() => execute({ tabId: admitted.tabId,
      requested: copy(admitted.requested), operation: copy(admitted), context, onOutcome }))
      .then(outcome => { onOutcome(outcome); })
      .catch(error => {
        report(error, admitted, 'execute');
        try { unknown('settings_execution_unknown', error); }
        catch (failure) { report(failure, admitted, 'settlement-unavailable'); }
      });
  }

  function submit(input) {
    const request = submission(input);
    const operationId = paramsOperationId(request.tabId, request.requestId);
    const existing = store.get(operationId, { tabId: request.tabId });
    if (existing) {
      if (existing.requestFingerprint !== paramsRequestFingerprint(request.requested)) {
        return conflict({ code: 'settings_request_conflict', statusCode: 409, operation: existing });
      }
      return response(existing, UNRESOLVED.has(existing.phase) ? 'join' : 'replay');
    }
    let target;
    try { target = captureTarget(request.tabId); }
    catch (error) { throw failure('settings_target_unavailable', 503, error); }
    if (target && typeof target.then === 'function') {
      // Reject an accidentally async dependency without leaving its rejected
      // promise unobserved. It still grants no reservation or dispatch.
      void Promise.resolve(target).catch(error => report(error, null, 'capture'));
      throw failure('settings_target_unavailable', 503);
    }
    if (!target) throw failure('settings_target_unavailable', 503);
    if (target.provider !== 'claude') throw failure('settings_provider_unsupported', 409);
    let owner;
    try { owner = normalizeParamsOwner(target.owner); }
    catch (error) { throw failure('settings_target_unavailable', 503, error); }
    if (owner.provider !== target.provider) throw failure('settings_target_unavailable', 503);
    const reserved = store.reserve({ ...request, owner });
    if (reserved.ok !== true) return conflict(reserved);
    // Another synchronous entrant/shared store may have reserved the same ID
    // while captureTarget ran. Only OUR fresh reservation may call begin.
    if (reserved.action !== 'reserved') return response(reserved.operation, reserved.action);
    const begun = store.begin({ operationId, attemptId: reserved.operation.attemptId, owner: reserved.operation.owner });
    if (begun.ok !== true) return conflict(begun);
    const result = response(begun.operation, begun.action);
    if (begun.dispatchAllowed === true) dispatch(begun.operation, target.executeContext);
    return result;
  }

  async function read(input) {
    object(input, ['tabId', 'operationId']);
    const tabId = text(input.tabId);
    const operationId = input.operationId === undefined ? null : text(input.operationId, 8192);
    const operation = operationId ? store.get(operationId, { tabId }) : null;
    if (operationId && !operation) throw failure('settings_operation_not_found', 404);
    let current = null, currentError = null;
    try {
      current = await readCurrent(tabId);
      if (current == null) throw failure('settings_current_unavailable', 503);
      current = copy(current);
    } catch (error) {
      currentError = { code: error?.code || 'settings_current_unavailable',
        statusCode: Number(error?.statusCode) || 503 };
      if (!operation) throw failure(currentError.code, currentError.statusCode, error);
    }
    return { ...(operation ? response(operation, 'read') : { tabId }),
      statusCode: 200, current, ...(currentError ? { currentError } : {}) };
  }

  return { submit, read };
}

module.exports = { createAgentParamsService };
