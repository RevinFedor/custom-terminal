import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';

// Compile the actual three modules. Only browser/Electron/socket participants
// are substituted: no UI dispatch, real timers, IPC, profiling or network.
const compiled = new Map(['uiPerformanceDiagnostics.mjs', 'perfIncidentChannel.ts', 'perfFreezeProbe.ts'].map(name => [name,
  transformSync(readFileSync(new URL(name, import.meta.url), 'utf8'), { loader: name.endsWith('.ts') ? 'ts' : 'js',
    format: 'cjs', target: 'node18', define: { 'import.meta.env.DEV': 'true' } }).code]));

function harness() {
  let at = 1000, timerSeq = 0;
  const intervals = new Map(), timeouts = new Map(), listeners = new Map(), logs = [], native = [], sockets = [], observers = [];
  const performance = { timeOrigin: 100000, now: () => at };
  class Socket extends EventEmitter {
    writable = true; writableLength = 0; destroyed = false; lines = []; acceptsMore = true;
    write(line) { this.lines.push(JSON.parse(line)); return this.acceptsMore; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  class Element {
    tagName = 'BUTTON'; id = ''; classList = []; isConnected = true;
    closest(selector) {
      assert.equal(this.isConnected, true, 'reports may not revisit the removed target');
      const attrs = { '[data-insp-path]': ['data-insp-path', 'Control.tsx'],
        '[data-tab-id]': ['data-tab-id', 'test-tab'], '[data-history-owner]': ['data-history-owner', 'test-owner'] };
      const attr = attrs[selector];
      return attr ? { getAttribute: name => name === attr[0] ? attr[1] : '25' } : null;
    }
    get textContent() { throw Error('no target text'); }
    get value() { throw Error('no target value'); }
    get href() { throw Error('no URLs'); }
    getBoundingClientRect() { throw Error('no layout'); }
  }
  class PerformanceObserver {
    static supportedEntryTypes = ['event'];
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.type = options.type; }
  }
  const document = { visibilityState: 'visible', hasFocus: () => true, styleSheets: [],
    activeElement: null, body: { style: {} }, documentElement: { style: {} } };
  const ipcRenderer = {
    invoke: async channel => { assert.equal(channel, 'perf:watchdog-info'); return { socketPath: '/fake/watchdog' }; },
    send: (channel, payload) => native.push({ channel, payload }),
  };
  const window = {
    require: name => {
      if (name === 'electron') return { ipcRenderer };
      if (name === 'process') return { pid: 42 };
      if (name === 'net') return { createConnection: () => { const socket = new Socket(); sockets.push(socket); return socket; } };
      throw Error('unexpected dependency ' + name);
    },
    setInterval: (fn, ms) => { intervals.set(++timerSeq, { fn, ms }); return timerSeq; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++timerSeq, { fn, ms }); return timerSeq; },
    clearTimeout: id => timeouts.delete(id),
    requestAnimationFrame: () => {},
    addEventListener: (type, callback, options) => { listeners.set(type, { callback, options }); },
  };
  const globals = { window, document, performance, Element, PerformanceObserver,
    MutationObserver: class { observe() {} }, console: { warn: message => logs.push(message) } };
  function load(name, deps) {
    const module = { exports: {} };
    new Function('module', 'exports', 'require', ...Object.keys(globals), compiled.get(name))(
      module, module.exports, name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; }, ...Object.values(globals));
    return module.exports;
  }
  const ui = load('uiPerformanceDiagnostics.mjs', {});
  const channel = load('perfIncidentChannel.ts', { './uiPerformanceDiagnostics.mjs': ui });
  const probe = load('perfFreezeProbe.ts', {
    './uiPerformanceDiagnostics.mjs': ui, './perfIncidentChannel': channel,
    '../store/useWorkspaceStore': { useWorkspaceStore: { getState: () => ({ view: 'workspace', openProjects: new Map() }) } },
    './rendererActivityTrail': { attributeFreeze: () => '', recentRendererActivities: () => '', markRendererActivity: () => {} },
    './interactionCursor': { getInteractionCursor: () => '' },
  });
  return { probe, channel, ui, Element, intervals, timeouts, listeners, logs, native, sockets, observers, time: value => { at = value; } };
}

