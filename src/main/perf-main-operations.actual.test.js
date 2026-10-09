'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createCausalContext } = require('./perf-causal-context');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const from = source.indexOf('const perfActiveOps = ');
  const end = source.indexOf('function perfFreezeSeverity(ms)', from);
  assert.ok(from > 0 && end > from);
  let time = 0;
  const handlers = new Map(), logs = [], ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => { if (handlers.has(channel)) throw Error('duplicate'); handlers.set(channel, fn); };
  const causal = createCausalContext({ now: () => 1000 + time });
  causal.configure({ enabled: true, sink: () => true });
  const context = vm.createContext({ global: {}, Map, Set, ipcMain, perfCausal: causal,
    nodePerformance: { now: () => time, timeOrigin: 1000 }, console: { warn: text => logs.push(text) } });
  vm.runInContext(source.slice(from, end) + '\nglobal.result={summarizePerfOps,summarizeRecentPerfOps,summarizeIpcAgg,perfActiveOps};', context);
  return { ipcMain, handlers, logs, state: context.global.result, tick: n => { time += n; } };
}

test('actual universal Main wrapper reports long await separately from synchronous execution', async () => {
  const f = fixture(); let release;
  f.ipcMain.handle('test:deferred', () => { f.tick(3); return new Promise(resolve => { release = resolve; }); });
  const result = f.handlers.get('test:deferred')({}, { tabId: 'tab-1' });
  f.tick(1000);
  assert.match(f.state.summarizePerfOps(), /state=awaiting:syncMs=3\.0/);
  release('same-result'); assert.equal(await result, 'same-result');
  assert.match(f.logs[0], /lifetimeMs=1003\.0 syncMs=3\.0 returnedPromise=1/);
  assert.match(f.state.summarizeIpcAgg(), /scope=lifetime:syncSum=3\.0:syncMax=3\.0/);
});

test('actual sync Main callback is visible while running; errors and duplicate registration remain unchanged', () => {
  const f = fixture(); const error = new Error('expected');
  f.ipcMain.handle('test:sync', () => { assert.match(f.state.summarizePerfOps(), /state=executing/); f.tick(320); throw error; });
  assert.throws(() => f.handlers.get('test:sync')({}), e => e === error);
  assert.equal(f.state.perfActiveOps.size, 0);
  assert.match(f.logs[0], /syncMs=320\.0 returnedPromise=0/);
  assert.throws(() => f.ipcMain.handle('test:sync', () => 1), /duplicate/);
});

test('actual wrapped on/removeListener and hot event return semantics survive diagnostics', () => {
  const f = fixture(); let count = 0;
  const handler = () => { count++; f.tick(1); };
  f.ipcMain.on('terminal:resize', handler); f.ipcMain.emit('terminal:resize', {});
  f.ipcMain.removeListener('terminal:resize', handler); f.ipcMain.emit('terminal:resize', {});
  assert.equal(count, 1); assert.equal(f.state.perfActiveOps.size, 0);
  assert.equal(f.state.summarizeRecentPerfOps(), '');
  assert.match(f.state.summarizeIpcAgg(), /terminal:resize:n=1/);
});

test('actual Main causal sender counts asynchronous channel errors instead of treating enqueue as delivery', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const from = source.indexOf('const { causal: perfCausal, boundedCallerToken:');
  const end = source.indexOf('const perfActiveOps = ', from);
  let sink, failures = 0; const callbacks = [];
  const context = vm.createContext({ process: { env: { NOTED_E2E_TEST: 'true' } }, path, srcMainDir: __dirname,
    app: { once() {} }, require: name => name.endsWith('perf-causal-context')
      ? { causal: { configure: options => { sink = options.sink; }, transportFailed: () => { failures++; } } }
      : { createThreadMetrics: () => null } });
  vm.runInContext(source.slice(from, end) + '\nthis.connect=(sender)=>{perfWatchdog=sender;};', context);
  context.connect({ connected: true, send(_value, callback) { callbacks.push(callback); } });
  assert.equal(sink({}), true); assert.equal(sink({}), true);
  callbacks.forEach(callback => callback(Error('channel closed')));
  assert.equal(failures, 2);
});
