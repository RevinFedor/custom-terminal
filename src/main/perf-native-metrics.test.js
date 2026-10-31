'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createNativePerfMonitor, metricsDelta } = require('./perf-native-metrics');
const metrics = values => ({ metrics: Object.entries(values).map(([name, value]) => ({ name, value })) });

test('native counter intervals distinguish JS/style/layout and do not fabricate missing values', () => {
  const result = metricsDelta(metrics({ Timestamp: 1, ScriptDuration: 1, RecalcStyleDuration: 2, LayoutCount: 4 }),
    metrics({ Timestamp: 2, ScriptDuration: 1.01, RecalcStyleDuration: 2.3, LayoutCount: 6, Nodes: 60000 }));
  assert.equal(result.ScriptDurationMs, 10); assert.equal(result.RecalcStyleDurationMs, 300);
  assert.equal(result.LayoutCount, 2); assert.equal(result.nodes, 60000);
  assert.equal(result.ThreadTimeMs, undefined);
  const idle = metricsDelta(metrics({ Timestamp: 1, ThreadTime: 1 }), metrics({ Timestamp: 2, ThreadTime: 1.02 }));
  assert.equal(idle.intervalWallMs, 1000); assert.equal(idle.rendererThreadCpuPercent, 2);
  assert.equal(metricsDelta(metrics({ Timestamp: 1, ThreadTime: 1 }), metrics({ Timestamp: 1.001, ThreadTime: 1.001 })).rendererThreadCpuPercent, null);
});

// Run the actual CommonJS producer with only Electron transport/process replaced.
// No app, inspector, renderer runtime, provider, or timer is started here.
const preloadSource = fs.readFileSync(path.join(__dirname, 'perf-native-bootstrap-preload.js'), 'utf8');
function preloadControl(onSend = () => {}, isMainFrame = true, globals = {}) {
  const ipc = new EventEmitter(), process = new EventEmitter(), sent = [];
  process.isMainFrame = isMainFrame;
  process.once = (name, listener) => {
    assert.equal(name, 'loaded');
    assert.equal(ipc.listenerCount('perf:native-bootstrap-challenge'), 1, 'challenge listener precedes loaded registration');
    return EventEmitter.prototype.once.call(process, name, listener);
  };
  ipc.send = (channel, payload) => { sent.push({ channel, payload }); onSend(channel, payload); };
  const run = new vm.Script('(function(require, process, module, exports) {\n' + preloadSource + '\n})');
  run.runInNewContext(globals)((name) => {
    if (name === 'electron') return { ipcRenderer: ipc };
    assert.equal(name, 'node:crypto'); return require(name);
  }, process, { exports: {} }, {});
  return { ipc, process, sent };
}
const drain = () => new Promise(resolve => setImmediate(resolve)); // Promise/event turn, never a readiness sleep.

test('actual preload clock is scalar, exact-bootstrap-bound and duplicate-stable', () => {
  let time = 12;
  const f = preloadControl(() => {}, true, { window: { performance: { timeOrigin: 1000, now: () => time } } });
  const base = { wcId: 1, rendererPid: 2, frameProcessId: 77, frameRoutingId: 3,
    documentGeneration: 1, challenge: 'a'.repeat(32) };
  f.ipc.emit('perf:native-bootstrap-challenge', {}, base); f.process.emit('loaded');
  const boot = f.sent.find(x => x.channel === 'perf:native-bootstrap-ack').payload;
  const request = { ...base, bootNonce: boot.bootNonce, clockId: 'b'.repeat(32) };
  f.ipc.emit('perf:input-clock-challenge', {}, { ...request, bootNonce: 'c'.repeat(32) });
  f.ipc.emit('perf:input-clock-challenge', {}, { ...request, frameRoutingId: 4 });
  assert.equal(f.sent.filter(x => x.channel === 'perf:input-clock-ack').length, 0);
  f.ipc.emit('perf:input-clock-challenge', {}, request);
  const first = f.sent.at(-1).payload;
  assert.equal(first.rendererEpochMs, 1012); assert.equal(first.clockId, request.clockId);
  time = 99; f.ipc.emit('perf:input-clock-challenge', {}, request);
  assert.equal(f.sent.at(-1).payload.rendererEpochMs, 1012);
  assert.deepEqual([first.rendererTimeOriginMs, first.rendererNowMs], [1000, 12]);
  assert.deepEqual(Object.keys(first).sort(), [...Object.keys(base), 'bootNonce', 'clockId',
    'rendererEpochMs', 'rendererTimeOriginMs', 'rendererNowMs'].sort());
});

function fixture(t, external = false, options = {}) {
  const { proof = true, ...monitorOptions } = options;
  const dbg = new EventEmitter(), wc = new EventEmitter(), calls = [], logs = [], challenges = [];
  let attached = external, current = 0;
  dbg.isAttached = () => attached;
  dbg.attach = () => { calls.push('attach'); attached = true; };
  dbg.detach = () => { calls.push('detach'); attached = false; dbg.emit('detach', {}, 'owned-detach'); };
  const sendCommand = async method => { calls.push(method); return metrics({ Timestamp: ++current, TaskDuration: current / 10, RecalcStyleDuration: current / 20 }); };
  dbg.sendCommand = sendCommand;
  Object.assign(wc, { id: 1, debugger: dbg, isDestroyed: () => false, getOSProcessId: () => 2, isDevToolsOpened: () => false });
  const newFrame = (extra = {}) => {
    const frame = { parent: null, processId: 77, routingId: 3, osProcessId: wc.getOSProcessId(), ...extra };
    frame.send = (channel, payload) => {
      challenges.push({ frame, channel, payload });
      frame.preload?.ipc.emit(channel, {}, payload);
    };
    return frame;
  };
  wc.mainFrame = newFrame();
  const monitor = createNativePerfMonitor({ webContents: wc, log: s => logs.push(s), autoStart: false, ...monitorOptions });
  const event = (frame = wc.mainFrame) => ({ sender: wc, senderFrame: frame });
  const commit = (frame = newFrame()) => {
    wc.mainFrame = frame;
    wc.emit('did-frame-navigate', {}, 'private-url-not-logged', 200, 'OK', true, frame.processId, frame.routingId);
    return frame;
  };
  const loaded = (frame = wc.mainFrame, deferAck = false) => {
    frame.preload = preloadControl((channel, payload) => {
      if (channel === 'perf:native-bootstrap-available') monitor.bootstrapAvailable(event(frame));
      else if (channel === 'perf:native-bootstrap-ack' && !deferAck) monitor.bootstrapAck(event(frame), payload);
    });
    frame.preload.process.emit('loaded'); return frame.preload;
  };
  const ack = frame => frame.preload.sent.find(item => item.channel === 'perf:native-bootstrap-ack')?.payload;
  t.after(() => monitor.dispose());
  if (proof) { commit(); loaded(); }
  return { dbg, wc, calls, logs, monitor, challenges, newFrame, event, commit, loaded, ack, sendCommand,
    setAttached(value) { attached = value; } };
}

