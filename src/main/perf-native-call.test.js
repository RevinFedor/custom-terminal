'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { observeNativeCall } = require('./perf-native-call');
const { createCausalContext } = require('./perf-causal-context');

function setup(overrides = {}) {
  const records = [], ops = [], logs = [];
  const causal = createCausalContext();
  causal.configure({ enabled: true, sink: r => { records.push(r); return true; },
    metrics: { read: () => process.cpuUsage(), between: start => {
      const cpu = process.cpuUsage(start); return { threadCpuMs: (cpu.user + cpu.system) / 1000 };
    } } });
  const options = { causal, caller: 'heartbeat', target: {}, args: [],
    beginPerfOp: (name, detail) => { ops.push({ name, detail, start: performance.timeOrigin + performance.now() }); return 1; },
    endPerfOp: id => { ops[0].id = id; ops[0].end = performance.timeOrigin + performance.now(); },
    log: message => logs.push(message), ...overrides };
  return { records, ops, logs, options };
}

test('real causal work brackets a known synchronous pause with named op and absolute timestamps', () => {
  const f = setup();
  const result = observeNativeCall({ ...f.options, getter() { const until = performance.now() + 60; while (performance.now() < until) {} return 42; } });
  assert.equal(result, 42);
  const enter = f.records.find(r => r.kind === 'span' && r.phase === 'enter' && r.name === 'native.getAppMetrics');
  const summary = f.records.find(r => r.kind === 'work-summary').workSummary;
  assert.equal(enter.caller, 'heartbeat'); assert.equal(summary.siteId, 'native.getAppMetrics');
  assert.ok(summary.endAbs - summary.startAbs >= 50); assert.ok(summary.threadCpuMs > 0);
  assert.ok(f.ops[0].start <= summary.startAbs && f.ops[0].end >= summary.endAbs);
  assert.equal(f.ops[0].name, 'native.getAppMetrics'); assert.equal(f.ops[0].id, 1);
  assert.match(f.logs[0], /^\[Perf:NativeCall\] name=native\.getAppMetrics caller=heartbeat status=success durationMs=/);
  assert.match(f.logs[0], / startAbs=\d+\.\d endAbs=\d+\.\d coverage=sync-call-wall$/);
});

test('a synchronous wait is not reported as continuous CPU work', () => {
  const f = setup();
  const result = observeNativeCall({ ...f.options, getter() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65);
    return 'wait completed';
  } });
  assert.equal(result, 'wait completed');
  const summary = f.records.find(r => r.kind === 'work-summary').workSummary;
  const wallMs = summary.endAbs - summary.startAbs;
  assert.ok(wallMs >= 50);
  assert.ok(summary.threadCpuMs < wallMs * 0.7, 'test-local process CPU must differ from this wait lifetime');
});

test('unrelated await occurs outside synchronous work', async () => {
  const f = setup();
  await new Promise(resolve => setTimeout(resolve, 30));
  observeNativeCall({ ...f.options, getter: () => 1 });
  const settle = f.records.find(r => r.name === 'native.getAppMetrics' && r.phase === 'settle');
  assert.ok(settle.syncMs < 25); assert.equal(f.logs.length, 0);
});

test('preserves this, arguments, exact result and exception without inspecting either', () => {
  const f = setup(), target = {}, arg = {}, error = new Error('private');
  const result = new Proxy({}, { get() { throw Error('result read'); }, ownKeys() { throw Error('result serialized'); } });
  assert.equal(observeNativeCall({ ...f.options, target, args: [arg], getter(x) { assert.equal(this, target); assert.equal(x, arg); return result; } }), result);
  assert.throws(() => observeNativeCall({ ...f.options, getter() { throw error; } }), e => e === error);
});

test('diagnostics failing before or after callback cannot change outcome or repeat getter', () => {
  for (const causal of [
    { syncWork() { throw Error('before'); } },
    { syncWork(_n, _m, cb) { cb(); throw Error('after'); } },
    { syncWork(_n, _m, cb) { try { cb(); } catch {} throw Error('after error'); } },
    { syncWork(_n, _m, cb) { cb(); cb(); } },
  ]) for (const shouldThrow of [false, true]) {
    let calls = 0; const token = {}, f = setup({ causal, beginPerfOp() { throw Error('begin'); }, endPerfOp() { throw Error('end'); }, log() { throw Error('log'); }, clock: { now: (() => { let t = 0; return () => (t += 20); })() } });
    const run = () => observeNativeCall({ ...f.options, getter() { calls++; if (shouldThrow) throw token; return token; } });
    if (shouldThrow) assert.throws(run, e => e === token); else assert.equal(run(), token);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const f = setup({ endPerfOp() { throw Error('end'); }, log() { throw Error('log'); }, clock: { now: (() => { let t = 0; return () => (t += 20); })() } });
  assert.equal(observeNativeCall({ ...f.options, getter() { calls++; return 7; } }), 7); assert.equal(calls, 1);
});
