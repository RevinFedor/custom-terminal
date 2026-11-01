'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cpuFrame, systemCpu, summarizeFrames, createArtifactStore, captureDecision } = require('./perf-flight-recorder');

const proc = (pid, cpuNs, extra = {}) => ({ pid, ppid: 1, startedAtTicks: '10', cpuNs,
  name: 'process', footprintBytes: 1048576, ...extra });
test('same interval distinguishes app, PTY descendant and external CPU; omits raw arguments', () => {
  const before = { processes: [proc(10, 0), proc(20, 0), proc(21, 0), proc(30, 0)] };
  const after = { processes: [proc(10, 1e9), proc(20, 1e8, { ppid: 10 }),
    proc(21, 2e8, { ppid: 20, commandLine: 'SECRET', execPath: '/private/SECRET' }), proc(30, 6e9, { name: 'OrbStack' })] };
  const frame = cpuFrame(before, after, 2000, [{ pid: 10, type: 'Browser' }], [{ pid: 20, tabId: 'tab-1' }], 10);
  assert.equal(frame.appCpu, 50); assert.equal(frame.tabCpu, 15);
  assert.equal(frame.rows.find(p => p.pid === 30).cpu, 300);
  assert.equal(frame.rows.find(p => p.pid === 21).tabId, 'tab-1');
  assert.ok(!JSON.stringify(frame).includes('SECRET'));
});
test('first sample and PID reuse with a LARGER counter are unknown, not 0 or false CPU', () => {
  const before = { processes: [proc(10, 1e9), proc(11, 1e9)] };
  const after = { processes: [proc(10, 2e9, { startedAtTicks: '11' }), proc(11, 0), proc(12, 9e9)] };
  assert.deepEqual(cpuFrame(before, after, 1000, [], [], 100).rows, []);
  assert.deepEqual(cpuFrame(null, after, 1000, [], [], 100).rows, []);
});
test('normalized CPU keeps its provenance in frames/checkpoints without scaling twice', () => {
  const normalization = { sourceUnit: 'mach-ticks', outputUnit: 'nanoseconds', numer: 125, denom: 3 };
  const before = { processes: [proc(10, 0)] };
  const after = { processes: [proc(10, 1e9)], cpuTimeNormalization: normalization };
  const frame = { ...cpuFrame(before, after, 1000, [], [], 10), wallMs: 1000, elapsedMs: 1000,
    systemBusy: 10, probeMs: 1, observerGapMs: 0 };
  assert.equal(frame.appCpu, 100);
  assert.deepEqual(frame.cpuTimeNormalization, normalization);
  const summary = summarizeFrames([frame]);
  assert.equal(summary.appPeak, 100);
  assert.deepEqual(summary.cpuTimeNormalization, normalization);
});
test('system busy uses all-core delta and rejects a reset/topology change', () => {
  const cpu = (user, idle) => ({ times: { user, idle, sys: 0, nice: 0, irq: 0 } });
  assert.equal(systemCpu([cpu(0, 0), cpu(0, 0)], [cpu(100, 0), cpu(0, 100)]), 50);
  assert.equal(systemCpu([cpu(100, 0)], [cpu(0, 100)]), null);
  assert.equal(systemCpu([], [cpu(0, 0)]), null);
});
test('CPU ownership keeps Electron, its helpers, tab processes and unrelated Docker separate', () => {
  const before = { processes: [proc(10,0),proc(11,0,{ppid:10}),proc(20,0,{ppid:10}),proc(30,0,{name:'Docker'})] };
  const after = { processes: [proc(10,2e8),proc(11,4e8,{ppid:10}),proc(20,6e8,{ppid:10}),proc(30,8e8,{name:'Docker'})] };
  const frame = cpuFrame(before,after,1000,[{pid:10,type:'Browser'}],[{pid:20,tabId:'tab'}],10);
  assert.equal(frame.appCpu,20);assert.equal(frame.appChildCpu,40);assert.equal(frame.tabCpu,60);assert.equal(frame.externalCpu,80);
  const summary=summarizeFrames([{...frame,wallMs:1000,elapsedMs:1000,cores:8,systemBusy:25,probeMs:1,observerGapMs:0}]);
  assert.equal(summary.ownerGroups.externalCpu.peakCpu,80);assert.equal(summary.cores,8);
  assert.equal(summary.ownerGroups.appCpu.meanCpu,20);
});
test('checkpoint preserves burst BETWEEN flushes and observed identity coverage', () => {
  const frames = [10, 300, 20].map((cpu, i) => ({ wallMs: 2000 * (i + 1), elapsedMs: 2000,
    systemBusy: 50, appCpu: cpu, probeMs: 4, observerGapMs: 0,
    rows: [{ pid: 10, identity: 'a', cpu, owner: 'app' }] }));
  const result = summarizeFrames(frames);
  assert.equal(result.rows[0].peakCpu, 300); assert.equal(result.rows[0].meanCpu, 110);
  assert.equal(result.rows[0].observedMs, 6000); assert.equal(result.from, 0); assert.equal(result.to, 6000);
});
test('capture quota is rolling and survives a new recorder; retention touches only owned regular files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-flight-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const name = 'incident-' + (now - 7200000 + i * 700000) + '-1.capture.json';
    store.write(name, {});
    fs.utimesSync(store.file(name), new Date(now - 7200000 + i * 700000), new Date(now - 7200000 + i * 700000));
  }
  const reloaded = createArtifactStore(dir);
  assert.equal(reloaded.reserveCapture('incident-' + now + '-1', now), false);
  assert.equal(reloaded.reserveCapture('incident-' + (now + 86400000) + '-1', now + 86400000), true);
  assert.throws(() => store.file('../secret'));
  fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'keep');
  store.write('incident-1-1.main.cpuprofile', {});
  store.write('incident-1-1.ui.json', { animations: [] });
  const old = new Date(now - 8 * 86400000);
  fs.utimesSync(store.file('incident-1-1.main.cpuprofile'), old, old);
  fs.utimesSync(store.file('incident-1-1.ui.json'), old, old);
  fs.symlinkSync(path.join(dir, 'user-notes.txt'), store.file('incident-2-1.json'));
  store.prune(now);
  assert.equal(fs.existsSync(store.file('incident-1-1.main.cpuprofile')), false);
  assert.equal(fs.existsSync(store.file('incident-1-1.ui.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'user-notes.txt'), 'utf8'), 'keep');
  assert.throws(() => store.write('incident-2-1.json', {}));
});
test('passive renderer diagnostics never hit-test, read computed style or scan the hover tree', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils/perfFreezeProbe.ts'), 'utf8');
  assert.doesNotMatch(source, /document\.elementFromPoint\s*\(|window\.getComputedStyle\s*\(|querySelectorAll\(['"]:hover/);
  assert.match(source, /targetEvidence=event/);
  assert.match(source, /createPerfSocketWriter/);
  const transport = fs.readFileSync(path.join(__dirname, '../renderer/utils/perfIncidentChannel.ts'), 'utf8');
  assert.match(transport, /writableLength >= 16384/);
});

test('ambient CPU cannot consume the two responsiveness slots; skip reason and expiry are exact', () => {
  const now = 86400000;
  const background = [{ at: now - 1200000, group: 'background' }, { at: now - 600001, group: 'background' }];
  assert.equal(captureDecision(background, now, 'sustained-cpu').reason, 'reserved-for-responsiveness');
  assert.equal(captureDecision(background, now, 'ui-click').allowed, true);
  const recent = [...background, { at: now - 1000, group: 'responsiveness' }];
  const cooldown = captureDecision(recent, now, 'ui-click');
  assert.equal(cooldown.reason, 'capture-group-cooldown'); assert.equal(cooldown.nextEligibleWallMs, now + 599000);
  recent.push({ at: now - 2000, group: 'responsiveness' });
  assert.equal(captureDecision(recent, now, 'ui-click').reason, 'rolling-quota-exhausted');
});
test('system load without an Electron hotspot does not waste a background profile or suppress a real UI stall', () => {
  const pressure = { appCpu: 10, appChildCpu: 3, externalCpu: 750, systemBusy: 98 };
  assert.equal(captureDecision([], Date.now(), 'sustained-cpu', pressure).reason, 'system-pressure-no-electron-hotspot');
  assert.equal(captureDecision([], Date.now(), 'ui-click', pressure).allowed, true);
  assert.equal(captureDecision([], Date.now(), 'sustained-cpu', { ...pressure, appCpu: 150 }).allowed, true);
});

test('repeated manual requests retain distinct receipts across reload without refunding exhausted auto quota', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-manual-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const name = 'incident-' + (now - 7200000 + i * 700000) + '-1.capture.json';
    store.write(name, { group: 'responsiveness' });
    fs.utimesSync(store.file(name), new Date(now - 7200000 + i * 700000), new Date(now - 7200000 + i * 700000));
  }
  assert.equal(store.reserveCaptureDetails('incident-' + now + '-1', now, 'ui-click').reason, 'rolling-quota-exhausted');
  const saved = new Map(store.entries().map(e => [e.name, store.read(e.name)]));
  for (let i = 0; i < 5; i++) {
    const reloaded = createArtifactStore(dir), id = 'incident-' + (now + i) + '-2';
    const decision = reloaded.reserveCaptureDetails(id, now + i, 'manual');
    assert.equal(decision.allowed, true); assert.equal(decision.group, 'manual');
    assert.equal(decision.remaining, null, 'manual has no daily slot counter');
    assert.deepEqual(JSON.parse(reloaded.read(id + '.capture.json')),
      { requestedAt: now + i, kind: 'manual', group: 'manual' });
    saved.set(id + '.capture.json', reloaded.read(id + '.capture.json'));
    reloaded.prune(now + i);
    for (const [name, bytes] of saved) assert.equal(reloaded.read(name), bytes);
    assert.equal(reloaded.reserveCaptureDetails('incident-' + (now + i) + '-3', now + i, 'ui-click').reason,
      'rolling-quota-exhausted');
  }
  const reloaded = createArtifactStore(dir), first = 'incident-' + now + '-2';
  const priorStat = fs.statSync(reloaded.file(first + '.capture.json'));
  assert.throws(() => reloaded.reserveCaptureDetails(first, now + 100, 'manual'), { code: 'EEXIST' });
  assert.equal(reloaded.read(first + '.capture.json'), saved.get(first + '.capture.json'));
  assert.equal(fs.statSync(reloaded.file(first + '.capture.json')).mtimeMs, priorStat.mtimeMs);
  assert.equal(reloaded.entries().filter(e => e.name.endsWith('.capture.json')).length, 9);
});

test('manual receipt neither consumes nor renews automatic responsiveness slots', () => {
  const now = 86400000, manual = { at: now - 1, group: 'manual' };
  assert.equal(captureDecision([manual], now, 'ui-click').remaining, 3);
  const old = { at: now - 2000, group: 'responsiveness' };
  assert.equal(captureDecision([old, manual], now, 'ui-click').nextEligibleWallMs, old.at + 600000);
  assert.equal(captureDecision([{}, {}, {}, {}, manual], now, 'ui-click').allowed, false);
  assert.equal(captureDecision([{ at: now - 1 }], now, 'manual').allowed, true);
});

test('artifact reservations still enforce background2/day and auto4/day after repeated manual captures', t => {
  const { store, now } = artifactFixture(t);
  for (let i = 0; i < 5; i++)
    assert.equal(store.reserveCaptureDetails('incident-' + (now + i) + '-2', now + i, 'manual').allowed, true);
  function automatic(at, kind) {
    const id = 'incident-' + at + '-1';
    const decision = store.reserveCaptureDetails(id, at, kind);
    if (decision.allowed) fs.utimesSync(store.file(id + '.capture.json'), new Date(at), new Date(at));
    return decision;
  }
  assert.equal(automatic(now - 2100000, 'sustained-cpu').allowed, true);
  assert.equal(automatic(now - 1400000, 'sustained-cpu').allowed, true);
  assert.equal(automatic(now, 'sustained-cpu').reason, 'reserved-for-responsiveness');
  assert.equal(automatic(now - 700000, 'ui-click').allowed, true);
  assert.equal(automatic(now, 'ui-click').allowed, true);
  assert.equal(automatic(now + 700000, 'ui-click').reason, 'rolling-quota-exhausted');
  assert.equal(store.entries().filter(e => e.name.endsWith('.capture.json')).length, 9);
});

// Execute the actual recorder and artifact store with only clocks, scheduling,
// process/pressure sampling and the capture callback replaced. All incident and
// capture receipts below are real filesystem writes; no live profiler is run.
function flightFixture(t, warm = true) {
  const vm = require('node:vm');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-flight-manual-'));
  let wall = Date.now(), mono = 0, pending, requestSequence = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wall])); }
    static now() { return wall; }
  }
  const mod = { exports: {} }, captures = [], logs = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'perf-flight-recorder.js'), 'utf8'), {
    module: mod, exports: mod.exports, process: { pid: 12345 }, Date: ClockDate, Buffer,
    require: name => name === 'perf_hooks' ? { performance: { now: () => mono, timeOrigin: wall } }
      : name === 'os' ? { cpus: () => [{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }], loadavg: () => [0,0,0] }
      : require(name),
    setTimeout: fn => (pending = { fn, unref() {} }),
    clearTimeout: timer => { if (pending === timer) pending = null; },
  }, { filename: path.join(__dirname, 'perf-flight-recorder.js') });
  const flight = mod.exports.createFlightRecorder({ directory, mainPid: 42,
    log: line => logs.push(line), requestCapture: request => captures.push(request),
    context: () => ({ appPids: [], tabs: [], owner: 'original-context' }),
    snapshot: () => ({ ok: true, processes: [], skipped: 0 }),
    pressure: () => ({ sampledAt: wall, available: false, reason: 'fixture' }),
  });
  const advance = ms => { wall += ms; mono += ms; };
  if (warm) advance(60001);
  t.after(() => { flight.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const read = id => JSON.parse(flight.artifacts.read(id + '.json', 65536));
  const ids = () => flight.artifacts.entries().filter(e => /^incident-\d+-\d+\.json$/.test(e.name))
    .map(e => e.name.slice(0, -5));
  function exhaustAuto() {
    for (let i = 0; i < 4; i++) {
      const at = wall - 7200000 + i * 700000, name = 'incident-' + at + '-1.capture.json';
      flight.artifacts.write(name, { requestedAt: at, kind: 'ui-click', group: 'responsiveness' });
      fs.utimesSync(flight.artifacts.file(name), new Date(at), new Date(at));
    }
  }
  const request = () => {
    const token = (++requestSequence).toString(16).padStart(24, '0');
    return { version: 1, requestId: 'manual-42-' + token, mainPid: 42,
      owner: { mainPid: 42, windowId: 3, webContentsId: 4, rendererPid: 43,
        frameProcessId: 5, frameRoutingId: 6, documentToken: token },
      reason: 'native-help-before-gesture', durationMs: 10000 };
  };
  return { flight, captures, logs, advance, tick: () => pending.fn(), read, ids, exhaustAuto,
    manual: () => flight.requestManualCapture(request()), now: () => wall };
}

test('manual early-ends only metadata, keeps its events and creates a distinct ID in the same millisecond', t => {
  const h = flightFixture(t); h.exhaustAuto();
  h.flight.incident('ui-click', { owner: { rendererPid: 99 }, actionId: 'original-action' });
  h.flight.incident('ui-lag', { actionId: 'second-action' });
  const [oldId] = h.ids(), before = h.read(oldId);
  assert.equal(before.capture.requested, false); assert.equal(h.captures.length, 0);
  const manual = h.manual();
  assert.equal(manual.allowed, true); assert.notEqual(manual.id, oldId);
  const ended = h.read(oldId), own = h.read(manual.id);
  assert.equal(ended.state, 'early-ended'); assert.equal(ended.complete, false);
  assert.equal(ended.endReason, 'explicit-manual-request'); assert.equal(ended.endedWallMs, h.now());
  assert.equal(ended.completedWallMs, undefined);
  assert.deepEqual(ended.events, before.events); assert.deepEqual(ended.frames, before.frames);
  assert.deepEqual(ended.context, before.context);
  assert.equal(own.events.length, 1); assert.equal(own.events[0].kind, 'manual');
  assert.equal(own.events[0].owner.rendererPid, 43); assert.equal(own.events[0].actionId, undefined);
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].id, manual.id);
  h.advance(20001); h.tick(); h.flight.stop();
  assert.deepEqual(h.read(oldId), ended, 'later tick/stop must not mark the shortened window complete');
  assert.equal(h.read(manual.id).complete, true, 'the separate full metadata window still completes normally');
});

