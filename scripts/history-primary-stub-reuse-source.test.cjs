'use strict';

// Actual backend producer, private finite SQLite pages and parsed synthetic
// canonical input. No app, provider, user data or native acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { serialize, getHeapStatistics } = require('node:v8');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { createPrimaryHistoryPresentation } = require('../src/main/history-root-engine/main/history-primary-presentation');
const { retainPrimaryHistoryPresentation } = require('../src/main/history-root-engine/main/history-primary-semantic-bundle');
const { materializeHistoryCursorSync: materialize } = require('../src/main/history-root-engine/main/history-paged-store');
assert(getHeapStatistics().heap_size_limit <= 96 * 1024 ** 2, 'run with the bounded V8 command');
const control = { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } };
const row = (uuid, extra = {}) => ({ uuid, role: 'assistant', sessionId: 's',
  timestamp: '2026-10-28T00:00:00.000Z', content: '  FULL Ω\0\ud800😀 ' + uuid + '  ', ...extra });
const args = (f, payload = {}, extra = {}) => ({ service: {}, control,
  payload: { ...f.payload, grouping: { enabled: false }, ...payload }, ...extra });
const digest = value => createHash('sha256').update(serialize(value)).digest('hex');

test('finite 16-row duplicate construction counter, complete content and independent metadata domains', async t => {
  const shared = { text: 'metadata Ω\ud800\0😀'.repeat(50), missing: undefined, minus: -0 };
  shared.self = shared;
  const sparse = new Array(5); sparse[3] = shared;
  const entries = Array.from({ length: 16 }, (_, i) => row('r' + i, {
    content: ('  full ' + i + ' Ω\ud800\0😀 ').repeat(150), thinking: ' thinking '.repeat(32),
    questionReplyProof: { left: shared, right: shared, sparse },
    actions: [{ tool: '__raw__', rawTool: { toolUseId: 'tool-' + i, toolName: 'Read',
      args: { file_path: '/finite/Ω\ud800-' + i + '.js', offset: 0, limit: 10 }, recordTime: 1 } }],
  }));
  const f = await createPrimaryAddressFixture(t, { entries }); let summary;
  const before = f.store.stats().leases;
  const result = await createPrimaryHistoryPresentation(f.store, f.source, args(f, {}, {
    diagnostics: { complete(value) { summary = value; } },
  }));
  try {
    const stats = result.stats(), canonical = materialize(result.durableMetadataCursor), prepared = materialize(result.sourceMetadataCursor);
    assert.equal(stats.canonicalStubRows, 16);
    assert.equal(stats.preparedStubRows, 0);
    assert.equal(stats.preparedReusedStubRows, 16);
    assert.deepEqual(prepared, canonical);
    for (let i = 0; i < 16; i++) {
      const proof = prepared[i].questionReplyProof;
      assert.equal(proof.left, proof.right); assert.equal(proof.left.self, proof.left);
      assert.equal(proof.sparse[3], proof.left); assert.equal(0 in proof.sparse, false);
      assert.equal(proof.left.text, shared.text); assert(Object.is(proof.left.minus, -0));
      assert.equal(prepared[i].contentLength, entries[i].content.trim().length);
      assert.equal(prepared[i].hasThinking, true);
      assert.equal(prepared[i].actionSummary[0].toolUseId, 'tool-' + i);
      assert.equal(materialize(result.unitAt(i)).entry.content, entries[i].content);
    }
    assert.equal(result.canonicalMetadataValidation.canonicalEntryCount, 16);
    assert.equal(Object.hasOwn(result.canonicalMetadataValidation, 'preparedEntryCount'), false);
    assert.equal(result.preparedMetadataValidation.preparedEntryCount, 16);
    assert.equal(Object.hasOwn(result.preparedMetadataValidation, 'canonicalEntryCount'), false);
    assert.notEqual(result.canonicalMetadataValidation, result.preparedMetadataValidation);
    console.log('[HistoryStubReuse] ' + JSON.stringify({ rows: 16,
      canonicalStubRows: stats.canonicalStubRows, preparedStubRows: stats.preparedStubRows,
      preparedReusedStubRows: stats.preparedReusedStubRows, scalarReads: stats.scalarReads,
      metadataDigest: digest(prepared), elapsedMs: summary.elapsedMs,
      phases: summary.phases.map(p => ({ stage: p.stage, elapsedMs: p.elapsedMs })),
      store: f.store.stats() }));
  } finally { result.close(); }
  assert.equal(f.store.stats().leases, before); assert.equal(f.store.stats().activeBuilders, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
});

test('same UUID and ordinal with changed CURRENT tool results rebuilds only that stub', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [row('a', { actions: [{ tool: '__raw__',
    rawTool: { toolUseId: 'call', toolName: 'Read', args: { file_path: '/finite/file' }, result: 'old', isError: false } }] }), row('b')] });
  const result = await createPrimaryHistoryPresentation(f.store, f.source, args(f, {
    liveToolResults: [{ toolUseId: 'call', result: 'new\ud800\0😀', isError: true }],
  }));
  try {
    assert.equal(result.stats().preparedStubRows, 1); assert.equal(result.stats().preparedReusedStubRows, 1);
    const canonical = materialize(result.durableMetadataCursor), prepared = materialize(result.sourceMetadataCursor);
    assert.equal(canonical[0].uuid, prepared[0].uuid);
    assert.equal(canonical[0].actionSummary[0].isError, undefined);
    assert.equal(prepared[0].actionSummary[0].isError, true);
    assert.equal(materialize(result.presentationSource())[0].actions[0].rawTool.result, 'new\ud800\0😀');
    assert.deepEqual(prepared[1], canonical[1]);
  } finally { result.close(); }
});

