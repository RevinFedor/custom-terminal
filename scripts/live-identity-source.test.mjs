// Finite actual-source control: parsed synthetic canonical rows, Node SQLite
// and in-process IPC replace native ingestion/Electron only. Real producer,
// shared client, renderer model and unmodified native reducer execute below.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/live-identity-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel, historyPrimaryToolClaimFingerprint, historyPrimaryLiveClaimFingerprint } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { historyLivePresentationIdentities, reconcileCommittedHistoryLiveProjection } from '../src/renderer/utils/historyLiveProjection.mjs';
import { readHistoryThroughIpc } from '../src/renderer/utils/historyReadTransport.mjs';
const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync: materialize } = require('../src/main/history-root-engine/main/history-paged-store.js');
assert(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite total V8 heap; use documented command');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const row = (uuid, extra = {}) => ({ uuid, role: 'assistant', sessionId: 's',
  timestamp: '2026-10-27T00:00:00.000Z', content: 'preserved body', ...extra });
const setting = (uuid, id, kind, value, extra = {}) => row(uuid, { role: 'slash', sourceIdentity: id,
  settingsFact: { version: 1, provider: 'codex', kind, value }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

async function setup(entries, { intercept = async () => undefined, inputs = {} } = {}) {
  const f = await createPrimaryAddressFixture(null, { entries });
  const calls = [];
  const invoke = async (channel, payload) => {
    let result = await intercept(channel, payload, f);
    if (result === undefined) result = channel === 'agent-transcript:cancel-read' ? { success: true } : await f.invoke(channel, payload);
    calls.push({ channel, kind: payload?.kind, scope: payload?.scope, operation: payload?.operation,
      field: payload?.field, offset: payload?.offset, limit: payload?.limit, nodeToken: payload?.nodeToken,
      leaseId: payload?.leaseId, resultLeaseId: result?.leaseId, count: result?.items?.length,
      requestBytes: Buffer.byteLength(JSON.stringify(payload)), resultBytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  };
  const model = new HistoryPrimaryRootReadModel(invoke, { ...f.transport, readHistoryThroughIpc });
  model.windowDiagnostic = () => {};
  const payload = { ...f.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
    grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] },
    captionSelections: [], settingsPresentationKeys: [], ...inputs } };
  try { await model.open(payload); } catch (error) { await model.close(); f.close(); throw error; }
  const canonical = materialize(f.plane.state(model.view.root, f.consumerKey).primaryPresentation.toolCoverageInputs().entries);
  const before = calls.length;
  const restore = [];
  for (const [owner, field] of [[model, 'metadata'], [model.view, 'metadata'], [model.view, 'serverMetadata']]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, field);
    restore.push(() => descriptor ? Object.defineProperty(owner, field, descriptor) : delete owner[field]);
    Object.defineProperty(owner, field, { configurable: true, get() { throw Error('MIGRATED_PATH_READ_N_METADATA'); } });
  }
  const unpoison = () => { while (restore.length) restore.pop()(); };
  const bounds = () => {
    for (const call of calls.slice(before)) {
      assert(call.requestBytes <= 65536 && call.resultBytes <= 65536);
      assert(call.count == null || call.count <= 3);
      if (call.kind === 'leaf') assert(call.limit <= 1024);
      if ([model.header.sourceMetadata.nodeToken, model.header.durableMetadata.nodeToken].includes(call.nodeToken)) {
        assert.equal(call.kind, 'primary-canonical-consumers', 'no generic metadata decoding in migrated path');
      }
    }
    assert.equal(model.window.size, 0); assert(f.store.stats().peakCachedPages <= 3);
  };
  return { f, model, payload, canonical, calls, before, bounds, unpoison,
    async close() { unpoison(); await model.close(); f.close(); } };
}

async function compare(x, claims) {
  const expected = reconcileCommittedHistoryLiveProjection(claims, x.canonical);
  const proof = await x.model.readLiveIdentityCoverage(claims);
  assert.equal(proof.header, x.model.header); assert.equal(proof.dataSubject, x.model.getReceiptDataSubject());
  assert.equal(proof.claims.length, claims.length);
  for (let index = 0; index < claims.length; index++) {
    const actual = proof.claims[index], entry = claims[index];
    assert.equal(actual.entry, entry); assert.equal(actual.fingerprint, historyPrimaryLiveClaimFingerprint(entry));
    assert.equal(actual.coveredIdentity, historyLivePresentationIdentities(entry).some(id => expected.durableIdentities.has(id)));
    assert.equal(!actual.coveredIdentity || actual.settingsConflict, expected.entries.includes(entry));
  }
  return proof;
}

