// Executes the REAL installIpcDeliveryAttribution (sliced out of
// perfFreezeProbe.ts and compiled) against a fake ipcRenderer.
//
// Why it exists: 63 long tasks totalling 7.7s in one 2-hour boot reported
// `during=none-marked recent=none`. The renderer has 241 separate
// `ipcRenderer.on` registrations and no shared dispatcher, so the marks are
// installed by wrapping the emitter itself. That is a delivery path for every
// message in the app, so the tests below care far more about "delivery is
// unchanged" than about the marking: a dropped argument, a swallowed throw or
// a listener that cannot be removed would be a far worse bug than an
// unnamed freeze.
//
// Run: node --experimental-strip-types --test \
//   src/renderer/utils/ipcDeliveryAttribution.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');

const sourcePath = process.env.NOTED_TEST_PROBE_SOURCE || resolve(HERE, 'perfFreezeProbe.ts');
const source = readFileSync(sourcePath, 'utf8');

const from = source.indexOf('function installIpcDeliveryAttribution');
assert.ok(from > 0, 'installIpcDeliveryAttribution must exist');
const to = source.indexOf('\nexport function installWatchdogHeartbeat', from);
assert.ok(to > from, 'the function must be sliceable');
const code = transformSync(source.slice(from, to), { loader: 'ts' }).code;

function build({ marks = [], logs = [] } = {}) {
  const listeners = new Map();
  const ipc = {
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(listener);
      return this;
    },
    once(channel, listener) { return this.on(channel, listener); },
    addListener(channel, listener) { return this.on(channel, listener); },
    prependListener(channel, listener) { return this.on(channel, listener); },
    prependOnceListener(channel, listener) { return this.on(channel, listener); },
    removeListener(channel, listener) {
      const list = listeners.get(channel) || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return this;
    },
    off(channel, listener) { return this.removeListener(channel, listener); },
  };
  const sandbox = {
    window: { require: (name) => name === 'electron' ? { ipcRenderer: ipc } : null },
    performance: { now: () => sandbox.__now },
    __now: 0,
    markRendererActivity: (label) => {
      const mark = { label, open: true };
      marks.push(mark);
      return () => { mark.open = false; };
    },
    getContext: () => 'ctx',
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nmodule.exports = installIpcDeliveryAttribution;', sandbox);
  sandbox.module.exports((line) => logs.push(line));
  const deliver = (channel, ...args) => (listeners.get(channel) || [])
    .slice().map(listener => listener.call(ipc, ...args));
  return { ipc, deliver, listeners, sandbox, marks, logs };
}

test('delivery is unchanged: arguments, `this`, and return value', () => {
  const { ipc, deliver } = build();
  const seen = [];
  ipc.on('terminal:data', function (...args) { seen.push({ args, self: this }); return 'result'; });
  const returned = deliver('terminal:data', { sender: 1 }, 'payload', 42);
  assert.deepEqual(seen[0].args, [{ sender: 1 }, 'payload', 42], 'every argument reaches the listener');
  assert.equal(seen[0].self, ipc, '`this` is preserved');
  assert.deepEqual(returned, ['result'], 'the return value passes through');
});

test('a throwing listener is isolated, reported, and its mark is closed', () => {
  // Contract CHANGED on 01.11 and this test was updated to the new one.
  // It used to assert that the throw propagates. In production that was the
  // bug: ipcRenderer is a plain EventEmitter, so a throwing listener stopped
  // every LATER subscriber of the same channel — History received none of 141
  // `agent-transcript:changed` events and nothing was logged. Delivery to
  // siblings now outranks propagating one subscriber's failure.
  const marks = [];
  const logs = [];
  const { ipc, deliver } = build({ marks, logs });
  const reached = [];
  ipc.on('claude:busy-state', () => { throw new Error('listener exploded'); });
  ipc.on('claude:busy-state', () => reached.push('sibling'));
  assert.doesNotThrow(() => deliver('claude:busy-state', {}));
  assert.deepEqual(reached, ['sibling'], 'a later subscriber of the same channel still runs');
  assert.ok(logs.some(line => line.includes('[IpcListenerError]') && line.includes('listener exploded')),
    'the failure is reported, not swallowed silently');
  assert.ok(marks.length >= 1, 'the delivery was marked');
  assert.ok(marks.every(mark => !mark.open), 'no mark is left open after a throw');
});

