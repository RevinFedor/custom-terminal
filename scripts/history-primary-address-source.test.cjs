'use strict';

// Finite SOURCE control, not Electron/E28, latency or a process-memory proof.
// Run: node --max-old-space-size=64 --max-semi-space-size=8 --test scripts/history-primary-address-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), v8 = require('node:v8');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..'), MAIN = path.join(ROOT, 'src/main/history-root-engine/main');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync: materialize } = require(path.join(MAIN, 'history-paged-store'));
const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
const { historyPrimaryPhysicalKey } = require(path.join(MAIN, 'history-primary-physical-key'));
const local = require(path.join(MAIN, 'history-primary-compat/src/renderer/utils/primaryLocalCompat.ts.cjs'));
const { decorateHistoryPromptPresentations } = require(path.join(MAIN, 'history-primary-compat/src/main/history-prompt-presentations.js.cjs'));
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite V8 TOTAL <=128MiB; use documented command');
const native = Promise.all(['historyDisplayUnits.mjs', 'historyLiveProjection.mjs', 'historyToolNavigation.mjs']
  .map(name => import(pathToFileURL(path.join(ROOT, 'src/renderer/utils', name)))));
const user = (uuid, content = '', extra = {}) => ({ uuid, role: 'user', type: 'user', content, sessionId: 's', ...extra });
const assistant = (uuid, content = '', extra = {}) => ({ uuid, role: 'assistant', type: 'assistant', content, sessionId: 's', ...extra });
const call = (uuid, id, extra = {}) => assistant(uuid, '', { actions: [{ tool: '__raw__', rawTool: {
  toolUseId: id, toolName: 'Read', family: 'read', args: { file_path: '/finite/file' }, result: 'exact\0\ud800\udc00😀\r\nresult',
} }], ...extra });
const state = (f, o) => f.plane.state(o.root, f.consumerKey);
const prepared = (f, o) => state(f, o).primaryPresentation;
const query = (o, options = {}) => o.reader.primaryPresentationAddresses(o.root, { header: o.header, ...options });
const decode = (f, o, descriptor) => materialize(f.plane.cursor(state(f, o), descriptor.nodeToken));
const headerAt = (f, o, item) => decode(f, o, item.header);
const request = (o, options = {}) => ({ ...o.reader.identity, nodeToken: o.root.nodeToken,
  kind: 'primary-presentation-address', profile: 'primary-presentation-address-v1',
  semanticIdentity: o.header.semanticIdentity, metadataIdentity: o.header.metadataIdentity,
  semanticRevisionToken: o.header.semanticRevisionToken, viewRevisionToken: o.header.viewRevisionToken,
  mode: 'range', offset: 0, limit: 3, value: null, tool: null, creditBytes: 65536, ...options });
const control = { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } };
async function text(document) { let value = ''; for await (const chunk of document.chunks()) value += chunk; return value; }

async function nativePrepared(data, options = {}) {
  const [, live] = await native;
  const durable = structuredClone(data).map(row => ['user', 'queued'].includes(row.role) || row.type === 'user' || row.kind === 'user'
    ? decorateHistoryPromptPresentations(undefined, { toolType: 'codex', sessionId: 's', entries: [row] })[0] : row);
  const filtered = local.filterSuppressedPromptEntries(durable, options.suppressions || []).entries;
  let combined = local.mergeServerAndLocalEntries(filtered, options.localEntries || []);
  combined = live.buildHistoryLivePresentation(combined, options.liveEntries || [], { settingsPresentationKeys: new Map(options.settingsPresentationKeys || []) });
  if (options.liveToolResults?.length) combined = combined.map(row => live.applyHistoryLiveToolResultsToEntry(row, options.liveToolResults));
  return local.buildRewindPreviewEntries(combined, options.rewindPreview || null).entries;
}

