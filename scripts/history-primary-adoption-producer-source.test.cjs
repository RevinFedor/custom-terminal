'use strict';

// SOURCE only. Real frozen producer, page store, selected-value read plane
// and native CURRENT predicates. Parsed synthetic rows, temporary Node SQLite
// and in-process IPC are the declared boundaries; no app/provider/native run.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-adoption-producer-source.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getHeapStatistics } = require('node:v8');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const MAIN = path.resolve(__dirname, '../src/main/history-root-engine/main');
const local = require(path.join(MAIN, 'history-primary-compat/src/renderer/utils/primaryLocalCompat.ts.cjs'));
const image = require(path.join(MAIN, 'history-primary-compat/src/shared/prompt-image-attachments.mjs.cjs'));
const { materializeHistoryCursorSync: materialize } = require(path.join(MAIN, 'history-paged-store'));
const { primaryTimeWindow, checkPrimaryTime } = require(path.join(MAIN, 'history-primary-dependencies'));
const generator = require('./generate-history-primary-local-compat.cjs');
assert(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite heap required');
console.log('ADOPTION_PRODUCER_SOURCE_CERTIFICATE ' + JSON.stringify({ node: process.version,
  heapLimit: getHeapStatistics().heap_size_limit, electron: process.versions.electron || null,
  boundaries: ['synthetic parsed canonical input', 'temporary Node SQLite adapter', 'in-process IPC', 'supplementary synthetic text cursor'] }));
const row = (content, extra = {}) => ({ uuid: 'durable', role: 'assistant', content,
  timestamp: '2026-10-27T00:00:00.000Z', sessionId: 's', ...extra });
const pending = (extra = {}) => ({ uuid: 'local-prompt-one', role: 'queued', content: 'local',
  timestamp: '2026-10-27T00:00:00.000Z', optimisticAt: 1, statusChangedAt: 1,
  queueStatus: 'failed', ...extra });
const normalize = value => image.normalizePromptImageIdentity(String(value || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '').replace(/~\]/g, '').trim());

async function selected(f, root, ordinal, request = {}, control) {
  const state = f.plane.state(root, f.consumerKey), source = state.primaryPresentation.toolCoverageInputs().entries.at(ordinal);
  const before = f.store.stats().leases;
  const response = await f.plane.forkCanonicalConsumerValue({ ...f.plane.identity(state),
    nodeToken: f.plane.nodeToken(state, source), encoding: 'history-canonical-consumer-text-v1',
    operation: 'prompt-identity', field: 'content', ...request }, { consumerKey: f.consumerKey, control });
  assert.notEqual(response.leaseId, root.leaseId, 'independent child lease');
  try {
    const child = f.plane.state(response, f.consumerKey);
    return materialize(f.plane.cursor(child, response.payloadDocument.nodeToken));
  } finally {
    f.plane.release(response, { consumerKey: f.consumerKey });
    assert.equal(f.store.stats().leases, before, 'selected value releases exactly once');
  }
}

// Canonical literal reducers can produce inherited data through their real
// arena prototype API; the fixture's ordinary JS importer deliberately refuses
// arbitrary native prototypes. Construct that source through the actual arena.
function replaceFrozenSource(f, mutate) {
  const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
  const { forkFrozenCanonical } = require(path.join(MAIN, 'history-frozen-canonical'));
  const arena = new HistoryProjectionArena(f.store, f.source.root); let root, frozen;
  try {
    root = arena.step(() => { const rows = arena.state(); mutate(arena, rows); return arena.publish(rows); });
    frozen = forkFrozenCanonical(f.store, { ...f.source, root, entries: root.cursor() });
    f.plane.projectHistory = async () => forkFrozenCanonical(f.store, frozen);
    return () => frozen.release();
  } finally { root?.release(); arena.close(); }
}

test('CURRENT extraction, compiled dependency grammar and manifest regenerate exactly', () => {
  generator.check();
  assert.equal(typeof local.historyPromptFailureHasRecoveryOwner, 'function');
  assert.equal(image.normalizePromptImageIdentity('[image](https://example.test/a) [Image #5]'),
    '[image](https://example.test/a) [Image]');
});

