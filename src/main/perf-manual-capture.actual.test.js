'use strict';
// Execute SOURCE boundary bodies with controlled Electron/CDP/inspector/clock
// ports. No Electron launch, native sample, socket, inspector port or OS input.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const manual = require('./perf-manual-capture');
function body(file, first, end) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const start = src.indexOf(first); assert.ok(start >= 0, first);
  const stop = src.indexOf(end, start); assert.ok(stop > start, end);
  return src.slice(start, stop);
}
function load(file, overrides = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module, exports: module.exports, Buffer, process, console, setTimeout, clearTimeout,
    __dirname, __filename: path.join(__dirname, file),
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(__dirname, name) : name),
    ...globals,
  }, { filename: file });
  return module.exports;
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-perf-manual-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function flightFixture(t) {
  const dir = path.join(directory(t), 'perf-incidents'), requests = [], logs = [];
  let now = 0, tick, forward;
  const wallOrigin = Date.now();
  const exports = load('perf-flight-recorder.js', {
    perf_hooks: { performance: { timeOrigin: 1700000000000, now: () => now } },
    os: { cpus: () => [], loadavg: () => [] },
  }, { Date: class extends Date { static now() { return wallOrigin + now; } },
    setTimeout: fn => { tick = fn; return { unref() {} }; }, clearTimeout() {} });
  const flight = exports.createFlightRecorder({ directory: dir, mainPid: process.pid,
    log: x => logs.push(x), context: () => ({}), requestCapture: r => { requests.push(r); forward?.(r); },
    snapshot: () => ({ ok: true, processes: [] }), pressure: () => ({ available: false }) });
  t.after(() => flight.stop());
  return { dir, flight, requests, logs, forward: fn => { forward = fn; }, advance: value => { now = value; tick(); } };
}
function typedRequest() {
  return { t: 'perf-manual-request', version: 1, mainPid: process.pid,
    requestId: 'manual-' + process.pid + '-1234567890abcdef12345678', kind: 'manual',
    reason: 'native-help-before-gesture', durationMs: 10000, requestedWallMs: Date.now(),
    owner: { mainPid: process.pid, windowId: 7, webContentsId: 8, rendererPid: 123,
      frameProcessId: 4, frameRoutingId: 5, documentToken: '1234567890abcdef12345678' } };
}

test('actual manual admission preserves startup/active/stopped guards while removing daily and metadata cooldown limits', async t => {
  await t.test('warmup and duplicate', t => {
    const f = flightFixture(t);
    assert.equal(f.flight.requestManualCapture(typedRequest()).reason, 'startup-warmup');
    assert.equal(f.requests.length, 0);
    assert.equal(f.flight.requestManualCapture(typedRequest()).reason, 'startup-warmup');
  });
  await t.test('manual slot remains available after automatic quota exhaustion', t => {
    const f = flightFixture(t); f.advance(61000);
    for (let i = 0; i < 4; i++) {
      const name = 'incident-' + (100 + i) + '-1.capture.json';
      f.flight.artifacts.write(name, { kind: 'ui-action', group: 'responsiveness' });
    }
    const result = f.flight.requestManualCapture(typedRequest());
    assert.equal(result.allowed, true); assert.equal(result.group, 'manual');
    assert.equal(result.remaining, null); assert.equal(f.requests.length, 1);
    assert.equal(f.flight.artifacts.entries().filter(e => e.name.endsWith('.capture.json')).length, 5);
    f.advance(100000);
    assert.equal(f.flight.requestManualCapture(typedRequest()).allowed, true);
    assert.equal(f.requests.length, 2);
  });
  await t.test('same admission and new manual kind; duplicate cannot merge/adopt', t => {
    const f = flightFixture(t); f.advance(61000);
    const result = f.flight.requestManualCapture(typedRequest());
    assert.equal(result.allowed, true); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].kind, 'manual'); assert.equal(f.requests[0].reason, 'native-help-before-gesture');
    assert.equal(f.requests[0].t, undefined, 'cannot override watchdog capture tag');
    const receipt = JSON.parse(f.flight.artifacts.read(result.id + '.capture.json'));
    assert.equal(receipt.kind, 'manual'); assert.equal(receipt.group, 'manual');
    assert.equal(f.flight.requestManualCapture(typedRequest()).allowed, false); assert.equal(f.requests.length, 1);
    f.advance(82000);
    assert.equal(f.flight.requestManualCapture(typedRequest()).allowed, true);
    assert.equal(f.requests.length, 2);
    f.flight.stop(); assert.equal(f.flight.requestManualCapture(typedRequest()).reason, 'recorder-stopped');
  });
});

