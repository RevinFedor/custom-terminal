'use strict';
// Finite SOURCE protocol tests only. No Electron/Inspector runtime, model,
// native sampler, provider, GUI, user data or wall-clock recording interval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const flush = () => new Promise(resolve => setImmediate(resolve));
const profile = { startTime: 100, endTime: 200, nodes: [{ id: 1 }], samples: [1], timeDeltas: [100] };

function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-profile-lifetime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], commands = [], pending = new Map(), ready = [], timers = [], deadlines = [];
  const dbg = new EventEmitter(); let attached = false, current = true, invalidate, mono = 100;
  const guard = { owner: { mainPid: 50, webContentsId: 7, rendererPid: 51, documentToken: 'fixture-document' },
    isCurrent: () => current, current: () => ({ rendererPid: current ? 51 : 52 }),
    invalidated: new Promise(resolve => { invalidate = resolve; }), lose() { current = false; invalidate(); } };
  const foreign = () => { dbg.emit('detach', {}, 'foreign-client'); attached = true; };
  const complete = (stream = 'own-stream') => dbg.emit('message', {}, 'Tracing.tracingComplete', { stream, dataLossOccurred: false });
  function command(target, method, callback) {
    const key = target + ':' + method; calls.push(key); mono += options.commandCostMs || 0;
    if (key === options.invalidateAt) guard.lose();
    if (key === options.foreignAt) foreign();
    if (key === options.completeAt) complete('foreign-stream');
    const result = method === 'Profiler.stop' ? { profile }
      : method === 'IO.read' ? { data: '{"traceEvents":[]}', eof: true }
        : method === 'Runtime.evaluate' ? { result: { value: { entries: [], observedCount: 0 } } } : {};
    if ((options.hold || []).includes(key)) {
      return new Promise((resolve, reject) => pending.set(key, {
        resolve(value = result) { mono += 1; callback?.(null, value); resolve(value); },
        reject(error = Error('lost transport')) { callback?.(error); reject(error); },
      }));
    }
    if (key === options.rejectAt) {
      const error = Error(options.rejectMessage || 'lost transport'); callback?.(error);
      return Promise.reject(error);
    }
    if (method === 'Tracing.end' && !options.holdCompletion) complete();
    callback?.(null, result); return Promise.resolve(result);
  }
  dbg.attach = () => { attached = true; calls.push('attach'); };
  dbg.detach = () => { attached = false; calls.push('detach'); dbg.emit('detach', {}, 'own-detach'); };
  dbg.isAttached = () => attached;
  dbg.sendCommand = (method, params) => { commands.push({ target: 'renderer', method, params }); return command('renderer', method); };
  class Session {
    connect() { calls.push('main:connect'); }
    disconnect() { calls.push('main:disconnect'); }
    post(method, params, cb) { commands.push({ target: 'main', method, params }); command('main', method, cb).catch(() => {}); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'perf-incident-profile.js'), 'utf8'), {
    module, exports: module.exports, process, Buffer, console, __dirname,
    require: name => name === 'perf_hooks' ? { performance: { now: () => mono, timeOrigin: 1700000000000 } }
      : require(name.startsWith('.') ? path.join(__dirname, name) : name),
    setTimeout(fn, ms) {
      const timer = { ms, cleared: false }; timers.push(timer);
      if (!options.holdDuration) queueMicrotask(() => { mono += ms; fn(); });
      return timer;
    }, clearTimeout(timer) { if (timer) timer.cleared = true; },
  }, { filename: 'perf-incident-profile.js' });
  const commandDeadline = (promise, label, ms) => {
    deadlines.push({ label, ms, mono });
    // Observe real raw commands once; only the caller-facing wait expires.
    if ((options.hold || []).some(key => key.endsWith(':' + label))
      || label === 'Tracing.complete' && options.holdCompletion) {
      return Promise.resolve().then(() => { throw Error(label + ':timeout'); });
    }
    return promise;
  };
  const wc = { id: 7, debugger: dbg, isDestroyed: () => false, isDevToolsOpened: () => false,
    getOSProcessId: () => 51, getZoomFactor: () => 1 };
  const args = { request: { id: 'incident-77-1', requestedWallMs: Date.now(), pid: 51 },
    webContents: wc, directory: dir, inspector: { url: () => options.externalMain ? 'external' : '', Session },
    durationMs: 0, commandDeadline, ownerGuard: guard, log() {}, onReady: value => ready.push(value) };
  return { calls, commands, pending, dir, ready, timers, deadlines, guard, complete, foreign,
    advance(ms) { mono += ms; },
    capture(extra = {}) { return module.exports.captureIncidentProfile({ ...args, ...extra }); },
    count(name) { return calls.filter(x => x === name).length; },
    resolve(key) { assert.ok(pending.has(key), 'issued ' + key); pending.get(key).resolve(); },
  };
}