function inputFixture(t, extra = {}) {
  let ports;
  const record = { starts: 0, pauses: [], resumes: 0, disposals: 0 };
  const recorder = { start() { record.starts++; return Promise.resolve(true); },
    pause(reason, options) { record.pauses.push({ reason, options }); return Promise.resolve(true); },
    resume() { record.resumes++; return Promise.resolve(true); },
    dispose() { record.disposals++; return Promise.resolve(true); }, observe() { return true; },
    state: () => ({ phase: 'recording' }), ...extra };
  const f = fixture(t, false, { inputPreroll: { factory(options) { ports = options.transport; return recorder; },
    createCollector() {}, publish: async () => true } });
  return { ...f, record, recorder, ports: () => ports };
}

test('input trace ports require loaded owner and permit only fixed methods on that attachment', async t => {
  const f = inputFixture(t); assert.equal(f.ports(), undefined);
  await f.monitor.sample(); const ports = f.ports(), scope = ports.scope();
  assert.equal(scope.rendererPid, 2); assert.equal(scope.window, 1);
  await assert.rejects(ports.sendRaw('Runtime.evaluate', { expression: 'not allowed' }, scope), /not-admitted/);
  await assert.rejects(ports.sendRaw('Tracing.start', {}, { ...scope, attachmentId: 'foreign' }), /not-admitted/);
  await ports.sendRaw('Tracing.recordClockSyncMarker', { syncId: 'owned-control' }, scope);
  const original = f.calls.length;
  f.setAttached(false); f.dbg.emit('detach', {}, 'external-replacement'); f.setAttached(true);
  assert.equal(ports.canCleanup(scope), false);
  await assert.rejects(ports.sendRaw('Tracing.end', {}, scope, { cleanup: true }), /not-admitted/);
  assert.equal(f.calls.length, original);
});

test('clock reply joins only the exact current frame/nonce and revocation rejects pending reads', async t => {
  const f = inputFixture(t); await f.monitor.sample();
  const ports = f.ports(), scope = ports.scope();
  const clock = ports.readRendererClock(scope);
  const request = f.challenges.at(-1); assert.equal(request.channel, 'perf:input-clock-challenge');
  const response = { ...request.payload, challenge: f.ack(f.wc.mainFrame).challenge,
    rendererEpochMs: 1234, rendererTimeOriginMs: 1000, rendererNowMs: 234 };
  assert.equal(f.monitor.inputClockAck({ sender: { id: 1 }, senderFrame: f.wc.mainFrame }, response), false);
  assert.equal(f.monitor.inputClockAck(f.event(), { ...response, bootNonce: 'a'.repeat(32) }), false);
  assert.equal(f.monitor.inputClockAck(f.event(), response), true);
  const got = await clock; assert.equal(got.rendererEpochMs, 1234); assert.ok(got.parentAfterAbs >= got.parentBeforeAbs);
  assert.equal(f.monitor.inputClockAck(f.event(), response), false);
  const old = ports.readRendererClock(scope); const rejected = assert.rejects(old, /revoked|lost/);
  f.commit(); await rejected;
});

test('heavy profiler admission waits for input cleanup and unknown cleanup does not become ready', async t => {
  let finish;
  const f = inputFixture(t, { pause: () => new Promise(resolve => { finish = resolve; }) });
  await f.monitor.sample(); const resume = f.monitor.suspend('incident-profile', { preserve: true });
  let ready = false; resume.ready.then(() => { ready = true; }, () => {});
  await drain(); assert.equal(ready, false); assert.equal(f.calls.includes('detach'), false);
  finish(true); await resume.ready; assert.equal(f.calls.includes('detach'), true); resume();
  const g = inputFixture(t, { pause: async () => false }); await g.monitor.sample();
  const failed = g.monitor.suspend(); await assert.rejects(failed.ready, /retirement-unconfirmed/); failed();
});

test('disposal keeps detach observation until asynchronous input retirement ends', async t => {
  let finish;
  const f = inputFixture(t, { pause: () => new Promise(resolve => { finish = resolve; }) });
  await f.monitor.sample(); f.monitor.dispose(); await drain();
  assert.ok(f.dbg.listenerCount('detach') > 0);
  f.setAttached(false); f.dbg.emit('detach', {}, 'external-replaced'); f.setAttached(true);
  finish(true); await drain(); await drain();
  assert.equal(f.calls.includes('detach'), false, 'never detach external replacement');
  assert.equal(f.dbg.listenerCount('detach'), 0);
});

