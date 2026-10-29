'use strict';
// Actual preparation/FIFO/receipt/continuation and Main→Codex result reader.
// SQLite binary port, Electron IPC shell, PID/readiness and native audit are
// controlled. No app/provider/input/native lane; synthetic private JSONL only.
const test = require('node:test'), assert = require('node:assert/strict');
const { installContextFixture } = require('./fixtures/build-install-posthook.cjs');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { promptFingerprint } = require('./claude-prompt-carriers');

test('app-added context binds exact logical→prepared transport→native attempt→actual Main natural result; restart retains the binding', async t => {
  const h = await installContextFixture(t);
  assert.notEqual(promptAuditFingerprint(h.logical), promptAuditFingerprint(h.transport));
  await h.reconcile(); assert.equal(h.blocked(), true); assert.ok(h.reads.length > 0);
  const entry = h.read().entries[0]; assert.equal(entry.state, 'waiting-callback-turn');
  assert.equal(h.reads[0].promptHash, promptFingerprint(h.transport)); assert.equal(h.reads[0].promptHash.length, 64);
  assert.equal(entry.callbackBinding.attemptId, h.attempt.attemptId);
  assert.equal(entry.callbackBinding.transportAuditHash, promptAuditFingerprint(h.transport));
  h.restore(); await h.reconcile(); assert.equal(h.blocked(), true);
  h.complete(); await h.reconcile(); assert.equal(h.blocked(), false);
  const proof = h.read().entries[0].callbackProof; assert.equal(proof.turnId, 'callback-T');
  h.restore(); await h.reconcile(); assert.equal(h.blocked(), false); assert.equal(h.inputs.length, 0);
  assert.equal(h.changes.filter(e => e.state === 'continued').length, 1, 'late/duplicate wakes cannot create a second release');
});

test('same native source-only receipt may learn its canonical UUID before natural final, including after restart', async t => {
  const h = await installContextFixture(t, { sourceOnlyAudit: true });
  await h.reconcile();
  const frozen = h.read().entries[0].callbackBinding;
  assert.equal(frozen.userUuid, null); assert.ok(frozen.sourceIdentity);
  const settledAt = h.store.get(h.operationKey).settledAt;
  const enriched = h.promoteAudit();
  assert.equal(enriched.enriched, true); assert.equal(enriched.promoted, false);
  assert.equal(enriched.record.settledAt, settledAt);
  h.restore();
  const proof = await h.callbackProof();
  assert.ok(proof?.binding.userUuid, 'fresh exact callback proof survives canonical address enrichment');
  assert.equal(proof.naturalFinal, false); assert.equal(h.blocked(), true);
  await h.reconcile(); assert.equal(h.blocked(), true, 'delivery enrichment is not natural completion');
  h.complete(); await h.reconcile(); assert.equal(h.blocked(), false);
  assert.equal(h.read().entries[0].callbackProof.turnId, 'callback-T');
  assert.deepEqual(h.read().entries[0].callbackBinding, frozen, 'historical binding remains unchanged');
  h.restore(); await h.reconcile(); assert.equal(h.inputs.length, 0);
  assert.equal(h.changes.filter(entry => entry.state === 'continued').length, 1);
});

test('canonical UUID enrichment during the exact final read releases once without another Send', async t => {
  const h = await installContextFixture(t, { sourceOnlyAudit: true });
  await h.reconcile(); h.complete();
  h.state.onResult = () => { assert.equal(h.promoteAudit().enriched, true); h.state.onResult = null; };
  await h.reconcile(); assert.equal(h.blocked(), false);
  assert.equal(h.changes.filter(entry => entry.state === 'continued').length, 1); assert.equal(h.inputs.length, 0);
});

test('cancellation during a final read wins over same-receipt canonical enrichment', async t => {
  const h = await installContextFixture(t, { sourceOnlyAudit: true });
  await h.reconcile(); h.complete();
  h.state.onResult = () => { assert.equal(h.promoteAudit().enriched, true); h.cancelRequest(); };
  await h.reconcile(); h.restore(); await h.reconcile();
  assert.equal(h.read().entries[0].state, 'cancelled'); assert.equal(h.blocked(), false);
  assert.equal(h.changes.filter(entry => entry.state === 'continued').length, 0); assert.equal(h.inputs.length, 0);
});