async function compare(f, o, data, options = {}) {
  const [display, live] = await native, p = prepared(f, o);
  const expectedSource = await nativePrepared(data, options), actualSource = materialize(p.presentationSource());
  assert.deepEqual(actualSource, expectedSource, 'complete prepared content/provenance/aliases/undefined/cycles');
  const expected = display.buildHistoryDisplayUnits(expectedSource, options.grouping || {});
  assert.equal(o.header.totalEntries, expected.length);
  const keys = [];
  for (let rank = 0; rank < expected.length; rank++) {
    assert.deepEqual(materialize(p.unitAt(rank)), expected[rank], 'complete native unit at ' + rank);
    const key = expected[rank].kind === 'group' ? String(expected[rank].key || '') : String(live.historyLivePresentationKey(expected[rank].entry));
    assert.equal(materialize(p.headerAt(rank).field('physicalKey')), key, 'actual Panel physical key'); keys.push(key);
  }
  for (let offset = 0; offset < expected.length;) {
    const page = await query(o, { mode: 'range', offset, limit: 3 });
    assert.equal(page.status, 'range');
    for (const item of page.items) assert.equal(headerAt(f, o, item).physicalKey, keys[item.rank]);
    offset = page.nextOffset;
  }
  for (const row of expectedSource) {
    if (!row.uuid || row.uuid.length > 2048 || Buffer.byteLength(row.uuid) > 4096) continue;
    const expectedAddress = display.resolveHistoryDisplayTarget(expected, row.uuid);
    const result = await query(o, { mode: 'uuid', value: row.uuid });
    assert.equal(result.status, expectedAddress ? 'found' : 'absent');
    if (expectedAddress) {
      assert.equal(result.items[0].rank, expectedAddress.index);
      assert.equal(decode(f, o, result.items[0].entry).uuid, row.uuid);
    }
  }
  return { expected, expectedSource, keys };
}

