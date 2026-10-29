'use strict';

// Finite SOURCE controls for the live coverage's selected-value channel.
// Native values/complete strings exist only in the finite expected-value
// oracle. Product reads use the actual held store/plane/client and text leases.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-live-values-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), v8 = require('node:v8');
const { pathToFileURL } = require('node:url');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const ROOT = path.resolve(__dirname, '..'), MAIN = path.join(ROOT, 'src/main/history-root-engine/main');
const { materializeHistoryCursorSync } = require(path.join(MAIN, 'history-paged-store'));
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite V8 TOTAL<=128MiB');
const ENCODING = 'history-canonical-consumer-text-v1';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function text(document) {
  try { let result = ''; for await (const chunk of document.chunks()) result += chunk; return result; }
  finally { await document.close(); }
}
async function fixture(t, cases) {
  const f = await createPrimaryAddressFixture(t, { entries: [{ uuid: 'safe', role: 'assistant',
    content: 'unchanged body', sessionId: 's', selectedCases: cases }] });
  const opened = await f.open(); assert.equal(opened.kind, 'root', f.errors.at(-1)?.stack);
  const page = await opened.reader.primaryCanonicalConsumers(opened.header.durableMetadata,
    { header: opened.header, scope: 'canonical' });
  const state = f.plane.state(opened.reader.identity, f.consumerKey);
  const array = f.plane.cursor(state, page.items[0].row.nodeToken).field('selectedCases');
  const node = index => f.plane.describe(state, array.at(index), { inline: false });
  return { f, opened, state, array, node };
}
// Execute the exact CURRENT private predicate without copying its logic or
// parsing the giant Panel. The bounded source extraction is one named arrow.
const liveSource = fs.readFileSync(path.join(ROOT, 'src/renderer/utils/historyLiveProjection.mjs'), 'utf8');
const start = liveSource.indexOf('const codexSettingFact = (entry) => {');
assert(start >= 0, 'actual settings predicate exists');
const end = liveSource.indexOf('\n};', start);
assert(end > start, 'actual settings predicate terminates');
const nativeSettingFact = new Function(liveSource.slice(start, end + 3) + '\nreturn codexSettingFact;')();

test('actual truthy projection preserves primitive/container truth without coercing UUID values', async t => {
  const cycle = []; cycle.push(cycle);
  const noString = Object.create(null); noString.x = 'cannot stringify';
  const values = [undefined, null, false, true, 0, -0, NaN, Infinity, -Infinity,
    0n, 1n, BigInt('9'.repeat(128)), '', '0', '\0\ud800😀\\"'.repeat(2048),
    [], [0], cycle, noString, { toString: undefined }, new Map(), new Set()];
  const { f, opened, node, array } = await fixture(t, values.map(uuid => ({ uuid })));
  for (let index = 0; index < values.length; index++) {
    const native = materializeHistoryCursorSync(array.at(index)).uuid;
    assert.equal(await text(await opened.reader.forkCanonicalConsumerValue(node(index),
      { operation: 'truthy', field: 'uuid' })), String(Boolean(native)), 'truthy case ' + index);
  }
  assert.equal(f.store.stats().activeBuilders, 0);
  await opened.reader.close();
});