for (const missing of [null, 'entryUuidAliases', 'sourceIdentityAliases']) {
  test('canonical alias promotion keeps every pinned address: missing ' + missing, async t => {
    // Native address facts are controlled; the existing receipt owner performs
    // the real same-attempt alias upgrade and the Main reader proves its final.
    const h = await installContextFixture(t, { initialAudit: { entryUuid: 'early-user', sourceIdentity: 'early-source' } });
    await h.reconcile(); const frozen = h.read().entries[0].callbackBinding;
    const enriched = h.promoteAudit({ entryUuidAliases: ['early-user'], sourceIdentityAliases: ['early-source'] });
    assert.equal(enriched.enriched, true); assert.equal(enriched.promoted, false);
    if (missing) h.state.transform = record => record && ({ ...record,
      auditIdentity: { ...record.auditIdentity, [missing]: [] } });
    h.complete(); h.restore(); await h.reconcile();
    assert.equal(h.blocked(), !!missing); assert.equal(h.inputs.length, 0);
    assert.deepEqual(h.read().entries[0].callbackBinding, frozen);
    if (missing) assert.equal(await h.callbackProof(), null);
    else assert.equal(h.read().entries[0].callbackProof.turnId, 'callback-T');
  });
}

for (const field of ['operationKey', 'attemptId', 'requestFingerprint', 'promptHash', 'auditTimestamp', 'sourceIdentity']) {
  test('canonical enrichment does not absorb changed ' + field + ' into the frozen callback', async t => {
    const h = await installContextFixture(t, { sourceOnlyAudit: true });
    await h.reconcile(); h.promoteAudit(); h.complete(); const reads = h.reads.length;
    h.state.transform = record => {
      if (!record) return record;
      if (field === 'auditTimestamp' || field === 'sourceIdentity') return { ...record,
        auditIdentity: { ...record.auditIdentity, [field]: field === 'auditTimestamp' ? '2040-01-01T00:00:00Z' : 'unrelated-native-source' } };
      return { ...record, [field]: 'changed-' + field };
    };
    await h.reconcile(); assert.equal(h.blocked(), true); assert.equal(h.reads.length, reads);
    assert.equal(await h.callbackProof(), null); assert.equal(h.inputs.length, 0);
  });
}

test('producer refresh of an embedded context wrapper is proved by frozen base hash, without suffix matching', async t => {
  const logical = '<saved_prompt name="old" context-update-id="context-one">\nold content\n</saved_prompt>\n\nContinue callback work.';
  const h = await installContextFixture(t, { logical });
  assert.equal(h.transport.endsWith(logical), false);
  h.complete(); await h.reconcile(); assert.equal(h.blocked(), false);
});

test('v1 exact reversible preparation can recover its logical hash; a missing preparation cannot authorize an arbitrary matching suffix', async t => {
  const h = await installContextFixture(t); h.legacy(); h.complete();
  h.state.readPrepared = () => null; await h.reconcile(); assert.equal(h.blocked(), true); assert.equal(h.reads.length, 0);
  h.state.readPrepared = (tab, handoff) => h.context.readPreparedHandoff(tab, handoff);
  await h.reconcile(); assert.equal(h.blocked(), false);
  assert.equal(h.read().entries[0].callbackIntent.logicalHash.length, 64);
});

test('read-only exact accessor keeps missing and legacy NULL distinct without reservation/status changes', async t => {
  const h = await installContextFixture(t);
  const before = h.db.prepare('SELECT * FROM tab_context_handoffs').all();
  assert.equal(h.context.readPreparedHandoff('sibling', 'build-install-return:J'), null);
  assert.deepEqual(h.db.prepare('SELECT * FROM tab_context_handoffs').all(), before);
  h.db.prepare('UPDATE tab_context_handoffs SET prepared_prompt=NULL').run();
  const legacy = h.context.readPreparedHandoff('753', 'build-install-return:J');
  assert.equal(legacy.prepared_prompt, null); assert.equal(legacy.status, 'preparing');
  h.complete(); await h.reconcile(); assert.equal(h.blocked(), false, 'legacy full bytes come only from the immutable request/native receipt');
});

for (const kind of ['wrong-logical', 'wrong-attempt', 'wrong-source', 'wrong-preparation', 'bad-request-hash', 'failed-preparation', 'merged-preparation']) {
  test('exact binding rejects ' + kind, async t => {
    const h = await installContextFixture(t, kind === 'wrong-logical' ? { preparedLogical: 'another logical callback' } : {});
    if (kind === 'wrong-attempt') h.state.transform = record => record && ({ ...record, auditIdentity: { ...record.auditIdentity, attemptId: 'stale-attempt' } });
    if (kind === 'wrong-source') h.state.owner = 'unrelated-writer';
    if (kind === 'wrong-preparation') h.db.prepare("UPDATE tab_context_handoffs SET prepared_prompt='wrong transport'").run();
    if (kind === 'bad-request-hash') h.db.prepare("UPDATE agent_send_queue SET request_hash='wrong'").run();
    if (kind === 'failed-preparation' || kind === 'merged-preparation') h.db.prepare('UPDATE tab_context_handoffs SET status=?').run(kind.split('-')[0]);
    h.complete(); await h.reconcile(); assert.equal(h.blocked(), true); assert.equal(h.inputs.length, 0);
    assert.equal(h.reads.length, 0, 'invalid provenance never reaches natural result verification');
  });
}

