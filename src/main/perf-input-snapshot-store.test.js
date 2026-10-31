'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createInputSnapshotWriter } = require('./perf-input-snapshot-store');
const { createInputLatencyCollector } = require('./perf-input-latency');
const fixture = require('./perf-input-latency.test.cjs');
const wheelFixture = require('./perf-input-latency.wheel.fixture.json');
const mainPid = fixture.options.mainPid, rendererPid = fixture.options.rendererPid;
const BASE = 1793264279500.6;
function evidence() {
  const c = createInputLatencyCollector(fixture.options);
  c.write('{"traceEvents":[\n' + fixture.events.map(e => JSON.stringify(e)).join(',\n') + '\n]}');
  return c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers });
}
function record(start = BASE) {
  return { version: 1, kind: 'input-native-preroll', cpuProfiler: false, recordingId: 'input-ring-' + mainPid + '-1',
    scope: { mainPid, rendererPid, window: 1, documentGeneration: 2, frameProcessId: 3, frameRoutingId: 4,
      documentTimeOriginMs: fixture.options.documentTimeOriginMs, attachmentId: 'attachment-123' },
    actions: [{ id: 'ui-' + Math.floor(BASE - 1000).toString(36) + '-1', event: 'wheel', startAbs: BASE - 200,
      durationMs: 200, inputDelayMs: 180 }],
    omittedTriggers: 0, captureStartedAbs: start, captureFinishedAbs: start + 10, recordingStartedAbs: BASE - 1000,
    exportBytes: 9000, exportComplete: true, dataLoss: false, cleanupConfirmed: true,
    errors: [], clockMarkers: [{ label: 'snapshot-before', syncId: 'SENSITIVE-RAW-ID',
      before: { epochMs: BASE - 1 }, after: { epochMs: BASE } }], evidence: evidence() };
}
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-input-writer-unit-')), logs = [];
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, logs, writer: createInputSnapshotWriter({ directory, mainPid, log: s => logs.push(s), ...options }),
    file: (start = BASE) => path.join(directory, 'incident-' + Math.round(start) + '-' + mainPid + '.input.json') };
}
const ioWith = fields => ({ mkdir: fs.promises.mkdir, lstat: fs.promises.lstat, open: fs.promises.open, ...fields });
const codeOf = logs => JSON.parse(logs.at(-1).slice('[Perf:InputSnapshot] '.length)).code;

function wheelRecord() {
  const c = createInputLatencyCollector(wheelFixture.options);
  c.write('{"traceEvents":[\n' + wheelFixture.events.map(e => JSON.stringify(e)).join(',\n') + '\n]}');
  const e = c.finish({ completeExport: true, dataLoss: false, clockMarkers: wheelFixture.clockMarkers,
    rendererClockRelation: wheelFixture.rendererClockRelation, trigger: wheelFixture.trigger });
  const originalAbs = wheelFixture.options.documentTimeOriginMs + wheelFixture.trigger.nativeOriginal.timeStampMs;
  const r = record(Math.ceil(originalAbs + 1000));
  r.scope.documentTimeOriginMs = wheelFixture.options.documentTimeOriginMs;
  r.recordingStartedAbs = originalAbs - 1000;
  r.actions = [{ id: 'ui-' + Math.floor(originalAbs).toString(36) + '-1', event: 'wheel',
    startAbs: originalAbs, durationMs: 234.6, inputDelayMs: 234.6,
    nativeOriginal: { ...wheelFixture.trigger.nativeOriginal } }];
  r.evidence = e;
  return r;
}
const wheelMainScope = r => r.evidence.flows.find(f => f.traceId === '4').linkedNativeIntervals
  .find(s => s.name === 'STEP_HANDLE_INPUT_EVENT_MAIN');

