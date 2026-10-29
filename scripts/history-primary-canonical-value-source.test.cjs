'use strict';

// SOURCE-only finite oracle. Native values are confined to this fixture and
// expected-result oracle; the selected production helper operates on pages.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-canonical-value-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), v8 = require('node:v8');
const { pathToFileURL } = require('node:url');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const ROOT = path.resolve(__dirname, '..'), MAIN = path.join(ROOT, 'src/main/history-root-engine/main');
const { materializeHistoryCursorSync } = require(path.join(MAIN, 'history-paged-store'));
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite V8 TOTAL<=128MiB; use documented command');
const ENCODING = 'history-canonical-consumer-text-v1';
async function value(doc) { try { let text = ''; for await (const chunk of doc.chunks()) text += chunk; return text; } finally { await doc.close(); } }
async function fixture(t, cases) {
  const f = await createPrimaryAddressFixture(t, { entries: [{ uuid: 'safe', role: 'assistant', content: 'unchanged body',
    sessionId: 's', selectedCases: cases }] });
  const o = await f.open(); assert.equal(o.kind, 'root', f.errors.at(-1)?.stack);
  const page = await o.reader.primaryCanonicalConsumers(o.header.durableMetadata, { header: o.header, scope: 'canonical' });
  const state = f.plane.state(o.reader.identity, f.consumerKey);
  const array = f.plane.cursor(state, page.items[0].row.nodeToken).field('selectedCases');
  const node = index => f.plane.describe(state, array.at(index), { inline: false });
  return { f, o, node, array };
}
const expectedNumber = number => Object.is(number, -0) ? '-0' : String(number);

test('actual selected coercion preserves complete String(value||empty), Number and exact kinds across finite native oracle', async t => {
  const cycle = ['before']; cycle.push(cycle, ['after', null]);
  const sparse = new Array(7); sparse[2] = 'two'; sparse[6] = false;
  const noJoin = ['hidden']; noJoin.join = undefined;
  const noString = { toString: undefined };
  const nullPrototype = Object.create(null); nullPrototype.x = 1;
  const huge = 'escaped\\\"\0\ud800😀\r\n'.repeat(1400) + 'FULL-END';
  const cases = [undefined, null, false, true, 0, -0, NaN, Infinity, -Infinity, 1.234e-200, 0n, 9007199254740993n,
    BigInt('9'.repeat(128)), '', '\uFEFF\u2028 42\u00a0', '-0', '+Infinity', ' -Infinity ', '+0x10', '0x20000000000001',
    '0b' + '1'.repeat(140), '0o1777777777777777777', '0x' + 'f'.repeat(300), '0x' + 'f'.repeat(300) + 'z',
    '0.' + '0'.repeat(1200) + '1', '1' + '0'.repeat(1400), '1' + '0'.repeat(1400) + 'x', '1e' + '9'.repeat(1400),
    '-1e-' + '9'.repeat(1400), '.125', '1.', '.e1', '1e+', 'NaN', huge, [], [undefined, null, '', 0, false, [1, 2], []],
    sparse, cycle, noJoin, {}, { valueOf: undefined }, noString, nullPrototype, new Map([['x', 1]]), new Set(['x'])];
  const wrapped = cases.map(content => ({ content }));
  const { f, o, node, array } = await fixture(t, wrapped);
  for (let index = 0; index < wrapped.length; index++) {
    // Native differential is over the exact frozen value returned by the
    // actual source, including its supported special values/prototypes.
    const actual = materializeHistoryCursorSync(array.at(index).field('content'));
    const type = actual === null ? 'null' : Array.isArray(actual) ? 'array' : actual instanceof Map ? 'map'
      : actual instanceof Set ? 'set' : typeof actual;
    assert.equal(await value(await o.reader.forkCanonicalConsumerValue(node(index), { field: 'content', operation: 'kind' })), type);
    for (const operation of ['string-falsy', 'number']) {
      let expected, error;
      try { expected = operation === 'string-falsy' ? String(actual || '') : expectedNumber(Number(actual)); } catch (caught) { error = caught; }
      const run = () => o.reader.forkCanonicalConsumerValue(node(index), { field: 'content', operation }).then(value);
      if (error) await assert.rejects(run(), undefined, 'same refusal for case ' + index + '/' + operation);
      else assert.equal(await run(), expected, 'case ' + index + '/' + operation);
    }
  }
  assert(f.plane.metrics.canonicalValueCheckpoints > 0, 'actual numeric and field walks cooperatively checkpoint');
  assert.equal(f.plane.metrics.canonicalValueResidentFrames, 2);
  assert.equal(f.store.stats().activeBuilders, 0);
  await o.reader.close();
});

