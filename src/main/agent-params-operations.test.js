'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { APP_STATE_KEY, createAgentParamsOperations, paramsOperationId, paramsRequestFingerprint,
  operationHttpStatus } = require('./agent-params-operations');

const copy = value => JSON.parse(JSON.stringify(value));
const owner = (overrides = {}) => ({ provider: 'claude', sessionId: 'session-a',
  lifecycleGeneration: 'generation-a', terminalInstanceId: 'terminal-a', terminalRunSeq: 7,
  inputRevision: 14, launchId: 'launch-a', startupAttemptId: null, ownerToken: 'owner-a', ...overrides });
const request = (overrides = {}) => ({ tabId: 'tab-a', requestId: 'native-request-a',
  requested: { model: 'claude-fable-5', effort: 'max' }, owner: owner(), ...overrides });
const exact = operation => ({ operationId: operation.operationId, attemptId: operation.attemptId, owner: operation.owner });

function memoryDb() {
  let values = {};
  let failWrite = false;
  const db = {
    reads: 0, writes: 0,
    getAppState(key) { db.reads++; return values[key] === undefined ? null : copy(values[key]); },
    setAppState(key, value) {
      db.writes++;
      if (failWrite) { failWrite = false; throw Error('fixture persistence failure'); }
      values[key] = copy(value);
    },
    failNextWrite() { failWrite = true; },
  };
  db.db = { inTransaction: false, transaction(fn) {
    const run = () => {
      const before = copy(values);
      const wasInTransaction = db.db.inTransaction;
      db.db.inTransaction = true;
      try { return fn(); } catch (error) { values = before; throw error; }
      finally { db.db.inTransaction = wasInTransaction; }
    };
    run.immediate = run;
    return run;
  } };
  return db;
}

function harness(options = {}) {
  let now = 1000;
  let attempts = 0;
  const db = options.db || memoryDb();
  const store = createAgentParamsOperations(db, { now: () => now,
    randomUUID: () => 'attempt-' + (++attempts), ...options });
  return { db, store, advance: (ms = 1000) => { now += ms; }, attempts: () => attempts };
}

function begun(h, overrides = {}) {
  const reservation = h.store.reserve(request(overrides));
  assert.equal(reservation.action, 'reserved');
  const result = h.store.begin(exact(reservation.operation));
  assert.equal(result.dispatchAllowed, true);
  return result.operation;
}

test('canonical request and operation IDs are stable and unambiguous; unsupported input is not omitted', () => {
  assert.equal(paramsOperationId('tab-a', 'native-request-a'), 'settings:tab-a:native-request-a');
  assert.notEqual(paramsOperationId('a:b', 'c'), paramsOperationId('a', 'b:c'));
  assert.equal(paramsOperationId('вкладка', 'a/b'), 'settings:%D0%B2%D0%BA%D0%BB%D0%B0%D0%B4%D0%BA%D0%B0:a%2Fb');
  assert.equal(paramsRequestFingerprint({ effort: ' max ', model: 'claude-fable-5' }),
    paramsRequestFingerprint({ model: 'claude-fable-5', effort: 'max' }));
  assert.notEqual(paramsRequestFingerprint({ thinking: false }), paramsRequestFingerprint({ thinking: 'disabled' }));
  for (const requested of [{ model: 'x', apiKey: 'not-a-real-secret' }, { model: {} }, { effort: null },
    JSON.parse('{"__proto__":"unsafe"}'), { model: 'x\r/model y' }]) {
    assert.throws(() => paramsRequestFingerprint(requested), { code: 'settings_invalid_request' });
  }
});

test('reserve persists exact owner/attempt before dispatch and duplicate requests only join', () => {
  const h = harness();
  const first = h.store.reserve(request());
  const duplicate = h.store.reserve(request({ requested: { effort: 'max', model: 'claude-fable-5' } }));
  assert.equal(first.dispatchAllowed, false);
  assert.equal(first.action, 'reserved');
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.action, 'join');
  assert.equal(duplicate.dispatchAllowed, false);
  assert.deepEqual(first.operation, duplicate.operation);
  assert.deepEqual(h.db.getAppState(APP_STATE_KEY).operations[0].owner, owner());
  assert.equal(h.attempts(), 1);
  assert.equal(h.db.writes, 1);
  const started = h.store.begin(exact(first.operation));
  assert.equal(started.dispatchAllowed, true);
  assert.equal(h.store.begin(exact(first.operation)).dispatchAllowed, false);
  assert.equal(h.store.reserve(request()).dispatchAllowed, false);
  assert.equal(h.store.get(first.operation.operationId).stage, 'begun');
});