test('metadata-only incident cooldown still blocks auto but not a new explicit manual request', t => {
  const h = flightFixture(t); h.exhaustAuto();
  h.flight.incident('ui-click', { actionId: 'old' }); const [oldId] = h.ids();
  h.advance(20001); h.tick();
  assert.equal(h.read(oldId).complete, true);
  h.flight.incident('ui-click', { actionId: 'cooldown' });
  assert.deepEqual(h.ids(), [oldId]);
  assert.ok(h.logs.some(line => line.includes('incident-window-cooldown')));
  const manual = h.manual(); assert.equal(manual.allowed, true); assert.notEqual(manual.id, oldId);
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].kind, 'manual');
});

for (const kind of ['ui-click', 'manual']) test('active requested ' + kind + ' capture cannot be interrupted or adopted by manual', t => {
  const h = flightFixture(t);
  const id = kind === 'manual' ? h.manual().id : h.flight.incident(kind, { actionId: 'original' });
  const before = h.read(id), receipt = h.flight.artifacts.read(id + '.capture.json');
  const refused = h.manual();
  assert.equal(refused.allowed, false); assert.equal(refused.incident, id);
  assert.equal(refused.reason, 'merged-into-active-incident');
  assert.deepEqual(h.ids(), [id]); assert.deepEqual(h.read(id), before);
  assert.equal(h.flight.artifacts.read(id + '.capture.json'), receipt);
  assert.equal(h.captures.length, 1);
});