test('actual wheel collector → writer → readback keeps scope relation/timings, full CPU and both candidates', async t => {
  const h = setup(t), r = wheelRecord(), expected = structuredClone(r.evidence);
  const scope = wheelMainScope(r);
  assert.equal(scope.eventRootRelation, 'metrics-end-inside-main-handler');
  scope.unlistedComment = 'PRIVATE-CONTENT';
  Object.defineProperty(scope, 'unknownNote', { get() { assert.fail('unknown field must not be read'); } });
  assert.equal(await h.writer.publish(r), true);
  const file = h.file(r.captureStartedAbs), raw = await fs.promises.readFile(file, 'utf8');
  const saved = JSON.parse(raw), after = wheelMainScope(saved);
  assert.deepEqual(saved.evidence, expected);
  assert.equal(after.eventRootRelation, 'metrics-end-inside-main-handler');
  assert.equal(after.eventRootOverlapMs, 0.012); assert.equal(after.scopeTailAfterEventMs, 0.012);
  assert.equal(after.threadMs, 0.024, 'entire handler CPU is not split by wall overlap/tail');
  assert.equal(saved.evidence.flows.find(f => f.traceId === '4').stages
    .find(s => s.name === 'RendererMainProcessing').threadMs, null);
  assert.equal(saved.evidence.trigger.status, 'ambiguous');
  assert.deepEqual(saved.evidence.trigger.candidates, ['3', '4']);
  assert.equal(saved.evidence.trigger.candidateCount, 2);
  assert.doesNotMatch(raw, /PRIVATE-CONTENT|unlistedComment|unknownNote/);
  assert(Buffer.byteLength(raw) <= 262144);
  assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
  const line = h.logs.find(s => s.startsWith('[Perf:InputPath] ')); assert(line);
  const summary = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(summary.nativeBinding, 'ambiguous'); assert.equal(summary.largestMeasuredStage, null);
  assert.deepEqual(summary.nativeCandidates.map(c => c.traceId), ['3', '4']);
  for (const candidate of summary.nativeCandidates) {
    const interval = candidate.largestObservedInterval;
    assert.equal(interval.stage, 'GenerationToBrowserMain');
    assert.match(interval.meaning, /до регистрации.*RenderWidgetHost/);
    assert.match(interval.meaning, /CDP.*может включать ожидание интерфейса/);
    assert.match(interval.meaning, /не замер CPU Main/);
  }
});

test('optional scope metadata rejects invalid enums/numbers/accessors before filesystem and preserves privacy', async t => {
  let calls = 0, accessorReads = 0, coercions = 0;
  const io = Object.fromEntries(['mkdir','lstat','open'].map(k => [k, async () => { calls++; assert.fail('unexpected IO'); }]));
  const h = setup(t, { windowId: 1, io });
  const cases = [
    ['unknown relation', s => { s.eventRootRelation = 'PRIVATE-CONTENT'; }],
    ['wrong enum type', s => { s.eventRootRelation = true; }],
    ['null relation', s => { s.eventRootRelation = null; }],
    ['oversized relation', s => { s.eventRootRelation = 'PRIVATE-CONTENT'.repeat(100); }],
    ...['eventRootOverlapMs','scopeTailAfterEventMs'].flatMap(key => [NaN,Infinity,-Infinity,-0.01,
      Number.MAX_SAFE_INTEGER + 1,'PRIVATE-CONTENT',null].map(value => [key + ':' + String(value), s => { s[key] = value; }])),
    ...['eventRootRelation','eventRootOverlapMs','scopeTailAfterEventMs'].map(key => [key + ':accessor', s => {
      Object.defineProperty(s, key, { get() { accessorReads++; return 0; } });
    }]),
    ...['eventRootOverlapMs','scopeTailAfterEventMs'].map(key => [key + ':object', s => {
      s[key] = { valueOf() { coercions++; return 0; }, toJSON() { coercions++; return 0; } };
    }]),
  ];
  for (const [label, change] of cases) {
    const r = wheelRecord(); change(wheelMainScope(r));
    assert.equal(await h.writer.publish(r), false, label);
    assert.equal(codeOf(h.logs), 'INPUT_SNAPSHOT_INVALID_RECORD', label);
  }
  const foreign = wheelRecord(); wheelMainScope(foreign).pid = 999999;
  assert.equal(await h.writer.publish(foreign), false);
  assert.equal(codeOf(h.logs), 'INPUT_SNAPSHOT_WRONG_OWNER');
  const oversized = wheelRecord(), scope = wheelMainScope(oversized);
  oversized.evidence.flows.find(f => f.traceId === '4').linkedNativeIntervals = Array(4096).fill(scope);
  assert.equal(await h.writer.publish(oversized), false);
  assert.equal(codeOf(h.logs), 'INPUT_SNAPSHOT_OVERSIZE');
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
  assert.equal(accessorReads, 0); assert.equal(coercions, 0);
  assert.doesNotMatch(h.logs.join('\n'), /PRIVATE-CONTENT|accessor|unexpected IO/);
});

