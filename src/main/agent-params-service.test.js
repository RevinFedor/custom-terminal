'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentParamsService } = require('./agent-params-service');
const { createAgentParamsOperations, paramsOperationId } = require('./agent-params-operations');

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const owner = version => ({ provider: 'claude', sessionId: 'S' + version,
  lifecycleGeneration: 'G' + version, terminalInstanceId: 'T' + version,
  terminalRunSeq: version, inputRevision: version, launchId: 'L' + version, ownerToken: 'O' + version });
const request = (changes = {}) => ({ tabId: 'tab', requestId: 'request', model: 'requested-model', effort: 'max', ...changes });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryDb() {
  let values = {}, fail = false;
  const db = {
    reads: 0, writes: 0,
    getAppState(key) { db.reads++; return copy(values[key]) ?? null; },
    setAppState(key, value) {
      db.writes++;
      if (fail) { fail = false; return false; }
      values[key] = copy(value);
      return true;
    },
    failNextWrite() { fail = true; },
  };
  db.db = { inTransaction: false, transaction(fn) {
    const run = () => {
      const before = copy(values), nested = db.db.inTransaction;
      db.db.inTransaction = true;
      try { return fn(); } catch (error) { values = before; throw error; }
      finally { db.db.inTransaction = nested; }
    };
    run.immediate = run;
    return run;
  } };
  return db;
}

function fixture() {
  const db = memoryDb(), errors = [], deliveries = [], listeners = new Set(), errorListeners = new Set();
  let time = 1000, attempt = 0;
  const store = createAgentParamsOperations(db, { now: () => ++time, randomUUID: () => 'attempt-' + (++attempt),
    onChanged: operation => { for (const listener of [...listeners]) listener(operation); } });
  const state = { version: 1, provider: 'claude', captureCalls: 0, currentCalls: 0,
    context: { sentinel: 'PRIVATE_EXECUTE_CONTEXT', terminal: {}, checkOwner() {} } };
  const started = deferred(), pending = deferred();
  let handler = () => pending.promise;
  const deps = { store,
    captureTarget: () => { state.captureCalls++; return { provider: state.provider,
      owner: owner(state.version), executeContext: state.context }; },
    execute: delivery => { deliveries.push(delivery); started.resolve(delivery); return handler(delivery); },
    readCurrent: async tabId => { state.currentCalls++; return { tabId, provider: state.provider,
      owner: owner(state.version), model: 'current-' + state.version, coherent: true }; },
    onError: (error, detail) => {
      errors.push({ error, detail });
      for (const listener of [...errorListeners]) listener({ error, detail });
    },
  };
  const service = createAgentParamsService(deps);
  function waitForPhase(phase, requestId = 'request') {
    const id = paramsOperationId('tab', requestId);
    const current = store.get(id);
    if (current?.phase === phase) return Promise.resolve(current);
    const done = deferred();
    const listener = operation => {
      if (operation.operationId === id && operation.phase === phase) {
        listeners.delete(listener); done.resolve(operation);
      }
    };
    listeners.add(listener);
    return done.promise;
  }
  return { db, store, state, errors, deliveries, deps, service, started: started.promise, pending,
    setExecute(fn) { handler = fn; }, waitForPhase,
    waitForError(stage) {
      const existing = errors.find(value => value.detail.stage === stage);
      if (existing) return Promise.resolve(existing);
      const done = deferred();
      const listener = value => {
        if (value.detail.stage === stage) { errorListeners.delete(listener); done.resolve(value); }
      };
      errorListeners.add(listener);
      return done.promise;
    },
  };
}