test('actual flight permits repeated completed manual captures within the same day and retains all receipts', t => {
  const h = flightFixture(t), saved = new Map();
  for (let i = 0; i < 3; i++) {
    const result = h.manual(); assert.equal(result.allowed, true); assert.equal(saved.has(result.id), false);
    saved.set(result.id, h.flight.artifacts.read(result.id + '.capture.json'));
    h.advance(20001); h.tick();
    assert.equal(h.read(result.id).complete, true);
  }
  assert.equal(h.captures.length, 3);
  assert.equal(new Set(h.captures.map(c => c.requestId)).size, 3, 'these are separate explicit requests');
  for (const [id, receipt] of saved) assert.equal(h.flight.artifacts.read(id + '.capture.json'), receipt);
  assert.equal(h.flight.artifacts.reserveCaptureDetails('incident-' + h.now() + '-8', h.now(), 'ui-click').remaining, 3);
});

test('startup warmup remains a refusal even when manual replaces an uncaptured metadata window', t => {
  const h = flightFixture(t, false);
  h.flight.incident('ui-click'); const [oldId] = h.ids();
  const result = h.manual(); assert.equal(result.allowed, false); assert.equal(result.reason, 'startup-warmup');
  assert.notEqual(result.id, oldId); assert.equal(h.read(oldId).complete, false);
  assert.equal(h.captures.length, 0);
  assert.equal(h.flight.artifacts.entries().some(e => e.name.endsWith('.capture.json')), false);
});

