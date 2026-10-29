'use strict';

// Finite SOURCE control: actual paged store, source-owner validator, read
// plane, checked shared client, and exact existing prepared decoder function.
// Synthetic parsed metadata and in-process IPC are the declared substitutions.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { getHeapStatistics } = require('node:v8');
const MAIN = path.resolve(__dirname, '../src/main/history-root-engine/main');
const { HistoryPagedStore, historyPagedCursorAddress } = require(path.join(MAIN, 'history-paged-store'));
const { validateCanonicalMetadata, establishCanonicalMetadataValidation, sourceProjection, digestJSON } = require(path.join(MAIN, 'history-primary-metadata-validation'));
const Database = require('./test-support/history-node-sqlite.cjs');
assert(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'bounded source process required');
const thin = extra => ({ uuid: 'u', rowStub: true, role: 'assistant', sessionId: 's', ...extra });
function setup(t, rows) {
  const store = new HistoryPagedStore({ Database, pageBytes: 1024, residentPages: 3, indexBytes: 2048,
    sqlCacheKiB: 8, diskBytes: 28 * 1024 ** 2 });
  const lease = store.captureLegacy(rows);
  t.after(() => { lease.release(); assert.equal(store.stats().leases, 0); assert.equal(store.stats().activeBuilders, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
    assert(store.stats().peakCachedPages <= 3); assert(store.stats().peakIndexBytes <= 2048); store.close(); });
  return { store, lease };
}
function nativeDecoder() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/utils/historyPrimaryRootReadModel.mjs'), 'utf8');
  const start = source.indexOf('async function readActionMetadata('), end = source.indexOf('\n// Only server-decoded', start);
  const thinStart = source.indexOf('function assertThin('), thinEnd = source.indexOf('\n// An explicit', thinStart);
  const textStart = source.indexOf('async function readPrimaryDocumentText('), textEnd = source.indexOf('\nexport async function readHistoryPrimaryUnitDocument', textStart);
  assert(start > 0 && end > start && thinStart > 0 && thinEnd > thinStart && textEnd > textStart);
  return new Function('fail', 'current', 'release', 'createDocumentUtf16Digest', 'HISTORY_PRIMARY_PAGE_ITEMS', 'metadataRules',
    source.slice(thinStart, thinEnd) + '\n' + source.slice(textStart, textEnd) + '\n' + source.slice(start, end) + '\nreturn readActionMetadata;')(
    code => Object.assign(new Error(code), { code }), (signal, owns) => { if (signal?.aborted || !owns()) throw Error('stale'); },
    document => document?.close?.(), async () => ({
      hash: crypto.createHash('sha256'), update(part) { this.hash.update(Buffer.from(part, 'utf16le')); }, digest() { return this.hash.digest('hex'); },
    }), 3, require('../src/shared/history-primary-metadata-rules.cjs'));
}
async function decodeActual(store, lease) {
  const { HistoryRootReadPlane } = require(path.join(MAIN, 'history-root-read-plane'));
  const { HistoryRootClient } = await import(pathToFileURL(path.resolve(__dirname, '../src/shared/history-root-read-client.mjs')));
  const held = lease.fork(), plane = new HistoryRootReadPlane({ store, projectHistory: async () => {} });
  const { descriptor } = plane.install({ root: held }, held.cursor(), { consumerKey: 'finite', ownerKey: 'finite', revision: 'finite',
    source: {}, release: () => held.release() });
  const reader = new HistoryRootClient(async (channel, request) => {
    if (channel.endsWith('read-page')) return plane.readPage(request, { consumerKey: 'finite' });
    if (channel.endsWith('fork-read-leaf')) return plane.forkLeaf(request, { consumerKey: 'finite' });
    if (channel.endsWith('release-read-root')) return plane.release(request, { consumerKey: 'finite' });
    throw Error(channel);
  }, descriptor, { pageBytes: 65536, pageItems: 3 });
  try { return await nativeDecoder()(reader, descriptor, { owns: () => true }); }
  finally { await reader.close(); plane.close(); }
}