test('changed payload conflicts but owner replacement replays the historical owner without adoption', () => {
  const h = harness();
  const op = begun(h);
  const conflict = h.store.reserve(request({ requested: { model: 'different' } }));
  assert.equal(conflict.code, 'settings_request_conflict');
  assert.equal(conflict.statusCode, 409);
  const differentOwner = owner({ ownerToken: 'owner-b', sessionId: 'session-b', inputRevision: 99 });
  const replay = h.store.reserve(request({ owner: differentOwner }));
  assert.equal(replay.action, 'join');
  assert.deepEqual(replay.operation.owner, op.owner);
  assert.equal(h.store.begin({ ...exact(op), owner: differentOwner }).code, 'settings_owner_mismatch');
  assert.equal(h.store.get(op.operationId).revision, op.revision);
});

test('two adapters re-read the same transaction state and grant only one dispatch', () => {
  const h = harness();
  const second = createAgentParamsOperations(h.db, { recoverOnOpen: false });
  const first = h.store.reserve(request()).operation;
  assert.equal(second.reserve(request()).action, 'join');
  assert.equal(second.begin(exact(first)).dispatchAllowed, true);
  assert.equal(h.store.begin(exact(first)).dispatchAllowed, false);
  assert.equal(h.db.writes, 2);
});

test('Enter/submitted and requested arguments alone never classify an applied result', () => {
  const h = harness();
  const op = begun(h);
  for (const outcome of [{ submitted: true, success: true }, { accepted: true, appliedSettings: { model: 'requested' } }]) {
    assert.throws(() => h.store.settle({ ...exact(op), outcome }), { code: 'settings_invalid_request' });
  }
  const pending = h.store.settle({ ...exact(op), outcome: { phase: 'pending', submitted: true,
    steps: [{ kind: 'model', commandId: 'command-a', phase: 'pending', write: { enterWritten: true } }] } });
  assert.equal(pending.operation.phase, 'pending');
  assert.equal(pending.operation.appliedSettings, undefined);
  assert.equal(pending.operation.observed, undefined);
  assert.equal(pending.operation.submitted, undefined);
});

test('late result requires exact attempt and every admitted owner field', () => {
  const h = harness();
  const op = begun(h);
  const outcome = { phase: 'applied', appliedSettings: { model: 'claude-fable-5', effort: 'max' } };
  assert.equal(h.store.settle({ ...exact(op), attemptId: 'older-attempt', outcome }).code, 'settings_attempt_mismatch');
  for (const [key, value] of Object.entries({ provider: 'codex', sessionId: null, lifecycleGeneration: 'old',
    terminalInstanceId: 'old', terminalRunSeq: 8, inputRevision: 15, launchId: null,
    startupAttemptId: 'other', ownerToken: null })) {
    assert.equal(h.store.settle({ ...exact(op), owner: { ...op.owner, [key]: value }, outcome }).code, 'settings_owner_mismatch', key);
  }
  assert.equal(h.store.get(op.operationId).revision, op.revision);
  assert.equal(h.store.settle({ ...exact(op), operationId: 'settings:other-tab:other-request', outcome }).statusCode, 404);
});

test('old exact attempt may settle historically but never writes a newer operation or owner', () => {
  const h = harness();
  const a = begun(h);
  h.store.settle({ ...exact(a), outcome: { phase: 'unknown', code: 'settings_bridge_timeout' } });
  const b = begun(h, { requestId: 'native-request-b', owner: owner({ launchId: 'launch-b' }) });
  const settled = h.store.settle({ ...exact(a), outcome: { phase: 'applied-different',
    observed: { model: { label: 'Sonnet 5', modelId: 'claude-sonnet-5', contextTokens: null, source: 'direct-command-stdout' } },
    appliedSettings: { model: 'claude-sonnet-5' },
    steps: [{ kind: 'model', commandId: 'command-a', phase: 'applied-different', stdoutUuid: 'stdout-a',
      observed: { label: 'Sonnet 5', modelId: 'claude-sonnet-5' } }] } });
  assert.equal(settled.statusCode, 409);
  assert.equal(settled.operation.requested.model, 'claude-fable-5');
  assert.equal(settled.operation.appliedSettings.model, 'claude-sonnet-5');
  assert.deepEqual(h.store.get(b.operationId), b);
  assert.equal(h.store.begin(exact(a)).dispatchAllowed, false);
  assert.equal(h.store.get(a.operationId, { tabId: 'other-tab' }), null);
});

