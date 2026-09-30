'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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

function fixture(t, external = false) {
  const dbg = new EventEmitter(), wc = new EventEmitter(), calls = [], logs = [];
  let attached = external, current = 0;
  dbg.isAttached = () => attached;
  dbg.attach = () => { calls.push('attach'); attached = true; };
  dbg.detach = () => { calls.push('detach'); attached = false; dbg.emit('detach', {}, 'owned-detach'); };
  dbg.sendCommand = async method => { calls.push(method); return metrics({ Timestamp: ++current, TaskDuration: current / 10, RecalcStyleDuration: current / 20 }); };
  Object.assign(wc, { id: 1, debugger: dbg, isDestroyed: () => false, getOSProcessId: () => 2, isDevToolsOpened: () => false });
  const monitor = createNativePerfMonitor({ webContents: wc, log: s => logs.push(s), autoStart: false });
  t.after(() => monitor.dispose()); return { dbg, wc, calls, logs, monitor };
}
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
  const next = await f.monitor.sample('after-navigation');
  assert.equal(next.nativeFromSeconds, null); assert.equal(next.previousSampleAbs, null);
  assert.equal(next.TaskDurationMs, undefined);
  assert.ok(!f.logs.join('\n').includes('not-logged'));
});