test('actual collector output readback is exact; bounded envelope drops text, keys, raw sync/attachment IDs', async t => {
  const h = setup(t), r = record(), expected = structuredClone(r.evidence);
  r.protocolError = 'SECRET'; r.scope.text = 'SECRET'; r.actions[0].key = 'SECRET';
  r.evidence.text = 'SECRET'; r.evidence.flows[0].nativeEvidence[0].args.secret = 'SECRET';
  Object.defineProperty(r, 'toJSON', { value: () => { throw Error('must not clone original'); } });
  Object.defineProperty(r, 'unused', { get() { throw Error('unknown getter must not run'); } });
  assert.equal(await h.writer.publish(r), true);
  const text = await fs.promises.readFile(h.file(), 'utf8'), actual = JSON.parse(text);
  assert.deepEqual(actual.evidence, expected);
  assert.equal(actual.scope.attachmentIdSha256, createHash('sha256').update('attachment-123').digest('hex'));
  assert.equal(actual.clockMarkers[0].syncId, undefined);
  assert.equal(actual.actions[0].key, undefined);
  assert.equal(actual.recordingId, r.recordingId);
  assert.doesNotMatch(text, /SECRET|SENSITIVE-RAW-ID|attachment-123/);
  assert.ok(Buffer.byteLength(text) <= 262144);
  assert.equal((await fs.promises.stat(h.file())).mode & 0o777, 0o600);
});

test('zero native stage and unlinked roots survive actual file projection for later inspection', async t => {
  const h = setup(t), r = record(), events = structuredClone(fixture.events);
  const instant = events.find(e => e.name === 'RendererCompositorProcessing' && e.ph === 'b');
  const endIndex = events.findIndex(e => e.name === instant.name && e.ph === 'e');
  instant.ph = 'n'; events.splice(endIndex, 1);
  events.find(e => e.name === 'RendererCompositorToMain' && e.ph === 'b').ts = instant.ts;
  events.push({ name: 'InputLatency::MouseMove', ph: 'b', pid: mainPid, tid: 1, ts: instant.ts,
    id: '0x990', args: { text: 'PRIVATE-CONTENT' } });
  events.push({ name: 'EventLatency', ph: 'n', pid: rendererPid, tid: 2, ts: instant.ts,
    id2: { local: '0x991' }, args: { event_latency: { event_type: 'MOUSE_MOVED_EVENT' }, x: 1234 } });
  const c = createInputLatencyCollector(fixture.options);
  c.write('{"traceEvents":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}');
  r.evidence = c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers });
  assert.equal(await h.writer.publish(r), true);
  const raw = await fs.promises.readFile(h.file(), 'utf8'), saved = JSON.parse(raw);
  assert.deepEqual(saved.evidence, r.evidence);
  assert(saved.evidence.flows.some(f => f.nativeEvidence.some(e => e.name === instant.name && e.ph === 'n')));
  assert(saved.evidence.orphanEvidence.some(e => e.name === 'InputLatency::MouseMove'));
  assert(saved.evidence.orphanEvidence.some(e => e.name === 'EventLatency' && e.ph === 'n'
    && !Object.hasOwn(e.args.event_latency, 'event_latency_id')));
  assert.doesNotMatch(raw, /PRIVATE-CONTENT|"x":1234/);
});

