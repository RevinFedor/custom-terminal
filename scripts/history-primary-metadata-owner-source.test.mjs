// V50 finite SOURCE controls: actual producer, SQLite store, read plane,
// checked shared client and model. Boundaries: synthetic parsed canonical
// rows, private Node SQLite and in-process IPC. No native ingestion, mounted
// React, provider, global memory or latency claim. Prepared Np remains OPEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryRootClient, checkedHistoryRootOpenHeader,
  checkedHistoryPrimaryCanonicalMetadataFact } from '../src/shared/history-root-read-client.mjs';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryCommitWitnessDiagnostics } from '../src/renderer/utils/uiPerformanceDiagnostics.mjs';

const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { historyPagedCursorAddress, materializeHistoryCursorSync } = require('../src/main/history-root-engine/main/history-paged-store.js');
const { CodexSourceGenerations } = require('../src/main/history-root-engine/main/codex-source-generations.js');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
assert(getHeapStatistics().heap_size_limit <= 192 * 1024 ** 2, 'finite source process required');
const row = (uuid, extra = {}) => ({ uuid, role: 'user', content: 'body ' + uuid, sessionId: 's',
  timestamp: '2026-10-27T00:00:00.000Z', ...extra });
const presentation = () => ({ localEntries: [], liveEntries: [], liveToolResults: [],
  grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] },
  captionSelections: [], settingsPresentationKeys: [] });
const kind = 'primary-canonical-metadata';
const turn = () => new Promise(resolve => setImmediate(resolve));
function credit(value) {
  value.creditBytesUsed = 0;
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (value.creditBytesUsed === bytes) return value;
    value.creditBytesUsed = bytes;
  }
  throw Error('finite credit convergence');
}
async function clientRig(t, entries = [row('one')], options = {}) {
  const fixture = await createPrimaryAddressFixture(null, { entries });
  const opened = await fixture.open(options);
  assert.equal(opened.kind, 'root');
  const readers = [opened.reader];
  t.after(async () => { for (const reader of readers) await reader.close(); fixture.close(); });
  return { fixture, opened, readers, async view() {
    const view = await fixture.open({ primaryRequestClass: 'view', localRootLease: opened.header,
      expectedSemanticIdentity: opened.header.semanticIdentity,
      primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } });
    assert.equal(view.kind, 'root'); readers.push(view.reader); return view;
  } };
}
async function modelRig(t, entries = [row('one')], options = {}) {
  const fixture = await createPrimaryAddressFixture(null, { entries });
  let intercept = options.intercept;
  const calls = [];
  const invoke = async (channel, payload) => {
    if (channel === 'agent-transcript:cancel-read') return { success: true };
    const forward = () => fixture.invoke(channel, payload);
    const response = intercept ? await intercept(channel, payload, forward) : await forward();
    calls.push({ channel, payload, response });
    return response;
  };
  const model = new HistoryPrimaryRootReadModel(invoke, options.transport || fixture.transport);
  model.windowDiagnostic = () => {};
  const payload = { ...fixture.payload, primaryPresentation: presentation(), ...options.payload };
  t.after(async () => { await model.close(); fixture.close(); });
  return { fixture, model, payload, calls, invoke, setIntercept(value) { intercept = value; },
    open(options) { return model.open(payload, options); },
    view(options) { return model.open({ ...payload, primaryRequestClass: 'view',
      primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } }, options); } };
}
function corruptField(fixture, cursor, value) {
  const address = historyPagedCursorAddress(cursor), meta = fixture.store.json(address.ref.id);
  const id = fixture.store.vectorGet(meta.fields, 0), previous = fixture.store.db.prepare('SELECT body,digest FROM hp_pages WHERE id=?').get(id);
  const field = fixture.store.json(id); field.value = value;
  const bytes = Buffer.from(JSON.stringify(field));
  fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?')
    .run(bytes, createHash('sha256').update(bytes).digest('hex'), id);
  return () => { fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(previous.body, previous.digest, id);
    fixture.store.cache.clear(); fixture.store.cacheBytes = 0; };
}

