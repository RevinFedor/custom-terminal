'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTraceProjectionWriter, createNativeTraceProjectionAdapter, describeTraceMaxRss, LIMITS } = require('./perf-trace-projection');
const { createInputLatencyCollector } = require('./perf-input-latency');

function event(name = 'FunctionCall', more = {}) {
  return { name, cat: 'devtools.timeline', ph: 'X', pid: 22, tid: 2, ts: 100, dur: 10, ...more };
}
function encode(rows, tail = '] }') { return '{"traceEvents":[\n' + rows.map(e => JSON.stringify(e)).join(',\n') + '\n' + tail; }
async function setup(t, options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-projection-')));
  const file = path.join(dir, 'incident-123-456.trace.json');
  const c = { file, incidentDir: dir, incidentId: 'incident-123-456', mainPid: 11, rendererPid: 22,
    deadlineAt: Date.now() + 10000, ...options };
  const w = createTraceProjectionWriter(c);
  t.after(async () => { await w.abort(); fs.rmSync(dir, { recursive: true, force: true }); });
  await w.ready;
  return { w, dir, file, c };
}
async function writeAll(w, data, size = 65536) {
  const b = Buffer.from(data);
  let ack;
  for (let i = 0; i < b.length; i += size) { ack = await w.write(b.subarray(i, i + size)); if (!ack.continue) break; }
  return ack;
}

test('closed allowlist, exclusive mode, metadata privacy, exact bytes and owned exit', async t => {
  const { w, file } = await setup(t);
  const secret = 'SECRET_BODY_DO_NOT_STORE';
  await writeAll(w, encode([
    event('FunctionCall', { args: { text: secret, data: { url: 'https://secret.invalid/' + secret, functionName: secret } } }),
    event('ThreadControllerImpl::RunTask', { cat: 'toplevel', args: { src_func: secret } }),
    event(secret), event('Layout', { pid: 33 }), event('Paint', { args: { data: { clip: [1, 2], text: secret } } }),
    event('EventDispatch', { args: { data: { type: 'click', text: secret } } }),
    event('V8.GC_SCAVENGER', { cat: 'devtools.timeline,disabled-by-default-v8.gc', args: { secret } }),
  ], '],"metadata":{"name":"FunctionCall","args":{"text":"' + secret + '"}}'));
  const result = await w.finish({ completeExport: true, dataLoss: false });
  const text = fs.readFileSync(file, 'utf8'), json = JSON.parse(text);
  assert.equal(text.includes(secret), false);
  assert.deepEqual(json.traceEvents.map(e => e.name), ['FunctionCall', 'ThreadControllerImpl::RunTask', 'Paint', 'EventDispatch', 'V8.GC_SCAVENGER']);
  assert.equal(result.complete, true); assert.equal(result.closed.acknowledged, true);
  assert.equal(result.closed.code, 0); assert.equal(result.projectedBytes, fs.statSync(file).size);
  assert.equal(json.projection.projectedBytes, result.projectedBytes);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(result.cost.maxRss > 0); assert.equal(result.cost.maxRssUnit, 'KiB');
  assert.equal(result.cost.runtime.node, process.versions.node); assert.equal(result.cost.maxRssKiB, undefined);
  assert.equal(result.limits.heapMiB, 128);
});

test('one credit only, chunk limit, copied bytes, no queued write or replay', async t => {
  const { w, file } = await setup(t);
  await assert.rejects(w.write(Buffer.alloc(65537)), /chunk-limit/);
  const chunk = Buffer.from(encode([event()]));
  const pending = w.write(chunk); chunk.fill(32);
  await assert.rejects(w.write('next'), /credit-exhausted/);
  await pending;
  const r = await w.finish({ completeExport: true });
  assert.equal(r.projectedCount, 1); assert.equal(JSON.parse(fs.readFileSync(file)).traceEvents[0].name, 'FunctionCall');
  await assert.rejects(w.write('next'), /not-ready/);
});

