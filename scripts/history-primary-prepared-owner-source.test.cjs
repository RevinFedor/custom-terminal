'use strict';

// SOURCE only: real producer, thin validator, semantic bundle, SQLite plane,
// selected client and actual existing controller dispatch. Finite parsed rows
// and in-process transport are explicit fixture substitutions.
// node --max-old-space-size=64 --max-semi-space-size=2 --test --test-reporter=tap --test-isolation=none scripts/history-primary-prepared-owner-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path'), v8 = require('node:v8');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { historyPagedCursorAddress } = require('../src/main/history-root-engine/main/history-paged-store');
const ENCODING = 'history-primary-prepared-presentation-v1';
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'use bounded documented V8 command');
const row = (uuid, extra = {}) => ({ role: 'user', uuid, sessionId: 's', content: 'real body ' + uuid, ...extra });
const control = { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } };
async function rig(t, entries = [row('a')], options = {}) {
  const fixture = await createPrimaryAddressFixture(t, { entries, ...options });
  const parent = await fixture.plane.open(fixture.payload, { consumerKey: fixture.consumerKey, control });
  const shared = await import(pathToFileURL(path.resolve(__dirname, '../src/shared/history-root-read-client.mjs')));
  return { fixture, parent, shared };
}
function request(header, extra = {}) {
  const { leaseId, ownerKey, revision, generation, metadataIdentity, metadataSchema, semanticIdentity,
    semanticRevisionToken, viewRevisionToken, canonicalEntryCount, sourceEntryCount } = header;
  return { leaseId, ownerKey, revision, generation, metadataIdentity, metadataSchema, semanticIdentity,
    semanticRevisionToken, viewRevisionToken, canonicalEntryCount, sourceEntryCount,
    ...header.preparedPresentation, parentNodeToken: header.root.nodeToken, nodeToken: header.sourceMetadata.nodeToken,
    encoding: ENCODING, preparedRequestId: randomUUID(), ...extra };
}
const retain = (x, header = x.parent, extra = {}, selectedControl = control) => x.fixture.plane.forkPreparedPresentation(
  request(header, extra), { consumerKey: x.fixture.consumerKey, control: selectedControl });
const release = (x, header) => x.fixture.plane.release(header, { consumerKey: x.fixture.consumerKey });
async function sourceBody(x, child, ordinal = 0) {
  const header = x.shared.checkedHistoryRootOpenHeader(child);
  const reader = new x.shared.HistoryRootClient(x.fixture.invoke, header.root, { pageBytes: 65536, pageItems: 3 });
  const page = await reader.primaryCanonicalConsumers(header.sourceMetadata, { header, scope: 'prepared', offset: ordinal, limit: 1 });
  const field = (await reader.project(page.items[0].row, ['content'])).items[0].value;
  let result = '';
  if (typeof field === 'string') return field;
  if (field?.kind === 'scalar') return field.value;
  for await (const part of reader.text(field).chunks()) result += part;
  return result;
}

test('independent subject preserves exact prepared cut after original Root release and a new source open', async t => {
  const text = 'full\0\ud800😀'.repeat(500), x = await rig(t, [row('a', { content: text })]);
  const before = x.fixture.plane.stats().roots, child = await retain(x);
  assert.notEqual(child.leaseId, x.parent.leaseId); assert.equal(child.retainedPreparedPresentation, true);
  assert.equal(child.preparedValidation.leaseId, x.parent.leaseId);
  assert.equal(child.preparedValidation.parentNodeToken, x.parent.root.nodeToken);
  assert.equal(child.preparedValidation.nodeToken, x.parent.sourceMetadata.nodeToken);
  assert.equal(child.sourceMetadata.leaseId, child.leaseId);
  assert.equal(child.preparedSource.length, 1); assert.equal(child.preparedView.kind, 'object');
  assert.equal(x.fixture.plane.stats().roots, before + 1);
  release(x, x.parent);
  x.fixture.setEntries([row('new', { content: 'different source' })]);
  const next = await x.fixture.plane.open(x.fixture.payload, { consumerKey: x.fixture.consumerKey, control });
  assert.notEqual(child.semanticIdentity, next.semanticIdentity);
  assert.equal(await sourceBody(x, child), text);
  assert.equal(x.fixture.plane.state(child, x.fixture.consumerKey).primaryPresentation.sourceMetadataCursor.length, 1);
  release(x, child); assert.throws(() => x.fixture.plane.state(child, x.fixture.consumerKey), { code: 'HISTORY_ROOT_RELEASED' });
  assert.equal(x.fixture.plane.state(next, x.fixture.consumerKey).released, false);
});

