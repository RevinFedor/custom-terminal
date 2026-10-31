'use strict';

// SOURCE candidate tests. Not executed during the review which authored them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInputLatencyCollector } = require('./perf-input-latency');
const { createInputSnapshotWriter } = require('./perf-input-snapshot-store');
const fixture = require('./perf-input-latency.test.cjs');
const real10403 = require('./perf-input-latency.same-time.fixture.json');
const clone = value => structuredClone(value);
const encode = events => '{"traceEvents":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}';
const find = (events, name, ph) => events.find(e => e.name === name && e.ph === ph);
const row = (result, name) => result.flows[0].stages.find(s => s.name === name);

function collect(events, finish = {}, chunkSize = 16384, limits = {}) {
  const c = createInputLatencyCollector({ ...fixture.options, ...limits }), source = Buffer.from(encode(events));
  for (let i = 0; i < source.length; i += chunkSize) c.write(source.subarray(i, i + chunkSize));
  const mainOrigin = fixture.clockMarkers[0].before.timeOrigin, center = 1793264278300;
  const sample = (timeOrigin, epochMs) => ({ timeOrigin, epochMs, now: epochMs - timeOrigin });
  return c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers,
    rendererClockRelation: { mainPid: fixture.options.mainPid, rendererPid: fixture.options.rendererPid,
      mainBefore: sample(mainOrigin, center - 0.1), mainAfter: sample(mainOrigin, center + 0.1),
      renderer: sample(fixture.options.documentTimeOriginMs, center) }, trigger: fixture.trigger, ...finish });
}

function boundaryEvents(position = 'before-previous-end') {
  const events = clone(fixture.events);
  const instant = find(events, 'RendererCompositorProcessing', 'b');
  events.splice(events.indexOf(find(events, instant.name, 'e')), 1);
  instant.ph = 'n';
  const next = find(events, 'RendererCompositorToMain', 'b'); next.ts = instant.ts;
  if (position !== 'ordinary') {
    events.splice(events.indexOf(instant), 1);
    const pivot = position === 'before-previous-end'
      ? find(events, 'RendererCompositorQueueingDelay', 'e') : next;
    events.splice(events.indexOf(pivot) + (position === 'after-next-begin' ? 1 : 0), 0, instant);
  }
  return events;
}

test('zero core stage before previous end or after next begin has proven sibling depth; bytes/order stay evidence', () => {
  for (const position of ['before-previous-end', 'after-next-begin']) {
    const events = boundaryEvents(position), r = collect(events), zero = row(r, 'RendererCompositorProcessing');
    assert.equal(r.trigger.status, 'matched'); assert.equal(r.flows[0].status, 'measured');
    assert.equal(zero.depth, 0); assert.equal(zero.depthFromExport, 1);
    assert.equal(zero.depthEvidence, 'validated-core-boundary');
    assert.equal(zero.durationMs, 0); assert.equal(zero.threadMs, null);
    assert.equal(r.stats.sameTimestampCoreBoundaries, 1);
    assert.equal(r.flows[0].largestMeasuredStage.durationMs, 152.539);
    const originalTrack = events.filter(e => e.id2).map(e => [e.name, e.ph, e.ts]);
    const savedTrack = r.flows[0].nativeEvidence.filter(e => e.id2).map(e => [e.name, e.ph, e.ts]);
    assert.deepEqual(savedTrack, originalTrack, 'native order is not sorted or rewritten');
    const replay = collect([...events.filter(e => e.name === 'clock_sync'), ...r.threadEvidence, ...r.flows[0].nativeEvidence]);
    assert.equal(replay.trigger.status, 'matched'); assert.equal(replay.stats.sameTimestampCoreBoundaries, 1);
    assert.deepEqual(collect(events, {}, 1), r, 'byte chunking cannot change topology');
  }
  const ordinary = collect(boundaryEvents('ordinary'));
  assert.equal(ordinary.trigger.status, 'matched'); assert.equal(ordinary.stats.sameTimestampCoreBoundaries, 0);
  assert.equal(row(ordinary, 'RendererCompositorProcessing').depthFromExport, undefined);
});

