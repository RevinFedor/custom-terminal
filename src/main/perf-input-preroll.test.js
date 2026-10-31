'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createInputPreroll, LIMITS } = require('./perf-input-preroll');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
// Finite microtask drain, not state polling or a wall-time readiness wait.
const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function fixture(options = {}) {
  let time = performance.timeOrigin + 10000, timerId = 0, queue = Promise.resolve(), stream = 0;
  const timers = new Map(), calls = [], listeners = new Set(), publications = [], logs = [], collectors = [];
  const scope = { mainPid: 11, rendererPid: 22, window: 3, documentGeneration: 4,
    frameProcessId: 5, frameRoutingId: 6, attachmentId: 'fixture-owned', documentTimeOriginMs: performance.timeOrigin + 1000 };
  const rendererOrigin = scope.documentTimeOriginMs;
  const f = { scope, rendererOrigin, calls, timers, publications, logs, collectors, listeners, clockEvents: [], current: true, cleanup: true,
    handlers: {}, time: () => time, setTime: value => { time = value; },
    schedule(fn, ms) { const id = ++timerId; timers.set(id, { at: time + ms, fn }); return id; },
    cancel(id) { timers.delete(id); },
    emit(method, params, owner = scope) { for (const listener of [...listeners]) listener(method, params, owner); },
    async tick(ms) {
      const end = time + ms;
      // Only finite fixture timers due within this explicit interval are run.
      for (let count = 0; count < 1000; count++) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await drain();
        if (count === 999) assert.fail('unexpected timer loop');
      }
      time = end; await drain();
    },
    count(method) { return calls.filter(c => c.method === method).length; },
  };
  f.transport = {
    scope: () => scope,
    isCurrent: () => f.current,
    canCleanup: () => f.cleanup,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readRendererClock(owner) {
      calls.push({ method: 'readRendererClock', owner });
      if (f.handlers.readRendererClock) return f.handlers.readRendererClock(owner);
      return { rendererTimeOriginMs: rendererOrigin, rendererNowMs: time + 37 - rendererOrigin,
        rendererEpochMs: time + 37, parentBeforeAbs: time, parentAfterAbs: time };
    },
    runExclusive(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; },
    sendRaw(method, params, owner, flags) {
      calls.push({ method, params, owner, flags });
      if (f.handlers[method]) return f.handlers[method](params, owner, flags);
      if (method === 'Tracing.recordClockSyncMarker') { f.clockEvents.push({ name: 'clock_sync', ph: 'c', pid: owner.mainPid, tid: 1,
        ts: Math.round((time - performance.timeOrigin) * 1000), args: { sync_id: params.syncId } }); return {}; }
      if (method === 'Tracing.end') { f.emit('Tracing.tracingComplete', { stream: 'stream-' + (++stream), dataLossOccurred: false }, owner); return {}; }
      if (method === 'IO.read') return { data: '{"traceEvents":[\n' + f.clockEvents.map(e => JSON.stringify(e)).join(',\n') + '\n]}', eof: true };
      return {};
    },
  };
  f.collect = config => {
    const row = { config, chunks: [], finish: null }; collectors.push(row);
    return { write(chunk) { row.chunks.push(chunk); }, finish(args) {
      row.finish = args; return { schema: 'fixture-safe-evidence', status: args.completeExport && args.dataLoss === false ? 'complete' : 'partial',
        flows: [{ traceId: '4', nativeEvidence: [{ name: 'EventLatency', ph: 'b', pid: 22, tid: 1, ts: 100 }] }],
        trigger: { status: args.trigger ? 'unknown' : 'not-requested' } };
    } };
  };
  f.core = createInputPreroll({ transport: f.transport, createCollector: config => f.collect(config),
    publish: value => { publications.push(value); return f.publish ? f.publish(value) : true; },
    now: () => time, schedule: f.schedule, cancel: f.cancel, log: value => logs.push(value),
    limits: { ...LIMITS, commandMs: 30, exportMs: 100, postMs: 5 }, ...options });
  f.action = (id = 'action-1', patch = {}) => ({ id, event: 'pointerdown', kind: 'input-delay',
    startAbs: time + 37, durationMs: 160, inputDelayMs: 155, rendererPid: 22,
    documentTimeOriginMs: rendererOrigin,
    nativeOriginal: { type: 'pointerdown', pointerType: 'mouse', timeStampMs: time + 37 - rendererOrigin }, ...patch });
  return f;
}

test('explicit pre-effect existing trace refusal parks starts until real pause/resume, never ENDs foreign trace', async () => {
  const f = fixture(); f.handlers['Tracing.start'] = () => { throw new Error('Tracing has already been started'); };
  assert.equal(await f.core.start(), false);
  for (let i = 0; i < 5; i++) assert.equal(await f.core.start(), false);
  assert.equal(await f.core.resume(), false); assert.equal(f.count('Tracing.start'), 1);
  assert.equal(f.count('Tracing.end'), 0); assert.equal(await f.core.pause(), true);
  delete f.handlers['Tracing.start']; assert.equal(await f.core.resume(), true);
  assert.equal(f.count('Tracing.start'), 2); assert.equal(await f.core.dispose(), true);
});