test('actual probe emits safe Meta down/up, printable-key and slow-input summaries with captured targets and native counters', async () => {
  const h = harness(); h.probe.installPerfFreezeProbe();
  await Promise.resolve();
  h.sockets[0].emit('connect');
  const timing = h.observers.find(observer => observer.type === 'event');
  const packets = h.sockets[0].lines;
  for (const [at, type, key, meta, expected] of [
    [1000, 'keydown', 'Meta', true, 'Meta'], [2200, 'keyup', 'Meta', false, 'Meta'],
    [3400, 'keydown', 'SECRET-PRINTABLE', true, 'Other'],
  ]) {
    h.time(at); const target = new h.Element();
    h.listeners.get(type).callback({ type, key, metaKey: meta, ctrlKey: true, altKey: false, shiftKey: true,
      repeat: type === 'keydown', timeStamp: at - 10, target,
      get code() { throw Error('no printable code'); }, get text() { throw Error('no printable text'); } });
    target.isConnected = false;
    timing.callback({ getEntries: () => [{ name: type, startTime: at - 10, duration: 200,
      processingStart: at, processingEnd: at + 70, interactionId: at, target: null }] });
    const incident = packets.at(-1);
    assert.equal(incident.t, 'incident'); assert.equal(incident.keyClass, expected);
    assert.equal(incident.meta, meta); assert.equal(incident.ctrl, true); assert.equal(incident.alt, false);
    assert.equal(incident.shift, true); assert.equal(incident.repeat, type === 'keydown');
    assert.equal(incident.targetSource, 'Control.tsx:25'); assert.equal(incident.targetTag, 'button');
    assert.equal(incident.tabId, 'test-tab'); assert.equal(incident.historyOwner, 'test-owner');
    assert.equal(incident.target, undefined, 'wire target fields are flat');
    assert.deepEqual([incident.inputDelayMs, incident.handlerMs, incident.presentationMs], [10, 70, 120]);
    assert.equal(incident.coverage, h.ui.UI_ACTION_COVERAGE);
    const eventLog = h.logs.findLast(line => line.startsWith('[Perf:EventTiming]'));
    assert.ok(eventLog.includes('actionId=' + incident.actionId));
    assert.ok(eventLog.includes('keyClass=' + expected + ' meta=' + Number(meta)));
    const actionLog = JSON.parse(h.logs.findLast(line => line.startsWith('[Perf:UIAction]')).split(' appView=')[0].slice(16));
    assert.equal(actionLog.id, incident.actionId); assert.equal(actionLog.keyClass, expected);
    assert.equal(h.native.at(-1).channel, 'perf:ui-summary');
    assert.equal(h.native.at(-1).payload.id, incident.actionId);
    assert.deepEqual(Object.keys(h.native.at(-1).payload).sort(), ['durationMs', 'event', 'id', 'startAbs']);
  }
  h.time(4600);
  h.listeners.get('keyup').callback({ type: 'keyup', key: 'Meta', metaKey: false, timeStamp: 4100, target: new h.Element() });
  const delayed = packets.at(-1);
  assert.equal(delayed.kind, 'input-keyup'); assert.match(delayed.actionId, /^ui-/);
  assert.equal(delayed.inputDelayMs, 500); assert.equal(delayed.handlerMs, null); assert.equal(delayed.presentationMs, null);
  timing.callback({ getEntries: () => [{ name: 'keyup', startTime: 4100, duration: 600,
    processingStart: 4600, processingEnd: 4610, target: null }] });
  assert.equal(packets.at(-1), delayed, 'same-second EventTiming is intentionally throttled');
  h.time(4700);
  const logCount = h.logs.length;
  h.listeners.get('keydown').callback({ type: 'keydown', key: 'Alt', altKey: true, timeStamp: 4200, target: new h.Element() });
  assert.equal(h.logs.length, logCount, 'the existing console throttle still applies');
  for (const { fn } of h.intervals.values()) fn();
  const heartbeat = packets.at(-1);
  assert.equal(heartbeat.diagnosticHealth.drops.rateLimit, 2, 'console-throttled slow input must also register loss');
  assert.doesNotMatch(JSON.stringify([packets, h.logs, h.native]), /SECRET|"code"|"text"/);
  assert.equal(h.listeners.get('keyup').options.passive, true);
});

test('actual heartbeat reconnect retains identity and health, creates one timer and cancels pending reconnect on unload', async () => {
  const h = harness(); h.probe.installWatchdogHeartbeat();
  await Promise.resolve();
  const first = h.sockets[0];
  const staleConnect = first.listeners('connect')[0];
  first.emit('connect');
  assert.equal(h.intervals.size, 1); assert.equal(h.timeouts.size, 0);
  const beat = () => { for (const { fn, ms } of h.intervals.values()) { assert.equal(ms, 250); fn(); } };
  first.acceptsMore = false; beat(); beat();
  assert.equal(first.lines.length, 1, 'backpressure does not queue heartbeats');
  first.emit('error', Error('closed'));
  assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 1);
  assert.equal(first.destroyed, true);
  h.channel.reportPerfIncident('ui-keydown', 100000, 150, 'ui-test-1');
  const [id, retry] = [...h.timeouts][0]; h.timeouts.delete(id);
  assert.equal(retry.ms, 1000); retry.fn();
  const next = h.sockets[1]; next.emit('connect');
  assert.equal(h.intervals.size, 1);
  staleConnect(); assert.equal(h.intervals.size, 1, 'late old socket connect cannot replace the writer');
  h.time(2000); beat();
  const hb = next.lines[0];
  assert.equal(hb.sourceBoot, first.lines[0].sourceBoot);
  assert.equal(hb.sourceSeq, 4); assert.equal(hb.emittedAbs, 102000);
  assert.deepEqual(hb.diagnosticHealth.drops, { noConnection: 1, rateLimit: 0, backpressure: 1, writeThrow: 0 });
  next.emit('close'); assert.equal(h.timeouts.size, 1);
  h.listeners.get('beforeunload').callback();
  assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
});