test('adjacent zero core stages at one proven sibling boundary normalize independently', () => {
  const events = boundaryEvents(), a = find(events, 'RendererCompositorProcessing', 'n');
  const b = find(events, 'RendererCompositorToMain', 'b');
  events.splice(events.indexOf(find(events, b.name, 'e')), 1); b.ph = 'n';
  find(events, 'RendererMainProcessing', 'b').ts = a.ts;
  events.splice(events.indexOf(b), 1);
  events.splice(events.indexOf(find(events, 'RendererCompositorQueueingDelay', 'e')), 0, b);
  const r = collect(events);
  assert.equal(r.trigger.status, 'matched'); assert.equal(r.stats.sameTimestampCoreBoundaries, 2);
  for (const name of [a.name, b.name]) {
    assert.equal(row(r, name).depth, 0); assert.equal(row(r, name).durationMs, 0);
    assert.equal(row(r, name).depthEvidence, 'validated-core-boundary');
  }
});

test('interior zero, missing pair, duplicate stage, foreign track and timestamp inversion stay unqualified', () => {
  const mutations = [
    events => { find(events, 'RendererCompositorProcessing', 'n').ts--; },
    events => { events.splice(events.indexOf(find(events, 'RendererCompositorQueueingDelay', 'e')), 1); },
    events => { const n = find(events, 'RendererCompositorProcessing', 'n'); events.splice(events.indexOf(n), 0, clone(n)); },
    events => { find(events, 'RendererCompositorProcessing', 'n').id2.local = '0x777'; },
    events => {
      const b = find(events, 'BrowserMainToRendererCompositor', 'b');
      const e = find(events, b.name, 'e');
      events.splice(events.indexOf(e), 1); events.splice(events.indexOf(b), 1);
      events.splice(events.indexOf(find(events, 'RendererCompositorQueueingDelay', 'e')) + 1, 0, b, e);
    },
  ];
  for (const mutate of mutations) {
    const events = boundaryEvents(); mutate(events); const r = collect(events);
    assert.notEqual(r.trigger.status, 'matched'); assert.notEqual(r.flows[0].status, 'measured');
    assert.equal(r.flows[0].largestMeasuredStage, null);
    assert.equal(r.stats.sameTimestampCoreBoundaries, 0);
  }
});

test('real nested presentation instant retains depth one, not promoted to a core sibling', () => {
  const events = clone(fixture.events), n = find(events, 'ReceiveCompositorFrameToStartDraw', 'b');
  events.splice(events.indexOf(find(events, n.name, 'e')), 1); n.ph = 'n';
  find(events, 'StartDrawToSwapStart', 'b').ts = n.ts;
  const r = collect(events);
  assert.equal(r.trigger.status, 'matched'); assert.equal(row(r, n.name).depth, 1);
  assert.equal(row(r, n.name).depthEvidence, undefined); assert.equal(r.stats.sameTimestampCoreBoundaries, 0);
});

test('normalizing a stage cannot resolve incomplete export, data loss or a competing unfinished same-type input', () => {
  for (const finish of [{ completeExport: false }, { dataLoss: true }, { dataLoss: undefined }]) {
    const r = collect(boundaryEvents(), finish);
    assert.equal(r.trigger.status, 'unknown'); assert.equal(r.flows[0].largestMeasuredStage, null);
    assert.equal(row(r, 'RendererCompositorProcessing').depth, 0, 'shape evidence is distinct from capture authority');
  }
  const events = boundaryEvents();
  events.push({ name: 'InputLatency::MouseDown', ph: 'b', pid: fixture.options.mainPid, tid: 1,
    ts: find(events, 'EventLatency', 'b').ts + 1000000, id: '0x999', args: {} });
  const r = collect(events);
  assert.equal(r.flows[0].status, 'measured'); assert.equal(r.stats.sameTimestampCoreBoundaries, 1);
  assert.equal(r.trigger.status, 'unknown'); assert.equal(r.trigger.reason, 'incomplete-evidence');
});

