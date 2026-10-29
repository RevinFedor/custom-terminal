// V52 finite SOURCE integration: actual shared client, producer/read plane,
// prepared owner and Root model; parsed synthetic rows, private Node SQLite
// and in-process IPC are the only transport/source substitutions. No mounted
// Panel, native ingestion, provider, paint/input or Np-retirement claim.
// node --max-old-space-size=64 --max-semi-space-size=2 --test --test-reporter=tap --test-isolation=none scripts/history-primary-prepared-model-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryRootClient, checkedHistoryPrimaryPreparedPresentation } from '../src/shared/history-root-read-client.mjs';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { withHistoryPrimaryCanonicalConsumer as withConsumer,
  selectHistoryPrimaryCanonicalValue as selected } from '../src/renderer/utils/historyPrimaryCanonicalConsumers.mjs';

const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { historyPagedCursorAddress } = require('../src/main/history-root-engine/main/history-paged-store.js');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
assert(getHeapStatistics().heap_size_limit <= 96 * 1024 ** 2, 'bounded source process required');
const ENCODING = 'history-primary-prepared-presentation-v1';
const CANONICAL = 'primary-canonical-metadata';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const row = (uuid, extra = {}) => ({ uuid, role: 'user', content: 'body ' + uuid, sessionId: 's',
  timestamp: '2026-10-27T00:00:00.000Z', ...extra });
const presentation = () => ({ localEntries: [], liveEntries: [], liveToolResults: [],
  grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] },
  captionSelections: [], settingsPresentationKeys: [] });
const isPreparedFork = (channel, payload) => channel.endsWith('fork-read-leaf') && payload.encoding === ENCODING;
const isRelease = channel => channel.endsWith('release-read-root');

async function rig(t, entries = [row('one')], options = {}) {
  const fixture = await createPrimaryAddressFixture(null, { entries });
  let intercept;
  const calls = [], resources = [];
  const invoke = async (channel, payload) => {
    if (channel.endsWith('cancel-read')) return { success: true };
    const call = { channel, payload }; calls.push(call);
    const forward = () => fixture.invoke(channel, payload);
    try { return call.response = intercept ? await intercept(channel, payload, forward) : await forward(); }
    catch (error) { call.error = error; throw error; }
  };
  const model = new HistoryPrimaryRootReadModel(invoke, fixture.transport);
  model.windowDiagnostic = () => {};
  const payload = { ...fixture.payload, primaryPresentation: presentation(), ...options.payload };
  t.after(async () => {
    await model.close();
    for (const resource of resources.reverse()) {
      try { await resource.close(); } catch { /* expected UNKNOWN is asserted at its initiating test */ }
    }
    fixture.close();
  });
  return { fixture, invoke, model, payload, calls,
    keep(resource) { resources.push(resource); return resource; },
    setIntercept(value) { intercept = value; },
    open(opts) { return model.open(payload, opts); },
    view(opts) { return model.open({ ...payload, primaryRequestClass: 'view',
      primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } }, opts); },
    async client() {
      const opened = await fixture.transport.openHistoryRootThroughIpc(invoke, 'agent-transcript:get-history', payload,
        { pageBytes: 65536, pageItems: 3 });
      assert.equal(opened.kind, 'root'); resources.push(opened.reader); return opened;
    },
  };
}

async function selectedBody(held, uuid, options = {}) {
  return withConsumer(held.model, held.view, options, async context => {
    const found = await context.find('prepared', node => context.equals(selected(node, 'uuid'), uuid));
    assert(found, 'original prepared row selected through actual consumer protocol');
    return context.withText(selected(found.row, 'content'), async document => {
      let value = ''; await context.scanText(document, part => { value += part; }); return value;
    });
  });
}

