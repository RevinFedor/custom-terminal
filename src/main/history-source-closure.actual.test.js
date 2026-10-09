'use strict';

// Real service, Codex reader/generation ledger, SQLite metadata/prepared owner
// and temporary synthetic files. Only async delivery boundaries are held.
// ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test src/main/history-source-closure.actual.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
const codexData = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');
const { HistoryFreshness } = require('./history-freshness');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const { validateHistoryRevision } = require('./history-revision');

const api = codexData._api;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const answer = (text, n = 0) => ({ type: 'response_item', timestamp: new Date(Date.UTC(2026, 9, 8) + n * 1000).toISOString(),
  payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });

function fixture(t, { prepared = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-source-closure-'));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const filePath = path.join(root, 'rollout-' + sessionId + '.jsonl');
  const metadata = id => ({ type: 'session_meta', payload: { id, cwd: root } });
  fs.writeFileSync(filePath, encode([metadata(sessionId), answer('ORIGINAL')]));
  const db = new DatabaseManager({ existingConnection: new SQLite(path.join(root, 'metadata.db')) });
  db.initTables(); db.db.pragma('journal_mode = WAL');
  const diagnostics = [];
  const cache = prepared ? new HistoryPreparedCache({ directory: path.join(root, 'cache'),
    onDiagnostic: event => diagnostics.push(event) }) : null;
  const scopedApi = { ...api,
    findCodexSessionFile: (id, cwd) => api.findCodexSessionFile(id, cwd, { sessionsDir: root, allowContentScan: false }),
    loadSessionRecords: (id, cwd, options) => api.loadSessionRecords(id, cwd, { ...options, sessionsDir: root }),
    projectCodexFullHistoryFromFile: (id, cwd, options) => api.projectCodexFullHistoryFromFile(id, cwd, { ...options, sessionsDir: root }),
  };
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: scopedApi },
    promptPresentationStore: db, sessionHistoryStore: db, preparedHistoryStore: cache });
  const unobserve = api.observeCodexReadInvalidation(event => {
    if (cache && !event.readRefresh && !event.sourceAppend && event.filePath.startsWith(root + path.sep)) cache.invalidate(event.filePath);
  });
  const scope = { tabId: 'private-tab', toolType: 'codex', sessionId, cwd: root };
  const payload = { ...scope, dehydrate: true, freshnessProof: true };
  const freshness = new HistoryFreshness({ readContext: (owner, ids) => service.getHistoryFreshnessContext(owner, ids) });
  const changedFiles = new Set([filePath]);
  t.after(() => {
    unobserve();
    for (const file of changedFiles) api.invalidateJsonlCache(file);
    service.codexVirtualTranscriptStore?.dispose();
    db.close();
    assert.equal(cache?.activeFiles.size || 0, 0, 'no fixture transaction remains active');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, filePath, sessionId, db, cache, diagnostics, service, scope, payload, freshness, metadata, scopedApi, changedFiles,
    rewrite(text, target = filePath, id = sessionId) {
      fs.writeFileSync(target, encode([metadata(id), answer(text)]));
      api.invalidateJsonlCache(target);
    },
    append(text) { fs.appendFileSync(filePath, encode([answer(text, 1)])); api.invalidateJsonlCache(filePath, { sourceAppend: true }); },
  };
}

async function assertCurrent(f, result, expected) {
  assert.equal(result.success, true, result.error);
  const rows = result.entries || result.changedEntries;
  assert.ok(rows?.some(row => row.content === expected), 'current synthetic rows must be returned');
  assert.ok(!rows?.some(row => row.content === 'ORIGINAL' || row.content === 'BEFORE-SAVE'),
    'pre-invalidation row bodies must not be published');
  assert.equal((await validateHistoryRevision(result.revision, f.scope)).unchanged, true,
    'the returned revision must still witness the current source');
  const source = await f.scopedApi.projectCodexFullHistoryFromFile(f.sessionId, f.root, {});
  assert.equal(result.payloadGeneration, source.sourceSnapshot.sourceGeneration,
    'the result must use the actual current generation, not a newly captured stat on old rows');
}