test('new submit captures, reserves and begins synchronously before exactly one background dispatch', async () => {
  const h = fixture();
  const response = h.service.submit(request());
  assert.equal(typeof response.then, 'undefined');
  assert.equal(h.state.captureCalls, 1);
  assert.equal(h.db.writes, 2, 'actual store reserve and begin are already durable');
  assert.equal(h.deliveries.length, 0, 'existing executor starts only after the admission stack');
  assert.equal(response.statusCode, 202); assert.equal(response.operation.stage, 'begun');
  assert.equal(response.model, undefined); assert.equal(response.appliedSettings, undefined);
  assert.equal(response.operation.requested.provider, undefined);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_EXECUTE_CONTEXT/);
  response.operation.owner.sessionId = 'mutated-reply';
  h.state.version = 2;
  const delivery = await h.started;
  assert.equal(delivery.operation.owner.sessionId, 'S1');
  assert.equal(delivery.context, h.state.context);
  assert.equal(delivery.requested.model, 'requested-model');
  assert.equal(h.state.currentCalls, 0, 'admission never awaits a current GET');
});

test('concurrent duplicates join the actual same-store receipt and changed payload conflicts', async () => {
  const h = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => h.service.submit(request())));
  await h.started;
  assert.equal(h.deliveries.length, 1); assert.equal(h.state.captureCalls, 1);
  assert.equal(results.filter(result => result.action === 'begun').length, 1);
  assert.equal(results.filter(result => result.action === 'join').length, 11);
  assert.equal(new Set(results.map(result => result.operation.attemptId)).size, 1);
  const writes = h.db.writes;
  const conflict = h.service.submit(request({ model: 'different-model' }));
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.code, 'settings_request_conflict');
  assert.equal(conflict.accepted, false); assert.equal(conflict.model, undefined);
  assert.equal(h.db.writes, writes); assert.equal(h.deliveries.length, 1);
});

test('two service adapters share the store admission gate, not an in-memory execution queue', async () => {
  const h = fixture();
  const secondStore = createAgentParamsOperations(h.db, { recoverOnOpen: false });
  const second = createAgentParamsService({ ...h.deps, store: secondStore });
  const first = h.service.submit(request());
  const replay = second.submit(request());
  await h.started;
  assert.equal(first.operation.attemptId, replay.operation.attemptId);
  assert.equal(replay.action, 'join'); assert.equal(h.deliveries.length, 1);
});

test('explicit application returns only proven legacy values; requested mismatch stays distinct', async () => {
  const h = fixture();
  h.setExecute(() => ({ phase: 'applied-different', appliedSettings: { model: 'observed-model', effort: 'high' },
    observed: { model: { value: 'observed-model', requestedSatisfied: false } } }));
  const done = h.waitForPhase('applied-different');
  const initial = h.service.submit(request());
  assert.equal(initial.model, undefined);
  await done;
  const replay = h.service.submit(request());
  assert.equal(replay.action, 'replay'); assert.equal(replay.statusCode, 409);
  assert.equal(replay.model, 'observed-model'); assert.equal(replay.effort, 'high');
  assert.equal(replay.operation.requested.model, 'requested-model');
  assert.equal(replay.success, undefined); assert.equal(h.deliveries.length, 1);
});

test('generic success/Enter/submitted and generic appliedSettings never prove application', async () => {
  const h = fixture();
  h.setExecute(() => ({ success: true, submitted: true, enterWritten: true,
    model: 'requested-model', appliedSettings: { model: 'untyped-claim' } }));
  const done = h.waitForPhase('unknown');
  h.service.submit(request());
  const operation = await done;
  assert.equal(operation.code, 'settings_outcome_unavailable');
  assert.equal(operation.appliedSettings, undefined);
  const replay = h.service.submit(request());
  assert.equal(replay.statusCode, 202); assert.equal(replay.model, undefined);
  assert.equal(h.deliveries.length, 1);
});