test('dedicated empty proof is branded and distinct from a fake empty inventory', async t => {
  const { opened, fixture } = await clientRig(t, []);
  const fact = await opened.reader.canonicalMetadataValidation(opened.header);
  assert.equal(checkedHistoryPrimaryCanonicalMetadataFact(fact, opened.header), fact);
  assert.equal(fact.kind, 'validated-canonical-metadata'); assert.equal(fact.canonicalEntryCount, 0);
  assert.deepEqual(fact.diagnosticTail, { kind: 'empty' });
  assert(Object.isFrozen(fact)); assert(Object.isFrozen(fact.sourceSnapshot));
  for (const key of ['entries', 'durableEntries', 'rows', 'items']) assert(!Object.hasOwn(fact, key));
  assert.equal(fixture.calls.filter(call => call.kind === kind).length, 1);
  assert.throws(() => checkedHistoryPrimaryCanonicalMetadataFact({ ...fact }, opened.header), { code: 'HISTORY_PRIMARY_METADATA_FACT_INVALID' });
  assert.throws(() => checkedHistoryPrimaryCanonicalMetadataFact([], opened.header), { code: 'HISTORY_PRIMARY_METADATA_FACT_INVALID' });
});

test('fixed selected tail preserves exact diagnostics including negative zero and invalid omission', async t => {
  const original = row('tail', { sourceIdentity: 'x'.repeat(513), contentRevision: '\ud800\n', recordByteOffset: -0,
    liveProjection: true, sourceSequence: -0, questionReplyProof: { nested: 'never retained by the fact' } });
  const { opened, fixture } = await clientRig(t, [row('first'), original]);
  const legacyMetadataRow = materializeHistoryCursorSync(fixture.plane.state(opened.root, fixture.consumerKey)
    .primaryPresentation.durableMetadataCursor.at(1));
  const fact = await opened.reader.canonicalMetadataValidation(opened.header), selected = fact.diagnosticTail.row;
  assert.equal(fact.diagnosticTail.ordinal, 1); assert(Object.isFrozen(selected));
  assert(Object.is(selected.recordByteOffset, -0));
  assert(Object.is(selected.sourceSequence, legacyMetadataRow.sourceSequence));
  assert(!Object.hasOwn(selected, 'questionReplyProof')); assert(!Object.hasOwn(selected, 'content'));
  function observe(value) {
    const events = [], identity = { ownerKey: 'A', sessionId: 's', generation: 1, presentationVisit: 1 };
    const diagnostics = createHistoryCommitWitnessDiagnostics({ enabled: () => true, now: () => 1000,
      commit(_action, _name, packet) { events.push(packet.historyWitness); return true; } });
    const attempt = diagnostics.begin(identity, 'action', 'read');
    diagnostics.observeRead(attempt, () => true)('read', { diagnosticReadId: 'read', diagnosticActionId: 'action' });
    assert(diagnostics.adopt(attempt, { row: value, revisionToken: 'revision', payloadGeneration: 'payload' }));
    assert(diagnostics.commit(diagnostics.candidate(), identity, value)); return events[0];
  }
  const actual = observe(selected), legacy = observe(legacyMetadataRow);
  assert.deepEqual(actual, legacy); assert(Object.is(actual.recordByteOffset, -0));
  assert.equal(actual.qualification, 'unqualified-live-version'); assert.equal(actual.rowMount, 'unqualified');
});

