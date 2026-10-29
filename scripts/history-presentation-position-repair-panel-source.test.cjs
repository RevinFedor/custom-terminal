'use strict';
// Original r3 preserving-contract controls with V52 fixture adaptation.
// Reuses the pinned adapted finite fixture prefix; actual Panel callbacks,
// merge/group cache, controller/model/position owner/client/plane/store load
// from THIS candidate. React cells, DOM, scheduling and delivery are finite
// synthetic boundaries. No native/whole-UI/CPU/RSS/latency acceptance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url'), test = require('node:test'), v8 = require('node:v8');
const ROOT = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2);
function makeHooks(effects) {
  const mem = [], refs = [], layouts = []; let mi = 0, ri = 0, li = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return { begin() { mi = ri = li = 0; },
    useMemo(fn, deps) { const i = mi++; if (!mem[i] || !same(mem[i].deps, deps)) mem[i] = { deps: [...deps], value: fn() }; return mem[i].value; },
    useRef(value) { const i = ri++; if (!refs[i]) refs[i] = { current: value }; return refs[i]; },
    useLayoutEffect(fn, deps) { const i = li++, old = layouts[i]; if (old && same(old.deps, deps)) return;
      old?.cleanup?.(); layouts[i] = { deps: [...deps], cleanup: fn() };
      if (!old) effects.push(() => layouts[i]?.cleanup?.()); },
  };
}
const fixtureFile = path.join(__dirname, 'history-presentation-position-panel-source.test.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const cut = fixtureSource.indexOf("\ntest('actual primary producer is absent;");
assert(cut > 0);
const suppliedV51FixturePrefixSHA256 = '93100cc885392d3146c08e3332d2a211826117fe1ac5603baeef143d6d57e411';
const adaptedPrefix = fixtureSource.slice(0, cut);
assert.equal(sha(adaptedPrefix), 'b486b31a65a36c0848ce5116c328c42fe6e8b32f90e1c96870979bf486ba1e6c',
  'exact V52 adapted finite fixture prefix; original supplied prefix pin is separately retained');
let prefix = adaptedPrefix;
function replaceOnce(before, after) {
  assert.equal(prefix.split(before).length - 1, 1, before); prefix = prefix.replace(before, after);
}
replaceOnce('  const env = f.env = {', '  const hooks = f.hooks = makeHooks(effects);\n  const env = f.env = {');
replaceOnce('    useMemo: fn => fn(), useRef: current => ({ current }),', '    useMemo: hooks.useMemo, useRef: hooks.useRef,');
replaceOnce('    useLayoutEffect: fn => { const cleanup = fn(); if (cleanup) effects.push(cleanup); },',
  '    useLayoutEffect: hooks.useLayoutEffect,');
const anchorStart = fixtureSource.indexOf('function installAnchor(f, uuid = exact, offsetPx = -17.25) {');
const anchorEnd = fixtureSource.indexOf("\ntest('actual Root-null saved-anchor starts", anchorStart);
assert(anchorStart >= 0 && anchorEnd > anchorStart);
const anchorFixture = fixtureSource.slice(anchorStart, anchorEnd);
const imported = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', '__filename', 'makeHooks', prefix + '\n' + anchorFixture
  + '\nmodule.exports={fixture,registration,resizeCallbacks,activateResize,modules,tick,gateFork,sourceRows,audit,exact,panel,compile,build,installAnchor};')(
  createRequire(fixtureFile), imported, imported.exports, path.dirname(fixtureFile), fixtureFile, makeHooks);
const fns = imported.exports;
function fragment(text, start, end, limit = 4096) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert(a >= 0 && b > a && text.indexOf(start, a + start.length) < 0);
  const value = text.slice(a, b); assert(Buffer.byteLength(value) < limit); return value;
}
const presentationText = fragment(fns.panel, '  const primaryPresentation = useMemo(() => ({', '  const primaryInputTransaction =');
const presentation = fns.compile(presentationText, 'return primaryPresentation;');
const convergenceText = fragment(fns.panel, 'function runHistoryScrollConvergence(opts:', '\nfunction useHistoryRevealToggle(');
assert.equal(Buffer.byteLength(convergenceText), 2427);
assert.equal(sha(convergenceText), 'e1b8d2d07de7fd336246d5eb4844e4684255d3672fe5f16ac83c6a6d742385ee',
  'byte-identical accepted V50 original convergence, including its240-attempt policy');
