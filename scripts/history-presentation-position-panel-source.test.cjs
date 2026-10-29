'use strict';
// Finite SOURCE controls. Actual bounded verbatim HistoryPanel callbacks,
// public beginHistoryResize/controller, inert primary model, position owner,
// shared client, sparse owner, prepared-frame admission and paged plane/store.
// The historical rows here deliberately have no prepared child, so the
// actual preflight chooses the preserved native compatibility adapter. The
// separate prepared-panel controls cover the selected prepared handoff.
// Synthetic boundaries: immutable finite
// input rows, DOM geometry, React hook execution, convergence scheduling and
// frozen search flag replies. No Electron/native pixel, RSS, latency claim.
// NODE_PATH=/absolute/tooling node --max-old-space-size=64 --max-semi-space-size=8 scripts/history-presentation-position-panel-source.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { pathToFileURL } = require('node:url');
const ts = require(process.env.NOTED_TEST_TYPESCRIPT || 'typescript');
const ROOT = path.resolve(__dirname, '..');
const panel = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2,
  'finite V8 TOTAL <=128MiB; use the documented command');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fragments = [];
function part(start, end, limit = 20 * 1024) {
  const a = panel.indexOf(start), b = panel.indexOf(end, a + start.length);
  assert(a >= 0 && b > a && panel.indexOf(start, a + start.length) < 0,
    'unique actual bounded Source markers: ' + start);
  const source = panel.slice(a, b), bytes = Buffer.byteLength(source);
  assert(bytes <= limit, 'no monolithic Panel parse');
  fragments.push({ start, bytes, sha256: sha(source) });
  return source;
}
function compile(source, tail = '') {
  const output = ts.transpileModule(source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.deepEqual(output.diagnostics, []);
  return new Function('env', 'with(env){\n' + output.outputText + '\n' + tail + '\n}');
}
const builder = part('  const unitIndexByUuid = useMemo(() => {', '  const unitIndexByUuidRef =');
const alias = part('  const displayEntryIndexByUuid = unitIndexByUuid;', '  const primaryHeader =');
const build = compile(builder + alias,
  'return {unitIndexByUuid,displayEntryIndexByUuid,displayEntryIndexByUuidRef};');
const registration = compile(part('  // Coordinates describe THIS native current projection', '  // Expand the group'),
  'return {primaryPositionOwner,primaryResizePosition,primaryAnchorPosition,primaryMountedPosition,primaryTimelinePosition,primaryPositionFrame,primaryPositionFrameRef,primaryPositionModeRef};');
const classifyLocal = compile(
  ['PROMPT', 'REWIND', 'COMPACT_ERROR'].map(kind => part('const LOCAL_' + kind + '_PREFIX =', '\n')).join('\n')
    + '\n' + part('const isLocalPromptEntry =', 'const findServerPromptEntry ='),
  'return entry => isLocalPromptEntry(entry) || isLocalRewindEntry(entry) || isLocalCompactErrorEntry(entry);')({});
const owner = part("    const owner = () => historyOwnerKeyRef.current + ':' + historyOwnerGenerationRef.current",
  '    const controller = createHistoryResizeController({');
const write = part('      canWritePosition: () =>', '      converge: runHistoryScrollConvergence,');
const jump = part('      jumpToKey: async (key: string, uuid: string, tail = false) => {', '      onPrepare: () => {');
const prepare = part('      onPrepare: () => {', '      onPhase: (phase: string | null) => {');
const resizeCallbacks = compile('let resizeToken = 0;\n' + owner + '\nconst options = {\n' + write + jump + prepare + '};',
  'return {...options,owner};');
const cancelRestore = part('    const cancelReasonForRestore = (', '    // A settled hunt is the one moment');
const anchor = part('    const anchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);',
  '    if (anchor?.followBottom ||');
const restoreAnchor = compile(cancelRestore + anchor, 'return "unresolved";');
const mounted = part('  // Root membership is queried for actual mounted subjects only.',
  '  // A new metadata alias or hydrated body is a real demand,');
const mountedSearch = compile(mounted);
const navigationOwns = part('    const ownsNavigation = () => scrollMountedRef.current && scrollGenRef.current === myGen',
  '    const step = async () => {');
const navigationPosition = part('      let currentIdx: number;', '      if (currentIdx < 0) {');
const timelinePosition = compile('async function selectedPosition(){\n' + navigationOwns + navigationPosition
  + '\nreturn currentIdx;\n}', 'return selectedPosition();');
const navigationLifetime = compile(part('const JUMP_STUB_HYDRATION_WAIT_MS =', '\n'),
  'return JUMP_STUB_HYDRATION_WAIT_MS;')({});
assert.equal(navigationLifetime, 20_000);
const audit = { schema: 'v52-compatibility-panel-source-audit-1', node: process.version, nodeExecutable: process.execPath,
  compiler: ts.version, heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
  sourcePanelSHA256: sha(panel), sourcePanelBytes: Buffer.byteLength(panel), fragments,
  scriptSHA256: sha(fs.readFileSync(__filename)), fixturesCleaned: 0,
  boundary: 'bounded actual SOURCE callbacks; finite React/DOM/convergence/search replies/in-process transport; no whole UI/native acceptance' };
const load = relative => import(pathToFileURL(path.join(ROOT, relative)));
const modules = Promise.all([
  load('src/renderer/utils/historyResizeController.mjs'),
  load('src/renderer/utils/historyGestureAnchor.mjs'),
  load('src/renderer/utils/historyPrimaryRootReadModel.mjs'),
  load('src/renderer/utils/historyResizeAnchor.mjs'),
  load('src/renderer/utils/historyPresentationPosition.mjs'),
  load('src/shared/history-search.mjs'),
  load('src/renderer/utils/historyPresentationOwnership.mjs'),
  load('src/renderer/utils/historyPrimaryPanelBindings.mjs'),
  load('src/renderer/utils/historyPreparedPosition.mjs'),
  load('src/renderer/utils/historyPrimarySparsePublication.mjs'),
]).then(values => Object.assign({}, ...values));
const { HistoryPagedStore } = require('../src/main/history-root-engine/main/history-paged-store');
const { HistoryRootReadPlane } = require('../src/main/history-root-engine/main/history-root-read-plane');
const Database = require('./test-support/history-node-sqlite.cjs');
const OPEN = 'agent-transcript:get-history', PAGE = 'agent-transcript:read-page';
const FORK = 'agent-transcript:fork-read-leaf', RELEASE = 'agent-transcript:release-read-root';
const CANCEL = 'agent-transcript:cancel-read';
const tick = () => new Promise(resolve => setImmediate(resolve));
const fail = code => Object.assign(new Error(code), { code });
const exact = 'hidden \0\ud800😀 ' + 'ж\udc00'.repeat(2100);
const identity = 'alias \0\ud800😀 ' + 'Я\udc00'.repeat(2100);
assert.equal(exact.length, 4212);
assert.equal(sha(Buffer.from(exact, 'utf16le')), 'b857166990fe92b35081917a0dd56d09b1aab38af985fc7ed1fe5466914f5db2');
function sourceRows() {
  const local = { uuid: 'local-prompt-current', role: 'queued' };
  const first = { uuid: 'group-first', role: 'assistant' };
  const hidden = { uuid: exact, role: 'assistant', sourceIdentity: identity };
  return { local, first, hidden, entries: [local, first, hidden],
    units: [{ kind: 'entry', entry: local }, { kind: 'group', key: 'new-work-key', entries: [first, hidden] }],
    keys: ['local-key', 'new-work-key'] };
}
function dom(uuid = exact) {
  let rows = [], width = 600;
  const inertView = { addEventListener() {}, removeEventListener() {},
    ResizeObserver: class { observe() {} disconnect() {} } };
  const doc = { defaultView: inertView, createTreeWalker: () => ({ nextNode: () => null }) };
  const oldRow = { ownerDocument: doc, dataset: { uuid, historyRowOwner: 'finite-dom-owner' },
    getBoundingClientRect: () => ({ top: 20, bottom: 60, height: 40 }),
    getAttribute: name => name === 'data-history-unit-key' ? 'old-physical-key' : name === 'data-uuid' ? uuid : null };
  rows = [oldRow];
  const scroller = { isConnected: true, scrollTop: 0, scrollHeight: 1000, clientHeight: 100,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => rows, querySelector: () => rows[0] || null, contains: row => rows.includes(row) };
  const stage = { contains: value => value === scroller, getBoundingClientRect: () => ({ width }) };
  const element = { isConnected: true, ownerDocument: doc, querySelector: () => stage,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {} };
  return { element, stage, scroller, oldRow, setRows: value => { rows = value; },
    setWidth: value => { width = value; } };
}
async function fixture(t, { rows = sourceRows(), rootNull = false, primary = true } = {}) {
  const m = await modules, d = dom(), effects = [], writes = [], notes = [], calls = [];
  const store = new HistoryPagedStore({ Database, pageBytes: 1024, indexBytes: 2048,
    residentPages: 3, sqlCacheKiB: 8, diskBytes: 16 * 1024 ** 2 });
  let sourceCalls = 0, canonicalCalls = 0, checkpoints = 0, mapReads = 0;
  const plane = new HistoryRootReadPlane({ store,
    projectHistory: async () => { sourceCalls++; throw fail('CANONICAL_SOURCE_UNAVAILABLE'); } });
  const pending = new m.HistoryPrimaryRootReadModel(() => { canonicalCalls++; throw fail('UNEXPECTED_CANONICAL_CALL'); }, {});
  assert.equal(pending.header, null); assert.equal(pending.closed, false);
  const control = { assertCurrent() {}, async checkpoint() { checkpoints++; await tick(); } };
  const f = { m, d, writes, calls, notes, effects, store, plane, pending, rows, hook: null, convergence: null };
  const route = (channel, payload) => {
    const options = { consumerKey: 'finite-actual-panel', control };
    if (channel === OPEN) return plane.openPosition(payload, options);
    if (channel === PAGE) return plane.readPage(payload, options);
    if (channel === FORK) return plane.forkPositionQuery(payload, options);
    if (channel === RELEASE) return plane.release(payload, options);
    if (channel === CANCEL) return { success: true, cancelled: true };
    throw fail('UNEXPECTED_FINITE_CHANNEL');
  };
  f.invoke = (channel, payload) => {
    calls.push({ channel, operation: payload.operation, events: payload.events?.length || 0,
      bytes: Buffer.byteLength(JSON.stringify(payload)), leaseId: payload.leaseId });
    return f.hook ? f.hook(channel, payload, route) : route(channel, payload);
  };
  const presentation = {}, historyOwnerKey = 'same-owned-presentation';
  const sparseOwner = m.createHistoryPrimarySparsePublicationOwner({ isLocal: classifyLocal });
  const localPublication = sparseOwner.publishCompatibility(rows.entries, { ownerKey: historyOwnerKey, generation: 3 });
  const env = f.env = {
    ...m, primaryPhysicalCandidate: primary, historyOwnerKey, historyOwnerVisitState: 7, fileRewriteEpoch: 0,
    displayEntries: rows.entries, displayEntriesRef: { current: rows.entries },
    displayUnits: rows.units, displayUnitsRef: { current: rows.units },
    displayUnitItemKeys: rows.keys, displayUnitItemKeysRef: { current: rows.keys },
    primaryPresentation: presentation, primaryPresentationRef: { current: presentation },
    entries: rows.entries, visibleLiveEntries: [],
    primarySparsePublicationOwner: sparseOwner, primaryLocalPublicationAtRender: localPublication,
    primaryPreparedCompatibilityRef: { current: null },
    primaryRootRef: { current: rootNull ? null : pending }, primaryInputsCurrent: () => false,
    historyOwnerKeyRef: { current: historyOwnerKey }, historyOwnerGenerationRef: { current: 3 },
    historyPresentationProofRef: { current: { visit: 7, presented: true } },
    historyUserGestureGenerationRef: { current: 0 }, mountWaveActiveRef: { current: false },
    scrollRestoreGenRef: { current: 0 }, historyRestoreInFlightRef: { current: 0 },
    historyRestoreTokenRef: { current: 0 }, initialLoadDoneRef: { current: true },
    scrollSaveTimerRef: { current: null }, terminalPreviewAnchorSettleCancelRef: { current: null },
    historyPresentationHideCleanupRef: { current: null }, historyTailPinScheduler: { cancel() {} },
    setHistoryTailFollowIntent(value) { notes.push({ followBottom: value }); },
    virtuosoScrollerRef: { current: d.scroller }, virtuosoRef: { current: { scrollToIndex: packet => writes.push(packet) } },
    panelRef: { current: d.element }, historyOwnerDomId: 'finite-dom-owner', tabId: 'finite-panel-source',
    primaryResizeAddress: { resolveKeyOrTarget() { throw fail('PENDING_ROOT_POINT_PATH'); } },
    mountedSearchDemandRef: { current: null }, searchHighlightDemandRef: { current: null },
    ipcRenderer: { invoke: f.invoke }, historyDiag: note => notes.push(note),
    useMemo: fn => fn(), useRef: current => ({ current }),
    useLayoutEffect: fn => { const cleanup = fn(); if (cleanup) effects.push(cleanup); },
    useEffect: fn => { const cleanup = fn(); if (cleanup) effects.push(cleanup); },
    runHistoryScrollConvergence: spec => { assert.equal(f.convergence, null); f.convergence = spec; },
    historyPresentationOwnsWrite: m.historyPresentationOwnsWrite,
  };
  Object.defineProperty(env, 'displayEntryIndexByUuidRef', { configurable: true,
    get() { mapReads++; throw fail('PRIMARY_MAP_REF_READ'); } });
  Object.assign(env, registration(env));
  if (primary) await waitFor(() => env.primaryPositionOwner.capture() !== null,
    'actual asynchronous compatibility admission before canonical header');
  f.publication = env.primaryPositionOwner.capture();
  if (primary) assert(f.publication, 'actual registration publishes before canonical header');
  f.counters = () => ({ mapReads, canonicalCalls, sourceCalls, checkpoints,
    owner: env.primaryPositionOwner.stats(), plane: plane.stats(), store: store.stats() });
  t.after(async () => {
    for (const cleanup of effects.reverse()) cleanup();
    for (const lane of ['primaryResizePosition', 'primaryAnchorPosition', 'primaryMountedPosition', 'primaryTimelinePosition']) env[lane].dispose();
    await env.primaryPositionOwner.dispose(); sparseOwner.close(); await pending.close(); await tick();
    plane.close(); plane.owner.close();
    assert.equal(store.stats().leases, 0); assert.equal(store.stats().activeBuilders, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n, 0);
    assert(store.stats().peakCachedPages <= 3); assert(store.stats().peakIndexBytes <= 2048);
    assert.equal(sourceCalls, 0); assert.equal(canonicalCalls, 0); assert.equal(mapReads, 0);
    assert(calls.every(call => call.bytes <= 64 * 1024 && call.events <= 3));
    store.close(); audit.fixturesCleaned++;
  });
  return f;
}
function activateResize(f) {
  const cb = resizeCallbacks(f.env), frames = [];
  const controller = f.m.createHistoryResizeController({ root: f.d.element,
    getScroller: () => f.env.virtuosoScrollerRef.current, getOwner: cb.owner,
    isPresented: () => f.env.historyPresentationProofRef.current.presented,
    getFollowBottom: () => false, isPositionBusy: () => false,
    canWritePosition: cb.canWritePosition, isContentReady: cb.isContentReady,
    jumpToKey: cb.jumpToKey, onPrepare: cb.onPrepare, onPhase() {}, onFinish() {},
    converge: spec => { f.convergence = spec; }, requestFrame: fn => (frames.push(fn), frames.length),
    cancelFrame() {}, setTimer() { throw fail('UNEXPECTED_RESIZE_TIMER'); }, clearTimer() {} });
  f.effects.push(() => controller.dispose());
  const finish = f.m.beginHistoryResize({ contains: root => root === f.d.element }, 'finite-source-v51');
  assert.equal(controller.active(), true); f.d.setRows([]); f.d.setWidth(700); finish(true);
  assert(f.convergence); assert.equal(f.convergence.cancelled(), null);
  return { cb, controller };
}
async function waitFor(predicate, label, limit = 300) {
  for (let iteration = 0; iteration < limit; iteration++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('finite synthetic completion bound: ' + label);
}
function gateFork(f) {
  let release, entered = false;
  const wait = new Promise(resolve => { release = resolve; });
  f.hook = async (channel, payload, route) => {
    if (channel === FORK) { const reply = await route(channel, payload); entered = true; await wait; return reply; }
    return route(channel, payload);
  };
  return { entered: () => entered, release: () => { f.hook = null; release(); } };
}

test('actual primary producer is absent; aliases remain one genuine legacy Map with exact last duplicate/local semantics', () => {
  const rows = sourceRows(); let allocations = 0;
  class PoisonMap { constructor() { allocations++; throw fail('PRIMARY_MAP_ALLOCATION'); } }
  const primary = build({ displayUnits: rows.units, primaryPhysicalCandidate: true,
    useMemo: fn => fn(), useRef: current => ({ current }), Map: PoisonMap });
  assert.equal(primary.unitIndexByUuid, null); assert.equal(primary.displayEntryIndexByUuid, null);
  assert.equal(primary.displayEntryIndexByUuidRef.current, null); assert.equal(allocations, 0);
  const units = [...rows.units, { kind: 'entry', entry: { uuid: 1 } }, { kind: 'entry', entry: { uuid: '1' } },
    { kind: 'entry', entry: { uuid: 'dup' } }, { kind: 'group', entries: [{ uuid: 'dup' }] }];
  const legacy = build({ displayUnits: units, primaryPhysicalCandidate: false,
    useMemo: fn => fn(), useRef: current => ({ current }) });
  assert(legacy.unitIndexByUuid instanceof Map);
  assert.equal(legacy.displayEntryIndexByUuid, legacy.unitIndexByUuid);
  assert.equal(legacy.displayEntryIndexByUuidRef.current, legacy.unitIndexByUuid);
  for (const [uuid, index] of [[exact, 1], ['local-prompt-current', 0], [1, 2], ['1', 3], ['dup', 5]]) {
    assert.equal(legacy.unitIndexByUuid.get(uuid), index);
  }
  assert.equal(legacy.unitIndexByUuid.has(identity), false, 'alias does not become a UUID member');
});

test('supplied actual pending counter becomes POSITIVE after primary Map retirement', async t => {
  const f = await fixture(t), { cb } = activateResize(f);
  assert.equal(f.pending.header, null); assert.equal(f.pending.closed, false);
  assert.equal(f.env.primaryInputsCurrent(), false);
  assert.equal(cb.canWritePosition(), true); assert.equal(cb.isContentReady({ kind: 'row' }), true);
  assert.equal(f.convergence.measureDrift(), null);
  assert.equal(await f.convergence.jump(), true);
  assert.deepEqual(f.writes, [{ index: 1, align: 'start', behavior: 'auto' }]);
  const counters = f.counters();
  assert.equal(counters.owner.unitVisits, 2); assert.equal(counters.owner.memberVisits, 3);
  assert.equal(counters.owner.registrations, 1); assert.equal(counters.owner.queries, 1);
  assert.equal(counters.owner.nativeCoordinateMaps, 0); assert.equal(counters.mapReads, 0);
  const visits = counters.owner.memberVisits;
  assert.equal(await f.convergence.jump(), true);
  assert.equal(f.counters().owner.memberVisits, visits, 'covered demand never replays N');
  assert.equal(f.counters().owner.queries, 1);
  audit.pendingCounter = { status: 'PRIMARY_PENDING_COUNTER_POSITIVE_MAP_RETIRED', exactUUIDUTF16: exact.length,
    exactUUIDSHA256: sha(Buffer.from(exact, 'utf16le')), actualCallerCounters: counters,
    boundaries: ['actual bounded Panel registration/resize/onPrepare', 'actual public begin/controller and inert model',
      'actual position owner/client/plane/paged store', 'finite DOM/convergence and in-process channel router'],
    liveWrites: 0, nativePixelsMeasured: false, canonicalSourceCalls: 0 };
  t.diagnostic(JSON.stringify({ status: audit.pendingCounter.status, exactUUIDUTF16: exact.length,
    ownerCounters: counters.owner, primaryMapReads: counters.mapReads, canonicalSourceCalls: counters.sourceCalls }));
});

test('actual resize keeps key-first and genuine legacy fallback without a position demand', async t => {
  const f = await fixture(t), { cb } = activateResize(f);
  f.env.displayUnitItemKeysRef.current = ['old-physical-key'];
  assert.equal(await cb.jumpToKey('old-physical-key', exact), true);
  assert.equal(f.writes.at(-1).index, 0); assert.equal(f.counters().owner.queries, 0);
  f.env.primaryPositionModeRef.current = false; f.env.primaryPhysicalCandidate = false;
  f.env.primaryRootRef.current = null; f.env.displayUnitItemKeysRef.current = ['local-key', 'new-work-key'];
  const legacy = build({ displayUnits: f.rows.units, primaryPhysicalCandidate: false,
    useMemo: fn => fn(), useRef: current => ({ current }) });
  Object.defineProperty(f.env, 'displayEntryIndexByUuidRef', { value: legacy.displayEntryIndexByUuidRef });
  assert.equal(await cb.jumpToKey('old-physical-key', exact), true);
  assert.equal(f.writes.at(-1).index, 1); assert.equal(f.counters().owner.queries, 0);
});

test('actual ready Root point path and pending-input write guard remain distinct', async t => {
  const f = await fixture(t), { cb } = activateResize(f); let readyCalls = 0;
  const header = {}, ready = { header, totalCount: 8 };
  f.env.primaryRootRef.current = ready; f.env.primaryInputsCurrent = () => false;
  assert.equal(cb.canWritePosition(), false); assert.equal(await cb.jumpToKey('missing', exact), true);
  assert.equal(f.writes.length, 0);
  f.env.primaryInputsCurrent = () => true;
  f.env.primaryResizeAddress = { async resolveKeyOrTarget(root, key, uuid, options) {
    readyCalls++; assert.equal(root, ready); assert.equal(uuid, exact); assert.equal(options.owns(), true);
    return { status: 'ready', address: { index: 6 } };
  } };
  assert.equal(await cb.jumpToKey('missing', exact), true);
  assert.equal(f.writes.at(-1).index, 6); assert.equal(readyCalls, 1);
  assert.equal(f.counters().owner.queries, 0);
});

test('actual resize discards original awaited owner/visit/gesture/scroller/rows/restore replacement', async t => {
  const changes = [
    ['owner', e => { e.historyOwnerKeyRef.current = 'replacement'; }],
    ['generation', e => { e.historyOwnerGenerationRef.current++; }],
    ['visit', e => { e.historyPresentationProofRef.current = { visit: 8, presented: true }; }],
    ['gesture', e => { e.historyUserGestureGenerationRef.current++; }],
    ['scroller', e => { e.virtuosoScrollerRef.current = { isConnected: true }; }],
    // Future preparation input alone is not the displayed coordinate frame.
    // The independent R1 repair controls prove that input-only updates keep
    // the original query; replacement of actual displayed rows still revokes.
    ['rows', e => { e.displayEntriesRef.current = []; }],
    ['restore', e => { e.historyRestoreInFlightRef.current++; }],
  ];
  for (const [name, change] of changes) await t.test(name, async t => {
    const f = await fixture(t); await f.publication.promise; activateResize(f);
    const gate = gateFork(f), jumped = f.convergence.jump();
    await waitFor(gate.entered, name + ' query entered'); change(f.env); gate.release();
    assert.equal(await jumped, true); assert.equal(f.writes.length, 0);
    assert.equal(f.counters().owner.queries, 1);
  });
});

test('actual retained resize keeps its original query across same-frame model/header/null/close changes', async t => {
  for (const name of ['model', 'header', 'null', 'close']) await t.test(name, async t => {
    const f = await fixture(t); await f.publication.promise; activateResize(f);
    // Only this header fixture is mutable. The model replacement and close
    // cases use the actual inert model, without a canonical source read.
    if (name === 'header') f.env.primaryRootRef.current = { header: null };
    const publication = f.publication, frame = f.env.primaryPositionFrameRef.current;
    const restoreToken = f.env.historyRestoreInFlightRef.current;
    const gate = gateFork(f), jumped = f.convergence.jump();
    try {
      await waitFor(gate.entered, 'retained resize ' + name + ' query entered');
      if (name === 'model') {
        const next = new f.m.HistoryPrimaryRootReadModel(() => { throw fail('UNEXPECTED_CANONICAL_CALL'); }, {});
        f.env.primaryRootRef.current = next; t.after(() => next.close());
      } else if (name === 'header') f.env.primaryRootRef.current.header = {};
      else if (name === 'null') f.env.primaryRootRef.current = null;
      else await f.pending.close();
      assert.equal(f.env.primaryPositionOwner.capture(), publication);
      assert.equal(f.env.primaryPositionFrameRef.current, frame);
      assert.equal(f.env.historyRestoreInFlightRef.current, restoreToken);
      assert.equal(f.convergence.cancelled(), null); assert.equal(f.writes.length, 0);
      gate.release(); assert.equal(await jumped, true);
      assert.deepEqual(f.writes, [{ index: 1, align: 'start', behavior: 'auto' }]);
      assert.equal(f.counters().owner.queries, 1); assert.equal(f.counters().owner.registrations, 1);
      (audit.sameFrameRetainedResize ||= []).push({ change: name, originalQueryCompleted: true,
        registrations: 1, queries: 1, preservedRestoreToken: true, selectedIndex: 1 });
    } finally { gate.release(); }
  });
});

function installAnchor(f, uuid = exact, offsetPx = -17.25) {
  const e = f.env;
  Object.assign(e, { scrollPositionKeyRef: { current: 'finite-anchor-key' },
    getHistoryReadingAnchor: () => ({ uuid, offsetPx, followBottom: false }),
    presentationAtRestore: e.historyPresentationProofRef.current,
    primaryAnchorReady: false, primaryAnchorResolution: null,
    settleRestoreAndBankGeometry() {}, CSS: { escape: value => value } });
  assert.equal(restoreAnchor(e), undefined, 'actual retained branch starts original convergence');
  assert(f.convergence); return f.convergence;
}

test('actual Root-null saved-anchor starts original convergence, resolves hidden UUID and preserves fractional offset', async t => {
  const f = await fixture(t, { rootNull: true }), convergence = installAnchor(f);
  assert.equal(f.writes.length, 0); assert.equal(convergence.cancelled(), null);
  assert.equal(convergence.measureDrift(), null, 'coordinate proof awaited inside jump');
  assert.equal(await convergence.jump(), true);
  assert.deepEqual(f.writes, [{ index: 1, align: 'start', behavior: 'auto', offset: -17.25 }]);
  assert.equal(convergence.measureDrift(), 2.75);
  assert.equal(f.counters().owner.queries, 1);
  assert.equal(await convergence.jump(), true); assert.equal(f.counters().owner.queries, 1);
});

test('actual Root-null saved-anchor absence and UNKNOWN cannot invent a position or tail', async t => {
  await t.test('proved current absence', async t => {
    const f = await fixture(t, { rootNull: true }), convergence = installAnchor(f, 'canonical-only-not-current', 33.5);
    assert.equal(await convergence.jump(), false); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.notes.filter(note => typeof note === 'object'), [{ followBottom: false }]);
  });
  await t.test('UNKNOWN stays failed without retry', async t => {
    const f = await fixture(t, { rootNull: true }); await f.publication.promise;
    let targets = 0;
    f.hook = (channel, payload, route) => {
      if (channel === PAGE && payload.operation === 'target') { targets++; throw fail('HISTORY_READER_TRANSPORT_UNKNOWN'); }
      return route(channel, payload);
    };
    const convergence = installAnchor(f, 'local-prompt-current', 33.5);
    await assert.rejects(convergence.jump(), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
    await assert.rejects(convergence.jump(), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
    assert.equal(targets, 1); assert.equal(f.writes.length, 0);
  });
});

test('actual saved-anchor await keeps original visit/gesture/projection/scroller and no recapture', async t => {
  for (const [name, change] of [
    ['visit', e => { e.historyPresentationProofRef.current = { visit: 8, presented: true }; }],
    ['gesture', e => { e.historyUserGestureGenerationRef.current++; }],
    ['projection', e => { e.primaryPositionFrameRef.current = {}; }],
    ['scroller', e => { e.virtuosoScrollerRef.current = { isConnected: true }; }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { rootNull: true }); await f.publication.promise;
    const convergence = installAnchor(f), gate = gateFork(f), jumped = convergence.jump();
    await waitFor(gate.entered, name + ' anchor entered'); change(f.env); gate.release();
    assert.equal(await jumped, true); assert.equal(f.writes.length, 0);
  });
});

function installMounted(f, { matchKey = identity, collect = null } = {}) {
  let state = null, retains = 0, releases = 0, published = 0, flagsCalls = [], error = null;
  const client = { retain() { retains++; let released = false; return async () => { if (!released) { released = true; releases++; } }; },
    async entryFlags(batch) { assert(batch.length <= 3); flagsCalls.push(batch.slice());
      return batch.map(entryUuid => ({ entryUuid, match: entryUuid === matchKey })); } };
  Object.assign(f.env, { searchResult: { searchClient: client }, searchActive: true, searchRequest: {},
    setMountedSearchRows(next) { published++; state = typeof next === 'function' ? next(state) : next; },
    setSearchError(value) { error = value; },
    MutationObserver: class { constructor(fn) { this.callback = fn; } observe() {} disconnect() {} },
    collectHistoryPrimaryMountedSearchSubjects: collect || (() => { throw fail('ROOT_NULL_SEARCH_USED_ROOT'); }) });
  mountedSearch(f.env);
  return { client, stats: () => ({ state, retains, releases, published, flagsCalls, error }) };
}

test('actual Root-null mounted search resolves full alias of last unit/first duplicate member and evicts coverage', async t => {
  const rows = sourceRows();
  const wrongEarly = { uuid: exact, role: 'assistant', sourceIdentity: 'wrong-earlier-unit' };
  const wrongDuplicate = { uuid: exact, role: 'assistant', sourceIdentity: 'wrong-later-member' };
  rows.units = [{ kind: 'entry', entry: wrongEarly }, rows.units[0],
    { kind: 'group', entries: [rows.first, rows.hidden, wrongDuplicate] }];
  rows.keys = ['earlier', 'local-key', 'physical-sub-or-work']; rows.entries = [wrongEarly, rows.local, rows.first, rows.hidden, wrongDuplicate];
  const f = await fixture(t, { rows, rootNull: true }), search = installMounted(f);
  await waitFor(() => search.stats().state?.matches.has(exact) && search.stats().retains === search.stats().releases, 'mounted full alias');
  const result = search.stats(); assert.equal(result.error, null);
  assert.deepEqual(result.flagsCalls.flat(), [exact, identity]);
  assert.equal(f.counters().owner.unitVisits, 3); assert.equal(f.counters().owner.memberVisits, 5);
  assert.equal(f.counters().owner.queries, 1);
  const visits = f.counters().owner.memberVisits;
  for (let n = 0; n < 25; n++) f.env.mountedSearchDemandRef.current();
  await waitFor(() => search.stats().retains === search.stats().releases, 'reentrant demand');
  assert.equal(search.stats().flagsCalls.length, 1); assert.equal(f.counters().owner.memberVisits, visits);
  f.d.setRows([]); f.env.mountedSearchDemandRef.current();
  await waitFor(() => search.stats().state?.matches.size === 0 && search.stats().retains === search.stats().releases, 'unmounted eviction');
  f.d.setRows([f.d.oldRow]); f.env.mountedSearchDemandRef.current();
  await waitFor(() => search.stats().flagsCalls.length === 2 && search.stats().state?.matches.has(exact)
    && search.stats().retains === search.stats().releases, 'reentry demand');
  assert.equal(f.counters().owner.memberVisits, visits, 'mounted recapture never scans whole group');
  audit.mountedSearch = { actualMountedCaller: { batches: search.stats().flagsCalls.length,
    flagKeys: search.stats().flagsCalls.reduce((sum, batch) => sum + batch.length, 0),
    retains: search.stats().retains, releases: search.stats().releases }, counters: f.counters() };
  t.diagnostic(JSON.stringify({ mountedCaller: audit.mountedSearch.actualMountedCaller,
    ownerCounters: audit.mountedSearch.counters.owner }));
});

test('actual mounted search refuses stale original projection/DOM/visit/gesture rather than empty proof', async t => {
  for (const [name, change] of [
    ['projection', f => { f.env.primaryPositionFrameRef.current = {}; }],
    ['visit', f => { f.env.historyPresentationProofRef.current = { visit: 8, presented: true }; }],
    ['gesture', f => { f.env.historyUserGestureGenerationRef.current++; }],
    ['DOM', f => { f.d.setRows([]); }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { rootNull: true }); await f.publication.promise;
    const gate = gateFork(f), search = installMounted(f);
    await waitFor(gate.entered, name + ' mounted entered'); change(f); gate.release();
    await waitFor(() => search.stats().retains === search.stats().releases, 'mounted refused releases');
    assert.equal(search.stats().published, 0); assert.equal(search.stats().flagsCalls.length, 0);
    assert.equal(search.stats().error, null); assert.equal(f.writes.length, 0);
  });
});

test('actual retained mounted search keeps original same-frame query across model/header/close changes', async t => {
  for (const name of ['model', 'header', 'close']) await t.test(name, async t => {
    const f = await fixture(t, { rootNull: true }); await f.publication.promise;
    if (name === 'header') f.env.primaryRootRef.current = { header: null };
    const publication = f.publication, frame = f.env.primaryPositionFrameRef.current;
    const gate = gateFork(f), search = installMounted(f);
    try {
      await waitFor(gate.entered, 'retained mounted ' + name + ' entered');
      if (name === 'model') f.env.primaryRootRef.current = f.pending;
      else if (name === 'header') f.env.primaryRootRef.current.header = {};
      else await f.pending.close();
      gate.release();
      await waitFor(() => search.stats().state?.matches.has(exact)
        && search.stats().retains === search.stats().releases, 'original retained aliases ' + name);
      assert.equal(f.env.primaryPositionOwner.capture(), publication);
      assert.equal(f.env.primaryPositionFrameRef.current, frame);
      assert.deepEqual(search.stats().flagsCalls.flat(), [exact, identity]);
      assert.equal(search.stats().error, null); assert.equal(f.counters().owner.queries, 1);
      assert.equal(f.counters().owner.registrations, 1);
      (audit.sameFrameRetainedMounted ||= []).push({ change: name, originalQueryCompleted: true,
        fullAliasUTF16: identity.length, queries: 1, registrations: 1 });
    } finally { gate.release(); }
  });
});

test('actual ready-root mounted capture rejects root/header/frame replacement across its new await boundary', async t => {
  for (const name of ['root', 'header', 'frame']) await t.test(name, async t => {
    const f = await fixture(t), e = f.env; await f.publication.promise;
    // Finite ready-Root/DOM fixture; actual collector and Panel effect run.
    // The replacement is scheduled from renderSnapshot, after capture's
    // synchronous body but before its caller's awaited continuation.
    const window = new Map([[0, { kind: 'entry', entry: f.rows.hidden }]]);
    const snapshot = { window }, root = { header: {}, closed: false,
      renderSnapshot() {
        queueMicrotask(() => {
          if (name === 'root') e.primaryRootRef.current = f.pending;
          else if (name === 'header') root.header = {};
          else e.primaryPositionFrameRef.current = {};
        });
        return snapshot;
      },
      addressAt() { return { physicalKey: 'old-physical-key' }; },
      matchesSnapshotUnit: () => true };
    f.d.oldRow.closest = () => ({ getAttribute: () => '0' });
    e.primaryRootRef.current = root; e.primaryInputsCurrent = () => true;
    const search = installMounted(f, { collect: f.m.collectHistoryPrimaryMountedSearchSubjects });
    await waitFor(() => search.stats().retains > 0 && search.stats().retains === search.stats().releases,
      'ready capture replaced ' + name);
    assert.equal(search.stats().published, 0); assert.equal(search.stats().flagsCalls.length, 0);
    assert.equal(search.stats().error, null); assert.equal(f.counters().owner.queries, 0);
  });
});

function installTimeline(f) {
  const finishes = [], frames = [], errors = [], state = { historyScrollRequestGeneration: 12 };
  Object.assign(f.env, { navigationRoot: null, navigationAddress: null, targetUuid: exact,
    scrollMountedRef: { current: true }, scrollGenRef: { current: 4 }, myGen: 4,
    ownerAtStart: f.env.historyOwnerKeyRef.current, userGeneration: 0, requestGeneration: 12,
    useUIStore: { getState: () => state }, startedAt: 100, JUMP_STUB_HYDRATION_WAIT_MS: navigationLifetime,
    performance: { now: () => 200 }, requestAnimationFrame: fn => (frames.push(fn), frames.length),
    step() {}, finish: (ok, reason) => finishes.push({ ok, reason }),
    setHistoryLoadError: error => errors.push(error) });
  return { finishes, frames, errors, state, select: () => timelinePosition(f.env) };
}

test('actual continuing legacy-started Timeline branch resolves new primary coordinates without a Map', async t => {
  const f = await fixture(t), nav = installTimeline(f);
  assert.equal(await nav.select(), 1);
  assert.equal(nav.finishes.length, 0); assert.equal(nav.frames.length, 0); assert.equal(nav.errors.length, 0);
  assert.equal(f.counters().owner.queries, 1);
  assert.equal(await nav.select(), 1); assert.equal(f.counters().owner.queries, 1);
  assert.equal(f.env.startedAt, 100); assert.equal(f.env.requestGeneration, 12);
});

test('actual Timeline coordinate await keeps original request/gesture/visit and original deadline', async t => {
  for (const name of ['request', 'gesture', 'visit', 'original-deadline']) await t.test(name, async t => {
    const f = await fixture(t); await f.publication.promise;
    const nav = installTimeline(f), gate = gateFork(f), selected = nav.select();
    await waitFor(gate.entered, 'Timeline ' + name);
    if (name === 'gesture') f.env.historyUserGestureGenerationRef.current++;
    else if (name === 'visit') f.env.historyPresentationProofRef.current.visit++;
    else if (name === 'request') nav.state.historyScrollRequestGeneration++;
    if (name === 'original-deadline') {
      f.env.performance.now = () => f.env.startedAt + navigationLifetime + 1;
      assert.equal(f.env.historyPresentationProofRef.current.visit, 7);
      assert.equal(nav.state.historyScrollRequestGeneration, 12);
    }
    gate.release(); assert.equal(await selected, undefined);
    assert.equal(f.writes.length, 0); assert.equal(nav.errors.length, 0);
    if (name === 'gesture' || name === 'request') assert.deepEqual(nav.finishes, [{ ok: false, reason: 'source-jump-cancelled' }]);
    else if (name === 'original-deadline') assert.deepEqual(nav.finishes, [{ ok: false, reason: 'target-address-timeout' }]);
    else { assert.equal(nav.finishes.length, 0); assert.equal(nav.frames.length, 1); }
    assert.equal(f.env.startedAt, 100); assert.equal(f.env.requestGeneration, 12);
    if (name === 'original-deadline') {
      assert.equal(f.env.primaryPositionOwner.owns(f.publication), true);
      audit.timelineDeadlineOnlyHeldQuery = { originalStartedAt: 100, lifetimeMs: navigationLifetime,
        syntheticNow: f.env.performance.now(), ownerVisitFrameModelRequestUnchanged: true,
        returnedIndex: null, reason: nav.finishes[0].reason, coordinateParentRetained: true };
    }
  });
});

test('actual Timeline delayed genuine successful coordinate cannot continue after its original twenty-second lifetime', async t => {
  const f = await fixture(t); await f.publication.promise;
  const nav = installTimeline(f), lane = f.env.primaryTimelinePosition;
  const publication = f.env.primaryPositionOwner.capture(), frame = f.env.primaryPositionFrameRef.current;
  const model = f.env.primaryRootRef.current, visit = f.env.historyPresentationProofRef.current.visit;
  let deliveredSelection = null, deliver;
  const held = new Promise(resolve => { deliver = resolve; });
  // Only response delivery is held. The actual lane, owner, client, plane and
  // store resolve the exact long UUID and produce their genuine READY proof.
  f.env.primaryTimelinePosition = { ...lane, async resolve(...args) {
    const selected = await lane.resolve(...args);
    assert.equal(selected.status, 'ready'); assert.equal(selected.address.index, 1);
    deliveredSelection = selected;
    await held;
    return selected;
  } };
  const selected = nav.select();
  await waitFor(() => deliveredSelection !== null, 'real ready coordinate held before caller delivery');
  assert.equal(f.counters().owner.queries, 1);
  f.env.performance.now = () => f.env.startedAt + navigationLifetime + 1;
  assert.equal(f.env.primaryPositionOwner.capture(), publication);
  assert.equal(f.env.primaryPositionFrameRef.current, frame);
  assert.equal(f.env.primaryRootRef.current, model);
  assert.equal(f.env.historyPresentationProofRef.current.visit, visit);
  assert.equal(nav.state.historyScrollRequestGeneration, 12);
  deliver();
  assert.equal(await selected, undefined);
  assert.equal(deliveredSelection.status, 'ready', 'late successful proof is still a genuine success');
  assert.deepEqual(nav.finishes, [{ ok: false, reason: 'target-address-timeout' }]);
  assert.equal(nav.frames.length, 0); assert.equal(nav.errors.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.env.startedAt, 100); assert.equal(f.env.requestGeneration, 12);
  assert.equal(f.env.primaryPositionOwner.owns(publication), true);
  assert.equal(f.plane.stats().roots, 1);
  audit.timelineDelayedSuccess = { actualSelectedStatus: deliveredSelection.status, actualSelectedIndex: 1,
    originalStartedAt: 100, lifetimeMs: navigationLifetime, syntheticNow: f.env.performance.now(),
    ownerVisitFrameModelRequestUnchanged: true, returnedIndex: null, writerCalls: 0,
    rescheduledFrames: 0, reason: nav.finishes[0].reason, coordinateParentRetained: true,
    boundary: 'finite clock advance and held delivery of a genuine real-query selected result' };
});

test('actual Timeline already-expired original lifetime admits no coordinate query or renewed attempt', async t => {
  const f = await fixture(t); await f.publication.promise;
  const nav = installTimeline(f), before = f.calls.length;
  f.env.performance.now = () => f.env.startedAt + navigationLifetime + 1;
  assert.equal(await nav.select(), undefined);
  assert.deepEqual(nav.finishes, [{ ok: false, reason: 'target-address-timeout' }]);
  assert.equal(f.counters().owner.queries, 0); assert.equal(f.calls.length, before);
  assert.equal(nav.frames.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.env.startedAt, 100); assert.equal(f.env.primaryPositionOwner.owns(f.publication), true);
  audit.timelineExpiredAdmission = { originalStartedAt: 100, lifetimeMs: navigationLifetime,
    syntheticNow: f.env.performance.now(), queries: 0, writerCalls: 0, rescheduledFrames: 0,
    reason: nav.finishes[0].reason };
});

test('actual Timeline exact original lifetime boundary still accepts a genuine coordinate success', async t => {
  const f = await fixture(t); await f.publication.promise;
  const nav = installTimeline(f);
  f.env.performance.now = () => f.env.startedAt + navigationLifetime;
  assert.equal(await nav.select(), 1);
  assert.equal(f.counters().owner.queries, 1);
  assert.equal(nav.finishes.length, 0); assert.equal(nav.frames.length, 0); assert.equal(nav.errors.length, 0);
  assert.equal(f.env.startedAt, 100); assert.equal(f.env.requestGeneration, 12);
  audit.timelineExactBoundary = { originalStartedAt: 100, lifetimeMs: navigationLifetime,
    syntheticNow: f.env.performance.now(), selectedIndex: 1, queries: 1 };
});

for (const heldKind of ['fork', 'target']) test('actual Timeline original deadline settles while real ' + heldKind + ' ACK remains held and late cleanup is exact', async t => {
  const f = await fixture(t); await f.publication.promise;
  const nav = installTimeline(f), publication = f.publication;
  const timers = [], active = new Map(); let timerSerial = 0, clearCalls = 0;
  f.env.setTimeout = (callback, delay) => {
    const timer = { id: ++timerSerial, callback, delay }; timers.push(timer); active.set(timer.id, timer); return timer.id;
  };
  f.env.clearTimeout = id => { clearCalls++; active.delete(id); };
  let entered = false, delivered = false, childId = null, release;
  const held = new Promise(resolve => { release = resolve; });
  f.hook = async (channel, payload, route) => {
    const reply = await route(channel, payload);
    const selected = heldKind === 'fork' ? channel === FORK : channel === PAGE && payload.operation === 'target';
    if (selected && !entered) {
      childId = heldKind === 'fork' ? reply.leaseId : payload.leaseId;
      entered = true; await held;
    }
    return reply;
  };
  let callerSettled = false;
  const selection = nav.select().then(value => { callerSettled = true; return value; });
  try {
    await waitFor(() => entered, 'actual ' + heldKind + ' server work completed and ACK held');
    assert.equal(callerSettled, false); assert.equal(timers.length, 1); assert.equal(active.size, 1);
    assert.equal(timers[0].delay, navigationLifetime - (200 - 100) + 1);
    assert.equal(f.plane.stats().roots, 2, 'real independent query child exists before deadline');
    f.env.performance.now = () => f.env.startedAt + navigationLifetime + 1;
    timers[0].callback();
    await waitFor(() => callerSettled, 'original deadline settles caller while raw ACK is still held');
    assert.equal(delivered, false); assert.equal(await selection, undefined);
    assert.deepEqual(nav.finishes, [{ ok: false, reason: 'target-address-timeout' }]);
    assert.equal(nav.frames.length, 0); assert.equal(nav.errors.length, 0); assert.equal(f.writes.length, 0);
    assert.equal(active.size, 0); assert.equal(clearCalls, 1); assert.equal(timers.length, 1);
    assert.equal(f.env.startedAt, 100); assert.equal(f.env.primaryPositionOwner.owns(publication), true);
    const releases = () => f.calls.filter(call => call.channel === RELEASE && call.leaseId === childId).length;
    if (heldKind === 'fork') {
      assert.equal(releases(), 0, 'unobserved raw fork identity is retained for its own eventual cleanup');
      const other = await f.env.primaryResizePosition.resolve(publication, exact, { owns: () => true });
      assert.equal(other.status, 'ready'); assert.equal(other.address.index, 1);
      assert.equal(delivered, false, 'independent consumer succeeds while first raw allocation ACK remains held');
    } else {
      await waitFor(() => releases() === 1 && f.plane.stats().roots === 1, 'known target child cleanup without waiting for target reply');
    }
    delivered = true; release();
    await waitFor(() => releases() === 1 && f.plane.stats().roots === 1
      && f.env.primaryTimelinePosition.stats().running === 0, 'exact late child cleanup');
    await tick(); assert.equal(releases(), 1);
    assert.equal(f.env.primaryPositionOwner.owns(publication), true);
    assert.equal(f.writes.length, 0); assert.equal(f.env.startedAt, 100);
    (audit.timelineHeldAcknowledgments ||= []).push({ heldKind, originalStartedAt: 100,
      lifetimeMs: navigationLifetime, syntheticNow: f.env.performance.now(),
      callerSettledWhileAckHeld: true, reason: nav.finishes[0].reason,
      oneOriginalDeadlineTimer: timers.length, timerCleared: clearCalls,
      childCleanupAttempts: releases(), parentRetained: true, rescheduledFrames: 0,
      independentLaneWhileForkAckHeld: heldKind === 'fork', writerCalls: 0,
      boundary: 'actual query/server capability; only reply delivery and the original-deadline timer/clock are synthetic' });
  } finally { delivered = true; release(); f.hook = null; }
});

test('actual legacy Root-null saved-anchor and mounted-search retain the original Map capability', async t => {
  const f = await fixture(t, { rootNull: true, primary: false });
  const legacy = build({ displayUnits: f.rows.units, primaryPhysicalCandidate: false,
    useMemo: fn => fn(), useRef: current => ({ current }) });
  let reads = 0; const get = legacy.unitIndexByUuid.get.bind(legacy.unitIndexByUuid);
  legacy.unitIndexByUuid.get = uuid => { reads++; return get(uuid); };
  Object.defineProperty(f.env, 'displayEntryIndexByUuidRef', { value: legacy.displayEntryIndexByUuidRef });
  const convergence = installAnchor(f, exact, 0.375);
  assert.equal(await convergence.jump(), true);
  assert.deepEqual(f.writes, [{ index: 1, align: 'start', behavior: 'auto', offset: 0.375 }]);
  const search = installMounted(f);
  await waitFor(() => search.stats().state?.matches.has(exact) && search.stats().retains === search.stats().releases,
    'legacy exact alias');
  assert.deepEqual(search.stats().flagsCalls.flat(), [exact, identity]); assert(reads >= 3);
  assert.equal(f.counters().owner.registrations, 0); assert.equal(f.calls.length, 0);
});

test('actual pending resize UNKNOWN surfaces failure once and retains the coordinate parent', async t => {
  const f = await fixture(t); await f.publication.promise; activateResize(f);
  let targets = 0;
  f.hook = (channel, payload, route) => {
    if (channel === PAGE && payload.operation === 'target') { targets++; throw fail('HISTORY_READER_TRANSPORT_UNKNOWN'); }
    return route(channel, payload);
  };
  await assert.rejects(f.convergence.jump(), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  await assert.rejects(f.convergence.jump(), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  assert.equal(targets, 1); assert.equal(f.writes.length, 0); assert.equal(f.plane.stats().roots, 1);
  assert.equal(f.env.primaryPositionOwner.owns(f.publication), true);
});

test.after(() => {
  audit.allTestCallbacksCompleted = true;
  // Full diagnostic objects are a separate optional scratch artifact. The
  // TAP stream stays compact so older Node reporters flush every test and
  // terminal count even after large UTF16/counter fixtures.
  if (process.env.V51_PANEL_RESULT) fs.writeFileSync(process.env.V51_PANEL_RESULT, JSON.stringify(audit, null, 2) + '\n');
  console.log('PANEL_SOURCE_AUDIT_COMPLETE ' + JSON.stringify({ fixturesCleaned: audit.fixturesCleaned,
    sourcePanelSHA256: audit.sourcePanelSHA256, node: audit.node, heapLimitBytes: audit.heapLimitBytes }));
});
