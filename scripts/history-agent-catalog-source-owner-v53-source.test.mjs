// Actual metadata-origin/source-registration/sparse-publication functions.
// The retained capability below is synthetic; connected model/producer tests
// qualify the actual capability separately. No array/UUID map is fabricated
// as a substitute source, and no native latency/paint claim is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getHeapStatistics } from 'node:v8';
import { registerHistoryPrimaryMetadataOrigin, historyPrimaryMetadataOrigin,
  historyPrimaryMetadataSubject, copyHistoryPrimaryMetadataOrigin } from '../src/renderer/utils/historyPrimaryMetadataOrigin.mjs';
import { createHistoryAgentCatalogSourceOwner } from '../src/renderer/utils/historyAgentCatalogSourceOwner.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime64/2 SOURCE cap');
const tick = () => new Promise(resolve => setImmediate(resolve));
const isLocal = row => row?.local === true;
const scope = (ownerKey = 'A', generation = 1) => ({ ownerKey, generation });
const local = value => ({ uuid: 'local-prompt-' + value, local: true, value });

function source(rows = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }], onRetain = () => {}) {
  const subject = registerHistoryPrimaryMetadataOrigin(rows);
  rows.forEach(Object.freeze); Object.freeze(rows);
  const header = Object.freeze({ sourceEntryCount: rows.length }), originHeader = Object.freeze({ old: true });
  const receiptDataSubject = Object.freeze({});
  let references = 0, retains = 0, closes = 0;
  const handle = () => {
    references++;
    let closed = false;
    return Object.freeze({ header, originHeader, metadataSubject: subject, receiptDataSubject,
      get closed() { return closed; },
      retain() { if (closed) throw Object.assign(Error('closed'), { code: 'HISTORY_READ_CANCELLED' });
        retains++; const next = handle(); onRetain(next); return next; },
      close() { if (!closed) { closed = true; closes++; references--; } return Promise.resolve(); } });
  };
  return { rows, held: handle(), subject, get references() { return references; }, get retains() { return retains; }, get closes() { return closes; } };
}

test('actual registration authenticates exact row witness, ordinal and independent subject', () => {
  const rows = [{ uuid: 'first' }, { uuid: 'second' }];
  const subject = registerHistoryPrimaryMetadataOrigin(rows);
  assert.equal(historyPrimaryMetadataSubject(rows), subject);
  assert.equal(registerHistoryPrimaryMetadataOrigin(rows), subject);
  assert.deepEqual(historyPrimaryMetadataOrigin(rows[1]), { subject, ordinal: 1, native: false });
  const fake = { ...rows[1] };
  for (const symbol of Object.getOwnPropertySymbols(rows[1])) Object.defineProperty(fake, symbol, Object.getOwnPropertyDescriptor(rows[1], symbol));
  assert.equal(historyPrimaryMetadataOrigin(fake), null, 'copied marker fails original weak row witness');
  assert.throws(() => registerHistoryPrimaryMetadataOrigin([Object.freeze({ uuid: 'unregistered' })]),
    error => error.code === 'HISTORY_PRIMARY_METADATA_ORIGIN_FROZEN');
  const decorated = copyHistoryPrimaryMetadataOrigin(rows[1], { ...rows[1], promptChips: ['native'] });
  assert.deepEqual(historyPrimaryMetadataOrigin(decorated), { subject, ordinal: 1, native: true });
  assert.equal(Object.keys(decorated).includes('ordinal'), false);
});

test('exact source order, removals, repeats and native decorations survive registration', async () => {
  const original = source(), owner = createHistoryAgentCatalogSourceOwner({ isLocal });
  try {
    const initial = owner.prepare(original.rows, scope(), { prepared: original.held }).commit();
    assert.deepEqual(initial.segments, [{ start: 0, end: 3 }]);
    const current = local('current');
    const decorated = copyHistoryPrimaryMetadataOrigin(original.rows[2], { ...original.rows[2], promptChips: [] });
    const entries = [original.rows[2], current, original.rows[0], original.rows[0], decorated];
    const next = owner.prepare(entries, scope()).commit();
    assert.deepEqual(next.segments, [{ start: 2, end: 3 }, { row: current },
      { start: 0, end: 1 }, { start: 0, end: 1 }, { row: decorated }]);
    assert.equal(next.historicalCount, 4);
    assert.deepEqual(next.localRows, [current]);
    assert.deepEqual(next.rows, [current, decorated]);
    assert.equal(next.prepared, initial.prepared, 'same registered subject does not fork on local status');
    assert.equal(original.retains, 1);
  } finally { owner.close(); await original.held.close(); await tick(); }
  assert.equal(original.references, 0);
});