test('actual fixed settings projections match CURRENT strict predicate and complete giant UTF16 values', async t => {
  const full = '  \\"\0\ud800😀\r\n'.repeat(8193) + 'FULL-END  ';
  const fact = { version: 1, provider: 'codex', kind: 'model', value: full };
  const row = { role: 'slash', sessionId: 's', uuid: 'u', settingsFact: fact };
  const cases = [row, { ...row, settingsFact: { ...fact, kind: 'effort', value: ' ' } },
    ...[undefined, null, false, 0, 'fact', [], {}, { ...fact, value: '' }, { ...fact, value: ['model'] },
      { ...fact, value: 1 }, { ...fact, value: true }, { ...fact, version: '1' }, { ...fact, version: 1n },
      { ...fact, version: NaN }, { ...fact, provider: 'Codex' }, { ...fact, provider: ['codex'] },
      { ...fact, kind: ['model'] }, { ...fact, kind: ' model' }, { ...fact, kind: 'other' }]
      .map(settingsFact => ({ ...row, settingsFact })),
    ...['user', 'assistant', 'queued', undefined, ['slash']].map(role => ({ ...row, role })),
  ];
  const { f, opened, node, array } = await fixture(t, cases);
  for (let index = 0; index < cases.length; index++) {
    const native = materializeHistoryCursorSync(array.at(index));
    const expected = nativeSettingFact(native);
    assert.equal(await text(await opened.reader.forkCanonicalConsumerValue(node(index),
      { operation: 'live-setting-kind' })), expected?.kind || '', 'kind case ' + index);
    assert.equal(await text(await opened.reader.forkCanonicalConsumerValue(node(index),
      { operation: 'live-setting-value' })), expected?.value || '', 'value case ' + index);
  }
  assert(full.length > 65536, 'selected exact value exceeds a wire packet');
  assert(f.plane.metrics.maxPacketBytes <= 65536);
  assert.equal(f.store.stats().activeBuilders, 0);
  await opened.reader.close();
});

test('actual settings lookup follows inherited frozen fields and strict numeric version', async t => {
  const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
  const { f, opened, state } = await fixture(t, []), arena = new HistoryProjectionArena(f.store);
  let lease;
  try {
    lease = arena.step(() => {
      const cases = arena.make('array'), inheritedFact = arena.make('object'), fact = arena.make('object');
      inheritedFact.version = 1; inheritedFact.provider = 'codex'; inheritedFact.kind = 'effort';
      inheritedFact.value = '\0full\ud800😀value'; arena.setPrototype(arena.owner(fact), inheritedFact);
      const inheritedRow = arena.make('object'), row = arena.make('object');
      inheritedRow.role = 'slash'; inheritedRow.settingsFact = fact;
      arena.setPrototype(arena.owner(row), inheritedRow); cases.push(row);
      const arrayFact = arena.make('array'); arrayFact.version = 1; arrayFact.provider = 'codex';
      arrayFact.kind = 'model'; arrayFact.value = 'exact-array-property'; cases.push({ role: 'slash', settingsFact: arrayFact });
      const nullFact = arena.make('object'); arena.setPrototype(arena.owner(nullFact), null);
      nullFact.version = 1; nullFact.provider = 'codex'; nullFact.kind = 'model'; nullFact.value = 'null-prototype';
      cases.push({ role: 'slash', settingsFact: nullFact });
      return arena.publish(cases);
    });
  } finally { arena.close(); }
  const installed = f.plane.install({ root: lease, primaryPresentation: state.primaryPresentation }, lease.cursor(),
    { consumerKey: f.consumerKey, ownerKey: state.ownerKey, revision: state.revision, source: state.source,
      release: () => lease.release() });
  const { HistoryRootClient } = await import(pathToFileURL(path.join(ROOT, 'src/shared/history-root-read-client.mjs')));
  const client = new HistoryRootClient(f.invoke, installed.descriptor);
  for (let index = 0; index < lease.cursor().length; index++) {
    const cursor = lease.cursor().at(index), expected = nativeSettingFact(materializeHistoryCursorSync(cursor));
    const descriptor = f.plane.describe(installed.state, cursor, { inline: false });
    assert(expected, 'finite native fixture contains a valid inherited/array/null fact');
    for (const select of ['kind', 'value']) assert.equal(await text(await client.forkCanonicalConsumerValue(descriptor,
      { operation: 'live-setting-' + select })), expected[select]);
  }
  await client.close(); await opened.reader.close();
});

