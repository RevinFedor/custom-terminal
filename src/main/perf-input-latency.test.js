'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputLatencyCollector } = require('./perf-input-latency');
const { createTraceLineReader } = require('./perf-trace-events');
const fixture = require('./perf-input-latency.test.cjs');
const clone = value => structuredClone(value);
const encode = events => '{"traceEvents":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}';
// Synthetic receipt for testing clock-join mechanics. The real control fixture
// has no independently measured renderer↔Main relation and must not imply one.
function clockRelation(offsetMs = 0) {
  const mainOrigin = fixture.clockMarkers[0].before.timeOrigin, center = 1793264278300;
  const sample = (timeOrigin, epochMs) => ({ timeOrigin, epochMs, now: epochMs - timeOrigin });
  return { mainPid: fixture.options.mainPid, rendererPid: fixture.options.rendererPid,
    mainBefore: sample(mainOrigin, center - 0.1), mainAfter: sample(mainOrigin, center + 0.1),
    renderer: sample(fixture.options.documentTimeOriginMs, center - offsetMs) };
}
function collect(events = fixture.events, finish = {}, options = {}, chunkSize = 16384) {
  const collector = createInputLatencyCollector({ ...fixture.options, ...options });
  const source = Buffer.from(encode(events));
  for (let i = 0; i < source.length; i += chunkSize) collector.write(source.subarray(i, i + chunkSize));
  return collector.finish({ completeExport: true, dataLoss: false,
    clockMarkers: fixture.clockMarkers, rendererClockRelation: clockRelation(), trigger: fixture.trigger, ...finish });
}
function anotherFlow(index) {
  return clone(fixture.events.filter(e => e.name !== 'clock_sync' && e.name !== 'thread_name')).map(e => {
    if (e.id !== undefined) e.id = '0x' + (1000 + index * 2).toString(16);
    if (e.id2) e.id2.local = '0x' + (1001 + index * 2).toString(16);
    if (e.args.chrome_latency_info?.trace_id !== undefined) e.args.chrome_latency_info.trace_id = index;
    if (e.args.event_latency) e.args.event_latency.event_latency_id = index;
    return e;
  });
}
const stage = (flow, name) => flow.stages.find(s => s.name === name);

test('rejection evidence retains the invalid native header despite routine skip noise, without private payload', () => {
  const noise = Array.from({ length: 70 }, (_, i) => ({ name: 'PRIVATE-Latency-NAME', ph: 'I', pid: 22, tid: 1,
    ts: i, args: { text: 'PRIVATE-BODY', key: 'PRIVATE-KEY', x: 42 } }));
  const invalid = { name: 'EventLatency', ph: 'I', pid: 22, tid: 1, ts: 12, id2: { local: '0x42' },
    args: { event_latency: { event_latency_id: 4, event_type: 'MOUSE_PRESSED' }, key: 'PRIVATE-KEY', text: 'PRIVATE-BODY' } };
  const r = collect([...fixture.events, ...noise, invalid]);
  assert.equal(r.trigger.status, 'unknown', 'rejection evidence does not weaken qualification');
  assert.equal(r.stats.invalidRecords, 1); assert.equal(r.rejections.counts['invalid-pair-phase'], 1);
  const rejected = r.rejections.events.find(e => e.reason === 'invalid-pair-phase');
  assert.deepEqual(rejected, { reason: 'invalid-pair-phase', kind: 'event', name: 'EventLatency',
    ph: 'I', pid: 22, tid: 1, ts: 12, localId: '66', traceId: '4', nativeType: 'MouseDown' });
  assert(r.rejections.retained <= 32 && r.rejections.omitted > 0);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-BODY|PRIVATE-KEY|PRIVATE-Latency-NAME/);
});

test('trace array boundary excludes multiline private export metadata, while real malformed event remains explained', () => {
  const source = encode(fixture.events).replace(/\n\]}$/, '\n],\n"metadata": {\n"list": [\n"EventLatency",\n"InputLatency::MouseDown"\n],\n"body": "' + 'PRIVATE_METADATA'.repeat(9000) + '"\n}\n}');
  const c = createInputLatencyCollector(fixture.options);
  for (let i = 0; i < source.length; i += 4096) c.write(source.slice(i, i + 4096));
  const r = c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers,
    rendererClockRelation: clockRelation(), trigger: fixture.trigger });
  assert.equal(r.trigger.status, 'matched'); assert.equal(r.stats.invalidRecords, 0);
  assert.equal(r.stats.malformedLines, 0); assert.equal(r.stream.overlongLines, 0);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_METADATA/);
  const bad = createInputLatencyCollector(fixture.options);
  bad.write(encode(fixture.events).replace(/\n\]}$/, ',\n"EventLatency"\n]}'));
  const rejected = bad.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers,
    rendererClockRelation: clockRelation(), trigger: fixture.trigger });
  assert.equal(rejected.trigger.status, 'unknown');
  assert(rejected.rejections.events.some(e => e.reason === 'event-not-object'));
});

