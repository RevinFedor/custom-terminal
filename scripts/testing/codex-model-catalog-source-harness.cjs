'use strict';
// Finite SOURCE fixture. Executes the actual catalog functions with explicit
// runner/filesystem substitutes; never imports Electron or launches Codex.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
function fakeBinding(command, args) {
  const recipe = args.length === 2 ? 'live' : 'bundled';
  const factsDigest = createHash('sha256').update(JSON.stringify([command, args])).digest('hex');
  return { before: { status: 'qualified', factsDigest, context: { recipe,
    cwdDigest: 'a'.repeat(64), pathDigest: 'b'.repeat(64), loaderContextDigest: 'c'.repeat(64) },
    fixtureSubstitution: 'fake filesystem binding; not native launch proof' },
  finish: () => ({ status: 'qualified', reason: 'matched', factsDigest, matched: true }) };
}
function sourceHarness({ run, sourcePath, binding = fakeBinding, identity,
  onChange, nowWall, nowMono } = {}) {
  const source = fs.readFileSync(sourcePath || path.resolve(__dirname, '../../src/main/ipc/codex-data.js'), 'utf8');
  const start = source.indexOf('function normalizeCodexModel(');
  const end = source.indexOf('async function loadSessionRecords(', start);
  if (start < 0 || end <= start) throw Error('actual catalog source boundary drift');
  const logs = [];
  const context = vm.createContext({ execFile: run, setTimeout, clearTimeout, Buffer,
    performance: nowMono ? { now: nowMono } : performance,
    Date: nowWall ? class extends Date { static now() { return nowWall(); } } : Date,
    beginCatalogLaunchBinding: binding,
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    buildChildProcessEnv: x => x, buildCodexProcessPath: () => '/finite-only',
    safeJsonParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } } });
  vm.runInContext('let modelCache = null, modelCacheInflight = null; const MODEL_CACHE_TTL_MS = 300000;\n'
    + source.slice(start, end)
    + '\nglobalThis.api = { listCodexModels, disposeCodexModelCatalog, bindCodexModelCatalogRuntime, getCodexModelCatalogLifecycle, createCodexModelCatalogLifecycle };', context);
  if (identity && !context.api.bindCodexModelCatalogRuntime(identity, onChange)) throw Error('source fixture identity refused');
  return { ...context.api, logs, substitution: 'actual lifecycle with finite fake runner/binding' };
}
function pendingRun() {
  const calls = [];
  const run = (command, args, options, callback) => {
    const child = Object.assign(new EventEmitter(), { pid: 2000 + calls.length,
      exitCode: null, signalCode: null, killed: false, signals: [],
      kill(signal) { this.signals.push(signal); this.killed = true; return true; } });
    calls.push({ command, args: [...args], options, callback, child }); return child;
  };
  const spawn = i => calls[i].child.emit('spawn');
  const callback = (i, error = null, stdout = '[{"slug":"fixture-live"}]') => calls[i].callback(error, stdout);
  const close = (i, code = 0, signal = null) => {
    const child = calls[i].child; child.exitCode = code; child.signalCode = signal;
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  return { run, calls, spawn, callback, close };
}
module.exports = { sourceHarness, pendingRun, fakeBinding };