for (const mutate of [false, true]) test('R4 final context await rejects newer exact-tab event' + (mutate ? ' with source append' : ' without stat change'), async t => {
  const f = fixture(t, { prepared: false });
  const ticket = await f.freshness.beginRead(f.scope);
  const data = await f.service.getHistory(f.payload);
  const entered = deferred(), release = deferred();
  const context = f.freshness.readContext.bind(f.freshness);
  let calls = 0;
  t.mock.method(f.freshness, 'readContext', async (...args) => {
    const value = await context(...args);
    if (++calls === 2) { entered.resolve(); await release.promise; }
    return value;
  });
  const pending = f.freshness.completeRead(f.scope, data, ticket);
  await entered.promise;
  if (mutate) f.append('AFTER-FINAL-STAT');
  const dirty = f.freshness.invalidate(f.scope.tabId);
  release.resolve();
  const result = await pending;
  assert.equal(calls, 2, 'hold only the real final context delivery, after validation');
  assert.equal(result.state, 'unknown', 'older rows cannot clear the newer watcher event');
  assert.equal(result.reason, 'changed-during-read');
  assert.equal(result.token, null);
  assert.ok(result.sequence > dirty.sequence);
  assert.equal((await f.freshness.probe(f.scope)).reason, 'read-proof-required');
  const nextTicket = await f.freshness.beginRead(f.scope);
  const nextData = await f.service.getHistory(f.payload);
  assert.equal((await f.freshness.completeRead(f.scope, nextData, nextTicket)).state, 'known',
    'a fresh selected read preserves the normal certifying capability');
});

test('R4 an unrelated tab event does not revoke an otherwise stable final context read', async t => {
  const f = fixture(t, { prepared: false });
  const ticket = await f.freshness.beginRead(f.scope);
  const data = await f.service.getHistory(f.payload);
  const readContext = f.freshness.readContext.bind(f.freshness);
  let calls = 0;
  t.mock.method(f.freshness, 'readContext', async (...args) => {
    const result = await readContext(...args);
    if (++calls === 2) f.freshness.invalidate('other-private-tab');
    return result;
  });
  assert.equal((await f.freshness.completeRead(f.scope, data, ticket)).state, 'known');
});

function holdActualWrite(t, f, kind, successful = false) {
  const entered = deferred(), release = deferred();
  const outcomes = [];
  let held = false;
  if (!successful) {
    const write = f.cache.withAsyncDb.bind(f.cache);
    t.mock.method(f.cache, 'withAsyncDb', (owner, callback, operation) => write(owner, async (db, diagnostic) => {
      const value = await callback(db, diagnostic);
      if (!held && operation === 'savePrepared' && diagnostic.kind === kind) {
        held = true; entered.resolve(); await release.promise;
      }
      return value;
    }, operation));
  }
  const save = f.cache.savePrepared.bind(f.cache);
  t.mock.method(f.cache, 'savePrepared', async request => {
    const result = await save(request);
    const entry = { kind: request.kind || 'view', result };
    outcomes.push(entry);
    if (successful && !held && entry.kind === kind) {
      held = true; entered.resolve(); await release.promise;
    }
    return result;
  });
  return { entered, release, outcomes };
}

for (const kind of ['base', 'view']) for (const delta of [false, true]) {
  test('R5 actual prepared ' + kind + ' refusal closes ' + (delta ? 'delta' : 'full') + ' source before publication', async t => {
    const f = fixture(t);
    const previous = delta ? await f.service.getHistory({ ...f.payload, deltaOk: true }) : null;
    if (delta) f.append('BEFORE-SAVE');
    const gate = holdActualWrite(t, f, kind);
    const pending = f.service.getHistory({ ...f.payload, deltaOk: delta, ifRevision: previous?.revision });
    await gate.entered.promise;
    assert.equal(f.cache.activeFiles.size, 1, 'hold the real native SQLite transaction after its callback');
    f.rewrite('CURRENT-AFTER-REFUSAL');
    gate.release.resolve();
    const result = await pending;
    assert.equal(gate.outcomes.find(entry => entry.kind === kind).result, null,
      'the actual prepared owner quietly refuses an invalidated write; it is not a fake successful store');
    assert.ok(f.diagnostics.some(event => event.operation === 'savePrepared' && event.reason === 'write-invalidated'));
    await assertCurrent(f, result, 'CURRENT-AFTER-REFUSAL');
  });
}

