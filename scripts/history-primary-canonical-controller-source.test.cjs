'use strict';

// Finite SOURCE control, not Electron/process/native acceptance. Extract the
// actual controller methods with an AST; only maintenance/backing scheduling
// and diagnostics are explicit doubles. The store/plane/scalar child are real.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-canonical-controller-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), v8 = require('node:v8');
const { pathToFileURL } = require('node:url');
const parser = require(process.env.NOTED_TEST_BABEL_PARSER || '@babel/parser');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/main/history-root-engine/main/history-root-controller.js'), 'utf8');
const ast = parser.parse(source, { sourceType: 'script' });
const declaration = ast.program.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'HistoryRootController');
assert(declaration, 'actual source controller class');
const names = ['allocates', 'installedPositionRead', 'installedTextPinFork', 'dispatch', 'consumer', 'remember', 'retainRootCapability', 'dispatchOwned'];
const selected = names.map(name => {
  const node = declaration.body.body.find(item => item.type === 'ClassMethod' && item.key.name === name);
  assert(node, 'actual method ' + name); return source.slice(node.start, node.end);
});
const failure = code => Object.assign(new Error(code), { code });
const { HISTORY_PRESENTATION_POSITION_PROFILE: POSITION_PROFILE,
  HISTORY_PRESENTATION_POSITION_QUERY_ENCODING: POSITION_QUERY_ENCODING } = require('../src/main/history-root-engine/main/history-presentation-position');
const Controller = new Function('backingPhase', 'fail', 'POSITION_PROFILE', 'POSITION_QUERY_ENCODING',
  'return class SourceController {' + selected.join('\n') + '}')(
  () => () => {}, failure, POSITION_PROFILE, POSITION_QUERY_ENCODING);
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite V8 TOTAL <=128MiB; use documented command');
const ENCODING = 'history-canonical-consumer-text-v1';

function controller(f) {
  const events = [];
  const instance = Object.assign(Object.create(Controller.prototype), {
    plane: f.plane, store: f.store, closed: false, initializedBacking: true, fullCollectionDepth: 0,
    sourceOptions: {}, sourceSchema: 'finite-source', maintenanceMetrics: { cleanupErrors: 0 },
    maintenanceAdmission: { active: false, async acquire() { events.push('acquire'); return () => events.push('unlock'); } },
    ensurePlane() { events.push('ensure'); return f.plane; },
    async initializeBacking() { events.push('initialize'); },
    collectBounded(limit, reason) { assert.equal(limit, 64); assert.equal(reason, 'allocation-collection'); events.push('collect64'); },
    async makeRoom(method) { assert.equal(method, 'forkHistoryRootLeaf'); events.push('room'); },
    cleanupStep() { events.push('cleanup'); },
  });
  return { instance, events };
}
async function body(document) { let result = ''; for await (const part of document.chunks()) result += part; return result; }