test('START timeout then late ACK retires original unknown once, without a new START', async () => {
  const f = fixture(), start = deferred(); f.handlers['Tracing.start'] = () => start.promise;
  const pending = f.core.start(); await drain(); await f.tick(31); assert.equal(await pending, false);
  assert.equal(f.core.state().phase, 'unknown');
  start.resolve({}); await drain();
  assert.equal(f.count('Tracing.start'), 1); assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), 1);
  assert.equal(f.core.state().recordingId, null); assert.equal(await f.core.dispose(), true);
});

test('concurrent cleanup shares END/CLOSE and both pauses receive the same confirmed outcome', async () => {
  const f = fixture(), close = deferred(); assert.equal(await f.core.start(), true);
  f.handlers['IO.close'] = () => close.promise;
  const a = f.core.pause(), b = f.core.pause(); await drain();
  assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), 1);
  close.resolve({}); await drain(); assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test('IO.close timeout late ACK retires original unknown without replay or repeated publication', async () => {
  const f = fixture(), close = deferred(); assert.equal(await f.core.start(), true);
  f.handlers['IO.close'] = () => close.promise;
  const p = f.core.pause(); await drain(); await f.tick(31); assert.equal(await p, false);
  assert.equal(f.timers.size, 0, 'UNKNOWN waits for new proof, not another internal deadline/retry cycle');
  close.resolve({}); await drain();
  assert.equal(f.count('IO.close'), 1); assert.equal(f.core.state().recordingId, null);
  assert.equal(await f.core.pause(), true); assert.equal(f.publications.length, 0);
});

test('preserve pause exports already owned ring, heartbeat companion needs no actions and ready means cleanup', async () => {
  const f = fixture(); assert.equal(await f.core.start(), true);
  const ready = await f.core.pause('heavy-profile', { preserve: true, companionCaptureId: 'heavy-1', actions: [] });
  assert.equal(ready, true); assert.equal(f.publications.length, 1);
  const record = f.publications[0]; assert.equal(record.companionCaptureId, 'heavy-1');
  assert.deepEqual(record.actions, []); assert.equal(record.exportComplete, true);
  assert.equal(record.evidence.flows[0].traceId, '4'); assert.equal(f.count('Tracing.start'), 1);
  assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), 1);
  assert.equal(f.calls.some(c => /Profiler|attach|detach/i.test(c.method)), false);
  assert.equal(f.core.state().paused, true);
});

test('snapshot passes full clock snapshots, renderer relation and nativeOriginal to unchanged collector API', async () => {
  const f = fixture(); assert.equal(await f.core.start(), true);
  const action = f.action(); f.core.observe(action); await f.tick(5);
  assert.equal(f.publications.length, 1);
  const { config, finish } = f.collectors[0];
  assert.equal(config.maxInputBytes, 4194304); assert.equal(config.documentTimeOriginMs, f.scope.documentTimeOriginMs);
  assert.equal(finish.clockMarkers.length, 2);
  assert.ok(finish.clockMarkers[0].before.epochMs <= action.startAbs - 37);
  assert.equal(typeof finish.clockMarkers[0].before.timeOrigin, 'number');
  assert.equal(finish.rendererClockRelation.rendererPid, 22);
  assert.equal(finish.rendererClockRelation.renderer.epochMs - finish.rendererClockRelation.mainBefore.epochMs, 37);
  assert.deepEqual(finish.trigger.nativeOriginal, action.nativeOriginal);
  assert.equal(finish.trigger.documentTimeOriginMs, f.scope.documentTimeOriginMs);
  assert.equal(await f.core.dispose(), true);
});

test('late END ACK plus exact completion retires original timeout; foreign/early completion is not authority', async () => {
  const f = fixture(), ending = deferred(); assert.equal(await f.core.start(), true);
  f.handlers['Tracing.end'] = () => ending.promise;
  const p = f.core.pause(); await drain(); await f.tick(61); assert.equal(await p, false);
  ending.resolve({}); await drain(); assert.equal(f.count('IO.close'), 0);
  f.emit('Tracing.tracingComplete', { stream: 'foreign', dataLossOccurred: false }, { ...f.scope, attachmentId: 'foreign' });
  await drain(); assert.equal(f.count('IO.close'), 0);
  f.emit('Tracing.tracingComplete', { stream: 'late-owned', dataLossOccurred: false }); await drain();
  assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), 1);
  assert.equal(f.calls.find(c => c.method === 'IO.close').params.handle, 'late-owned');
  assert.equal(f.core.state().recordingId, null);
  assert.equal(await f.core.dispose(), true);
});

test('generic START failure remains UNKNOWN without replay, unlike typed before-effect refusal', async () => {
  for (const before of [false, true]) {
    const f = fixture(); f.handlers['Tracing.start'] = () => { throw Object.assign(new Error('SECRET_REMOTE_ERROR'), { notSent: before }); };
    assert.equal(await f.core.start(), false); assert.equal(await f.core.start(), false);
    assert.equal(f.count('Tracing.start'), 1); assert.equal(f.count('Tracing.end'), 0);
    if (before) assert.equal(await f.core.pause(), true);
    else { const p = f.core.dispose(); await drain(); assert.equal(await p, false); }
    assert.ok(!JSON.stringify(f.logs).includes('SECRET_REMOTE_ERROR'));
  }
});