test('actual sparse publisher refreshes catalog recipe after CURRENT status/removal and historical suppression', async () => {
  const original = source(), agent = createHistoryAgentCatalogSourceOwner({ isLocal });
  const sparse = createHistoryPrimarySparsePublicationOwner({ isLocal, agentSourceOwner: agent, agentCatalogEnabled: () => true });
  const first = local('first'), updated = { ...first, value: 'updated' };
  const publication = { header: original.held.header, dataSubject: original.held.receiptDataSubject,
    replacements: [], exclusions: [], insertions: [first], currentLocals: [first] };
  try {
    sparse.adopt({ prepared: original.held, publication, isCurrent: () => true }, [...original.rows, first], scope());
    const nextRows = [original.rows[0], updated, original.rows[2]];
    const next = sparse.publishCompatibility(nextRows, scope());
    assert.equal(next.sparse, publication, 'V52 prepared recipe itself remains unchanged');
    assert.deepEqual(next.rows, [updated]);
    assert.deepEqual(next.agentCatalog.segments, [{ start: 0, end: 1 }, { row: updated }, { start: 2, end: 3 }]);
    assert.equal(next.agentCatalog.historicalCount, 2, 'removed historical user/row does not resurrect from prepared cut');
    assert(sparse.matches(next, nextRows, scope()));
    const removed = sparse.publishCompatibility([original.rows[2]], scope());
    assert.deepEqual(removed.agentCatalog.segments, [{ start: 2, end: 3 }]);
    assert.deepEqual(removed.agentCatalog.rows, []);
  } finally { sparse.close(); await original.held.close(); await tick(); }
  assert.equal(original.references, 0);
});

test('header-null new owner retained prefix has separate source and writer facts', async () => {
  const original = source(), agent = createHistoryAgentCatalogSourceOwner({ isLocal });
  const sparse = createHistoryPrimarySparsePublicationOwner({ isLocal, agentSourceOwner: agent, agentCatalogEnabled: () => true });
  try {
    const publication = { header: original.held.header, dataSubject: original.held.receiptDataSubject };
    sparse.adopt({ prepared: original.held, publication, isCurrent: () => true }, original.rows, scope());
    const prefix = [original.rows[0]], hint = agent.capture(prefix);
    sparse.clear(); await original.held.close(); await tick();
    assert.equal(hint.prepared.closed, false, 'captured historical source survives original model/publication close');
    const next = sparse.publishCompatibility([...prefix, local('new-writer')], scope('B', 2), { sourceHint: hint });
    hint.close(); await tick();
    assert.equal(next.prepared, null, 'no prepared writer adoption is invented for new header-null owner');
    assert.equal(next.agentCatalog.ownerKey, 'B'); assert.equal(next.agentCatalog.generation, 2);
    assert.equal(next.agentCatalog.metadataSubject, original.subject);
    assert.equal(next.agentCatalog.sourceOriginHeader, original.held.originHeader);
    assert.equal(next.agentCatalog.prepared.closed, false);
    assert.deepEqual(next.agentCatalog.segments[0], { start: 0, end: 1 });
  } finally { sparse.close(); await original.held.close(); await tick(); }
  assert.equal(original.references, 0);
});

test('UNKNOWN/current-only, source-error and held genuinely empty have distinct proof states', async () => {
  const original = source([]), owner = createHistoryAgentCatalogSourceOwner({ isLocal });
  try {
    const current = local('only');
    const unknown = owner.prepare([current], scope()).commit();
    assert.equal(unknown.kind, 'unestablished-chip-source'); assert.equal(unknown.prepared, null);
    assert.deepEqual(unknown.localRows, [current]);
    const error = owner.prepare([{ uuid: 'unregistered-history' }], scope()).commit();
    assert.equal(error.kind, 'chip-source-error');
    assert.equal(error.error.code, 'HISTORY_AGENT_CATALOG_UNREGISTERED_SOURCE');
    assert.equal(error.historicalCount, null); assert.equal(error.segments, null);
    const empty = owner.prepare([], scope(), { prepared: original.held }).commit();
    assert.equal(empty.kind, 'held-chip-source'); assert(empty.prepared);
    assert.equal(empty.historicalCount, 0); assert.deepEqual(empty.segments, []);
  } finally { owner.close(); await original.held.close(); await tick(); }
  assert.equal(original.references, 0);
});