test('UNKNOWN START retains its exact attachment until late core cleanup, then a new document may attach', async t => {
  let resolveStart;
  const deadlines = [], events = [];
  const f = fixture(t, false, { inputPreroll: { publish: async () => true },
    schedule(fn, ms) { const item = { fn, ms, cancelled: false }; deadlines.push(item); return item; },
    cancel(item) { if (item) item.cancelled = true; } });
  f.dbg.sendCommand = async (method) => {
    events.push(method);
    if (method.startsWith('Performance.')) return { metrics: [] };
    if (method === 'Tracing.start') return new Promise(resolve => { resolveStart = resolve; });
    if (method === 'Tracing.end') { f.dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 'old-A', dataLossOccurred: false }); return {}; }
    if (method === 'IO.close') return {};
    assert.fail('unexpected ' + method);
  };
  await f.monitor.sample(); await drain(); assert.equal(typeof resolveStart, 'function');
  f.commit(); f.loaded(); await drain();
  for (const item of deadlines.filter(item => !item.cancelled && item.ms === 3000)) { item.cancelled = true; item.fn(); }
  await drain(); await drain();
  assert.equal(f.calls.filter(x => x === 'detach').length, 0, 'deadline is not a tracing cancellation proof');
  assert.equal(await f.monitor.sample('new-document-before-old-proof'), null);
  assert.equal(events.filter(x => x === 'Tracing.start').length, 1);
  resolveStart({}); await drain(); await drain();
  assert.equal(events.filter(x => x === 'Tracing.end').length, 1);
  assert.equal(events.filter(x => x === 'IO.close').length, 1);
  assert.equal(f.calls.filter(x => x === 'detach').length, 1);
  // Leave the subsequent start as a known refusal; do not create another
  // unknown diagnostic operation merely for a test cleanup.
  f.dbg.sendCommand = async method => {
    events.push(method); if (method === 'Tracing.start') throw Error('Tracing has already been started');
    return { metrics: [] };
  };
  assert.ok(await f.monitor.sample('new-document-after-old-proof')); await drain();
  assert.equal(f.calls.filter(x => x === 'attach').length, 2);
  assert.equal(f.calls.filter(x => x === 'detach').length, 1, 'late A cleanup cannot detach B');
});

test('clock-bound current origin rejects old UI summaries even with reused numeric frame IDs', async t => {
  let accepted = 0;
  const f = inputFixture(t, { observe() { accepted++; return true; } }); await f.monitor.sample();
  const oldFrame = f.wc.mainFrame;
  f.commit(); f.loaded(); await drain(); await drain(); await f.monitor.sample();
  const scope = f.ports().scope();
  const clock = f.ports().readRendererClock(scope), request = f.challenges.at(-1).payload;
  f.monitor.inputClockAck(f.event(), { ...request, challenge: f.ack(f.wc.mainFrame).challenge,
    rendererTimeOriginMs: 2000, rendererNowMs: 34, rendererEpochMs: 2034 });
  await clock;
  const action = { id: 'ui-b-1', event: 'wheel', startAbs: 2030, durationMs: 200,
    documentTimeOriginMs: 1000, nativeOriginal: { type: 'wheel', timeStampMs: 1030 } };
  assert.equal(f.monitor.observeInput(action, f.event(oldFrame)), false); assert.equal(accepted, 0);
  assert.equal(f.monitor.observeInput({ ...action, documentTimeOriginMs: 2000 }, f.event()), true);
  assert.equal(accepted, 1);
});
test('passive monitor never reads DOM or starts a profiler and yields to an owned incident capture', async t => {
  const f = fixture(t); await f.monitor.sample(); await f.monitor.sample('ui-action', { id: 'a1' });
  assert.ok(f.logs.some(s => s.startsWith('[Perf:NativeWindow]') && s.includes('RecalcStyleDurationMs')));
  assert.ok(f.calls.every(c => ['attach', 'Performance.enable', 'Performance.getMetrics'].includes(c)));
  const resume = f.monitor.suspend(); const count = f.calls.length;
  await f.monitor.sample(); assert.equal(f.calls.length, count);
  resume(); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.filter(x => x === 'attach').length, 2);
});
test('an external debugger is never commanded or detached', async t => {
  const f = fixture(t, true); await f.monitor.sample(); f.monitor.dispose();
  assert.deepEqual(f.calls, []); assert.ok(f.logs.some(s => s.includes('external-debugger')));
});

test('DevTools visibility without debugger replacement pauses and resumes our existing counter attachment', async t => {
  const f = fixture(t); await f.monitor.sample();
  let open = true; f.wc.isDevToolsOpened = () => open;
  const before = f.calls.length;
  assert.equal(await f.monitor.sample(), null);
  assert.equal(f.calls.length, before, 'opening DevTools must not command or discard our known attachment');
  open = false;
  const resumed = await f.monitor.sample('devtools-closed');
  assert.ok(resumed, 'closing DevTools must not strand our own attachment as external');
  assert.equal(resumed.nativeFromSeconds, null, 'the DevTools interval is not a counter baseline');
  assert.equal(f.calls.filter(x => x === 'attach').length, 1, 'no extra attachment or external detach');
});

test('DevTools opening during a rejected native command keeps ownership only until a real detach', async t => {
  const f = fixture(t); await f.monitor.sample();
  let reject, open = false; f.wc.isDevToolsOpened = () => open;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise((_, r) => { reject = r; }); };
  const pending = f.monitor.sample();
  open = true; reject(new Error('DevTools temporarily unavailable'));
  assert.equal(await pending, null);
  const before = f.calls.length;
  await f.monitor.sample(); assert.equal(f.calls.length, before);
  open = false; f.dbg.sendCommand = f.sendCommand;
  assert.ok(await f.monitor.sample('closed-after-rejection'));
  // A genuine replacement still revokes ownership and cannot be commandeered.
  f.dbg.emit('detach', {}, 'replaced-with-devtools'); f.setAttached(true);
  const external = f.calls.length;
  assert.equal(await f.monitor.sample(), null); f.monitor.dispose();
  assert.equal(f.calls.length, external);
});

test('a successful pending command cannot bridge an opened and closed DevTools interval', async t => {
  const f = fixture(t); await f.monitor.sample();
  let resolve, open = false; f.wc.isDevToolsOpened = () => open;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(r => { resolve = r; }); };
  const pending = f.monitor.sample();
  open = true; f.wc.emit('devtools-opened');
  open = false; f.wc.emit('devtools-closed');
  resolve(metrics({ Timestamp: 100, TaskDuration: 20 }));
  assert.equal(await pending, null);
  f.dbg.sendCommand = f.sendCommand;
  assert.equal((await f.monitor.sample()).nativeFromSeconds, null);
});