test('normalized boundary cannot supply missing clock proof or bypass record/output limits', () => {
  const events = boundaryEvents();
  for (const markers of [[], [fixture.clockMarkers[0], fixture.clockMarkers[0]]]) {
    const r = collect(events, { clockMarkers: markers });
    assert.equal(r.stats.sameTimestampCoreBoundaries, 1);
    assert.notEqual(r.trigger.status, 'matched');
    assert.notEqual(r.clock.status, 'bounded');
  }
  const capped = collect(events, {}, 16384, { maxRecords: 8 });
  assert.ok(capped.omitted.records > 0);
  assert.notEqual(capped.trigger.status, 'matched');
  assert.ok(capped.flows.every(f => f.status !== 'measured'));
  const output = collect(events, {}, 16384, { maxOutputBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 4096);
  assert.notEqual(output.trigger.status, 'matched');
});

test('duplicate native root cannot become measured through a normalized boundary', () => {
  const events = boundaryEvents();
  const begin = clone(find(events, 'InputLatency::MouseDown', 'b'));
  const end = clone(find(events, 'InputLatency::MouseDown', 'e'));
  begin.id = end.id = '0x998';
  events.push(begin, end);
  const r = collect(events);
  assert.equal(r.stats.sameTimestampCoreBoundaries, 1);
  assert.notEqual(r.trigger.status, 'matched');
  assert.notEqual(r.flows[0].status, 'measured');
  assert.equal(r.flows[0].largestMeasuredStage, null);
});

test('selected native10403 chain source-counter: zero depth is corrected; original full capture stays UNKNOWN', () => {
  const c = createInputLatencyCollector(real10403.options);
  c.write(encode(real10403.events));
  // No reconstructed clock/trigger authority: this tests the native chain only.
  const r = c.finish({ completeExport: true, dataLoss: false });
  const f = r.flows.find(f => f.traceId === '10403'), zero = f.stages.find(s => s.name === 'RendererCompositorProcessing');
  assert.equal(f.status, 'measured'); assert.equal(zero.depth, 0); assert.equal(zero.depthFromExport, 1);
  assert.equal(zero.durationMs, 0); assert.equal(r.stats.sameTimestampCoreBoundaries, 1);
  assert.equal(f.largestMeasuredStage.name, 'GenerationToBrowserMain');
  assert.equal(f.largestMeasuredStage.durationMs, 532.645);
  assert.equal(r.trigger.status, 'not-requested'); assert.equal(r.clock.status, 'unknown');
  assert.equal(real10403.originalCapture.trigger.status, 'unknown');
  assert.equal(real10403.originalCapture.trigger.reason, 'incomplete-evidence');
  assert.deepEqual(real10403.originalCapture.flowIssues, ['missing-core-stage']);
});

function envelope(evidence, start = 1793264279500.6) {
  return { version: 1, kind: 'input-native-preroll', cpuProfiler: false,
    recordingId: 'input-ring-11-1', status: 'complete',
    scope: { ...fixture.options, window: 1, documentGeneration: 2, frameProcessId: 3, frameRoutingId: 4 },
    actions: [], captureStartedAbs: start, captureFinishedAbs: start + 10, recordingStartedAbs: start - 1000,
    exportBytes: 9000, exportComplete: true, dataLoss: false, cleanupConfirmed: true, errors: [], evidence };
}

test('fixed persistence whitelist preserves correction provenance and counter with exact collector readback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-input-boundary-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const r = envelope(collect(boundaryEvents()));
  const writer = createInputSnapshotWriter({ directory, mainPid: fixture.options.mainPid });
  assert.equal(await writer.publish(r), true);
  const bytes = fs.readFileSync(path.join(directory, 'incident-' + Math.round(r.captureStartedAbs) + '-11.input.json'));
  const saved = JSON.parse(bytes);
  assert.deepEqual(saved.evidence, r.evidence);
  assert.equal(saved.evidence.stats.sameTimestampCoreBoundaries, 1);
  assert.equal(row(saved.evidence, 'RendererCompositorProcessing').depthFromExport, 1);
  assert.equal(row(saved.evidence, 'RendererCompositorProcessing').depthEvidence, 'validated-core-boundary');
  assert(bytes.length <= 256 * 1024);
});

test('correction metadata rejects invalid enum/count/depth and getters before IO', async () => {
  let ioCalls = 0, getterCalls = 0;
  const io = Object.fromEntries(['mkdir', 'lstat', 'open'].map(name => [name, async () => { ioCalls++; throw Error('unexpected IO'); }]));
  const writer = createInputSnapshotWriter({ directory: path.join(os.tmpdir(), 'noted-input-no-io'), mainPid: 11, io });
  const mutations = [
    e => { row(e, 'RendererCompositorProcessing').depthEvidence = 'PRIVATE_OR_UNPROVEN'; },
    e => { row(e, 'RendererCompositorProcessing').depthFromExport = 2; },
    e => { e.stats.sameTimestampCoreBoundaries = -1; },
    e => { Object.defineProperty(row(e, 'RendererCompositorProcessing'), 'depthEvidence', { get() { getterCalls++; return 'validated-core-boundary'; } }); },
  ];
  for (const mutate of mutations) {
    const e = collect(boundaryEvents()); mutate(e);
    assert.equal(await writer.publish(envelope(e)), false);
  }
  assert.equal(ioCalls, 0); assert.equal(getterCalls, 0);
});