test('full old identity grammar: prefixes, aliases, queue, coercions and no IDs; metadata reads throw', async () => {
  const cycle = ['tail']; cycle.push(cycle);
  const x = await setup([
    row('plain'), row('u', { role: 'user' }), row('slash', { role: 'slash', sessionId: 'sid' }),
    row('failure', { role: 'provider-error', sessionId: 7 }), row('limit', { role: 'usage-limit', sessionId: '' }),
    row('aliases', { sourceIdentity: ['main', 0], sourceIdentityAliases: [0, false, null, ' exact ', 42, {}, ['joined', 2], cycle],
      sourceUuidAliases: ['not-a-live-alias'] }),
    row('queue', { role: 'queued', sessionId: 'queue-s', timestamp: 'when', content: '  hello\r\n world  ' }),
  ]);
  try {
    const cases = [
      { sourceIdentity: 'plain' }, row('plain'), { sourceIdentity: 'assistant-uuid:plain' },
      { sourceIdentity: 'user-uuid:u' }, { sourceIdentity: 'slash-uuid:sid:slash' },
      { sourceIdentity: 'provider-error-uuid:7:failure' }, { sourceIdentity: 'usage-limit-uuid::limit' },
      { sourceIdentity: ' exact ' }, { sourceIdentity: 'exact' }, { sourceIdentity: 42 },
      { sourceIdentity: '[object Object]' }, { sourceIdentity: 'joined,2' }, { sourceIdentity: 'tail,' },
      { sourceIdentity: 'main,0' }, { sourceIdentity: 'not-a-live-alias' }, { content: 'no identity' },
      { sourceIdentityAliases: Array.from({ length: 40 }, (_, index) => index === 39 ? 'assistant-uuid:plain' : 'absent-' + index) },
      { sourceIdentity: historyLivePresentationIdentities(x.canonical.find(entry => entry.uuid === 'queue'))[0] },
    ];
    for (let offset = 0; offset < cases.length; offset += 3) await compare(x, cases.slice(offset, offset + 3));
    const explicit = await x.model.readLiveIdentityCoverage([{ sourceIdentity: 'plain' }, row('plain'), { sourceIdentity: 'not-a-live-alias' }]);
    assert.deepEqual(explicit.claims.map(item => item.coveredIdentity), [false, true, false]);
    assert(x.calls.slice(x.before).some(call => call.operation === 'queue-identity'));
    x.bounds();
  } finally { await x.close(); }
});

test('settings last fact per identity, strict sessions, conflicts and plain unmatched remain distinct', async () => {
  const x = await setup([
    setting('a1', 'shared', 'model', 'wrong'),
    setting('a2', 'shared', 'model', 'foreign', { sessionId: 'other' }),
    setting('b1', 'conflict', 'effort', 'high'),
    setting('b2', 'clean', 'model', 'wanted'),
    setting('c1', 'numeric', 'model', 'wrong', { sessionId: 7 }),
    setting('d1', 'null', 'model', 'wrong', { sessionId: null }),
    setting('e1', 'undefined', 'model', 'wrong', { sessionId: undefined }),
    setting('f1', 'kind-change', 'effort', 'wanted'),
    setting('g1', 'last-valid', 'model', 'wrong'),
    setting('g2', 'last-valid', 'model', '', { settingsFact: { version: 1, provider: 'codex', kind: 'model', value: '' } }),
    setting('h1', 'nan-session', 'model', 'wrong', { sessionId: NaN }),
    setting('h2', 'zero-session', 'model', 'wrong', { sessionId: -0 }),
    setting('h3', 'container-session', 'model', 'wrong'),
  ]);
  try {
    const cases = [
      setting('live-a', 'shared', 'model', 'wanted'),
      setting('live-b', 'clean', 'model', 'wanted', { sourceIdentityAliases: ['conflict'] }),
      setting('live-c', 'numeric', 'model', 'wanted', { sessionId: '7' }),
      setting('live-d', 'numeric', 'model', 'wanted', { sessionId: 7 }),
      setting('live-e', 'null', 'model', 'wanted', { sessionId: undefined }),
      setting('live-f', 'undefined', 'model', 'wanted', { sessionId: undefined }),
      setting('live-g', 'kind-change', 'model', 'wanted'),
      setting('live-h', 'last-valid', 'model', 'wanted'),
      setting('', '', 'model', 'wanted'),
      setting('live-i', 'nan-session', 'model', 'wanted', { sessionId: 0 }),
      setting('live-j', 'zero-session', 'model', 'wanted', { sessionId: -0 }),
      setting('live-k', 'container-session', 'model', 'wanted', { sessionId: {} }),
      setting('live-l', 'nan-session', 'model', 'wanted', { sessionId: NaN }),
    ];
    for (let offset = 0; offset < cases.length; offset += 3) await compare(x, cases.slice(offset, offset + 3));
    const proof = await compare(x, cases.slice(0, 3));
    assert.deepEqual(proof.claims.map(item => [item.coveredIdentity, item.settingsConflict]), [[true, false], [true, true], [true, false]]);
    assert.equal(proof.claims.some(item => !item.coveredIdentity), false, 'plain unmatched ignores the retained conflicting settings row');
    x.bounds();
  } finally { await x.close(); }
});

