'use strict';

// Finite SOURCE differential, not native Electron/layout/latency acceptance.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-canonical-consumers-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), v8 = require('node:v8');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..'), MAIN = path.join(ROOT, 'src/main/history-root-engine/main');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync: materialize } = require(path.join(MAIN, 'history-paged-store'));
const local = require(path.join(MAIN, 'history-primary-compat/src/renderer/utils/primaryLocalCompat.ts.cjs'));
const live = require(path.join(MAIN, 'history-primary-compat/src/renderer/utils/historyLiveProjection.mjs.cjs'));
const { decorateHistoryPromptPresentations } = require(path.join(MAIN, 'history-primary-compat/src/main/history-prompt-presentations.js.cjs'));
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite V8 TOTAL <=128MiB; use documented command');
const PROFILE = 'primary-canonical-consumers-v1';
const ENCODING = 'history-canonical-consumer-text-v1';
const user = (uuid, content, extra = {}) => ({ uuid, role: 'user', content, sessionId: 's', ...extra });
const assistant = (uuid, content, extra = {}) => ({ uuid, role: 'assistant', content, sessionId: 's', ...extra });
const state = (f, o) => f.plane.state(o.reader.identity, f.consumerKey);
const query = (o, scope = 'canonical', options = {}) => o.reader.primaryCanonicalConsumers(
  scope === 'canonical' ? o.header.durableMetadata : o.header.sourceMetadata, { header: o.header, scope, ...options });
const decode = (f, o, descriptor) => materialize(f.plane.cursor(state(f, o), descriptor.nodeToken));
const control = { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } };
const request = (o, changes = {}) => ({ ...o.reader.identity, nodeToken: o.header.durableMetadata.nodeToken,
  parentNodeToken: o.root.nodeToken, kind: 'primary-canonical-consumers', profile: PROFILE, scope: 'canonical', offset: 0, limit: 3,
  semanticIdentity: o.header.semanticIdentity, metadataIdentity: o.header.metadataIdentity, metadataSchema: 1,
  semanticRevisionToken: o.header.semanticRevisionToken, viewRevisionToken: o.header.viewRevisionToken,
  canonicalEntryCount: o.header.canonicalEntryCount, sourceEntryCount: o.header.sourceEntryCount, creditBytes: 65536, ...changes });
const recredit = packet => {
  let before;
  do { before = packet.creditBytesUsed; packet.creditBytesUsed = Buffer.byteLength(JSON.stringify(packet)); }
  while (before !== packet.creditBytesUsed);
  return packet;
};
async function text(document) { let value = ''; for await (const part of document.chunks()) value += part; return value; }
async function scan(f, o, scope) {
  const values = [], ordinals = []; let offset = 0, rootToken;
  for (;;) {
    const page = await query(o, scope, { offset });
    assert.equal(page.scope, scope); assert.equal(page.offset, offset);
    rootToken ||= page.root.nodeToken; assert.equal(page.root.nodeToken, rootToken);
    for (const item of page.items) { values.push(decode(f, o, item.row)); ordinals.push(item.ordinal); }
    offset = page.nextOffset;
    if (page.done) { assert.equal(offset, page.total); break; }
    assert(page.items.length > 0);
  }
  assert.deepEqual(ordinals, values.map((_value, index) => index));
  return values;
}

