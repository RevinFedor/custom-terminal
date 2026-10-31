'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTraceProjectionWriter, createNativeTraceProjectionAdapter } = require('./perf-trace-projection');
const { createInputLatencyCollector } = require('./perf-input-latency');
const { createInputSnapshotWriter } = require('./perf-input-snapshot-store');
const fixture = require('./perf-input-latency.wheel.fixture.json');
const FORWARD = 'RenderWidgetHostImpl::ForwardWheelEvent';
const encode = events => '{"traceEvents":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}';
function scopes() {
  const stamps = fixture.events.filter(e => e.name === 'InputLatency::MouseWheel' && e.ph === 'b')
    .map(e => e.args.chrome_latency_info.component_info.find(c => c.component_type === 'COMPONENT_INPUT_EVENT_LATENCY_BEGIN_RWH').time_us);
  return [
    { name: FORWARD, ph: 'X', cat: 'input', pid: 11, tid: 1, ts: stamps[0] - 19, dur: stamps[1] - stamps[0] + 18, args: { dx: 0, dy: -120 } },
    { name: FORWARD, ph: 'X', cat: 'input', pid: 11, tid: 1, ts: stamps[1], dur: 40, args: { dx: 0, dy: 0 } },
  ];
}
function collect(events, finish = {}) {
  const c = createInputLatencyCollector(fixture.options); c.write(encode(events));
  return c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers,
    rendererClockRelation: fixture.rendererClockRelation, trigger: fixture.trigger, ...finish });
}
async function project(t, rows) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noted-forwarding-')));
  const file = path.join(dir, 'incident-123-11.trace.json');
  const w = createTraceProjectionWriter({ file, incidentDir: dir, incidentId: 'incident-123-11',
    mainPid: 11, rendererPid: 22, clockSyncIds: fixture.clockMarkers.map(m => m.syncId), deadlineAt: Date.now() + 10000 });
  t.after(async () => { await w.abort(); fs.rmSync(dir, { recursive: true, force: true }); });
  await w.ready; const data = Buffer.from(encode(rows));
  for (let i = 0; i < data.length; i += 65536) await w.write(data.subarray(i, i + 65536));
  const proof = await w.finish({ completeExport: true, dataLoss: false });
  const raw = fs.readFileSync(file, 'utf8');
  const c = createInputLatencyCollector(fixture.options), adapter = createNativeTraceProjectionAdapter({ collector: c, projection: proof });
  const bytes = Buffer.from(raw);
  for (let i = 0; i < bytes.length; i += 65536) adapter.write(bytes.subarray(i, i + 65536));
  const result = adapter.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers,
    rendererClockRelation: fixture.rendererClockRelation, trigger: fixture.trigger });
  return { dir, raw, proof, result: result.result };
}