test('structural rejection details share projection/output caps and report omitted records', () => {
  const noise = Array.from({ length: 80 }, (_, i) => ({ name: 'EventLatency', ph: 'I', pid: 22, tid: 1,
    ts: i, id2: { local: i }, args: { event_latency: { event_latency_id: i, event_type: 'MOUSE_PRESSED' } } }));
  const r = collect([...fixture.events, ...noise], {}, { maxRetainedBytes: 4096, maxOutputBytes: 4096 });
  assert(r.rejections.total >= 80); assert(r.rejections.retained <= 32);
  assert(r.rejections.omitted > 0 || r.rejections.outputOmitted > 0);
  assert(r.stats.retainedBytes + r.rejections.projectionBytes <= r.limits.retainedBytes);
  assert(Buffer.byteLength(JSON.stringify(r)) <= 4096);
  assert.equal(r.trigger.status, 'unknown');
});

test('Perfetto zero-duration async stage is a measured instant, not a missing end or invalid record', () => {
  const events = clone(fixture.events);
  const begin = events.find(e => e.name === 'RendererCompositorProcessing' && e.ph === 'b');
  const endIndex = events.findIndex(e => e.name === begin.name && e.ph === 'e');
  begin.ph = 'n'; events.splice(endIndex, 1);
  events.find(e => e.name === 'RendererCompositorToMain' && e.ph === 'b').ts = begin.ts;
  const r = collect(events);
  assert.equal(r.trigger.status, 'matched'); assert.equal(r.stats.invalidRecords, 0);
  const zero = stage(r.flows[0], begin.name);
  assert.equal(zero.durationMs, 0); assert.equal(zero.depth, 0);
  assert.equal(zero.threadMs, null, 'zero wall duration is not a sampled CPU value');
  assert(r.flows[0].nativeEvidence.some(e => e.name === begin.name && e.ph === 'n'));
  const replay = collect([...events.filter(e => e.name === 'clock_sync'), ...r.threadEvidence, ...r.flows[0].nativeEvidence]);
  assert.equal(replay.trigger.status, 'matched');
  const duplicate = collect([...events, { ...begin }]);
  assert.notEqual(duplicate.trigger.status, 'matched');
  assert(duplicate.flows[0].issues.some(x => x === 'duplicate-pair' || x === 'nonmonotonic'));
});

test('unfinished typed InputLatency root remains evidence without spoiling a different input type', () => {
  const pending = { name: 'InputLatency::MouseMove', ph: 'b', pid: 11, tid: 1,
    ts: fixture.events.find(e => e.name === 'InputLatency::MouseDown').ts, id: '0x999', args: {} };
  const r = collect([...fixture.events, pending]);
  assert.equal(r.trigger.status, 'matched'); assert.equal(r.status, 'partial');
  assert.equal(r.stats.invalidIds, 0); assert.equal(r.stats.orphanTracks, 1);
  assert(r.orphanEvidence.some(e => e.name === pending.name && e.id === '2457'));
  assert.equal(r.rejections.counts['unlinked-native-root'], 1);
  const sameType = collect([...fixture.events, { ...pending, name: 'InputLatency::MouseDown' }]);
  assert.equal(sameType.trigger.status, 'unknown', 'unknown same-type original cannot be discarded');
  for (const bad of [null, -1, Number.MAX_SAFE_INTEGER + 1, 'not-an-id']) {
    const invalid = collect([...fixture.events, { ...pending, args: { chrome_latency_info: { trace_id: bad } } }]);
    assert.equal(invalid.trigger.status, 'unknown'); assert.equal(invalid.stats.invalidIds, 1);
  }
});

test('optional EventLatency link and Chromium MouseMove enum preserve typed orphan evidence', () => {
  const unlinked = anotherFlow(5).filter(e => e.id2);
  const root = unlinked.find(e => e.name === 'EventLatency' && e.ph === 'b');
  delete root.args.event_latency.event_latency_id;
  root.args.event_latency.event_type = 'MOUSE_MOVED_EVENT';
  const r = collect([...fixture.events, ...unlinked]);
  assert.equal(r.trigger.status, 'matched'); assert.equal(r.stats.invalidIds, 0);
  assert.equal(r.stats.orphanTracks, 1);
  const retained = r.orphanEvidence.find(e => e.name === 'EventLatency' && e.ph === 'b');
  assert.equal(retained.args.event_latency.event_type, 'MOUSE_MOVED');
  assert.equal(retained.args.event_latency.event_latency_id, undefined);
  root.args.event_latency.event_type = 'MOUSE_PRESSED';
  assert.equal(collect([...fixture.events, ...unlinked]).trigger.status, 'unknown');
  root.args.event_latency.event_type = 'UNSUPPORTED';
  assert.equal(collect([...fixture.events, ...unlinked]).trigger.status, 'unknown');
});