test('actual controller admits derived value as allocating work, dispatches helper and retains one exact child', async t => {
  const full = 'source-bound\0\ud800😀'.repeat(250);
  const f = await createPrimaryAddressFixture(t, { entries: [{ role: 'user', uuid: 'u', sessionId: 's', content: full }] });
  const o = await f.open(); assert.equal(o.kind, 'root');
  const row = (await o.reader.primaryCanonicalConsumers(o.header.durableMetadata, { header: o.header, scope: 'canonical' })).items[0].row;
  const text = (await o.reader.project(row, ['content'])).items[0].value;
  const { instance: ctl, events } = controller(f), retained = [];
  const request = { ...o.reader.identity, nodeToken: row.nodeToken, encoding: ENCODING, operation: 'string-falsy', field: 'content',
    _historyRootConsumerKey: f.consumerKey };
  assert.equal(ctl.allocates('forkHistoryRootLeaf', request), true);
  const pinCheck = f.plane.assertTextPinFork;
  let pinChecks = 0;
  f.plane.assertTextPinFork = function (...args) { pinChecks++; return pinCheck.apply(this, args); };
  assert.equal(ctl.installedTextPinFork('forkHistoryRootLeaf', request), false);
  assert.equal(pinChecks, 0, 'derived value cannot enter synchronous text-pin proof');
  const baseline = f.plane.stats().roots;
  const calls = [], valueFork = f.plane.forkCanonicalConsumerValue;
  f.plane.forkCanonicalConsumerValue = async function (...args) { calls.push('value'); return valueFork.apply(this, args); };
  const control = { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } };
  const result = await ctl.dispatch('forkHistoryRootLeaf', request, { control, retain: cleanup => retained.push(cleanup) });
  assert.deepEqual(calls, ['value']); assert.equal(result.encoding, ENCODING); assert.notEqual(result.leaseId, o.reader.identity.leaseId);
  assert.deepEqual(events, ['acquire', 'ensure', 'initialize', 'collect64', 'room', 'ensure', 'cleanup', 'unlock']);
  assert.equal(retained.length, 1); assert.equal(f.plane.stats().roots, baseline + 1);
  const { HistoryRootClient } = await import(pathToFileURL(path.join(ROOT, 'src/shared/history-root-read-client.mjs')));
  const child = new HistoryRootClient(f.invoke, result.payloadDocument, { pageBytes: 65536, pageItems: 3 });
  assert.equal(await body(child.text(child.root)), full);
  retained[0](); retained[0](); assert.equal(f.plane.stats().roots, baseline, 'unretained reply cleanup is exactly once');

  // Existing plain pin keeps its admitted synchronous path. The displayed
  // unit baseline tests admission/dispatch only: its codec is an explicit
  // double returning a real independent pin, not a unit-codec acceptance.
  events.length = 0; retained.length = 0;
  const plain = { ...request, nodeToken: text.nodeToken, encoding: 'plain' }; delete plain.operation; delete plain.field;
  const plainResult = await ctl.dispatch('forkHistoryRootLeaf', plain, { control, retain: cleanup => retained.push(cleanup) });
  assert.equal(plainResult.success, true); assert.deepEqual(events, ['ensure', 'cleanup']);
  assert(pinChecks >= 1); retained[0]();
  events.length = 0; retained.length = 0;
  const unitFork = f.plane.forkViewUnit;
  f.plane.forkViewUnit = async (_payload, options) => { calls.push('unit-double'); return f.plane.forkLeaf(plain, options); };
  try {
    const unit = await ctl.dispatch('forkHistoryRootLeaf', { ...request, encoding: 'history-display-unit-v8-v1' },
      { control, retain: cleanup => retained.push(cleanup) });
    assert.equal(unit.success, true); assert.equal(calls.at(-1), 'unit-double');
    assert.deepEqual(events, ['acquire', 'ensure', 'initialize', 'collect64', 'room', 'ensure', 'cleanup', 'unlock']);
    retained[0]();
  } finally { f.plane.forkViewUnit = unitFork; }
  assert.equal(f.plane.stats().roots, baseline); assert.equal(o.reader.closed, false); await o.reader.close();
});

test('actual controller preserves refusal/UNKNOWN and cleans post-allocation cancellation without replay or parent release', async t => {
  const f = await createPrimaryAddressFixture(t, { entries: [{ role: 'user', uuid: 'u', sessionId: 's', content: 'whole' }] });
  const o = await f.open(); assert.equal(o.kind, 'root');
  const row = (await o.reader.primaryCanonicalConsumers(o.header.durableMetadata, { header: o.header, scope: 'canonical' })).items[0].row;
  const request = { ...o.reader.identity, nodeToken: row.nodeToken, encoding: ENCODING, operation: 'string-falsy', field: 'content',
    _historyRootConsumerKey: f.consumerKey };
  const { instance: ctl, events } = controller(f), baseline = f.plane.stats().roots;
  let attempts = 0; const fork = f.plane.forkCanonicalConsumerValue;
  f.plane.forkCanonicalConsumerValue = function (...args) { attempts++; return fork.apply(this, args); };
  const control = { assertCurrent() {}, async checkpoint() {} };
  const room = ctl.makeRoom, refusal = failure('HISTORY_BACKING_FULL');
  ctl.makeRoom = async () => { throw refusal; };
  ctl.evictOldest = () => false;
  await assert.rejects(ctl.dispatch('forkHistoryRootLeaf', request, { control }), error => error === refusal);
  assert.equal(attempts, 0); assert.equal(events.at(-1), 'unlock'); assert.equal(f.plane.stats().roots, baseline);
  ctl.makeRoom = room;
  const unknown = failure('HISTORY_READER_TRANSPORT_UNKNOWN');
  f.plane.forkCanonicalConsumerValue = async () => { attempts++; throw unknown; };
  await assert.rejects(ctl.dispatch('forkHistoryRootLeaf', request, { control }), error => error === unknown);
  assert.equal(attempts, 1, 'UNKNOWN is not retried'); assert.equal(f.plane.stats().roots, baseline);
  f.plane.forkCanonicalConsumerValue = fork;
  let cancelled = false, cleanup;
  const aborted = failure('HISTORY_READ_CANCELLED');
  const cancellation = { assertCurrent() { if (cancelled) throw aborted; }, async checkpoint() { this.assertCurrent(); } };
  await assert.rejects(ctl.dispatch('forkHistoryRootLeaf', request, { control: cancellation,
    retain: release => { cleanup = release; cancelled = true; } }), error => error === aborted);
  assert.equal(typeof cleanup, 'function'); cleanup(); assert.equal(f.plane.stats().roots, baseline);
  assert.equal(ctl.maintenanceMetrics.cleanupErrors, 0);
  assert.equal((await o.reader.primaryCanonicalConsumers(o.header.durableMetadata,
    { header: o.header, scope: 'canonical' })).total, 1);
  await o.reader.close();
});