test('navigation, suspension and disposal retire only our deferred attachment after DevTools closes', async t => {
  for (const kind of ['navigation', 'suspend', 'dispose']) {
    const f = fixture(t); await f.monitor.sample();
    let open = true; f.wc.isDevToolsOpened = () => open; f.wc.emit('devtools-opened');
    let resume;
    if (kind === 'navigation') { f.wc.emit('did-start-navigation', {}, 'private', false, true); f.commit(); f.loaded(); }
    else if (kind === 'suspend') resume = f.monitor.suspend();
    else f.monitor.dispose();
    const before = f.calls.length;
    open = false; f.wc.emit('devtools-closed');
    assert.equal(f.calls[before], 'detach', kind + ': retire the known old attachment');
    if (kind === 'dispose') {
      assert.equal(f.wc.listenerCount('devtools-closed'), 0);
      assert.equal(f.dbg.listenerCount('detach'), 0);
    } else {
      resume?.(); await drain();
      assert.ok(await f.monitor.sample(), kind + ': a fresh current owner can collect counters');
    }
  }
});

test('external replacement after deferred disposal removes retirement listeners without detaching the replacement', async t => {
  const f = fixture(t); await f.monitor.sample();
  let open = true; f.wc.isDevToolsOpened = () => open; f.wc.emit('devtools-opened');
  f.monitor.dispose();
  assert.equal(f.wc.listenerCount('devtools-closed'), 1);
  const before = f.calls.length;
  f.dbg.emit('detach', {}, 'replaced-with-devtools'); f.setAttached(true);
  open = false; f.wc.emit('devtools-closed');
  assert.equal(await f.monitor.sample(), null);
  assert.equal(f.calls.length, before);
  assert.equal(f.wc.listenerCount('devtools-closed'), 0);
  assert.equal(f.wc.listenerCount('destroyed'), 0);
  assert.equal(f.dbg.listenerCount('detach'), 0);
});

test('coalesced current-document UI action keeps its completed counter interval', async t => {
  let now = 1000;
  const f = fixture(t, false, { now: () => now });
  await f.monitor.sample();
  let release;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { release = resolve; }); };
  now = 1100;
  const sample = f.monitor.sample();
  const calls = f.calls.length;
  const action = f.monitor.sample('ui-action', { id: 'coalesced-current', startAbs: 1120, durationMs: 20 });
  assert.equal(f.calls.length, calls, 'coalescing never issues another command');
  now = 1200;
  release(metrics({ Timestamp: 3, TaskDuration: 0.4, RecalcStyleDuration: 0.2 }));
  await Promise.all([sample, action]);
  const record = f.logs.filter(s => s.startsWith('[Perf:NativeAction]'))
    .map(s => JSON.parse(s.slice(s.indexOf('{')))).find(s => s.action.id === 'coalesced-current');
  assert(record, 'the genuine current action is not lost while its sample is pending');
  assert(record.intervals.length > 0);
  assert.equal(f.calls.length, calls);
});

test('coalesced old-document UI action is never relabelled with its replacement', async t => {
  const f = fixture(t); await f.monitor.sample();
  let release;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { release = resolve; }); };
  const sample = f.monitor.sample();
  const action = f.monitor.sample('ui-action', { id: 'coalesced-old', startAbs: 0, durationMs: 100 });
  f.wc.emit('did-start-navigation', {}, 'not-logged', false, true);
  const frame = f.commit(); f.loaded(frame);
  release(metrics({ Timestamp: 999, TaskDuration: 999 }));
  await Promise.all([sample, action]);
  assert(!f.logs.some(s => s.startsWith('[Perf:NativeAction]') && s.includes('coalesced-old')));
});
test('late reply after user DevTools replacement is discarded without detaching its owner', async t => {
  const f = fixture(t); await f.monitor.sample(); let release;
  f.dbg.sendCommand = () => new Promise(resolve => { release = resolve; });
  const pending = f.monitor.sample();
  f.dbg.emit('detach', {}, 'replaced-with-devtools'); release(metrics({ Timestamp: 2 }));
  assert.equal(await pending, null); f.monitor.dispose();
  assert.ok(!f.calls.includes('detach'));
});
test('renderer navigation resets counters instead of reporting a cross-document CPU delta', async t => {
  const f = fixture(t); await f.monitor.sample(); await f.monitor.sample();
  f.wc.emit('did-start-navigation', {}, 'not-logged', false, true);
  assert.equal(await f.monitor.sample('no-new-proof'), null);
  f.commit(); f.loaded();
  const next = await f.monitor.sample('after-navigation');
  assert.equal(next.nativeFromSeconds, null); assert.equal(next.previousSampleAbs, null);
  assert.equal(next.TaskDurationMs, undefined);
  assert.ok(!f.logs.join('\n').includes('not-logged'));
});

test('absent or unknown renderer PID never receives a debugger command', async t => {
  const f = fixture(t);
  for (const pid of [0, null, undefined, -1]) {
    f.wc.getOSProcessId = () => pid;
    assert.equal(await f.monitor.sample(), null);
  }
  assert.deepEqual(f.calls, []);
  assert(f.logs.some(s => s.includes('renderer-pid-unavailable')));
});

test('renderer loss revokes counters and replacement resumes early with a fresh baseline', async t => {
  const f = fixture(t); await f.monitor.sample(); await f.monitor.sample();
  f.wc.getOSProcessId = () => 0; f.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  const before = f.calls.length;
  await f.monitor.sample(); await f.monitor.sample('ui-action', { id: 'gone' });
  assert.equal(f.calls.length, before); assert.equal(f.calls.filter(x => x === 'detach').length, 1);
  f.wc.getOSProcessId = () => 99;
  f.wc.emit('frame-created', {}, { frame: f.newFrame() });
  assert.equal(await f.monitor.sample(), null);
  f.commit(); f.loaded();
  const next = await f.monitor.sample('new-renderer-before-dom-ready');
  assert.equal(next.rendererPid, 99); assert.equal(next.nativeFromSeconds, null);
  assert.equal(next.TaskDurationMs, undefined); assert.equal(f.calls.filter(x => x === 'attach').length, 2);
});