test('dedicated full canonical/prepared pages preserve native values, aliases, later equal text and overlay distinction', async t => {
  const shared = { note: undefined, text: 'NUL\0 lone\ud800 pair😀\r\nTAIL' }; shared.self = shared;
  const long = 'full\0\ud800😀\r\n'.repeat(900) + 'DIFFERENT FINAL SUFFIX';
  const entries = [user('earlier', long, { recordByteOffset: 9, sourceIdentityAliases: ['earlier-alias'], graph: shared }),
    assistant('not-user', long, { recordByteOffset: 40, sourceIdentity: 'semantic-assistant' }),
    user('other-session', long, { sessionId: 'other', recordByteOffset: 50 }),
    user('later', long, { recordByteOffset: 60, sourceIdentityAliases: ['later-alias', ' spaced alias '], sourceUuidAliases: ['different-predicate-only'] }),
    assistant('final', 'complete assistant body', { sourceIdentityAliases: ['semantic-final'] })];
  const overlay = assistant('only-live', 'same text is not canonical identity', { sourceIdentity: 'live-only' });
  const f = await createPrimaryAddressFixture(t, { entries });
  const o = await f.open({ primaryPresentation: { liveEntries: [overlay] } });
  assert.equal(o.kind, 'root', f.errors.at(-1)?.stack);
  assert.deepEqual(o.header.canonicalConsumers, { profile: PROFILE, maxItems: 3, valueEncoding: ENCODING });
  const expectedCanonical = structuredClone(entries).map(row => row.role === 'user'
    ? decorateHistoryPromptPresentations(undefined, { toolType: 'codex', sessionId: 's', entries: [row] })[0] : row);
  assert.deepEqual(await scan(f, o, 'canonical'), expectedCanonical, 'complete pre-overlay semantic values, not metadata stubs');
  const expectedPrepared = local.buildRewindPreviewEntries(live.buildHistoryLivePresentation(
    local.mergeServerAndLocalEntries(expectedCanonical, []), [overlay], { settingsPresentationKeys: new Map() }), null).entries;
  assert.deepEqual(await scan(f, o, 'prepared'), expectedPrepared, 'current prepared/live membership remains a separate scope');
  assert(!(await scan(f, o, 'canonical')).some(row => row.sourceIdentity === 'live-only'));
  assert((await scan(f, o, 'prepared')).some(row => row.sourceIdentity === 'live-only'));

  // Cost checks follow full-value differential. Pages touch only <=3 cursor
  // descriptors; neither current decoder nor native materializer is called.
  const p = state(f, o).primaryPresentation, before = p.stats().work, leases = f.store.stats().leases;
  const callsAt = f.calls.length;
  const { HistoryPagedCursor } = require(path.join(MAIN, 'history-paged-store'));
  const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
  const pagedText = require(path.join(MAIN, 'history-paged-text'));
  const poisoned = [[HistoryPagedCursor.prototype, 'rows'], [HistoryPagedCursor.prototype, 'fields'],
    [HistoryPagedCursor.prototype, 'pairs'], [HistoryPagedCursor.prototype, 'textChunks'],
    [HistoryProjectionArena.prototype, 'decode'], [pagedText, 'materialize'], [f.store, 'captureLegacy']]
    .map(([target, key]) => ({ target, key, value: target[key] }));
  for (const item of poisoned) item.target[item.key] = () => { throw new Error('FORBIDDEN_FULL_READ:' + item.key); };
  try {
    for (const offset of [0, 3, 0]) await query(o, 'canonical', { offset });
  } finally { for (const item of poisoned) item.target[item.key] = item.value; }
  assert.deepEqual(p.stats().work, before); assert.equal(f.store.stats().leases, leases);
  assert(f.calls.slice(callsAt).every(call => call.kind === 'primary-canonical-consumers'));
  assert(f.plane.stats().maxPacketBytes <= 65536); assert(f.plane.stats().maxReturnedItems <= 3);
  await o.reader.close();
});

test('empty source requires dedicated proof; strict wire rejects generic empty, wrong scope/cut/progress/descriptors', async t => {
  const f = await createPrimaryAddressFixture(t), o = await f.open(); assert.equal(o.kind, 'root');
  for (const scope of ['canonical', 'prepared']) {
    const page = await query(o, scope);
    assert.equal(page.total, 0); assert.equal(page.offset, 0); assert.equal(page.nextOffset, 0);
    assert.equal(page.done, true); assert.deepEqual(page.items, []); assert.equal(page.root.length, 0);
  }
  const callsAt = f.calls.length;
  await assert.rejects(query(o, 'canonical', { header: { ...o.header, canonicalConsumers: undefined } }), /HEADER_INVALID|QUERY_INVALID/);
  await assert.rejects(query(o, 'canonical', { limit: 4 }), /QUERY_INVALID/);
  assert.equal(f.calls.length, callsAt, 'invalid local input does no IPC');
  const mutations = [
    packet => { delete packet.profile; },
    packet => { packet.scope = 'prepared'; },
    packet => { packet.semanticIdentity = 'foreign'; },
    packet => { packet.metadataIdentity = 'foreign'; },
    packet => { packet.sourceEntryCount++; },
    packet => { packet.total++; },
    packet => { packet.done = false; },
    packet => { packet.nextOffset++; },
    packet => { packet.root = { ...packet.root, leaseId: 'foreign' }; },
    packet => { packet.items = [{ ordinal: 0, row: packet.root }]; },
    packet => { packet.extra = 'undeclared'; },
  ];
  for (const mutate of mutations) {
    await assert.rejects(query(o, 'canonical', { invoke: async (_channel, payload) => {
      const packet = structuredClone(await f.plane.readPage(payload, { consumerKey: f.consumerKey, control }));
      mutate(packet); return recredit(packet);
    } }), /QUERY_PROTOCOL|DESCRIPTOR_INVALID/);
    assert.equal(o.reader.closed, false, 'bad point proof does not close the shared parent');
  }
  await assert.rejects(query(o, 'canonical', { invoke: async () => ({ success: true, items: [], done: true }) }), /QUERY_PROTOCOL/);
  assert.equal((await query(o)).done, true);
  await o.reader.close();
});