test('scope change unlocks external refusal but preserves exact projected owner; bad scope getters never escape', async () => {
  const f = fixture(); f.scope.privateText = 'SECRET_SCOPE';
  f.handlers['Tracing.start'] = () => { throw Object.assign(new Error(), { notSent: true }); };
  assert.equal(await f.core.start(), false); f.scope.documentGeneration++;
  delete f.handlers['Tracing.start']; assert.equal(await f.core.start(), true);
  assert.equal(f.count('Tracing.start'), 2);
  assert.equal(f.calls[0].owner.privateText, undefined);
  assert.equal(await f.core.dispose(), true);
  const broken = fixture(); broken.transport.scope = () => new Proxy({}, { get() { throw Error('SECRET_SCOPE'); } });
  assert.equal(await broken.core.start(), false); assert.equal(broken.count('Tracing.start'), 0);
  assert.equal(broken.core.observe(new Proxy({}, { get() { throw Error('SECRET_INPUT'); } })), false);
  assert.equal(await broken.core.dispose(), true);
});

test('revoked document permits only original END/CLOSE; revoked cleanup authority reports false', async () => {
  const f = fixture(); assert.equal(await f.core.start(), true);
  const before = f.calls.length; f.current = false;
  assert.equal(await f.core.pause('heavy', { preserve: true }), true);
  assert.deepEqual(f.calls.slice(before).map(c => c.method), ['Tracing.end', 'IO.close']);
  assert.ok(f.calls.slice(before).every(c => c.flags.cleanup));
  assert.equal(f.publications[0].exportComplete, false);
  assert.equal(f.publications[0].status, 'partial');
  const lost = fixture(); assert.equal(await lost.core.start(), true); lost.current = false; lost.cleanup = false;
  assert.equal(await lost.core.pause(), false); assert.equal(lost.count('Tracing.end'), 0);
  lost.cleanup = true; assert.equal(await lost.core.dispose(), true);
  assert.equal(lost.count('Tracing.end'), 1); assert.equal(lost.count('IO.close'), 1);
});

test('preserve uses the already owned ring while scope() blocks new start under parent suspension', async () => {
  const f = fixture(); assert.equal(await f.core.start(), true);
  f.transport.scope = () => { throw Error('suspended'); };
  assert.equal(await f.core.pause('heavy', { preserve: true, companionCaptureId: 'companion-2' }), true);
  assert.equal(f.publications.length, 1); assert.equal(f.count('Tracing.start'), 1);
  assert.equal(f.publications[0].cleanupConfirmed, true); assert.equal(f.core.state().recordingId, null);
});

test('close rejection and missing stream never report cleanup ready or issue duplicate mutations', async () => {
  for (const mode of ['close-reject', 'stream-missing']) {
    const f = fixture(); assert.equal(await f.core.start(), true);
    if (mode === 'close-reject') f.handlers['IO.close'] = () => Promise.reject(Error('SECRET_CLOSE'));
    else f.handlers['Tracing.end'] = () => { f.emit('Tracing.tracingComplete', { dataLossOccurred: false }); return {}; };
    assert.equal(await f.core.pause('preserve', { preserve: true }), false);
    assert.equal(await f.core.pause(), false); assert.equal(await f.core.dispose(), false);
    assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), mode === 'close-reject' ? 1 : 0);
    assert.equal(f.publications.length, 1); assert.equal(f.publications[0].status, 'partial');
    assert.equal(f.publications[0].cleanupConfirmed, false);
    assert.ok(!JSON.stringify(f.publications).includes('SECRET_CLOSE'));
  }
});

test('collector write/finish and publisher failure cannot strand a known-closed ring', async () => {
  for (const mode of ['write', 'finish', 'publish']) {
    const f = fixture();
    if (mode !== 'publish') f.collect = () => ({ write() { if (mode === 'write') throw Error('SECRET_PARSE'); },
      finish() { throw Error('SECRET_FINISH'); } });
    else f.publish = () => { throw Error('SECRET_PUBLISH'); };
    assert.equal(await f.core.start(), true);
    assert.equal(await f.core.pause('heavy', { preserve: true }), true);
    assert.equal(f.core.state().recordingId, null); assert.equal(f.count('IO.close'), 1); assert.equal(f.publications.length, 1);
    assert.equal(await f.core.dispose(), true);
    assert.ok(!JSON.stringify([f.publications, f.logs, f.core.state()]).includes('SECRET_'));
  }
});

test('lost persistence ACK is unknown then late-positive, with exactly one immutable publish', async () => {
  const f = fixture(), persisted = deferred(); f.publish = () => persisted.promise;
  assert.equal(await f.core.start(), true);
  const p = f.core.pause('heavy', { preserve: true }); await drain();
  const record = f.publications[0], before = JSON.stringify(record);
  await f.tick(31); assert.equal(await p, true, 'trace is closed independently of persistence ACK');
  assert.equal(f.core.state().publication.persisted, null);
  persisted.resolve(true); await drain(); assert.equal(f.core.state().publication.persisted, true);
  assert.equal(JSON.stringify(record), before); assert.equal(f.publications.length, 1);
  assert.equal(await f.core.pause('again', { preserve: true }), true); assert.equal(f.publications.length, 1);
});