test('actual model retains a branded independent prepared owner before adoption and reads its full selected values after model close', async t => {
  const proof = { text: 'proof\0\ud800😀'.repeat(150), missing: undefined };
  proof.self = proof;
  const body = 'body\0\ud800😀'.repeat(500), x = await rig(t, [row('one', { content: body,
    questionReplyProof: { left: proof, right: proof } })]);
  let beforeAdoptChild;
  await x.open({ prepareAdopt: async candidate => {
    assert.equal(candidate.metadata.entries.length, 1);
    assert.equal(x.fixture.plane.roots.size, 2, 'original Root and independent child exist before handoff');
    beforeAdoptChild = [...x.fixture.plane.roots.values()].find(state => state.preparedPresentationRequestId);
    assert(beforeAdoptChild); return { isCurrent: () => true };
  } });
  const held = x.keep(x.model.retainPreparedPresentation()), header = x.model.header;
  assert.equal(checkedHistoryPrimaryPreparedPresentation(held.capability), held.capability);
  assert.notEqual(held.header.leaseId, header.leaseId);
  assert.equal(held.capability.validation.leaseId, header.leaseId);
  assert.equal(held.header.leaseId, beforeAdoptChild.leaseId);
  assert.equal(held.ownsCompatibilityMetadata(x.model.metadata.entries), true);
  assert.equal(held.ownsCompatibilityMetadata([...x.model.metadata.entries]), false);
  const subject = x.model.getReceiptDataSubject();
  await x.model.close();
  assert.equal(x.fixture.plane.roots.size, 1);
  assert.equal(x.model.getReceiptDataSubject(), null);
  assert.equal(held.receiptDataSubject, subject);
  const metadata = await held.readMetadataOrdinal(0);
  assert.equal(metadata.uuid, 'one'); assert.equal(metadata.rowStub, true);
  assert.equal(metadata.questionReplyProof.left, metadata.questionReplyProof.right);
  assert.equal(metadata.questionReplyProof.left.self, metadata.questionReplyProof.left);
  assert.equal(metadata.questionReplyProof.left.text, proof.text);
  assert(Object.hasOwn(metadata.questionReplyProof.left, 'missing'));
  assert.equal(metadata.questionReplyProof.left.missing, undefined);
  assert.equal(await selectedBody(held, 'one'), body);
  await held.close();
  assert.equal(held.releaseState, 'released'); assert.equal(x.fixture.plane.roots.size, 0);
  const releases = x.calls.filter(call => isRelease(call.channel) && call.payload.leaseId === held.header.leaseId);
  assert.equal(releases.length, 1); assert.equal(releases[0].payload.preparedRequestId, held.capability.preparedRequestId);
});