test('a prior complete EventLatency cannot be a competing original, but overlapping incomplete identity stays unknown', () => {
  const earlier = anotherFlow(5).filter(e => e.id2);
  for (const e of earlier) e.ts -= 300000;
  const r = collect([...fixture.events, ...earlier]);
  assert.equal(r.trigger.status, 'matched');
  assert(r.flows.find(f => f.traceId === '5').issues.includes('missing-native-root'));
  assert.equal(collect([...fixture.events, ...anotherFlow(5).filter(e => e.id2)]).trigger.status, 'unknown');
  const orphan = clone(earlier); delete orphan.find(e => e.name === 'EventLatency' && e.ph === 'b').args.event_latency.event_latency_id;
  assert.equal(collect([...fixture.events, ...orphan]).trigger.status, 'matched');
  orphan.pop();
  assert.equal(collect([...fixture.events, ...orphan]).trigger.status, 'unknown', 'missing end cannot establish exclusion');
});

test('duplicate unlinked or linked roots cannot hide a competing original behind the first root', () => {
  const original = fixture.events.find(e => e.name === 'InputLatency::MouseDown').ts;
  const pending = { name: 'InputLatency::MouseMove', ph: 'b', pid: 11, tid: 1, ts: original,
    id: '0x999', args: {} };
  const colliding = collect([...fixture.events, pending, { ...pending, name: 'InputLatency::MouseDown' }]);
  assert.equal(colliding.trigger.status, 'unknown');
  const earlier = anotherFlow(5);
  for (const e of earlier) {
    e.ts -= 1000000;
    for (const c of e.args?.chrome_latency_info?.component_info || []) c.time_us -= 1000000;
  }
  const unresolved = { ...pending, name: 'InputLatency::MouseDown', id: '0x998',
    args: { chrome_latency_info: { trace_id: 5, is_coalesced: false } } };
  const linked = collect([...fixture.events, ...earlier, unresolved]);
  assert.equal(linked.trigger.status, 'unknown');
  assert(linked.flows.find(f => f.traceId === '5').issues.includes('duplicate-identity'));
});

function targetAtEnd(count = 120) {
  const original = fixture.events.find(e => e.name === 'InputLatency::MouseDown' && e.ph === 'b').ts;
  const events = clone(fixture.events.filter(e => e.name === 'clock_sync' || e.name === 'thread_name'));
  for (let id = 1; id <= count; id++) {
    const start = original - (count - id + 1) * 3000 - 10000;
    const compressed = anotherFlow(id);
    for (const e of compressed) {
      e.ts = start + Math.round((e.ts - original) / 1000);
      if (e.dur !== undefined) e.dur = Math.round(e.dur / 1000);
      if (e.tdur !== undefined) e.tdur = Math.round(e.tdur / 1000);
      for (const c of e.args?.chrome_latency_info?.component_info || []) c.time_us = start + Math.round((c.time_us - original) / 1000);
    }
    events.push(...compressed);
  }
  events.push(...anotherFlow(1000));
  return events;
}

test('slow target at END of >64 inputs and >4096 records wins output before old flows', () => {
  const events = targetAtEnd();
  assert.ok(events.length > 4096); assert.ok(Buffer.byteLength(encode(events)) < 2 * 1024 * 1024);
  for (const maxOutputBytes of [262144, 22000]) {
    const r = collect(events, {}, { maxFlows: 512, maxRecords: 16384, maxOutputBytes });
    assert.equal(r.trigger.status, 'matched'); assert.equal(r.trigger.traceId, '1000');
    assert.equal(r.flows[0].traceId, '1000'); assert.equal(r.flows[0].largestMeasuredStage.durationMs, 152.539);
    assert.ok(r.flows[0].nativeEvidence.length > 0); assert.ok(r.omitted.outputFlows > 0);
    assert.equal(r.omitted.records, 0); assert.equal(r.omitted.flowRecords, 0);
    assert.equal(r.status, 'partial', 'whole report omits old output; selected target proof remains complete');
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= maxOutputBytes);
    assert.ok(r.stats.retainedBytes <= r.limits.retainedBytes);
  }
  assert.equal(collect(events).trigger.status, 'matched', 'new defaults also cover the full analysis');
  const legacyCaller = collect(events, {}, { maxFlows: 64, maxRecords: 4096 });
  assert.equal(legacyCaller.trigger.status, 'unknown', 'parent must update explicit old maxima before shipping');
  assert.ok(legacyCaller.omitted.flowRecords > 0 || legacyCaller.omitted.records > 0);
});