test('new input during export is bounded separate evidence, duplicate IDs coalesce and pending never orphan', async () => {
  const f = fixture(), read = deferred(); assert.equal(await f.core.start(), true);
  f.handlers['IO.read'] = () => read.promise;
  assert.equal(f.core.observe(f.action()), true); await f.tick(5);
  assert.equal(f.core.observe(f.action()), true); // same still-active action
  assert.equal(f.core.observe(f.action('action-2')), true);
  const p = f.core.pause(); read.resolve({ data: '{"traceEvents":[]}', eof: true }); await drain();
  assert.equal(await p, true); assert.equal(f.publications.length, 1);
  assert.deepEqual(f.publications[0].actions.map(a => a.id), ['action-1', 'action-2']);
  assert.equal(f.publications[0].multipleActions[1].binding, 'unknown-snapshot-gap');
  assert.equal(f.publications[0].multipleActions[1].exclusiveCpuClaim, false);
  assert.equal(f.core.state().pendingTriggers, 0);
  assert.equal(await f.core.resume(), true); assert.equal(f.core.observe(f.action()), false, 'already captured ID is not a new capture');
  assert.equal(await f.core.dispose(), true);
});

test('input arriving after frozen publication is explicitly retired; visible-commit excluded; delay OR duration', async () => {
  const f = fixture(), published = deferred(); f.publish = () => published.promise;
  assert.equal(await f.core.start(), true);
  assert.equal(f.core.observe(f.action('visible', { kind: 'visible-commit', durationMs: 18000 })), false);
  assert.equal(f.core.observe(f.action('fast', { durationMs: 5, inputDelayMs: 5 })), false);
  assert.equal(f.core.observe(f.action('delay-only', { durationMs: 2, inputDelayMs: 151 })), true);
  await f.tick(5);
  assert.equal(f.core.observe(f.action('gap')), false); assert.equal(f.core.state().pendingTriggers, 0);
  assert.equal(f.core.state().retiredTriggers, 1);
  const p = f.core.pause(); published.resolve(true); await drain(); assert.equal(await p, true);
  assert.equal(f.publications[0].actions.length, 1);
});

test('IO.read timeout is not replayed; late result cannot change/publish a partial report again', async () => {
  const f = fixture(), read = deferred(); f.handlers['IO.read'] = () => read.promise;
  assert.equal(await f.core.start(), true);
  const p = f.core.pause('heavy', { preserve: true }); await drain(); await f.tick(31);
  assert.equal(await p, true); assert.equal(f.count('IO.read'), 1); assert.equal(f.publications[0].exportComplete, false);
  const before = JSON.stringify(f.publications[0]); read.resolve({ data: 'SECRET_LATE_DATA', eof: true }); await drain();
  assert.equal(f.publications.length, 1); assert.equal(JSON.stringify(f.publications[0]), before);
  assert.equal(f.count('IO.read'), 1); assert.equal(f.count('IO.close'), 1);
});

test('truncation/data loss/unknown loss cannot become complete; raised options cannot raise hard bounds', async () => {
  const max = fixture({ limits: { bufferKiB: 999999, exportBytes: 99999999, chunkBytes: 99999999,
    outputBytes: 99999999, commandMs: 99999999, exportMs: 99999999, postMs: 99999999, triggers: 99999999 } });
  assert.equal(await max.core.start(), true);
  assert.deepEqual(max.core.state().limits, LIMITS);
  assert.equal(max.calls.find(c => c.method === 'Tracing.start').params.traceConfig.traceBufferSizeInKb, 2048);
  assert.equal(await max.core.dispose(), true);
  for (const mode of ['loss', 'unknown-loss', 'cap', 'empty-not-eof']) {
    const f = fixture({ limits: { ...LIMITS, commandMs: 30, exportMs: 100, postMs: 5, exportBytes: 256 } });
    f.handlers['Tracing.end'] = () => { f.emit('Tracing.tracingComplete', { stream: 'owned', dataLossOccurred: mode === 'loss' ? true : mode === 'unknown-loss' ? undefined : false }); return {}; };
    if (mode === 'cap') f.handlers['IO.read'] = () => ({ data: 'x'.repeat(257), eof: true });
    if (mode === 'empty-not-eof') f.handlers['IO.read'] = () => ({ data: '', eof: false });
    assert.equal(await f.core.start(), true); assert.equal(await f.core.pause('heavy', { preserve: true }), true);
    assert.equal(f.publications[0].status, 'partial'); assert.equal(f.count('IO.close'), 1);
    assert.ok(f.count('IO.read') <= 2);
  }
});

test('bad transport getters/subscribe/log and failing runExclusive never reject public methods', async () => {
  for (const name of ['scope', 'isCurrent', 'subscribe', 'runExclusive']) {
    const f = fixture(); Object.defineProperty(f.transport, name, { get() { throw Error('SECRET_GETTER'); } });
    assert.equal(await f.core.start(), false);
    assert.equal(typeof await f.core.pause(), 'boolean'); assert.equal(typeof await f.core.resume(), 'boolean');
    assert.equal(typeof await f.core.dispose(), 'boolean'); assert.ok(f.core.state());
  }
  const badLog = fixture({ log: () => Promise.reject(Error('SECRET_LOG')) });
  assert.equal(await badLog.core.start(), true); assert.equal(await badLog.core.dispose(), true); await drain();
  const after = fixture(); after.transport.runExclusive = async fn => { await fn(); throw Error('after effect'); };
  assert.equal(await after.core.start(), true); assert.equal(await after.core.dispose(), true);
  assert.equal(after.count('Tracing.end'), 1);
});

