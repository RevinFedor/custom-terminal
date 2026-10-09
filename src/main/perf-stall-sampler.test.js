'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createArtifactStore } = require('./perf-flight-recorder');
const { createNativeStallSampler, nativeCaptureDecision, parseNativeSampleHeader, sampleOverlap } = require('./perf-stall-sampler');

const HOUR = 3600000, DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 9, 9, 12);
const target = { pid: 321, processIdentity: 'start:100', stallId: 'main-1' };
test('sample v7 only proves overlap via a complete verified envelope contained in the actual stall', () => {
  const record = { status: 'complete', output: { hasCallGraph: true },
    stall: { pid: 321, startedWallMs: BASE }, capture: { pid: 321, source: null, reason: 'native-actual-bounds-unavailable' },
    spawnRequestedWallMs: BASE + 500, samplingCompletedObservedWallMs: BASE + 1600,
    childClosedWallMs: BASE + 5000, resumeObservedWallMs: BASE + 2200 };
  assert.equal(sampleOverlap(record).status, 'overlap');
  assert.equal(sampleOverlap(record).overlapMs, null, 'no fabricated native sampling duration');
  assert.equal(sampleOverlap({ ...record, samplingCompletedObservedWallMs: null }).status, 'unknown');
  assert.equal(sampleOverlap({ ...record, capture: { ...record.capture, reason: 'sample-target-unproven' } }).status, 'unknown');
  assert.equal(sampleOverlap({ ...record, status: 'failed' }).status, 'unknown');
  assert.equal(sampleOverlap({ ...record, spawnRequestedWallMs: BASE + 2500, samplingCompletedObservedWallMs: BASE + 3600 }).status, 'no-overlap');
});
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-stall-unit-'));
  const artifacts = createArtifactStore(directory), children = [], calls = [], logs = [], timers = new Set();
  let wall = BASE, mono = 1000;
  const clock = { now: () => wall, monoNow: () => mono };
  const defaults = {
    artifacts, platform: 'darwin', sampleAvailable: () => true,
    verifyTarget: meta => ({ state: 'found', pid: meta.pid, processIdentity: meta.processIdentity }),
    ...clock, log: line => logs.push(line),
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    spawn: (binary, args, opts) => {
      const child = new EventEmitter();
      child.pid = 900 + children.length; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kills = []; child.kill = signal => { child.kills.push(signal); return true; };
      children.push(child); calls.push({ binary, args, opts });
      return child;
    },
  };
  const samplers = [];
  function make(extra = {}) { const sampler = createNativeStallSampler({ ...defaults, ...options, ...extra }); samplers.push(sampler); return sampler; }
  const sampler = make();
  t.after(() => {
    for (const s of samplers) s.stop();
    for (const c of children) { c.emit('close', null, 'SIGKILL'); c.stdout.destroy(); c.stderr.destroy(); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, artifacts, children, calls, logs, timers, sampler, make,
    advance: ms => { wall += ms; mono += ms; }, wallJump: ms => { wall += ms; }, now: clock.now,
    meta: (extra = {}) => ({ ...target, kind: 'main', state: 'stalled', stalledMs: 500,
      stallStartedWallMs: wall - 500, observedWallMs: wall, ...extra }),
    read: id => JSON.parse(artifacts.read(id + '.sample.json')),
    finish: (text, code = 0, signal = null) => {
      const child = children.at(-1); child.emit('spawn');
      if (text) child.stdout.write(text);
      child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
    },
  };
}
function report(pid = 321, extraHeader = '') {
  return 'Analysis of sampling Noted Terminal (pid ' + pid + ') every 1 millisecond\n' +
    'Process: Noted Terminal [' + pid + ']\nDate/Time: 2026-10-09 12:00:00.000 +0000\n' + extraHeader +
    'Report Version: 7\nAnalysis Tool: /usr/bin/sample\nCall graph:\n' +
    '    800 Thread_1\n    + 800 0x123 (Electron Framework + 456)\n' +
    'Sort by top of stack, same collapsed (when >= 5):\n        ChromiumUnknown 800\n\n' +
    'Binary Images:\n       0x100 - 0x999 Electron Framework <EXACT-UUID> /fixture/Framework\n';
}
const bounds = (start, end) => 'Start time: ' + new Date(start).toISOString() + '\nEnd time: ' + new Date(end).toISOString() + '\n';
const receipt = (at, i, extra = {}) => ({ requestedWallMs: at, pid: i + 1, processIdentity: 'process-' + i, stallId: 'stall-' + i, ...extra });

test('global rolling native quotas, exact process cooldown and exact expiry boundaries', () => {
  const at = BASE;
  const recent = Array.from({ length: 8 }, (_, i) => receipt(at - HOUR + 1 + i, i));
  const hour = nativeCaptureDecision(recent, at, target);
  assert.equal(hour.reason, 'native-hour-quota-exhausted'); assert.equal(hour.nextEligibleWallMs, at + 1);
  assert.equal(nativeCaptureDecision(recent, at + 1, { ...target, stalledMs: 1000 }).allowed, true);
  const day = Array.from({ length: 24 }, (_, i) => receipt(at - DAY + 1 + i * 2 * HOUR, i));
  // All 24 slots fit a day while only one is in the current hour.
  day.forEach((r, i) => { r.requestedWallMs = at - DAY + 1 + i * HOUR; });
  assert.equal(nativeCaptureDecision(day, at, target).reason, 'native-day-quota-exhausted');
  assert.equal(nativeCaptureDecision(day, at + 1, { ...target, stalledMs: 1000 }).allowed, true);
  const own = [receipt(at - 29999, 0, { ...target, stallId: 'previous' })];
  assert.equal(nativeCaptureDecision(own, at, target).reason, 'native-process-cooldown');
  assert.equal(nativeCaptureDecision(own, at + 1, target).allowed, true);
  assert.equal(nativeCaptureDecision(own, at, { ...target, processIdentity: 'reused-pid' }).allowed, true);
  assert.equal(nativeCaptureDecision(own, at, { ...target, pid: target.pid + 1 }).allowed, true);
  assert.equal(nativeCaptureDecision([receipt(at + 1, 0)], at, target).reason, 'quota-clock-unknown');
});

test('unsupported, invalid, stale, unknown and unfocused targets never reserve or spawn', t => {
  const f = fixture(t);
  for (const [change, reason] of [
    [{ pid: 0 }, 'invalid-target'], [{ pid: -9 }, 'invalid-target'], [{ pid: 1.5 }, 'invalid-target'],
    [{ processIdentity: '' }, 'invalid-target'], [{ stallId: '' }, 'invalid-stall-identity'],
    [{ state: 'unknown' }, 'stall-state-unknown'], [{ kind: 'external' }, 'unsupported-target-kind'],
    [{ stalledMs: 499 }, 'stall-below-threshold'], [{ stalledMs: NaN }, 'stall-below-threshold'],
    [{ observedWallMs: BASE - 1001 }, 'stall-observation-stale-or-invalid'],
    [{ observedWallMs: BASE + 1 }, 'stall-observation-stale-or-invalid'],
    [{ stallStartedWallMs: BASE - 10 }, 'stall-observation-stale-or-invalid'],
    [{ kind: 'renderer', focused: false }, 'renderer-not-focused'],
    [{ kind: 'renderer', focused: true }, 'stall-threshold-unknown'],
    [{ kind: 'renderer', focused: true, thresholdMs: 750 }, 'stall-below-threshold'],
  ]) assert.equal(f.sampler.request(f.meta(change)).reason, reason);
  assert.equal(f.make({ platform: 'linux' }).request(f.meta()).reason, 'unsupported-platform');
  assert.equal(f.make({ sampleAvailable: () => false }).request(f.meta()).reason, 'sample-binary-unavailable');
  assert.equal(f.make({ verifyTarget: undefined }).request(f.meta()).reason, 'target-state-unknown');
  assert.equal(f.make({ verifyTarget: () => ({ state: 'absent' }) }).request(f.meta()).reason, 'target-absent');
  assert.equal(f.make({ verifyTarget: () => { throw Error('lookup failed'); } }).request(f.meta()).reason, 'target-state-unknown');
  assert.equal(f.make({ verifyTarget: () => ({ state: 'found', pid: target.pid, processIdentity: 'replacement' }) }).request(f.meta()).reason, 'target-identity-changed');
  assert.equal(f.make({ verifyTarget: () => Promise.resolve({ state: 'found', ...target }) }).request(f.meta()).reason, 'target-state-unknown');
  assert.deepEqual(f.artifacts.entries(), []); assert.equal(f.children.length, 0);
});

test('receipt is durable before spawn; complete native artifact and lifecycle survive separately from the hint', async t => {
  const f = fixture(t), writes = [];
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => { writes.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return sync(fd); };
  let result;
  try { result = f.sampler.request(f.meta()); } finally { fs.fsyncSync = sync; }
  assert.equal(result.allowed, true); assert.deepEqual(writes, ['file', 'directory']);
  const receiptName = result.id + '.sample-capture.json';
  assert.equal(JSON.parse(f.artifacts.read(receiptName)).stallId, target.stallId);
  assert.equal(fs.statSync(f.artifacts.file(receiptName)).mode & 0o777, 0o600);
  assert.deepEqual(f.calls[0].args, ['321', '1', '1', '-file', '/dev/stdout']);
  assert.equal(f.calls[0].binary, '/usr/bin/sample'); assert.equal(f.calls[0].opts.shell, false);
  assert.equal([...f.timers][0].delay, 20000);
  assert.equal(f.read(result.id).spawnedWallMs, null);
  f.advance(25); f.children[0].emit('spawn'); f.advance(1000);
  f.children[0].stdout.write(report()); f.children[0].emit('close', 0, null);
  const done = await result.done;
  assert.equal(done.status, 'complete'); assert.equal(done.requestedWallMs, BASE);
  assert.equal(done.spawnedWallMs, BASE + 25); assert.equal(done.finishedWallMs, BASE + 1025);
  assert.equal(done.childState, 'closed'); assert.equal(done.output.complete, true);
  assert.equal(done.capture.actualStartWallMs, null); assert.equal(done.overlap.status, 'unknown');
  assert.match(done.topStackHint, /ChromiumUnknown/);
  assert.equal(fs.readFileSync(f.artifacts.file(done.output.file), 'utf8'), report());
  assert.equal(f.timers.size, 0);
  assert.equal(f.sampler.resumed({ ...target, resumedWallMs: BASE + 1025 }).recorded, true);
  const resumed = f.read(result.id);
  assert.equal(resumed.overlap.status, 'overlap', 'complete capture envelope lies wholly inside the observed stall');
  assert.equal(resumed.overlap.overlapMs, null, 'containment does not invent an exact native interval');
  assert.equal(resumed.capture.actualStartWallMs, null);
  assert.equal(resumed.capture.actualEndWallMs, null);
  assert.equal(resumed.overlap.basis, 'verified-native-capture-envelope-contained-in-heartbeat-silence');
  assert.equal(f.read(result.id).resumeObservedWallMs, BASE + 1025);
});

test('focused renderer uses watchdog threshold; concurrent processes and overload do not allocate artifacts', async t => {
  const f = fixture(t);
  const request = f.sampler.request(f.meta({ kind: 'renderer', focused: true, thresholdMs: 750,
    stalledMs: 750, stallStartedWallMs: BASE - 750 }));
  assert.equal(request.allowed, true);
  const other = f.make();
  for (let i = 0; i < 1000; i++) {
    const s = i % 2 ? f.sampler : other;
    assert.equal(s.request(f.meta({ pid: i + 1000, stallId: 'other-' + i })).reason, 'sample-in-flight');
  }
  assert.equal(f.children.length, 1); assert.equal(f.artifacts.entries().length, 3); assert.equal(f.timers.size, 1);
  f.finish(report()); await request.done;
  f.advance(1);
  const next = other.request(f.meta({ pid: 322, stallId: 'next' }));
  assert.equal(next.allowed, true); f.finish(report(322)); await next.done;
});

test('restart preserves global 8/hour and 24/day independently of discarded sample files', async t => {
  const f = fixture(t);
  for (let group = 0; group < 3; group++) {
    for (let i = 0; i < 8; i++) {
      const sampler = f.make();
      const result = sampler.request(f.meta({ pid: 1000 + group * 8 + i, processIdentity: 'p-' + group + '-' + i, stallId: 's-' + group + '-' + i,
        ...(i >= 6 ? { stalledMs: 1000, stallStartedWallMs: f.now() - 1000 } : {}) }));
      assert.equal(result.allowed, true); f.finish(report(1000 + group * 8 + i)); await result.done; sampler.stop();
      fs.unlinkSync(f.artifacts.file(result.id + '.sample.txt'));
      fs.unlinkSync(f.artifacts.file(result.id + '.sample.json'));
    }
    assert.equal(f.make().request(f.meta({ pid: 2000 })).reason, group === 2 ? 'native-day-quota-exhausted' : 'native-hour-quota-exhausted');
    if (group < 2) f.advance(HOUR);
  }
  assert.equal(f.children.length, 24);
  f.advance(DAY - 2 * HOUR);
  assert.equal(f.make().request(f.meta({ pid: 2001 })).allowed, true);
});

test('restart preserves per-identity cooldown and same-stall de-duplication', async t => {
  const f = fixture(t), r = f.sampler.request(f.meta());
  f.finish(report()); await r.done; f.sampler.stop();
  const reloaded = f.make({ artifacts: createArtifactStore(f.directory) });
  assert.equal(reloaded.request(f.meta()).reason, 'stall-already-requested');
  assert.equal(reloaded.request(f.meta({ stallId: 'new' })).reason, 'native-process-cooldown');
  f.advance(30000);
  assert.equal(reloaded.request(f.meta({ stallId: 'new' })).allowed, true);
});

test('six early alarms leave capacity for a still-observed critical stall, without raising or resetting caps', async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) {
    const request = f.sampler.request(f.meta({ pid: 1000+i, processIdentity: 'initial-'+i, stallId: 'initial-'+i }));
    assert.equal(request.allowed,true);f.finish(report(1000+i));await request.done;
  }
  const held=f.meta({ pid:2000,processIdentity:'held',stallId:'same-held-stall' });
  assert.equal(f.make().request(held).reason,'native-reserved-for-critical-stall');
  assert.equal(f.children.length,6);
  f.advance(500);
  const critical=f.make().request({...held,stalledMs:1000,observedWallMs:f.now()});
  assert.equal(critical.allowed,true);f.finish(report(2000));await critical.done;
  assert.equal(JSON.parse(f.artifacts.read(critical.id+'.sample-capture.json')).admissionClass,'critical');
  assert.equal(f.make().request({...held,stalledMs:1000,observedWallMs:f.now()}).reason,'stall-already-requested');
  const last=f.make().request(f.meta({pid:2001,processIdentity:'critical2',stallId:'critical2',stalledMs:1000,stallStartedWallMs:f.now()-1000}));
  assert.equal(last.allowed,true);f.finish(report(2001));await last.done;
  assert.equal(f.make().request(f.meta({pid:2002,stalledMs:1000,stallStartedWallMs:f.now()-1000})).reason,'native-hour-quota-exhausted');
});