const compileConvergence = fns.compile(convergenceText, 'return runHistoryScrollConvergence;');
const audit = { schema: 'v52-r3-repair-panel-source-1', node: process.version,
  heapLimitBytes: v8.getHeapStatistics().heap_size_limit, sourcePanelSHA256: sha(fns.panel),
  testSHA256: sha(fs.readFileSync(__filename)), suppliedV51FixturePrefixSHA256,
  adaptedFixturePrefix: { bytes: Buffer.byteLength(adaptedPrefix), sha256: sha(adaptedPrefix) },
  actualPresentation: { bytes: Buffer.byteLength(presentationText), sha256: sha(presentationText) },
  actualConvergence: { bytes: Buffer.byteLength(convergenceText), sha256: sha(convergenceText), attempts: 240, wallclockDeadline: false },
  results: [], boundary: 'actual bounded current SOURCE and pinned V52 adapted finite fixture prefix; persistent synthetic hooks/DOM/frame scheduling/clock/delivery; retained native compatibility admission; no product timing policy added' };
const loaded = Promise.all([
  import(pathToFileURL(path.join(ROOT, 'src/renderer/utils/historyLiveProjection.mjs'))),
  import(pathToFileURL(path.join(ROOT, 'src/renderer/utils/historyDisplayUnits.mjs'))),
]);
async function waitFor(predicate, label) {
  for (let turn = 0; turn < 500; turn++) { if (predicate()) return; await fns.tick(); }
  assert.fail('finite Source fixture completion: ' + label);
}
async function cohort(t, n) {
  const [live, grouping] = await loaded;
  let data = Array.from({ length: n }, (_, i) => ({ uuid: i === n - 1 ? fns.exact : 'r' + i,
    role: 'user', content: 'durable ' + i, sessionId: 's' }));
  const opts = { enabled: true, responseWork: true, threshold: 2, expandedKeys: new Set() };
  let units = grouping.buildHistoryDisplayUnitsCached(data, opts); assert(units.every(unit => unit.kind === 'entry'));
  let keys = units.map(unit => live.historyLivePresentationKey(unit.entry));
  const f = await fns.fixture(t, { rows: { entries: data, units, keys } });
  const pHook = makeHooks([]), legacyHook = makeHooks([]);
  const pEnv = Object.assign(Object.create(f.env), { useMemo: pHook.useMemo,
    primaryLocalRowsRef: { current: [] }, ownerLiveEntries: [], primaryLiveToolResults: null, rewindPreview: null,
    historyGroupActionsEnabled: true, expandedGroupKeys: opts.expandedKeys,
    groupCaptionSelectionsRef: { current: new Map() }, primaryCaptionRevision: 0,
    primarySuppressionRevision: 0, primarySettingsPresentationKeysRef: { current: [] } });
  let legacyExecutions = 0, previousInput = null;
  const legacyEnv = { displayUnits: units, primaryPhysicalCandidate: false,
    useMemo: (fn, deps) => legacyHook.useMemo(() => { legacyExecutions++; return fn(); }, deps),
    useRef: current => ({ current }) };
  const render = async sequence => {
    pEnv.ownerLiveEntries = sequence ? [{ ...data.at(-1), content: 'next stream ' + sequence, liveProjection: true }] : [];
    assert.equal(live.buildHistoryLivePresentation(data, pEnv.ownerLiveEntries), data, 'actual canonical-wins merge');
    assert.equal(grouping.peekHistoryDisplayUnitsCached(data, opts), units, 'actual immutable grouping cache');
    pHook.begin(); const input = presentation(pEnv); f.env.primaryPresentation = input;
    if (previousInput) assert.notEqual(input, previousInput, 'future preparation input actually changed'); previousInput = input;
    f.env.primaryLocalPublicationAtRender = f.env.primarySparsePublicationOwner.publishCompatibility(f.env.entries,
      { ownerKey: f.env.historyOwnerKeyRef.current, generation: f.env.historyOwnerGenerationRef.current });
    f.hooks.begin(); Object.assign(f.env, fns.registration(f.env));
    // Admission is asynchronous, but waiting for its publication is not a
    // registration-completion wait. A retirement barrier may still own the
    // old query's exact late ACK while the new publication remains pending.
    await waitFor(() => f.env.primaryPositionOwner.capture()?.frame === f.env.primaryPositionFrame
      && f.env.primaryPositionOwner.owns(f.env.primaryPositionOwner.capture()), 'current admitted coordinate frame');
    f.publication = f.env.primaryPositionOwner.capture();
    legacyEnv.displayUnits = units; legacyHook.begin();
    const native = fns.build(legacyEnv); assert(native.unitIndexByUuid instanceof Map);
    assert.equal(native.displayEntryIndexByUuid, native.unitIndexByUuid);
    return f.publication;
  };
  const replaceCoordinates = nextData => {
    data = nextData; units = grouping.buildHistoryDisplayUnitsCached(data, opts);
    keys = units.map(unit => live.historyLivePresentationKey(unit.entry));
    Object.assign(f.env, { entries: data, displayEntries: data, displayUnits: units, displayUnitItemKeys: keys });
    f.env.displayEntriesRef.current = data; f.env.displayUnitsRef.current = units; f.env.displayUnitItemKeysRef.current = keys;
  };
  await (await render(0)).promise;
  return { f, render, legacyExecutions: () => legacyExecutions, data: () => data,
    units: () => units, keys: () => keys, replaceCoordinates };
}