test('partial unknown preserves proven half and late exact evidence can complete only that attempt', () => {
  const h = harness();
  const op = begun(h);
  const partial = h.store.settle({ ...exact(op), outcome: { phase: 'partial-unknown',
    appliedSettings: { model: 'claude-fable-5' }, error: 'old transport timeout', detail: 'old detail',
    steps: [{ kind: 'model', commandId: 'm', phase: 'applied', stdoutUuid: 'model-proof' },
      { kind: 'effort', commandId: 'e', phase: 'unknown', write: { enterWritten: true } }] } });
  assert.equal(partial.statusCode, 202);
  assert.equal(h.store.settle({ ...exact(op), outcome: { phase: 'pending' } }).ignored, true);
  const complete = h.store.settle({ ...exact(op), outcome: { phase: 'applied',
    appliedSettings: { effort: 'max' },
    steps: [{ kind: 'effort', commandId: 'e', phase: 'applied', stdoutUuid: 'effort-proof' }] } });
  assert.deepEqual(complete.operation.appliedSettings, { model: 'claude-fable-5', effort: 'max' });
  assert.equal(complete.operation.steps[0].stdoutUuid, 'model-proof');
  assert.equal(complete.operation.steps[1].write.enterWritten, true);
  assert.equal(complete.operation.error, undefined);
  assert.equal(complete.operation.detail, undefined);
  assert.equal(complete.statusCode, 200);
  const stale = h.store.settle({ ...exact(op), outcome: { phase: 'unknown' } });
  assert.equal(stale.ignored, true);
  assert.deepEqual(stale.operation, complete.operation);
});

test('partial failure, rejection and applied-different remain distinct terminal facts without retry permission', () => {
  const h = harness();
  for (const phase of ['partial-failed', 'rejected', 'applied-different']) {
    const op = begun(h, { requestId: phase });
    const outcome = { phase, code: phase === 'rejected' ? 'claude_rate_limit' : 'settings_' + phase,
      ...(phase === 'rejected' ? {} : { appliedSettings: { model: 'observed-model' } }),
      unattempted: ['thinking'], failedCommand: '/effort max', error: 'Настройка не подтверждена' };
    const terminal = h.store.settle({ ...exact(op), outcome });
    assert.equal(terminal.operation.phase, phase);
    assert.equal(terminal.statusCode, 409);
    assert.equal(terminal.operation.settledAt, 1000);
    assert.equal(h.store.reserve(request({ requestId: phase })).action, 'replay');
    assert.equal(h.store.begin(exact(op)).dispatchAllowed, false);
    assert.equal(h.store.settle({ ...exact(op), outcome: { phase: 'applied' } }).code, 'settings_outcome_conflict');
  }
  assert.equal(operationHttpStatus({ phase: 'unknown' }), 202);
});

test('confirmed evidence cannot be erased, reassigned, or contradicted by a later partial callback', () => {
  const h = harness();
  const op = begun(h);
  const pending = h.store.settle({ ...exact(op), outcome: { phase: 'partial-unknown',
    appliedSettings: { model: 'observed-model' }, observed: { model: { label: 'Actual', modelId: null } },
    steps: [{ kind: 'model', commandId: 'command-a', phase: 'applied', stdoutUuid: 'stdout-a' }] } }).operation;
  for (const outcome of [{ phase: 'rejected' },
    { phase: 'unknown', appliedSettings: { model: 'requested-model' } },
    { phase: 'unknown', steps: [{ kind: 'model', commandId: 'different-command', phase: 'applied' }] },
    { phase: 'unknown', steps: [{ kind: 'model', phase: 'pending' }] }]) {
    assert.equal(h.store.settle({ ...exact(op), outcome }).code, 'settings_evidence_conflict');
    assert.deepEqual(h.store.get(op.operationId), pending);
  }
  const enriched = h.store.settle({ ...exact(op), outcome: { phase: 'partial-unknown',
    observed: { model: { modelId: 'actual-model', label: null } } } });
  assert.deepEqual(enriched.operation.observed.model, { label: 'Actual', modelId: 'actual-model' });
});