test('all heavy slots exhausted still allows native; native receipts do not consume or reset heavy slots', async t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    const at = BASE - HOUR + i * 700000, name = 'incident-' + at + '-1.capture.json';
    f.artifacts.write(name, { requestedAt: at, group: 'responsiveness' });
    fs.utimesSync(f.artifacts.file(name), new Date(at), new Date(at));
  }
  const id = 'incident-' + BASE + '-1';
  assert.equal(f.artifacts.reserveCaptureDetails(id, BASE).reason, 'rolling-quota-exhausted');
  const result = f.sampler.request(f.meta()); assert.equal(result.allowed, true);
  f.finish(report()); await result.done;
  f.artifacts.prune(BASE);
  assert.equal(createArtifactStore(f.directory).reserveCaptureDetails(id, BASE).reason, 'rolling-quota-exhausted');
  const nativeOnly = fixture(t);
  const n = nativeOnly.sampler.request(nativeOnly.meta()); nativeOnly.finish(report()); await n.done;
  assert.equal(nativeOnly.artifacts.reserveCaptureDetails(id, BASE).allowed, true);
});

test('corrupt or future quota evidence cannot silently reset the native budget', t => {
  const f = fixture(t), id = 'stall-' + BASE + '-123-1';
  f.artifacts.write(id + '.sample-capture.json', '{broken');
  assert.equal(f.sampler.request(f.meta()).reason, 'quota-state-unknown');
  assert.equal(f.children.length, 0);
  fs.unlinkSync(f.artifacts.file(id + '.sample-capture.json'));
  const future = 'stall-' + (BASE + 1) + '-123-1';
  f.artifacts.write(future + '.sample-capture.json', { version: 1, id: future, requestedWallMs: BASE + 1,
    pid: 123, processIdentity: 'p', stallId: 's' });
  assert.equal(f.sampler.request(f.meta()).reason, 'quota-clock-unknown');
});