test('partial unknown and exact late callback settle the original receipt after renderer loss', async () => {
  const h = fixture();
  h.service.submit(request());
  const delivery = await h.started;
  const partial = delivery.onOutcome({ phase: 'partial-unknown', appliedSettings: { model: 'observed-model' },
    steps: [{ kind: 'model', phase: 'applied', observed: { value: 'observed-model' } },
      { kind: 'effort', phase: 'unknown', write: { enterWritten: true } }],
    error: 'renderer transport disappeared', failedCommand: '/effort max' });
  assert.equal(partial.statusCode, 202); assert.equal(partial.model, 'observed-model');
  assert.equal(partial.effort, undefined);
  h.state.version = 2;
  const loss = h.waitForError('execute');
  h.pending.reject(Object.assign(new Error('renderer unavailable'), { appliedSettings: { effort: 'not-proof' } }));
  await loss;
  const afterLoss = await h.waitForPhase('partial-unknown');
  assert.equal(afterLoss.appliedSettings.effort, undefined);
  assert.equal(afterLoss.code, 'settings_execution_unknown');
  const late = delivery.onOutcome({ phase: 'applied', appliedSettings: { model: 'observed-model', effort: 'max' },
    steps: [{ kind: 'effort', phase: 'applied', observed: { value: 'max' } }] });
  assert.equal(late.statusCode, 200); assert.equal(late.operation.owner.sessionId, 'S1');
  assert.equal(late.model, 'observed-model'); assert.equal(late.effort, 'max');
  assert.equal(late.error, undefined);
  const read = await h.service.read({ tabId: 'tab', operationId: late.operation.operationId });
  assert.equal(read.operation.phase, 'applied'); assert.equal(read.current.owner.sessionId, 'S2');
  assert.equal(h.deliveries.length, 1);
});

test('final applied proof survives a later rejection or stale unknown callback', async () => {
  const h = fixture();
  h.service.submit(request());
  const delivery = await h.started;
  delivery.onOutcome({ phase: 'applied', appliedSettings: { model: 'proven', effort: 'max' } });
  h.pending.reject(new Error('late transport loss'));
  const stale = delivery.onOutcome({ phase: 'unknown', code: 'late_transport_unknown' });
  assert.equal(stale.operation.phase, 'applied'); assert.equal(stale.model, 'proven');
  const value = await h.service.read({ tabId: 'tab', operationId: stale.operation.operationId });
  assert.equal(value.operation.phase, 'applied'); assert.equal(value.model, 'proven');
});

for (const sync of [true, false]) test((sync ? 'thunk throw' : 'async rejection') + ' is unknown, never applied or retried', async () => {
  const h = fixture();
  const error = Object.assign(new Error('fixture execution unavailable'), { appliedSettings: { model: 'untyped-claim' } });
  h.setExecute(sync ? () => { throw error; } : () => Promise.reject(error));
  const done = h.waitForPhase('unknown');
  h.service.submit(request());
  const operation = await done;
  assert.equal(operation.code, 'settings_execution_unknown');
  assert.equal(operation.appliedSettings, undefined);
  assert.equal(operation.phase, 'unknown');
  assert.equal(h.errors[0].detail.stage, 'execute');
  const replay = h.service.submit(request());
  assert.equal(replay.action, 'join'); assert.equal(h.deliveries.length, 1);
});

test('malformed explicit outcome fails closed in the actual codec and permits a later valid proof', async () => {
  const h = fixture();
  h.service.submit(request());
  const delivery = await h.started;
  const malformed = delivery.onOutcome({ phase: 'applied', appliedSettings: { model: { invalid: true } } });
  assert.equal(malformed.operation.phase, 'unknown');
  assert.equal(malformed.model, undefined);
  assert.equal(h.errors[0].detail.stage, 'settlement');
  const valid = delivery.onOutcome({ phase: 'applied', appliedSettings: { model: 'proven' } });
  assert.equal(valid.statusCode, 200); assert.equal(valid.model, 'proven');
});

test('restart recovery keeps unknown replay without calling captureTarget or execute', async () => {
  const h = fixture();
  const initial = h.service.submit(request());
  await h.started;
  const restartedStore = createAgentParamsOperations(h.db);
  let calls = 0;
  const restarted = createAgentParamsService({ store: restartedStore,
    captureTarget: () => { calls++; throw Error('old process no longer exists'); },
    execute: () => { calls++; throw Error('must not reexecute'); }, readCurrent: () => null });
  const result = restarted.submit(request());
  assert.equal(result.action, 'join'); assert.equal(result.operation.phase, 'unknown');
  assert.equal(result.operation.code, 'settings_restart_during_operation');
  assert.equal(result.operation.attemptId, initial.operation.attemptId);
  assert.equal(calls, 0);
});