test('true waits for successful close; overlapping publication for same window is refused', async t => {
  let releaseClose, closeEntered;
  const gate = new Promise(r => { releaseClose = r; }), entered = new Promise(r => { closeEntered = r; });
  const h = setup(t, { io: ioWith({ open: async (...args) => {
    const fd = await fs.promises.open(...args);
    return { stat: () => fd.stat(), write: (...a) => fd.write(...a), close: async () => { closeEntered(); await gate; await fd.close(); } };
  } }) });
  let settled = false; const first = h.writer.publish(record()).then(v => { settled = true; return v; });
  await entered; assert.equal(settled, false);
  assert.equal(await h.writer.publish(record(BASE + 1)), false); assert.equal(codeOf(h.logs), 'INPUT_SNAPSHOT_BUSY');
  releaseClose(); assert.equal(await first, true);
  assert.equal(fs.existsSync(h.file(BASE + 1)), false);
});

test('existing file and existing symlink are never overwritten, including a new writer instance', async t => {
  const h = setup(t); assert.equal(await h.writer.publish(record()), true);
  const saved = await fs.promises.readFile(h.file());
  assert.equal(await h.writer.publish(record()), false);
  assert.equal(await createInputSnapshotWriter({ directory: h.directory, mainPid }).publish(record()), false);
  assert.deepEqual(await fs.promises.readFile(h.file()), saved);
  const original = path.join(h.directory, 'original'); await fs.promises.writeFile(original, 'untouched');
  await fs.promises.symlink(original, h.file(BASE + 1));
  assert.equal(await h.writer.publish(record(BASE + 1)), false);
  assert.equal(await fs.promises.readFile(original, 'utf8'), 'untouched');
  assert.equal((await fs.promises.lstat(h.file(BASE + 1))).isSymbolicLink(), true);
});

test('invalid owner/name/shape and oversize are rejected before any filesystem call', async t => {
  let calls = 0;
  const io = Object.fromEntries(['mkdir','lstat','open'].map(k => [k, async () => { calls++; throw Error('unexpected IO'); }]));
  const h = setup(t, { windowId: 1, io });
  const cases = [
    r => { r.scope.mainPid++; },
    r => { r.scope.window = 2; },
    r => { r.evidence.scope.rendererPid++; },
    r => { r.evidence.flows[0].nativeEvidence[0].pid = 999999; },
    r => { r.file = '../arbitrary.json'; },
    r => { r.captureStartedAbs = NaN; },
    r => { r.cpuProfiler = true; },
    r => { r.errors = ['arbitrary protocol message SECRET']; },
    r => { r.evidence.flows[0].stages[0].name = 'raw-js-stack-SECRET'; },
    r => { Object.defineProperty(r.scope, 'window', { get() { throw Error('getter'); } }); },
    r => { r.actions = new Array(17); },
    r => { r.evidence.flows[0].nativeEvidence = new Array(4097); },
    r => { r.evidence.flows = Array.from({ length: 64 }, () => r.evidence.flows[0]); }
  ];
  for (const change of cases) { const r = record(); change(r); assert.equal(await h.writer.publish(r), false); }
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
  assert.ok(h.logs.some(s => s.includes('INPUT_SNAPSHOT_OVERSIZE')));
  assert.doesNotMatch(h.logs.join('\n'), /SECRET|getter|arbitrary/);
});

test('exact total 256KiB envelope limit includes evidence; oversize cannot allocate an output file', async t => {
  const h = setup(t), r = record();
  const flow = r.evidence.flows[0];
  // Finite valid rows, enough to cross the total envelope cap before writing.
  r.evidence.flows = Array.from({ length: 64 }, () => flow);
  assert.equal(await h.writer.publish(r), false);
  assert.equal(codeOf(h.logs), 'INPUT_SNAPSHOT_OVERSIZE');
  assert.equal(fs.existsSync(h.file()), false);
});