test('late enable from a crashed renderer cannot issue getMetrics for a replacement', async t => {
  const f = fixture(t); let release;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { release = resolve; }); };
  const pending = f.monitor.sample(); assert.equal(typeof release, 'function');
  f.wc.getOSProcessId = () => 0; f.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  release({}); assert.equal(await pending, null);
  assert.equal(f.calls.filter(x => x === 'Performance.getMetrics').length, 0);
  const records = f.logs.filter(s => s.startsWith('[Perf:NativeMethod]')).map(s => JSON.parse(s.slice(s.indexOf('{'))));
  assert(records.some(r => r.method === 'Performance.enable' && r.phase === 'settled' && r.rendererPid === 2 && r.ownerCurrent === false));
});

test('pending metrics preserve issue and actual late settlement without publishing stale counters', async t => {
  const f = fixture(t); await f.monitor.sample(); let release;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { release = resolve; }); };
  const windows = f.logs.filter(s => s.startsWith('[Perf:NativeWindow]')).length;
  const pending = f.monitor.sample();
  f.wc.getOSProcessId = () => 0; f.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  const crash = JSON.parse(f.logs.find(s => s.startsWith('[Perf:NativeMethodWindow]')).split('] ')[1]);
  assert(crash.operations.some(r => r.method === 'Performance.getMetrics' && r.phase === 'issue' && r.rendererPid === 2));
  release(metrics({ Timestamp: 999, TaskDuration: 999 })); assert.equal(await pending, null);
  assert.equal(f.logs.filter(s => s.startsWith('[Perf:NativeWindow]')).length, windows);
});

test('periodic reads stop on loss; only a committed bootstrap rearms counters before DOM', async t => {
  const timers = [];
  const f = fixture(t, false, { autoStart: true, proof: false,
    schedule(fn, delay) { const h = { fn, delay, cancelled: false, unref() {} }; timers.push(h); return h; },
    cancel(h) { h.cancelled = true; } });
  await timers[0].fn();
  assert.deepEqual(f.calls, []);
  f.wc.getOSProcessId = () => 0; f.wc.emit('render-process-gone');
  assert(timers.every(h => h.cancelled || h === timers[0]));
  const before = f.calls.length; await f.monitor.sample(); assert.equal(f.calls.length, before);
  f.wc.getOSProcessId = () => 100;
  f.wc.emit('frame-created', {}, { frame: f.newFrame({ parent: {} }) });
  f.wc.emit('frame-created', {}, { frame: f.newFrame() }); f.wc.emit('dom-ready');
  assert.equal(timers.filter(h => !h.cancelled && h !== timers[0]).length, 0);
  assert.equal(f.calls.length, before);
  f.commit(); f.loaded(); await drain();
  assert.deepEqual(f.calls, ['attach', 'Performance.enable', 'Performance.getMetrics']);
  assert.equal(timers.filter(h => !h.cancelled && h !== timers[0]).length, 1);
  const count = f.calls.length;
  f.monitor.bootstrapAck(f.event(), f.ack(f.wc.mainFrame)); f.monitor.bootstrapAvailable(f.event());
  assert.equal(f.calls.length, count);
  f.monitor.dispose();
  for (const name of ['did-frame-navigate', 'did-start-navigation', 'render-process-gone', 'dom-ready', 'did-finish-load', 'destroyed']) {
    assert.equal(f.wc.listenerCount(name), 0);
  }
});

test('native method crash window is bounded and contains only method metadata', async t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) await f.monitor.sample();
  f.wc.getOSProcessId = () => 0; f.wc.emit('render-process-gone');
  const line = f.logs.find(s => s.startsWith('[Perf:NativeMethodWindow]'));
  const window = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(window.operations.length, 8);
  assert(window.operations.every(r => ['Performance.enable', 'Performance.getMetrics', 'Debugger.attach'].includes(r.method)));
  assert(!line.includes('metrics"')); assert(!line.includes('params"'));
});