test('a throwing ATTRIBUTION mark never breaks delivery', () => {
  // The 01.11 regression itself: `markRendererActivity` was only re-exported,
  // so calling it threw on every marked delivery and starved all later
  // subscribers. Diagnostics must never be able to do that again.
  const marks = [];
  const { ipc, deliver, sandbox } = build({ marks });
  sandbox.markRendererActivity = () => { throw new Error('mark is not defined'); };
  const reached = [];
  ipc.on('agent-transcript:changed', () => reached.push('history'));
  assert.doesNotThrow(() => deliver('agent-transcript:changed', {}));
  assert.deepEqual(reached, ['history'], 'the real listener still receives the event');
});

test('removeListener finds the wrapper, so unmount really detaches', () => {
  // The worst failure mode of this change: a component unmounts, its listener
  // stays attached through the wrapper, and it keeps reacting forever.
  const { ipc, deliver, listeners } = build();
  const listener = () => {};
  ipc.on('history:changed', listener);
  assert.equal(listeners.get('history:changed').length, 1);
  ipc.removeListener('history:changed', listener);
  assert.equal(listeners.get('history:changed').length, 0, 'the listener must be gone');
  assert.deepEqual(deliver('history:changed'), [], 'nothing is delivered after removal');
});

test('off() detaches too, and the same listener on two channels stays separate', () => {
  const { ipc, listeners } = build();
  const listener = () => {};
  ipc.on('a', listener);
  ipc.on('b', listener);
  ipc.off('a', listener);
  assert.equal(listeners.get('a').length, 0, 'channel a detached');
  assert.equal(listeners.get('b').length, 1, 'channel b is untouched');
});

test('the same listener registered twice is wrapped once (stable identity)', () => {
  const { ipc, listeners } = build();
  const listener = () => {};
  ipc.on('dup', listener);
  ipc.on('dup', listener);
  const [first, second] = listeners.get('dup');
  assert.equal(first, second, 'one listener maps to one wrapper');
});

test('a non-function listener is passed through untouched', () => {
  const { ipc } = build();
  assert.doesNotThrow(() => ipc.on('weird', undefined));
});

test('cheap channels are sampled, not marked on every delivery', () => {
  // terminal:data fires thousands of times per minute and the activity trail
  // holds 80 entries. Marking each delivery would evict the very activity a
  // freeze needs named.
  const marks = [];
  const { ipc, deliver } = build({ marks });
  ipc.on('terminal:data', () => {});
  for (let i = 0; i < 200; i++) deliver('terminal:data', {}, 'chunk');
  assert.ok(marks.length < 20, `a cheap channel must not mark 200 times (got ${marks.length})`);
  assert.ok(marks.length >= 1, 'but it is still sampled');
});

test('a slow channel keeps being marked', () => {
  const marks = [];
  const { ipc, deliver, sandbox } = build({ marks });
  ipc.on('history:rows', () => { sandbox.__now += 40; });
  for (let i = 0; i < 12; i++) deliver('history:rows', {});
  assert.ok(marks.length >= 10, `a slow channel must stay marked (got ${marks.length})`);
  assert.ok(marks.every(mark => mark.label === 'ipc:history:rows'), 'marks are named after the channel');
});

test('a slow delivery is reported once per new worst case', () => {
  const logs = [];
  const { ipc, deliver, sandbox } = build({ logs });
  ipc.on('history:rows', () => { sandbox.__now += 80; });
  deliver('history:rows', {});
  const reports = logs.filter(line => line.includes('[Perf:IpcDelivery]'));
  assert.equal(reports.length, 1, 'the first slow delivery is reported');
  assert.match(reports[0], /channel=history:rows/);
  assert.match(reports[0], /handlerMs=8[0-9]\.\d/);
});

test('installing twice does not double-wrap', () => {
  const marks = [];
  const { ipc, deliver, sandbox, logs } = build({ marks });
  sandbox.module.exports((line) => logs.push(line)); // second install attempt
  ipc.on('terminal:data', () => {});
  deliver('terminal:data', {});
  assert.ok(marks.length <= 1, 'one delivery produces at most one mark');
});