test('failure to preserve the ended metadata refuses manual without losing the active window', t => {
  const h = flightFixture(t); h.exhaustAuto(); h.flight.incident('ui-click');
  const [oldId] = h.ids(), before = h.read(oldId), originalWrite = h.flight.artifacts.write;
  h.flight.artifacts.write = (name, value, ...args) => {
    if (name === oldId + '.json' && value.state === 'early-ended') throw Error('fixture-disk-failure');
    return originalWrite(name, value, ...args);
  };
  const refused = h.manual(); assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'metadata-window-persist-failed');
  assert.deepEqual(h.ids(), [oldId]); assert.deepEqual(h.read(oldId), before); assert.equal(h.captures.length, 0);
  h.flight.artifacts.write = originalWrite;
  assert.equal(h.manual().allowed, true);
});

function artifactFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-artifacts-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createArtifactStore(directory), now = Date.now();
  const sparse = (name, bytes, at) => {
    const fd = store.openExclusive(name);
    try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
    fs.utimesSync(store.file(name), new Date(at), new Date(at));
  };
  return { directory, store, now, sparse };
}

test('artifact entries and bounded read/exclusive receipt API reject unknown paths and symlinks', t => {
  const { directory, store } = artifactFixture(t);
  const id = 'stall-1000-321-1';
  for (const extension of ['.sample.txt', '.sample.json', '.sample-capture.json']) store.write(id + extension, 'evidence');
  store.write('causal-2026100912.ndjson', '{}\n', true);
  fs.writeFileSync(path.join(directory, 'user-data'), 'untouched');
  fs.symlinkSync(path.join(directory, 'user-data'), store.file('stall-1000-321-2.sample.txt'));
  fs.mkdirSync(store.file('stall-1000-321-3.sample.txt'));
  assert.equal(store.entries().length, 4);
  assert.equal(store.read(id + '.sample.txt'), 'evidence');
  assert.throws(() => store.read(id + '.sample.txt', 2), /read/);
  assert.throws(() => store.read('stall-1000-321-2.sample.txt'));
  assert.throws(() => store.read('stall-1000-321-3.sample.txt'));
  assert.throws(() => store.openExclusive('stall-1000-321-2.sample.txt'));
  assert.throws(() => store.file('../stall-1000-321-1.sample.txt'));
  assert.throws(() => store.file('user-data'));
  store.writeExclusive('stall-1000-321-4.sample-capture.json', { version: 1 });
  assert.throws(() => store.writeExclusive('stall-1000-321-4.sample-capture.json', 'replace'));
  assert.deepEqual(JSON.parse(store.read('stall-1000-321-4.sample-capture.json')), { version: 1 });
  store.prune(Date.now() + 8 * 86400000);
  assert.equal(fs.readFileSync(path.join(directory, 'user-data'), 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(store.file('stall-1000-321-2.sample.txt')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(store.file('stall-1000-321-3.sample.txt')).isDirectory(), true);
});

test('5GiB pruning evicts large artifacts without refunding either current quota', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000;
  const receipt = 'stall-' + (now - 1000) + '-123-1.sample-capture.json';
  // Even an old mtime cannot evict a newly named immutable native receipt.
  sparse(receipt, 128, now - 8 * day);
  for (let i = 0; i < 4; i++) sparse('incident-' + (now - 7200000 + i * 700000) + '-1.capture.json', 128, now - 7200000 + i * 700000);
  sparse('stall-' + now + '-123-1.sample.txt', 6 * 1024 * 1024 * 1024, now - 180000);
  const pruned = store.prune(now);
  assert.ok(pruned.bytes < 5 * 1024 * 1024 * 1024);
  assert.equal(fs.existsSync(store.file(receipt)), true);
  assert.equal(store.entries().filter(e => e.name.endsWith('.capture.json')).length, 4);
  assert.equal(createArtifactStore(store.directory).reserveCaptureDetails('incident-' + now + '-1', now).reason, 'rolling-quota-exhausted');
});

test('native receipts and detailed sample metadata/full report expire at 24h', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000;
  const id = 'stall-' + (now - day - 1) + '-123-1';
  for (const extension of ['.sample.txt', '.sample.json', '.sample-capture.json']) sparse(id + extension, 100, now - day - 1);
  store.prune(now);
  assert.equal(fs.existsSync(store.file(id + '.sample-capture.json')), false);
  assert.equal(fs.existsSync(store.file(id + '.sample.txt')), false);
  assert.equal(fs.existsSync(store.file(id + '.sample.json')), false);
  assert.deepEqual(store.entries(), []);
});