test('failed durable receipt, initial metadata and output creation never spawn', t => {
  for (const [method, expected] of [['writeExclusive', 'receipt-write-failed'], ['write', 'metadata-write-failed'], ['openExclusive', 'sample-start-failed']]) {
    const f = fixture(t);
    f.artifacts[method] = () => { throw Error('disk unavailable'); };
    assert.equal(f.sampler.request(f.meta()).reason, expected);
    assert.equal(f.children.length, 0); assert.equal(f.timers.size, 0);
  }
});

test('exact target and observation are rechecked after durable disk work, before spawn', t => {
  for (const changed of ['identity', 'absent', 'unknown', 'old-observation']) {
    const f = fixture(t);
    let checks = 0;
    const sampler = f.make({ verifyTarget: meta => {
      checks++;
      if (checks === 2) {
        if (changed === 'old-observation') f.advance(1001);
        if (changed === 'identity') return { state: 'found', pid: meta.pid, processIdentity: 'reused-pid' };
        if (changed === 'absent' || changed === 'unknown') return { state: changed };
      }
      return { state: 'found', pid: meta.pid, processIdentity: meta.processIdentity };
    } });
    const r = sampler.request(f.meta());
    assert.equal(r.allowed, false); assert.equal(checks, 2); assert.equal(f.children.length, 0);
    assert.equal(f.read(r.id).status, 'failed');
    assert.equal(f.artifacts.entries().filter(e => e.name.endsWith('.sample-capture.json')).length, 1);
  }
});