function profileFixture(t, options = {}) {
  const dir = directory(t), calls = [], timers = [], ready = [];
  const dbg = new EventEmitter(); let attached = false, startResolve;
  const profile = { nodes: [{ id: 1, callFrame: { functionName: 'fixture' } }], samples: [1], timeDeltas: [1000] };
  dbg.isAttached = () => attached;
  dbg.attach = () => { attached = true; calls.push('attach'); };
  dbg.detach = () => { calls.push('detach'); attached = false; dbg.emit('detach', {}, 'own-cleanup'); };
  dbg.sendCommand = async method => {
    calls.push(method);
    if (method === 'Profiler.start' && options.startPending) return new Promise(resolve => { startResolve = resolve; });
    if (method === 'Profiler.start' && options.startFailure) throw Error('Profiler.start:timeout');
    if (method === 'Profiler.start' && options.ownerLostAtStart) guard.lose();
    if (method === 'Tracing.start' && options.ownerLostAtTraceStart) guard.lose();
    if (method === 'Tracing.start' && options.replacedAtTraceStart) {
      guard.lose(); dbg.emit('detach', {}, 'replaced'); attached = true;
    }
    if (method === 'Tracing.end') dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 'own-stream', dataLossOccurred: !!options.dataLoss });
    if (method === 'Profiler.stop') return { profile: options.emptyCpu ? null : profile };
    if (method === 'IO.read') {
      if (options.ownerLostAtRead) { guard.lose(); return { data: ' '.repeat(2 * 1024 * 1024), eof: true }; }
      return { data: options.emptyTrace ? '' : '{"traceEvents":[]}', eof: true };
    }
    if (method === 'Runtime.evaluate') return { result: { value: { entries: [], observedCount: 0 } } };
    return {};
  };
  let current = true, invalidate;
  const guard = { isCurrent: () => current, current: () => ({ rendererPid: current ? 123 : 124 }),
    invalidated: new Promise(resolve => { invalidate = resolve; }), lose: () => { current = false; invalidate('lost'); } };
  class Session {
    connect() { calls.push('main-connect'); }
    post(method, _params, cb) { calls.push('main-' + method); cb(null, method === 'Profiler.stop' ? { profile } : {}); }
    disconnect() { calls.push('main-disconnect'); }
  }
  const inspector = { url: () => undefined, Session };
  const exports = load('perf-incident-profile.js', {}, {
    setTimeout: (fn, ms) => {
      if (ms !== 10000 && !(options.inputPreset && ms > 10000 && ms <= 40000)) return setTimeout(fn, ms);
      const timer = { fn, ms, cancelled: false }; timers.push(timer);
      if (!options.holdDuration) queueMicrotask(fn);
      return timer;
    }, clearTimeout: timer => { if (typeof timer?.ms === 'number') timer.cancelled = true; else clearTimeout(timer); },
  });
  const wc = { debugger: dbg, isDestroyed: () => false, isDevToolsOpened: () => false,
    getOSProcessId: () => 123, getZoomFactor: () => 1 };
  const durationMs = options.inputPreset ? 40000 : 10000;
  const request = { ...typedRequest(), durationMs, t: 'capture', id: 'incident-123-456', pid: 123 };
  return { dir, calls, ready, wc, guard, timers, exports, inspector,
    resolveStart: () => startResolve(),
    start: extra => exports.captureIncidentProfile({ request, directory: dir, webContents: wc, durationMs,
      ownerGuard: guard, inspector, log() {}, onReady: value => ready.push({ value, calls: calls.slice() }), ...extra }) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('actual recorder emits READY only after Profiler.start ACK and writes nonempty bounded files/status', async t => {
  const f = profileFixture(t, { startPending: true });
  const pending = f.start(); await flush();
  assert.ok(f.calls.includes('Profiler.start')); assert.equal(f.ready.length, 0);
  f.resolveStart(); const status = await pending;
  assert.equal(f.ready.length, 1); assert.equal(f.ready[0].value.rendererCpu, true);
  assert.equal(f.ready[0].value.mainCpu, true); assert.equal(f.ready[0].value.trace, true);
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].ms, 10000); assert.equal(f.timers[0].cancelled, true);
  assert.equal(status.outcome, 'completed'); assert.equal(status.ownerCurrent, true);
  for (const artifact of Object.values(status.artifacts)) {
    assert.equal(fs.statSync(artifact.file).size, artifact.bytes); assert.ok(artifact.bytes > 0 && artifact.bytes <= 16 * 1024 * 1024);
    assert.equal(fs.statSync(artifact.file).mode & 0o777, 0o600);
  }
  const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'incident-123-456.profile.json')));
  assert.equal(disk.kind, 'manual'); assert.equal(disk.requestId, typedRequest().requestId);
  assert.equal(disk.outcome, 'completed'); assert.ok(disk.readyWallMs >= disk.rendererStartedWallMs);
  assert.equal(f.calls.filter(x => x === 'detach').length, 1); assert.ok(f.calls.includes('IO.close'));
});