test('optional preload clock port: absent/failure/missing origin stays native-only, never Runtime.evaluate', async () => {
  for (const mode of ['absent', 'failure', 'missing-origin', 'bad-getter']) {
    const f = fixture();
    if (mode === 'absent') delete f.transport.readRendererClock;
    if (mode === 'failure') f.handlers.readRendererClock = () => Promise.reject(Error('SECRET_CLOCK'));
    if (mode === 'missing-origin') f.handlers.readRendererClock = () => ({ rendererEpochMs: f.time() + 37, parentBeforeAbs: f.time(), parentAfterAbs: f.time() });
    if (mode === 'bad-getter') Object.defineProperty(f.transport, 'readRendererClock', { get() { throw Error('SECRET_CLOCK'); } });
    assert.equal(await f.core.start(), true); assert.equal(await f.core.pause('heavy', { preserve: true }), true);
    assert.equal(f.collectors[0].finish.rendererClockRelation, undefined);
    assert.equal(f.calls.some(c => c.method.startsWith('Runtime.')), false);
    assert.equal(f.publications[0].status, 'partial');
    assert.ok(f.publications[0].errors.includes('input-renderer-clock-unavailable'));
    assert.ok(!JSON.stringify(f.publications).includes('SECRET_CLOCK'));
  }
});

test('preload clock timeout late reply does not replay request or silently upgrade a finished artifact', async () => {
  const f = fixture(), receipt = deferred(); f.handlers.readRendererClock = () => receipt.promise;
  const started = f.core.start(); await drain(); await f.tick(31); assert.equal(await started, true);
  assert.equal(await f.core.pause('heavy', { preserve: true }), true);
  const saved = JSON.stringify(f.publications[0]); receipt.resolve({ rendererTimeOriginMs: f.rendererOrigin,
    rendererNowMs: f.time() + 37 - f.rendererOrigin, rendererEpochMs: f.time() + 37, parentBeforeAbs: f.time(), parentAfterAbs: f.time() });
  await drain(); assert.equal(JSON.stringify(f.publications[0]), saved); assert.equal(f.count('readRendererClock'), 1);
});

test('actual collector end-to-end in pure core: native pairs, safe raw evidence, nonzero renderer/Main relation', async () => {
  const { createInputLatencyCollector } = require('./perf-input-latency');
  const nativeFixture = require('./perf-input-latency.test.cjs');
  for (const mode of ['exact', 'missing-original', 'foreign-origin']) {
  const f = fixture(); f.collect = createInputLatencyCollector;
  delete f.scope.documentTimeOriginMs; // first scope need not know renderer origin
  const nativeEvents = structuredClone(nativeFixture.events.filter(e => e.name !== 'clock_sync'));
  const original = nativeEvents.find(e => e.name === 'InputLatency::MouseDown' && e.ph === 'b').ts;
  const replacement = 10030000, markers = [];
  for (const e of nativeEvents) {
    if (e.name !== 'thread_name') e.ts += replacement - original;
    for (const c of e.args?.chrome_latency_info?.component_info || []) c.time_us += replacement - original;
  }
  f.handlers['Tracing.recordClockSyncMarker'] = params => {
    markers.push({ name: 'clock_sync', ph: 'c', pid: 11, tid: 1,
      ts: Math.round((f.time() - performance.timeOrigin) * 1000), args: { sync_id: params.syncId } }); return {};
  };
  let encoded, offset = 0;
  f.handlers['IO.read'] = () => {
    if (!encoded) encoded = Buffer.from('{"traceEvents":[\n' + [...markers, ...nativeEvents].map(e => JSON.stringify(e)).join(',\n') + '\n]}');
    const chunk = encoded.subarray(offset, offset + 1024); offset += chunk.length;
    return { data: chunk.toString('base64'), base64Encoded: true, eof: offset === encoded.length };
  };
  assert.equal(await f.core.start(), true);
  f.setTime(f.time() + 400);
  const action = f.action('ui-actual', { startAbs: performance.timeOrigin + replacement / 1000 + 37,
    nativeOriginal: { type: 'pointerdown', pointerType: 'mouse', timeStampMs: replacement / 1000 + 37 - 1000 } });
  if (mode === 'missing-original') delete action.nativeOriginal;
  if (mode === 'foreign-origin') action.documentTimeOriginMs += 1;
  assert.equal(await f.core.pause('heavy', { preserve: true, actions: [action] }), true);
  const report = f.publications[0];
  assert.equal(report.status, 'complete'); assert.equal(report.evidence.trigger.status,
    mode === 'exact' ? 'matched' : mode === 'foreign-origin' ? 'not-requested' : 'unknown');
  if (mode !== 'foreign-origin') assert.equal(report.actions[0].id, 'ui-actual');
  if (mode === 'missing-original') assert.equal(report.evidence.trigger.reason, 'missing-native-original');
  if (mode === 'foreign-origin') { assert.equal(report.actions.length, 0); assert.equal(report.rejectedForeignTriggers, 1); }
  assert.equal(report.evidence.rendererClock.offsetLowMs, -37);
  assert.equal(report.evidence.flows[0].largestMeasuredStage.durationMs, 152.539);
  assert.ok(report.evidence.flows[0].nativeEvidence.some(e => e.args?.chrome_latency_info?.component_info?.length));
  assert.equal(report.evidence.flows[0].linkedNativeIntervals[0].threadMs, 151.09);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 262144);
  assert.equal(f.calls.some(c => c.method.startsWith('Runtime.') || c.method.startsWith('Profiler.')), false);
  }
});