test('old incident metadata cannot erase every freshly captured native stack under the same global cap', t => {
  const { store, now, sparse } = artifactFixture(t), miB = 1048576;
  for (let i = 0; i < 1281; i++) sparse('incident-' + (now - 4 * 3600000 - i) + '-1.json', 4 * miB, now - 4 * 3600000 - i);
  const id = 'stall-' + (now - 180000) + '-123-1';
  sparse(id + '.sample.txt', miB, now - 180000);
  store.write(id + '.sample.json', { id, status: 'complete', output: { file: id + '.sample.txt', complete: true } });
  const after = store.prune(now);
  assert.ok(after.bytes <= 5 * 1024 * miB);
  assert.equal(fs.existsSync(store.file(id + '.sample.txt')), true, 'the recent stack remains useful beyond its two-minute write grace');
});

test('causal journals retain 24h and may borrow unused space beyond their protected share', t => {
  const { store, now, sparse } = artifactFixture(t), hour = 3600000, miB = 1048576;
  const bucket = at => 'causal-' + new Date(at).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
  const expired = bucket(now - 24 * hour), recent = bucket(now - 23 * hour);
  sparse(expired, 1024, now - 24 * hour); sparse(recent, 1024, now - 23 * hour);
  store.prune(now);
  assert.equal(fs.existsSync(store.file(expired)), false); assert.equal(fs.existsSync(store.file(recent)), true);
  fs.unlinkSync(store.file(recent));
  const names = Array.from({ length: 17 }, (_, i) => bucket(now - i * hour));
  // These journals use the shared 5GiB budget rather than being deleted at
  // 64MiB while the rest of that budget is empty. Sparse files allocate no data.
  names.forEach((name, i) => sparse(name, 4 * miB, now - i * 1000));
  const after = store.prune(now);
  assert.equal(after.causalBytes, 68 * miB);
  assert.equal(fs.existsSync(store.file(names.at(-1))), true);
  assert.equal(fs.existsSync(store.file(names[0])), true);
});