test('native zero instant, id2, clock, types, components and thread roles survive collector', async t => {
  const fixture = require('./perf-input-latency.same-time.fixture.json');
  const options = fixture.options;
  const syncIds = (fixture.clockMarkers || []).map(m => m.syncId);
  // Fixture schema is consumed directly by the same native collector.
  const { w, file } = await setup(t, { mainPid: options.mainPid, rendererPid: options.rendererPid, clockSyncIds: syncIds });
  await writeAll(w, encode(fixture.events), 37);
  const r = await w.finish({ completeExport: true });
  const output = fs.readFileSync(file, 'utf8'), rows = JSON.parse(output).traceEvents;
  const originalN = fixture.events.filter(e => e.ph === 'n');
  assert.ok(originalN.length); assert.deepEqual(rows.filter(e => e.ph === 'n').map(e => [e.name, e.ts, e.id2]), originalN.map(e => [e.name, e.ts, e.id2]));
  const before = createInputLatencyCollector(options), after = createInputLatencyCollector(options);
  before.write(encode(fixture.events)); after.write(output);
  const finish = { completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers, trigger: fixture.trigger };
  const a = before.finish(finish), b = after.finish({ ...finish, completeExport: r.complete, dataLoss: r.dataLoss });
  assert.deepEqual(b.flows, a.flows); assert.deepEqual(b.clock, a.clock);
  assert.equal(r.inputLossRecords, 0);
});

test('unknown input fields and unknown input vocab record loss without leaking values', async t => {
  const { w, file } = await setup(t);
  await w.write(encode([
    event('EventLatency', { ph: 'b', id2: { local: '0x123' }, args: { event_latency: { event_type: 'MOUSE_WHEEL', event_latency_id: '14', secret: 'PRIVATE_SENTINEL' } } }),
    event('InputLatency::PRIVATE_SENTINEL', { id: 14 }),
    event('LatencyInfo.Flow', { args: { chrome_latency_info: { trace_id: '14', step: 'PRIVATE_SENTINEL' } } }),
    event('clock_sync', { ph: 'c', pid: 11, args: { sync_id: 'PRIVATE_SENTINEL' } }),
  ]));
  const r = await w.finish({ completeExport: true });
  assert.equal(r.complete, true); assert.equal(r.dataLoss, true); assert.equal(r.inputCoverage, 'unknown');
  assert.ok(r.inputLossRecords >= 4); assert.equal(fs.readFileSync(file, 'utf8').includes('PRIVATE_SENTINEL'), false);
});

test('partial raw EOF, overlong event, malformed and minified rows never claim complete', async t => {
  for (const input of [encode([event()], ''), encode([event('Layout', { args: { secret: 'x'.repeat(70000) } })]),
    '{"traceEvents":[\n{bad}\n]}', '{"traceEvents":[' + JSON.stringify(event()) + ',' + JSON.stringify(event()) + ']}']) {
    await t.test('bounded partial', async t => {
      const { w, file } = await setup(t);
      await writeAll(w, input);
      const r = await w.finish({ completeExport: true });
      assert.equal(r.complete, false); assert.equal(r.dataLoss, true);
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file)));
      assert.ok(r.reader.peakCarryBytes <= 65536);
    });
  }
});

test('event, raw ingress and artifact caps remain finite; finish yields valid partial JSON', async t => {
  await t.test('event limit', async t => {
    const { w } = await setup(t, { maxEvents: 3 });
    const ack = await writeAll(w, encode(Array.from({ length: 20 }, () => event())));
    assert.equal(ack.continue, false);
    const r = await w.finish({ completeExport: true });
    assert.equal(r.complete, false); assert.equal(r.eventCount, 3); assert.ok(r.omitted.eventLimit);
  });
  await t.test('artifact limit', async t => {
    const { w, file } = await setup(t, { maxProjectedBytes: 9000 });
    await writeAll(w, encode(Array.from({ length: 200 }, () => event())));
    const r = await w.finish({ completeExport: true });
    assert.ok(r.omitted.artifactLimit); assert.equal(r.complete, false);
    assert.ok(fs.statSync(file).size <= 9000); JSON.parse(fs.readFileSync(file));
  });
  await t.test('raw ingress', async t => {
    const { w } = await setup(t, { maxRawBytes: 100 });
    await assert.rejects(w.write(Buffer.alloc(101)), /raw-limit/);
    await w.write('{"traceEvents":[\n');
    const r = await w.finish({ completeExport: false });
    assert.ok(r.rawBytes <= 100); assert.equal(r.complete, false);
  });
  assert.equal(LIMITS.rawBytes, 67108864); assert.equal(LIMITS.projectedBytes, 16777216);
  assert.equal(LIMITS.events, 300000);
});