test('receipt fsync failure retains conservative quota evidence and never spawns', t => {
  const f = fixture(t), sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('sync failed'); };
  let r;
  try { r = f.sampler.request(f.meta()); } finally { fs.fsyncSync = sync; }
  assert.equal(r.reason, 'receipt-write-failed'); assert.equal(f.children.length, 0);
  assert.equal(f.make().request(f.meta({ stallId: 'retry' })).reason, 'native-process-cooldown');
});

test('stream errors and failed kill are recorded, not treated as confirmed child exit', async t => {
  const f = fixture(t), r = f.sampler.request(f.meta()), child = f.children[0];
  child.kill = () => { throw Error('kill failed'); };
  child.stdout.emit('error', Error('broken pipe'));
  const result = await r.done;
  assert.equal(result.reason, 'sample-stream-error'); assert.equal(result.termination.sent, false);
  assert.match(result.termination.error, /kill failed/);
  assert.equal(f.make().request(f.meta()).reason, 'sample-in-flight');
  let shutdownAttempts = 0;
  child.kill = () => { shutdownAttempts++; return true; };
  f.sampler.stop(); f.sampler.stop();
  assert.equal(shutdownAttempts, 1); assert.equal(f.read(r.id).shutdownKill.sent, true);
  child.emit('close', 1, null);
  assert.equal(f.read(r.id).childState, 'closed');
});

