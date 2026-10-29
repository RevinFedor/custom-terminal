'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const file = require.resolve('../hooks/useBuildInstallStatus.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const job = { id: 'J', requestId: 'I', revision: 2, running: true, returnTo: { tabId: '753', sessionId: 'S' } };
const snap = (revision, patch = {}) => ({ version: 1, known: true, stale: false, epoch: 'voice', publication: revision,
  projection: { epoch: 'main', revision }, jobs: [{ ...job, ...patch, projection: { epoch: 'main', revision } }] });
async function fixture(invoke) {
  const { mergeBuildInstallJobs } = await import('./buildInstallPresentation.mjs');
  let state, effect, cleanup;
  const listeners = new Map(), calls = [];
  const react = {
    useState: initial => { state = initial; return [state, update => { state = typeof update === 'function' ? update(state) : update; }]; },
    useEffect: fn => { effect = fn; }, useCallback: fn => fn, useRef: current => ({ current }),
  };
  const ipcRenderer = { on: (name, fn) => listeners.set(name, fn), removeListener: name => listeners.delete(name),
    invoke: async (name, args) => { calls.push([name, args]); return invoke(name, args, calls.length); } };
  const module = { exports: {} };
  vm.runInNewContext(code, { exports: module.exports, module, window: { require: () => ({ ipcRenderer }) },
    require: name => name === 'react' ? react : { mergeBuildInstallJobs }, console });
  const hook = module.exports.useBuildInstallStatus('753');
  cleanup = effect(); await tick();
  return { hook, calls, state: () => state, cleanup, emit: value => listeners.get('build-install:status')?.({}, value) };
}
test('cancel applies the authoritative scoped snapshot even without a subsequent owner event', async () => {
  let reads = 0;
  const h = await fixture(async name => name === 'build-install:cancel' ? { ok: true, continuation: { state: 'cancelled' } }
    : ++reads === 1 ? snap(1) : snap(2, { running: false, cancelled: true, callback: { status: 'sent' }, continuation: { state: 'cancelled' } }));
  await h.hook.cancel(job);
  assert.equal(reads, 2);
  assert.equal(h.state().jobs[0].running, false);
  assert.equal(h.state().jobs[0].continuation.state, 'cancelled');
  h.emit(snap(1)); assert.equal(h.state().jobs[0].running, false);
  h.cleanup();
});
test('a returned cancellation refusal is visible and never fabricates a cancelled job', async () => {
  const h = await fixture(async name => name === 'build-install:cancel' ? { ok: false, error: 'exact owner changed' } : snap(1));
  await h.hook.cancel(job);
  assert.match(h.state().error, /exact owner changed/);
  assert.equal(h.state().jobs[0].running, true);
  assert.equal(h.state().jobs[0].cancelled, undefined);
  h.cleanup();
});
test('failed refresh retains the old job as stale instead of clearing an unknown operation', async () => {
  let reads = 0;
  const h = await fixture(async name => {
    if (name === 'build-install:cancel') return { ok: true };
    if (++reads === 1) return snap(1);
    throw Error('snapshot unavailable');
  });
  await h.hook.cancel(job);
  assert.equal(reads, 2); assert.equal(h.state().stale, true);
  assert.equal(h.state().jobs[0].running, true);
  assert.match(h.state().error, /snapshot unavailable/);
  h.cleanup();
});
test('an old cancel result after unmount cannot refresh or mutate the next owner', async () => {
  let release;
  const h = await fixture(async name => name === 'build-install:cancel' ? new Promise(resolve => { release = resolve; }) : snap(1));
  const pending = h.hook.cancel(job), before = h.state();
  h.cleanup(); release({ ok: false, error: 'late result' }); await pending;
  assert.equal(h.state(), before);
  assert.equal(h.calls.filter(([name]) => name === 'build-install:status-for-tab').length, 1);
});