test('producer validates exact request, credits, metadata caps and held source lifetime', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [user('u', 'full body'), assistant('a', 'assistant body')] });
  const o = await f.open(); assert.equal(o.kind, 'root');
  const changes = [{ profile: 'generic' }, { scope: 'other' }, { limit: 0 }, { limit: 4 }, { offset: 3 },
    { offset: -1 }, { canonicalEntryCount: 3 }, { sourceEntryCount: 3 }, { semanticIdentity: 'foreign' },
    { metadataIdentity: 'foreign' }, { semanticRevisionToken: '0'.repeat(64) }, { viewRevisionToken: '0'.repeat(64) },
    { nodeToken: o.root.nodeToken }, { parentNodeToken: o.header.durableMetadata.nodeToken }, { creditBytes: 65537 },
    { creditBytes: 511 }, { mutate: true }, { diagnosticActionId: '\0'.repeat(11000) }];
  for (const change of changes) await assert.rejects(f.plane.readPage(request(o, change), { consumerKey: f.consumerKey, control }));
  await assert.rejects(query(o, 'canonical', { creditBytes: 512 }), error => error.code === 'HISTORY_ROOT_CREDIT_TOO_SMALL'
    && error.minimumCreditBytes > 512 && error.minimumCreditBytes <= 65536);
  await assert.rejects(o.reader.rowWindow(o.header.durableMetadata, { profile: 'primary-metadata-fields-v1', limit: 2 }), /FIELDS_INVALID/);
  assert.equal((await query(o)).total, 2, 'credit refusal does not consume parent');
  const maxItems = f.plane.maxItems;
  f.plane.maxItems = 1;
  try {
    const first = await query(o, 'canonical', { limit: 3 });
    assert.equal(first.items.length, 1); assert.equal(first.nextOffset, 1); assert.equal(first.done, false);
    const last = await query(o, 'canonical', { offset: first.nextOffset, limit: 3 });
    assert.equal(last.items.length, 1); assert.equal(last.nextOffset, 2); assert.equal(last.done, true);
  } finally { f.plane.maxItems = maxItems; }
  const frozen = await scan(f, o, 'canonical');
  f.setEntries([user('new', 'new source')]);
  const next = await f.open(); assert.equal(next.kind, 'root');
  assert.deepEqual(await scan(f, o, 'canonical'), frozen, 'old lease retains exact frozen canonical cut');
  assert.deepEqual((await scan(f, next, 'canonical')).map(row => row.uuid), ['new']);
  const page = await query(o), field = await o.reader.project(page.items[0].row, ['content']);
  const descriptor = field.items[0].value;
  // Use a source text large enough to have a signed descriptor in the next
  // fixture control; this ordinary string still proves complete field access.
  assert.equal(descriptor, 'full body');
  await o.reader.close(); await next.reader.close();
});

