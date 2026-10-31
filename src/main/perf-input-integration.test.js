'use strict';

// Actual monitor/preload/core/collector/writer chain. Only Chromium transport,
// clocks and input are finite controls; this is not native GUI acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createNativePerfMonitor } = require('./perf-native-metrics');
const { createInputSnapshotWriter } = require('./perf-input-snapshot-store');
const nativeFixture = require('./perf-input-latency.test.cjs');
const preload = fs.readFileSync(path.join(__dirname, 'perf-native-bootstrap-preload.js'), 'utf8');

test('real preload → native monitor → pre-roll → collector → exclusive file preserves exact input and native stage', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-input-chain-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mainPid = process.pid, rendererPid = mainPid + 10000, origin = performance.timeOrigin;
  let at = origin + 10000, attached = false, trace = [], readAt = 0;
  let recordingResolve;
  const recording = new Promise(resolve => { recordingResolve = resolve; });
  const calls = [], logs = [], timers = new Map(); let timer = 0;
  const dbg = new EventEmitter(), wc = new EventEmitter(), ipc = new EventEmitter();
  const fakeProcess = new EventEmitter(); fakeProcess.isMainFrame = true;
  let monitor;
  const sender = () => ({ sender: wc, senderFrame: wc.mainFrame });
  ipc.send = (channel, payload) => {
    if (channel === 'perf:native-bootstrap-available') monitor.bootstrapAvailable(sender());
    else if (channel === 'perf:native-bootstrap-ack') monitor.bootstrapAck(sender(), payload);
    else if (channel === 'perf:input-clock-ack') monitor.inputClockAck(sender(), payload);
    else assert.fail('unexpected channel ' + channel);
  };
  Object.assign(wc, { id: 7, debugger: dbg, isDestroyed: () => false, isDevToolsOpened: () => false,
    getOSProcessId: () => rendererPid, mainFrame: { parent: null, processId: 4, routingId: 5, osProcessId: rendererPid,
      send: (channel, payload) => ipc.emit(channel, {}, payload) } });
  dbg.isAttached = () => attached;
  dbg.attach = () => { assert.equal(attached, false); attached = true; calls.push('attach'); };
  dbg.detach = () => { assert.equal(attached, true); attached = false; calls.push('detach'); dbg.emit('detach', {}, 'own'); };
  const stream = () => Buffer.from('{"traceEvents":[\n' + trace.map(e => JSON.stringify(e)).join(',\n') + '\n]}');
  dbg.sendCommand = async (method, args) => {
    calls.push(method);
    if (method === 'Performance.enable') return {};
    if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Timestamp', value: at / 1000 }] };
    if (method === 'Tracing.start') { assert.equal(args.traceConfig.traceBufferSizeInKb, 2048); return {}; }
    if (method === 'Tracing.recordClockSyncMarker') {
      trace.push({ name: 'clock_sync', ph: 'c', pid: mainPid, tid: 1, ts: Math.round((at - origin) * 1000), args: { sync_id: args.syncId } });
      return {};
    }
    if (method === 'Tracing.end') {
      dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 'owned-stream', dataLossOccurred: false }); return {};
    }
    if (method === 'IO.read') {
      assert.equal(args.handle, 'owned-stream'); const all = stream(), data = all.subarray(readAt, readAt + args.size);
      readAt += data.length; return { data: data.toString(), eof: readAt >= all.length };
    }
    if (method === 'IO.close') { assert.equal(args.handle, 'owned-stream'); return {}; }
    assert.fail('unallowed command ' + method);
  };
  const writer = createInputSnapshotWriter({ directory, mainPid, windowId: wc.id, log: line => logs.push(line) });
  monitor = createNativePerfMonitor({ webContents: wc, autoStart: false, now: () => at,
    schedule(fn, ms) { const id = ++timer; timers.set(id, { fn, ms }); return id; }, cancel(id) { timers.delete(id); },
    inputPreroll: { publish: writer.publish }, // No test factory/collector substitution.
    log(line) { logs.push(line); if (line.startsWith('[Perf:InputPreroll]') && JSON.parse(line.slice(line.indexOf('{'))).state === 'recording') recordingResolve(); },
  });
  t.after(() => monitor.dispose());
  new vm.Script('(function(require,process){' + preload + '\n})').runInNewContext({
    window: { performance: { timeOrigin: origin, now: () => at - origin } },
  })(name => name === 'electron' ? { ipcRenderer: ipc } : require(name), fakeProcess);
  wc.emit('did-frame-navigate', {}, 'private-not-logged', 200, 'OK', true, 4, 5);
  fakeProcess.emit('loaded'); await monitor.sample(); await recording;
  assert.equal(monitor.inputState().phase, 'recording');

  const original = nativeFixture.events.flatMap(e => e.args?.chrome_latency_info?.component_info || [])
    .find(c => c.component_type === 'COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL').time_us;
  const shift = 10010000 - original;
  trace.push(...structuredClone(nativeFixture.events.filter(e => e.name !== 'clock_sync')).map(e => {
    e.pid = e.pid === nativeFixture.options.mainPid ? mainPid : rendererPid;
    if (e.ph !== 'M') e.ts += shift; // Thread metadata starts at zero, not the input clock.
    for (const c of e.args?.chrome_latency_info?.component_info || []) c.time_us += shift;
    return e;
  }));
  trace.push({ name: 'private-unknown', ph: 'X', pid: rendererPid, tid: 1, ts: 10010000, dur: 1,
    args: { key: 'PRIVATE-KEY', text: 'PRIVATE-BODY', point_x: 1234 } });
  at += 400;
  const action = { id: 'ui-' + Math.floor(origin + 10000).toString(36) + '-1', event: 'pointerdown',
    kind: 'second-frame', startAbs: origin + 10010, durationMs: 200, inputDelayMs: 1,
    documentTimeOriginMs: origin, nativeOriginal: { type: 'pointerdown', timeStampMs: 10010, pointerType: 'mouse' } };
  assert.equal(monitor.observeInput(action, { sender: wc, senderFrame: { ...wc.mainFrame, parent: {} } }), false);
  assert.equal(monitor.observeInput(action, sender()), true);
  const resume = monitor.suspend('control-profile', { preserve: true }); await resume.ready;
  const files = fs.readdirSync(directory).filter(f => f.endsWith('.input.json'));
  assert.equal(files.length, 1, logs.join('\n'));
  const text = fs.readFileSync(path.join(directory, files[0]), 'utf8'), saved = JSON.parse(text);
  assert.equal(saved.actions[0].id, action.id); assert.equal(saved.scope.rendererPid, rendererPid);
  assert.equal(saved.evidence.trigger.status, 'matched', JSON.stringify(saved.evidence.trigger));
  assert.equal(saved.evidence.flows[0].largestMeasuredStage.name, 'RendererMainProcessing');
  assert.equal(saved.evidence.flows[0].largestMeasuredStage.durationMs, 152.539);
  assert.equal(saved.cleanupConfirmed, true); assert.equal(saved.exportComplete, true);
  assert.equal(saved.dataLoss, false); assert.equal(saved.cpuProfiler, false);
  assert.equal(fs.statSync(path.join(directory, files[0])).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(text) <= 256 * 1024);
  assert.doesNotMatch(text, /PRIVATE-KEY|PRIVATE-BODY|point_x|sync_id/);
  const summaryLine = logs.find(line => line.startsWith('[Perf:InputPath] '));
  assert.ok(summaryLine, 'saved native evidence also has a concise layer explanation');
  const summary = JSON.parse(summaryLine.slice(summaryLine.indexOf('{')));
  assert.equal(summary.actionId, action.id); assert.equal(summary.artifact, files[0]);
  assert.equal(summary.largestMeasuredStage.meaning, 'обработка события интерфейсом');
  assert.equal(summary.largestMeasuredStage.durationMs, 152.539);
  assert.match(summary.cause, /not a function or root-cause verdict/);
  for (const method of ['Tracing.start','Tracing.end','IO.close','detach']) assert.equal(calls.filter(x => x === method).length, 1, method);
  assert.equal(attached, false); assert.equal(timers.size, 0);
});