test('same-data view authenticates cheap prepared reuse, keeps canonical tail and data subject, and leaves the old shown cut independently held', async t => {
  const x = await rig(t); await x.open();
  const old = x.model.view, held = x.keep(x.model.retainPreparedPresentation()), subject = x.model.getReceiptDataSubject();
  const sql = x.fixture.store.sql, before = x.calls.length;
  x.fixture.store.sql = function(query) {
    if (query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work')) throw Error('POISON_FULL_GRAPH_RESCAN_ON_VIEW');
    return sql.call(this, query);
  };
  try { await x.view(); } finally { x.fixture.store.sql = sql; }
  await turn();
  assert.equal(x.model.getReceiptDataSubject(), subject);
  assert.equal(x.model.metadata.entries, old.metadata.entries);
  assert.equal(x.model.metadata.canonicalMetadataFact.diagnosticTail, old.metadata.canonicalMetadataFact.diagnosticTail);
  assert.equal(x.model.metadata.canonicalMetadataFact.diagnosticTail.row, old.metadata.canonicalMetadataFact.diagnosticTail.row);
  assert.notEqual(x.model.view.prepared.header.leaseId, held.header.leaseId);
  assert.notEqual(x.model.view.prepared.header.viewRevisionToken, held.header.viewRevisionToken);
  const forks = x.calls.slice(before).filter(call => isPreparedFork(call.channel, call.payload));
  assert.equal(forks.length, 1); assert.equal(forks[0].payload.reuseValidation, held.capability.validation);
  assert.equal(x.fixture.plane.roots.size, 3, 'new Root + new child + old shown child');
  await x.model.close(); assert.equal(x.fixture.plane.roots.size, 1);
  assert.equal((await held.readMetadataOrdinal(0)).uuid, 'one');
  assert.equal(await selectedBody(held, 'one'), 'body one');
});

test('equal-count replacement creates a new source subject while the old shown handle continues reading its original cut', async t => {
  const x = await rig(t, [row('one', { content: 'old exact body' })]); await x.open();
  const held = x.keep(x.model.retainPreparedPresentation()), oldSubject = x.model.getReceiptDataSubject();
  const oldTail = x.model.metadata.canonicalMetadataFact.diagnosticTail;
  x.fixture.setEntries([row('one', { content: 'new exact body' })]); await x.open(); await turn();
  const current = x.keep(x.model.retainPreparedPresentation());
  assert.notEqual(x.model.getReceiptDataSubject(), oldSubject);
  assert.notEqual(x.model.metadata.canonicalMetadataFact.diagnosticTail, oldTail);
  assert.notEqual(current.capability.validation.sourceProof, held.capability.validation.sourceProof);
  assert.notEqual(current.capability.validation.semanticIdentity, held.capability.validation.semanticIdentity);
  assert.equal(await selectedBody(held, 'one'), 'old exact body');
  assert.equal(await selectedBody(current, 'one'), 'new exact body');
  await x.model.close(); assert.equal(x.fixture.plane.roots.size, 2);
  await held.close(); assert.equal(x.fixture.plane.roots.size, 1);
  assert.equal((await current.readMetadataOrdinal(0)).uuid, 'one');
});

test('cloned subjects, changed source identity and mismatched original binding cannot authorize a checked child', async t => {
  const x = await rig(t), opened = await x.client();
  const child = x.keep((await opened.reader.retainPreparedPresentation(opened.header)).reader);
  const real = await opened.reader.retainPreparedPresentation(opened.header); x.keep(real.reader);
  assert.throws(() => checkedHistoryPrimaryPreparedPresentation({ ...real }), { code: 'HISTORY_PRIMARY_PREPARED_SUBJECT_INVALID' });
  const before = x.calls.length;
  await assert.rejects(opened.reader.retainPreparedPresentation({ ...opened.header,
    sourceSnapshot: { ...opened.header.sourceSnapshot, size: opened.header.sourceSnapshot.size + 1 } }),
  { code: 'HISTORY_PRIMARY_PREPARED_VALIDATION_SOURCE' });
  assert.equal(x.calls.length, before, 'source mismatch fails before any allocation');
  await assert.rejects(opened.reader.retainPreparedPresentation(opened.header, { reuseSubject: { ...real } }),
    { code: 'HISTORY_PRIMARY_PREPARED_SUBJECT_INVALID' });
  await assert.rejects(opened.reader.retainPreparedPresentation({ ...opened.header,
    preparedPresentation: { ...opened.header.preparedPresentation, validationToken: '0'.repeat(64) } }),
  { code: 'HISTORY_PRIMARY_PREPARED_VALIDATION_BINDING' });
  assert.equal(child.closed, false); assert.equal(opened.reader.closed, false);
  assert.equal(opened.reader.pending, false); assert.equal(x.fixture.plane.roots.size, 3);
});

test('malformed child replies retire only their exact allocation; substituted sibling or parent identities remain live', async t => {
  const x = await rig(t), opened = await x.client();
  const sibling = await opened.reader.retainPreparedPresentation(opened.header); x.keep(sibling.reader);
  const siblingRaw = x.calls.find(call => isPreparedFork(call.channel, call.payload)).response;
  for (const kind of ['binding', 'sibling', 'parent']) {
    let allocated, originalId;
    const before = x.calls.length;
    x.setIntercept(async (channel, payload, forward) => {
      const value = await forward();
      if (!isPreparedFork(channel, payload)) return value;
      allocated = value; originalId = payload.preparedRequestId;
      if (kind === 'sibling') return siblingRaw;
      if (kind === 'parent') return opened.header;
      return { ...value, preparedValidation: { ...value.preparedValidation, viewRevisionToken: '0'.repeat(64) } };
    });
    await assert.rejects(opened.reader.retainPreparedPresentation(opened.header), { code: 'HISTORY_PRIMARY_PREPARED_FORK_PROTOCOL' });
    await turn(); x.setIntercept(null);
    assert.equal(x.calls.slice(before).filter(call => isPreparedFork(call.channel, call.payload)).length, 1);
    sibling.reader.assertOpen(); opened.reader.assertOpen();
    assert.equal(x.fixture.plane.state(sibling.header, x.fixture.consumerKey).released, false);
    assert.equal(x.fixture.plane.state(opened.header, x.fixture.consumerKey).released, false);
    const attempts = x.calls.slice(before).filter(call => isRelease(call.channel));
    if (kind === 'binding') {
      assert.equal(attempts.length, 1); assert.equal(attempts[0].payload.leaseId, allocated.leaseId);
      assert.equal(attempts[0].payload.preparedRequestId, originalId);
      assert.equal(x.fixture.plane.roots.size, 2);
    } else {
      assert.equal(x.fixture.plane.roots.size, 3, 'a hidden true allocation stays UNKNOWN, never inferred from another owner');
      assert.equal(attempts.length, kind === 'sibling' ? 1 : 0);
      if (kind === 'sibling') {
        assert.equal(attempts[0].payload.preparedRequestId, originalId);
        assert.equal(attempts[0].response.error, 'HISTORY_PRIMARY_PREPARED_RELEASE_BINDING');
      }
      // The fixture owns the original raw producer response. Production has
      // no such lost response and must retain UNKNOWN instead of guessing.
      assert.equal((await x.fixture.invoke('agent-transcript:release-read-root', allocated)).success, true);
    }
  }
});

test('abort and original-reader close during a late child reply clean up exactly once without revoking another independently held child', async t => {
  for (const revoke of ['abort', 'close']) {
    const x = await rig(t), opened = await x.client();
    const sibling = await opened.reader.retainPreparedPresentation(opened.header); x.keep(sibling.reader);
    const delivered = deferred(), reply = deferred(), abort = new AbortController();
    let raw, originalId;
    x.setIntercept(async (channel, payload, forward) => {
      const value = await forward();
      if (!isPreparedFork(channel, payload)) return value;
      raw = value; originalId = payload.preparedRequestId; delivered.resolve(); return reply.promise;
    });
    const pending = opened.reader.retainPreparedPresentation(opened.header, { signal: abort.signal });
    const rejected = assert.rejects(pending, { code: 'HISTORY_READ_CANCELLED' });
    await delivered.promise;
    if (revoke === 'abort') abort.abort(); else await opened.reader.close();
    await rejected; assert.equal(opened.reader.pending, false);
    reply.resolve(raw); await turn(); await turn();
    const cleanup = x.calls.filter(call => isRelease(call.channel) && call.payload.leaseId === raw.leaseId);
    assert.equal(cleanup.length, 1); assert.equal(cleanup[0].payload.preparedRequestId, originalId);
    assert.equal(cleanup[0].response.success, true);
    assert.equal(x.fixture.plane.roots.size, revoke === 'abort' ? 2 : 1);
    assert.equal(x.fixture.plane.state(sibling.header, x.fixture.consumerKey).released, false);
    assert.equal(sibling.reader.closed, false);
  }
});

test('selected metadata demand cancellation abandons only its probe, and separate handles release the child exactly once', async t => {
  const x = await rig(t); await x.open();
  const first = x.keep(x.model.retainPreparedPresentation()), second = x.keep(first.retain());
  await x.model.close();
  const abort = new AbortController(); let intercepted = false;
  x.setIntercept(async (channel, payload, forward) => {
    const value = await forward();
    if (!intercepted && channel.endsWith('read-page') && payload.leaseId === first.header.leaseId) {
      intercepted = true; abort.abort();
    }
    return value;
  });
  await assert.rejects(first.readMetadataOrdinal(0, { signal: abort.signal }), { code: 'HISTORY_READ_CANCELLED' });
  assert(intercepted); x.setIntercept(null);
  assert.equal(first.closed, false); assert.equal(second.closed, false);
  assert.equal(first.capability.reader.closed, false);
  assert.equal(x.calls.filter(call => isRelease(call.channel) && call.payload.leaseId === first.header.leaseId).length, 0);
  assert.equal((await second.readMetadataOrdinal(0)).uuid, 'one');
  await first.close(); assert.equal(x.fixture.plane.roots.size, 1);
  await assert.rejects(first.readMetadataOrdinal(0), { code: 'HISTORY_READ_CANCELLED' });
  assert.equal((await second.readMetadataOrdinal(0)).uuid, 'one');
  await second.close(); await second.close();
  assert.equal(x.fixture.plane.roots.size, 0);
  assert.equal(x.calls.filter(call => isRelease(call.channel) && call.payload.leaseId === first.header.leaseId).length, 1);
});

test('failed final release remains UNKNOWN, retires local authority and never retries or reopens', async t => {
  const x = await rig(t); await x.open();
  const held = x.keep(x.model.retainPreparedPresentation()); await x.model.close();
  let attempts = 0;
  x.setIntercept(async (channel, payload, forward) => {
    if (isRelease(channel) && payload.leaseId === held.header.leaseId) {
      attempts++; return { success: false, error: 'FINITE_RELEASE_UNKNOWN' };
    }
    return forward();
  });
  await assert.rejects(held.close(), { code: 'HISTORY_PRIMARY_PREPARED_RELEASE_UNKNOWN' });
  assert.equal(held.releaseState, 'unknown'); assert.equal(held.closed, true);
  await assert.rejects(held.close(), { code: 'HISTORY_PRIMARY_PREPARED_RELEASE_UNKNOWN' });
  await assert.rejects(held.retirement(), { code: 'HISTORY_PRIMARY_PREPARED_RELEASE_UNKNOWN' });
  await assert.rejects(held.readMetadataOrdinal(0), { code: 'HISTORY_READ_CANCELLED' });
  assert.throws(() => held.retain(), { code: 'HISTORY_READ_CANCELLED' });
  await turn(); assert.equal(attempts, 1);
  assert.equal(x.fixture.plane.roots.size, 1, 'fixture deliberately withheld the release ACK and action');
});

test('successful-looking malformed release receipts remain UNKNOWN without a second release attempt', async t => {
  for (const malformed of ['missing', 'allocation', 'identity', 'released']) {
    const x = await rig(t); await x.open();
    const held = x.keep(x.model.retainPreparedPresentation()); await x.model.close();
    let attempts = 0;
    x.setIntercept(async (channel, payload, forward) => {
      const receipt = await forward();
      if (!isRelease(channel) || payload.leaseId !== held.header.leaseId) return receipt;
      attempts++;
      if (malformed === 'missing') return { success: true };
      if (malformed === 'allocation') return { ...receipt, preparedRequestId: '00000000-0000-0000-0000-000000000000' };
      if (malformed === 'identity') return { ...receipt, leaseId: '00000000-0000-0000-0000-000000000000' };
      return { ...receipt, released: false };
    });
    await assert.rejects(held.close(), { code: 'HISTORY_PRIMARY_PREPARED_RELEASE_UNKNOWN' }, malformed);
    assert.equal(held.releaseState, 'unknown'); assert.equal(held.closed, true);
    await assert.rejects(held.retirement(), { code: 'HISTORY_PRIMARY_PREPARED_RELEASE_UNKNOWN' });
    assert.equal(attempts, 1);
    assert.equal(x.fixture.plane.roots.size, 0, 'the backing action happened; malformed ACK is still not proof');
  }
});

test('valid canonical proof cannot hide an unsupported prepared local row before actual model adoption', async t => {
  const local = row('local-prompt-invalid', { role: 'queued', isLocal: true, queueStatus: 'pending', optimisticAt: Date.now(),
    questionReplyProof: { hidden: new Map([['key', 'value']]) } });
  const x = await rig(t, [row('one')], { payload: { primaryPresentation: { ...presentation(), localEntries: [local] } } });
  let sourceToken, preparedDecoded = 0;
  x.setIntercept(async (channel, payload, forward) => {
    if (channel.endsWith('read-page') && payload.nodeToken === sourceToken && ['range', 'rowWindow'].includes(payload.kind)) preparedDecoded++;
    const value = await forward(); if (channel.endsWith('get-history')) sourceToken = value.sourceMetadata.nodeToken;
    return value;
  });
  await assert.rejects(x.open(), { code: 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED' });
  assert.equal(x.calls.filter(call => call.payload.kind === CANONICAL && call.response?.success === true).length, 1);
  assert.equal(x.calls.filter(call => isPreparedFork(call.channel, call.payload)).length, 1);
  assert.equal(preparedDecoded, 0); assert.equal(x.model.view, null); assert.equal(x.fixture.plane.roots.size, 0);
});

test('prepared aggregate UTF16 corruption is checked independently after canonical proof and before compatibility decode', async t => {
  const local = row('local-prompt-corrupt', { role: 'queued', isLocal: true, queueStatus: 'pending', optimisticAt: Date.now(),
    questionReplyProof: { text: 'prepared-only\ud800'.repeat(500) } });
  const x = await rig(t, [row('one')], { payload: { primaryPresentation: { ...presentation(), localEntries: [local] } } });
  let header, restore, preparedDecoded = 0;
  x.setIntercept(async (channel, payload, forward) => {
    if (channel.endsWith('read-page') && payload.nodeToken === header?.sourceMetadata.nodeToken && ['range', 'rowWindow'].includes(payload.kind)) preparedDecoded++;
    const value = await forward();
    if (channel.endsWith('get-history')) header = value;
    if (payload.kind === CANONICAL && value.success) {
      const p = x.fixture.plane.state(header, x.fixture.consumerKey).primaryPresentation;
      const address = historyPagedCursorAddress(p.sourceMetadataCursor.at(1).field('questionReplyProof').field('text'));
      const meta = x.fixture.store.json(address.ref.id), id = x.fixture.store.vectorGet(meta.chunks, 0);
      const old = x.fixture.store.db.prepare('SELECT body,digest FROM hp_pages WHERE id=?').get(id), body = Buffer.from(old.body);
      body[0] ^= 1;
      x.fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(body, createHash('sha256').update(body).digest('hex'), id);
      restore = () => { x.fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(old.body, old.digest, id);
        x.fixture.store.cache.clear(); x.fixture.store.cacheBytes = 0; };
    }
    return value;
  });
  try { await assert.rejects(x.open()); } finally { restore?.(); }
  assert(restore, 'corruption injected after actual canonical success');
  assert.equal(x.calls.filter(call => call.payload.kind === CANONICAL && call.response?.success === true).length, 1);
  assert.equal(x.calls.filter(call => isPreparedFork(call.channel, call.payload)).length, 1);
  assert(x.fixture.errors.some(error => /digest|corrupt/i.test(error.message)));
  assert.equal(preparedDecoded, 0); assert.equal(x.model.view, null); assert.equal(x.fixture.plane.roots.size, 0);
  assert.equal(x.fixture.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
});

test('provisional prepared adoption failure preserves previous shown subject without read retry', async t => {
  const x = await rig(t); await x.open();
  const previous = x.model.view, held = x.keep(x.model.retainPreparedPresentation()), wakes = [];
  x.model.onReceiptReadWake(event => wakes.push(event));
  x.fixture.setEntries([row('new')]);
  const before = x.calls.length;
  await assert.rejects(x.open({ prepareAdopt: async () => {
    throw Object.assign(Error('finite adoption UNKNOWN'), { code: 'FINITE_ADOPTION_UNKNOWN' });
  } }), { code: 'FINITE_ADOPTION_UNKNOWN' });
  await turn();
  assert.equal(x.model.view, previous); assert.equal(x.model.getReceiptDataSubject(), held.receiptDataSubject);
  assert.equal(x.fixture.plane.roots.size, 2, 'previous Root and previous independent child remain');
  assert.equal(x.calls.slice(before).filter(call => isPreparedFork(call.channel, call.payload)).length, 1);
  assert.deepEqual(wakes.map(event => event.kind), ['settled']);
  assert.equal(await selectedBody(held, 'one'), 'body one');
  x.model.notify(); await turn(); assert.equal(wakes.length, 1);
});

test('selected prepared metadata borrows signed text without text allocation and verifies full aggregate integrity', async t => {
  const id = 'uuid-' + 'full\0\ud800😀'.repeat(100);
  const proof = 'proof-full\0\udc00😀'.repeat(100);
  const x = await rig(t, [row(id, { questionReplyProof: { text: proof } })]);
  await x.open(); const held = x.keep(x.model.retainPreparedPresentation()); await x.model.close();
  let textForks = 0, textReleases = 0, leafReads = 0, corrupt = false;
  x.setIntercept(async (channel, payload, forward) => {
    if (channel.endsWith('fork-read-leaf') && payload.nodeToken && payload.encoding === undefined) textForks++;
    if (isRelease(channel) && x.fixture.plane.roots.get(payload.leaseId)?.lease.cursor().kind === 'text') textReleases++;
    const value = await forward();
    if (channel.endsWith('read-page') && payload.kind === 'leaf') {
      leafReads++;
      if (corrupt && typeof value.text === 'string' && value.text.length) {
        corrupt = false; return { ...value, text: '!' + value.text.slice(1) };
      }
    }
    return value;
  });
  const selected = await held.readMetadataOrdinal(0);
  assert.equal(selected.uuid, id); assert.equal(selected.questionReplyProof.text, proof);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(held.readMetadataOrdinal(0, { signal: abort.signal }), error => error.code === 'HISTORY_READ_CANCELLED');
  assert.equal((await held.readMetadataOrdinal(0)).questionReplyProof.text, proof);
  corrupt = true;
  await assert.rejects(held.readMetadataOrdinal(0), error => error.code === 'HISTORY_PRIMARY_DOCUMENT_DIGEST');
  assert.equal(held.closed, false); assert(leafReads >= 2);
  assert.equal(textForks, 0); assert.equal(textReleases, 0, 'no selected text raw-release ACK exists to block a cancelled lane');
});
