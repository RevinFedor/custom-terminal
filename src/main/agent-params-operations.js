'use strict';

const crypto = require('node:crypto');
const { createDiagnosticSanitizer } = require('./diagnostic-log-export');

// A factual, durable admission/receipt adapter, not a settings executor. In
// particular, Enter/submitted is never interpreted as settings application.
const APP_STATE_KEY = 'agentParamsOperations.v1';
const VERSION = 1;
const PHASES = Object.freeze({
  PENDING: 'pending', UNKNOWN: 'unknown', PARTIAL_UNKNOWN: 'partial-unknown',
  APPLIED: 'applied', APPLIED_DIFFERENT: 'applied-different',
  PARTIAL_FAILED: 'partial-failed', REJECTED: 'rejected',
});
const UNRESOLVED = new Set([PHASES.PENDING, PHASES.UNKNOWN, PHASES.PARTIAL_UNKNOWN]);
const FINAL = new Set([PHASES.APPLIED, PHASES.APPLIED_DIFFERENT, PHASES.PARTIAL_FAILED, PHASES.REJECTED]);
const SETTING_KEYS = new Set(['model', 'effort', 'thinking', 'permissionMode']);
const REQUEST_KEYS = new Set([...SETTING_KEYS, 'provider']);
const OWNER_KEYS = new Set(['provider', 'sessionId', 'lifecycleGeneration', 'terminalInstanceId',
  'terminalRunSeq', 'runSeq', 'inputRevision', 'launchId', 'startupAttemptId', 'ownerToken']);
const OBSERVATION_KEYS = new Set([...SETTING_KEYS, 'value', 'label', 'modelId', 'contextTokens',
  'provenance', 'source', 'evidenceId', 'commandId', 'checkpointId', 'wrapperUuid', 'stdoutUuid',
  'stderrUuid', 'sourceIdentity', 'satisfied', 'requestedSatisfied', 'observedAt', 'proofRevision']);
const STEP_PHASES = new Set(['unattempted', 'pending', 'unknown', 'applied', 'applied-different', 'rejected']);
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DETAILED_RECORDS = 1000;

function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'settings_invalid_request', statusCode: 400 });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(label + ' must be a plain object');
  return value;
}

function string(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw invalid(label + ' must be a non-empty bounded string without control characters');
  }
  return value.trim();
}

function scalar(value, label) {
  if (typeof value === 'string') return string(value, label);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw invalid(label + ' must be a JSON scalar');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function settings(value, keys = SETTING_KEYS) {
  object(value, 'settings');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!keys.has(key)) throw invalid('unsupported settings field: ' + key);
    if (value[key] === undefined) continue;
    const field = value[key];
    if (key === 'thinking' && typeof field === 'boolean') result[key] = field;
    else result[key] = string(field, key);
  }
  return result;
}

function normalizeParamsOwner(value) {
  object(value, 'owner');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!OWNER_KEYS.has(key)) throw invalid('unsupported owner field: ' + key);
    if (value[key] !== undefined) result[key] = scalar(value[key], 'owner.' + key);
  }
  result.provider = string(result.provider, 'owner.provider', 128);
  // The caller captures ALL applicable fields from its authoritative snapshot.
  // A provider or saved SID alone is not an admitted live owner.
  if (!['lifecycleGeneration', 'terminalInstanceId', 'launchId', 'ownerToken'].some(key => result[key] != null)) {
    throw invalid('owner needs an exact runtime or conversation identity');
  }
  return result;
}

function paramsOperationId(tabId, requestId) {
  // Encode each component independently: tab='a:b', id='c' differs from a/b:c.
  return 'settings:' + encodeURIComponent(string(tabId, 'tabId')) + ':' + encodeURIComponent(string(requestId, 'requestId'));
}

function paramsRequestFingerprint(requested) {
  return crypto.createHash('sha256').update(canonical({ kind: 'settings', version: VERSION,
    requested: settings(requested, REQUEST_KEYS) })).digest('hex');
}