test('output pruning cannot hide an older matching candidate or keep a match without target proof', () => {
  const events = targetAtEnd();
  events.splice(4, 0, ...anotherFlow(999));
  const ambiguous = collect(events, {}, { maxOutputBytes: 22000 });
  assert.equal(ambiguous.trigger.status, 'ambiguous'); assert.equal(ambiguous.trigger.candidateCount, 2);
  assert.deepEqual(ambiguous.trigger.candidates, ['999', '1000']);
  assert.equal(ambiguous.flows[0].traceId, '999'); assert.ok(ambiguous.omitted.outputFlows > 0);
  const tiny = collect(targetAtEnd(), {}, { maxOutputBytes: 4096 });
  assert.equal(tiny.trigger.status, 'unknown'); assert.equal(tiny.trigger.reason, 'output-limit');
  assert.ok(!tiny.flows.some(f => f.traceId === '1000')); assert.ok(Buffer.byteLength(JSON.stringify(tiny)) <= 4096);
});

test('flow/record/projection byte exhaustion invalidates the full candidate audit, not just omitted rows', () => {
  const events = [...fixture.events, ...anotherFlow(5)]; // apparently unique first flow has a later competitor
  for (const options of [{ maxFlows: 1 }, { maxRecords: 46 }, { maxRetainedBytes: 1024 }]) {
    const r = collect(events, {}, options);
    assert.equal(r.trigger.status, 'unknown'); assert.equal(r.trigger.reason, 'incomplete-evidence');
    assert.ok(r.omitted.flowRecords || r.omitted.records || r.omitted.retainedByteRecords);
    assert.ok(r.stats.retainedBytes <= r.limits.retainedBytes);
  }
  const r = collect([], {}, { maxFlows: 999999, maxRecords: 999999, maxRetainedBytes: 99999999, maxOutputBytes: 99999999 });
  assert.equal(r.limits.flows, 512); assert.equal(r.limits.records, 16384);
  assert.equal(r.limits.retainedBytes, 4194304); assert.equal(r.limits.outputBytes, 262144); assert.equal(r.limits.outputFlows, 64);
});

test('actual minimal 150ms control, plus explicitly synthetic renderer/Main clock-join receipt', () => {
  const r = collect(), f = r.flows[0];
  assert.equal(r.status, 'complete'); assert.equal(r.trigger.status, 'matched');
  assert.equal(r.trigger.traceId, '4'); assert.equal(f.nativeType, 'MouseDown');
  assert.equal(r.clock.uncertaintyMs, 0.59033203125);
  assert.equal(f.largestMeasuredStage.name, 'RendererMainProcessing');
  assert.equal(f.largestMeasuredStage.category, 'renderer-processing');
  assert.equal(f.largestMeasuredStage.durationMs, 152.539);
  assert.equal(stage(f, 'RendererMainProcessing').threadMs, null, 'async emitter is not the processing thread');
  assert.equal(stage(f, 'RendererCompositorQueueingDelay').durationMs, 0.023);
  assert.equal(f.linkedNativeIntervals[0].durationMs, 152.556);
  assert.equal(f.linkedNativeIntervals[0].threadMs, 151.09);
  assert.equal(f.linkedNativeIntervals[0].evidence, 'exact-trace-id');
  assert.equal(f.linkedNativeIntervals[0].cpuQualification, 'exact-flow-and-thread');
  assert.equal(r.unboundNativeIntervals[0].durationMs, 152.535);
  assert.equal(r.unboundNativeIntervals[0].threadMs, 151.069);
  assert.equal(r.unboundNativeIntervals[0].association, 'unbound');
  assert.notEqual(f.inputInterval.endUs, f.eventInterval.endUs, 'distinct native ends must not be conflated');
  assert.match(r.interpretation, /FrameSwap is not physical scanout/);
});

test('200ms shifted native queue stays separate from renderer processing and overlapping JS/visible-commit', () => {
  const events = clone(fixture.events);
  const pivot = events.find(e => e.name === 'RendererCompositorQueueingDelay' && e.ph === 'e').ts;
  for (const e of events) {
    if (e.name === 'clock_sync') continue;
    if (e.ts >= pivot) e.ts += 200000;
    for (const c of e.args.chrome_latency_info?.component_info || []) if (c.time_us >= pivot) c.time_us += 200000;
  }
  events.push({ name: 'FunctionCall', ph: 'X', pid: 22, tid: 1, ts: pivot, dur: 300000,
    args: { data: { url: 'SECRET_FUNCTION_URL', functionName: 'SECRET_FUNCTION' } } });
  events.push({ name: 'visible-commit', ph: 'X', pid: 22, tid: 1, ts: pivot, dur: 18000000 });
  const r = collect(events), f = r.flows[0];
  assert.equal(r.trigger.status, 'matched');
  assert.equal(f.largestMeasuredStage.name, 'RendererCompositorQueueingDelay');
  assert.equal(f.largestMeasuredStage.category, 'renderer-queue');
  assert.equal(f.largestMeasuredStage.durationMs, 200.023);
  assert.equal(stage(f, 'RendererMainProcessing').durationMs, 152.539);
  assert.equal(f.linkedNativeIntervals[0].threadMs, 151.09);
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.ok(!JSON.stringify(r).includes('visible-commit'));
});