test('recovery-owned failed/cancelled cards retain CURRENT TTL and reusable clock policy', () => {
  const retained = [pending({ applicationQueueId: 7 }), pending({ queueStatus: 'cancelled', statusReason: 'history-preparation-interrupted' })];
  for (const entry of retained) {
    assert.deepEqual(local.mergeServerAndLocalEntries([], [entry]), [entry]);
    assert.equal(primaryTimeWindow([entry], 20000, 20000).notAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(checkPrimaryTime(primaryTimeWindow([entry], 20000, 20000), 99999).ok, true);
  }
  for (const value of [undefined, null, 0, -1, '7', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const entry = pending({ applicationQueueId: value });
    assert.deepEqual(local.mergeServerAndLocalEntries([], [entry]), []);
    assert.equal(primaryTimeWindow([entry], 1, 1).notAfter, 15001);
  }
  assert.equal(checkPrimaryTime(primaryTimeWindow([pending()], 1, 1), 15001).reason, 'local-ttl-boundary');
  assert.equal(primaryTimeWindow([pending({ statusChangedAt: 0, optimisticAt: 0, timestamp: 'invalid' })], 1, 1).known, false);
});

test('actual producer keeps recovery-owned rows and decorates every duplicate UUID missing from chosen match', async t => {
  const captured = pending({ queueStatus: 'sent', auditEntryUuid: 'same', content: 'local',
    promptChips: [{ id: 'chip', kind: 'text', text: 'author' }], imagePaths: [{ id: 1, path: '/synthetic/image.png' }] });
  const recovery = pending({ uuid: 'local-prompt-recovery', applicationQueueId: 7 });
  const f = await createPrimaryAddressFixture(t, { entries: [row('same', { uuid: 'same', role: 'user' }),
    row('duplicate', { uuid: 'same', role: 'user' })] });
  const opened = await f.open({ localEntries: [captured, recovery] });
  assert.equal(opened.kind, 'root');
  const state = f.plane.state(opened.root, f.consumerKey);
  const entries = materialize(state.primaryPresentation.presentationSource());
  const adopted = entries.filter(entry => entry.uuid === 'same');
  assert.equal(adopted.length, 2);
  for (const entry of adopted) { assert.deepEqual(entry.promptChips, captured.promptChips); assert.deepEqual(entry.imagePaths, captured.imagePaths); }
  assert.equal(entries.some(entry => entry.uuid === captured.uuid), false);
  assert.equal(entries.some(entry => entry.uuid === recovery.uuid), true);
  await opened.reader.close();
});

test('exact native grammar differential: deterministic mixtures and URL-cap boundaries (synthetic text cursor only)', async () => {
  const { normalizePrimaryPromptIdentity } = require(path.join(MAIN, 'history-primary-prompt-normalize'));
  // This extra differential test deliberately substitutes only text paging;
  // the real SQLite/read-plane/lease tests below carry the producer claims.
  async function run(text) {
    let next = 0; const strings = new Map();
    const save = value => { const ref = { id: ++next }; strings.set(ref.id, value); return ref; };
    const pieces = async function* (ref, from = 0, to = strings.get(ref.id).length) {
      for (let at = from; at < to; at += 128) yield strings.get(ref.id).slice(at, Math.min(to, at + 128));
    };
    const write = async input => { let value = ''; for await (const part of input) value += part; return save(value); };
    const result = await normalizePrimaryPromptIdentity({ ref: save(text),
      store: { json: id => ({ totalChars: strings.get(id).length }) },
      reader: ref => ({ length: strings.get(ref.id).length, at: index => strings.get(ref.id)[index] }),
      pieces, write, step: async () => {}, find: async (ref, needle, from) => strings.get(ref.id).indexOf(needle, from),
      replace: async (ref, needle) => save(strings.get(ref.id).split(needle).join('')) });
    return strings.get(result.id);
  }
  let seed = 4;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const atoms = ['[imagePath:', '[imageError:', '[Image', '[image](', '![', ']', 'https://', 'http://', '<', '>',
    '\\', '[200~', '~]', '<system-reminder>', '</system-reminder>', 'a', ' ', '\n', '\r', '\t', '#1', '"', "'", ')', '('];
  for (let index = 0; index < 3000; index++) {
    let text = '';
    for (let at = 0; at < 1 + random() % 30; at++) text += atoms[random() % atoms.length];
    assert.equal(await run(text), normalize(text), JSON.stringify(text));
  }
  for (const length of [8170, 8171, 8180, 8181, 8182, 8183, 8184, 8190, 8191, 8192, 8193]) for (const angle of [true, false]) {
    const text = '![ [Image #3] ](' + (angle ? '<' : '') + 'https://a/' + 'q'.repeat(length) + (angle ? '>' : '') + ')';
    assert.equal(await run(text), normalize(text), 'URL boundary ' + length + '/' + angle);
  }
});

test('paged prompt identity equals CURRENT full grammar across markers, escaped web references and long UTF16', async t => {
  const inputs = [
    '', 'hello', '[Image]', '[imagePath: x]', '[imageError:x]', '[imagePath: ]',
    '[imagePath: \r\n]', '[imagePath: \r\nX\r\n]', '[Image #123]', '[Image 123]', '[Image\n#123]',
    '[Image#1]', '[Image #1 ]', '[image](https://example.test)', '![a [Image #1](x)](https://example.test)',
    '![Image](https://example.test/(x))', '[image](<https://example.test>)', '![a](https://example.test "title")',
    '![a](https://example.test\\)b)', '\\[image](https://example.test)', '\\![a](https://example.test)',
    '![a](https://a'.padEnd(8205, 'x') + ')', '<system-reminder>x</system-reminder> [200~[imagePath:x]~]',
    '[imageError:[imagePath:x]]', '[imagePath:\nA\nB]', '[imagePath:\nA\n ]',
    'x ![a](https://example.test \'ti\\\'tle\') y',
    'x'.repeat(1023) + '[imagePath:' + 'p'.repeat(65536) + ']\ud800\udfff\ud800 tail',
    '![' + 'a'.repeat(17000) + '](https://example.test) [Image #8]',
  ];
  const f = await createPrimaryAddressFixture(t, { entries: inputs.map((value, index) => row(value, { uuid: 'case-' + index })) });
  const opened = await f.open();
  for (let index = 0; index < inputs.length; index++) assert.equal(await selected(f, opened.root, index), normalize(inputs[index]), 'grammar case ' + index);
  assert(f.plane.metrics.canonicalValueCheckpoints > 0, 'long scalar normalization cooperatively yields');
  assert(f.plane.metrics.maxReturnedItems <= 3);
  await opened.reader.close();
});

test('frozen String coercion preserves arrays, inherited data, cyclic joins and native TypeError', async t => {
  const cyclic = ['a']; cyclic.push(cyclic, 'b');
  const inherited = Object.create({ content: ['x', ['y', null], 0] });
  Object.assign(inherited, { uuid: 'inherited', role: 'assistant', timestamp: '', sessionId: 's' });
  const values = [0, false, null, undefined, 4n, ['a', undefined, ['b', 'c']], cyclic, { x: 'value' }, Object.create(null)];
  const f = await createPrimaryAddressFixture(null, { entries: [...values.map((content, index) => row(content, { uuid: 'value-' + index })), row(undefined, { uuid: 'inherited' })] });
  const release = replaceFrozenSource(f, (arena, rows) => { delete rows[values.length].content;
    Object.setPrototypeOf(rows[values.length], arena.own({ content: inherited.content })); });
  t.after(() => { release(); f.close(); });
  const opened = await f.open();
  for (let index = 0; index < values.length - 1; index++) assert.equal(await selected(f, opened.root, index), normalize(values[index]));
  await assert.rejects(selected(f, opened.root, values.length - 1), TypeError);
  assert.equal(await selected(f, opened.root, values.length), normalize(inherited.content));
  await opened.reader.close();
});

test('typed semanticTags selectors preserve inherited member lookup and reject unrelated field/index grammar', async t => {
  const tag = Object.create({ kind: 'orchestration', runId: ' run\ud800', phase: 'completion' });
  const f = await createPrimaryAddressFixture(null, { entries: [row('body', { semanticTags: [{}, null, 3, { kind: 1 }] })] });
  const release = replaceFrozenSource(f, (arena, rows) => Object.setPrototypeOf(rows[0].semanticTags[0],
    arena.own({ kind: tag.kind, runId: tag.runId, phase: tag.phase })));
  t.after(() => { release(); f.close(); });
  const opened = await f.open();
  const request = { operation: 'string-falsy', field: 'semanticTags', index: 0, memberField: 'runId' };
  assert.equal(await selected(f, opened.root, 0, request), ' run\ud800');
  assert.equal(await selected(f, opened.root, 0, { ...request, operation: 'kind', index: 1, memberField: 'kind' }), 'undefined');
  assert.equal(await selected(f, opened.root, 0, { ...request, operation: 'kind', index: 3, memberField: 'kind' }), 'number');
  for (const bad of [{ memberField: 'unknown' }, { field: 'content' }, { index: undefined }])
    await assert.rejects(selected(f, opened.root, 0, { ...request, ...bad }), /HISTORY_PRIMARY_CANONICAL_VALUE_QUERY/);
  await opened.reader.close();
});

test('selected identity graph retains full aliases, holes, prototypes, cross references and original-row projection cycles', async t => {
  const aliases = []; aliases.length = 4; aliases[1] = undefined;
  const object = { back: aliases }; aliases[2] = object; aliases[3] = ' alias\ud800' + 'q'.repeat(5000);
  const entry = row(Object.create(null), { sourceIdentity: 'source', sourceIdentityAliases: aliases,
    sourceUuidAliases: aliases, promptChips: { length: '0' }, imagePaths: 'image-array-like' });
  object.row = entry; object.map = new Map([[aliases, new Set([aliases])]]);
  const f = await createPrimaryAddressFixture(null, { entries: [entry] });
  const release = replaceFrozenSource(f, (arena, rows) => Object.setPrototypeOf(rows[0].sourceIdentityAliases[2],
    arena.own({ inherited: 'prototype field' })));
  t.after(() => { release(); f.close(); });
  const opened = await f.open();
  const packet = JSON.parse(await selected(f, opened.root, 0, { operation: 'prompt-selected-identity', field: undefined }));
  assert.equal(packet.version, 'primary-prompt-selected-identity-v1'); assert.equal(packet.root, 0);
  const fields = new Map(packet.nodes[0].properties);
  assert.deepEqual([...fields.keys()], ['uuid', 'sessionId', 'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases', 'hasPromptChips', 'hasImagePaths']);
  assert.deepEqual(fields.get('uuid'), ['string', 'durable']);
  assert.deepEqual(fields.get('hasPromptChips'), ['boolean', true], 'native truth of object.length');
  assert.deepEqual(fields.get('hasImagePaths'), ['boolean', true], 'native optional string.length');
  const aliasRef = fields.get('sourceIdentityAliases');
  assert.deepEqual(aliasRef, fields.get('sourceUuidAliases'), 'cross-property shared identity');
  const array = packet.nodes[aliasRef[1]];
  assert.equal(array.kind, 'array'); assert.equal(array.length, 4);
  assert.equal(await selected(f, opened.root, 0, { operation: 'graph-identity', field: 'sourceIdentityAliases' }), array.identity);
  assert.equal(await selected(f, opened.root, 0, { operation: 'graph-identity', field: 'uuid' }), '');
  assert.equal(typeof packet.nodes[0].identity, 'string');
  const properties = new Map(array.properties);
  assert.equal(properties.has('0'), false, 'sparse hole stays absent');
  assert.deepEqual(properties.get('1'), ['undefined'], 'own undefined is not a hole');
  assert.deepEqual(properties.get('3'), ['string', aliases[3]], 'full untrimmed UTF16 alias');
  const selectedObject = packet.nodes[properties.get('2')[1]], objectFields = new Map(selectedObject.properties);
  assert.deepEqual(objectFields.get('back'), aliasRef);
  assert.deepEqual(objectFields.get('row'), ['ref', 0], 'back-reference resolves the five-field projection, not full row content');
  const prototype = packet.nodes[selectedObject.prototype[1]];
  assert.deepEqual(new Map(prototype.properties).get('inherited'), ['string', 'prototype field']);
  const map = packet.nodes[objectFields.get('map')[1]];
  assert.equal(map.kind, 'map'); assert.deepEqual(map.entries[0][0], aliasRef);
  const set = packet.nodes[map.entries[0][1][1]];
  assert.equal(set.kind, 'set'); assert.deepEqual(set.entries, [aliasRef]);
  await assert.rejects(selected(f, opened.root, 0, { operation: 'prompt-selected-identity' }), /HISTORY_PRIMARY_CANONICAL_VALUE_QUERY/);
  await opened.reader.close();
});

test('historical Array.some keeps native own/inherited/null-prototype noncallable refusal even when empty', async t => {
  const own = []; own.some = undefined;
  const inherited = [], nulled = [];
  const f = await createPrimaryAddressFixture(null, { entries: [row('', { sourceIdentityAliases: [] }),
    row('', { sourceIdentityAliases: own }), row('', { sourceIdentityAliases: inherited }), row('', { sourceIdentityAliases: nulled })] });
  const release = replaceFrozenSource(f, (arena, rows) => {
    Object.setPrototypeOf(rows[2].sourceIdentityAliases, arena.own({ some: null }));
    Object.setPrototypeOf(rows[3].sourceIdentityAliases, null);
  });
  t.after(() => { release(); f.close(); });
  const opened = await f.open(), request = { operation: 'array-some-check', field: 'sourceIdentityAliases' };
  assert.equal(await selected(f, opened.root, 0, request), 'true');
  for (const index of [1, 2, 3]) await assert.rejects(selected(f, opened.root, index, request), TypeError);
  await opened.reader.close();
});

test('cancelled paged normalization keeps parent live and does not leak child or active builder', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [row('[imagePath:' + 'x'.repeat(16384) + ']')] });
  const opened = await f.open();
  const before = f.store.stats().leases; let checkpoints = 0, cancelled = false;
  const control = { assertCurrent() { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'HISTORY_READ_CANCELLED' }); },
    async checkpoint() { if (++checkpoints === 2) cancelled = true; } };
  await assert.rejects(selected(f, opened.root, 0, {}, control), { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(f.store.stats().leases, before); assert.equal(f.store.stats().activeBuilders, 0);
  assert.equal(await selected(f, opened.root, 0), '[Image]');
  await opened.reader.close();
});