for (const n of [8, 80]) test('R1 actual unchanged displayed coordinates at N=' + n + ' survive three future-input updates with zero extra N work', async t => {
  const h = await cohort(t, n), owner = h.f.env.primaryPositionOwner;
  const original = owner.capture(), frame = original.frame, deltas = [];
  for (let update = 1; update <= 3; update++) {
    const before = owner.stats(), publication = await h.render(update); await publication.promise;
    assert.equal(publication, original); assert.equal(publication.frame, frame); assert.equal(publication.status, 'ready');
    assert.equal(h.f.env.displayEntries, h.data()); assert.equal(h.f.env.displayUnits, h.units()); assert.equal(h.f.env.displayUnitItemKeys, h.keys());
    const after = owner.stats(), delta = { registrations: after.registrations - before.registrations,
      memberVisits: after.memberVisits - before.memberVisits, unitVisits: after.unitVisits - before.unitVisits,
      queries: after.queries - before.queries };
    assert.deepEqual(delta, { registrations: 0, memberVisits: 0, unitVisits: 0, queries: 0 }); deltas.push(delta);
  }
  assert.equal(h.legacyExecutions(), 1);
  audit.results.push({ kind: 'R1-input-only-no-N-replay', n, deltas, sameOriginalPublication: true, legacyNativeMapExecutions: 1 });
});

test('R1 original held pending resize query completes across three future-input updates without retry', async t => {
  const h = await cohort(t, 8), f = h.f; fns.activateResize(f);
  const original = f.env.primaryPositionOwner.capture(), before = f.env.primaryPositionOwner.stats();
  const gate = fns.gateFork(f), jumped = f.convergence.jump();
  let queryError; jumped.catch(error => { queryError = error; });
  try {
    await waitFor(() => gate.entered() || queryError, 'original pending resize fork');
    if (queryError) throw queryError;
    for (let update = 1; update <= 3; update++) {
      const publication = await h.render(update); await publication.promise;
      assert.equal(publication, original); assert.equal(f.convergence.cancelled(), null);
      assert.equal(f.env.primaryPositionOwner.stats().registrations, before.registrations);
      assert.equal(f.writes.length, 0);
    }
    gate.release(); assert.equal(await jumped, true);
    assert.deepEqual(f.writes, [{ index: 7, align: 'start', behavior: 'auto' }]);
    assert.equal(f.env.primaryPositionOwner.stats().queries - before.queries, 1);
    assert.equal(await f.convergence.jump(), true); assert.equal(f.env.primaryPositionOwner.stats().queries - before.queries, 1);
    audit.results.push({ kind: 'R1-original-held-query', updates: 3, extraRegistrations: 0, queries: 1,
      firstWrite: f.writes[0], originalQueryCompletedWithoutRetry: true, controllerStillOwned: f.convergence.cancelled() === null });
  } finally { gate.release(); }
});