test('missing/duplicate clock markers, conflicting bounds, nonmonotonic snapshots and no extrapolation', () => {
  const conflict = clone(fixture.clockMarkers);
  for (const key of ['before', 'after']) { conflict[1][key].now += 10; conflict[1][key].epochMs += 10; }
  const nonmonotonic = clone(fixture.clockMarkers);
  nonmonotonic[1].after.now = nonmonotonic[1].before.now - 1;
  const cases = [
    { clockMarkers: [] }, { clockMarkers: fixture.clockMarkers.slice(0, 1) },
    { clockMarkers: [fixture.clockMarkers[0], fixture.clockMarkers[0]] },
    { clockMarkers: conflict }, { clockMarkers: nonmonotonic },
  ];
  for (const finish of cases) {
    const r = collect(undefined, finish);
    assert.notEqual(r.clock.status, 'bounded'); assert.equal(r.flows[0].largestMeasuredStage.durationMs, 152.539);
    assert.equal(r.trigger.status, 'unknown');
  }
  assert.equal(collect(undefined, { clockMarkers: conflict }).clock.status, 'conflict');
  const duplicate = collect([...fixture.events, fixture.events.find(e => e.name === 'clock_sync')]);
  assert.equal(duplicate.clock.reason, 'duplicate-clock-event');
  const absent = collect(fixture.events.filter(e => e.args?.sync_id !== 'fixture-clock-0'));
  assert.equal(absent.clock.reason, 'missing-clock-event');
  const shifted = clone(fixture.events);
  for (const e of shifted) if (e.name !== 'clock_sync') {
    e.ts += 2000000;
    for (const c of e.args.chrome_latency_info?.component_info || []) c.time_us += 2000000;
  }
  assert.equal(collect(shifted).flows[0].absoluteClockStatus, 'unknown');
});

test('loss/unknown export status prevents precise chain/trigger qualification but keeps measured intervals', () => {
  for (const finish of [{ completeExport: false }, { dataLoss: true }, { dataLoss: undefined }]) {
    const r = collect(undefined, finish);
    assert.equal(r.status, 'partial'); assert.equal(r.trigger.status, 'unknown');
    assert.equal(r.flows[0].largestMeasuredStage, null);
    assert.equal(stage(r.flows[0], 'RendererMainProcessing').durationMs, 152.539);
  }
});

test('missing pairs, duplicate roots/IDs, negative/nonmonotonic stages and missing core stages stay partial', () => {
  const missing = fixture.events.filter(e => !(e.name === 'RendererMainProcessing' && e.ph === 'e'));
  const negative = clone(fixture.events);
  negative.find(e => e.name === 'RendererMainProcessing' && e.ph === 'e').ts =
    negative.find(e => e.name === 'RendererMainProcessing' && e.ph === 'b').ts - 1;
  const duplicate = [...fixture.events, ...fixture.events.filter(e => e.name === 'InputLatency::MouseDown')];
  const noStage = fixture.events.filter(e => e.name !== 'RendererMainProcessing');
  const wrongOriginal = clone(fixture.events);
  wrongOriginal.find(e => e.args.chrome_latency_info?.component_info).args.chrome_latency_info.component_info
    .find(c => c.component_type.endsWith('_ORIGINAL')).time_us += 1000000;
  for (const events of [missing, negative, duplicate, noStage, wrongOriginal]) {
    const r = collect(events); assert.notEqual(r.status, 'complete');
    assert.equal(r.flows[0].largestMeasuredStage, null); assert.notEqual(r.trigger.status, 'matched');
  }
  const repeatedTraceId = anotherFlow(4);
  const r = collect([...fixture.events, ...repeatedTraceId]);
  assert.equal(r.flows[0].status, 'ambiguous'); assert.equal(r.trigger.status, 'ambiguous');
});

test('own Main/renderer scope is mandatory; foreign PID cannot close a local pair or supply clocks', () => {
  assert.throws(() => createInputLatencyCollector(), /PIDs/);
  assert.throws(() => createInputLatencyCollector({ mainPid: 1, rendererPid: 1 }), /PIDs/);
  const foreign = clone(fixture.events).map(e => ({ ...e, pid: e.pid + 100 }));
  const r = collect([...fixture.events, ...foreign]);
  assert.equal(r.status, 'complete'); assert.equal(r.flows.length, 1); assert.ok(r.stats.foreignEvents > 0);
  const wrongPid = clone(fixture.events);
  wrongPid.find(e => e.name === 'EventLatency' && e.ph === 'e').pid = 11;
  assert.equal(collect(wrongPid).flows[0].largestMeasuredStage, null);
  assert.ok(collect(wrongPid).stats.wrongRoleEvents > 0);
  const foreignClock = clone(fixture.events);
  for (const e of foreignClock) if (e.name === 'clock_sync') e.pid = 999;
  assert.notEqual(collect(foreignClock).clock.status, 'bounded');
});