test('structural rejection reasons survive disk projection without granting a foreign header flow authority', async t => {
  const h = setup(t), r = record();
  r.evidence.rejections = { total: 2, retained: 2, omitted: 0, outputOmitted: 0, projectionBytes: 150,
    counts: { 'invalid-pair-phase': 1, 'foreign-pid': 1 }, events: [
      { reason: 'invalid-pair-phase', kind: 'event', name: 'EventLatency', ph: 'n', pid: rendererPid, tid: 1, ts: 12, traceId: '4' },
      { reason: 'foreign-pid', kind: 'thread', name: 'thread_name', ph: 'M', pid: 777777, tid: 2, ts: 1 },
    ], qualification: 'diagnostic-only; conservative input qualification unchanged' };
  assert.equal(await h.writer.publish(r), true);
  const saved = JSON.parse(fs.readFileSync(h.file(), 'utf8'));
  assert.deepEqual(saved.evidence.rejections, r.evidence.rejections);
  assert.equal(saved.scope.rendererPid, rendererPid); assert.equal(saved.evidence.scope.rendererPid, rendererPid);
});

test('short and throwing partial writes retain the original partial file and never retry', async t => {
  for (const mode of ['short','throw']) {
    let writes = 0, closes = 0;
    const h = setup(t, { io: ioWith({ open: async (...args) => {
      const fd = await fs.promises.open(...args);
      return { stat: () => fd.stat(), write: async b => {
        writes++; const written = await fd.write(b, 0, 13, 0);
        if (mode === 'throw') throw Object.assign(Error('SECRET protocol details'), { code: 'INPUT_SNAPSHOT_SECRET' });
        return written;
      }, close: async () => { closes++; await fd.close(); } };
    } }) });
    assert.equal(await h.writer.publish(record()), false);
    assert.equal(writes, 1); assert.equal(closes, 1);
    const original = await fs.promises.readFile(h.file()); assert.equal(original.length, 13);
    assert.equal(await h.writer.publish(record()), false); assert.equal(writes, 1);
    assert.deepEqual(await fs.promises.readFile(h.file()), original);
    assert.doesNotMatch(h.logs.join('\n'), /SECRET|protocol details/);
  }
});

test('close failure does not report true or reopen/overwrite the complete original bytes', async t => {
  let closeCalls = 0;
  const h = setup(t, { io: ioWith({ open: async (...args) => {
    const fd = await fs.promises.open(...args);
    return { stat: () => fd.stat(), write: (...a) => fd.write(...a), close: async () => {
      closeCalls++; await fd.close(); throw Error('lost close confirmation SECRET');
    } };
  } }) });
  assert.equal(await h.writer.publish(record()), false); assert.equal(closeCalls, 1);
  assert.ok((await fs.promises.stat(h.file())).size > 0);
  assert.equal(await h.writer.publish(record()), false); assert.equal(closeCalls, 1);
  assert.doesNotMatch(h.logs.join('\n'), /SECRET/);
});

test('directory symlink refused, fixed failure-only envelope allowed, and snapshot does not observe later mutation', async t => {
  const h = setup(t), real = path.join(h.directory, 'real'), link = path.join(h.directory, 'link');
  await fs.promises.mkdir(real); await fs.promises.symlink(real, link);
  assert.equal(await createInputSnapshotWriter({ directory: link, mainPid }).publish(record()), false);
  assert.deepEqual(await fs.promises.readdir(real), []);
  const failed = record(); delete failed.evidence; failed.errors = ['input-trace-read-failed'];
  const work = h.writer.publish(failed); failed.scope.mainPid = 999999; failed.errors[0] = 'SECRET';
  assert.equal(await work, true);
  const saved = JSON.parse(await fs.promises.readFile(h.file(), 'utf8'));
  assert.equal(saved.scope.mainPid, mainPid); assert.deepEqual(saved.errors, ['input-trace-read-failed']);
});