for (const target of ['main', 'renderer']) {
  test(target + ' late CPU START owns one STOP after report, preserving original session', { timeout: 1000 }, async t => {
    const f = harness(t, { hold: [target + ':Profiler.start'] });
    const report = await f.capture(); const snapshot = JSON.stringify(report);
    assert.equal((await report.retirement).state, 'unknown');
    assert.equal(f.count(target + ':Profiler.stop'), 0);
    assert.equal(f.count('detach'), 0); assert.equal(f.count('main:disconnect'), 0);
    assert.equal((await f.capture({ request: { id: 'incident-77-2' } })).outcome, 'refused');
    f.advance(20000); f.resolve(target + ':Profiler.start');
    const receipt = await report.whenRetired;
    assert.equal(receipt.confirmed, true); assert.equal(receipt.leaseId, report.leaseId);
    assert.equal(f.count(target + ':Profiler.start'), 1); assert.equal(f.count(target + ':Profiler.stop'), 1);
    assert.equal(f.count('detach'), 1); assert.equal(f.count('main:disconnect'), 1);
    assert.equal(JSON.stringify(report), snapshot, 'late result cannot mutate the original report');
    assert.equal(receipt.profiles[target].stop.state, 'ok');
    assert.equal(receipt.profiles[target].stop.profileStartTimeUs, profile.startTime);
    assert.equal(receipt.profiles[target].stop.profileEndTimeUs, profile.endTime);
    assert.ok(receipt.profiles[target].stop.issuedMonoMs >= receipt.profiles[target].start.settledMonoMs);
  });
  test(target + ' late CPU STOP holds attachment and Inspector until exact ACK', { timeout: 1000 }, async t => {
    const f = harness(t, { hold: [target + ':Profiler.stop'] });
    const report = await f.capture();
    assert.equal((await report.retirement).confirmed, false);
    assert.equal(f.count('detach'), 0); assert.equal(f.count('main:disconnect'), 0);
    f.advance(20000); f.resolve(target + ':Profiler.stop');
    assert.equal((await report.whenRetired).state, 'retired');
    assert.equal(f.count(target + ':Profiler.stop'), 1);
    assert.equal(f.count('detach'), 1); assert.equal(f.count('main:disconnect'), 1);
  });
}

test('late trace START ignores foreign completion, retains lane then retires exact END/close', { timeout: 1000 }, async t => {
  const f = harness(t, { hold: ['renderer:Tracing.start'] });
  const report = await f.capture(); const snapshot = JSON.stringify(report);
  const disk = fs.readFileSync(path.join(f.dir, 'incident-77-1.profile.json'), 'utf8');
  assert.equal((await report.retirement).state, 'unknown');
  assert.equal(f.count('renderer:Tracing.end'), 0); assert.equal(f.count('detach'), 0);
  f.complete('foreign-stream'); await flush();
  assert.equal(f.count('renderer:IO.close'), 0);
  f.guard.lose(); f.advance(20000); f.resolve('renderer:Tracing.start');
  const receipt = await report.whenRetired;
  assert.equal(receipt.confirmed, true); assert.equal(f.count('renderer:Tracing.start'), 1);
  assert.equal(f.count('renderer:Tracing.end'), 1); assert.equal(f.count('renderer:IO.close'), 1);
  assert.equal(f.count('renderer:IO.read'), 0, 'late cleanup must not collect the next document');
  assert.equal(f.count('renderer:Runtime.evaluate'), 0);
  assert.equal(JSON.stringify(report), snapshot);
  assert.equal(fs.readFileSync(path.join(f.dir, 'incident-77-1.profile.json'), 'utf8'), disk);
});

test('late START after foreign reattach has no END, stream close or detach authority', { timeout: 1000 }, async t => {
  const f = harness(t, { hold: ['renderer:Tracing.start'] });
  const report = await f.capture(); f.foreign(); f.resolve('renderer:Tracing.start');
  await flush(); await flush(); f.complete('foreign-stream'); await flush();
  assert.equal(f.count('renderer:Tracing.end'), 0); assert.equal(f.count('renderer:IO.close'), 0);
  assert.equal(f.count('detach'), 0); assert.equal((await report.retirement).confirmed, false);
  assert.equal((await f.capture({ request: { id: 'incident-77-2' } })).errors[0], 'capture-in-flight');
});