test('deferred document and deadline sequence keeps exactly one raw lane across all triggers', async t => {
  const timers = [];
  const f = fixture(t, false, { proof: false, now: () => 100,
    schedule(fn, delay) { const h = { fn, delay }; timers.push(h); return h; },
    cancel(h) { h.cancelled = true; } });
  const windows = () => f.logs.filter(line => line.startsWith('[Perf:NativeWindow]')).length;
  const records = () => f.logs.filter(line => line.startsWith('[Perf:NativeMethod]'))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))));
  f.wc.emit('frame-created', {}, { frame: f.wc.mainFrame });
  f.wc.emit('dom-ready'); f.wc.emit('did-finish-load');
  assert.equal(await f.monitor.sample('before-proof'), null); assert.deepEqual(f.calls, []);
  const a = f.commit(); f.loaded(a);
  const proofA = f.ack(a);
  const baselineA = await f.monitor.sample('A-before-DOM');
  assert.equal(baselineA.nativeFromSeconds, null);
  assert.deepEqual(f.calls, ['attach', 'Performance.enable', 'Performance.getMetrics']);
  let releaseA;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { releaseA = resolve; }); };
  const pendingA = f.monitor.sample();
  f.wc.emit('did-start-navigation', {}, 'private-navigation', false, true);
  const atNavigation = f.calls.length;
  assert.equal(await f.monitor.sample(), null); assert.equal(f.calls.length, atNavigation);
  const b = f.commit();
  assert.equal(a.osProcessId, b.osProcessId); assert.equal(a.processId, b.processId); assert.equal(a.routingId, b.routingId);
  assert.equal(f.monitor.bootstrapAck(f.event(a), proofA), false);
  const challengeB = f.challenges.at(-1).payload;
  f.monitor.bootstrapAvailable(f.event(a));
  assert.equal(f.challenges.at(-1).frame, b);
  assert.equal(f.challenges.at(-1).payload.challenge, challengeB.challenge);
  assert.notEqual(challengeB.challenge, proofA.challenge);
  const beforeLateA = windows();
  releaseA(metrics({ Timestamp: 999, TaskDuration: 999 }));
  assert.equal(await pendingA, null); assert.equal(windows(), beforeLateA);
  assert.equal(await f.monitor.sample(), null); // Commit alone never authorizes B.
  f.dbg.sendCommand = f.sendCommand;
  f.loaded(b);
  const proofB = f.ack(b), baselineB = await f.monitor.sample('B-before-DOM');
  assert.equal(baselineB.nativeFromSeconds, null); assert.equal(baselineB.TaskDurationMs, undefined);
  assert.notEqual(baselineB.documentGeneration, baselineA.documentGeneration);
  assert.deepEqual(f.calls.slice(-3), ['attach', 'Performance.enable', 'Performance.getMetrics']);

  let releaseB;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { releaseB = resolve; }); };
  const pendingB = f.monitor.sample();
  const issueB = records().at(-1);
  timers.findLast(h => !h.cancelled).fn(); // Inject caller deadline, not wall time.
  assert.equal(await pendingB, null);
  const beforeBlocked = f.calls.length, beforeLateB = windows();
  await f.monitor.sample(); await f.monitor.sample('ui-action', { id: 'deadline-ui' });
  f.monitor.bootstrapAck(f.event(b), proofB); f.monitor.bootstrapAvailable(f.event(a));
  const resumeOuter = f.monitor.suspend(), resumeInner = f.monitor.suspend();
  const afterSuspend = f.calls.length;
  assert.equal(afterSuspend, beforeBlocked + 1); // Explicit profile handoff detaches only our attachment.
  resumeInner(); resumeInner();
  await f.monitor.sample(); resumeOuter(); resumeOuter(); await drain();
  assert.equal(f.calls.length, afterSuspend);
  assert(f.logs.some(line => line.includes('native-command-unsettled-after-deadline')));

  // External replacement while the old native promise is still unresolved.
  f.setAttached(true); f.wc.isDevToolsOpened = () => true; f.dbg.emit('detach', {}, 'replaced-with-devtools');
  await f.monitor.sample(); assert.equal(f.calls.length, afterSuspend);
  releaseB(metrics({ Timestamp: 1000, TaskDuration: 1000 })); await drain();
  const late = records().filter(r => r.operationId === issueB.operationId && r.phase === 'settled');
  assert.equal(late.length, 1); assert.equal(late[0].late, true); assert.equal(late[0].ownerCurrent, false);
  assert.equal(records().filter(r => r.operationId === issueB.operationId && r.phase === 'deadline').length, 1);
  assert.equal(windows(), beforeLateB);
  await f.monitor.sample(); f.monitor.bootstrapAck(f.event(b), proofB); await drain();
  assert.equal(f.calls.length, afterSuspend); // Never commands/detaches external DevTools.
  f.setAttached(false); f.wc.isDevToolsOpened = () => false; f.dbg.emit('detach', {}, 'external-closed');
  f.dbg.sendCommand = f.sendCommand;
  const fresh = await f.monitor.sample('ordinary-after-actual-settlement');
  assert.equal(fresh.nativeFromSeconds, null);
  assert.deepEqual(f.calls.slice(-3), ['attach', 'Performance.enable', 'Performance.getMetrics']);
  const allLogs = f.logs.join('\n');
  for (const secret of [proofA.challenge, proofA.bootNonce, proofB.challenge, proofB.bootNonce, 'private-navigation', 'private-url-not-logged']) {
    assert(!allLogs.includes(secret));
  }
  assert(f.logs.every(line => line.length < 5000));
});

test('actual preload buffers challenge before loaded and accepts loaded before commit', async t => {
  for (const loadedFirst of [false, true]) {
    const f = fixture(t, false, { proof: false });
    const frame = f.newFrame(); f.wc.mainFrame = frame;
    if (loadedFirst) f.loaded(frame);
    else {
      frame.preload = preloadControl((channel, payload) => {
        if (channel === 'perf:native-bootstrap-available') f.monitor.bootstrapAvailable(f.event(frame));
        else f.monitor.bootstrapAck(f.event(frame), payload);
      });
    }
    assert.equal(await f.monitor.sample(), null);
    f.commit(frame);
    if (!loadedFirst) {
      assert.equal(frame.preload.sent.length, 0);
      assert.equal(await f.monitor.sample(), null);
      frame.preload.process.emit('loaded');
    }
    const result = await f.monitor.sample('early-without-DOM');
    assert.equal(result.nativeFromSeconds, null);
    assert.deepEqual(f.calls, ['attach', 'Performance.enable', 'Performance.getMetrics']);
    assert.equal(frame.preload.sent.filter(r => r.channel === 'perf:native-bootstrap-ack').length, 1);
    f.monitor.bootstrapAvailable(f.event(frame));
    assert.equal(frame.preload.sent.filter(r => r.channel === 'perf:native-bootstrap-ack').length, 1);
  }
  const subframe = preloadControl(() => assert.fail('subframe must not send'), false);
  assert.equal(subframe.ipc.listenerCount('perf:native-bootstrap-challenge'), 0);
  assert.equal(subframe.process.listenerCount('loaded'), 0);
});

test('preload drops malformed/older challenges and keeps bounded receipt fields', () => {
  const p = preloadControl();
  p.process.emit('loaded');
  const send = value => p.ipc.emit('perf:native-bootstrap-challenge', {}, value);
  const challenge = { challenge: 'a'.repeat(32), wcId: 1, rendererPid: 2, frameProcessId: 77,
    frameRoutingId: 3, documentGeneration: 9, privateExtra: 'never-echo-this' };
  for (const value of [null, {}, { ...challenge, challenge: 'z'.repeat(2048) },
    { ...challenge, rendererPid: NaN }, { ...challenge, documentGeneration: -1 }]) send(value);
  assert.equal(p.sent.length, 1); // Only availability until a valid challenge.
  send(challenge); send(challenge);
  send({ ...challenge, documentGeneration: 8, challenge: 'b'.repeat(32) });
  send({ ...challenge, challenge: 'c'.repeat(32) });
  assert.equal(p.sent.length, 2);
  assert.equal(p.sent[1].payload.privateExtra, undefined);
  assert.match(p.sent[1].payload.bootNonce, /^[a-f0-9]{32}$/);
});