test('projection → native adapter → collector → real writer preserves boolean packet evidence without selecting a DOM candidate', async t => {
  const p = await project(t, [...fixture.events, ...scopes()]);
  assert.equal(p.proof.inputLossRecords, 0); assert.equal(p.proof.dataLoss, false);
  const parsed = JSON.parse(p.raw).traceEvents.filter(e => e.name === FORWARD);
  assert.deepEqual(parsed.map(e => e.args), [{ hasDelta: true }, { hasDelta: false }]);
  assert.doesNotMatch(p.raw, /"dx"|"dy"|-120/);
  const r = p.result;
  assert.deepEqual(r.trigger.candidates, ['3', '4']); assert.equal(r.trigger.status, 'ambiguous');
  for (const f of r.flows) {
    assert.equal(f.wheelForwarding.status, 'qualified');
    assert.equal(f.wheelForwarding.candidateCount, 1); assert.equal(f.wheelForwarding.ownerCount, 1);
    assert.equal(f.wheelForwarding.candidates[0].hasDelta, f.traceId === '3');
  }
  const record = { version: 1, kind: 'input-native-preroll', cpuProfiler: false,
    scope: { ...fixture.options, window: 1, documentGeneration: 1, frameProcessId: 1, frameRoutingId: 1 },
    actions: [], captureStartedAbs: 1793335365409, captureFinishedAbs: 1793335365410,
    recordingStartedAbs: 1793335360000, errors: [], evidence: r };
  const dir = path.join(p.dir, 'saved'), writer = createInputSnapshotWriter({ directory: dir, mainPid: 11, windowId: 1 });
  assert.equal(await writer.publish(record), true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.deepEqual(saved.evidence, r);
});

test('overlap, duplicate scopes, shared boundary and multiple owners refuse a unique link, independent of hasDelta', () => {
  const base = scopes();
  for (const extra of [
    { ...base[0], args: { hasDelta: false } },
    { ...base[0], ts: base[0].ts - 1, dur: base[0].dur + 2, args: { hasDelta: true } },
    { ...base[1], ts: base[0].ts + 19, dur: 0, args: { hasDelta: false } },
  ]) {
    const safe = base.map(e => ({ ...e, args: { hasDelta: e.args.dy !== 0 } }));
    const r = collect([...fixture.events, ...safe, extra]);
    assert.equal(r.flows.find(f => f.traceId === '3').wheelForwarding.status, 'ambiguous');
    assert.equal(r.trigger.status, 'ambiguous');
  }
  const wide = { ...base[0], dur: base[1].ts - base[0].ts + 1, args: { hasDelta: true } };
  const r = collect([...fixture.events, wide]);
  assert(r.flows.every(f => f.wheelForwarding.reason === 'nonunique-forward-owner'));
});

test('ordinary raw pre-roll and safe profile projection normalize identically without retaining delta values', () => {
  const raw = scopes(), safe = raw.map(e => ({ ...e, args: { hasDelta: e.args.dy !== 0 } }));
  const a = collect([...fixture.events, ...raw]), b = collect([...fixture.events, ...safe]);
  assert.deepEqual(a.flows, b.flows); assert.deepEqual(a.trigger, b.trigger);
  assert.deepEqual(a.unboundNativeIntervals, b.unboundNativeIntervals);
  assert.deepEqual(a.stats, b.stats);
  assert.equal(a.trigger.status, 'ambiguous');
  assert(a.flows.every(f => f.wheelForwarding.status === 'qualified'));
  assert.doesNotMatch(JSON.stringify(a), /"dx"|"dy"|-120/);
  for (const event of [{ ...raw[0], args: { ...raw[0].args, hasDelta: false } },
    { ...raw[0], args: { dx: 0, dy: Infinity } }]) {
    const rejected = collect([...fixture.events, event]);
    assert.equal(rejected.stats.invalidRecords, 1);
    assert(rejected.flows.every(f => f.wheelForwarding.status === 'unknown'));
  }
});

test('missing scope/thread, source loss and malformed boolean remain unknown; legacy candidate audit unchanged', () => {
  const safe = scopes().map(e => ({ ...e, args: { hasDelta: e.args.dy !== 0 } }));
  for (const [events, finish] of [
    [fixture.events, {}],
    [[...fixture.events.filter(e => e.name !== 'thread_name'), ...safe], {}],
    [[...fixture.events, ...safe], { dataLoss: true }],
    [[...fixture.events, ...safe], { completeExport: false }],
    [[...fixture.events, ...safe.map(e => ({ ...e, args: { hasDelta: 'PRIVATE' } }))], {}],
  ]) {
    const r = collect(events, finish);
    assert(r.flows.every(f => f.wheelForwarding.status === 'unknown'));
    assert.notEqual(r.trigger.status, 'matched');
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  }
});

test('raw delta values and foreign/malformed forwarding packets cannot create a boolean witness', async t => {
  const first = scopes()[0];
  const rows = [
    { ...first, args: { dx: 'PRIVATE', dy: 2 } },
    { ...first, args: { dx: 0, hasDelta: true } },
    { ...first, pid: 22 },
    { ...first, ph: 'b' },
    { ...first, args: { dx: 0, dy: 4, text: 'PRIVATE' } },
  ];
  const p = await project(t, [...fixture.events, ...rows]);
  assert(p.proof.inputLossRecords >= 4); assert.equal(p.proof.dataLoss, true);
  assert.doesNotMatch(p.raw, /PRIVATE|"dx"|"dy"|"text"/);
  assert(p.result.flows.every(f => f.wheelForwarding.status === 'unknown'));
});