test('settings operations remain row-only fixed selectors and invalid requests allocate no child', async t => {
  const { f, opened, node, state, array } = await fixture(t, [{ role: 'slash', settingsFact: {
    version: 1, provider: 'codex', kind: 'model', value: 'exact' } }]);
  const before = f.plane.stats().roots;
  for (const operation of ['live-setting-kind', 'live-setting-value']) {
    for (const options of [{ field: 'content' }, { index: 0 }, { field: 'sourceIdentityAliases', index: 0 }]) {
      const calls = f.calls.length;
      await assert.rejects(opened.reader.forkCanonicalConsumerValue(node(0), { operation, ...options }));
      assert.equal(f.calls.length, calls, 'invalid client selector rejected before dispatch');
      await assert.rejects(f.plane.forkCanonicalConsumerValue({ ...opened.reader.identity,
        nodeToken: node(0).nodeToken, encoding: ENCODING, operation, ...options }, { consumerKey: f.consumerKey }));
    }
    await assert.rejects(opened.reader.forkCanonicalConsumerValue(f.plane.describe(state, array, { inline: false }), { operation }));
    for (const change of [{ ownerKey: 'foreign' }, { generation: 'foreign' }, { member: 'value' },
      { operation: 'live-setting-anything' }, { diagnosticActionId: '\0'.repeat(11000) }]) {
      await assert.rejects(f.plane.forkCanonicalConsumerValue({ ...opened.reader.identity, nodeToken: node(0).nodeToken,
        encoding: ENCODING, operation, ...change }, { consumerKey: f.consumerKey }));
    }
  }
  assert.equal(f.plane.stats().roots, before); assert.equal(f.store.stats().activeBuilders, 0);
  assert.equal(await text(await opened.reader.forkCanonicalConsumerValue(node(0), { operation: 'live-setting-value' })), 'exact');
  await opened.reader.close();
});

test('cancelled and late settings forks preserve parent and independent text lease without retry', async t => {
  const wide = {};
  for (let n = 0; n < 160; n++) wide['irrelevant-' + n] = n;
  Object.assign(wide, { version: 1, provider: 'codex', kind: 'model', value: 'exact\0\ud800😀' });
  const { f, opened, node } = await fixture(t, [{ role: 'slash', settingsFact: wide }]);
  const kept = await opened.reader.forkCanonicalConsumerValue(node(0), { operation: 'live-setting-value' });
  const before = f.plane.stats().roots; let stopped = false, checkpoints = 0;
  const request = { ...opened.reader.identity, nodeToken: node(0).nodeToken, encoding: ENCODING, operation: 'live-setting-value' };
  await assert.rejects(f.plane.forkCanonicalConsumerValue(request, { consumerKey: f.consumerKey, control: {
    assertCurrent() { if (stopped) throw Object.assign(new Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' }); },
    async checkpoint() { checkpoints++; stopped = true; await tick(); },
  } }), /HISTORY_READ_CANCELLED/);
  assert.equal(checkpoints, 1); assert.equal(f.plane.stats().roots, before);
  let releaseReply, allocated, calls = 0;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  const hasAllocated = new Promise(resolve => { allocated = resolve; });
  const abort = new AbortController();
  const pending = opened.reader.forkCanonicalConsumerValue(node(0), { operation: 'live-setting-value', signal: abort.signal,
    invoke: async (channel, payload) => { calls++; const reply = await f.invoke(channel, payload); allocated(); await replyGate; return reply; } });
  await hasAllocated; abort.abort(); await assert.rejects(pending, /HISTORY_READ_CANCELLED/);
  releaseReply(); await tick(); await tick();
  assert.equal(calls, 1); assert.equal(f.plane.stats().roots, before, 'late child released, independent child retained');
  let unknownCalls = 0;
  await assert.rejects(opened.reader.forkCanonicalConsumerValue(node(0), { operation: 'live-setting-kind',
    invoke: async () => { unknownCalls++; return { success: false, error: 'SOURCE_UNKNOWN' }; } }), /SOURCE_UNKNOWN/);
  assert.equal(unknownCalls, 1, 'UNKNOWN did not create a replay');
  await assert.rejects(opened.reader.forkCanonicalConsumerValue(node(0), { operation: 'live-setting-value',
    invoke: async (channel, payload) => ({ ...await f.invoke(channel, payload), operation: 'live-setting-kind' }) }), /PROTOCOL/);
  await tick(); assert.equal(f.plane.stats().roots, before, 'malformed new child released once');
  assert.equal(f.store.stats().activeBuilders, 0); assert.equal(f.plane.opening, 0);
  await opened.reader.close(); assert.equal(await text(kept), 'exact\0\ud800😀', 'own child survives parent close');
});