test('unsafe rounded numeric IDs are rejected; exact uint64 strings survive without collision', () => {
  for (const id of [9007199254740992, '18446744073709551616', '-1', 'SECRET_ID']) {
    const events = clone(fixture.events);
    for (const e of events) {
      if (e.args.chrome_latency_info?.trace_id !== undefined) e.args.chrome_latency_info.trace_id = id;
      if (e.args.event_latency) e.args.event_latency.event_latency_id = id;
    }
    const r = collect(events); assert.equal(r.flows.length, 0); assert.ok(r.stats.invalidIds > 0);
    assert.equal(r.trigger.status, 'unknown');
  }
  const exact = clone(fixture.events);
  for (const e of exact) {
    if (e.args.chrome_latency_info?.trace_id !== undefined) e.args.chrome_latency_info.trace_id = '18446744073709551615';
    if (e.args.event_latency) e.args.event_latency.event_latency_id = '18446744073709551615';
    if (e.id2) e.id2.local = '0xffffffffffffffff';
  }
  const r = collect(exact); assert.equal(r.flows[0].traceId, '18446744073709551615'); assert.equal(r.trigger.status, 'matched');
  const badPairId = clone(exact); badPairId.find(e => e.id2).id2.local = 9007199254740992;
  assert.notEqual(collect(badPairId).trigger.status, 'matched');
});

test('coalesced wheel is not an individual input; timestamp ambiguity is explicit', () => {
  const wheel = clone(fixture.events);
  for (const e of wheel) {
    if (e.name.startsWith('InputLatency::')) e.name = 'InputLatency::MouseWheel';
    if (e.args.chrome_latency_info?.component_info) e.args.chrome_latency_info.is_coalesced = true;
    if (e.args.event_latency) e.args.event_latency.event_type = 'MOUSE_WHEEL';
    if (e.args.type) e.args.type = 'MouseWheel';
  }
  const trigger = clone(fixture.trigger); trigger.nativeOriginal.type = 'wheel';
  const r = collect(wheel, { trigger }); assert.equal(r.trigger.status, 'coalesced');
  assert.equal(r.flows[0].coalesced, true); assert.equal(r.flows[0].largestMeasuredStage, null);
  const ambiguous = collect([...fixture.events, ...anotherFlow(5)]);
  assert.equal(ambiguous.trigger.status, 'ambiguous'); assert.deepEqual(ambiguous.trigger.candidates, ['4', '5']);
  const incomplete = anotherFlow(5);
  const info = incomplete.find(e => e.args.chrome_latency_info?.component_info).args.chrome_latency_info;
  info.component_info = info.component_info.filter(c => !c.component_type.endsWith('_ORIGINAL'));
  assert.equal(collect([...fixture.events, ...incomplete]).trigger.status, 'unknown');
});

test('UI binding requires native original, matching captured document and renderer; no phase timestamp fallback', () => {
  for (const patch of [{ rendererPid: 33 }, { documentTimeOriginMs: fixture.options.documentTimeOriginMs - 1 },
    { nativeOriginal: null }, { nativeOriginal: { type: 'click', timeStampMs: 2570.9 } },
    { nativeOriginal: { type: 'pointerdown', pointerType: 'touch', timeStampMs: 2570.9 } }]) {
    const trigger = { ...fixture.trigger, ...patch, phase: 'visible-commit', durationMs: 18000 };
    assert.equal(collect(undefined, { trigger }).trigger.status, 'unknown');
  }
  assert.equal(collect(undefined, {}, { documentTimeOriginMs: undefined }).trigger.status, 'unknown');
  const trigger = clone(fixture.trigger); trigger.nativeOriginal.timeStampMs += 1000;
  assert.equal(collect(undefined, { trigger }).trigger.status, 'unmatched');
});

test('renderer/Main clock relation is required independently; bounded nonzero offset is applied', () => {
  const missing = collect(undefined, { rendererClockRelation: undefined });
  assert.equal(missing.trigger.status, 'unknown');
  assert.equal(missing.trigger.reason, 'missing-renderer-clock-relation');
  assert.equal(missing.flows[0].largestMeasuredStage.durationMs, 152.539, 'native interval does not need a UI join');
  const trigger = clone(fixture.trigger); trigger.nativeOriginal.timeStampMs -= 50;
  assert.equal(collect(undefined, { trigger }).trigger.status, 'unmatched');
  const shifted = collect(undefined, { trigger, rendererClockRelation: clockRelation(50) });
  assert.equal(shifted.trigger.status, 'matched');
  assert.ok(shifted.trigger.uncertaintyMs > shifted.clock.uncertaintyMs);
  assert.ok(shifted.rendererClock.offsetLowMs > 49);
  const foreign = clockRelation(); foreign.renderer.timeOrigin += 1; foreign.renderer.now -= 1;
  assert.equal(collect(undefined, { rendererClockRelation: foreign }).trigger.reason, 'foreign-document-clock-relation');
  const negative = clockRelation(); negative.mainAfter = negative.mainBefore; negative.mainBefore = clockRelation().mainAfter;
  assert.equal(collect(undefined, { rendererClockRelation: negative }).trigger.reason, 'invalid-renderer-clock-relation');
});