test('spawn failure consumes its receipt, closes output, and never throws through request', t => {
  const f = fixture(t, { spawn: () => { throw Error('spawn ENOENT'); } });
  const r = f.sampler.request(f.meta());
  assert.equal(r.reason, 'sample-start-failed'); assert.equal(f.read(r.id).status, 'failed');
  assert.equal(f.read(r.id).childState, 'closed');
  assert.equal(f.make().request(f.meta({ stallId: 'again' })).reason, 'native-process-cooldown');
});

test('asynchronous spawn error and nonzero exit record failures with no invented capture interval', async t => {
  const f = fixture(t), r = f.sampler.request(f.meta());
  f.children[0].pid = undefined;
  f.children[0].emit('error', Error('ENOENT'));
  assert.equal((await r.done).reason, 'sample-spawn-failed'); assert.equal(f.timers.size, 0);
  f.advance(30000);
  const r2 = f.sampler.request(f.meta({ stallId: 'later' }));
  f.finish(report(), 1);
  const done = await r2.done;
  assert.equal(done.reason, 'sample-exit-failed'); assert.equal(done.output.complete, false);
  assert.equal(done.overlap.status, 'unknown');
});

test('timeout, output overflow, stderr overflow and shutdown kill only owned child, bounded done and unknown until close', async t => {
  for (const reason of ['sample-timeout', 'sample-output-limit', 'sample-stderr-limit', 'sampler-shutdown']) {
    const f = fixture(t, { maxOutputBytes: 1024 });
    const r = f.sampler.request(f.meta()), child = f.children[0]; child.emit('spawn');
    if (reason === 'sample-timeout') { f.advance(20000); [...f.timers][0].fn(); }
    if (reason === 'sample-output-limit') child.stdout.write(Buffer.alloc(4096, 65));
    if (reason === 'sample-stderr-limit') child.stderr.write(Buffer.alloc(70000, 66));
    if (reason === 'sampler-shutdown') f.sampler.stop();
    const done = await r.done;
    assert.equal(done.reason, reason); assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(done.output.complete, false); assert.notEqual(done.childState, 'closed');
    assert.ok(fs.statSync(f.artifacts.file(done.output.file)).size <= 1024);
    assert.ok((done.stderrHint || '').length <= 512); assert.equal(f.timers.size, 0);
    assert.equal(f.make().request(f.meta({ pid: 456 })).reason, 'sample-in-flight');
    child.stdout.write('late-data'); child.emit('close', null, 'SIGKILL');
    assert.equal(f.read(r.id).childState, 'closed'); assert.equal(f.read(r.id).reason, reason);
    assert.equal(f.make().request(f.meta({ pid: 456 })).allowed, true);
  }
});