test('supported aliases/cycles/shared refs/undefined/lone-surrogates match actual native metadata decoder', async t => {
  const shared = { text: 'a\ud800\u0000'.repeat(35), absent: undefined, count: 3n, minus: -0, nan: NaN };
  shared.self = shared;
  const sparse = new Array(4); sparse[2] = shared; sparse.extra = new Map([['ignored-array-extra', 1]]);
  const rows = [thin({ uuid: {}, questionReplyProof: shared, actionSummary: sparse, sourceUuidAliases: shared })];
  const { store, lease } = setup(t, rows);
  const fact = await validateCanonicalMetadata(store, lease);
  assert.equal(fact.kind, 'validated'); assert.match(fact.digest, /^[a-f0-9]{64}$/);
  const decoded = await decodeActual(store, lease);
  assert.equal(decoded[0].questionReplyProof.self, decoded[0].questionReplyProof);
  assert.equal(decoded[0].questionReplyProof, decoded[0].sourceUuidAliases);
  assert.equal(decoded[0].questionReplyProof.text, shared.text);
  assert.equal(Object.hasOwn(decoded[0].actionSummary, 'extra'), false);
  assert.equal(0 in decoded[0].actionSummary, false);
  assert.equal((await validateCanonicalMetadata(store, lease)).digest, fact.digest);
});