test('same-length settings decoration keeps exact key grammar and gets a fresh stub', async t => {
  const key = 'old-visible-key\0\ud800😀';
  const f = await createPrimaryAddressFixture(t, { entries: [row('settings', { role: 'slash',
    sourceIdentity: 'settings-source', content: '/model x',
    settingsFact: { version: 1, provider: 'codex', kind: 'model', value: 'x' } })] });
  const result = await createPrimaryHistoryPresentation(f.store, f.source, args(f, {
    settingsPresentationKeys: [['settings-source', key]],
  }));
  try {
    assert.equal(result.stats().preparedStubRows, 1); assert.equal(result.stats().preparedReusedStubRows, 0);
    assert.equal(materialize(result.durableMetadataCursor)[0].settingsPresentationKey, undefined);
    assert.equal(materialize(result.sourceMetadataCursor)[0].settingsPresentationKey, key);
    assert.equal(materialize(result.settingsPresentationKeysCursor).get('settings-source'), key);
  } finally { result.close(); }
});

test('inserted live row shifts ordinals; count and UUIDs never substitute for exact owner identity', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [row('a', { recordByteOffset: 10 }), row('b', { recordByteOffset: 30 })] });
  const result = await createPrimaryHistoryPresentation(f.store, f.source, args(f, {
    liveEntries: [row('inserted', { recordByteOffset: 20, liveProjection: true })],
  }));
  try {
    assert.deepEqual(materialize(result.sourceMetadataCursor).map(r => r.uuid), ['a', 'inserted', 'b']);
    assert.equal(result.stats().preparedStubRows, 2); assert.equal(result.stats().preparedReusedStubRows, 1);
    assert.equal(result.canonicalMetadataValidation.canonicalEntryCount, 2);
    assert.equal(result.preparedMetadataValidation.preparedEntryCount, 3);
  } finally { result.close(); }
});

test('reused graph still receives both complete metadata refusals', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [row('bad', { questionReplyProof: { bad: new Map([['x', 1]]) } })] });
  const result = await createPrimaryHistoryPresentation(f.store, f.source, args(f));
  try {
    assert.equal(result.stats().preparedReusedStubRows, 1);
    for (const fact of [result.canonicalMetadataValidation, result.preparedMetadataValidation]) {
      assert.equal(fact.kind, 'refused'); assert.equal(fact.error, 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED');
    }
    await assert.rejects(result.validatePreparedMetadata(), { code: 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED' });
    await assert.rejects(result.validateCanonicalMetadata(), { code: 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED' });
  } finally { result.close(); }
});

test('cancellation during reused prepared loop preserves original error and releases all provisional leases', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: Array.from({ length: 16 }, (_, i) => row('r' + i)) });
  const before = f.store.stats().leases, original = Object.assign(Error('owned cancellation'), { code: 'HISTORY_READ_CANCELLED' });
  let stage, reads = 0, summary;
  await assert.rejects(createPrimaryHistoryPresentation(f.store, f.source, args(f, {}, {
    control: { assertCurrent() { if (stage === 'primary-prepared-stubs' && ++reads === 8) throw original; },
      async checkpoint() { this.assertCurrent(); await new Promise(resolve => setImmediate(resolve)); this.assertCurrent(); } },
    diagnostics: { beginPhase(name) { stage = name; }, complete(value) { summary = value; } },
  })), error => error === original);
  assert.equal(summary.failedStage, 'prepared-stubs'); assert.equal(summary.outcome, 'error');
  assert.equal(f.store.stats().leases, before); assert.equal(f.store.stats().activeBuilders, 0);
  assert.equal(materialize(f.source.entries).length, 16);
});

test('independent retained owner survives original close and rejects closed wrapper reads', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [row('owned')] });
  const before = f.store.stats().leases;
  const result = await createPrimaryHistoryPresentation(f.store, f.source, args(f));
  const retained = retainPrimaryHistoryPresentation(f.store, result);
  try {
    result.close(); result.close();
    assert.throws(() => result.stats(), { code: 'HISTORY_PRIMARY_RELEASED' });
    assert.equal(materialize(retained.unitAt(0)).entry.content, row('owned').content);
    assert.equal((await retained.validatePreparedMetadata()).preparedEntryCount, 1);
    assert.equal((await retained.validateCanonicalMetadata()).canonicalEntryCount, 1);
  } finally { retained.close(); }
  assert.equal(f.store.stats().leases, before);
});