test('actual queue identity matches current renderer grammar including UTF16, escapes, array carriers and dangling markers', async t => {
  const { claudeHistoryQueuePresentationIdentity } = await import(pathToFileURL(path.join(ROOT, 'src/renderer/utils/historyClaudePromptCarriers.mjs')));
  const common = { role: 'queued', uuid: 'queue', sessionId: ' s\"\0 ', timestamp: ' t\n ' };
  const noMap = ['must throw']; noMap.map = undefined;
  const badConstructor = ['must throw']; badConstructor.constructor = 7;
  const nullConstructor = ['must throw']; nullConstructor.constructor = null;
  const objectConstructor = ['preserved']; objectConstructor.constructor = {};
  const undefinedConstructor = ['preserved']; undefinedConstructor.constructor = undefined;
  const cases = [
    { ...common, content: '  alpha\r\n beta  ' },
    { ...common, content: '[200~before~]<system-reminder>hidden😀</system-reminder> after\ud800' },
    { ...common, content: 'x'.repeat(125) + '<system-reminder>z'.repeat(3) + '</system-reminder> tail' },
    { ...common, content: '<system-reminder>dangling' },
    { ...common, content: '<system-reminder>one</system-reminder>middle<system-reminder>two</system-reminder>' },
    { ...common, content: ['one', null, { type: 'text', text: 'two😀' }, { type: 'other', text: 'ignored' }, '', { text: 'ignored' }] },
    { ...common, content: { text: '\0\ud800\u2028tail' } },
    { ...common, content: ' \t\uFEFF ', timestamp: 'exists' },
    { ...common, content: 'one', timestamp: 0 },
    { ...common, content: 'one', sourceIdentity: 'claude-queue:exact\0\ud800' },
    { ...common, content: 'one', sourceIdentity: ['claude-queue:array-alias'] },
    { ...common, content: 'one', uuid: 'local-prompt-ignored', sourceIdentity: 'claude-queue:must-not-win' },
    { ...common, content: 'one', role: 'assistant' },
    { ...common, content: ['same ', { type: 'text', text: ' body'.repeat(800) }], timestamp: ['long', 'time'], sessionId: [1, 2] },
    ...[noMap, badConstructor, nullConstructor, objectConstructor, undefinedConstructor].flatMap(content => [
      { ...common, content }, { ...common, content, timestamp: 0 },
    ]),
  ];
  const { f, o, node, array } = await fixture(t, cases);
  for (let index = 0; index < cases.length; index++) {
    const current = materializeHistoryCursorSync(array.at(index));
    let expected, error;
    try { expected = claudeHistoryQueuePresentationIdentity(current); } catch (caught) { error = caught; }
    const run = () => o.reader.forkCanonicalConsumerValue(node(index), { operation: 'queue-identity' }).then(value);
    if (error) await assert.rejects(run(), undefined, 'queue refusal ' + index);
    else assert.equal(await run(), expected, 'queue ' + index);
  }
  assert(f.plane.metrics.canonicalValueCheckpoints > 0);
  await o.reader.close();
});