test('existing canonical container-session preparation refusal remains explicit before any live proof', async () => {
  await assert.rejects(setup([setting('container', 'same', 'model', 'wrong', { sessionId: {} })]), /history_cursor_not_scalar/);
});

test('full escaped UTF16 and later settings override use signed chunks, never previews', async () => {
  const id = 'start\0\ud800😀\\\"' + 'Ω\udc00'.repeat(2700) + 'EXACT-END';
  const value = 'model-\0\ud800😀' + '\\"ω'.repeat(1900);
  const x = await setup([setting('early', id, 'model', 'wrong'), setting('last', id, 'model', value)]);
  try {
    const proof = await compare(x, [setting('live', id, 'model', value), { sourceIdentity: id.slice(0, -1) + 'x' }]);
    assert.deepEqual(proof.claims.map(item => [item.coveredIdentity, item.settingsConflict]), [[true, false], [false, false]]);
    assert(x.calls.slice(x.before).some(call => call.kind === 'leaf' && call.offset >= 4096));
    assert(x.calls.slice(x.before).some(call => call.operation === 'live-setting-value'));
    x.bounds();
  } finally { await x.close(); }
});

test('later durable alias coercion error defeats earlier positive coverage', async () => {
  const x = await setup([row('first', { sourceIdentity: 'already-covered' }),
    row('last', { sourceIdentityAliases: [{ toString: undefined }] })]);
  try {
    for (const claims of [[{ sourceIdentity: 'already-covered' }], [setting('live', 'already-covered', 'model', 'wanted')]]) {
      assert.throws(() => reconcileCommittedHistoryLiveProjection(claims, x.canonical), TypeError);
      await assert.rejects(x.model.readLiveIdentityCoverage(claims));
    }
    assert(x.f.errors.some(error => error instanceof TypeError && error.message === 'Cannot convert object to primitive value'));
    x.bounds();
  } finally { await x.close(); }
});

test('zero canonical proof is dedicated; generic empty success, UNKNOWN and >3 never become coverage', async () => {
  let mode = '';
  const x = await setup([], { inputs: { liveEntries: [row('prepared-only', { sourceIdentity: 'prepared' })] },
    intercept: async (channel, payload, f) => {
      if (payload?.kind !== 'primary-canonical-consumers') return;
      if (mode === 'unknown') return { success: false, error: 'UNKNOWN_SOURCE' };
      if (mode === 'empty') { const page = await f.invoke(channel, payload); delete page.profile; return page; }
    } });
  try {
    assert.equal((await compare(x, [{ sourceIdentity: 'prepared' }])).claims[0].coveredIdentity, false);
    await assert.rejects(x.model.readLiveIdentityCoverage([{}, {}, {}, {}]), /HISTORY_PRIMARY_LIVE_CLAIMS_LIMIT/);
    await assert.rejects(x.model.readLiveIdentityCoverage([{}], { owns: () => Promise.resolve(true) }), /HISTORY_READ_CANCELLED/);
    mode = 'unknown'; const before = x.calls.length;
    await assert.rejects(x.model.readLiveIdentityCoverage([{}]), /UNKNOWN_SOURCE/);
    await tick(); assert.equal(x.calls.length, before + 1, 'query UNKNOWN has no retry or wake');
    mode = 'empty'; await assert.rejects(x.model.readLiveIdentityCoverage([{}]));
    x.bounds();
  } finally { await x.close(); }
});