test('safe native b/e, numeric IDs and component_info survive for independent reanalysis', () => {
  const original = collect(), f = original.flows[0];
  assert.ok(f.nativeEvidence.some(e => e.name === 'EventLatency' && e.id2?.local));
  assert.ok(f.nativeEvidence.some(e => e.args?.chrome_latency_info?.component_info?.length));
  const replay = collect([...fixture.events.filter(e => e.name === 'clock_sync'), ...original.threadEvidence, ...f.nativeEvidence]);
  assert.deepEqual(replay.flows[0].largestMeasuredStage, f.largestMeasuredStage);
  assert.equal(replay.trigger.status, 'matched');
  assert.equal(replay.flows[0].linkedNativeIntervals[0].threadMs, 151.09);
});

test('CPU requires exact Flow X plus owned thread metadata, never async-stage emitter or overlap', () => {
  for (const events of [fixture.events.filter(e => e.name !== 'thread_name'),
    [...fixture.events, { name: 'thread_name', ph: 'M', pid: 22, tid: 1, ts: 0, args: { name: 'Compositor' } }]]) {
    const r = collect(events);
    assert.equal(r.flows[0].linkedNativeIntervals[0].threadMs, null);
    assert.equal(r.flows[0].linkedNativeIntervals[0].cpuQualification, 'unknown-thread');
    assert.equal(r.flows[0].largestMeasuredStage.durationMs, 152.539);
  }
  const r = collect(fixture.events.filter(e => e.name !== 'LatencyInfo.Flow'));
  assert.equal(r.flows[0].linkedNativeIntervals.length, 0);
  assert.equal(stage(r.flows[0], 'RendererMainProcessing').threadMs, null);
  assert.equal(r.unboundNativeIntervals[0].association, 'unbound');
  const flow = fixture.events.find(e => e.name === 'LatencyInfo.Flow');
  const duplicate = collect([...fixture.events, flow]);
  assert.ok(duplicate.flows[0].issues.includes('duplicate-native-interval'));
  assert.equal(duplicate.flows[0].linkedNativeIntervals[0].threadMs, null);
  const outside = clone(fixture.events);
  outside.find(e => e.name === 'LatencyInfo.Flow').ts += 1000000;
  assert.ok(collect(outside).flows[0].issues.includes('native-interval-outside-root'));
});

test('actual Chrome final-event metadata trailer preserves last pair and does not parse private metadata', () => {
  const collector = createInputLatencyCollector(fixture.options);
  const events = fixture.events.filter(e => e.name !== 'thread_name');
  collector.write('{"traceEvents":[\n' + events.map(e => JSON.stringify(e)).join(',\n')
    + '],"metadata":\n{"command_line":"SECRET EventLatency", "details":{"name":"clock_sync"}}}');
  const r = collector.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers });
  assert.equal(r.stats.malformedLines, 0); assert.equal(r.flows[0].status, 'measured');
  assert.equal(r.flows[0].largestMeasuredStage.durationMs, 152.539);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const { createLayoutRootCollector } = require('./perf-incident-ui');
  const layout = createLayoutRootCollector({ rendererPid: 22 });
  layout.write('{"traceEvents":[\n{"name":"Layout","pid":22,"args":{"endData":{"layoutRoots":[{"nodeId":7}]}}}]' + ',"metadata":\n'
    + '{"name":"Layout","pid":22,"args":{"endData":{"layoutRoots":[{"nodeId":999}]}}}}');
  assert.deepEqual(layout.finish(true).roots, [{ backendNodeId: 7, occurrences: 1 }]);
});

test('invalid times and duplicated components retain partial evidence, never repaired by sorting/coercion', () => {
  for (const invalid of [-1, NaN, 9007199254740992, '100']) {
    const events = clone(fixture.events); events.find(e => e.name === 'EventLatency').ts = invalid;
    const r = collect(events); assert.ok(r.stats.invalidTimes > 0); assert.notEqual(r.trigger.status, 'matched');
  }
  const events = clone(fixture.events);
  const info = events.find(e => e.args.chrome_latency_info?.component_info).args.chrome_latency_info;
  info.component_info.push(clone(info.component_info[0]));
  assert.ok(collect(events).flows[0].issues.includes('invalid-components'));
  const badThread = clone(fixture.events);
  badThread.find(e => e.name === 'LatencyInfo.Flow').tdur = 999999;
  const r = collect(badThread); assert.ok(r.stats.invalidThreadTimes > 0);
  assert.equal(r.flows[0].linkedNativeIntervals[0].threadMs, null);
});