test('complete native preparation/grouping/key differential; hidden members, exact tool aliases, view fork, append', async t => {
  const graph = { retained: undefined, text: 'Unicode İΣ😀\0\r\n\ud800\udc00', nested: { note: 'full note' } };
  graph.self = graph; graph.alias = graph.nested;
  const longId = 'long-' + 'ID😀\ud800\0'.repeat(420);
  const data = [user('u0', 'authored', { graph, sourceIdentityAliases: ['inherited\0', 'alias\ud800'],
    sourceUuidAliases: ['old-u0'], entryRef: { physicalSessionId: 'physical', rawUuid: 'raw-u0', segmentId: 'seg' } }),
    assistant('caption', 'Read these files', { messageId: 'm' }),
    call('a1', 'tool-1', { messageId: 'm', sourceIdentity: 'source-a1', sourceIdentityAliases: ['alias-a1'] }),
    assistant('thinking', '', { thinking: 'exact reasoning', messageId: 'm' }),
    call('a2', 'tool-2', { messageId: 'm', entryRef: { physicalSessionId: 'p2', rawUuid: 'raw2', segmentId: 'seg2' } }),
    user('boundary', 'stop grouping'), { uuid: 'compact', role: 'compact', content: 'summary', sourceIdentity: 'compact-source', compactSummary: 'FULL\0summary' },
    { uuid: 'settings', role: 'slash', content: '/model x', sourceIdentity: 'setting-source', settingsFact: { version: 1, provider: 'codex', kind: 'model', value: 'x' } },
    { uuid: 'interrupted', role: 'interrupted', content: 'interrupted', sourceIdentity: 'codex-interrupted-source-1', serviceCarrier: 'turn-aborted' },
    assistant(longId, 'long identity off window', { sourceIdentity: 'long-key-' + longId }),
    assistant('duplicate-key-a', 'first', { rewriteRenderKey: 'same-key' }), assistant('duplicate-key-b', 'second', { rewriteRenderKey: 'same-key' })];
  const f = await createPrimaryAddressFixture(t, { entries: data }), o = await f.open();
  assert.equal(o.kind, 'root', f.errors.at(-1)?.stack);
  assert.deepEqual(materialize(f.source.entries), data, 'complete canonical graph preserved');
  const expected = await compare(f, o, data);
  assert(expected.expected.some(unit => unit.kind === 'group'), 'fixture must actually group');
  const group = expected.expected.find(unit => unit.kind === 'group');
  const groupAddress = await query(o, { mode: 'group', value: group.key });
  assert.equal(headerAt(f, o, groupAddress.items[0]).physicalKey, group.key);
  const hidden = await query(o, { mode: 'uuid', value: 'a2' });
  assert.equal(hidden.items[0].rank, groupAddress.items[0].rank);
  assert.equal(decode(f, o, hidden.items[0].entry).uuid, 'a2', 'target is actual hidden member, not firstUuid');
  assert.equal((await query(o, { mode: 'key', value: 'same-key' })).status, 'ambiguous');

  const [, , navigation] = await native;
  for (const [identity, tool] of [ ['alias-a1', null], ['ignored', { toolUseId: 'tool-2' }],
    ['ignored', { messageReference: { physicalSessionId: 'p2', rawUuid: 'raw2', transcriptSegmentId: 'seg2' } }],
    ['ignored', { messageReference: { physicalSessionId: 'p2', rawUuid: 'raw2', transcriptSegmentId: 'wrong' } }],
    ['absent', null] ]) {
    const wanted = navigation.resolveHistoryToolNavigationTarget(expected.expectedSource, identity, tool);
    const result = await query(o, { mode: 'target', value: identity, tool });
    assert.equal(result.status, wanted ? 'found' : 'absent');
    if (wanted) assert.equal(decode(f, o, result.items[0].entry).uuid, wanted.uuid);
  }
  const scan = await query(o, { mode: 'scan' });
  assert.deepEqual(decode(f, o, scan.source), expected.expectedSource, 'signed scan cursor is prepared source');
  const ordinal = expected.expectedSource.findIndex(row => row.uuid === longId);
  const long = await query(o, { mode: 'source-rank', offset: ordinal });
  assert.equal(decode(f, o, long.items[0].entry).uuid, longId);
  const fields = await o.reader.project(long.items[0].header, ['physicalKey']);
  const keyDescriptor = fields.items[0].value;
  assert.equal(await text(o.reader.text(keyDescriptor)), 'source:long-key-' + longId, 'complete paged physical key, no prefix');

  const expandedOptions = { grouping: { enabled: true, threshold: 2, expandedKeys: [group.key] } };
  const expanded = await f.open({ primaryRequestClass: 'view', localRootLease: o.reader.identity,
    expectedSemanticIdentity: o.header.semanticIdentity, primaryViewOptions: { ...expandedOptions, captionSelections: [] } });
  assert.equal(expanded.kind, 'root', f.errors.at(-1)?.stack);
  assert.equal(expanded.header.semanticIdentity, o.header.semanticIdentity);
  assert.equal(expanded.header.metadataIdentity, o.header.metadataIdentity);
  assert.equal(expanded.header.readMetrics.primaryMetadataRows, 0);
  await compare(f, expanded, data, expandedOptions);
  assert.notEqual((await query(expanded, { mode: 'uuid', value: 'a2' })).items[0].rank,
    (await query(expanded, { mode: 'group', value: group.key })).items[0].rank, 'expanded child address belongs to its own row');

  const refresh = await f.open({ primaryRequestClass: 'semantic', localRootLease: o.reader.identity });
  assert.equal(refresh.kind, 'root', f.errors.at(-1)?.stack);
  const refreshExpected = await compare(f, refresh, data);
  assert.deepEqual(refreshExpected.keys, expected.keys, 'metadata-only semantic refresh does not lease-key unchanged rows');
  assert.notEqual(refresh.header.semanticIdentity, o.header.semanticIdentity);
  const appended = [...data, user('appended', 'next prompt')]; f.setEntries(appended);
  const append = await f.open(); assert.equal(append.kind, 'root');
  const appendExpected = await compare(f, append, appended);
  assert.deepEqual(appendExpected.keys.slice(0, expected.keys.length), expected.keys, 'true append retains previous physical keys');

  // Correctness above precedes bounds. Ordinary range/point reads allocate no
  // view, do no semantic/metadata preparation, and use no metadata IPC profile.
  const callsAt = f.calls.length, builds = prepared(f, append).stats().work, leases = f.store.stats().leases;
  for (const offset of [0, 3, 0]) await query(append, { mode: 'range', offset });
  await query(append, { mode: 'uuid', value: 'a2' });
  assert.deepEqual(prepared(f, append).stats().work, builds); assert.equal(f.store.stats().leases, leases);
  assert(f.calls.slice(callsAt).every(row => row.kind === 'primary-presentation-address'));
  assert(f.plane.stats().maxReturnedItems <= 3); assert(f.plane.stats().maxPacketBytes <= 65536);
  assert(f.calls.every(row => ['agent-transcript:get-history', 'agent-transcript:read-page', 'agent-transcript:fork-read-leaf', 'agent-transcript:release-read-root'].includes(row.channel)));
  for (const opened of [o, expanded, refresh, append]) await opened.reader.close();
});