test('in-place aliases, cyclic claim changes, array replacement and owner loss discard late proofs', async () => {
  let hold = null;
  const x = await setup([row('canonical', { sourceIdentity: 'match' })], { intercept: async (channel, payload, f) => {
    if (hold && payload?.kind === 'primary-canonical-consumers') { const current = hold; hold = null;
      const result = await f.invoke(channel, payload); current.entered.resolve(); await current.release.promise; return result; }
  } });
  try {
    for (const mode of ['alias', 'cycle', 'array', 'owner', 'ABA']) {
      const entry = { sourceIdentityAliases: ['match'] }; entry.self = entry;
      const claims = [entry]; let owned = true, revision = 1; const admissionRevision = revision;
      hold = { entered: deferred(), release: deferred() }; const pending = hold;
      const result = x.model.readLiveIdentityCoverage(claims, { owns: () => owned && revision === admissionRevision });
      await pending.entered.promise;
      if (mode === 'alias') entry.sourceIdentityAliases[0] = 'changed';
      if (mode === 'cycle') entry.self = { sourceIdentity: 'new cyclic owner' };
      if (mode === 'array') claims[0] = { sourceIdentity: 'replacement' };
      if (mode === 'owner') owned = false;
      if (mode === 'ABA') { entry.sourceIdentityAliases[0] = 'other'; revision++;
        entry.sourceIdentityAliases[0] = 'match'; revision++; }
      pending.release.resolve(); await assert.rejects(result, /HISTORY_READ_CANCELLED/);
    }
    const current = { sourceIdentity: 'match' }; current.self = current;
    assert.equal((await compare(x, [current])).claims[0].coveredIdentity, true);
    x.bounds();
  } finally { await x.close(); }
});

test('current query header/sequence is stricter than checked reusable data subject; changed cuts discard old proof', async () => {
  let hold = null;
  const x = await setup([row('canonical', { sourceIdentity: 'match' })], { intercept: async (channel, payload, f) => {
    if (hold && payload?.kind === 'primary-canonical-consumers') { const current = hold; hold = null;
      const result = await f.invoke(channel, payload); current.entered.resolve(); await current.release.promise; return result; }
  } });
  try {
    const initial = await x.model.readLiveIdentityCoverage([{ sourceIdentity: 'match' }]);
    x.unpoison();
    const wakes = [], metadata = []; const off = x.model.onReceiptReadWake(event => wakes.push(event));
    const offMetadata = x.model.onMetadata(() => metadata.push(x.model.header));
    try {
      hold = { entered: deferred(), release: deferred() }; let pending = hold;
      const old = x.model.readLiveIdentityCoverage([{ sourceIdentity: 'match' }]);
      await pending.entered.promise;
      await x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: {
        grouping: { ...x.payload.primaryPresentation.grouping, enabled: true }, captionSelections: [] } });
      pending.release.resolve(); await assert.rejects(old, /HISTORY_READ_CANCELLED/);
      assert.notEqual(x.model.header, initial.header);
      assert.equal(x.model.getReceiptDataSubject(), initial.dataSubject, 'checked view reuse keeps same canonical cut without a Panel render');
      assert.equal((await x.model.readLiveIdentityCoverage([{ sourceIdentity: 'match' }])).claims[0].coveredIdentity, true);
      assert.equal(wakes.length, 1); assert.equal(metadata.length, 1);
      x.model.notify(); await tick(); assert.equal(wakes.length, 1, 'body traffic is not a read wake');
      hold = { entered: deferred(), release: deferred() }; pending = hold;
      const obsolete = x.model.readLiveIdentityCoverage([{ sourceIdentity: 'match' }]);
      await pending.entered.promise;
      x.f.setEntries([row('replacement', { sourceIdentity: 'new-cut' })]);
      await x.model.open({ ...x.payload, primaryRequestClass: 'source' });
      pending.release.resolve(); await assert.rejects(obsolete, /HISTORY_READ_CANCELLED/);
      assert.notEqual(x.model.getReceiptDataSubject(), initial.dataSubject);
      const next = await x.model.readLiveIdentityCoverage([{ sourceIdentity: 'match' }, { sourceIdentity: 'new-cut' }]);
      assert.deepEqual(next.claims.map(item => item.coveredIdentity), [false, true]);
      assert.equal(wakes.length, 2); assert.equal(metadata.length, 2);
    } finally { off(); offMetadata(); }
  } finally { await x.close(); }
});