test('unknown START rejection never ends a foreign global trace', { timeout: 1000 }, async t => {
  const f = harness(t, { rejectAt: 'renderer:Tracing.start' });
  const report = await f.capture(); f.complete(); await flush();
  assert.equal((await report.retirement).state, 'unknown');
  assert.equal(f.count('renderer:Tracing.end'), 0); assert.equal(f.count('detach'), 0);
  assert.equal(f.count('renderer:Runtime.evaluate'), 0);
});

test('known trace refusal retires own CPU leases without touching global recording', { timeout: 1000 }, async t => {
  const f = harness(t, { rejectAt: 'renderer:Tracing.start', rejectMessage: 'Tracing has already been started' });
  const report = await f.capture();
  assert.equal((await report.whenRetired).confirmed, true);
  assert.equal(f.count('renderer:Tracing.end'), 0); assert.equal(f.count('renderer:Runtime.evaluate'), 0);
  assert.equal(f.count('detach'), 1);
});

test('late END and complete are distinct proofs; neither creates a second END', { timeout: 1000 }, async t => {
  const f = harness(t, { hold: ['renderer:Tracing.end'], holdCompletion: true });
  const report = await f.capture();
  assert.equal((await report.retirement).state, 'unknown');
  f.resolve('renderer:Tracing.end'); await flush();
  assert.equal(f.count('detach'), 0); assert.equal(f.count('renderer:IO.close'), 0);
  f.complete(); assert.equal((await report.whenRetired).confirmed, true);
  assert.equal(f.count('renderer:Tracing.end'), 1); assert.equal(f.count('renderer:IO.close'), 1);
});

test('late complete before END ACK cannot release lane', { timeout: 1000 }, async t => {
  const f = harness(t, { hold: ['renderer:Tracing.end'], holdCompletion: true });
  const report = await f.capture(); f.complete(); await flush();
  assert.equal(f.count('detach'), 0); assert.equal(f.count('renderer:Tracing.end'), 1);
  f.resolve('renderer:Tracing.end'); assert.equal((await report.whenRetired).confirmed, true);
  assert.equal(f.count('renderer:Tracing.end'), 1);
});

test('late stream-close ACK is retirement proof, not export success', { timeout: 1000 }, async t => {
  const f = harness(t, { hold: ['renderer:IO.close'] });
  const report = await f.capture();
  assert.equal(report.traceComplete, true); assert.equal((await report.retirement).state, 'unknown');
  assert.equal(f.count('detach'), 0); f.resolve('renderer:IO.close');
  assert.equal((await report.whenRetired).confirmed, true); assert.equal(f.count('renderer:IO.close'), 1);
});

test('rejected STOP remains finite unknown without disconnect, retry or new capture', { timeout: 1000 }, async t => {
  const f = harness(t, { rejectAt: 'main:Profiler.stop' });
  const report = await f.capture(); await flush();
  assert.equal((await report.retirement).state, 'unknown'); assert.equal(f.count('main:Profiler.stop'), 1);
  assert.equal(f.count('main:disconnect'), 0); assert.equal(f.count('detach'), 0);
  assert.equal(f.count('renderer:Runtime.evaluate'), 0);
  assert.equal((await f.capture({ request: { id: 'incident-77-2' } })).outcome, 'refused');
});

test('document invalidation permits cleanup but forbids collection and READY', { timeout: 1000 }, async t => {
  const f = harness(t, { invalidateAt: 'renderer:Tracing.start' });
  const report = await f.capture();
  assert.equal((await report.whenRetired).confirmed, true); assert.equal(report.ownerCurrent, false);
  assert.equal(f.count('renderer:Tracing.end'), 1); assert.equal(f.count('renderer:Profiler.stop'), 1);
  assert.equal(f.count('renderer:IO.read'), 0); assert.equal(f.count('renderer:Runtime.evaluate'), 0);
  assert.equal(f.ready.length, 0);
});

test('completion emitted before our END is ignored', { timeout: 1000 }, async t => {
  const f = harness(t, { completeAt: 'renderer:Performance.enable', holdCompletion: true });
  const report = await f.capture();
  assert.equal((await report.retirement).state, 'unknown'); assert.equal(f.count('renderer:IO.close'), 0);
  f.complete(); assert.equal((await report.whenRetired).confirmed, true);
});