test('native reports may borrow the shared budget; heavy expiry records loss without refunding quota', t => {
  const { store, now, sparse } = artifactFixture(t), miB = 1048576;
  const ids=Array.from({length:9},(_,i)=>'stall-'+(now-7200000-i*900000)+'-123-'+i);
  for(const [i,id] of ids.entries()){
    sparse(id+'.sample.txt',8*miB,now-7200000-i*900000);
    store.write(id+'.sample.json',{id,status:'complete',output:{file:id+'.sample.txt',complete:true}});
    store.writeExclusive(id+'.sample-capture.json',{version:1,id,requestedWallMs:now-7200000-i*900000});
  }
  const after=store.prune(now);
  assert.equal(after.nativeSampleBytes,72*miB);
  assert.equal(fs.existsSync(store.file(ids.at(-1)+'.sample.txt')),true);
  const old=new Date(now-86400000-1);
  fs.utimesSync(store.file(ids.at(-1)+'.sample.txt'),old,old);
  store.prune(now);
  const metadata=JSON.parse(store.read(ids.at(-1)+'.sample.json'));
  assert.equal(metadata.status,'complete');assert.equal(metadata.output.retained,false);
  assert.equal(metadata.output.removalReason,'heavy-retention-expired');
  assert.equal(store.entries().filter(e=>e.name.endsWith('.sample-capture.json')).length,9);
});