test('bounded publisher envelope rejects excessive/throwing collector result, not a second publish', async () => {
  for (const finish of [() => ({ status: 'complete', payload: 'x'.repeat(270000) }),
    () => ({ status: 'complete', toJSON() { throw Error('SECRET_SERIALIZE'); } })]) {
    const f = fixture({ limits: { ...LIMITS, outputBytes: 16384, commandMs: 30 } });
    f.collect = () => ({ write() {}, finish });
    assert.equal(await f.core.start(), true); assert.equal(await f.core.pause('heavy', { preserve: true }), true);
    assert.equal(f.publications.length, 1); const record = f.publications[0];
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 16384); assert.equal(record.evidence, null);
    assert.equal(record.status, 'partial'); assert.equal(record.cleanupConfirmed, true);
    assert.ok(!JSON.stringify(record).includes('SECRET_SERIALIZE'));
  }
});

test('owner revoked during IO read permits close, forbids further read/clock and does not claim a complete export', async () => {
  const f = fixture(), read = deferred(); f.handlers['IO.read'] = () => read.promise;
  assert.equal(await f.core.start(), true);
  const p = f.core.pause('heavy', { preserve: true }); await drain();
  f.current = false; const before = f.calls.length; read.resolve({ data: '{}', eof: true }); await drain();
  assert.equal(await p, true); assert.deepEqual(f.calls.slice(before).map(c => c.method), ['IO.close']);
  assert.equal(f.publications[0].exportComplete, false); assert.equal(f.publications[0].status, 'partial');
});

test('concurrent preserve pause, dispose and late close ACK neither republish nor restart a ring', async () => {
  const f = fixture(), close = deferred(); f.handlers['IO.close'] = () => close.promise;
  assert.equal(await f.core.start(), true);
  const a = f.core.pause('heavy', { preserve: true }), b = f.core.dispose(); await drain();
  close.resolve({}); await drain(); assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(f.publications.length, 1); assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), 1);
  assert.equal(f.count('Tracing.start'), 1); assert.equal(await f.core.resume(), false);
});

test('pause before START delivery does not create a new ring merely to preserve it', async () => {
  const f = fixture(); const started = f.core.start(); const p = f.core.pause('heavy', { preserve: true });
  assert.equal(await started, false); assert.equal(await p, true);
  assert.equal(f.count('Tracing.start'), 0); assert.equal(f.publications.length, 0);
});

test('late invocation by a failed exclusive wrapper cannot launch after a negative public return', async () => {
  const f = fixture(); let captured;
  f.transport.runExclusive = fn => { captured = fn; throw Error('SECRET_EXCLUSIVE'); };
  assert.equal(await f.core.start(), false); assert.equal(await captured(), false);
  assert.equal(f.count('Tracing.start'), 0); assert.equal(f.listeners.size, 0);
});

test('completion before our END and completion following explicit END refusal cannot authorize a stream', async () => {
  const f = fixture(); assert.equal(await f.core.start(), true);
  f.emit('Tracing.tracingComplete', { stream: 'foreign-early', dataLossOccurred: false });
  assert.equal(f.core.state().phase, 'recording');
  f.handlers['Tracing.end'] = () => { throw Object.assign(Error('before END'), { notSent: true }); };
  const p = f.core.pause(); await drain(); await f.tick(31); assert.equal(await p, false);
  f.emit('Tracing.tracingComplete', { stream: 'foreign-late', dataLossOccurred: false }); await drain();
  assert.equal(f.count('IO.close'), 0); assert.equal(f.count('Tracing.end'), 1);
  assert.equal(await f.core.dispose(), false);
});

test('rolling clocks are bounded and select only exact markers still present after ring eviction', async () => {
  const f = fixture({ limits: { ...LIMITS, clockMs: 1000, commandMs: 30, postMs: 5 } });
  assert.equal(await f.core.start(), true); await f.tick(18000);
  assert.equal(f.count('Tracing.start'), 1); assert.equal(f.count('Tracing.recordClockSyncMarker'), 19);
  f.handlers['IO.read'] = () => ({ data: '{"traceEvents":[\n' + f.clockEvents.slice(-3).map(e => JSON.stringify(e)).join(',\n') + '\n]}', eof: true });
  assert.equal(await f.core.pause('heavy', { preserve: true }), true);
  const record = f.publications[0], supplied = f.collectors[0].finish.clockMarkers;
  assert.equal(record.clockCoverage.issued, 20); assert.equal(record.clockCoverage.receiptsRetained, 16);
  assert.equal(record.clockCoverage.retiredReceipts, 4); assert.equal(record.clockCoverage.usableReceipts, 3);
  assert.equal(record.clockCoverage.missingFromExport, 13);
  assert.deepEqual(supplied.map(m => m.syncId), f.clockEvents.slice(-3).map(e => e.args.sync_id));
  for (const m of supplied) {
    assert.equal(m.before.timeOrigin + m.before.now, m.before.epochMs);
    assert.equal(m.after.timeOrigin + m.after.now, m.after.epochMs);
  }
  await f.tick(10000); assert.equal(f.count('Tracing.recordClockSyncMarker'), 20);
  assert.equal(f.count('Tracing.start'), 1); assert.equal(f.timers.size, 0);
});

test('single surviving marker leaves actual collector clock unknown, without guessed offset', async () => {
  const f = fixture(); f.collect = require('./perf-input-latency').createInputLatencyCollector;
  assert.equal(await f.core.start(), true);
  f.handlers['IO.read'] = () => ({ data: '{"traceEvents":[\n' + JSON.stringify(f.clockEvents.at(-1)) + '\n]}', eof: true });
  assert.equal(await f.core.pause('heavy', { preserve: true }), true);
  const record = f.publications[0];
  assert.equal(record.clockCoverage.usableReceipts, 1); assert.equal(record.evidence.clock.status, 'unknown');
  assert.equal(record.evidence.clock.offsetLowMs, null); assert.equal(record.status, 'partial');
});