test('private armed uses first START deadline, 8ms samples and Main + one exact renderer READY', { timeout: 1000 }, async t => {
  const f = harness(t, { commandCostMs: 50 });
  const report = await f.capture({ captureOptions: { mode: 'private-armed', durationMs: 40000, samplingIntervalUs: 8000 } });
  assert.equal(f.ready.length, 1); const ready = f.ready[0];
  assert.equal(ready.targets.length, 2); assert.equal(ready.targets[0].role, 'main');
  assert.equal(ready.targets[1].role, 'renderer'); assert.equal(ready.targets[1].webContentsId, 7);
  assert.equal(ready.targets[1].owner.documentToken, 'fixture-document');
  assert.equal(ready.targets[1].attachmentGeneration, report.retirementState.attachmentGeneration);
  assert.equal(ready.mainCpu && ready.rendererCpu && ready.trace, true);
  assert.equal(report.samplingIntervalUs, 8000);
  for (const target of ['main', 'renderer']) assert.equal(f.commands.find(c => c.target === target
    && c.method === 'Profiler.setSamplingInterval').params.interval, 8000);
  assert.equal(ready.plannedStopMonoMs, report.profiles.main.start.issuedMonoMs + 40000);
  assert.equal(f.timers.length, 1); assert.ok(f.timers[0].ms < 40000);
  assert.equal(f.timers[0].ms, ready.plannedStopMonoMs - ready.readyMonoMs);
  assert.equal(report.profiles.main.stop.issuedMonoMs >= ready.plannedStopMonoMs, true);
  assert.equal(report.traceComplete, true);
  assert.equal(report.traceProjection.closed.acknowledged, true);
  assert.equal(report.traceProjection.closed.code, 0);
  assert.equal(report.traceProjectionClose.closed, true);
  assert.equal(report.artifacts.trace.format, 'noted-trace-projection-v1');
  assert.deepEqual(Array.from(report.traceCategories), ['devtools.timeline', 'v8', 'input', 'latencyInfo']);
  assert.equal(f.count('renderer:IO.close'), 1);
  assert.equal((await report.whenRetired).confirmed, true);
});

test('confirmed retirement reopens the same lane and balances every original session exactly once', { timeout: 1000 }, async t => {
  const f = harness(t); const first = await f.capture();
  const firstReceipt = await first.whenRetired;
  const second = await f.capture({ request: { id: 'incident-77-2', requestedWallMs: Date.now(), pid: 51 } });
  const secondReceipt = await second.whenRetired;
  assert.equal(secondReceipt.confirmed, true); assert.notEqual(firstReceipt.leaseId, secondReceipt.leaseId);
  assert.notEqual(firstReceipt.attachmentGeneration, secondReceipt.attachmentGeneration);
  assert.equal(f.count('detach'), 2); assert.equal(f.count('main:disconnect'), 2);
  assert.equal(f.count('renderer:Tracing.start'), 2); assert.equal(f.count('renderer:Tracing.end'), 2);
});

test('foreign replacement during a pending STOP cannot receive late cleanup commands', { timeout: 1000 }, async t => {
  const f = harness(t, { hold: ['renderer:Profiler.stop'], holdCompletion: true });
  const report = await f.capture(); f.foreign(); f.resolve('renderer:Profiler.stop');
  const before = f.calls.slice(); f.complete('foreign-stream'); await flush(); await flush();
  assert.deepEqual(f.calls, before); assert.equal(f.count('detach'), 0);
  assert.equal(f.count('renderer:IO.close'), 0); assert.equal((await report.retirement).state, 'unknown');
});

test('armed setup exhaustion creates no READY or renewed recording interval', { timeout: 1000 }, async t => {
  const f = harness(t, { commandCostMs: 2000 });
  const report = await f.capture({ captureOptions: { mode: 'private-armed', durationMs: 40000, samplingIntervalUs: 8000 } });
  assert.equal(f.ready.length, 0); assert.equal(f.timers.length, 0);
  assert.equal((await report.whenRetired).confirmed, true);
  assert.ok(report.errors.includes('armed-setup-incomplete') || report.errors.includes('profile-cleanup-authority-lost'));
});

test('private options cannot extend manual or accept more than 40s / wrong sampling', { timeout: 1000 }, async t => {
  for (const [duration, sampling, manual] of [[40001, 8000, false], [40000, 1000, false], [40000, 8000, true]]) {
    const f = harness(t);
    const report = await f.capture({ request: { id: 'incident-77-1', kind: manual ? 'manual' : 'auto', durationMs: 10000 },
      captureOptions: { mode: 'private-armed', durationMs: duration, samplingIntervalUs: sampling } });
    assert.equal(report.outcome, 'refused'); assert.equal((await report.retirement).confirmed, true);
    assert.equal(f.calls.length, 0);
  }
});

test('manual API keeps its 10 second default and 1ms sampling', { timeout: 1000 }, async t => {
  const f = harness(t);
  const report = await f.capture({ durationMs: 10000,
    request: { id: 'incident-77-1', kind: 'manual', durationMs: 10000, requestedWallMs: Date.now(), owner: f.guard.owner } });
  assert.equal(report.outcome, 'completed'); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].ms, 10000);
  assert.equal(report.samplingIntervalUs, 1000); assert.equal((await report.whenRetired).confirmed, true);
});