test('binding guards reject wrong sender, subframe, missing PID and forged protocol fields', async t => {
  const f = fixture(t, false, { proof: false });
  const frame = f.commit(); f.loaded(frame, true); const proof = f.ack(frame);
  assert.equal(await f.monitor.sample(), null);
  for (const event of [{ sender: { id: f.wc.id }, senderFrame: frame }, f.event(f.newFrame({ parent: frame })),
    f.event(f.newFrame({ processId: frame.osProcessId })), f.event(f.newFrame({ osProcessId: 0 })),
    { sender: f.wc, senderFrame: null }]) {
    assert.equal(f.monitor.bootstrapAck(event, proof), false);
    assert.equal(f.monitor.bootstrapAvailable(event), false);
  }
  const goneFrame = { sender: f.wc, get senderFrame() { throw new Error('disposed-frame'); } };
  assert.equal(f.monitor.bootstrapAck(goneFrame, proof), false);
  assert.equal(f.monitor.bootstrapAvailable(goneFrame), false);
  for (const key of ['wcId', 'rendererPid', 'frameProcessId', 'frameRoutingId', 'documentGeneration']) {
    assert.equal(f.monitor.bootstrapAck(f.event(), { ...proof, [key]: proof[key] + 1 }), false);
  }
  assert.equal(f.monitor.bootstrapAck(f.event(), { ...proof, bootNonce: 'private-invalid-nonce' }), false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.monitor.bootstrapAck(f.event(), proof), true);
  assert.equal(f.monitor.bootstrapAck(f.event(), proof), true);
  assert.equal(f.monitor.bootstrapAck(f.event(), { ...proof, bootNonce: 'f'.repeat(32) }), false);
  for (const pid of [0, null, undefined, -1]) {
    f.wc.getOSProcessId = () => pid;
    assert.equal(await f.monitor.sample(), null);
    assert.equal(f.monitor.bootstrapAck(f.event(), proof), false);
  }
  assert.deepEqual(f.calls, []);
  assert(!f.logs.join('\n').includes('private-invalid-nonce'));
});

test('a commit without exact current main frame and OS PID cannot authorize attachment', async t => {
  for (const kind of ['missing-pid', 'wrong-frame-pid', 'wrong-process', 'wrong-route']) {
    const f = fixture(t, false, { proof: false });
    const frame = f.newFrame();
    if (kind === 'missing-pid') f.wc.getOSProcessId = () => 0;
    if (kind === 'wrong-frame-pid') frame.osProcessId++;
    f.wc.mainFrame = frame;
    f.wc.emit('did-frame-navigate', {}, 'not-logged', 200, 'OK', true,
      frame.processId + (kind === 'wrong-process' ? 1 : 0), frame.routingId + (kind === 'wrong-route' ? 1 : 0));
    f.loaded(frame); f.wc.emit('dom-ready'); f.wc.emit('did-finish-load');
    assert.equal(await f.monitor.sample(), null); assert.deepEqual(f.calls, []);
    assert.equal(f.challenges.length, 0);
  }
});

test('subframe/hash navigation and counter suspension preserve document identity; real navigation revokes it', async t => {
  const f = fixture(t); const first = await f.monitor.sample();
  f.wc.emit('did-start-navigation', {}, 'subframe-secret', false, false);
  f.wc.emit('did-frame-navigate', {}, 'subframe-secret', 200, 'OK', false, 78, 4);
  f.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  f.wc.emit('did-navigate-in-page', {}, 'hash-secret', true);
  const next = await f.monitor.sample();
  assert.equal(next.documentGeneration, first.documentGeneration); assert.equal(next.nativeFromSeconds, first.nativeToSeconds);
  const release1 = f.monitor.suspend(), release2 = f.monitor.suspend();
  const before = f.calls.length; release1(); release1(); await drain(); assert.equal(f.calls.length, before);
  release2(); release2(); await drain();
  const resumed = await f.monitor.sample(); assert.equal(resumed.documentGeneration, first.documentGeneration);
  assert.equal(f.calls.filter(c => c === 'attach').length, 2);
  const release3 = f.monitor.suspend();
  f.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  f.commit(); const afterNavigation = f.calls.length; release3(); await drain();
  assert.equal(f.calls.length, afterNavigation);
  f.loaded(); const fresh = await f.monitor.sample(); assert.equal(fresh.nativeFromSeconds, null);
});

test('late rejection after deadline, disposal, and destruction settles once and never retries', async t => {
  for (const lifecycle of ['dispose', 'destroyed']) {
    const timers = [];
    const f = fixture(t, false, { schedule(fn) { const h = { fn }; timers.push(h); return h; }, cancel(h) { h.cancelled = true; } });
    await f.monitor.sample(); let rejectRaw;
    f.dbg.sendCommand = method => { f.calls.push(method); return new Promise((_, reject) => { rejectRaw = reject; }); };
    const pending = f.monitor.sample(); timers.at(-1).fn(); assert.equal(await pending, null);
    assert.equal(f.calls.filter(c => c === 'detach').length, 0); // Timeout alone never yields/reacquires.
    if (lifecycle === 'destroyed') { f.wc.isDestroyed = () => true; f.wc.emit('destroyed'); }
    else f.monitor.dispose();
    const before = f.calls.length;
    rejectRaw(new Error('private-native-error-payload')); await drain();
    const late = f.logs.filter(line => line.includes('"phase":"rejected"') && line.includes('"late":true'));
    assert.equal(late.length, 1); assert(late[0].includes('"ownerCurrent":false'));
    assert.equal(await f.monitor.sample(), null);
    assert.equal(f.monitor.bootstrapAck(f.event(), f.ack(f.wc.mainFrame)), false);
    assert.equal(f.calls.length, before); assert(!f.logs.join('\n').includes('private-native-error-payload'));
  }
});