test('root-proven code locations only; no sibling/traversal/query/remote URLs', async t => {
  const { w, file, dir } = await setup(t, { packagedRoot: '/usr' });
  const urls = ['/usr/packaged/app.js', '/usr-other/secret.js', '/usr/../secret.js', '/usr/app.js?secret', 'https://host/app.js'];
  await w.write(encode(urls.map(url => event('FunctionCall', { args: { data: { url, functionName: 'onClick', scriptId: '7', lineNumber: 8, columnNumber: 9, text: 'SECRET' } } }))));
  await w.finish({ completeExport: true });
  const rows = JSON.parse(fs.readFileSync(file)).traceEvents;
  assert.deepEqual(rows[0].args.data, { url: 'file:///usr/packaged/app.js', functionName: 'onClick', scriptId: '7', lineNumber: 8, columnNumber: 9 });
  assert.ok(rows.slice(1).every(e => !e.args.data));
});

test('existing file and symlink refused without overwrite; invalid incident address rejected', async t => {
  const { w, file, c, dir } = await setup(t);
  await w.abort();
  fs.writeFileSync(file, 'original');
  const second = createTraceProjectionWriter({ ...c, deadlineAt: Date.now() + 3000 });
  await assert.rejects(second.ready); await second.closed;
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  fs.unlinkSync(file); const target = path.join(dir, 'target'); fs.writeFileSync(target, 'original'); fs.symlinkSync(target, file);
  const third = createTraceProjectionWriter({ ...c, deadlineAt: Date.now() + 3000 });
  await assert.rejects(third.ready); await third.closed;
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.throws(() => createTraceProjectionWriter({ ...c, file: path.join(dir, 'wrong.trace.json') }), /invalid-path/);
});

test('deadline and lost IPC have explicit close proof, reject pending write, never replay', async t => {
  await t.test('original deadline', async t => {
    const { w } = await setup(t, { deadlineAt: Date.now() + 350 });
    const proof = await w.closed;
    assert.equal(proof.closed, true); assert.equal(proof.acknowledged, false); assert.ok(proof.signal === 'SIGKILL' || proof.code === 1);
    await assert.rejects(w.write('no'), /not-ready/);
  });
  await t.test('killed worker unknown ACK', async t => {
    const { w } = await setup(t);
    process.kill(w.pid, 'SIGSTOP');
    const pending = w.write(encode([event()]));
    process.kill(w.pid, 'SIGKILL');
    await assert.rejects(pending, /unknown|closed/);
    const proof = await w.closed; assert.equal(proof.acknowledged, false);
  });
});

test('metadata before traceEvents never parsed as native records', async t => {
  const { w, file } = await setup(t);
  await w.write('{"metadata":{\n' + JSON.stringify(event('Layout')) + '\n},"traceEvents":[' + JSON.stringify(event()) + ']}');
  const r = await w.finish({ completeExport: true });
  assert.equal(r.complete, false); assert.equal(r.dataLoss, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).traceEvents, []);
});

test('abort cleans owned child with pending credit and leaves other files untouched', async t => {
  const { w, dir } = await setup(t);
  const other = path.join(dir, 'other'); fs.writeFileSync(other, 'keep');
  process.kill(w.pid, 'SIGSTOP');
  const pending = w.write(encode([event()]));
  const rejected = assert.rejects(pending, /aborted/);
  const proof = await w.abort(); await rejected;
  assert.equal(proof.closed, true); assert.equal(proof.acknowledged, false);
  assert.throws(() => process.kill(w.pid, 0), /ESRCH/);
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
});