test('actual recorder rejects stale initial owner and non10s manual before opening any profiler', async t => {
  for (const mode of ['stale', 'duration']) {
    const f = profileFixture(t); if (mode === 'stale') f.guard.lose();
    const result = await f.start(mode === 'duration' ? { durationMs: 1 } : {});
    assert.equal(result.outcome, 'refused'); assert.deepEqual(f.calls, []); assert.equal(f.ready.length, 0);
  }
});

test('actual recorder loss after start never sends to replacement document, never READY/PASS; cleans own sessions', async t => {
  const f = profileFixture(t, { ownerLostAtStart: true });
  const result = await f.start();
  assert.equal(f.ready.length, 0); assert.equal(result.outcome, 'incomplete'); assert.equal(result.ownerCurrent, false);
  assert.ok(result.errors.includes('original-owner-lost'));
  assert.ok(!f.calls.includes('Tracing.start')); assert.equal(f.calls.filter(x => x === 'Profiler.stop').length, 1);
  assert.ok(f.calls.includes('main-Profiler.stop')); assert.ok(f.calls.includes('main-disconnect'));
  assert.equal(f.calls.filter(x => x === 'detach').length, 1);
});

test('owner invalidation cleans only the owned profiler, trace and stream', async t => {
  for (const option of ['ownerLostAtTraceStart', 'ownerLostAtRead', 'replacedAtTraceStart']) {
    const f = profileFixture(t, { [option]: true });
    const result = await f.start();
    assert.equal(result.outcome, 'incomplete');
    if (option === 'replacedAtTraceStart') {
      assert.ok(!f.calls.includes('Profiler.stop')); assert.ok(!f.calls.includes('Tracing.end'));
      assert.ok(!f.calls.includes('detach'));
    } else {
      assert.equal(f.calls.filter(x => x === 'Profiler.stop').length, 1);
      assert.equal(f.calls.filter(x => x === 'Tracing.end').length, 1);
      assert.equal(f.calls.filter(x => x === 'IO.close').length, 1);
      assert.equal(f.calls.filter(x => x === 'detach').length, 1);
    }
    assert.ok(!f.calls.includes('Runtime.evaluate'));
  }
});

test('actual recorder owns one inflight and lifetime abort clears duration timer and releases admission', async t => {
  const f = profileFixture(t, { holdDuration: true }); const pending = f.start();
  await flush(); assert.equal(f.ready.length, 1);
  const duplicate = await f.start({ request: { ...typedRequest(), id: 'incident-124-456', kind: 'manual' } });
  assert.equal(duplicate.outcome, 'refused'); assert.ok(duplicate.errors.includes('capture-in-flight'));
  f.guard.lose(); const result = await pending;
  assert.equal(result.outcome, 'incomplete'); assert.equal(f.timers[0].cancelled, true);
  const next = profileFixture(t); const result2 = await next.start(); assert.equal(result2.outcome, 'completed');
});

test('actual recorder never calls incomplete/empty/lost trace a completed manual capture', async t => {
  for (const options of [{ dataLoss: true }, { emptyTrace: true }, { emptyCpu: true }, { startFailure: true }]) {
    const f = profileFixture(t, options); const result = await f.start();
    assert.equal(result.outcome, 'incomplete');
    if (options.emptyTrace) { assert.equal(result.traceComplete, false); assert.ok(result.errors.includes('trace-export-empty')); }
    if (options.startFailure) assert.equal(f.ready.length, 0);
    assert.equal(f.calls.filter(x => x === 'detach').length, 1); assert.ok(f.calls.includes('main-disconnect'));
  }
});

test('status save failure cannot report completed and preserves the preexisting file', async t => {
  const f = profileFixture(t);
  const statusFile = path.join(f.dir, 'incident-123-456.profile.json');
  fs.writeFileSync(statusFile, 'preserve');
  const result = await f.start();
  assert.equal(result.outcome, 'failed-status-save'); assert.ok(result.errors.some(x => x.includes('EEXIST')));
  assert.equal(fs.readFileSync(statusFile, 'utf8'), 'preserve');
  assert.equal(f.calls.filter(x => x === 'detach').length, 1);
});