test('historical replay survives a changed provider/current owner without new dispatch', async () => {
  const h = fixture();
  h.service.submit(request());
  const delivery = await h.started;
  delivery.onOutcome({ phase: 'applied', appliedSettings: { model: 'old-observed' } });
  h.state.version = 2; h.state.provider = 'codex';
  const writes = h.db.writes;
  const replay = h.service.submit(request());
  assert.equal(replay.operation.owner.provider, 'claude'); assert.equal(replay.operation.owner.sessionId, 'S1');
  assert.equal(h.state.captureCalls, 1); assert.equal(h.db.writes, writes);
  const current = await h.service.read({ tabId: 'tab' });
  assert.equal(current.current.provider, 'codex'); assert.equal(h.deliveries.length, 1);
  assert.throws(() => h.service.submit(request({ requestId: 'new-request' })),
    { code: 'settings_provider_unsupported', statusCode: 409 });
});

test('receipt GET is read-only and keeps current state separate from historical applied fields', async () => {
  const h = fixture();
  const initial = h.service.submit(request());
  const delivery = await h.started;
  delivery.onOutcome({ phase: 'partial-failed', appliedSettings: { model: 'old-observed' }, error: 'effort rejected' });
  h.state.version = 2;
  const before = { writes: h.db.writes, captureCalls: h.state.captureCalls, deliveries: h.deliveries.length };
  const value = await h.service.read({ tabId: 'tab', operationId: initial.operation.operationId });
  assert.equal(value.statusCode, 200); assert.equal(value.operation.phase, 'partial-failed');
  assert.equal(value.model, 'old-observed'); assert.equal(value.current.model, 'current-2');
  assert.equal(value.operation.owner.sessionId, 'S1'); assert.equal(value.current.owner.sessionId, 'S2');
  assert.equal(h.db.writes, before.writes); assert.equal(h.state.captureCalls, before.captureCalls);
  assert.equal(h.deliveries.length, before.deliveries);
  await assert.rejects(h.service.read({ tabId: 'other-tab', operationId: initial.operation.operationId }),
    { code: 'settings_operation_not_found', statusCode: 404 });
  await assert.rejects(h.service.read({ tabId: 'tab', operationId: 'missing' }),
    { code: 'settings_operation_not_found', statusCode: 404 });
});

test('current unavailable is separate currentError on a historical receipt but an error without one', async () => {
  const h = fixture();
  const initial = h.service.submit(request());
  const broken = createAgentParamsService({ ...h.deps,
    readCurrent: async () => { throw Object.assign(new Error('runtime unavailable'), { code: 'params_snapshot_unstable', statusCode: 503 }); } });
  const writes = h.db.writes;
  const result = await broken.read({ tabId: 'tab', operationId: initial.operation.operationId });
  assert.equal(result.statusCode, 200); assert.equal(result.current, null);
  assert.equal(result.currentError.code, 'params_snapshot_unstable');
  assert.equal(result.operation.operationId, initial.operation.operationId);
  assert.equal(h.db.writes, writes);
  await assert.rejects(broken.read({ tabId: 'tab' }), { code: 'params_snapshot_unstable', statusCode: 503 });
});

test('invalid fields and unsupported thinking are rejected before capture or reservation', () => {
  const h = fixture();
  for (const value of [null, {}, request({ requestId: '' }), request({ model: null }),
    request({ effort: 'high\n/model other' }), request({ thinking: 'none' }),
    request({ thinking: 'maybe' }), { ...request(), callback: true },
    { tabId: 'tab', requestId: 'empty' }]) {
    assert.throws(() => h.service.submit(value), { code: 'settings_invalid_request', statusCode: 400 });
  }
  assert.equal(h.state.captureCalls, 0); assert.equal(h.db.writes, 0);
  const boolean = h.service.submit(request({ thinking: false }));
  assert.equal(boolean.operation.requested.thinking, 'disabled');
  assert.equal(h.service.submit(request({ thinking: 'disabled' })).action, 'join');
});