test('unknown rolling marker is not retried; original late ACK allows a different later sample', async () => {
  const f = fixture({ limits: { ...LIMITS, clockMs: 1000, commandMs: 30 } }), marker = deferred();
  assert.equal(await f.core.start(), true);
  f.handlers['Tracing.recordClockSyncMarker'] = () => marker.promise;
  await f.tick(1031); assert.equal(f.count('Tracing.recordClockSyncMarker'), 2);
  await f.tick(5000); assert.equal(f.count('Tracing.recordClockSyncMarker'), 2);
  delete f.handlers['Tracing.recordClockSyncMarker']; marker.resolve({}); await drain();
  await f.tick(1000); assert.equal(f.count('Tracing.recordClockSyncMarker'), 3);
  const ids = f.calls.filter(c => c.method === 'Tracing.recordClockSyncMarker').map(c => c.params.syncId);
  assert.equal(new Set(ids).size, 3); assert.equal(f.count('Tracing.start'), 1);
  f.current = false; await f.tick(1000); await f.tick(5000);
  assert.equal(f.count('Tracing.recordClockSyncMarker'), 3); assert.equal(f.timers.size, 0);
  assert.equal(await f.core.dispose(), true);
});

test('onRetired delivers original scope once after unknown START/navigation recovery, clear and unsubscribe', async () => {
  const retired = []; let f;
  f = fixture({ onRetired: scope => {
    assert.equal(f.core.state().recordingId, null); assert.equal(f.listeners.size, 0);
    retired.push(scope); throw Error('SECRET_CALLBACK');
  } });
  const original = { ...f.scope }, start = deferred(); f.handlers['Tracing.start'] = () => start.promise;
  const p = f.core.start(); await drain(); await f.tick(31); assert.equal(await p, false);
  f.current = false; f.scope.documentGeneration++;
  assert.equal(await f.core.pause('navigation'), false); assert.equal(retired.length, 0);
  assert.equal(f.listeners.size, 1, 'parent retains this exact attachment until proof');
  start.resolve({}); await drain();
  assert.equal(retired.length, 1); assert.deepEqual(retired[0], original);
  assert.equal(f.count('Tracing.start'), 1); assert.equal(f.count('Tracing.end'), 1); assert.equal(f.count('IO.close'), 1);
  assert.equal(f.publications.length, 0, 'retirement is independent of artifact persistence');
  assert.equal(await f.core.dispose(), true); assert.equal(retired.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('SECRET_CALLBACK'));
  const asynchronous = fixture({ onRetired: () => Promise.reject(Error('SECRET_CALLBACK_ASYNC')) });
  assert.equal(await asynchronous.core.start(), true); assert.equal(await asynchronous.core.dispose(), true); await drain();
});

test('startup clock ACK for B removes queued foreign A action before primary selection, never rewrites missing origin', async () => {
  const f = fixture(), clock = deferred(); delete f.scope.documentTimeOriginMs;
  f.handlers.readRendererClock = () => clock.promise;
  const started = f.core.start(); await drain();
  assert.equal(f.core.observe(f.action('ui-old-A', { documentTimeOriginMs: f.rendererOrigin - 100 })), true);
  assert.equal(f.core.observe(f.action('ui-current-B')), true);
  assert.equal(f.core.state().pendingTriggers, 2);
  clock.resolve({ rendererTimeOriginMs: f.rendererOrigin, rendererNowMs: f.time() + 37 - f.rendererOrigin,
    rendererEpochMs: f.time() + 37, parentBeforeAbs: f.time(), parentAfterAbs: f.time() });
  await drain(); assert.equal(await started, true); assert.equal(f.core.state().pendingTriggers, 1);
  assert.equal(await f.core.pause('heavy', { preserve: true }), true);
  assert.deepEqual(f.publications[0].actions.map(a => a.id), ['ui-current-B']);
  assert.equal(f.publications[0].rejectedForeignTriggers, 1);
  const known = fixture(); assert.equal(await known.core.start(), true);
  assert.equal(known.core.observe(known.action('ui-foreign-origin', { documentTimeOriginMs: known.rendererOrigin - 1 })), false);
  assert.equal(known.core.observe(known.action('ui-foreign-renderer', { rendererPid: 99 })), false);
  assert.equal(known.core.observe(known.action('ui-origin-unknown', { documentTimeOriginMs: undefined })), true);
  assert.equal(await known.core.pause('heavy', { preserve: true, actions: [known.action('ui-old-A', { documentTimeOriginMs: known.rendererOrigin - 1 })] }), true);
  assert.deepEqual(known.publications[0].actions.map(a => a.id), ['ui-origin-unknown']);
  assert.equal(known.collectors[0].finish.trigger.documentTimeOriginMs, undefined);
});