test('256KiB single-credit ingress and exact finite 64MiB raw cap without whole-stream object', async t => {
  const { w, file } = await setup(t, { chunkBytes: 262144, deadlineAt: Date.now() + 10000 });
  const header = Buffer.from('{"traceEvents":[\n');
  await w.write(header);
  const block = Buffer.alloc(262144, 32); block[block.length - 1] = 10;
  let remaining = LIMITS.rawBytes - header.length, ack;
  while (remaining) {
    const bytes = Math.min(remaining, block.length);
    ack = await w.write(block.subarray(0, bytes)); remaining -= bytes;
  }
  assert.equal(ack.rawBytes, LIMITS.rawBytes); assert.equal(ack.continue, false);
  await assert.rejects(w.write('x'), /raw-limit/);
  const r = await w.finish({ completeExport: false });
  assert.equal(r.rawBytes, LIMITS.rawBytes); assert.equal(r.complete, false);
  assert.ok(r.reader.peakCarryBytes <= LIMITS.lineBytes); assert.ok(r.reader.overlongLines);
  assert.ok(fs.statSync(file).size <= LIMITS.projectedBytes);
  assert.ok(r.cost.heapUsedBytes < 128 * 1024 * 1024);
});

test('real artifact ceiling stops safely without retaining the source stream', async t => {
  const { w, file } = await setup(t, { deadlineAt: Date.now() + 10000 });
  await w.write('{"traceEvents":[\n');
  const row = JSON.stringify(event()) + ',\n';
  const block = Buffer.from(row.repeat(Math.floor(65536 / Buffer.byteLength(row))));
  let ack;
  for (let i = 0; i < 1024; i++) { ack = await w.write(block); if (!ack.continue) break; }
  assert.equal(ack.continue, false);
  const r = await w.finish({ completeExport: false });
  assert.ok(r.omitted.artifactLimit); assert.ok(r.eventCount <= LIMITS.events);
  assert.ok(r.rawBytes <= LIMITS.rawBytes); assert.equal(r.complete, false);
  assert.ok(fs.statSync(file).size <= LIMITS.projectedBytes);
  // Inspect only a bounded tail, not the full maximum-sized artifact in Main.
  const fd = fs.openSync(file, 'r'), end = Buffer.alloc(8192);
  fs.readSync(fd, end, 0, end.length, fs.statSync(file).size - end.length); fs.closeSync(fd);
  assert.match(end.toString(), /noted-trace-projection-v1/);
});

test('complete controlled native input stays MATCHED with exact clocks; duplicate unknown role stays ambiguous', async t => {
  const f = require('./perf-input-latency.test.cjs');
  const { w, file } = await setup(t, { clockSyncIds: f.clockMarkers.map(m => m.syncId) });
  await writeAll(w, encode(f.events), 53);
  const r = await w.finish({ completeExport: true, dataLoss: false });
  const mainOrigin = f.clockMarkers[0].before.timeOrigin, center = 1793264278300;
  const sample = (timeOrigin, epochMs) => ({ timeOrigin, epochMs, now: epochMs - timeOrigin });
  const finish = { completeExport: r.complete, dataLoss: r.dataLoss, clockMarkers: f.clockMarkers, trigger: f.trigger,
    rendererClockRelation: { mainPid: 11, rendererPid: 22, mainBefore: sample(mainOrigin, center - .1),
      mainAfter: sample(mainOrigin, center + .1), renderer: sample(f.options.documentTimeOriginMs, center) } };
  const original = createInputLatencyCollector(f.options), projected = createInputLatencyCollector(f.options);
  original.write(encode(f.events)); projected.write(fs.readFileSync(file));
  const a = original.finish({ ...finish, completeExport: true, dataLoss: false }), b = projected.finish(finish);
  assert.equal(a.trigger.status, 'matched'); assert.equal(b.trigger.status, 'matched');
  assert.deepEqual(b.flows, a.flows); assert.deepEqual(b.clock, a.clock);
  assert.equal(r.inputLossRecords, 0);
});