test('reserve/begin storage failure cannot dispatch an uncommitted operation', async () => {
  const h = fixture();
  h.db.failNextWrite();
  assert.throws(() => h.service.submit(request()), { code: 'settings_store_write_failed', statusCode: 503 });
  assert.equal(h.deliveries.length, 0); assert.equal(h.store.get(paramsOperationId('tab', 'request')), null);
  const normalBegin = h.store.begin;
  h.store.begin = value => { h.db.failNextWrite(); return normalBegin(value); };
  assert.throws(() => h.service.submit(request()), { code: 'settings_store_write_failed', statusCode: 503 });
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.store.get(paramsOperationId('tab', 'request')).stage, 'reserved');
  assert.equal(h.service.submit(request()).action, 'join', 'a retained reservation is not new permission to execute');
});

test('async or invalid owner capture is refused without admission', () => {
  const h = fixture();
  for (const captureTarget of [() => Promise.resolve({ provider: 'claude', owner: owner(1) }),
    () => null, () => ({ provider: 'claude', owner: { provider: 'claude', sessionId: 'only-saved' } }),
    () => ({ provider: 'claude', owner: { ...owner(1), provider: 'codex' } })]) {
    const service = createAgentParamsService({ ...h.deps, captureTarget });
    assert.throws(() => service.submit(request()), { code: 'settings_target_unavailable', statusCode: 503 });
  }
  assert.equal(h.db.writes, 0); assert.equal(h.deliveries.length, 0);
});

test('a same-ID reservation created during capture remains join and cannot be begun twice', async () => {
  const h = fixture();
  const sibling = createAgentParamsService(h.deps);
  let nested = false;
  const outer = createAgentParamsService({ ...h.deps, captureTarget: tabId => {
    if (!nested) { nested = true; sibling.submit(request()); }
    return h.deps.captureTarget(tabId);
  } });
  const result = outer.submit(request());
  assert.equal(result.action, 'join');
  await h.started;
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.db.writes, 2);
});

test('failed proof persistence cannot leak applied fields and the exact late callback can recover', async () => {
  const h = fixture();
  h.service.submit(request());
  const delivery = await h.started;
  h.db.failNextWrite();
  const first = delivery.onOutcome({ phase: 'applied', appliedSettings: { model: 'proven' } });
  assert.equal(first.operation.phase, 'unknown');
  assert.equal(first.model, undefined);
  assert.equal(first.operation.code, 'settings_settlement_unavailable');
  const late = delivery.onOutcome({ phase: 'applied', appliedSettings: { model: 'proven' } });
  assert.equal(late.statusCode, 200); assert.equal(late.model, 'proven');
  assert.equal(h.deliveries.length, 1);
});

test('a throwing capture is typed unavailable and cannot leave any operation or dispatch', () => {
  const h = fixture();
  const service = createAgentParamsService({ ...h.deps, captureTarget: () => { throw Error('owner unavailable'); } });
  assert.throws(() => service.submit(request()), error => error.code === 'settings_target_unavailable'
    && error.statusCode === 503 && error.cause?.message === 'owner unavailable');
  assert.equal(h.db.writes, 0); assert.equal(h.deliveries.length, 0);
});

test('diagnostic callback failure does not become an unhandled rejection or own settlement', async () => {
  const h = fixture();
  const service = createAgentParamsService({ ...h.deps,
    execute: () => { throw Error('executor unavailable'); },
    onError: async () => { throw Error('diagnostics unavailable'); } });
  const done = h.waitForPhase('unknown');
  service.submit(request());
  const operation = await done;
  assert.equal(operation.code, 'settings_execution_unknown');
  assert.equal(operation.appliedSettings, undefined);
});