test('R1 actual coordinate reorder revokes the old pending query and recovers current rank without equal-count substitution', async t => {
  const h = await cohort(t, 8), f = h.f; fns.activateResize(f);
  const owner = f.env.primaryPositionOwner, original = owner.capture(), before = owner.stats();
  const gate = fns.gateFork(f), heldHook = f.hook; let childId = null, parentId = null;
  f.hook = (channel, payload, route) => heldHook(channel, payload, async (method, request) => {
    const reply = await route(method, request);
    if (method === 'agent-transcript:fork-read-leaf' && childId === null) {
      childId = reply.leaseId; parentId = request.leaseId;
    }
    return reply;
  });
  let ackDelivered = false, ackDeliveries = 0;
  const deliverAck = () => { if (!ackDelivered) { ackDelivered = true; ackDeliveries++; gate.release(); } };
  const released = leaseId => f.calls.filter(call => call.channel === 'agent-transcript:release-read-root'
    && call.leaseId === leaseId).length;
  const jumped = f.convergence.jump();
  let queryError; jumped.catch(error => { queryError = error; });
  try {
    await waitFor(() => gate.entered() || queryError, 'reorder original fork');
    if (queryError) throw queryError;
    assert(childId && parentId && childId !== parentId);
    h.replaceCoordinates([...h.data()].reverse()); const next = await h.render(1);
    let nextSettled = false; next.promise.then(() => { nextSettled = true; });
    assert.notEqual(next, original); assert.equal(owner.owns(original), false); assert.equal(original.frame, null);
    assert.equal(await jumped, true); assert.equal(f.writes.length, 0);
    await waitFor(() => owner.stats().retiring === 1 && released(parentId) === 1,
      'old parent retired while its exact child allocation ACK is still held');
    assert.equal(next.status, 'pending'); assert.equal(nextSettled, false);
    assert.equal(owner.stats().registrations, before.registrations, 'first new registration retains the bounded retirement barrier');
    assert.equal(released(childId), 0); assert.equal(ackDelivered, false);
    const callsBeforeBlockedRead = f.calls.length;
    // Publication.promise is an internal registration completion, not a visible
    // consumer lifetime. Demand must settle UNKNOWN before the old raw ACK;
    // awaiting that publication first would deadlock this synthetic gate.
    let blocked = null;
    f.env.primaryResizePosition.resolve(next, fns.exact, { owns: () => owner.owns(next) })
      .then(value => { blocked = value; });
    await waitFor(() => blocked !== null, 'explicit bounded selected admission while retirement ACK is held');
    assert.equal(blocked.status, 'failed'); assert.equal(blocked.error?.code, 'HISTORY_READER_TRANSPORT_UNKNOWN');
    assert.equal(blocked.error.positionRegistrationPending, true);
    const blockedOutcome = { status: blocked.status, error: blocked.error.code };
    assert.equal(f.calls.length, callsBeforeBlockedRead, 'UNKNOWN admission performs no blind allocation or target replay');
    assert.equal(nextSettled, false); assert.equal(ackDelivered, false); assert.equal(f.writes.length, 0);
    assert.equal(f.convergence.cancelled(), null);
    deliverAck();
    await waitFor(() => nextSettled && owner.stats().retiring === 0 && released(childId) === 1,
      'exact old child ACK/cleanup drains the same queued new publication');
    assert.equal(await next.promise, next); assert.equal(next.status, 'ready');
    assert.equal(owner.stats().registrations - before.registrations, 1);
    assert.equal(released(parentId), 1); assert.equal(released(childId), 1); assert.equal(ackDeliveries, 1);
    assert.equal(f.convergence.cancelled(), null); assert.equal(await f.convergence.jump(), true);
    assert.deepEqual(f.writes, [{ index: 0, align: 'start', behavior: 'auto' }]);
    audit.results.push({ kind: 'R1-coordinate-reorder', oldReadNoWrite: true, oldPublicationRetired: true,
      newRegistrations: 1, originalControllerOwned: true, selectedIndex: 0,
      preAckRegistrationDelta: 0, preAckConsumerStatus: blockedOutcome.status,
      preAckConsumerError: blockedOutcome.error, samePendingPublicationDrained: true,
      originalParentReleaseAttempts: released(parentId), originalChildReleaseAttempts: released(childId),
      exactRawAckDeliveries: ackDeliveries, blockedReadExtraCalls: 0 });
  } finally { deliverAck(); }
});