function diagnostic(value, max) {
  if (typeof value !== 'string') throw invalid('diagnostic must be a string');
  const sanitizer = createDiagnosticSanitizer();
  const bounded = value.slice(0, max).replace(
    /("(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"<redacted>"',
  );
  return bounded.split(/\r?\n/).map(line => sanitizer.sanitizeLine(line)).filter(line => line !== null).join('\n');
}

function observation(value, depth = 0) {
  object(value, 'observed');
  if (depth > 3) throw invalid('observation is too deeply nested');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!OBSERVATION_KEYS.has(key) || value[key] === undefined) continue;
    result[key] = value[key] && typeof value[key] === 'object'
      ? observation(value[key], depth + 1) : scalar(value[key], 'observed.' + key);
  }
  return result;
}

function normalizeStep(value) {
  object(value, 'step');
  const result = { kind: string(value.kind, 'step.kind') };
  if (!SETTING_KEYS.has(result.kind)) throw invalid('unsupported step kind');
  if (value.phase !== undefined || value.outcome !== undefined) {
    result.phase = value.phase ?? value.outcome;
    if (!STEP_PHASES.has(result.phase)) throw invalid('invalid step phase');
  }
  for (const key of ['commandId', 'evidenceId', 'checkpointId', 'wrapperUuid', 'stdoutUuid', 'stderrUuid', 'sourceIdentity', 'code']) {
    if (value[key] != null) result[key] = string(value[key], 'step.' + key);
  }
  if (value.requested !== undefined) result.requested = scalar(value.requested, 'step.requested');
  if (value.observed != null) result.observed = observation(value.observed);
  if (value.write != null) {
    object(value.write, 'step.write');
    result.write = {};
    for (const key of ['pasteWritten', 'enterWritten']) {
      if (value.write[key] === undefined) continue;
      if (value.write[key] !== null && typeof value.write[key] !== 'boolean') throw invalid('step.write must be boolean or null');
      result.write[key] = value.write[key];
    }
  }
  return result;
}

function normalizeOutcome(value) {
  object(value, 'outcome');
  if (![...UNRESOLVED, ...FINAL].includes(value.phase)) throw invalid('explicit settings outcome.phase required');
  const result = { phase: value.phase };
  if (value.appliedSettings != null) result.appliedSettings = settings(value.appliedSettings);
  if (value.observed != null) result.observed = observation(value.observed);
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > 16) throw invalid('steps must be a bounded array');
    result.steps = value.steps.map(normalizeStep);
    const kinds = result.steps.map(step => step.kind);
    if (new Set(kinds).size !== kinds.length) throw invalid('only one step per setting kind is supported');
  }
  if (value.unattempted !== undefined) {
    if (!Array.isArray(value.unattempted) || value.unattempted.some(kind => !SETTING_KEYS.has(kind))) throw invalid('invalid unattempted settings');
    result.unattempted = [...new Set(value.unattempted)].sort();
  }
  for (const key of ['code', 'failedCommand', 'diagnosticId']) {
    if (value[key] != null) result[key] = string(value[key], key);
  }
  for (const [key, max] of [['error', 2048], ['detail', 16_384]]) {
    if (value[key] != null) result[key] = diagnostic(value[key], max);
  }
  // No raw reply, provider response, auth/profile config or prompt data is copied.
  return result;
}

function operationHttpStatus(operation) {
  return UNRESOLVED.has(operation?.phase) ? 202 : operation?.phase === PHASES.APPLIED ? 200 : 409;
}

function defaultCode(phase) { return 'settings_' + phase.replace(/-/g, '_'); }

function result(operation, action, extras = {}) {
  return { ok: true, action, dispatchAllowed: false, retryable: false,
    statusCode: operationHttpStatus(operation), operation: clone(operation), ...extras };
}

function conflict(code, operation = null) {
  return { ok: false, action: 'conflict', code, statusCode: operation ? 409 : 404,
    dispatchAllowed: false, retryable: false, operation: operation ? clone(operation) : null };
}