test('cancelled/UNKNOWN canonical demand never closes shared parent or independent text child', async t => {
  const full = 'lease-bound\0\ud800😀'.repeat(500);
  const f = await createPrimaryAddressFixture(t, { entries: [user('u', full)] }), o = await f.open();
  assert.equal(o.kind, 'root');
  const page = await query(o), fields = await o.reader.project(page.items[0].row, ['content']);
  const doc = await o.reader.forkText(fields.items[0].value);
  const abort = new AbortController(); let finish;
  const pending = query(o, 'canonical', { signal: abort.signal, invoke: async (_channel, payload) => {
    const result = await f.plane.readPage(payload, { consumerKey: f.consumerKey, control });
    await new Promise(resolve => { finish = resolve; }); return result;
  } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  abort.abort(); finish(); await assert.rejects(pending, /HISTORY_READ_CANCELLED/);
  await assert.rejects(query(o, 'canonical', { invoke: async () => ({ success: false, error: 'HISTORY_READ_UNKNOWN' }) }), /HISTORY_READ_UNKNOWN/);
  assert.equal(o.reader.closed, false); assert.equal((await query(o)).total, 1);
  await o.reader.close(); assert.equal(await text(doc), full, 'child stays exact after parent close'); await doc.close();
});

test('derived-value client validates response and releases late child once without touching its parent', async t => {
  const { HistoryRootClient } = await import(pathToFileURL(path.join(ROOT, 'src/shared/history-root-read-client.mjs')));
  const full = 'coercion-body\0\ud800😀'.repeat(300);
  const f = await createPrimaryAddressFixture(t, { entries: [user('u', full)] }), o = await f.open();
  assert.equal(o.kind, 'root');
  const row = (await query(o)).items[0].row;
  const content = (await o.reader.project(row, ['content'])).items[0].value;
  const baseline = f.plane.stats().roots;
  const abort = new AbortController(); let finish, created;
  const reader = new HistoryRootClient(f.invoke, o.root, { pageBytes: 65536, pageItems: 3 });
  const pending = reader.forkCanonicalConsumerValue(content, { operation: 'string-falsy', signal: abort.signal,
    invoke: async (channel, payload) => {
      created = await f.invoke(channel, payload);
      await new Promise(resolve => { finish = resolve; }); return created;
    } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.success, true, f.errors.at(-1)?.stack);
  assert.notEqual(created.leaseId, o.reader.identity.leaseId);
  abort.abort(); await assert.rejects(pending, /HISTORY_READ_CANCELLED/); finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.plane.stats().roots, baseline); assert.equal((await query(o)).total, 1);
  assert.equal(f.calls.filter(call => call.channel === 'agent-transcript:release-read-root' && call.leaseId === created.leaseId).length, 1);
  await assert.rejects(o.reader.forkCanonicalConsumerValue(content, { operation: 'unknown' }), /QUERY_INVALID/);
  const mutations = [
    packet => { delete packet.encoding; },
    packet => { delete packet.payloadDocument; },
    packet => { packet.encoding = 'plain'; },
    packet => { packet.operation = 'number'; },
    packet => { packet.totalChars++; },
    packet => { packet.extra = true; },
    packet => { packet.payloadDocument = { ...packet.payloadDocument, leaseId: o.reader.identity.leaseId }; },
    packet => { packet.payloadDocument = { ...packet.payloadDocument, ownerKey: 'foreign' }; },
    packet => { packet.payloadDocument = { ...packet.payloadDocument, kind: 'array' }; },
  ];
  for (const mutate of mutations) {
    let admission;
    const firstCall = f.calls.length;
    await assert.rejects(o.reader.forkCanonicalConsumerValue(row, { operation: 'string-falsy', field: 'content',
      invoke: async (channel, payload) => {
        admission = await f.invoke(channel, payload); assert.equal(admission.success, true, f.errors.at(-1)?.stack);
        const packet = structuredClone(admission); mutate(packet); return packet;
      } }), /PROTOCOL|DESCRIPTOR_INVALID/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.plane.stats().roots, baseline, 'malformed payload does not orphan its admitted child');
    assert.deepEqual(f.calls.slice(firstCall).filter(call => call.channel === 'agent-transcript:release-read-root')
      .map(call => call.leaseId), [admission.leaseId], 'only the exact admitted child is released');
  }
  const firstCall = f.calls.length;
  const parentPayload = { success: true, __notedHistoryTransport: 'root-v1', ...o.reader.identity,
    payloadDocument: content, totalChars: content.length, encoding: ENCODING, operation: 'string-falsy' };
  await assert.rejects(o.reader.forkCanonicalConsumerValue(content, { operation: 'string-falsy',
    invoke: async () => parentPayload }), /PROTOCOL/);
  const foreignPayload = { ...parentPayload, leaseId: 'foreign-child', ownerKey: 'foreign',
    payloadDocument: { ...content, leaseId: 'foreign-child', ownerKey: 'foreign' } };
  await assert.rejects(o.reader.forkCanonicalConsumerValue(content, { operation: 'string-falsy',
    invoke: async () => foreignPayload }), /PROTOCOL/);
  assert.equal(f.calls.slice(firstCall).filter(call => call.channel === 'agent-transcript:release-read-root').length, 0,
    'parent and foreign owner cannot become cleanup targets');
  const doc = await o.reader.forkCanonicalConsumerValue(content, { operation: 'string-falsy' });
  await o.reader.close(); assert.equal(await text(doc), full); await doc.close();
});