test('conflicting thread metadata cannot become a false unique role after projection', async t => {
  const { w, file } = await setup(t);
  await w.write(encode([
    event('thread_name', { ph: 'M', args: { name: 'CrRendererMain' } }),
    event('thread_name', { ph: 'M', args: { name: 'PRIVATE_UNKNOWN_ROLE' } }),
  ]));
  await w.finish({ completeExport: true });
  const rows = JSON.parse(fs.readFileSync(file)).traceEvents;
  assert.deepEqual(rows.map(e => e.args.name), ['CrRendererMain', null]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('PRIVATE_UNKNOWN_ROLE'), false);
});

test('full 300k event budget counts omitted records and stops without unbounded parse/retention', async t => {
  const { w } = await setup(t);
  await w.write('{"traceEvents":[\n');
  const row = JSON.stringify(event('not-in-closed-vocabulary')) + ',\n';
  const block = Buffer.from(row.repeat(Math.floor(65536 / Buffer.byteLength(row))));
  let ack;
  for (let i = 0; i < 1024; i++) { ack = await w.write(block); if (!ack.continue) break; }
  assert.equal(ack.continue, false);
  const r = await w.finish({ completeExport: false });
  assert.equal(r.eventCount, LIMITS.events); assert.ok(r.omitted.eventLimit);
  assert.equal(r.projectedCount, 0); assert.ok(r.rawBytes <= LIMITS.rawBytes);
});

test('only exact audited names/steps become intentional filtering; unknowns keep their loss', async t => {
  const ignored = ['InputRouterImpl::FilterAndSendWebInputEvent', 'InputEventSentBlocking', 'InputEventSentNonBlocking',
    'WidgetInputHandlerManager::DidHandleInputEventSentToCompositor', 'WidgetInputHandlerManager::DidHandleInputEventSentToMain',
    'WebCoalescedInputEvent::CoalesceWith', 'TranslateAndScaleWebInputEvent'];
  const steps = ['STEP_SWAP_BUFFERS', 'STEP_DRAW_AND_SWAP', 'STEP_HANDLE_INPUT_EVENT_MAIN_COMMIT'];
  const { w, file } = await setup(t);
  await w.write(encode([...ignored.map(name => event(name)), ...steps.flatMap(step => ['X', 'I'].map(ph => event('LatencyInfo.Flow',
    { ph, args: { chrome_latency_info: { trace_id: '14', step } } })))]));
  const r = await w.finish({ completeExport: true, dataLoss: false });
  assert.equal(r.inputLossRecords, 0); assert.equal(r.dataLoss, false);
  assert.deepEqual(r.intentionalFiltered, { names: 7, flowSteps: 6 });
  assert.equal(r.nativeDataLoss, false); assert.equal(r.projectionDataLoss, false);
  assert.equal(r.omitted.unsafeInput, 0); assert.equal(r.classificationVersion, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).traceEvents, []);
  await t.test('similar names, unknown step/field and invalid known-step identity are still unknown', async t => {
    const { w } = await setup(t);
    await w.write(encode([
      event('InputEventSentBlocking.FUTURE_SECRET'),
      event('LatencyInfo.Flow', { args: { chrome_latency_info: { trace_id: '14', step: 'STEP_FUTURE_SECRET' } } }),
      event('LatencyInfo.Flow', { args: { chrome_latency_info: { trace_id: '14', step: steps[0], SECRET_KEY: true } } }),
      event('LatencyInfo.Flow', { args: { chrome_latency_info: { trace_id: 'SECRET_ID', step: steps[1] } } }),
    ]));
    const r = await w.finish({ completeExport: true, dataLoss: false });
    assert.equal(r.inputLossRecords, 4); assert.equal(r.dataLoss, true);
    assert.equal(JSON.stringify(r).includes('SECRET'), false);
  });
  await t.test('native loss is independent and cannot be excused by filtering', async t => {
    const { w } = await setup(t); await w.write(encode([event(ignored[0])]));
    const r = await w.finish({ completeExport: true, dataLoss: true });
    assert.equal(r.complete, true); assert.equal(r.inputLossRecords, 0);
    assert.equal(r.nativeDataLoss, true); assert.equal(r.projectionDataLoss, false); assert.equal(r.dataLoss, true);
  });
});