test('projected persistence excludes malicious args, document/source/coordinates and raw sync IDs', () => {
  const canary = 'SECRET_PAYLOAD_9347', events = clone(fixture.events), markers = clone(fixture.clockMarkers);
  markers[0].syncId = canary;
  for (const e of events) {
    if (e.args.sync_id === 'fixture-clock-0') e.args.sync_id = canary;
    Object.assign(e.args, { key: canary, text: canary, code: canary, url: canary, x: 888888, y: 777777,
      data: { source: canary }, '__proto__': { poisoned: canary } });
    e.url = canary; e.frame = canary; e.nameOfDocument = canary;
    if (e.args.chrome_latency_info?.component_info) e.args.chrome_latency_info.component_info.push({ component_type: canary, time_us: 123 });
  }
  const r = collect(events, { clockMarkers: markers, trigger: { ...fixture.trigger, text: canary } });
  assert.equal(r.trigger.status, 'matched'); assert.ok(r.stats.unknownComponents > 0);
  const json = JSON.stringify(r);
  for (const value of [canary, '888888', '777777', 'sync_id']) assert.ok(!json.includes(value), value);
  assert.ok(json.includes('chrome_latency_info')); assert.ok(json.includes('component_type'));
  assert.equal({}.poisoned, undefined);
});

test('stream chunk boundaries including split UTF-8 preserve result and late writes cannot mutate finish', () => {
  const events = clone(fixture.events);
  events[0].args.privateText = 'Скрыто 😀';
  const whole = collect(events, {}, {}, 100000), tiny = collect(events, {}, {}, 1);
  assert.deepEqual(tiny, whole);
  const c = createInputLatencyCollector(fixture.options); c.write(encode(events));
  const a = c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers });
  c.write(encode(anotherFlow(9))); assert.equal(c.finish({ completeExport: false }), a);
});

test('overlong line recovery, truncated tail, malformed candidate and input byte cap are explicit', () => {
  const c = createInputLatencyCollector({ ...fixture.options, maxCarryBytes: 1024 });
  c.write('{"name":"EventLatency","private":"' + 'x'.repeat(3000) + '"}\n'); c.write(encode(fixture.events));
  const r = c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers });
  assert.equal(r.stream.overlongLines, 1); assert.ok(r.stream.peakCarryBytes <= 1024);
  assert.equal(r.flows.length, 1); assert.equal(r.flows[0].largestMeasuredStage, null);
  const partial = createInputLatencyCollector(fixture.options);
  partial.write(encode(fixture.events).replace(/\n\]}$/, '') + '\n{"name":"EventLatency"');
  assert.ok(partial.finish({ completeExport: false }).stream.incompleteTailBytes > 0);
  const malformed = createInputLatencyCollector(fixture.options);
  malformed.write('{"name":"EventLatency",oops}\n');
  assert.equal(malformed.finish({ completeExport: true }).stats.malformedLines, 1);
  const bounded = createInputLatencyCollector(fixture.options);
  bounded.write(Buffer.alloc(4194404, 120)); bounded.write('extra');
  const b = bounded.finish({ completeExport: true });
  assert.equal(b.stream.acceptedBytes, 4194304); assert.equal(b.stream.omittedBytes, 105);
  assert.equal(b.stream.completeExport, false); assert.ok(b.stream.peakCarryBytes <= 65536);
});

test('flow, record and output caps are enforced with explicit counts, including 256KiB default', () => {
  const many = fixture.events.filter(e => e.name === 'clock_sync');
  for (let i = 1; i <= 64; i++) many.push(...anotherFlow(i));
  const f = collect(many, {}, { maxFlows: 1 });
  assert.equal(f.flows.length, 1); assert.ok(f.omitted.flowRecords > 0); assert.equal(f.trigger.status, 'unknown');
  const r = collect(undefined, {}, { maxRecords: 8 });
  assert.equal(r.stats.retainedRecords, 8); assert.ok(r.omitted.records > 0);
  for (const maxOutputBytes of [4096, 262144, 1000000]) {
    const report = collect(many, {}, { maxOutputBytes });
    assert.ok(Buffer.byteLength(JSON.stringify(report)) <= Math.min(maxOutputBytes, 262144));
    assert.ok(report.omitted.outputFlows > 0); assert.equal(report.trigger.status, 'ambiguous');
    assert.equal(report.trigger.candidateCount, 64); assert.equal(report.trigger.candidates.length, 16);
    assert.equal(report.trigger.omittedCandidates, 48);
    assert.equal(report.status, 'partial');
  }
});

test('shared reader bounds string decoding/carry and retains original no-byte-cap layout behavior', () => {
  const rows = [], r = createTraceLineReader({ maxCarryBytes: 64, maxBytes: 512, onLine: line => rows.push(line) });
  r.write('x'.repeat(100) + '\n{"ok":1}\n' + 'z'.repeat(1000));
  const result = r.finish(true);
  assert.deepEqual(rows, ['{"ok":1}']); assert.equal(result.acceptedBytes, 512);
  assert.equal(result.overlongLines, 2); assert.ok(result.omittedBytes > 0);
  assert.ok(result.peakCarryBytes <= 64);
});