test('deadline during enable retains raw lane; ordinary sample after settlement starts a new baseline', async t => {
  const timers = [];
  const f = fixture(t, false, { schedule(fn) { const h = { fn }; timers.push(h); return h; }, cancel(h) { h.cancelled = true; } });
  let release;
  f.dbg.sendCommand = method => { f.calls.push(method); return new Promise(resolve => { release = resolve; }); };
  const pending = f.monitor.sample(); timers.at(-1).fn(); assert.equal(await pending, null);
  const count = f.calls.length; await f.monitor.sample(); await f.monitor.sample('ui-action');
  assert.equal(f.calls.length, count); assert(!f.calls.includes('detach'));
  release({}); await drain(); assert.equal(f.calls.length, count);
  f.dbg.sendCommand = f.sendCommand;
  const next = await f.monitor.sample('ordinary-after-settlement');
  assert.equal(next.nativeFromSeconds, null); assert.equal(f.calls.filter(c => c === 'attach').length, 1);
});

test('Main source syntax and focused actual bootstrap handlers/window preferences retain exact wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  // Syntax-only compilation, no execution or 3.3MB TypeScript AST/program.
  new vm.Script('(function(require, module, exports) {\n' + source + '\n})');
  const start = source.indexOf('const perfNativeMonitors = new Map();');
  const end = source.indexOf("ipcMain.on('perf:ui-summary'", start);
  assert(start > 0 && end > start);
  const handlersSource = source.slice(start, end);
  const ast = require('acorn').parse(handlersSource, { ecmaVersion: 'latest' });
  const ipcRegistration = node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression'
    && node.expression.callee.object.name === 'ipcMain' && node.expression.callee.property.name === 'on';
  const channels = ast.body.filter(ipcRegistration)
    .map(node => node.expression.arguments[0].value).sort();
  assert.deepEqual(channels, ['perf:native-bootstrap-available', 'perf:native-bootstrap-ack', 'perf:input-clock-ack'].sort());
  // Execute the real counter-owner boundary. The adjacent manual-capture
  // controller has its own actual tests and is not a bootstrap dependency.
  const focusedSource = ast.body.filter(node => ipcRegistration(node)
    || (node.type === 'FunctionDeclaration' && node.id.name === 'ensureNativePerfMonitor')
    || (node.type === 'VariableDeclaration' && node.declarations.some(d => ['perfNativeMonitors','perfNativeCaptureHolds'].includes(d.id.name))))
    .map(node => handlersSource.slice(node.start, node.end)).join('\n');
  const ipcMain = new EventEmitter(), routed = [], installs = [], writers = [];
  const owned = { id: 47, isDestroyed: () => false, once() {} };
  const monitor = { dispose() {}, bootstrapAvailable(event) { routed.push(['available', event]); },
    bootstrapAck(event, payload) { routed.push(['ack', event, payload]); },
    inputClockAck(event, payload) { routed.push(['clock', event, payload]); } };
  const publish = () => true;
  const context = { ipcMain, process: { env: {}, pid: 333 }, mainWindow: { webContents: owned },
    mainLogPath: '/private/owned-logs/production.log', perfCollectionAllowed: true, path, srcMainDir: __dirname,
    console, require(name) {
      if (name === path.join(__dirname, 'perf-input-snapshot-store.js')) return {
        createInputSnapshotWriter(options) { writers.push(options); return { publish }; } };
      assert.equal(name, path.join(__dirname, 'perf-native-metrics.js'));
      return { createNativePerfMonitor(options) { installs.push(options); return monitor; } }; } };
  vm.runInNewContext(focusedSource + '\nthis.ensure = ensureNativePerfMonitor;', context);
  const foreign = { sender: { id: 999 } };
  ipcMain.emit('perf:native-bootstrap-available', foreign); ipcMain.emit('perf:native-bootstrap-ack', foreign, {});
  ipcMain.emit('perf:input-clock-ack', foreign, {});
  assert.deepEqual(installs, []); assert.deepEqual(routed, []);
  assert.equal(context.ensure(owned), monitor); assert.equal(context.ensure(owned), monitor);
  const event = { sender: owned, senderFrame: { processId: 5, routingId: 6 } }, payload = { exact: true };
  ipcMain.emit('perf:native-bootstrap-available', event); ipcMain.emit('perf:native-bootstrap-ack', event, payload);
  ipcMain.emit('perf:input-clock-ack', event, payload);
  assert.equal(installs.length, 1); assert.equal(routed[0][1], event); assert.equal(routed[1][1], event);
  assert.equal(installs[0].inputPreroll.publish, publish); assert.equal(writers.length, 1);
  assert.equal(writers[0].mainPid, 333); assert.equal(writers[0].windowId, owned.id);
  context.ensure({ ...owned, id: 48 });
  assert.equal(installs[1].inputPreroll, null, 'secondary windows never own another global trace');
  assert.equal(writers.length, 1);
  assert.equal(routed[1][2], payload);
  assert.deepEqual(routed[2], ['clock', event, payload]);
  for (const channel of ['perf:native-bootstrap-available', 'perf:native-bootstrap-ack', 'perf:input-clock-ack']) {
    assert.equal(source.split("ipcMain.on('" + channel + "'").length - 1, 1);
    assert.equal(source.split("ipcMain.handle('" + channel + "'").length - 1, 0);
  }
  const windowStart = source.indexOf('  const windowOptions = {', source.indexOf('function createWindow('));
  const windowEnd = source.indexOf('  mainWindow = new BrowserWindow(windowOptions);', windowStart);
  assert(windowStart > 0 && windowEnd > windowStart);
  const windowAst = require('acorn').parse(source.slice(windowStart, windowEnd), { ecmaVersion: 'latest' });
  const options = windowAst.body[0].declarations[0].init;
  const preferences = options.properties.find(p => p.key.name === 'webPreferences').value;
  const preload = preferences.properties.filter(p => p.key?.name === 'preload');
  assert.equal(preload.length, 1);
  const expression = source.slice(windowStart + preload[0].value.start, windowStart + preload[0].value.end);
  assert.equal(vm.runInNewContext(expression, { path, srcMainDir: '/source/src/main' }), '/source/src/main/perf-native-bootstrap-preload.js');
  const installedAt = source.indexOf('ensureNativePerfMonitor(mainWindow.webContents);', windowEnd);
  const firstLoad = source.slice(windowEnd).search(/mainWindow\.load(?:URL|File)\(/) + windowEnd;
  assert(installedAt > windowEnd && firstLoad > installedAt);
  const files = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).build.files;
  assert(files.includes('src/main/**/*'));
});