for (const durationMs of [10000, 40000]) test('SOURCE menu/Main/watchdog route manual' + durationMs + ' through actual recorder', async t => {
  const f = flightFixture(t); f.advance(61000);
  const child = new EventEmitter(), watchdogProcess = new EventEmitter(); child.connected = true;
  const profilePort = profileFixture(t, { inputPreset: durationMs === 40000 });
  const wc = new EventEmitter(), win = new EventEmitter();
  Object.assign(wc, profilePort.wc, { id: 8, mainFrame: { processId: 4, routingId: 5, osProcessId: 123 },
    isDestroyed: () => false, isLoadingMainFrame: () => false, getOSProcessId: () => 123 });
  Object.assign(win, { id: 7, webContents: wc, isDestroyed: () => false });
  const logs = [], captures = [], counters = { resume: 0, suspend: 0 };
  let completion;
  class Menu { constructor() { this.items = []; } append(item) { this.items.push(item); } }
  class MenuItem { constructor(data) { Object.assign(this, data); if (Array.isArray(data.submenu)) this.submenu = new Menu(); } }
  let menu = new Menu();
  Menu.getApplicationMenu = () => menu; Menu.setApplicationMenu = value => { menu = value; };
  child.send = (message, cb) => { watchdogProcess.emit('message', message); cb?.(null); };
  watchdogProcess.send = message => child.emit('message', message);
  const scope = vm.createContext({ process, path, srcMainDir: __dirname, mainLogPath: path.join(path.dirname(f.dir), 'production.log'),
    ipcMain: {}, app: {}, isolatedPerfDiagnostics: false, perfCausal: {},
    perfWatchdog: child, BrowserWindow: { fromId: id => id === 7 ? win : undefined,
      getAllWindows: () => { throw Error('manual must not use fallback window inventory'); } },
    Menu, require: file => file === 'electron' ? { MenuItem } : file.endsWith('perf-incident-profile.js') ? { captureIncidentProfile: args => {
      captures.push(args);
      return completion = profilePort.exports.captureIncidentProfile({ ...args, inspector: profilePort.inspector });
    } } : file.endsWith('perf-manual-capture.js') ? manual : require(file),
    counters, originalWindow: win, console: { warn: line => logs.push(line) } });
  vm.runInContext(body('main.js', 'const perfNativeMonitors = new Map();', 'function ensureNativePerfMonitor'), scope);
  vm.runInContext('perfNativeMonitors.set(8, { suspend() { counters.suspend++; return () => { counters.resume++; }; } });', scope);
  vm.runInContext(body('main.js', 'const captureWatchdog = perfWatchdog;', '    let contextDueAt = 0;'), scope);
  const wdScope = vm.createContext({ process: watchdogProcess, MAIN_PID: process.pid, flight: f.flight,
    lameDuck: false, wdLog: line => logs.push(line),
    require: name => { assert.equal(name, './perf-manual-capture'); return manual; } });
  vm.runInContext(body('perf-watchdog.js', "process.on('message', (m) => {", '// Main and the standalone'), wdScope);
  const forward = vm.runInContext('({' + body('perf-watchdog.js', 'requestCapture: (request) => {', '    },\n  });')
    + '}}).requestCapture', wdScope);
  f.forward(forward);
  vm.runInContext(body('main.js', '  installManualCaptureMenu({ Menu,', '\n\n'), scope);
  assert.equal(menu.items.length, 1); assert.equal(menu.items[0].submenu.items.length, 2);
  const click = menu.items[0].submenu.items[durationMs === 40000 ? 1 : 0].click;
  assert.equal(click(null, win), true);
  await flush(); // The global native-observer retirement is now awaited before capture.
  assert.ok(completion, 'capture starts after all native observers release their owned channels');
  const captureResult = await completion;
  assert.equal(captureResult.outcome, 'completed', JSON.stringify({ errors: captureResult.errors,
    projection: captureResult.traceProjection }));
  await flush();
  assert.equal(f.requests.length, 1); assert.equal(captures.length, 1);
  assert.equal(captures[0].webContents, wc); assert.equal(captures[0].durationMs, durationMs);
  assert.equal(captures[0].request.t, 'capture'); assert.equal(captures[0].request.kind, 'manual');
  assert.equal(captures[0].ownerGuard.owner.webContentsId, 8);
  assert.equal(counters.suspend, 1); assert.equal(counters.resume, 1);
  assert.ok(logs.some(x => x.includes('"state":"ready"')));
  assert.ok(logs.some(x => x.includes('"state":"finished"')));
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, f.requests[0].id + '.profile.json')));
  assert.equal(saved.outcome, 'completed'); assert.equal(saved.ownerCurrent, true);
  assert.equal(fs.statSync(saved.artifacts.trace.file).size, saved.artifacts.trace.bytes);
  child.emit('message', { t: 'capture', ...f.requests[0] }); await flush();
  assert.equal(captures.length, 1, 'consumed reply is not replayed');
  assert.equal(wc.listenerCount('did-start-navigation'), 0);
  // A second native click is a NEW request, and gets the unchanged active
  // incident rejection. It cannot silently adopt the first capture.
  click(null, win); await flush();
  assert.equal(f.requests.length, 1); assert.equal(captures.length, 1);
  assert.ok(logs.some(x => x.includes('merged-into-active-incident')));
});