test('R1 generation scope reuses only exact READY coordinates and rewrite epoch still invalidates', async t => {
  const h = await cohort(t, 8), f = h.f, owner = f.env.primaryPositionOwner;
  const original = owner.capture(), frame = original.frame, before = owner.stats();
  f.env.historyOwnerGenerationRef.current++; f.env.historyOwnerVisitState++;
  const refreshed = await h.render(1); await refreshed.promise;
  assert.notEqual(refreshed, original); assert.equal(refreshed.frame, frame); assert.equal(owner.owns(original), false);
  assert.equal(owner.stats().registrations, before.registrations); assert.equal(owner.stats().memberVisits, before.memberVisits);
  assert.equal(owner.stats().reused - before.reused, 1);
  f.env.fileRewriteEpoch++; const rewritten = await h.render(2); await rewritten.promise;
  assert.notEqual(rewritten, refreshed); assert.notEqual(rewritten.frame, frame); assert.equal(owner.owns(refreshed), false);
  assert.equal(owner.stats().registrations - before.registrations, 1);
  audit.results.push({ kind: 'R1-generation-and-rewrite', readyScopeReuse: 1, generationRegistrationVisits: 0,
    compatibilityAdmissionRechecked: true,
    rewriteRegistrations: 1, originalAndRefreshedProofsRetired: true });
});

for (const kind of ['resize', 'saved-anchor']) test('original ' + kind + ' convergence retains240 attempts and no invented twenty-second cancellation', async t => {
  const f = await fns.fixture(t, { rootNull: kind === 'saved-anchor' }); await f.publication.promise;
  let now = 0; const clock = { now: () => now };
  // The actual callback and convergence share the same finite elapsed clock.
  // Binding only convergence would not qualify a caller-side time guard.
  f.env.performance = clock;
  if (kind === 'resize') fns.activateResize(f);
  else { f.d.setRows([]); fns.installAnchor(f); }
  const spec = f.convergence, frames = [], settled = [], aborted = [];
  const convergence = compileConvergence({ performance: clock, requestAnimationFrame: callback => frames.push(callback) });
  const laneName = kind === 'resize' ? 'primaryResizePosition' : 'primaryAnchorPosition';
  const lane = f.env[laneName]; let ready = null, deliver;
  const held = new Promise(resolve => { deliver = resolve; });
  f.env[laneName] = { ...lane, async resolve(...args) { const selection = await lane.resolve(...args);
    assert.equal(selection.status, 'ready'); if (!ready) { ready = selection; await held; } return selection; } };
  convergence({ ...spec,
    onSettled: outcome => { settled.push(outcome); spec.onSettled(outcome); },
    onAborted: outcome => { aborted.push(outcome); spec.onAborted(outcome); } });
  assert.equal(frames.length, 1); const firstStep = frames.shift()();
  await waitFor(() => ready !== null || aborted.length > 0, 'real ' + kind + ' selection before delayed delivery');
  assert.deepEqual(aborted, [], 'genuine coordinate must reach the finite delayed delivery boundary');
  assert.equal(f.writes.length, 0); assert.equal(frames.length, 0);
  now = 20_001; deliver(); await firstStep;
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].index, 1);
  if (kind === 'saved-anchor') assert.equal(f.writes[0].offset, -17.25);
  assert.equal(aborted.length, 0); assert.equal(settled.length, 0); assert.equal(frames.length, 1);
  let steps = 1;
  while (frames.length) { assert(steps < 241); const callback = frames.shift(); await callback(); steps++; }
  assert.equal(steps, 240); assert.equal(f.writes.length, 239);
  assert.equal(aborted.length, 0); assert.equal(settled.length, 1);
  assert.equal(settled[0].attempts, 240); assert.equal(settled[0].settled, '0'); assert.equal(settled[0].elapsedMs, 20_001);
  assert.equal(f.env.primaryPositionOwner.stats().queries, 1);
  audit.results.push({ kind: 'original-untimed-' + kind, genuineReadyCoordinate: true, syntheticElapsedMs: now,
    callerClockAlsoElapsedMs: f.env.performance.now(),
    firstWrite: f.writes[0], originalAttempts: settled[0].attempts, cachedCoordinateQueries: 1,
    writeIntents: f.writes.length, aborted: 0, renewedDeadline: false, noNew20sPolicy: true });
});

test.after(() => {
  audit.fixturesCleaned = fns.audit.fixturesCleaned;
  audit.allCallbacksCompleted = true;
  if (process.env.V51R3_REPAIR_PANEL_RESULT) fs.writeFileSync(process.env.V51R3_REPAIR_PANEL_RESULT, JSON.stringify(audit, null, 2) + '\n');
  console.log('V51R3_REPAIR_PANEL_COMPLETE ' + JSON.stringify({ results: audit.results.length,
    fixturesCleaned: audit.fixturesCleaned, sourcePanelSHA256: audit.sourcePanelSHA256 }));
});