test('terminal replay refuses contradictory proof without enriching or replacing the finalized receipt', () => {
  const h = harness();
  const op = begun(h);
  const completed = h.store.settle({ ...exact(op), outcome: { phase: 'applied',
    appliedSettings: { model: 'actual' }, observed: { model: 'actual' } } }).operation;
  for (const outcome of [{ phase: 'applied', appliedSettings: { model: 'requested' } },
    { phase: 'applied', observed: { model: { label: 'new model' } } }]) {
    assert.equal(h.store.settle({ ...exact(op), outcome }).code, 'settings_evidence_conflict');
    assert.deepEqual(h.store.get(op.operationId), completed);
  }
  assert.equal(h.store.settle({ ...exact(op), outcome: { phase: 'applied' } }).action, 'replay');
});

test('restart marks both reserved and begun pending as unknown, never as resumable', () => {
  const h = harness();
  const reserved = h.store.reserve(request({ requestId: 'reserved' })).operation;
  const active = begun(h, { requestId: 'begun' });
  const partial = begun(h, { requestId: 'part' });
  h.store.settle({ ...exact(partial), outcome: { phase: 'pending', appliedSettings: { model: 'observed' } } });
  h.advance();
  const restored = createAgentParamsOperations(h.db, { now: () => 2000 });
  for (const op of [reserved, active, partial]) {
    const receipt = restored.get(op.operationId);
    assert.equal(receipt.phase, op === partial ? 'partial-unknown' : 'unknown');
    assert.equal(receipt.code, 'settings_restart_during_operation');
    assert.ok(receipt.revision > op.revision);
    assert.equal(restored.begin(exact(op)).dispatchAllowed, false);
    assert.equal(restored.reserve(request({ requestId: op.requestId })).action, 'join');
  }
  assert.equal(restored.settle({ ...exact(reserved), outcome: { phase: 'applied' } }).code, 'settings_operation_not_begun');
  assert.equal(restored.settle({ ...exact(active), outcome: { phase: 'applied' } }).statusCode, 200);
});

test('read/replay have no persistence side effects and exposed objects cannot mutate durable identity', () => {
  const h = harness();
  const op = begun(h);
  const writes = h.db.writes;
  const read = h.store.get(op.operationId);
  read.owner.launchId = 'fake';
  read.requested.model = 'fake';
  assert.equal(h.store.list({ tabId: 'missing' }).length, 0);
  assert.equal(h.store.reserve(request()).operation.revision, op.revision);
  assert.equal(h.store.begin(exact(op)).operation.revision, op.revision);
  assert.equal(h.db.writes, writes);
  assert.deepEqual(h.store.get(op.operationId), op);
});

test('failed persistence rolls back reservation/begin and publishes no permission or false event', async () => {
  const events = [];
  const h = harness({ onChanged: op => events.push(op) });
  h.db.failNextWrite();
  assert.throws(() => h.store.reserve(request()), /persistence failure/);
  assert.deepEqual(h.store.list(), []);
  const op = h.store.reserve(request()).operation;
  await Promise.resolve();
  events.length = 0;
  h.db.failNextWrite();
  assert.throws(() => h.store.begin(exact(op)), /persistence failure/);
  await Promise.resolve();
  assert.deepEqual(events, []);
  assert.deepEqual(h.store.get(op.operationId), op);
  assert.equal(h.store.begin(exact(op)).dispatchAllowed, true);
});

test('publication occurs after commit, coalesces old revisions, and suppresses an outer rollback', async () => {
  const events = [];
  const h = harness({ onChanged: op => {
    assert.equal(h.db.db.inTransaction, false);
    assert.deepEqual(h.store.get(op.operationId), op);
    events.push(op);
  } });
  const op = begun(h);
  assert.equal(events.length, 0);
  await Promise.resolve();
  assert.deepEqual(events.map(op => op.revision), [2]);
  assert.throws(() => h.db.db.transaction(() => {
    h.store.settle({ ...exact(op), outcome: { phase: 'applied' } });
    throw Error('outer rollback');
  })(), /outer rollback/);
  await Promise.resolve();
  assert.equal(events.length, 1);
  assert.equal(h.store.get(op.operationId).phase, 'pending');
});