test('reject shapes distinguish fields/categories using static labels and bounded retention', async t => {
  const { w, file } = await setup(t);
  const input = (more = {}) => event('EventLatency', { ph: 'b', id2: { local: '1' }, ...more });
  await w.write(encode([
    input({ cat: 'input,PRIVATE_CATEGORY' }), input({ cat: 'input,PRIVATE CATEGORY' }),
    input({ args: { event_latency: { event_latency_id: 'SECRET_ID' } } }),
    input({ args: { event_latency: { event_type: 'SECRET_TYPE' } } }),
    input({ args: { event_latency: { SECRET_KEY: 'SECRET_BODY' } } }),
    event('LatencyInfo.Flow', { args: { chrome_latency_info: { component_info: [{}] } } }),
  ]));
  const r = await w.finish({ completeExport: true, dataLoss: false });
  assert.equal(r.inputLossRecords, 6);
  const rows = r.rejectShapes.entries;
  assert.ok(rows.some(x => x.reason === 'unsupported-category' && x.category === 'unlisted-token'));
  assert.ok(rows.some(x => x.reason === 'unsupported-category' && x.category === 'invalid-syntax'));
  assert.ok(rows.some(x => x.reason === 'invalid-id' && x.field === 'args.event_latency.event_latency_id'));
  assert.ok(rows.some(x => x.reason === 'unlisted-input-type' && x.field === 'args.event_latency.event_type'));
  assert.ok(rows.some(x => x.reason === 'unlisted-arg-field' && x.field === 'args.event_latency'));
  assert.ok(rows.some(x => x.reason === 'unlisted-component'));
  assert.equal(/SECRET|PRIVATE/.test(fs.readFileSync(file, 'utf8')), false);
  await t.test('counter overflow remains bounded and explicit; footer fits existing reservation', async t => {
    const { w, file } = await setup(t, { maxProjectedBytes: 8192 });
    const rows = [];
    const names = ['EventLatency', 'LatencyInfo.Flow', 'GenerationToBrowserMain', 'RendererMainProcessing', 'Layout', 'Paint', 'FunctionCall'];
    for (const name of names) for (const cat of [null, [], 'PRIVATE', 'PRIVATE FIELD', 'x'.repeat(257)]) rows.push(event(name, { cat }));
    await w.write(encode(rows)); const r = await w.finish({ completeExport: true, dataLoss: false });
    assert.equal(r.rejectShapes.total, rows.length); assert.ok(r.rejectShapes.omitted > 0);
    assert.ok(r.rejectShapes.entries.length <= 24); assert.ok(r.rejectShapes.reservedBytes <= 4096);
    assert.equal(r.rejectShapes.reasons['unsupported-category'], rows.length);
    assert.ok(fs.statSync(file).size <= 8192); JSON.parse(fs.readFileSync(file));
  });
});

test('RSS is raw with an explicit runtime unit, never guessed scaling', () => {
  const e28 = describeTraceMaxRss(102989824, { platform: 'darwin', node: '18.18.2', electron: '28.3.3' });
  assert.equal(e28.maxRss, 102989824); assert.equal(e28.maxRssUnit, 'unknown');
  assert.equal(e28.runtime.electron, '28.3.3'); assert.equal(e28.maxRssKiB, undefined);
  const node = describeTraceMaxRss(67184, { platform: 'darwin', node: '24.5.0' });
  assert.equal(node.maxRss, 67184); assert.equal(node.maxRssUnit, 'KiB');
  const unknown = describeTraceMaxRss(102989824, { platform: 'darwin', node: '22.0.0', electron: '35.0.0' });
  assert.equal(unknown.maxRss, 102989824); assert.equal(unknown.maxRssUnit, 'unknown');
});