test('empty or wrong target output is not success merely because sample exits zero', async t => {
  for (const [payload, reason] of [['', 'sample-output-empty'], [report(999), 'invalid-sample-report'], ['not a report', 'invalid-sample-report']]) {
    const f = fixture(t), r = f.sampler.request(f.meta()); f.finish(payload);
    const done = await r.done;
    assert.equal(done.reason, reason); assert.equal(done.output.complete, false); assert.equal(done.overlap.status, 'unknown');
  }
});

test('a native interval starting after observed resume explicitly proves no overlap', async t => {
  const f = fixture(t), r = f.sampler.request(f.meta()); f.children[0].emit('spawn');
  f.advance(20); assert.equal(f.sampler.resumed(target).recorded, true);
  f.advance(1100); f.finish(report(321, bounds(BASE + 100, BASE + 1100)));
  const done = await r.done;
  assert.equal(done.capture.source, 'native-header-explicit-bounds');
  assert.equal(done.overlap.status, 'no-overlap'); assert.equal(done.overlap.overlapMs, 0);
  assert.equal(done.resumeObservedWallMs, BASE + 20);
});

test('resume delivered after finish updates overlap only for the exact stall/process identity', async t => {
  const f = fixture(t), r = f.sampler.request(f.meta());
  f.advance(1200); f.finish(report(321, bounds(BASE + 10, BASE + 1010))); await r.done;
  assert.equal(f.read(r.id).overlap.reason, 'resume-not-observed');
  assert.equal(f.sampler.resumed({ ...target, processIdentity: 'reused-pid' }).recorded, false);
  assert.equal(f.sampler.resumed({ ...target, stallId: 'other' }).recorded, false);
  assert.equal(f.sampler.resumed({ ...target, resumedWallMs: BASE - 1 }).reason, 'resume-time-invalid');
  assert.equal(f.sampler.resumed({ ...target, resumedWallMs: BASE + 2000 }).reason, 'resume-time-invalid');
  const update = f.sampler.resumed({ ...target, resumedWallMs: BASE + 500 });
  assert.equal(update.overlap.status, 'overlap'); assert.equal(update.overlap.overlapMs, 490);
  assert.equal(f.read(r.id).resumeReceivedWallMs, BASE + 1200);
  assert.equal(f.sampler.resumed(target).reason, 'resume-already-recorded');
});