test('fresh live semantic witness rejects inherited aliases, coercion changes and nonenumerable fields missed by the tool witness', async () => {
  let hold = null;
  const x = await setup([row('canonical', { sourceIdentity: 'match' }), setting('fact', 'setting', 'model', 'wanted')],
    { intercept: async (channel, payload, f) => {
      if (hold && payload?.kind === 'primary-canonical-consumers') { const current = hold; hold = null;
        const result = await f.invoke(channel, payload); current.entered.resolve(); await current.release.promise; return result; }
    } });
  try {
    for (const mode of ['inherited-alias', 'inherited-coercion', 'nonenumerable-identity', 'nonenumerable-setting']) {
      let entry, change;
      if (mode === 'inherited-alias') {
        const aliases = new Array(1), prototype = ['match']; Object.setPrototypeOf(aliases, prototype);
        entry = { sourceIdentityAliases: aliases }; change = () => { prototype[0] = 'changed'; };
      } else if (mode === 'inherited-coercion') {
        let identity = 'match'; const value = [], prototype = Object.create(Array.prototype);
        prototype.join = () => identity; Object.setPrototypeOf(value, prototype);
        entry = { sourceIdentity: value }; change = () => { identity = 'changed'; };
      } else if (mode === 'nonenumerable-identity') {
        entry = {}; Object.defineProperty(entry, 'sourceIdentity', { value: 'match', writable: true });
        change = () => { entry.sourceIdentity = 'changed'; };
      } else {
        entry = setting('live', 'setting', 'model', 'wanted');
        Object.defineProperty(entry.settingsFact, 'value', { value: 'wanted', writable: true, enumerable: false });
        change = () => { entry.settingsFact.value = 'changed'; };
      }
      const oldToolWitness = historyPrimaryToolClaimFingerprint(entry), liveWitness = historyPrimaryLiveClaimFingerprint(entry);
      hold = { entered: deferred(), release: deferred() }; const pending = hold;
      const proof = x.model.readLiveIdentityCoverage([entry]); await pending.entered.promise;
      change(); assert.equal(historyPrimaryToolClaimFingerprint(entry), oldToolWitness, 'actual old witness counterexample: ' + mode);
      assert.notEqual(historyPrimaryLiveClaimFingerprint(entry), liveWitness, 'native semantic replay witnesses the change: ' + mode);
      pending.release.resolve(); await assert.rejects(proof, /HISTORY_READ_CANCELLED/);
    }
    x.bounds();
  } finally { await x.close(); }
});

test('cancelled late child lease closes exactly once while parent and independent old child remain usable', async () => {
  let hold = null;
  const x = await setup([row('canonical', { sourceIdentity: 'match' })], { intercept: async (channel, payload, f) => {
    if (hold && channel === 'agent-transcript:fork-read-leaf' && payload?.operation === 'string-falsy') {
      const current = hold; hold = null; const result = await f.invoke(channel, payload);
      current.result = result; current.entered.resolve(); await current.release.promise; return result;
    }
  } });
  try {
    const page = await x.model.view.reader.primaryCanonicalConsumers(x.model.header.durableMetadata,
      { header: x.model.header, scope: 'canonical', offset: 0, limit: 1 });
    const old = await x.model.view.reader.forkCanonicalConsumerValue(page.items[0].row, { field: 'content', operation: 'string-falsy' });
    const parent = x.model.view.root.leaseId, oldLease = old.reader.identity.leaseId;
    const controller = new AbortController(); hold = { entered: deferred(), release: deferred() }; const pending = hold;
    const result = x.model.readLiveIdentityCoverage([{ sourceIdentity: 'match' }], { signal: controller.signal });
    await pending.entered.promise; controller.abort(); await assert.rejects(result, /History read consumer released|HISTORY_READ_CANCELLED/);
    pending.release.resolve(); await tick();
    const late = pending.result.leaseId;
    assert.notEqual(late, parent); assert.notEqual(late, oldLease);
    assert.equal(x.calls.filter(call => call.channel === 'agent-transcript:release-read-root' && call.leaseId === late).length, 1);
    assert.equal(x.calls.filter(call => call.channel === 'agent-transcript:release-read-root' && [parent, oldLease].includes(call.leaseId)).length, 0);
    assert.equal((await old.read(0, 1024)).text, 'preserved body');
    await old.close(); assert.equal((await compare(x, [{ sourceIdentity: 'match' }])).claims[0].coveredIdentity, true);
    x.bounds();
  } finally { await x.close(); }
});