for (const kind of ['base', 'view']) for (const delta of [false, true]) {
  test('R5 source change after actual prepared ' + kind + ' success closes ' + (delta ? 'delta' : 'full') + ' source before publication', async t => {
    const f = fixture(t);
    const previous = delta ? await f.service.getHistory({ ...f.payload, deltaOk: true }) : null;
    if (delta) f.append('BEFORE-SAVE');
    const gate = holdActualWrite(t, f, kind, true);
    const pending = f.service.getHistory({ ...f.payload, deltaOk: delta, ifRevision: previous?.revision });
    await gate.entered.promise;
    assert.equal(f.cache.activeFiles.size, 0, 'the actual SQLite owner already committed successfully');
    assert.equal(gate.outcomes.find(entry => entry.kind === kind).result, true);
    f.rewrite('CURRENT-AFTER-SUCCESS');
    gate.release.resolve();
    await assertCurrent(f, await pending, 'CURRENT-AFTER-SUCCESS');
  });
}

test('R5 repeated source revocation stays bounded by the existing three attempts', async t => {
  const f = fixture(t);
  const save = f.cache.savePrepared.bind(f.cache);
  let attempts = 0;
  t.mock.method(f.cache, 'savePrepared', async request => {
    const result = await save(request);
    if (!request.kind) { attempts++; f.rewrite('REVOKED-' + attempts); }
    return result;
  });
  const result = await f.service.getHistory(f.payload);
  assert.equal(result.success, false);
  assert.equal(result.error, 'history_source_changed_during_preparation');
  assert.deepEqual(result.entries, []);
  assert.equal(attempts, 3, 'no new runner or unbounded retry');
});

test('R5 real prepared owner with source fence throws invalidation instead of returning stale success', async t => {
  const f = fixture(t);
  const gate = holdActualWrite(t, f, 'view');
  let revoked = false;
  f.cache.assertCurrent = () => { if (revoked) throw Object.assign(new Error('fixture source epoch invalidated'), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); };
  const pending = f.service.getHistory(f.payload);
  await gate.entered.promise;
  revoked = true; f.rewrite('CURRENT-SOURCE-FENCE');
  gate.release.resolve();
  await assert.rejects(pending, error => error.code === 'CODEX_SOURCE_READ_INVALIDATED');
  assert.ok(f.diagnostics.some(event => event.operation === 'savePrepared' && event.outcome === 'error'));
  assert.equal(f.cache.activeFiles.size, 0);
});

test('R5 mismatched actual rewrite baseline fallthrough rechecks the child after its final await', async t => {
  const f = fixture(t);
  const source = await f.service.getHistory(f.payload);
  const loaded = await f.scopedApi.loadSessionRecords(f.sessionId, f.root);
  const childId = '22222222-2222-4222-8222-222222222222';
  const childFile = path.join(f.root, 'rollout-' + childId + '.jsonl');
  f.changedFiles.add(childFile);
  const outputRecords = loaded.records.map((row, i) => i === 0 ? { ...row, payload: { ...row.payload, id: childId } } : row);
  const written = await api.writeCodexJsonlExclusive(childFile, outputRecords);
  await api.publishCodexRewriteProjection({ sourceSessionId: f.sessionId, loaded,
    result: { newSessionId: childId, filePath: childFile, written }, outputRecords });
  assert.ok(api.getCodexRewriteReceipt(childId, f.sessionId), 'use the actual committed rewrite projector receipt');
  // A real provider-wide sidecar revision changes the parent baseline token.
  f.db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId: f.sessionId,
    auditTimestamp: '2026-10-08T00:00:00Z', transportHash: '0123456789abcdef', entryUuid: 'missing-parent-user',
    schemaVersion: 1, chips: [{ kind: 'prompt', id: 'private', label: 'private', text: 'private instruction' }] });
  const entered = deferred(), release = deferred();
  const read = f.service.getHistory.bind(f.service);
  let baselineRevision;
  t.mock.method(f.service, 'getHistory', async (...args) => {
    const result = await read(...args);
    if (args[0].rewriteBaselineOnly === true) {
      baselineRevision = result.revision; entered.resolve(); await release.promise;
    }
    return result;
  });
  const childScope = { ...f.scope, sessionId: childId };
  const pending = f.service.getHistory({ ...f.payload, sessionId: childId,
    rewriteFrom: { sessionId: f.sessionId, revision: source.revision } });
  await entered.promise;
  assert.notEqual(baselineRevision.token, source.revision.token, 'exercise the real baseline-mismatch fallthrough');
  f.rewrite('CHILD-CURRENT', childFile, childId);
  release.resolve();
  const result = await pending;
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.entries.map(row => row.content), ['CHILD-CURRENT']);
  assert.equal((await validateHistoryRevision(result.revision, childScope)).unchanged, true);
  assert.equal(result.rewriteReceipt, undefined, 'an invalidated rewrite receipt cannot authorize old-prefix carry');
});