test('all reachable prepared graph values are checked separately from canonical validation', async t => {
  const shared = { text: 'UTF16\ud800'.repeat(90), missing: undefined };
  const sparse = []; sparse.length = 5; sparse[4] = shared; shared.self = shared;
  const x = await rig(t, [row('a', { questionReplyProof: { left: shared, right: shared, sparse } })]);
  const child = await retain(x);
  assert.match(child.preparedValidation.validationDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(child.preparedValidation.profile, x.parent.canonicalMetadataValidation.profile);
  assert.equal(x.fixture.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
  const p = x.fixture.plane.state(x.parent, x.fixture.consumerKey).primaryPresentation;
  assert.equal(p.preparedMetadataValidation.preparedEntryCount, 1);
  assert.equal(Object.hasOwn(p.preparedMetadataValidation, 'canonicalEntryCount'), false);
  assert.equal(p.canonicalMetadataValidation.canonicalEntryCount, 1);
  assert.equal(Object.hasOwn(p.canonicalMetadataValidation, 'preparedEntryCount'), false);
});

test('hidden invalid prepared local row cannot borrow valid canonical proof', async t => {
  const x = await rig(t, [row('a')]);
  const local = row('local-prompt-bad', { isLocal: true, role: 'queued', queueStatus: 'pending', optimisticAt: Date.now(),
    questionReplyProof: { bad: new Map([['key', 'value']]) } });
  const parent = await x.fixture.plane.open({ ...x.fixture.payload, primaryPresentation: { localEntries: [local] } },
    { consumerKey: x.fixture.consumerKey, control });
  const p = x.fixture.plane.state(parent, x.fixture.consumerKey).primaryPresentation;
  assert.equal(p.canonicalMetadataValidation.kind, 'validated');
  assert.equal(p.preparedMetadataValidation.kind, 'refused');
  await assert.rejects(retain(x, parent), { code: 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED' });
  assert.equal(x.fixture.plane.state(parent, x.fixture.consumerKey).released, false);
});

test('cold prepared check validates aggregate UTF16 text after individual page digest is repaired', async t => {
  const x = await rig(t, [row('a', { questionReplyProof: { text: 'hidden\ud800'.repeat(700) } })]);
  const p = x.fixture.plane.state(x.parent, x.fixture.consumerKey).primaryPresentation;
  const cursor = p.sourceMetadataCursor.at(0).field('questionReplyProof').field('text');
  const address = historyPagedCursorAddress(cursor), meta = x.fixture.store.json(address.ref.id);
  const id = x.fixture.store.vectorGet(meta.chunks, 0), old = x.fixture.store.db.prepare('SELECT body,digest FROM hp_pages WHERE id=?').get(id);
  const body = Buffer.from(old.body); body[0] ^= 1;
  x.fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(body, createHash('sha256').update(body).digest('hex'), id);
  try { await assert.rejects(retain(x), error => /digest|corrupt/i.test(error.message)); }
  finally { x.fixture.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(old.body, old.digest, id);
    x.fixture.store.cache.clear(); x.fixture.store.cacheBytes = 0; }
  assert.equal(x.fixture.plane.stats().roots, 1, 'failed new child was not published');
  assert.equal((await retain(x)).success, true);
});

test('authenticated pure-view reuse skips full SQL work but binds new exact original view and child', async t => {
  const x = await rig(t), child = await retain(x);
  const view = await x.fixture.plane.open({ ...x.fixture.payload, primaryRequestClass: 'view',
    localRootLease: x.parent, expectedSemanticIdentity: x.parent.semanticIdentity,
    primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } },
  { consumerKey: x.fixture.consumerKey, control });
  const sql = x.fixture.store.sql;
  x.fixture.store.sql = function (query) {
    if (query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work')) throw Error('POISON_PREPARED_RESCAN_ON_AUTHENTICATED_REUSE');
    return sql.call(this, query);
  };
  let reused;
  try { reused = await retain(x, view, { reuseValidation: child.preparedValidation }); }
  finally { x.fixture.store.sql = sql; }
  assert.notEqual(reused.leaseId, child.leaseId);
  assert.notEqual(reused.viewRevisionToken, child.viewRevisionToken);
  assert.equal(reused.preparedValidation.validationDigest, child.preparedValidation.validationDigest);
  assert.equal(reused.preparedValidation.leaseId, view.leaseId);
  assert.notEqual(reused.preparedValidation.validationReceipt, child.preparedValidation.validationReceipt);
  release(x, x.parent); release(x, view);
  assert.equal(await sourceBody(x, child), 'real body a'); assert.equal(await sourceBody(x, reused), 'real body a');
});

test('forged reuse, canonical receipt, source rewrite, count equality and descriptor swaps are refused', async t => {
  const x = await rig(t), child = await retain(x);
  const view = await x.fixture.plane.open({ ...x.fixture.payload, primaryRequestClass: 'view',
    localRootLease: x.parent, expectedSemanticIdentity: x.parent.semanticIdentity,
    primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } },
  { consumerKey: x.fixture.consumerKey, control });
  for (const change of [{ validationReceipt: '0'.repeat(64) }, { sourceProof: '0'.repeat(64) },
    { profile: 'primary-canonical-metadata-v1' }, { sourceEntryCount: 2 }]) {
    await assert.rejects(retain(x, view, { reuseValidation: { ...child.preparedValidation, ...change } }),
      { code: 'HISTORY_PRIMARY_PREPARED_VALIDATION_REUSE' });
  }
  for (const change of [{ nodeToken: child.sourceMetadata.nodeToken }, { parentNodeToken: child.root.nodeToken },
    { viewRevisionToken: '0'.repeat(64) }, { sourceSnapshot: view.sourceSnapshot }]) {
    await assert.rejects(retain(x, view, change), { code: 'HISTORY_PRIMARY_PREPARED_VALIDATION_BINDING' });
  }
  x.fixture.setEntries([row('a')]);
  const next = await x.fixture.plane.open(x.fixture.payload, { consumerKey: x.fixture.consumerKey, control });
  await assert.rejects(retain(x, next, { reuseValidation: child.preparedValidation }), { code: 'HISTORY_PRIMARY_PREPARED_VALIDATION_REUSE' });
  assert.equal(await sourceBody(x, child), 'real body a');
});

test('cancellation and parent release during cold validation do not publish or revoke another child', async t => {
  const x = await rig(t, [row('a', { questionReplyProof: Object.fromEntries(Array.from({ length: 100 }, (_, n) => ['field' + n, 'x'.repeat(20)])) })]), child = await retain(x);
  let cancelled = false, yields = 0;
  const aborted = { assertCurrent() { if (cancelled) throw Object.assign(Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' }); },
    async checkpoint() { yields++; cancelled = true; this.assertCurrent(); } };
  await assert.rejects(retain(x, x.parent, {}, aborted), { code: 'HISTORY_READ_CANCELLED' });
  assert(yields > 0); assert.equal(x.fixture.plane.stats().roots, 2);
  let closed = false;
  await assert.rejects(retain(x, x.parent, {}, { assertCurrent() {}, async checkpoint() {
    if (!closed) { closed = true; release(x, x.parent); }
  } }), { code: 'HISTORY_ROOT_RELEASED' });
  assert.equal(x.fixture.plane.stats().roots, 1);
  assert.equal(await sourceBody(x, child), 'real body a');
  assert.equal(x.fixture.store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n, 0);
});

test('post-allocation parent loss releases exactly provisional child; sibling remains live', async t => {
  const x = await rig(t), sibling = await retain(x), install = x.fixture.plane.install;
  x.fixture.plane.install = function (...args) {
    const result = install.apply(this, args); release(x, x.parent); return result;
  };
  try { await assert.rejects(retain(x), { code: 'HISTORY_ROOT_RELEASED' }); }
  finally { x.fixture.plane.install = install; }
  assert.equal(x.fixture.plane.stats().roots, 1); assert.equal(x.fixture.plane.opening, 0);
  assert.equal(await sourceBody(x, sibling), 'real body a');
});

test('prepared allocation ID restricts malformed/late cleanup to the exact new child', async t => {
  const x = await rig(t), one = await retain(x), two = await retain(x);
  const failRelease = header => assert.throws(() => release(x, header), { code: 'HISTORY_PRIMARY_PREPARED_RELEASE_BINDING' });
  failRelease({ ...two, preparedRequestId: one.preparedRequestId });
  failRelease({ ...x.parent, preparedRequestId: one.preparedRequestId });
  const without = { ...one }; delete without.preparedRequestId; failRelease(without);
  assert.equal(x.fixture.plane.stats().roots, 3);
  release(x, one); assert.equal(x.fixture.plane.stats().roots, 2);
  assert.equal(await sourceBody(x, two), 'real body a');
  assert.equal(x.fixture.plane.state(x.parent, x.fixture.consumerKey).released, false);
});