function nativeFinishOptions(f) {
  const mainOrigin = f.clockMarkers[0].before.timeOrigin, center = 1793264278300;
  const sample = (timeOrigin, epochMs) => ({ timeOrigin, epochMs, now: epochMs - timeOrigin });
  return { completeExport: true, dataLoss: false, clockMarkers: f.clockMarkers, trigger: f.trigger,
    rendererClockRelation: { mainPid: 11, rendererPid: 22, mainBefore: sample(mainOrigin, center - .1),
      mainAfter: sample(mainOrigin, center + .1), renderer: sample(f.options.documentTimeOriginMs, center) } };
}
function adapterFor(data, options = {}) {
  const f = require('./perf-input-latency.test.cjs');
  const collector = createInputLatencyCollector(f.options);
  const projection = { schema: 'noted-trace-projection-v1', complete: true, dataLoss: false,
    nativeDataLoss: false, projectedBytes: Buffer.byteLength(data), ...options.proof };
  return { adapter: createNativeTraceProjectionAdapter({ collector, projection, ...options.limits }), collector, projection };
}

test('native adapter reaches late evidence after >4MiB engine data without raising collector budgets', () => {
  const f = require('./perf-input-latency.test.cjs'), head = '{"traceEvents":[\n', tail = '\n]}\n';
  const row = JSON.stringify(event()) + ',\n', block = row.repeat(Math.floor(65536 / Buffer.byteLength(row)));
  const blocks = 75, native = f.events.map(e => JSON.stringify(e)).join(',\n');
  const bytes = Buffer.byteLength(head) + blocks * Buffer.byteLength(block) + Buffer.byteLength(native) + Buffer.byteLength(tail);
  const direct = createInputLatencyCollector(f.options), collector = createInputLatencyCollector(f.options);
  const adapter = createNativeTraceProjectionAdapter({ collector,
    projection: { schema: 'noted-trace-projection-v1', complete: true, dataLoss: false, nativeDataLoss: false, projectedBytes: bytes } });
  const feed = s => { direct.write(s); assert.equal(adapter.write(s).continue, true); };
  feed(head); for (let i = 0; i < blocks; i++) feed(block); feed(native); feed(tail);
  const before = direct.finish(nativeFinishOptions(f)), after = adapter.finish(nativeFinishOptions(f));
  assert.ok(before.stream.omittedBytes > 0); assert.notEqual(before.trigger.status, 'matched');
  assert.equal(after.result.trigger.status, 'matched'); assert.equal(after.audit.completeExport, true);
  assert.equal(after.audit.dataLoss, false); assert.equal(after.audit.sourceBytes, bytes);
  assert.ok(after.audit.sourceBytes > 4194304); assert.ok(after.audit.nativeBytes < 65536);
  assert.equal(after.result.limits.inputBytes, 4194304); assert.ok(after.audit.ignoredEngineEvents > 40000);
  const reference = createInputLatencyCollector(f.options); reference.write(encode(f.events));
  assert.deepEqual(after.result.flows, reference.finish(nativeFinishOptions(f)).flows);
  assert.equal(adapter.finish(), after);
});

test('native adapter never clears old/native loss, missing EOF, byte mismatch or malformed framing', () => {
  const f = require('./perf-input-latency.test.cjs'), data = encode(f.events);
  for (const options of [{ proof: { dataLoss: true } }, { proof: { nativeDataLoss: true } },
    { proof: { complete: false } }, { proof: { projectedBytes: Buffer.byteLength(data) + 1 } }, { eof: false }]) {
    const { adapter, projection } = adapterFor(data, options);
    adapter.write(data); projection.dataLoss = false; projection.nativeDataLoss = false; projection.complete = true;
    const { result, audit } = adapter.finish({ ...nativeFinishOptions(f), completeExport: options.eof !== false });
    assert.equal(audit.dataLoss, true); assert.notEqual(result.trigger.status, 'matched');
  }
  for (const broken of [encode(f.events, ''), '{"traceEvents":[\n{bad}\n]}',
    encode([event('InputLatency::SECRET_UNKNOWN')]), '{"metadata":{\n' + JSON.stringify(f.events[0]) + '\n},"traceEvents":[]}']) {
    const { adapter } = adapterFor(broken); adapter.write(broken);
    const { audit } = adapter.finish({ completeExport: true, dataLoss: false });
    assert.equal(audit.completeExport, false); assert.equal(audit.dataLoss, true);
  }
});