test('trusted captured mouse click maps only its actual release half; other clicks and ambiguous releases stay unqualified', async () => {
  const { createInputLatencyCollector } = require('./perf-input-latency');
  // Safe minimal release pairs from private116 trace_id=5. The old handler
  // receipts observed equal pointerup/click timestamps, but did NOT record a
  // pointerType. Mouse/touch/pen below are explicit synthetic producer controls.
  const pairs = [["EventLatency","b",2796398330283],["GenerationToBrowserMain","b",2796398330283],["GenerationToBrowserMain","e",2796398330301],["BrowserMainToRendererCompositor","b",2796398330301],["BrowserMainToRendererCompositor","e",2796398330402],["RendererCompositorQueueingDelay","b",2796398330402],["RendererCompositorQueueingDelay","e",2796398330411],["RendererCompositorProcessing","b",2796398330411],["RendererCompositorProcessing","e",2796398330412],["RendererCompositorToMain","b",2796398330412],["RendererCompositorToMain","e",2796398331154],["RendererMainProcessing","b",2796398331154],["RendererMainProcessing","e",2796398331649],["RendererMainFinishedToBeginImplFrame","b",2796398331649],["RendererMainFinishedToBeginImplFrame","e",2796398352624],["BeginImplFrameToSendBeginMainFrame","b",2796398352624],["BeginImplFrameToSendBeginMainFrame","e",2796398352636],["SendBeginMainFrameToCommit","b",2796398352636],["SendBeginMainFrameToCommit","e",2796398354438],["Commit","b",2796398354438],["Commit","e",2796398354464],["EndCommitToActivation","b",2796398354464],["EndCommitToActivation","e",2796398354759],["Activation","b",2796398354759],["Activation","e",2796398354789],["EndActivateToSubmitCompositorFrame","b",2796398354789],["EndActivateToSubmitCompositorFrame","e",2796398360528],["SubmitCompositorFrameToPresentationCompositorFrame","b",2796398360528],["SubmitToReceiveCompositorFrame","b",2796398360528],["SubmitToReceiveCompositorFrame","e",2796398360670],["ReceiveCompositorFrameToStartDraw","b",2796398360670],["ReceiveCompositorFrameToStartDraw","e",2796398360731],["StartDrawToSwapStart","b",2796398360731],["StartDrawToSwapStart","e",2796398361865],["Swap","b",2796398361865],["Swap","e",2796398362114],["SubmitCompositorFrameToPresentationCompositorFrame","e",2796398362114],["EventLatency","e",2796398362137]];
  for (const mode of ['mouse', 'touch', 'pen', 'missing-pointer', 'no-original', 'ambiguous']) {
    const f = fixture(); f.collect = createInputLatencyCollector;
    const components = [
      ['COMPONENT_INPUT_EVENT_LATENCY_BEGIN_RWH',2796398330301],
      ['COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL',2796398330283],
      ['COMPONENT_INPUT_EVENT_LATENCY_RENDERER_MAIN',2796398331153],
      ['COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN',2796398331186],
    ].map(([component_type,time_us]) => ({component_type,time_us}));
    let events = [
      {name:'InputLatency::MouseUp',ph:'b',pid:11,tid:1,ts:2796398330283,id:'60',
        args:{chrome_latency_info:{trace_id:5,is_coalesced:false,component_info:components}}},
      {name:'InputLatency::MouseUp',ph:'e',pid:11,tid:1,ts:2796398342493,id:'60'},
      ...pairs.map(([name,ph,ts]) => ({name,ph,ts,pid:22,tid:2,id2:{local:'61'},
        ...(name==='EventLatency' && ph==='b' ? {args:{event_latency:{event_latency_id:5,event_type:'MOUSE_RELEASED'}}} : {})})),
    ];
    for (const e of events) {
      e.ts += 10030000 - 2796398330283;
      for (const c of e.args?.chrome_latency_info?.component_info || []) c.time_us += 10030000 - 2796398330283;
    }
    if (mode==='ambiguous') events = events.concat(structuredClone(events).map(e => {
      if(e.id)e.id='62'; if(e.id2)e.id2.local='63';
      if(e.args?.chrome_latency_info)e.args.chrome_latency_info.trace_id=6;
      if(e.args?.event_latency)e.args.event_latency.event_latency_id=6; return e;
    }));
    f.handlers['IO.read'] = () => ({data:'{"traceEvents":[\n'+[...f.clockEvents,...events].map(e=>JSON.stringify(e)).join(',\n')+'\n]}',eof:true});
    assert.equal(await f.core.start(), true); f.setTime(f.time()+400);
    const nativeOriginal = {type:'click',timeStampMs:9067};
    if (['mouse','touch','pen','ambiguous'].includes(mode)) nativeOriginal.pointerType = mode==='ambiguous' ? 'mouse' : mode;
    const action = f.action('ui-real-click', {event:'click', nativeOriginal:mode==='no-original' ? undefined : nativeOriginal});
    assert.equal(await f.core.pause('heavy',{preserve:true,actions:[action]}),true);
    const report=f.publications[0], binding=report.evidence.trigger;
    assert.equal(report.actions[0].id,'ui-real-click');
    assert.equal(binding.status,mode==='mouse'?'matched':mode==='ambiguous'?'ambiguous':'unknown');
    if (mode==='mouse') {
      assert.equal(binding.nativeType,'MouseUp'); assert.equal(binding.traceId,'5');
      assert.equal(report.actions[0].nativeOriginal.type,'click');
      assert.equal(report.triggerInterpretation.meaning,'mouse-release-half-only');
      assert.equal(report.triggerInterpretation.wholeGesture,false);
    } else if (mode!=='ambiguous') assert.equal(report.triggerInterpretation,null);
  }
});