test('exact physical key grammar over paged queue normalization and all override/source branches', async t => {
  const [, live] = await native;
  const f = await createPrimaryAddressFixture(t), arena = new HistoryProjectionArena(f.store);
  const values = [undefined, user('uuid'), assistant('uuid', '', { sourceIdentity: 'source\0\ud800' }),
    { role: 'compact', uuid: 'c', sourceIdentity: 'compact' }, { role: 'goal', uuid: 'g', sourceIdentity: 'goal' },
    { role: 'interrupted', uuid: 'i', sourceIdentity: 'codex-interrupted-source-x', serviceCarrier: 'turn-aborted' },
    { role: 'interrupted', uuid: 'i', sourceIdentity: 'different', serviceCarrier: 'turn-aborted' },
    { role: 'slash', uuid: 's', sourceIdentity: 'setting', settingsFact: { version: 1, provider: 'codex', kind: 'effort', value: 'high' } },
    { role: 'user', uuid: 'u', sourceIdentity: 'claude-queue:existing' },
    { role: 'assistant', uuid: 'u', rewriteRenderKey: 'rewrite', settingsPresentationKey: 'settings', servicePresentationKey: 'service' },
    { role: 'assistant', uuid: 'u', settingsPresentationKey: 'settings', servicePresentationKey: 'service' },
    { role: 'assistant', uuid: 'u', servicePresentationKey: 'service' }];
  for (const content of ['  A\n B  ', '<system-reminder>hidden\ntext</system-reminder>[200~ A~] B\0\ud800😀',
    'x'.repeat(505) + '<system-reminder>' + 'hidden'.repeat(120) + '</system-reminder>\r\nTail\udc00',
    ['first', { type: 'image', text: 'ignore' }, '', { type: 'text', text: 'second' }, 'last'], { text: 'object' },
    '<system-reminder>only</system-reminder>', '<system-reminder>unclosed', ' \r\n\u2028\uFEFF ']) {
    values.push({ role: 'queued', uuid: 'queued', content, timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's' });
    values.push({ role: 'queued', uuid: 'local-prompt-q', content, timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's' });
  }
  try {
    for (const row of values) {
      let lease;
      try {
        lease = arena.step(() => arena.publish(historyPrimaryPhysicalKey(arena, arena.own({ kind: 'entry', entry: row }))));
        assert.equal(materialize(lease.cursor()), String(live.historyLivePresentationKey(row)));
      } finally { lease?.release(); }
    }
  } finally { arena.close(); }
});