function mergeFacts(previous = {}, next = {}) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw Error('settings_evidence_conflict');
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value === null && merged[key] !== undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) merged[key] = mergeFacts(merged[key] ?? {}, value);
    else if (merged[key] != null && canonical(merged[key]) !== canonical(value)) throw Error('settings_evidence_conflict');
    else merged[key] = value;
  }
  return merged;
}

function mergeSteps(previous = [], next = []) {
  const merged = previous.map(clone);
  for (const step of next) {
    const index = merged.findIndex(old => old.kind === step.kind);
    if (index < 0) { merged.push(step); continue; }
    const old = merged[index];
    if (['applied', 'applied-different', 'rejected'].includes(old.phase) && step.phase && step.phase !== old.phase) {
      throw Error('settings_evidence_conflict');
    }
    if (old.phase === 'unknown' && ['unattempted', 'pending'].includes(step.phase)) throw Error('settings_evidence_conflict');
    const { phase: _oldPhase, ...oldFacts } = old;
    const { phase: _newPhase, ...newFacts } = step;
    merged[index] = { ...mergeFacts(oldFacts, newFacts), ...(old.phase || step.phase ? { phase: step.phase || old.phase } : {}) };
  }
  return merged;
}

function createAgentParamsOperations(db, options = {}) {
  if (!db || typeof db.getAppState !== 'function' || typeof db.setAppState !== 'function'
    || typeof db.db?.transaction !== 'function') throw new TypeError('synchronous project app-state database required');
  const storageKey = options.storageKey || APP_STATE_KEY;
  const now = options.now || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const onChanged = options.onChanged;

  function read() {
    const stored = db.getAppState(storageKey);
    if (stored === null || stored === undefined) return { version: VERSION, revision: 0, operations: [] };
    // A corrupt store is not an empty store and must never grant a new dispatch.
    if (stored.version !== VERSION || !Number.isSafeInteger(stored.revision) || stored.revision < 0
      || !Array.isArray(stored.operations)) throw Object.assign(new Error('settings operation store is invalid'),
      { code: 'settings_store_invalid', statusCode: 503 });
    const state = clone(stored);
    const ids = new Set();
    for (const op of state.operations) {
      let valid = false;
      try {
        valid = !!op && op.version === VERSION && op.kind === 'settings' && op.accepted === true
          && typeof op.operationId === 'string' && !ids.has(op.operationId)
          && op.operationId === paramsOperationId(op.tabId, op.requestId)
          && Number.isSafeInteger(op.revision) && op.revision > 0 && op.revision <= state.revision
          && [...UNRESOLVED, ...FINAL].includes(op.phase) && ['reserved', 'begun'].includes(op.stage)
          && typeof op.attemptId === 'string' && !!op.attemptId
          && typeof op.requestFingerprint === 'string' && /^[a-f0-9]{64}$/.test(op.requestFingerprint)
          && !!op.owner && canonical(op.owner) === canonical(normalizeParamsOwner(op.owner))
          && (op.tombstone === true ? FINAL.has(op.phase)
            : op.tombstone === false && op.requestFingerprint === paramsRequestFingerprint(op.requested));
      } catch { /* Persisted corruption has a store error, not a caller 400. */ }
      if (!valid) {
        throw Object.assign(new Error('settings operation record is invalid'), { code: 'settings_store_invalid', statusCode: 503 });
      }
      ids.add(op.operationId);
    }
    return state;
  }

  function mutate(work) {
    const changed = [];
    const run = db.db.transaction(() => {
      const state = read();
      const touch = op => {
        if (state.revision >= Number.MAX_SAFE_INTEGER) throw Error('settings operation revision exhausted');
        op.revision = ++state.revision;
        op.updatedAt = now();
        changed.push(op);
      };
      const value = work(state, touch);
      if (changed.length) {
        const written = db.setAppState(storageKey, state);
        if (written === false || written?.success === false) throw Object.assign(new Error('settings operation persistence failed'),
          { code: 'settings_store_write_failed', statusCode: 503 });
      }
      return value;
    });
    const value = typeof run.immediate === 'function' ? run.immediate() : run();
    if (typeof onChanged === 'function') {
      for (const op of changed) {
        const event = clone(op);
        // Runs after an enclosing synchronous SQLite transaction too. Recheck
        // revision so an outer rollback or newer settlement cannot publish lies.
        queueMicrotask(() => {
          try {
            const current = get(event.operationId);
            if (current?.revision !== event.revision || canonical(current) !== canonical(event)) return;
            Promise.resolve(onChanged(event)).catch(() => console.warn('[AgentParamsOperations] onChanged failed'));
          } catch { console.warn('[AgentParamsOperations] committed publication unavailable'); }
        });
      }
    }
    return value;
  }

  function get(operationId, { tabId } = {}) {
    const id = string(operationId, 'operationId', 8192);
    const op = read().operations.find(candidate => candidate.operationId === id && (tabId === undefined || candidate.tabId === tabId));
    return op ? clone(op) : null;
  }

  function list({ tabId } = {}) {
    return read().operations.filter(op => tabId === undefined || op.tabId === tabId)
      .sort((a, b) => b.revision - a.revision).map(clone);
  }

  function reserve({ tabId: inputTabId, requestId: inputRequestId, requested: inputRequested, owner: inputOwner }) {
    const tabId = string(inputTabId, 'tabId');
    const requestId = string(inputRequestId, 'requestId');
    const requested = settings(inputRequested, REQUEST_KEYS);
    const owner = normalizeParamsOwner(inputOwner);
    const operationId = paramsOperationId(tabId, requestId);
    const requestFingerprint = paramsRequestFingerprint(requested);
    return mutate((state, touch) => {
      const existing = state.operations.find(op => op.operationId === operationId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) return conflict('settings_request_conflict', existing);
        // Current owner may have changed. Historical replay is still valid;
        // it never adopts that owner and never authorizes its executor.
        return result(existing, UNRESOLVED.has(existing.phase) ? 'join' : 'replay');
      }
      const operation = { version: VERSION, kind: 'settings', operationId, tabId, requestId, requestFingerprint,
        attemptId: string(randomUUID(), 'attemptId'), owner, requested, phase: PHASES.PENDING,
        stage: 'reserved', code: defaultCode(PHASES.PENDING), accepted: true,
        revision: 0, createdAt: now(), updatedAt: null, begunAt: null, settledAt: null, tombstone: false };
      state.operations.push(operation);
      touch(operation);
      return result(operation, 'reserved');
    });
  }

  function exact(state, input) {
    const op = state.operations.find(candidate => candidate.operationId === input.operationId);
    if (!op) return { refusal: conflict('settings_operation_not_found') };
    if (op.attemptId !== input.attemptId) return { refusal: conflict('settings_attempt_mismatch', op) };
    if (canonical(op.owner) !== canonical(normalizeParamsOwner(input.owner))) return { refusal: conflict('settings_owner_mismatch', op) };
    return { op };
  }

  function begin(input) {
    return mutate((state, touch) => {
      const { op, refusal } = exact(state, input);
      if (refusal) return refusal;
      if (op.stage !== 'reserved' || op.phase !== PHASES.PENDING) return result(op, 'replay');
      op.stage = 'begun';
      op.begunAt = now();
      touch(op); // Persisted BEFORE caller receives permission to dispatch.
      return result(op, 'begun', { dispatchAllowed: true });
    });
  }

  function settle(input) {
    const outcome = normalizeOutcome(input.outcome);
    return mutate((state, touch) => {
      const { op, refusal } = exact(state, input);
      if (refusal) return refusal;
      if (FINAL.has(op.phase)) {
        if (op.phase === outcome.phase) {
          if (!op.tombstone) {
            try {
              mergeFacts(op.appliedSettings, outcome.appliedSettings);
              mergeFacts(op.observed, outcome.observed);
              mergeSteps(op.steps, outcome.steps);
            } catch { return conflict('settings_evidence_conflict', op); }
          }
          return result(op, 'replay');
        }
        // A stale timeout cannot undo known application/rejection.
        if (UNRESOLVED.has(outcome.phase)) return result(op, 'replay', { ignored: true });
        return conflict('settings_outcome_conflict', op);
      }
      if (op.stage !== 'begun' && [PHASES.APPLIED, PHASES.APPLIED_DIFFERENT, PHASES.PARTIAL_FAILED].includes(outcome.phase)) {
        return conflict('settings_operation_not_begun', op);
      }
      if ([PHASES.UNKNOWN, PHASES.PARTIAL_UNKNOWN].includes(op.phase) && outcome.phase === PHASES.PENDING) {
        return result(op, 'replay', { ignored: true });
      }
      let merged;
      try {
        merged = { ...op, ...outcome,
          code: outcome.code || (outcome.phase === op.phase ? op.code : defaultCode(outcome.phase)) };
        if (op.appliedSettings || outcome.appliedSettings) merged.appliedSettings = mergeFacts(op.appliedSettings, outcome.appliedSettings);
        if (op.observed || outcome.observed) merged.observed = mergeFacts(op.observed, outcome.observed);
        if (op.steps || outcome.steps) merged.steps = mergeSteps(op.steps, outcome.steps);
        if (merged.phase === PHASES.REJECTED && (Object.keys(merged.appliedSettings || {}).length
          || merged.steps?.some(step => ['applied', 'applied-different'].includes(step.phase)))) throw Error('settings_evidence_conflict');
        if (outcome.phase === PHASES.APPLIED) {
          // A resolved transport timeout is historical diagnostics, not a
          // current error or an unattempted suffix of the successful result.
          for (const key of ['error', 'detail', 'failedCommand', 'unattempted']) {
            if (!(key in outcome)) delete merged[key];
          }
        }
      } catch { return conflict('settings_evidence_conflict', op); }
      if (canonical(merged) === canonical(op)) return result(op, 'replay');
      if (FINAL.has(merged.phase)) merged.settledAt = now();
      for (const key of Object.keys(op)) if (!(key in merged)) delete op[key];
      Object.assign(op, merged);
      touch(op);
      return result(op, 'settled');
    });
  }

  function recoverPending() {
    return mutate((state, touch) => {
      const recovered = [];
      for (const op of state.operations) {
        if (op.phase !== PHASES.PENDING) continue;
        op.phase = Object.keys(op.appliedSettings || {}).length
          || op.steps?.some(step => ['applied', 'applied-different'].includes(step.phase))
          ? PHASES.PARTIAL_UNKNOWN : PHASES.UNKNOWN;
        op.code = 'settings_restart_during_operation';
        touch(op);
        recovered.push(clone(op));
      }
      return recovered;
    });
  }

  function prune({ retentionMs = DEFAULT_RETENTION_MS, maxDetailedRecords = DEFAULT_MAX_DETAILED_RECORDS } = {}) {
    if (!Number.isFinite(retentionMs) || retentionMs < 0 || !Number.isSafeInteger(maxDetailedRecords) || maxDetailedRecords < 0) {
      throw invalid('invalid pruning bounds');
    }
    return mutate((state, touch) => {
      const detailed = state.operations.filter(op => FINAL.has(op.phase) && !op.tombstone)
        .sort((a, b) => b.revision - a.revision);
      let compacted = 0;
      for (const [index, op] of detailed.entries()) {
        if (index < maxDetailedRecords && now() - op.settledAt < retentionMs) continue;
        // Never erase the idempotency address. Unknown records retain their
        // evidence for late settlement; finalized rows keep replay tombstones.
        for (const key of ['requested', 'observed', 'appliedSettings', 'steps', 'unattempted', 'error', 'detail', 'failedCommand', 'diagnosticId']) delete op[key];
        op.tombstone = true;
        touch(op);
        compacted += 1;
      }
      return { compacted };
    });
  }

  // Construct once at application startup. Additional same-process adapters
  // must opt out; GET/list never perform recovery or any other writes.
  if (options.recoverOnOpen !== false) recoverPending();
  return { reserve, begin, settle, get, list, prune, recoverPending };
}

module.exports = { APP_STATE_KEY, VERSION, PHASES, createAgentParamsOperations,
  paramsOperationId, paramsRequestFingerprint, normalizeParamsOwner, operationHttpStatus };