test('profiles, traces and detailed reports expire at 24h; only small CPU checkpoints retain one week', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000;
  const profiles=['incident-1000-1.main.cpuprofile','incident-1000-1.cpuprofile','incident-1000-1.trace.json'];
  store.write('incident-1000-1.profile.json',{traceComplete:true,mainStoppedWallMs:now-day-1});
  for(const name of profiles)sparse(name,100,now-day-1);
  sparse('incident-1001-1.ui.json',8*1048576,now-day-1);
  sparse('incident-1002-1.main.cpuprofile',100,now-day+1);
  sparse('stall-1000-1-1.sample.txt',100,now-day-1);
  sparse('incident-1000-1.json',100,now-day-1);
  sparse('incident-1003-1.ui.json',100,now-day-1);
  sparse('incident-1004-1.ui.json',100,now-day+1);
  sparse('cpu-2026101600.ndjson',100,now-7*day-1);
  sparse('cpu-2026101601.ndjson',100,now-7*day+1);
  store.prune(now);
  for(const name of profiles)assert.equal(fs.existsSync(store.file(name)),false);
  assert.equal(fs.existsSync(store.file('incident-1001-1.ui.json')),false);
  for(const name of ['incident-1002-1.main.cpuprofile','incident-1000-1.profile.json','incident-1004-1.ui.json','cpu-2026101601.ndjson'])
    assert.equal(fs.existsSync(store.file(name)),true);
  for(const name of ['stall-1000-1-1.sample.txt','incident-1003-1.ui.json','cpu-2026101600.ndjson'])
    assert.equal(fs.existsSync(store.file(name)),false);
  const metadata=JSON.parse(store.read('incident-1000-1.profile.json'));
  assert.equal(metadata.traceComplete,true);
  for(const name of profiles)assert.equal(metadata.artifactRetention[name].removalReason,'heavy-retention-expired');
  assert.equal(fs.existsSync(store.file('incident-1000-1.json')),false);
});

test('causal append has an explicit hourly byte bound and preserves existing complete lines on overload', t => {
  const { store, now } = artifactFixture(t);
  const bucket = 'causal-' + new Date(now).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
  const body = 'x'.repeat(4 * 1024 * 1024 - 1) + '\n';
  store.write(bucket, body, true);
  assert.throws(() => store.write(bucket, '{}\n', true), /bucket full/);
  assert.equal(fs.statSync(store.file(bucket)).size, Buffer.byteLength(body));
  assert.throws(() => store.read(bucket), /read/);
});

for(const pool of ['causal','native'])test(pool+' 65MiB pool cannot fall to 61MiB when ordinary metadata can satisfy pressure', t=>{
  const {store,now,sparse}=artifactFixture(t),miB=1048576;
  for(let i=0;i<17;i++){
    const name=pool==='native'?'stall-'+(now-14400000-i)+'-123-'+i+'.sample.txt'
      :'causal-202610'+String(i+1).padStart(2,'0')+'00.ndjson';
    sparse(name,(i===16?1:4)*miB,i===16?now-3600000:now-14400000-i);
  }
  for(let i=0;i<1264;i++)sparse('incident-'+(now-7200000-i)+'-1.json',4*miB,now-7200000-i);
  const result=store.prune(now);
  assert.equal(pool==='native'?result.nativeSampleBytes:result.causalBytes,65*miB);
  assert.ok(result.bytes<=5*1024*miB);
});

