'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { observeNativeCall } = require('./perf-native-call');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function slice(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'actual Main source boundary');
  return source.slice(a, b);
}
function fixture() {
  let time = 0, calls = 0, error = null;
  const observations = [], completedOps = [], sent = [];
  const app = { getAppMetrics() {
    assert.equal(this, app);
    calls++;
    if (error) throw error;
    return [{ pid: 71, type: 'Browser' }, { pid: 72, type: 'Tab' }, { pid: 72 }, { pid: null }];
  } };
  const context = vm.createContext({
    app, process: { pid: 71 }, Set, Number, observeNativeCall,
    nodePerformance: { now: () => time, timeOrigin: 1000 },
    perfWatchdog: { connected: true },
    perfCausal: {
      syncWork(name, detail, fn) { observations.push({ name, ...detail }); return fn(); },
      snapshot() { return {}; },
    },
    beginPerfOp: () => 'native-test-op', endPerfOp: id => completedOps.push(id),
    perfActiveOps: new Map(), summarizePerfOps: () => '',
    collectMetricsTabs: () => [{ pid: 73, tabId: 'owned-test-tab' }],
    perfCausalTransport: {
      sendHeartbeat(get, done) { sent.push(get()); done(); return true; }, snapshot: () => ({}),
    },
    setInterval: (fn, ms) => { assert.equal(ms, 250); context.tick = fn; return 1; },
    console: { warn() {} },
  });
  return { context, app, observations, completedOps, sent,
    calls: () => calls, time: value => { time = value; }, fail: value => { error = value; } };
}

test('actual resource collector preserves PID filtering, fallback and one native query', () => {
  const f = fixture();
  vm.runInContext(slice('function collectAppPids() {', '/** Живые вкладки') + '\nthis.collect = collectAppPids;', f.context);
  assert.deepEqual(Array.from(f.context.collect()), [71, 72]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.observations, [{ name: 'native.getAppMetrics', caller: 'collectAppPids' }]);
  f.fail(new Error('native getter unavailable'));
  assert.deepEqual(Array.from(f.context.collect()), [71]);
  assert.equal(f.calls(), 2);
  assert.equal(f.completedOps.length, 2);
});

test('actual heartbeat keeps the existing 5s context cadence and disconnected guard', () => {
  const f = fixture();
  vm.runInContext(slice('    let contextDueAt = 0;', "    if (typeof hbTimer.unref === 'function')"), f.context);
  f.context.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.sent[0].context.appPids.length, 4);
  f.time(250); f.context.tick();
  assert.equal(f.calls(), 1, 'ordinary heartbeat must not add a native query');
  assert.equal(f.sent[1].context, undefined);
  f.time(5000); f.context.tick();
  assert.equal(f.calls(), 2);
  assert.ok(f.observations.every(x => x.name === 'native.getAppMetrics' && x.caller === 'heartbeat'));
  f.context.perfWatchdog.connected = false;
  f.time(10000); f.context.tick();
  assert.equal(f.calls(), 2);
});