test('a complete input snapshot at exactly256KiB succeeds; one additional byte fails before open', async t => {
  const h = setup(t), base = record(); assert.equal(await h.writer.publish(base), true);
  const baseBytes = (await fs.promises.stat(h.file())).size;
  const row = { name: 'WebFrameWidgetImpl::HandleInputEvent', ph: 'X', pid: rendererPid, tid: 1, ts: 0 };
  const cost = Buffer.byteLength(JSON.stringify(row)) + 1, total = 262144;
  const n = Math.floor((total - baseBytes + 1) / cost), remainder = total - (baseBytes + n * cost - 1);
  let tuned;
  for (let digits = 1; digits <= 16 && !tuned; digits++) for (let idLength = 0; idLength <= 20 && !tuned; idLength++) for (let durationDigits = 0; durationDigits <= 16 && !tuned; durationDigits++) for (let threadDigits = 0; threadDigits <= 16; threadDigits++) {
    const candidate = { ...row, ts: digits === 1 ? 0 : 10 ** (digits - 1),
      ...(durationDigits ? { dur: 10 ** (durationDigits - 1) } : {}), ...(threadDigits ? { tdur: 10 ** (threadDigits - 1) } : {}), ...(idLength ? { id: '1'.repeat(idLength) } : {}) };
    if (Buffer.byteLength(JSON.stringify(candidate)) - (cost - 1) === remainder) { tuned = candidate; break; }
  }
  assert(tuned); assert(n > 0 && n <= 4096);
  const exact = record(BASE + 1); exact.evidence.orphanEvidence = Array.from({ length: n }, () => row); exact.evidence.orphanEvidence[n - 1] = tuned;
  assert.equal(await h.writer.publish(exact), true);
  assert.equal((await fs.promises.stat(h.file(BASE + 1))).size, total);
  const over = { ...exact, captureStartedAbs: BASE + 2, captureFinishedAbs: BASE + 12, omittedTriggers: 10 };
  assert.equal(await h.writer.publish(over), false);
  assert.equal(codeOf(h.logs), 'INPUT_SNAPSHOT_OVERSIZE');
  assert.equal(fs.existsSync(h.file(BASE + 2)), false);
});

test('current core partial/null evidence and multiple-action coverage survive the fixed envelope', async t => {
  const h = setup(t), r = record();
  r.status = 'partial'; r.evidence = null; r.recordingStartedAbs = null;
  r.companionCaptureId = 'incident-' + Math.round(BASE) + '-' + mainPid;
  r.errors = ['input-summary-cap-or-invalid','input-renderer-clock-unavailable','input-command-unconfirmed'];
  r.actions[0].coverage = 'snapshot-gap'; r.actions[0].rendererPid = rendererPid;
  r.actions[0].documentTimeOriginMs = fixture.options.documentTimeOriginMs;
  r.actions[0].nativeOriginal = { type: 'wheel', timeStampMs: 100, pointerType: 'mouse', uncertaintyMs: 0.1, key: 'SECRET' };
  r.multipleActions = [{ id: r.actions[0].id, binding: 'unknown-snapshot-gap', exclusiveCpuClaim: false }];
  assert.equal(await h.writer.publish(r), true);
  const saved = JSON.parse(await fs.promises.readFile(h.file(), 'utf8'));
  assert.equal(saved.evidence, null); assert.equal(saved.recordingStartedAbs, null);
  assert.deepEqual(saved.multipleActions, r.multipleActions); assert.deepEqual(saved.errors, r.errors);
  assert.equal(saved.actions[0].coverage, 'snapshot-gap');
  assert.equal(saved.actions[0].nativeOriginal.key, undefined);
});

test('throwing or asynchronously rejected logging cannot change a completed write receipt', async t => {
  for (const log of [() => { throw Error('sink unavailable'); }, () => Promise.reject(Error('sink unavailable'))]) {
    const h = setup(t, { log });
    assert.equal(await h.writer.publish(record()), true);
    assert.equal(JSON.parse(await fs.promises.readFile(h.file(), 'utf8')).kind, 'input-native-preroll');
  }
});