test('input payload shares the same recent causal64MiB protection under a full5GiB metadata budget', async t => {
  const { store, now, sparse } = artifactFixture(t), miB = 1048576;
  const { createInputSnapshotWriter } = require('./perf-input-snapshot-store');
  const { createInputLatencyCollector } = require('./perf-input-latency');
  const fixture = require('./perf-input-latency.test.cjs');
  const c = createInputLatencyCollector(fixture.options);
  c.write('{"traceEvents":[\n' + fixture.events.map(e => JSON.stringify(e)).join(',\n') + '\n]}');
  const evidence = c.finish({ completeExport: true, dataLoss: false, clockMarkers: fixture.clockMarkers });
  const r = { version: 1, kind: 'input-native-preroll', cpuProfiler: false,
    scope: { mainPid: fixture.options.mainPid, rendererPid: fixture.options.rendererPid, window: 1,
      documentGeneration: 1, frameProcessId: 1, frameRoutingId: 1 },
    actions: [], errors: [], evidence, recordingStartedAbs: now - 10, captureStartedAbs: now, captureFinishedAbs: now + 1 };
  assert.equal(await createInputSnapshotWriter({ directory: store.directory, mainPid: fixture.options.mainPid }).publish(r), true);
  const name = 'incident-' + now + '-' + fixture.options.mainPid + '.input.json';
  const payload = fs.readFileSync(store.file(name));
  fs.utimesSync(store.file(name), new Date(now - 6 * 3600000), new Date(now - 6 * 3600000));
  for (let i = 0; i < 16; i++) sparse('causal-202610' + String(i + 1).padStart(2, '0') + '00.ndjson', 4 * miB, now - 8 * 3600000 - i);
  for (let i = 0; i < 8; i++) sparse('stall-' + (now - 7 * 3600000 - i) + '-123-' + i + '.sample.txt', 8 * miB, now - 7 * 3600000 - i);
  // Non-heavy CPU/metadata flood is newer than the captured input. A size-only
  // floor used to make the tiny input the only evictable causal remainder.
  for (let i = 0; i < 1280; i++) sparse('incident-' + (now - 4 * 3600000 - i) + '-1.json', 4 * miB, now - 4 * 3600000 - i);
  const result = store.prune(now);
  assert.ok(result.bytes <= 5 * 1024 * miB);
  assert.equal(result.causalBytes, 64 * miB + payload.length);
  assert.equal(result.nativeSampleBytes, 64 * miB);
  assert.deepEqual(fs.readFileSync(store.file(name)), payload);
  assert.deepEqual(JSON.parse(store.read(name, 262144)).evidence, evidence);
  assert.ok(store.retentionLedger().entries.some(e => e.reason === 'artifact-budget'));
});

test('input artifacts expire at24h, remain bounded by shared protection, and never become heavy/native quota receipts', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000, miB = 1048576;
  const expired = 'incident-' + (now - day) + '-9.input.json', recent = 'incident-' + (now - day + 1) + '-9.input.json';
  sparse(expired, 128, now - day); sparse(recent, 128, now - day + 1);
  const huge = 'incident-' + (now - 180000) + '-9.input.json'; sparse(huge, 5 * 1024 * miB, now - 180000);
  assert.throws(() => store.file('../' + recent));
  assert.throws(() => store.file('incident-x-9.input.json'));
  assert.throws(() => store.read(huge, 262144));
  const result = store.prune(now);
  assert.equal(fs.existsSync(store.file(expired)), false);
  assert.equal(fs.existsSync(store.file(recent)), true);
  assert.equal(fs.existsSync(store.file(huge)), false);
  assert.ok(result.bytes <= 5 * 1024 * miB); assert.equal(result.causalBytes, 128);
  assert.equal(store.reserveCaptureDetails('incident-' + now + '-10', now, 'ui-click').remaining, 3);
  assert.equal(store.reserveCaptureDetails('incident-' + now + '-11', now, 'manual').allowed, true);
  assert.equal(store.reserveCaptureDetails('incident-' + (now + 1) + '-11', now + 1, 'manual').allowed, true);
});

test('causal share is shared, not a permanent input reservation or a new pool', t => {
  const { store, now, sparse } = artifactFixture(t), miB = 1048576;
  const old = 'incident-' + (now - 12 * 3600000) + '-9.input.json'; sparse(old, 262144, now - 12 * 3600000);
  for (let i = 0; i < 16; i++) sparse('causal-202610' + String(i + 1).padStart(2, '0') + '00.ndjson', 4 * miB, now - 3600000 - i);
  for (let i = 0; i < 1280; i++) sparse('incident-' + (now - 2 * 3600000 - i) + '-1.json', 4 * miB, now - 2 * 3600000 - i);
  const result = store.prune(now);
  assert.equal(fs.existsSync(store.file(old)), false, 'older input outside the newest causal share can be evicted');
  assert.equal(result.causalBytes, 64 * miB);
  assert.ok(result.bytes <= 5 * 1024 * miB);
});