test('selected page-backed nested/cyclic joins do not keep native ancestry; cancelled work cleans child build only', async t => {
  let deep = 'tail\0\ud800'; for (let index = 0; index < 150; index++) deep = [deep];
  const { f, o, node } = await fixture(t, [{ content: deep }, { content: '1' + '0'.repeat(5000) }]);
  const beforeRoots = f.plane.stats().roots;
  const doc = await o.reader.forkCanonicalConsumerValue(node(0), { operation: 'string-falsy', field: 'content' });
  assert(f.plane.metrics.canonicalValueDepth >= 150);
  assert.equal(f.plane.metrics.canonicalValueResidentFrames, 2);
  let checks = 0, cancelled = false;
  const request = { ...o.reader.identity, nodeToken: node(1).nodeToken, encoding: ENCODING, operation: 'number', field: 'content' };
  await assert.rejects(f.plane.forkCanonicalConsumerValue(request, { consumerKey: f.consumerKey, control: {
    assertCurrent() { if (cancelled) throw Object.assign(new Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' }); },
    async checkpoint() { checks++; cancelled = true; await new Promise(resolve => setImmediate(resolve)); },
  } }), /HISTORY_READ_CANCELLED/);
  assert.equal(checks, 1); assert.equal(f.store.stats().activeBuilders, 0);
  assert.equal(f.plane.opening, 0); assert.equal(f.plane.stats().roots, beforeRoots + 1);
  assert.equal(await value(await o.reader.forkCanonicalConsumerValue(node(1), { operation: 'number', field: 'content' })), 'Infinity');
  await o.reader.close(); assert.equal(await value(doc), 'tail\0\ud800', 'completed independent result survives parent/cancel');
});

test('strict selected-value requests reject wrong owner, kind, selector, operation and wire; held cut is unchanged', async t => {
  const { f, o, node } = await fixture(t, [{ content: 'exact' }]);
  const request = { ...o.reader.identity, nodeToken: node(0).nodeToken, encoding: ENCODING, operation: 'string-falsy', field: 'content' };
  for (const change of [{ ownerKey: 'other' }, { generation: 'other' }, { encoding: 'plain' }, { operation: 'other' },
    { field: 'unbounded-user-selector' }, { index: -1 }, { index: 0 }, { operation: 'queue-identity' },
    { arbitrary: true }, { diagnosticActionId: '\0'.repeat(11000) }]) {
    await assert.rejects(f.plane.forkCanonicalConsumerValue({ ...request, ...change }, { consumerKey: f.consumerKey }));
  }
  assert.equal(await value(await o.reader.forkCanonicalConsumerValue(node(0), { operation: 'string-falsy', field: 'content' })), 'exact');
  assert.equal(f.store.stats().activeBuilders, 0); await o.reader.close();
});

test('actual frozen prototypes, inherited aliases and generic Array.join preserve native lookup and coercion errors', async t => {
  const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
  const { f, o } = await fixture(t, []);
  const parent = f.plane.state(o.reader.identity, f.consumerKey), arena = new HistoryProjectionArena(f.store);
  let lease;
  try {
    lease = arena.step(() => {
      const cases = arena.make('array');
      const arrayPrototype = arena.make('array'); arrayPrototype[1] = 'inherited';
      const arrayLike = arena.make('object');
      arena.setPrototype(arena.owner(arrayLike), arrayPrototype);
      arrayLike[0] = 'own'; arrayLike.length = ['2'];
      cases.push({ content: arrayLike });
      const bigintLength = arena.make('object'); arena.setPrototype(arena.owner(bigintLength), arrayPrototype);
      bigintLength.length = 2n; cases.push({ content: bigintLength });
      const cyclicLength = arena.make('object'); arena.setPrototype(arena.owner(cyclicLength), arrayPrototype);
      cyclicLength.length = cyclicLength; cases.push({ content: cyclicLength });
      const inherited = arena.make('object'), prototype = arena.make('object');
      prototype.sourceIdentityAliases = ['full\0\ud800 alias', ['assistant-uuid:', 'x']];
      arena.setPrototype(arena.owner(inherited), prototype); inherited.content = 'safe'; cases.push(inherited);
      const nullArray = arena.make('array'); nullArray.push('x'); arena.setPrototype(arena.owner(nullArray), null);
      cases.push({ content: nullArray });
      return arena.publish(cases);
    });
  } finally { arena.close(); }
  // The test publishes controlled immutable graph fixtures through the actual
  // store/plane. No product source, canonical root or runtime is mutated.
  const installed = f.plane.install({ root: lease, primaryPresentation: parent.primaryPresentation }, lease.cursor(), {
    consumerKey: f.consumerKey, ownerKey: parent.ownerKey, revision: parent.revision, source: parent.source, release: () => lease.release(),
  });
  const { HistoryRootClient } = await import(pathToFileURL(path.join(ROOT, 'src/shared/history-root-read-client.mjs')));
  const client = new HistoryRootClient(f.invoke, installed.descriptor);
  const node = index => f.plane.describe(installed.state, lease.cursor().at(index), { inline: false });
  for (const index of [0, 1, 2]) {
    const native = materializeHistoryCursorSync(lease.cursor().at(index)).content;
    let expected, error;
    try { expected = String(native || ''); } catch (caught) { error = caught; }
    const run = () => client.forkCanonicalConsumerValue(node(index), { field: 'content', operation: 'string-falsy' }).then(value);
    if (error) await assert.rejects(run()); else assert.equal(await run(), expected);
  }
  assert.equal(await value(await client.forkCanonicalConsumerValue(node(3), { field: 'sourceIdentityAliases', operation: 'kind' })), 'array');
  assert.equal(await value(await client.forkCanonicalConsumerValue(node(3), { field: 'sourceIdentityAliases', operation: 'array-length' })), '2');
  assert.equal(await value(await client.forkCanonicalConsumerValue(node(3), { field: 'sourceIdentityAliases', index: 0, operation: 'string-falsy' })), 'full\0\ud800 alias');
  await assert.rejects(client.forkCanonicalConsumerValue(node(3), { field: 'content', operation: 'array-length' }));
  // Characterize a pre-existing compatibility gap, NOT a differential pass:
  // the generic materializer ignores nullPrototype for arrays/Map/Set. This
  // internal-only fixture is built explicitly with arena.setPrototype (JSON
  // arrays and arena's native-array importer do not create that flag). Do not
  // repair the old whole-graph materializer as part of this selected slice.
  const legacyNullArray = materializeHistoryCursorSync(lease.cursor().at(4)).content;
  assert.equal(Object.getPrototypeOf(legacyNullArray), Array.prototype);
  const nativeNullArray = ['x']; Object.setPrototypeOf(nativeNullArray, null);
  assert.throws(() => String(nativeNullArray), TypeError);
  await assert.rejects(client.forkCanonicalConsumerValue(node(4), { field: 'content', operation: 'string-falsy' }));
  assert(f.errors.at(-1) instanceof TypeError, 'selected conversion preserves JS refusal; legacy discrepancy remains OPEN');
  await client.close(); await o.reader.close();
});