test('stale ACK replacing the audited attempt during natural result read cannot release the frozen binding', async t => {
  const h = await installContextFixture(t); h.complete();
  h.state.onResult = () => { h.state.transform = record => record && ({ ...record, attemptId: 'later-attempt',
    auditIdentity: { ...record.auditIdentity, attemptId: 'later-attempt' } }); };
  await h.reconcile(); assert.equal(h.blocked(), true);
  h.state.onResult = null; h.state.transform = record => record;
  await h.reconcile(); assert.equal(h.blocked(), false); assert.equal(h.inputs.length, 0);
});


test('production Main reader hash-only proof uses normalized full SHA256; exact foreign user/source never falls back to matching hash', async t => {
  const h = await installContextFixture(t); h.complete();
  const request = { sessionId: 'S', toolType: 'codex', cwd: h.root, forceFresh: true, resultReadMode: 'source-proof', maxChars: 1 };
  assert.equal((await h.resultReader({ ...request, promptHash: promptAuditFingerprint(h.transport) })).found, false);
  assert.equal((await h.resultReader({ ...request, promptHash: promptFingerprint(h.transport) })).found, true);
  assert.equal((await h.resultReader({ ...request, promptHash: promptFingerprint(h.transport), promptUserUuid: 'foreign-user' })).found, false);
});


test('a foreign native source identity cannot use the same SID/body/UUID to obtain a natural result', async t => {
  const h = await installContextFixture(t); h.complete();
  h.state.transform = record => record && ({ ...record, auditIdentity: { ...record.auditIdentity, sourceIdentity: 'foreign-native-source' } });
  await h.reconcile(); assert.equal(h.blocked(), true); assert.ok(h.reads.length > 0); assert.equal(h.inputs.length, 0);
});

test('actual WebServer factory reads the same exact preparation owner and passes normalized transport proof to the Main reader', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const h = await installContextFixture(t);
  const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const start = webSource.indexOf('function getBuildInstallContinuations() {');
  const end = webSource.indexOf('\nasync function readBuildInstallContinuations', start);
  assert.ok(start > 0 && end > start);
  let preparedReads = 0;
  const context = vm.createContext({ path, srcMainDir: __dirname, buildInstallContinuations: null, buildContinueOperations: null,
    require: name => name === './project-manager' ? { db: {
      getAppState: () => JSON.parse(h.db.prepare('SELECT value FROM state').get().value),
      setAppState: (_key, value) => h.db.prepare('UPDATE state SET value=?').run(JSON.stringify(value)),
    } } : require(name),
    agentSendReceiptStore: h.store, agentSendQueue: h.queue,
    tabWorkContext: { readPreparedHandoff(tab, handoff) { preparedReads++;
      assert.equal(tab, '753'); assert.equal(handoff, 'build-install-return:J'); return h.context.readPreparedHandoff(tab, handoff); } },
    readAgentRuntimeSnapshot: async () => ({ coherent: true, toolType: 'codex', sessionId: 'S', processStatus: 'found' }),
    getAgentTurnResult: h.resultReader, publishBuildInstallEvent() {}, scheduleTabActivityBroadcast() {},
    // Voice/installer status is outside this context-binding test. Execute the
    // actual current projection against an explicitly empty private status.
    getBuildInstallStatusClient: () => ({ snapshot: () => ({ known: true, stale: false, jobs: [] }) }),
  });
  const projectionStart = webSource.indexOf('function projectBuildInstallStatus(');
  const projectionEnd = webSource.indexOf('\nfunction publishBuildInstallEvent', projectionStart);
  vm.runInContext('let buildInstallPresentation = null;\n' + webSource.slice(projectionStart, projectionEnd)
    + '\n' + webSource.slice(start, end) + ';globalThis.owner = getBuildInstallContinuations();', context);
  await context.owner.reconcile(); assert.equal(context.owner.blocked('753'), true);
  h.complete(); await context.owner.reconcile(); assert.equal(context.owner.blocked('753'), false);
  assert.ok(preparedReads > 0); assert.ok(h.reads.every(request => request.promptHash === promptFingerprint(h.transport)));
});


test('concurrent startup/all-tab and native single-tab reconciliation publish one durable natural release', async t => {
  const h = await installContextFixture(t); h.complete();
  let release, readers = 0; const both = new Promise(resolve => { release = resolve; });
  h.state.onResult = async () => { if (++readers === 2) release(); await both; };
  await Promise.all([h.reconcile(), h.reconcileAll()]);
  assert.equal(h.blocked(), false);
  assert.equal(h.changes.filter(entry => entry.state === 'continued').length, 1);
  assert.equal(h.inputs.length, 0);
});
