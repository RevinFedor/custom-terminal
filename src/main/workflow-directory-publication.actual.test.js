'use strict';

// Actual Main composition + organization/SQL/canonical projector. Physical
// runtime/cards and the existing broadcast timer are controlled, not booted.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { directoryFixture } = require('./fixtures/workflow-directory-sqlite.cjs');
const { host } = require('./fixtures/workflow-publication-main.cjs');
const { createWorkflowPublicationWake } = require('./workflow-publication-wake');
const { createDirectoryCursorCodec, prepareDirectoryCatalog } = require('../shared/workflow-directory-catalog.cjs');
const { projectWorkflowCatalog } = require('../shared/workflow-catalog-projection.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const layout = id => ({ version: 1, windowDisplayKey: id, splitPanes: [] });
async function fixture(t, count = 0) {
  const f = await directoryFixture(t); f.add('chat');
  for (let i = 0; i < count; i++) f.add('file-' + i, { tabType: 'file', visualParentTabId: 'chat', filePath: path.join(f.directory, i + '.md') });
  const h = host(f.database, process.env.IOS35_CANDIDATE_MAIN
    ? { mainSource: fs.readFileSync(process.env.IOS35_CANDIDATE_MAIN, 'utf8') } : {});
  h.scope.captureWorkflowDirectoryRuntime = f.runtime; h.scope.captureWorkflowDirectoryCards = f.cards;
  return { f, h, api: h.scope.api };
}
const core = f => projectWorkflowCatalog({ snapshot: f.api.read(), namespaceOrder: ['__tab_catalog_v2__'], legacyNamespaces: [], directory: true });

test('C differentiating: actual Main initial catalog carries the exact synchronous publication receipt', async t => {
  const { f, h, api } = await fixture(t); h.bind();
  const calls = [], accessor = h.helper.forPublication?.bind(h.helper);
  if (accessor) h.helper.forPublication = publication => {
    calls.push({ inTransaction: f.db.inTransaction, publication: plain(publication) }); return accessor(publication);
  };
  const catalog = await api.readCatalogV2();
  assert.deepEqual(plain(catalog.workflowPublication ?? null), plain(h.helper.snapshot()), 'captured catalog lacks its exact Main publication receipt');
  assert.equal(calls.length, 1); assert.equal(calls[0].inTransaction, true);
  assert.equal(catalog.workflowPublication.generation, catalog.clocks.organization.generation);
  assert.equal(catalog.workflowPublication.revision, catalog.clocks.organization.revision);
});

test('exact wake join rejects missing/future/mismatched tuples and loses authority with its owner', () => {
  let current = true, schedules = 0;
  const wake = createWorkflowPublicationWake();
  const p = { version: 1, generation: 7, revision: 9 };
  assert.equal(wake.forPublication(p), null);
  wake.start({ epoch: 'main-A', isCurrent: () => current, readPublication: () => p, schedule: () => schedules++ });
  const joined = wake.forPublication(p);
  assert.deepEqual(joined, wake.snapshot()); joined.epoch = 'foreign'; joined.revision = 100;
  assert.equal(wake.forPublication(p).epoch, 'main-A'); assert.equal(wake.forPublication(p).revision, 9);
  for (const bad of [null, {}, { ...p, version: 2 }, { ...p, generation: 6 }, { ...p, generation: 8 },
    { ...p, revision: 8 }, { ...p, revision: 10 }, { ...p, revision: '9' }, { ...p, generation: NaN }]) {
    assert.equal(wake.forPublication(bad), null);
  }
  assert.equal(schedules, 1, 'read accessor must not observe/schedule/rebind');
  current = false; assert.equal(wake.forPublication(p), null); assert.equal(wake.snapshot(), null);
});

test('equal SQL revision on a different Main epoch never reuses the old epoch receipt', () => {
  const publication = { version: 1, generation: 3, revision: 12 };
  const a = createWorkflowPublicationWake(), b = createWorkflowPublicationWake();
  a.start({ epoch: 'main-A', isCurrent: () => true, readPublication: () => publication, schedule() {} });
  b.start({ epoch: 'main-B', isCurrent: () => true, readPublication: () => publication, schedule() {} });
  assert.equal(a.forPublication(publication).epoch, 'main-A');
  assert.equal(b.forPublication(publication).epoch, 'main-B');
});

test('unseeded and replaced Main omit optional receipt; catalog remains available', async t => {
  const { h, api } = await fixture(t);
  assert.equal(Object.hasOwn(await api.readCatalogV2(), 'workflowPublication'), false);
  h.bind(); assert.ok((await api.readCatalogV2()).workflowPublication);
  h.replaceOwner(); assert.equal(Object.hasOwn(await api.readCatalogV2(), 'workflowPublication'), false);
});

test('catalog capture is immutable across an intervening committed publication and duplicate read', async t => {
  const { f, h, api } = await fixture(t); h.bind();
  const [first, joined] = await Promise.all([api.readCatalogV2(), api.readCatalogV2()]);
  assert.deepEqual(first, joined); const captured = plain(first.workflowPublication);
  h.commit(layout('changed-after-capture')); const latest = h.helper.snapshot();
  assert.ok(latest.revision > captured.revision);
  assert.deepEqual(plain(first.workflowPublication), captured, 'a held old response must not receive a latest stamp');
  const next = await api.readCatalogV2(); assert.deepEqual(plain(next.workflowPublication), plain(latest));
});

test('missed publication is not fabricated by an accessor; exact later observation recovers', async t => {
  const { h, api } = await fixture(t); h.bind();
  const observe = h.helper.observe; h.helper.observe = () => false;
  h.commit(layout('missed-wake'));
  assert.equal(Object.hasOwn(await api.readCatalogV2(), 'workflowPublication'), false);
  h.helper.observe = observe; observe(h.publication());
  assert.equal((await api.readCatalogV2()).workflowPublication.revision, h.publication().revision);
});

test('receipt was joined during capture, never later by an awaiting consumer', async t => {
  const { h, api } = await fixture(t); h.bind();
  const pending = api.readCatalogV2();
  const old = await pending;
  h.commit(layout('response-held'));
  h.helper.forPublication = () => { throw Error('no late receipt accessor permitted'); };
  assert.equal((await pending).workflowPublication.revision, old.clocks.organization.revision);
  assert.notEqual(old.workflowPublication.revision, h.helper.snapshot().revision);
});

test('sidecar receipt changes neither hash/clocks/native drag nor first5/next20/tail2 cursor bytes', async t => {
  const { f } = await fixture(t, 27), input = core(f);
  const options = { sourceEpoch: 'fixed-directory-epoch', secret: Buffer.alloc(32, 9) };
  const a = prepareDirectoryCatalog(input, createDirectoryCursorCodec(options));
  const b = prepareDirectoryCatalog({ ...input, workflowPublication: {
    version: 1, source: 'workflow-organization-publication', epoch: 'different-main-epoch',
    generation: input.clocks.organization.generation, revision: input.clocks.organization.revision,
  } }, createDirectoryCursorCodec(options));
  const before = plain(a.initial()), after = plain(b.initial());
  assert.ok(after.workflowPublication); delete after.workflowPublication; assert.deepEqual(after, before);
  assert.equal(a.catalogClock, b.catalogClock);
  let token = before.fileWindows[0].nextCursor, counts = [];
  assert.equal(before.fileWindows[0].loaded, 5);
  while (token) {
    const left = a.page(token), right = b.page(token);
    assert.deepEqual(left, right); assert.equal(Object.hasOwn(right, 'workflowPublication'), false);
    counts.push(right.nodeIds.length); token = right.nextCursor;
  }
  assert.deepEqual(counts, [20, 2]);
});

test('RAW/v1 projections and held runtime/cards preserve their original contracts', async t => {
  const { f, h, api } = await fixture(t); h.bind();
  const raw = JSON.stringify(api.read()), v1 = JSON.stringify(await api.readCatalog());
  const initial = await api.readCatalogV2(), basis = { sourceEpoch: initial.sourceEpoch, catalogClock: initial.catalogClock, tabIds: ['chat'] };
  let release; const held = new Promise(resolve => { release = resolve; });
  h.scope.captureWorkflowDirectoryRuntime = async entries => { await held; return h.scope.runtimePort(entries); };
  h.scope.runtimePort = f.runtime;
  const runtime = api.readRuntimeSummary(basis);
  const cards = await api.readCardSignals(basis);
  release(); const result = await runtime;
  assert.equal(result.coverage.complete, true); assert.equal(cards.coverage.complete, true);
  assert.equal(Object.hasOwn(result, 'workflowPublication'), false); assert.equal(Object.hasOwn(cards, 'workflowPublication'), false);
  assert.equal(JSON.stringify(api.read()), raw); assert.equal(JSON.stringify(await api.readCatalog()), v1);
});

test('Main constructor wires receipt reader to the same wake, without altering late Web start', () => {
  const main = fs.readFileSync(process.env.IOS35_CANDIDATE_MAIN || path.join(__dirname, 'main.js'), 'utf8');
  assert.match(main, /readDirectoryPublication: publication => workflowPublicationWake\.forPublication\(publication\)/);
});