test('every exact response binding rejects mutation without closing the independently owned parent', async t => {
  const { opened, fixture } = await clientRig(t);
  const fields = ['leaseId', 'ownerKey', 'revision', 'generation', 'profile', 'schema', 'parentNodeToken', 'nodeToken',
    'sourceNodeToken', 'metadataIdentity', 'metadataSchema', 'semanticIdentity', 'semanticRevisionToken', 'viewRevisionToken',
    'canonicalEntryCount', 'sourceEntryCount', 'sourceProof', 'validationDigest', 'diagnosticTailDigest', 'validationToken'];
  for (const field of fields) {
    let calls = 0;
    await assert.rejects(opened.reader.canonicalMetadataValidation(opened.header, { invoke: async (channel, payload) => {
      calls++; const value = structuredClone(await fixture.invoke(channel, payload));
      value[field] = typeof value[field] === 'number' ? value[field] + 1 : 'wrong'; return credit(value);
    } }), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL' }, field);
    assert.equal(calls, 1, field + ' never self-retries'); assert.equal(opened.reader.closed, false);
  }
  assert.equal((await opened.reader.canonicalMetadataValidation(opened.header)).canonicalEntryCount, 1);
});

test('missing fields generic empty replies and forged diagnostic tails cannot establish a fact', async t => {
  const { opened, fixture } = await clientRig(t);
  const cases = [
    ['generic empty', () => ({ success: true, items: [], done: true }), 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['missing count', value => { delete value.canonicalEntryCount; return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['missing receipt', value => { delete value.validationReceipt; return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['extra inventory', value => ({ ...value, entries: [] }), 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['false empty', value => ({ ...value, diagnosticTail: { kind: 'empty' } }), 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['wrong tail ordinal', value => { value.diagnosticTail.ordinal++; return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['omitted selected field', value => { value.diagnosticTail.fields.pop(); return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['oversized selected value', value => { value.diagnosticTail.fields[0].value = 'x'.repeat(513); return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
    ['allowed value with wrong digest', value => { value.diagnosticTail.fields[0].value = 'other'; return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_TAIL'],
    ['negative zero wrong raw grammar', value => { value.diagnosticTail.fields[3] = { name: 'recordByteOffset', kind: 'value', value: -0 }; return value; }, 'HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL'],
  ];
  for (const [name, mutate, code] of cases) await assert.rejects(opened.reader.canonicalMetadataValidation(opened.header, {
    invoke: async (channel, payload) => credit(mutate(structuredClone(await fixture.invoke(channel, payload)))),
  }), { code }, name);
  assert.equal(opened.reader.closed, false);
});

test('source projection is independently hashed before dispatch and partial capability headers refuse', async t => {
  const { opened, fixture } = await clientRig(t);
  const changed = structuredClone(opened.header); changed.sourceSnapshot.sourceGeneration += '-changed';
  const before = fixture.calls.length;
  await assert.rejects(opened.reader.canonicalMetadataValidation(changed), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_SOURCE' });
  assert.equal(fixture.calls.length, before, 'wrong source is refused before IPC');
  for (const field of ['validationDigest', 'sourceProof', 'validationToken', 'diagnosticTailDigest']) {
    const malformed = structuredClone(opened.header); delete malformed.canonicalMetadataValidation[field];
    assert.throws(() => checkedHistoryRootOpenHeader(malformed), { code: 'HISTORY_ROOT_OPEN_HEADER_INVALID' });
  }
});

test('allowed escaped source vocabulary below the existing wire cap has no smaller incidental hash cap', async t => {
  const { opened, fixture } = await clientRig(t);
  const state = fixture.plane.state(opened.root, fixture.consumerKey);
  // The fixture's physical source is synthetic. Alter that declared boundary
  // only; the real producer binding, protocol, hashing and validation run.
  state.source = Object.freeze({ ...state.source, filePath: '/finite/' + '\u0001'.repeat(3000), sessionId: '\u0002'.repeat(3000) });
  const header = checkedHistoryRootOpenHeader({ ...opened.header, sourceSnapshot: state.source,
    canonicalMetadataValidation: fixture.plane.canonicalMetadataCapability(state) });
  assert(JSON.stringify(header.sourceSnapshot).length > 32 * 1024);
  let requestBytes = 0;
  const fact = await opened.reader.canonicalMetadataValidation(header, { invoke: (channel, payload) => {
    assert.equal(Object.hasOwn(payload, 'sourceSnapshot'), false, 'only the exact independently checked source proof crosses again');
    requestBytes = Buffer.byteLength(JSON.stringify(payload)); return fixture.invoke(channel, payload);
  } });
  assert(requestBytes <= 65536); assert.equal(fact.sourceProof, header.canonicalMetadataValidation.sourceProof);
  assert.equal(fact.sourceSnapshot.filePath, state.source.filePath);
});

test('complete legal escaped header and restored source generation retain capability without copying snapshot into request', async t => {
  const { opened, fixture } = await clientRig(t), state = fixture.plane.state(opened.root, fixture.consumerKey);
  const generations = new CodexSourceGenerations();
  const restored = { ...state.source, filePath: '/' + '\u0001'.repeat(4095), sessionId: '\u0002'.repeat(4096),
    fileIdentity: '1:1', sourceGeneration: '\u0003'.repeat(2048), size: 1, mtimeMs: 1, ctimeMs: 1 };
  assert(generations.restore(restored.filePath, restored, restored.sessionId));
  assert.equal(generations.observe(restored.filePath, { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }, restored.sessionId).generation,
    restored.sourceGeneration, 'actual current restore grammar admits and retains the long generation');
  const complete = { ...restored, fileIdentity: '\u0004'.repeat(2048) };
  assert(Buffer.byteLength(JSON.stringify(complete)) > 65536, 'full legal fixed header vocabulary exceeds a page when escaped');
  for (const source of [restored, complete]) {
    state.source = Object.freeze(source);
    const header = checkedHistoryRootOpenHeader({ ...opened.header, sourceSnapshot: source,
      canonicalMetadataValidation: fixture.plane.canonicalMetadataCapability(state) });
    let calls = 0, requestBytes = 0;
    const fact = await opened.reader.canonicalMetadataValidation(header, { invoke: async (channel, payload) => {
      calls++; assert.equal(payload.creditBytes, 65536, 'normal model/client credit is unchanged');
      assert.equal(Object.hasOwn(payload, 'sourceSnapshot'), false);
      requestBytes = Buffer.byteLength(JSON.stringify(payload)); return fixture.invoke(channel, payload);
    } });
    assert.equal(calls, 1); assert(requestBytes <= 65536);
    assert.deepEqual(fact.sourceSnapshot, header.sourceSnapshot);
    assert.equal(checkedHistoryPrimaryCanonicalMetadataFact(fact, header), fact);
  }
});

test('proof-only source binding preserves exact zero and negative-zero distinction in every accepted numeric field', async t => {
  const { opened, fixture } = await clientRig(t), state = fixture.plane.state(opened.root, fixture.consumerKey);
  for (const name of ['size', 'mtimeMs', 'ctimeMs']) for (const value of [0, -0]) {
    state.source = Object.freeze({ ...state.source, [name]: value });
    const header = checkedHistoryRootOpenHeader({ ...opened.header, sourceSnapshot: state.source,
      canonicalMetadataValidation: fixture.plane.canonicalMetadataCapability(state) });
    const fact = await opened.reader.canonicalMetadataValidation(header);
    assert(Object.is(fact.sourceSnapshot[name], value));
    const tampered = { ...header, sourceSnapshot: { ...header.sourceSnapshot, [name]: Object.is(value, -0) ? 0 : -0 } };
    const before = fixture.calls.length;
    await assert.rejects(opened.reader.canonicalMetadataValidation(tampered), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_SOURCE' }, name);
    assert.equal(fixture.calls.length, before, 'signed-zero source mismatch refuses before dispatch, without retry');
  }
});

test('real pure-view proof is cheap, newly bound, and preserves the same selected diagnostic row object', async t => {
  const rig = await clientRig(t), first = await rig.opened.reader.canonicalMetadataValidation(rig.opened.header);
  const view = await rig.view(), sql = rig.fixture.store.sql;
  rig.fixture.store.sql = function(query) {
    if (query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work')) throw Error('POISON_CANONICAL_RESCAN_ON_REUSE');
    return sql.call(this, query);
  };
  try {
    const second = await view.reader.canonicalMetadataValidation(view.header, { reuseFact: first, previousHeader: rig.opened.header });
    assert.equal(second.diagnosticTail, first.diagnosticTail); assert.equal(second.diagnosticTail.row, first.diagnosticTail.row);
    assert.notEqual(second.leaseId, first.leaseId); assert.notEqual(second.nodeToken, first.nodeToken);
    assert.notEqual(second.validationToken, first.validationToken); assert.notEqual(second.validationReceipt, first.validationReceipt);
    assert.equal(second.validationDigest, first.validationDigest); assert.equal(second.sourceProof, first.sourceProof);
    assert.equal(checkedHistoryPrimaryCanonicalMetadataFact(second, view.header), second);
  } finally { rig.fixture.store.sql = sql; }
});

test('fresh view token and descriptor mutation cannot be branded by unchanged counts or old receipt', async t => {
  const rig = await clientRig(t), first = await rig.opened.reader.canonicalMetadataValidation(rig.opened.header);
  const view = await rig.view();
  for (const name of ['validationToken', 'root', 'durableMetadata', 'sourceMetadata']) {
    const header = structuredClone(view.header);
    if (name === 'validationToken') header.canonicalMetadataValidation.validationToken = '0'.repeat(64);
    else header[name].nodeToken += '-wrong';
    // The mutated reader root simulates the actual open boundary receiving
    // the same malformed header, so local reader equality cannot mask it.
    const reader = new HistoryRootClient(rig.fixture.invoke, header.root, { pageBytes: 65536, pageItems: 3 });
    await assert.rejects(reader.canonicalMetadataValidation(header, { reuseFact: first, previousHeader: rig.opened.header }),
      error => error.code === 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' || error.code === 'HISTORY_ROOT_TOKEN', name);
    await reader.abandon();
  }
  assert.equal(view.reader.closed, false); assert.equal(rig.opened.reader.closed, false);
  assert.equal((await view.reader.canonicalMetadataValidation(view.header, { reuseFact: first, previousHeader: rig.opened.header })).diagnosticTail, first.diagnosticTail);
});

test('forged prior validation receipt and cloned local fact cannot authorize reuse', async t => {
  const rig = await clientRig(t), first = await rig.opened.reader.canonicalMetadataValidation(rig.opened.header), view = await rig.view();
  await assert.rejects(view.reader.canonicalMetadataValidation(view.header, { reuseFact: { ...first }, previousHeader: rig.opened.header }),
    { code: 'HISTORY_PRIMARY_METADATA_FACT_INVALID' });
  await assert.rejects(view.reader.canonicalMetadataValidation(view.header, { reuseFact: first, previousHeader: rig.opened.header,
    invoke: async (channel, payload) => rig.fixture.invoke(channel, { ...payload,
      reuseValidation: { ...payload.reuseValidation, validationReceipt: '0'.repeat(64) } }),
  }), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_REUSE' });
  assert.equal(view.reader.closed, false); assert.equal(rig.opened.reader.closed, false);
});

test('source-generation replacement cannot reuse a previously checked fact', async t => {
  const rig = await clientRig(t), first = await rig.opened.reader.canonicalMetadataValidation(rig.opened.header);
  rig.fixture.setEntries([row('one')]); const next = await rig.fixture.open(); rig.readers.push(next.reader);
  await assert.rejects(next.reader.canonicalMetadataValidation(next.header, { reuseFact: first, previousHeader: rig.opened.header }),
    { code: 'HISTORY_PRIMARY_METADATA_FACT_REUSE_CONFLICT' });
  const cold = await next.reader.canonicalMetadataValidation(next.header);
  assert.notEqual(cold.sourceProof, first.sourceProof); assert.notEqual(cold.diagnosticTail.row, first.diagnosticTail.row);
});

test('original lifetime guard refuses cancellation and owner change after a successful producer await', async t => {
  const { fixture, opened } = await clientRig(t);
  let current = true, calls = 0;
  await assert.rejects(opened.reader.canonicalMetadataValidation(opened.header, { owns: () => current,
    invoke: async (channel, payload) => { calls++; const result = await fixture.invoke(channel, payload); current = false; return result; },
  }), { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(calls, 1); assert.equal(opened.reader.closed, false);
  const controller = new AbortController();
  await assert.rejects(opened.reader.canonicalMetadataValidation(opened.header, { signal: controller.signal,
    invoke: async (channel, payload) => { const result = await fixture.invoke(channel, payload); controller.abort(); return result; },
  }), { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(opened.reader.closed, false, 'demand abort does not close independently owned parent');
});

test('closing the original reader during a fact demand never publishes checked authority', async t => {
  const { fixture, opened } = await clientRig(t);
  await assert.rejects(opened.reader.canonicalMetadataValidation(opened.header, {
    invoke: async (channel, payload) => { const result = await fixture.invoke(channel, payload); await opened.reader.close(); return result; },
  }), { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(opened.reader.pending, false); assert.equal(opened.reader.closed, true);
});

test('final cheap ownership guard cannot return true after synchronously closing or aborting the original demand', async t => {
  for (const revoke of ['close', 'abort']) {
    const { opened } = await clientRig(t), controller = new AbortController();
    let guards = 0;
    await assert.rejects(opened.reader.canonicalMetadataValidation(opened.header, {
      signal: controller.signal,
      owns() {
        if (++guards === 4) {
          if (revoke === 'close') void opened.reader.close(); else controller.abort();
        }
        return true;
      },
    }), { code: 'HISTORY_READ_CANCELLED' }, revoke);
    assert.equal(guards, 4, 'revocation occurs after the tail digest await, before publication');
    assert.equal(opened.reader.pending, false);
  }
});

test('model cold canonical decoder is poisoned while genuine prepared decoder remains a positive control', async t => {
  const rig = await modelRig(t, [row('one'), row('two')]);
  let header, canonicalPackets = 0, preparedPackets = 0;
  rig.setIntercept(async (channel, payload, forward) => {
    if (channel.endsWith('get-history')) { const value = await forward(); header = value; return value; }
    if (channel.endsWith('read-page') && ['range', 'fields', 'rowWindow'].includes(payload.kind)) {
      if (payload.nodeToken === header?.durableMetadata.nodeToken) { canonicalPackets++; throw Error('POISON_CANONICAL_NATIVE_DECODER'); }
      if (payload.nodeToken === header?.sourceMetadata.nodeToken) preparedPackets++;
    }
    return forward();
  });
  await rig.open();
  assert.equal(canonicalPackets, 0); assert(preparedPackets > 0);
  assert.equal(rig.model.metadata.preparedCompatibilityKind, 'prepared-metadata-compatibility');
  assert.deepEqual(rig.model.metadata.entries.map(entry => entry.uuid), ['one', 'two']);
  assert(rig.model.metadata.entries.every(entry => entry.rowStub === true && Object.isFrozen(entry)));
  assert(Object.isFrozen(rig.model.metadata.entries)); assert(!Object.hasOwn(rig.model.metadata, 'durableEntries'));
  assert(!Object.hasOwn(rig.model.view.serverMetadata, 'durableEntries'));
  assert.equal(rig.model.metadata.canonicalMetadataFact.canonicalEntryCount, 2);
  assert.equal(rig.calls.filter(call => call.payload.kind === kind).length, 1);
});

test('model rejects successful-looking fabricated fact from a mock reader and releases only provisional lease', async t => {
  const rig = await modelRig(t);
  const original = rig.fixture.transport.openHistoryRootThroughIpc;
  rig.model.transport = { ...rig.fixture.transport, async openHistoryRootThroughIpc(...args) {
    const opened = await original(...args);
    opened.reader.canonicalMetadataValidation = async () => ({ kind: 'validated-canonical-metadata',
      canonicalEntryCount: opened.header.canonicalEntryCount, diagnosticTail: { kind: 'empty' } });
    return opened;
  } };
  await assert.rejects(rig.open(), { code: 'HISTORY_PRIMARY_METADATA_FACT_INVALID' });
  assert.equal(rig.model.view, null); assert.equal(rig.fixture.plane.roots.size, 0);
});

test('hidden invalid canonical row excluded by actual Rewind still blocks model adoption', async t => {
  const rig = await modelRig(t, [row('first'), row('target'), row('hidden', { questionReplyProof: { nested: new Map([['key', 'value']]) } })],
    { payload: { rewindPreview: { targetUuid: 'target' } } });
  let header;
  rig.setIntercept(async (channel, _payload, forward) => { const result = await forward(); if (channel.endsWith('get-history')) header = result; return result; });
  await assert.rejects(rig.open(), { code: 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED' });
  assert(header.sourceEntryCount < header.canonicalEntryCount); assert.equal(rig.model.view, null);
  assert.equal(rig.fixture.plane.roots.size, 0); assert.equal(rig.calls.filter(call => call.payload.kind === kind).length, 1);
});

test('post-construction hidden canonical scalar change with repaired page SHA is refused at cold model open', async t => {
  const rig = await modelRig(t, [row('first'), row('target'), row('hidden', { questionReplyProof: { scalar: 1 } })],
    { payload: { rewindPreview: { targetUuid: 'target' } } });
  let restore;
  rig.setIntercept(async (channel, _payload, forward) => {
    const result = await forward();
    if (channel.endsWith('get-history')) {
      const state = rig.fixture.plane.state(result.root, rig.fixture.consumerKey);
      restore = corruptField(rig.fixture, state.primaryPresentation.durableMetadataCursor.at(2).field('questionReplyProof'),
        { type: 'number', value: '2' });
    }
    return result;
  });
  try { await assert.rejects(rig.open(), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_CHANGED' }); }
  finally { restore?.(); }
  assert.equal(rig.model.view, null); assert.equal(rig.fixture.plane.roots.size, 0);
});

test('post-construction hidden UTF16 leaf integrity failure is checked before prepared projection', async t => {
  const rig = await modelRig(t, [row('first'), row('target'), row('hidden', { questionReplyProof: { text: 'x\ud800'.repeat(700) } })],
    { payload: { rewindPreview: { targetUuid: 'target' } } });
  let restore, preparedPackets = 0, sourceToken;
  rig.setIntercept(async (channel, payload, forward) => {
    if (channel.endsWith('read-page') && payload.nodeToken === sourceToken && ['range', 'rowWindow'].includes(payload.kind)) preparedPackets++;
    const result = await forward();
    if (channel.endsWith('get-history')) {
      sourceToken = result.sourceMetadata.nodeToken;
      const state = rig.fixture.plane.state(result.root, rig.fixture.consumerKey);
      const cursor = state.primaryPresentation.durableMetadataCursor.at(2).field('questionReplyProof').field('text');
      const address = historyPagedCursorAddress(cursor), meta = rig.fixture.store.json(address.ref.id);
      const id = rig.fixture.store.vectorGet(meta.chunks, 0), original = rig.fixture.store.db.prepare('SELECT body,digest FROM hp_pages WHERE id=?').get(id);
      const body = Buffer.from(original.body); body[0] ^= 1;
      rig.fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?')
        .run(body, createHash('sha256').update(body).digest('hex'), id);
      restore = () => { rig.fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(original.body, original.digest, id);
        rig.fixture.store.cache.clear(); rig.fixture.store.cacheBytes = 0; };
    }
    return result;
  });
  try { await assert.rejects(rig.open()); }
  finally { restore?.(); }
  assert.equal(preparedPackets, 0); assert.equal(rig.model.view, null);
  assert(rig.fixture.errors.some(error => /digest|corrupt/i.test(error.message)));
});

test('model cheap same-data view keeps diagnostic identity, prepared rows, data subject, and adopted wake', async t => {
  const rig = await modelRig(t, [row('one')]); await rig.open();
  const previous = rig.model.view, subject = rig.model.getReceiptDataSubject(), wakes = [];
  rig.model.onReceiptReadWake(event => wakes.push(event));
  const sql = rig.fixture.store.sql;
  rig.fixture.store.sql = function(query) {
    if (query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work')) throw Error('POISON_REUSE_FULL_SCAN');
    return sql.call(this, query);
  };
  const before = rig.calls.length;
  try { await rig.view(); } finally { rig.fixture.store.sql = sql; }
  assert.notEqual(rig.model.view, previous); assert.equal(rig.model.getReceiptDataSubject(), subject);
  assert.equal(rig.model.metadata.entries, previous.metadata.entries);
  assert.equal(rig.model.metadata.canonicalMetadataFact.diagnosticTail, previous.metadata.canonicalMetadataFact.diagnosticTail);
  assert.notEqual(rig.model.metadata.canonicalMetadataFact.validationToken, previous.metadata.canonicalMetadataFact.validationToken);
  const requests = rig.calls.slice(before).filter(call => call.payload.kind === kind);
  assert.equal(requests.length, 1); assert(requests[0].payload.reuseValidation);
  assert.deepEqual(wakes.map(event => event.kind), ['adopted']); assert.equal(wakes[0].dataSubject, subject);
});

test('provisional preparation failure keeps old view subject and tail and emits exactly one external settlement wake', async t => {
  const rig = await modelRig(t); await rig.open();
  const old = rig.model.view, subject = rig.model.getReceiptDataSubject(), wakes = [];
  rig.model.onReceiptReadWake(event => wakes.push(event));
  rig.fixture.setEntries([row('new')]);
  await assert.rejects(rig.open({ prepareAdopt: async candidate => {
    assert.equal(candidate.metadata.canonicalMetadataFact.diagnosticTail.row.uuid, 'new');
    throw Object.assign(Error('finite preparation UNKNOWN'), { code: 'FINITE_UNKNOWN' });
  } }), { code: 'FINITE_UNKNOWN' });
  assert.equal(rig.model.view, old); assert.equal(rig.model.getReceiptDataSubject(), subject);
  assert.equal(rig.model.metadata.canonicalMetadataFact, old.metadata.canonicalMetadataFact);
  assert.deepEqual(wakes.map(event => event.kind), ['settled']); assert.equal(wakes[0].dataSubject, subject);
  assert.equal(rig.fixture.plane.roots.size, 2, 'previous Root and its independent prepared child retained');
  rig.model.notify(); await turn(); assert.equal(wakes.length, 1, 'body notification cannot self-retry UNKNOWN');
});

test('new equal-count source receives a new data subject and selected diagnostic row', async t => {
  const rig = await modelRig(t); await rig.open();
  const subject = rig.model.getReceiptDataSubject(), fact = rig.model.metadata.canonicalMetadataFact;
  rig.fixture.setEntries([row('one')]); await rig.open();
  assert.notEqual(rig.model.getReceiptDataSubject(), subject);
  assert.notEqual(rig.model.metadata.canonicalMetadataFact.diagnosticTail.row, fact.diagnosticTail.row);
  assert.notEqual(rig.model.metadata.canonicalMetadataFact.sourceProof, fact.sourceProof);
});

test('failed new-bound pure view rolls back and never falls back to old canonical arrays or retries', async t => {
  const rig = await modelRig(t); await rig.open();
  const previous = rig.model.view, wakes = []; rig.model.onReceiptReadWake(event => wakes.push(event));
  rig.setIntercept(async (channel, _payload, forward) => {
    const result = await forward();
    if (channel.endsWith('get-history') && result.primaryRequestClass === 'view') {
      return { ...result, canonicalMetadataValidation: { ...result.canonicalMetadataValidation, validationToken: '0'.repeat(64) } };
    }
    return result;
  });
  const before = rig.calls.length;
  await assert.rejects(rig.view(), { code: 'HISTORY_PRIMARY_METADATA_VALIDATION_BINDING' });
  assert.equal(rig.model.view, previous); assert.equal(rig.fixture.plane.roots.size, 2);
  assert.equal(rig.calls.slice(before).filter(call => call.payload.kind === kind).length, 1);
  assert.deepEqual(wakes.map(event => event.kind), ['settled']);
});

test('model never recaptures a moved view header or reader after open or fact await', async t => {
  for (const phase of ['open', 'proof']) for (const field of ['view', 'header', 'reader']) {
    const rig = await modelRig(t); await rig.open();
    const previous = rig.model.view, originalHeader = previous.header, originalReader = previous.reader;
    let moved = false, proofCalls = 0;
    const replacement = field === 'view' ? { ...previous } : field === 'header' ? { ...originalHeader }
      : { assertOpen() { throw Error('NEW_READER_MUST_NOT_BE_BORROWED'); } };
    rig.setIntercept(async (channel, payload, forward) => {
      const result = await forward();
      if (payload.kind === kind) proofCalls++;
      const boundary = phase === 'open' ? channel.endsWith('get-history') : payload.kind === kind;
      if (!moved && boundary) {
        moved = true;
        if (field === 'view') rig.model.view = replacement; else previous[field] = replacement;
      }
      return result;
    });
    try {
      await assert.rejects(rig.view(), { code: 'HISTORY_READ_CANCELLED' }, phase + ':' + field);
      assert(moved, 'actual awaited boundary reached');
      assert.equal(proofCalls, phase === 'open' ? 0 : 1, 'moved open owner cannot dispatch a metadata demand');
      assert.equal(rig.model.view, field === 'view' ? replacement : previous, 'no adoption overwrites the changed owner');
      assert.equal(originalReader.closed, false, 'original shared parent is independently owned');
      assert.equal(rig.fixture.plane.roots.size, 2, 'distinct provisional capability released; previous Root and prepared child remain');
    } finally {
      previous.header = originalHeader; previous.reader = originalReader; rig.model.view = previous;
    }
  }
});

test('bounded backing counters and released worklist establish finite source cleanup only', async t => {
  const rig = await modelRig(t, Array.from({ length: 16 }, (_, index) => row('r' + index, { questionReplyProof: { shared: 'value\ud800' } })));
  await rig.open();
  const stats = rig.fixture.store.stats();
  assert(stats.peakCachedPages <= 3); assert(stats.peakIndexBytes <= 2048); assert(stats.peakPageReadBytes <= 1024);
  assert.equal(rig.fixture.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
  assert.equal(rig.model.metadata.entries.length, 16, 'prepared Np compatibility is explicitly still retained');
  const facts = rig.calls.filter(call => call.payload.kind === kind);
  assert.equal(facts.length, 1); assert(Buffer.byteLength(JSON.stringify(facts[0].response)) <= 65536);
  assert.equal(rig.fixture.store.diskBudget, 28 * 1024 ** 2, 'existing fixture quota unchanged');
});