test('codec drops raw provider payloads and credential fields and sanitizes textual diagnostics', () => {
  const h = harness();
  const op = begun(h);
  const settled = h.store.settle({ ...exact(op), outcome: { phase: 'unknown',
    providerPayload: { private: 'PAYLOAD-ONLY' }, apiKey: 'FIELD-SECRET', request: { content: 'PROMPT-ONLY' },
    observed: { model: { label: 'Actual model', auth: 'OBSERVED-SECRET', raw: { foo: 'RAW-ONLY' } } },
    steps: [{ kind: 'model', phase: 'unknown', credentials: { token: 'STEP-SECRET' },
      observed: { label: 'Actual model' }, write: { enterWritten: true, apiKey: 'WRITE-SECRET' } }],
    error: 'Authorization: Bearer AUTH-SECRET',
    detail: 'safe diagnostic\n{"apiKey":"JSON-SECRET"}\nOPENAI_API_KEY=ENV-SECRET\n-----BEGIN PRIVATE KEY-----\nPRIVATE-KEY\n-----END PRIVATE KEY-----' } });
  const stored = JSON.stringify(h.db.getAppState(APP_STATE_KEY));
  for (const secret of ['PAYLOAD-ONLY', 'FIELD-SECRET', 'PROMPT-ONLY', 'OBSERVED-SECRET', 'RAW-ONLY',
    'STEP-SECRET', 'WRITE-SECRET', 'AUTH-SECRET', 'JSON-SECRET', 'ENV-SECRET', 'PRIVATE-KEY']) assert.ok(!stored.includes(secret), secret);
  assert.equal(settled.operation.observed.model.label, 'Actual model');
  assert.match(settled.operation.detail, /safe diagnostic/);
  assert.throws(() => h.store.reserve(request({ requestId: 'sensitive-owner', owner: { ...owner(), apiKey: 'SECRET' } })),
    { code: 'settings_invalid_request' });
});

test('pruning retains unresolved evidence and terminal replay tombstones; no old request can redispatch', () => {
  const h = harness();
  const unknown = begun(h, { requestId: 'unknown' });
  h.store.settle({ ...exact(unknown), outcome: { phase: 'unknown', detail: 'observation still needed',
    steps: [{ kind: 'model', phase: 'unknown', commandId: 'late-command' }] } });
  const applied = begun(h, { requestId: 'applied' });
  h.store.settle({ ...exact(applied), outcome: { phase: 'applied', appliedSettings: { model: 'done' }, detail: 'old detail' } });
  h.advance(10_000);
  const unknownBefore = h.store.get(unknown.operationId);
  const beforeRevision = h.store.get(applied.operationId).revision;
  assert.equal(h.store.prune({ retentionMs: 0, maxDetailedRecords: 0 }).compacted, 1);
  assert.deepEqual(h.store.get(unknown.operationId), unknownBefore);
  const tombstone = h.store.get(applied.operationId);
  assert.equal(tombstone.tombstone, true);
  assert.equal(tombstone.detail, undefined);
  assert.equal(tombstone.requested, undefined);
  assert.ok(tombstone.revision > beforeRevision);
  assert.equal(h.store.reserve(request({ requestId: 'applied' })).action, 'replay');
  assert.equal(h.store.reserve(request({ requestId: 'applied', requested: { model: 'different' } })).code, 'settings_request_conflict');
  assert.equal(h.store.begin(exact(applied)).dispatchAllowed, false);
  assert.equal(h.store.prune({ retentionMs: 0, maxDetailedRecords: 0 }).compacted, 0);
  assert.equal(h.store.settle({ ...exact(unknown), outcome: { phase: 'applied', appliedSettings: { model: 'late-value' } } }).statusCode, 200);
});

test('corrupt stored data is never treated as absence and cannot grant a duplicate reservation', () => {
  const h = harness();
  h.store.reserve(request());
  for (const corrupted of ['broken JSON', { version: 9, revision: 1, operations: [] },
    { version: 1, revision: 1, operations: [{ operationId: 'incomplete' }] }]) {
    h.db.setAppState(APP_STATE_KEY, corrupted);
    assert.throws(() => h.store.reserve(request()), { code: 'settings_store_invalid', statusCode: 503 });
  }
});

test('tampering with persisted requested values does not preserve an apparently valid reservation', () => {
  const h = harness();
  const op = h.store.reserve(request()).operation;
  const state = h.db.getAppState(APP_STATE_KEY);
  state.operations[0].requested.model = 'tampered';
  h.db.setAppState(APP_STATE_KEY, state);
  assert.throws(() => h.store.begin(exact(op)), { code: 'settings_store_invalid' });
});