for (const [name, extra, error] of [
  ['zero uuid', { uuid: 0 }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['bigint zero uuid', { uuid: 0n }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['false stub', { rowStub: false }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['content object', { content: {} }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['caption false', { captionTextComplete: false }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['thinking', { thinking: 'late' }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['compact', { compactSummary: 'late' }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['actions text', { actions: 'x' }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['actions length object', { actions: { length: {} } }, 'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'],
  ['nested map', { questionReplyProof: { value: new Map() } }, 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED'],
  ['nested set', { questionReplyProof: { value: new Set() } }, 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED'],
  ['wide bigint', { questionReplyProof: { value: BigInt('9'.repeat(65)) } }, 'HISTORY_ROOT_VALUE_INVALID'],
]) test('whole metadata validation and actual decoder both refuse ' + name, async t => {
  const { store, lease } = setup(t, [thin(), thin(extra)]);
  await assert.rejects(validateCanonicalMetadata(store, lease), { code: error });
  await assert.rejects(decodeActual(store, lease), { code: error });
  const fact = await establishCanonicalMetadataValidation(store, lease);
  assert.equal(fact.kind, 'refused'); assert.equal(fact.digest, null); assert.equal(fact.error, error);
});

test('falsey content/actions lengths and object/array truthy UUID retain original acceptance', async t => {
  const { store, lease } = setup(t, [thin({ uuid: [], content: '', actions: { length: 0n }, captionTextComplete: null }),
    thin({ uuid: 1n, thinking: false, compactSummary: 0, actions: false })]);
  assert.equal((await validateCanonicalMetadata(store, lease)).kind, 'validated');
  assert.equal((await decodeActual(store, lease)).length, 2);
});

test('selected diagnostic tail is exact bounded projection; absent and empty are distinct', async t => {
  const { store, lease } = setup(t, [thin({ uuid: { nested: 'not a diagnostic string' }, sourceIdentity: 'x'.repeat(513),
    contentRevision: '\ud800\n', recordByteOffset: Infinity, liveProjection: true, sourceSequence: 2, sessionId: 's' })]);
  const fact = await validateCanonicalMetadata(store, lease), tail = fact.diagnosticTail;
  assert.equal(tail.kind, 'row'); assert.equal(tail.ordinal, 0);
  assert.deepEqual(tail.fields.map(f => [f.name, f.kind]), [['uuid', 'invalid'], ['sourceIdentity', 'invalid'],
    ['contentRevision', 'value'], ['recordByteOffset', 'invalid'], ['sessionId', 'value'], ['liveProjection', 'value'], ['sourceSequence', 'value']]);
  assert.equal(tail.fields[2].value, '\ud800\n');
  const empty = store.captureLegacy([]);
  try { assert.deepEqual((await validateCanonicalMetadata(store, empty)).diagnosticTail, { kind: 'empty' }); }
  finally { empty.release(); }
});

test('selected diagnostic signed zero has a distinct digest-covered wire shape', async t => {
  const { store, lease } = setup(t, [thin({ recordByteOffset: -0, liveProjection: true, sourceSequence: -0 })]);
  const fact = await validateCanonicalMetadata(store, lease);
  for (const name of ['recordByteOffset', 'sourceSequence']) {
    assert.deepEqual(fact.diagnosticTail.fields.find(field => field.name === name), { name, kind: 'negative-zero' });
  }
  const wire = JSON.stringify(fact.diagnosticTail.fields);
  assert(!wire.includes('"value":0'));
  assert.notEqual(crypto.createHash('sha256').update(wire).digest('hex'),
    crypto.createHash('sha256').update(wire.replace('negative-zero', 'value')).digest('hex'));
});

test('cold repeated validation rejects hidden leaf corruption despite cached earlier fact', async t => {
  const { store, lease } = setup(t, [thin(), thin({ questionReplyProof: { nested: 'x'.repeat(2048) } })]);
  await validateCanonicalMetadata(store, lease);
  const address = historyPagedCursorAddress(lease.cursor().at(1).field('questionReplyProof').field('nested'));
  const meta = store.json(address.ref.id), page = store.vectorGet(meta.chunks, 0);
  store.read(page); // Deliberately populate a prior successful cache entry.
  store.db.prepare('UPDATE hp_pages SET body=? WHERE id=?').run(Buffer.from('bad'), page);
  await assert.rejects(validateCanonicalMetadata(store, lease), /history_page_corrupt/);
});

test('cancellation/closed-owner during checkpoint clears disk frontier and publishes no fact', async t => {
  const { store, lease } = setup(t, Array.from({ length: 12 }, (_, i) => thin({ uuid: 'u' + i })));
  let cancelled = false;
  const control = { assertCurrent() { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'FINITE_CANCELLED' }); },
    async checkpoint() { cancelled = true; } };
  await assert.rejects(validateCanonicalMetadata(store, lease, { control }), { code: 'FINITE_CANCELLED' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
});

async function connected(t, entries, options = {}) {
  const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
  const f = await createPrimaryAddressFixture(t, { entries });
  const opened = await f.open(options); assert.equal(opened.kind, 'root');
  const state = f.plane.state(opened.root, f.consumerKey);
  const request = () => ({ kind: 'primary-canonical-metadata', ...f.plane.canonicalMetadataBinding(state).binding,
    creditBytes: 65536 });
  return { f, opened, state, request, read: (input, control) => f.plane.readPage(input || request(), { consumerKey: f.consumerKey, control }) };
}
const full = (uuid, extra = {}) => ({ uuid, role: 'user', content: 'text-' + uuid,
  sessionId: 's', timestamp: '2026-10-27T00:00:00.000Z', ...extra });

test('actual producer/bundle/plane cold fact is bound and retains unchanged durable selected descriptor', async t => {
  const x = await connected(t, [full('first'), full('last', { sourceIdentity: 'source', contentRevision: 'revision', recordByteOffset: 12 })]);
  const packet = await x.read();
  assert.equal(packet.kind, 'primary-canonical-metadata'); assert.equal(packet.canonicalEntryCount, 2);
  assert.equal(packet.nodeToken, x.opened.header.durableMetadata.nodeToken);
  assert.equal(packet.sourceNodeToken, x.opened.header.sourceMetadata.nodeToken);
  assert.equal(packet.parentNodeToken, x.opened.root.nodeToken);
  assert.match(packet.validationReceipt, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(x.opened.header.canonicalMetadataValidation, 'validationReceipt'), false);
  assert.equal(packet.diagnosticTail.kind, 'row'); assert.equal(packet.diagnosticTail.ordinal, 1);
  assert.equal(packet.diagnosticTail.fields.find(f => f.name === 'uuid').value, 'last');
  assert.equal(packet.creditBytesUsed, Buffer.byteLength(JSON.stringify(packet)));
  assert(packet.creditBytesUsed <= 65536);
  assert.equal(x.f.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
  await x.opened.reader.close();
});

test('late malformed canonical row hidden by actual Rewind still refuses; independent selected grammar stays available', async t => {
  const x = await connected(t, [full('first'), full('target'), full('hidden', { questionReplyProof: { nested: new Map([['key', 'value']]) } })],
    { rewindPreview: { targetUuid: 'target' } });
  assert.equal(x.opened.header.canonicalEntryCount, 3);
  assert(x.opened.header.sourceEntryCount < x.opened.header.canonicalEntryCount);
  assert.equal(x.state.primaryPresentation.canonicalMetadataValidation.kind, 'refused');
  await assert.rejects(x.read(), { code: 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED' });
  assert.equal(x.f.plane.state(x.opened.root, x.f.consumerKey), x.state, 'failed demand does not retire shared selected consumers');
  await x.opened.reader.close();
});

test('wrong token/schema/count/source epoch and owner binding refuse without shared-root cleanup', async t => {
  const x = await connected(t, [full('one')]);
  for (const key of ['nodeToken', 'sourceNodeToken', 'parentNodeToken', 'metadataIdentity', 'semanticIdentity',
    'semanticRevisionToken', 'viewRevisionToken', 'sourceProof', 'validationDigest', 'validationToken', 'diagnosticTailDigest']) {
    const request = x.request(); request[key] = 'wrong';
    await assert.rejects(x.read(request), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  }
  for (const key of ['schema', 'metadataSchema', 'canonicalEntryCount', 'sourceEntryCount']) {
    const request = x.request(); request[key]++;
    await assert.rejects(x.read(request), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  }
  const missing = x.request(); delete missing.metadataIdentity;
  await assert.rejects(x.read(missing), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  const epoch = x.request(); epoch.sourceProof = digestJSON(sourceProjection({ ...x.state.source, sourceGeneration: 'new-epoch' }));
  await assert.rejects(x.read(epoch), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  const duplicated = x.request(); duplicated.sourceSnapshot = { ...x.state.source };
  await assert.rejects(x.read(duplicated), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_SOURCE' });
  assert.equal(x.f.plane.state(x.opened.root, x.f.consumerKey), x.state);
  assert.equal((await x.read()).canonicalEntryCount, 1);
  await x.opened.reader.close();
});

test('source proof retains signed zero and exact optional epoch with the fixed source vocabulary', () => {
  const source = { filePath: '/finite', sessionId: 's', size: -0, mtimeMs: -0, ctimeMs: -0,
    fileIdentity: 'file', linkKind: 'end', sourceGeneration: 'epoch' };
  const projected = sourceProjection(source);
  assert.deepEqual(Object.keys(projected), ['filePath', 'sessionId', 'size', 'mtimeMs', 'ctimeMs', 'fileIdentity', 'linkKind', 'sourceGeneration']);
  for (const key of ['size', 'mtimeMs', 'ctimeMs']) {
    assert.deepEqual(projected[key], { kind: 'negative-zero' });
    assert.notEqual(digestJSON(projected), digestJSON(sourceProjection({ ...source, [key]: 0 })));
  }
  const absent = { ...source }; delete absent.sourceGeneration;
  assert.notEqual(digestJSON(projected), digestJSON(sourceProjection(absent)));
  assert.notEqual(digestJSON(projected), digestJSON(sourceProjection({ ...source, sourceGeneration: 'changed' })));
});

test('full escaped source header stays admissible while metadata request omits its duplicate under the unchanged 64 KiB cap', async t => {
  // The parsed source snapshot is an explicit fixture input. The actual
  // immutable owner fork, producer, header checker and checked demand run.
  const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
  const { forkFrozenCanonical } = require(path.join(MAIN, 'history-frozen-canonical'));
  const sessionId = '\0'.repeat(4096), sourceSnapshot = { filePath: '\0'.repeat(4096), sessionId,
    size: -0, mtimeMs: -0, ctimeMs: -0, fileIdentity: '\0'.repeat(2048), linkKind: 'end', sourceGeneration: '\0'.repeat(2048) };
  assert(Buffer.byteLength(JSON.stringify(sourceSnapshot)) > 65536);
  const f = await createPrimaryAddressFixture(t, { sessionId, entries: [full('one', { sessionId })] });
  const originalProject = f.plane.projectHistory;
  f.plane.projectHistory = async (...args) => {
    const original = await originalProject(...args);
    try { return forkFrozenCanonical(f.store, { ...original, sourceSnapshot }); }
    finally { original.release(); }
  };
  const opened = await f.open(); assert.equal(opened.kind, 'root', f.errors.at(-1)?.stack);
  let requestBytes;
  const fact = await opened.reader.canonicalMetadataValidation(opened.header, { invoke: async (channel, payload) => {
    assert.equal(channel, 'agent-transcript:read-page');
    assert.equal(Object.hasOwn(payload, 'sourceSnapshot'), false);
    requestBytes = Buffer.byteLength(JSON.stringify(payload)); assert(requestBytes <= 65536);
    return f.invoke(channel, payload);
  } });
  assert(requestBytes > 0); assert.equal(fact.canonicalEntryCount, 1);
  assert.equal(fact.sourceSnapshot.sourceGeneration, sourceSnapshot.sourceGeneration);
  for (const key of ['size', 'mtimeMs', 'ctimeMs']) assert(Object.is(fact.sourceSnapshot[key], -0));
  const state = f.plane.state(opened.root, f.consumerKey), binding = f.plane.canonicalMetadataBinding(state).binding;
  for (const key of ['size', 'mtimeMs', 'ctimeMs']) {
    const request = { ...binding, kind: 'primary-canonical-metadata', creditBytes: 65536,
      sourceProof: digestJSON(sourceProjection({ ...sourceSnapshot, [key]: 0 })) };
    await assert.rejects(f.plane.readPage(request, { consumerKey: f.consumerKey }), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  }
  const envelope = { ...binding, kind: 'primary-canonical-metadata', creditBytes: 65536,
    readDemandId: 'finite-demand', diagnosticReadId: 'finite-read', diagnosticActionId: 'finite-action' };
  assert.equal((await f.plane.readPage(envelope, { consumerKey: f.consumerKey })).success, true);
  await opened.reader.close();
});

test('actual cold demand detects post-construction hidden scalar corruption with recomputed page SHA', async t => {
  const x = await connected(t, [full('first'), full('target'), full('hidden', { questionReplyProof: { scalar: 1 } })],
    { rewindPreview: { targetUuid: 'target' } });
  const cursor = x.state.primaryPresentation.durableMetadataCursor.at(2).field('questionReplyProof');
  const address = historyPagedCursorAddress(cursor), meta = x.f.store.json(address.ref.id);
  const fieldPage = x.f.store.vectorGet(meta.fields, 0), body = x.f.store.json(fieldPage);
  body.value = { type: 'number', value: '2' };
  const bytes = Buffer.from(JSON.stringify(body));
  x.f.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(bytes, crypto.createHash('sha256').update(bytes).digest('hex'), fieldPage);
  await assert.rejects(x.read(), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_CHANGED' });
  await x.opened.reader.close();
});

test('actual view fork keeps same immutable validation digest and rebinds exact capability token', async t => {
  const x = await connected(t, [full('one')]);
  const previous = x.f.plane.canonicalMetadataBinding(x.state).binding;
  const before = await x.read();
  const view = await x.f.open({ primaryRequestClass: 'view', localRootLease: x.opened.header,
    expectedSemanticIdentity: x.opened.header.semanticIdentity, primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } });
  assert.equal(view.kind, 'root');
  const state = x.f.plane.state(view.root, x.f.consumerKey), next = x.f.plane.canonicalMetadataBinding(state).binding;
  assert.equal(next.validationDigest, before.validationDigest); assert.equal(next.metadataIdentity, before.metadataIdentity);
  assert.notEqual(next.validationToken, before.validationToken); assert.notEqual(next.nodeToken, before.nodeToken);
  const reuseValidation = { ...previous, validationReceipt: before.validationReceipt };
  const request = { kind: 'primary-canonical-metadata', ...next,
    reuseValidation, creditBytes: 65536 };
  const sql = x.f.store.sql;
  x.f.store.sql = function (query) {
    if (query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work')) {
      throw Object.assign(new Error('cold scan poison'), { code: 'FINITE_COLD_SCAN_POISON' });
    }
    return sql.call(this, query);
  };
  let packet;
  try {
    packet = await x.f.plane.readPage(request, { consumerKey: x.f.consumerKey });
    const cold = { ...request }; delete cold.reuseValidation;
    await assert.rejects(x.f.plane.readPage(cold, { consumerKey: x.f.consumerKey }), { code: 'FINITE_COLD_SCAN_POISON' });
  } finally { x.f.store.sql = sql; }
  assert.equal(packet.diagnosticTail.fields.find(f => f.name === 'uuid').value, 'one');
  assert.notEqual(packet.validationReceipt, before.validationReceipt);
  await view.reader.close(); await x.opened.reader.close();
});

test('view reuse requires a prior completed-demand receipt and exact old/new immutable owner binding', async t => {
  const x = await connected(t, [full('one')]), previous = x.f.plane.canonicalMetadataBinding(x.state).binding;
  const before = await x.read(), witness = { ...previous, validationReceipt: before.validationReceipt };
  // Even a valid receipt cannot turn a new semantic request into passive reuse.
  await assert.rejects(x.read({ ...x.request(), reuseValidation: witness }), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_REUSE' });
  const view = await x.f.open({ primaryRequestClass: 'view', localRootLease: x.opened.header,
    expectedSemanticIdentity: x.opened.header.semanticIdentity, primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } });
  assert.equal(view.kind, 'root');
  const state = x.f.plane.state(view.root, x.f.consumerKey), next = x.f.plane.canonicalMetadataBinding(state).binding;
  const request = () => ({ kind: 'primary-canonical-metadata', ...next,
    reuseValidation: { ...witness }, creditBytes: 65536 });
  const read = input => x.f.plane.readPage(input, { consumerKey: x.f.consumerKey });
  for (const key of ['validationReceipt', 'validationToken', 'nodeToken', 'sourceNodeToken', 'parentNodeToken',
    'metadataIdentity', 'semanticIdentity', 'sourceProof', 'validationDigest', 'diagnosticTailDigest']) {
    const input = request(); input.reuseValidation[key] = '0'.repeat(64);
    await assert.rejects(read(input), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_REUSE' });
  }
  const missing = request(); delete missing.reuseValidation.validationReceipt;
  await assert.rejects(read(missing), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_REUSE' });
  const headerOnly = request(); headerOnly.reuseValidation = { ...previous, validationReceipt: previous.validationToken };
  await assert.rejects(read(headerOnly), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_REUSE' });
  const alteredNew = request(); alteredNew.nodeToken = previous.nodeToken;
  await assert.rejects(read(alteredNew), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  await x.opened.reader.close(); // same immutable bundle held independently by the view
  assert.equal((await read(request())).validationDigest, before.validationDigest);
  await view.reader.close();
});

test('view reuse rechecks the original owner after its bounded checkpoint', async t => {
  const x = await connected(t, [full('one')]), previous = x.f.plane.canonicalMetadataBinding(x.state).binding;
  const before = await x.read();
  const view = await x.f.open({ primaryRequestClass: 'view', localRootLease: x.opened.header,
    expectedSemanticIdentity: x.opened.header.semanticIdentity, primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } });
  const state = x.f.plane.state(view.root, x.f.consumerKey), next = x.f.plane.canonicalMetadataBinding(state).binding;
  const request = { kind: 'primary-canonical-metadata', ...next,
    reuseValidation: { ...previous, validationReceipt: before.validationReceipt }, creditBytes: 65536 };
  let checkpoint = false;
  await assert.rejects(x.f.plane.readPage(request, { consumerKey: x.f.consumerKey, control: {
    assertCurrent() {}, async checkpoint() { checkpoint = true; await view.reader.close(); },
  } }));
  assert(checkpoint); assert.equal(x.f.plane.state(x.opened.root, x.f.consumerKey), x.state);
  await x.opened.reader.close();
});

test('reentrant parent close during actual cold validation refuses and preserves unrelated root', async t => {
  const x = await connected(t, Array.from({ length: 8 }, (_, i) => full('u' + i)));
  const other = await x.f.open(); assert.equal(other.kind, 'root');
  let entered = false;
  const control = { assertCurrent() {}, async checkpoint() {
    if (!entered) { entered = true; await x.opened.reader.close(); }
  } };
  await assert.rejects(x.read(undefined, control));
  assert(entered); assert(x.f.plane.state(other.root, x.f.consumerKey));
  assert.equal(x.f.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
  await other.reader.close();
});

test('actual controller allocates and FIFO-admits canonical validation with unchanged quotas and no UNKNOWN replay', async t => {
  // Exact controller method AST extraction, as in the retained source control.
  // Maintenance/backing work and diagnostic logging remain declared doubles;
  // admission, dispatch, store, semantic owner and validation plane are real.
  const parser = require(process.env.NOTED_TEST_BABEL_PARSER || '@babel/parser');
  const source = fs.readFileSync(path.join(MAIN, 'history-root-controller.js'), 'utf8');
  const ast = parser.parse(source, { sourceType: 'script' });
  const declaration = ast.program.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'HistoryRootController');
  assert(declaration);
  const selected = ['allocates', 'installedTextPinFork', 'dispatch', 'consumer', 'dispatchOwned'].map(name => {
    const node = declaration.body.body.find(item => item.type === 'ClassMethod' && item.key.name === name);
    assert(node, 'actual controller method ' + name); return source.slice(node.start, node.end);
  });
  const Controller = new Function('backingPhase', 'fail', 'return class SourceController {' + selected.join('\n') + '}')(
    () => () => {}, code => Object.assign(new Error(code), { code }));
  const { createReadAdmission } = require(path.join(MAIN, 'history-read-control'));
  const x = await connected(t, Array.from({ length: 5 }, (_, i) => full('fifo-' + i)));
  const events = [], admission = createReadAdmission(), budget = x.f.store.diskBudget;
  const ctl = Object.assign(Object.create(Controller.prototype), { plane: x.f.plane, store: x.f.store,
    closed: false, initializedBacking: true, fullCollectionDepth: 0, sourceOptions: {}, sourceSchema: 'finite',
    maintenanceMetrics: { cleanupErrors: 0 }, maintenanceAdmission: admission,
    ensurePlane() { events.push('ensure'); return x.f.plane; },
    async initializeBacking() { events.push('initialize'); },
    collectBounded(limit, reason) { assert.equal(limit, 64); assert.equal(reason, 'allocation-collection'); events.push('collect64'); },
    async makeRoom(method) { assert.equal(method, 'readHistoryRootPage'); events.push('room'); },
    cleanupStep() { events.push('cleanup'); },
  });
  const request = { ...x.request(), _historyRootConsumerKey: x.f.consumerKey };
  assert.equal(ctl.allocates('readHistoryRootPage', request), true);
  assert.equal(ctl.allocates('readHistoryRootPage', { kind: 'fields' }), false);
  assert.equal(ctl.installedTextPinFork('readHistoryRootPage', request), false);
  let enter, unlock, held = false;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { unlock = resolve; });
  const first = ctl.dispatch('readHistoryRootPage', request, { control: { assertCurrent() {}, async checkpoint() {
    if (!held) { held = true; enter(); await gate; }
  } } });
  await entered;
  const second = ctl.dispatch('readHistoryRootPage', request, { control: { assertCurrent() {}, async checkpoint() {} } });
  assert.equal(admission.active, true); assert.equal(admission.waiting, 1);
  assert.deepEqual(events, ['ensure', 'initialize', 'collect64', 'room', 'ensure']);
  unlock();
  const results = await Promise.all([first, second]);
  assert(results.every(result => result.success === true && result.kind === 'primary-canonical-metadata'));
  assert.deepEqual(events, ['ensure', 'initialize', 'collect64', 'room', 'ensure', 'cleanup',
    'ensure', 'initialize', 'collect64', 'room', 'ensure', 'cleanup']);
  assert.equal(admission.active, false); assert.equal(admission.waiting, 0);
  assert.equal(x.f.store.diskBudget, budget);
  const originalRead = x.f.plane.readPage, unknown = Object.assign(new Error('unknown'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  let attempts = 0;
  x.f.plane.readPage = async () => { attempts++; throw unknown; };
  try { await assert.rejects(ctl.dispatch('readHistoryRootPage', request, { control: { assertCurrent() {} } }), error => error === unknown); }
  finally { x.f.plane.readPage = originalRead; }
  assert.equal(attempts, 1); assert.equal(admission.active, false);
  assert.equal(x.f.plane.state(x.opened.root, x.f.consumerKey), x.state);
  assert.equal(x.f.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
  await x.opened.reader.close();
});