test('header dates without actual bounds, ambiguous zones and stale native intervals remain unknown', async t => {
  const ordinary = parseNativeSampleHeader(report());
  assert.equal(ordinary.reportedWallMs, BASE); assert.equal(ordinary.actualStartWallMs, null);
  assert.equal(parseNativeSampleHeader(report(321, 'Start time: 2026-10-09 12:00:00\nEnd time: 2026-10-09 12:00:01\n')).source, null);
  assert.equal(parseNativeSampleHeader(report(321, bounds(BASE + 1000, BASE))).source, null);
  assert.equal(parseNativeSampleHeader(report(321, bounds(BASE, BASE + 1000) + bounds(BASE, BASE + 1000))).source, null);
  assert.equal(parseNativeSampleHeader(report(321, 'Start time: 2026-02-30T00:00:00Z\nEnd time: 2026-03-02T00:00:01Z\n')).source, null);
  for (const clockChange of [false, true]) {
    const f = fixture(t), r = f.sampler.request(f.meta());
    f.advance(2000); if (clockChange) f.wallJump(10000);
    f.finish(report(321, bounds(clockChange ? BASE : BASE - 1000, BASE + 1000)));
    assert.equal((await r.done).overlap.reason, 'native-bounds-outside-lifecycle-or-clock-change');
  }
  const record = { stall: { startedWallMs: BASE - 500, observedWallMs: BASE }, resumeObservedWallMs: null,
    capture: { source: 'native-header-explicit-bounds', actualStartWallMs: BASE - 300, actualEndWallMs: BASE + 50 } };
  assert.equal(sampleOverlap(record).lowerBound, true); assert.equal(sampleOverlap(record).overlapMs, 300);
});

test('throwing diagnostic logger and stop-before-request cannot throw into caller', t => {
  const f = fixture(t, { log: () => { throw Error('sink unavailable'); } });
  assert.equal(f.sampler.request(f.meta({ pid: 0 })).reason, 'invalid-target');
  f.sampler.stop(); f.sampler.stop();
  assert.equal(f.sampler.request(f.meta()).reason, 'sampler-stopped');
});