test('negotiated profile cannot relax old metadata limit, stale cuts, credits, ownership or independent leases', async t => {
  const duplicate = [user('u'), call('one', 'ambiguous-call'), call('two', 'other-call'),
    user('boundary'), call('three', 'ambiguous-call'), call('four', 'last-call')];
  const f = await createPrimaryAddressFixture(t, { entries: duplicate }), o = await f.open();
  assert.equal(o.kind, 'root');
  assert.equal((await query(o, { mode: 'target', value: 'one', tool: { toolUseId: 'ambiguous-call' } })).status, 'ambiguous');
  const [display] = await native, units = display.buildHistoryDisplayUnits(await nativePrepared(duplicate));
  const duplicateGroupKey = units.find(unit => unit.kind === 'group').key;
  const firstGroupIndex = units.findIndex(unit => unit.kind === 'group' && unit.key === duplicateGroupKey);
  assert.equal(units.filter(unit => unit.kind === 'group' && unit.key === duplicateGroupKey).length, 2, 'actual duplicate group-key counterexample');
  assert.equal((await query(o, { mode: 'group', value: duplicateGroupKey })).items[0].rank, firstGroupIndex,
    'group address preserves native findIndex first occurrence, including short/long selector parity');
  assert.equal((await query(o, { mode: 'key', value: duplicateGroupKey })).status, 'ambiguous');
  const badRequests = [ { limit: 4 }, { mode: 'target', value: 'one', tool: { toolUseId: 'x', mutation: 'forbidden' } },
    { profile: 'old-generic-find' }, { viewRevisionToken: 'stale' }, { metadataIdentity: 'stale' },
    { creditBytes: 65537 }, { mode: 'uuid', value: 'x'.repeat(2049) }, { offset: o.header.totalEntries + 1 } ];
  for (const change of badRequests) await assert.rejects(f.plane.readPage(request(o, change), { consumerKey: f.consumerKey, control }));
  const literal = '\0'.repeat(2048), aggregate = { mode: 'target', value: literal,
    tool: { toolUseId: literal, messageReference: { physicalSessionId: literal, sessionId: literal,
      transcriptSegmentId: literal, rawUuid: literal } } };
  assert(Buffer.byteLength(JSON.stringify(request(o, aggregate))) > 65536);
  await assert.rejects(f.plane.readPage(request(o, aggregate), { consumerKey: f.consumerKey, control }), /HISTORY_PRIMARY_ADDRESS_QUERY_INVALID/);
  const beforeAggregate = f.calls.length;
  await assert.rejects(query(o, aggregate), /HISTORY_PRIMARY_ADDRESS_QUERY_INVALID/);
  assert.equal(f.calls.length, beforeAggregate, 'aggregate escaped literals never exceed request wire credit');
  await assert.rejects(f.plane.readPage(request(o), { consumerKey: 'wrong-owner', control }), /HISTORY_ROOT_OWNER_MISMATCH/);
  const once = f.calls.length;
  await assert.rejects(query(o, { creditBytes: 512 }), /HISTORY_ROOT_CREDIT_TOO_SMALL/);
  assert.equal(f.calls.length, once + 1, 'credit refusal does not retry or enlarge');
  await assert.rejects(f.plane.readPage({ ...o.reader.identity, nodeToken: o.header.sourceMetadata.nodeToken,
    kind: 'rowWindow', profile: 'primary-metadata-fields-v1', offset: 0, limit: 2, creditBytes: 65536 },
  { consumerKey: f.consumerKey, control }), /HISTORY_ROOT_FIELDS/);

  const proof = await f.plane.readPage(request(o), { consumerKey: f.consumerKey, control });
  for (const transform of [packet => ({ ...packet, kind: 'find', status: 'absent', items: [] }),
    packet => ({ ...packet, viewRevisionToken: 'other-cut' }), packet => ({ ...packet, sourceCount: 0 }),
    packet => ({ ...packet, hiddenPayload: [] }), packet => ({ ...packet, items: packet.items.map(item => ({ ...item, rank: 100 })) })]) {
    const malformed = transform(proof); let previous;
    do { previous = malformed.creditBytesUsed; malformed.creditBytesUsed = Buffer.byteLength(JSON.stringify(malformed)); }
    while (previous !== malformed.creditBytesUsed);
    await assert.rejects(query(o, { invoke: async () => malformed }), /HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL/);
  }
  await assert.rejects(query(o, { invoke: async () => ({ ...proof, creditBytesUsed: proof.creditBytesUsed + 1 }) }), /HISTORY_ROOT_PAGE_CREDIT/);
  const aborted = new AbortController(); aborted.abort(); f.setSignal(aborted.signal);
  await assert.rejects(query(o), /HISTORY_READ_CANCELLED/); f.setSignal(null);
  assert.equal((await query(o)).status, 'range', 'aborted query does not close independent parent capability');

  const first = (await query(o)).items[0], document = await o.reader.forkViewUnit(first.header);
  const expected = materialize(prepared(f, o).unitAt(first.rank));
  await o.reader.close();
  const encoded = await text(document), actual = v8.deserialize(Buffer.from(encoded, 'base64'));
  assert.deepEqual(actual, expected, 'whole unit lease survives parent release');
  await document.close();
  await assert.rejects(f.plane.readPage(request(o), { consumerKey: f.consumerKey, control }), /HISTORY_ROOT_RELEASED/);
  assert.equal(f.calls.filter(row => !['agent-transcript:get-history', 'agent-transcript:read-page', 'agent-transcript:fork-read-leaf', 'agent-transcript:release-read-root'].includes(row.channel)).length, 0);
});