function sqliteHarness(t) {
  const Database = require('better-sqlite3');
  let probe;
  try { probe = new Database(':memory:'); }
  catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error.message)) {
      t.skip('Run SQLite acceptance with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test src/main/agent-params-operations.test.js');
      return null;
    }
    throw error;
  }
  probe.close();
  const DatabaseManager = require('./database');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-params-receipts-'));
  const databasePath = path.join(scratch, 'receipts.db');
  const connections = [];
  t.after(() => {
    for (const db of connections) if (db.open) db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const open = () => {
    const sqlite = new Database(databasePath);
    connections.push(sqlite);
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
    // Actual project getAppState/setAppState methods, but no constructor,
    // Electron app launch, production DB, settings initialization or fixtures
    // outside this one mkdtemp directory.
    const manager = Object.create(DatabaseManager.prototype);
    manager.db = sqlite;
    return manager;
  };
  return { open };
}

test('actual SQLite close/reopen retains requests, unknown attempts, late settlement and unrelated app state', t => {
  const fixture = sqliteHarness(t);
  if (!fixture) return;
  let db = fixture.open();
  db.setAppState('unrelated-fixture', { untouched: true });
  let store = createAgentParamsOperations(db, { now: () => 1000 });
  const a = store.reserve(request()).operation;
  assert.equal(store.begin(exact(a)).dispatchAllowed, true);
  const reserved = store.reserve(request({ requestId: 'reserved-crash' })).operation;
  const applied = store.reserve(request({ requestId: 'applied-before-restart' })).operation;
  store.begin(exact(applied));
  store.settle({ ...exact(applied), outcome: { phase: 'applied', appliedSettings: { model: 'done' } } });
  db.db.close();

  db = fixture.open();
  store = createAgentParamsOperations(db, { now: () => 2000 });
  assert.equal(store.get(a.operationId).phase, 'unknown');
  assert.equal(store.get(reserved.operationId).phase, 'unknown');
  assert.equal(store.get(applied.operationId).phase, 'applied');
  assert.equal(store.begin(exact(a)).dispatchAllowed, false);
  assert.equal(store.begin(exact(reserved)).dispatchAllowed, false);
  assert.equal(store.reserve(request()).action, 'join');
  const b = store.reserve(request({ requestId: 'new-owner-request', owner: owner({ launchId: 'launch-b' }) })).operation;
  store.begin(exact(b));
  store.settle({ ...exact(a), outcome: { phase: 'applied', appliedSettings: { model: 'late-observed', effort: 'max' } } });
  const finalRevision = store.get(a.operationId).revision;
  assert.deepEqual(store.get(b.operationId).owner, b.owner);
  assert.deepEqual(db.getAppState('unrelated-fixture'), { untouched: true });
  db.db.close();

  db = fixture.open();
  store = createAgentParamsOperations(db, { now: () => 3000 });
  assert.equal(store.get(a.operationId).phase, 'applied');
  assert.equal(store.get(a.operationId).revision, finalRevision);
  assert.equal(store.reserve(request()).action, 'replay');
  assert.equal(store.begin(exact(a)).dispatchAllowed, false);
  assert.equal(store.get(b.operationId).phase, 'unknown');
  store.prune({ retentionMs: 0, maxDetailedRecords: 0 });
  db.db.close();

  db = fixture.open();
  store = createAgentParamsOperations(db);
  assert.equal(store.get(a.operationId).tombstone, true);
  assert.equal(store.reserve(request()).action, 'replay');
  assert.equal(store.reserve(request({ requested: { model: 'different' } })).code, 'settings_request_conflict');
  assert.equal(store.begin(exact(a)).dispatchAllowed, false);
  assert.equal(store.get(b.operationId).phase, 'unknown');
});

test('actual SQLite failed commit and overlapping connections never lose reservation or grant a second dispatch', async t => {
  const fixture = sqliteHarness(t);
  if (!fixture) return;
  const firstDb = fixture.open();
  const secondDb = fixture.open();
  const events = [];
  const first = createAgentParamsOperations(firstDb, { onChanged: op => events.push(op) });
  const second = createAgentParamsOperations(secondDb, { recoverOnOpen: false });
  const op = first.reserve(request()).operation;
  await Promise.resolve();
  events.length = 0;
  assert.equal(second.reserve(request()).action, 'join');
  assert.throws(() => firstDb.db.transaction(() => {
    first.begin(exact(op));
    throw Error('outer sqlite rollback');
  }).immediate(), /outer sqlite rollback/);
  await Promise.resolve();
  assert.equal(events.length, 0);
  assert.equal(second.get(op.operationId).stage, 'reserved');
  assert.equal(second.begin(exact(op)).dispatchAllowed, true);
  assert.equal(first.begin(exact(op)).dispatchAllowed, false);
  const applied = second.settle({ ...exact(op), outcome: { phase: 'applied', appliedSettings: { model: 'actual' } } });
  assert.equal(first.get(op.operationId).revision, applied.operation.revision);
});