test('mixed historical subjects cannot silently become empty or attach to the nearest Root', async () => {
  const a = source(), b = source([{ uuid: 'b' }]), owner = createHistoryAgentCatalogSourceOwner({ isLocal });
  try {
    owner.prepare(a.rows, scope(), { prepared: a.held }).commit();
    const result = owner.prepare([a.rows[0], b.rows[0]], scope(), { prepared: b.held }).commit();
    assert.equal(result.kind, 'chip-source-error');
    assert.equal(result.error.code, 'HISTORY_AGENT_CATALOG_SOURCE_IDENTITY');
    assert.equal(result.prepared, null); assert.equal(result.historicalCount, null);
  } finally { owner.close(); await a.held.close(); await b.held.close(); await tick(); }
  assert.equal(a.references, 0); assert.equal(b.references, 0);
});

test('reentrant classification and original caller witness cannot commit a stale source plan', async () => {
  const original = source();
  let reenter = false, agent;
  agent = createHistoryAgentCatalogSourceOwner({ isLocal(row) { if (reenter) { reenter = false; agent.clear(); } return isLocal(row); } });
  const sparse = createHistoryPrimarySparsePublicationOwner({ isLocal, agentSourceOwner: agent, agentCatalogEnabled: () => true });
  try {
    const publication = { header: original.held.header, dataSubject: original.held.receiptDataSubject };
    sparse.adopt({ prepared: original.held, publication, isCurrent: () => true }, original.rows, scope());
    reenter = true;
    assert.throws(() => sparse.publishCompatibility([...original.rows, local('late')], scope()),
      error => error.code === 'HISTORY_READ_CANCELLED');
    await tick();
    assert.equal(agent.current(), null);
    assert.throws(() => sparse.publishCompatibility(original.rows.slice(), scope(), { owns() { sparse.clear(); return true; } }),
      error => error.code === 'HISTORY_READ_CANCELLED');
  } finally { sparse.close(); await original.held.close(); await tick(); }
  assert.equal(original.references, 0);
});

test('legacy-disabled registration does not classify historical native rows and releases prior source', async () => {
  const original = source(), owner = createHistoryAgentCatalogSourceOwner({ isLocal });
  try {
    owner.prepare(original.rows, scope(), { prepared: original.held }).commit();
    const legacy = Object.create(null);
    Object.defineProperty(legacy, 'local', { get() { throw Error('LEGACY_MUST_NOT_CLASSIFY'); } });
    assert.equal(owner.prepare([legacy], scope(), { enabled: false }).commit(), null);
    await tick(); assert.equal(original.references, 1);
  } finally { owner.close(); await original.held.close(); await tick(); }
});

test('retained prefix capture rechecks original owner after native classifier reentry', async () => {
  for (const action of ['clear', 'close']) {
    const original = source();
    let armed = false, captured = null, owner;
    owner = createHistoryAgentCatalogSourceOwner({ isLocal(row) {
      if (armed) { armed = false; owner[action](); }
      return isLocal(row);
    } });
    try {
      owner.prepare(original.rows, scope(), { prepared: original.held }).commit();
      const decorated = copyHistoryPrimaryMetadataOrigin(original.rows[0], { ...original.rows[0], promptChips: [] });
      armed = true;
      assert.throws(() => { captured = owner.capture([decorated]); }, error => error.code === 'HISTORY_READ_CANCELLED',
        'capture may not mint a new retained source after its original owner was cleared/closed');
    } finally { captured?.close(); owner.close(); await original.held.close(); await tick(); }
    assert.equal(original.references, 0);
  }
});

test('retained prefix capture releases newly retained child when retain reenters owner retirement', async () => {
  for (const action of ['clear', 'close']) {
    let armed = false, owner;
    const original = source(undefined, () => { if (armed) { armed = false; owner[action](); } });
    owner = createHistoryAgentCatalogSourceOwner({ isLocal });
    let captured = null;
    try {
      owner.prepare(original.rows, scope(), { prepared: original.held }).commit();
      armed = true;
      assert.throws(() => { captured = owner.capture([original.rows[0]]); }, error => error.code === 'HISTORY_READ_CANCELLED');
      await tick();
      assert.equal(original.references, 1, 'only original test handle remains; rejected prefix child and retired owner both released');
    } finally { captured?.close(); owner.close(); await original.held.close(); await tick(); }
    assert.equal(original.references, 0);
  }
});