test('native adapter bounds native output, ingress, chunks and event scanning; ignores trailing metadata', () => {
  const f = require('./perf-input-latency.test.cjs'), data = encode(f.events);
  const { adapter } = adapterFor(data, { limits: { maxOutputBytes: 512 } });
  assert.equal(adapter.write(data).continue, false);
  const { audit, result } = adapter.finish(nativeFinishOptions(f));
  assert.equal(audit.outputLimit, true); assert.equal(audit.completeExport, false);
  assert.ok(audit.nativeBytes <= 512); assert.notEqual(result.trigger.status, 'matched');
  const limited = adapterFor(data, { limits: { maxEvents: 2 } }).adapter;
  assert.equal(limited.write(data).continue, false); assert.equal(limited.finish({ completeExport: true }).audit.eventLimit, true);
  const ingress = adapterFor(data, { limits: { maxInputBytes: 256 } }).adapter;
  assert.throws(() => ingress.write(data), /input-limit/);
  assert.equal(ingress.finish({ completeExport: true }).audit.dataLoss, true);
  const chunk = adapterFor(data).adapter;
  assert.throws(() => chunk.write(Buffer.alloc(262145)), /chunk-limit/);
  const meta = encode(f.events, '],"metadata":{"name":"InputLatency::SECRET_UNKNOWN","args":{"SECRET_BODY":true}}');
  const clean = adapterFor(meta).adapter; clean.write(meta);
  const read = clean.finish(nativeFinishOptions(f));
  assert.equal(read.result.trigger.status, 'matched'); assert.equal(read.audit.rejectedLines, 0);
  assert.equal(JSON.stringify(read).includes('SECRET'), false);
});

test('Chromium120 scroll metadata and first-update type survive without masking unknown fields', async t => {
  const { w, file } = await setup(t);
  const latency = event('EventLatency', { ph: 'b', id2: { local: '9' }, args: { event_latency: {
    event_type: 'FIRST_GESTURE_SCROLL_UPDATE', event_latency_id: '42', has_high_latency: true, is_janky_scrolled_frame: false,
  } } });
  const input = event('InputLatency::GestureScrollUpdate', { ph: 'e', id: '42', args: { chrome_latency_info: {
    trace_id: '42', gesture_scroll_id: '9007199254740993', touch_id: 18, is_coalesced: false,
    component_info: ['COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL', 'COMPONENT_INPUT_EVENT_LATENCY_FIRST_SCROLL_UPDATE_ORIGINAL',
      'COMPONENT_INPUT_EVENT_LATENCY_SCROLL_UPDATE_ORIGINAL', 'COMPONENT_INPUT_EVENT_LATENCY_UI'].map(component_type => ({ component_type, time_us: 101 })),
  } } });
  await w.write(encode([latency, input]));
  const r = await w.finish({ completeExport: true, dataLoss: false });
  assert.equal(r.inputLossRecords, 0); assert.equal(r.dataLoss, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).traceEvents, [latency, input]);
  await t.test('wrong primitive types and future metadata still refuse without leaking', async t => {
    const { w, file } = await setup(t);
    await w.write(encode([
      event('EventLatency', { args: { event_latency: { event_type: 'MOUSE_WHEEL', has_high_latency: 'SECRET' } } }),
      event('InputLatency::GestureScrollBegin', { args: { chrome_latency_info: { trace_id: 42, gesture_scroll_id: 'SECRET' } } }),
      event('EventLatency', { args: { event_latency: { event_type: 'FUTURE_SECRET', event_latency_id: 42 } } }),
    ]));
    const r = await w.finish({ completeExport: true, dataLoss: false });
    assert.equal(r.inputLossRecords, 3); assert.equal(r.dataLoss, true);
    assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false);
  });
});
