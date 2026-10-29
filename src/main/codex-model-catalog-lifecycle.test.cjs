'use strict';
// Finite source/Node-child controls only. Never imports Electron or runs Codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { execFile } = require('node:child_process');
const v8 = require('node:v8');
const source = fs.readFileSync(process.env.CODEX_CATALOG_TEST_SOURCE || require.resolve('./ipc/codex-data'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function harness(run) {
  const logs = [];
  const context = vm.createContext({ execFile: run, setTimeout, clearTimeout,
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    buildChildProcessEnv: x => x, buildCodexProcessPath: () => '/finite-only',
    safeJsonParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } },
  });
  vm.runInContext('let modelCache = null, modelCacheInflight = null; const MODEL_CACHE_TTL_MS = 300000;\n'
    + section('function normalizeCodexModel(', 'async function loadSessionRecords(')
    + '\nglobalThis.api = {listCodexModels, disposeCodexModelCatalog, createCodexModelCatalogLifecycle};', context);
  return { ...context.api, logs };
}
function pendingRun() {
  const calls = [];
  const run = (command, args, options, callback) => {
    const child = Object.assign(new EventEmitter(), { pid: 2000 + calls.length, exitCode: null,
      signalCode: null, killed: false, signals: [], kill(signal) { this.signals.push(signal); this.killed = true; return true; } });
    calls.push({ command, args, options, callback, child });
    return child;
  };
  const close = (i, error = null, stdout = '[{"slug":"fixture-live"}]') => {
    const { child, callback } = calls[i];
    child.exitCode = error ? 1 : 0;
    callback(error, stdout);
    child.emit('close', child.exitCode, child.signalCode);
  };
  return { run, calls, close };
}

test('entire V8 heap is bounded below 128MiB', () => {
  assert.ok(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 * 1024);
});
test('normal live single-flight and TTL retain the real catalog result', async () => {
  const f = pendingRun(), h = harness(f.run);
  const pending = Array.from({ length: 40 }, () => h.listCodexModels());
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.shell, false);
  f.close(0);
  const result = await Promise.all(pending);
  assert.ok(result.every(r => r === result[0]));
  assert.equal(result[0][0].id, 'fixture-live');
  assert.equal(await h.listCodexModels(), result[0]);
  assert.equal(f.calls.length, 1);
  assert.equal((await h.disposeCodexModelCatalog()).settled, true);
  assert.deepEqual(f.calls[0].child.signals, [], 'completed child never signalled');
  await assert.rejects(h.listCodexModels(), { code: 'CODEX_MODEL_CATALOG_CLOSED' });
});
test('Quit cancels only its exact live handle, settles all waiters, and never starts bundled fallback', async () => {
  const f = pendingRun(), h = harness(f.run);
  const pending = h.listCodexModels();
  const rejected = assert.rejects(pending, { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  const disposal = h.disposeCodexModelCatalog();
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.equal(h.disposeCodexModelCatalog(), disposal, 'one cancellation, no replay');
  await assert.rejects(h.listCodexModels(), { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  let settled = false; disposal.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false, 'signal delivery is not child settlement');
  f.close(0, Object.assign(new Error('terminated'), { code: 'SIGTERM' }), '');
  await rejected; assert.equal((await disposal).settled, true);
  assert.equal(f.calls.length, 1);
});
test('normal live failure retains bundled and builtin compatibility fallbacks', async () => {
  const f = pendingRun(), h = harness(f.run), pending = h.listCodexModels();
  f.close(0, Object.assign(new Error('live'), { code: 'EFAIL' }), '');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].args.includes('--bundled'));
  f.close(1, Object.assign(new Error('bundled'), { code: 'EFAIL' }), '');
  assert.ok((await pending).some(m => m.id === 'gpt-5.6-sol'));
  assert.equal((await h.disposeCodexModelCatalog()).settled, true);
});
test('Quit also owns a bundled attempt already started', async () => {
  const f = pendingRun(), h = harness(f.run), pending = h.listCodexModels();
  const rejected = assert.rejects(pending, { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  f.close(0, new Error('live failed'), '');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 2);
  const disposal = h.disposeCodexModelCatalog();
  assert.deepEqual(f.calls[0].child.signals, []);
  assert.deepEqual(f.calls[1].child.signals, ['SIGTERM']);
  f.close(1, new Error('cancelled'), ''); await rejected;
  assert.equal((await disposal).settled, true);
});
test('a deadline is UNKNOWN; retain the owned handle and never signal it again', async () => {
  const f = pendingRun(), h = harness(f.run), owner = h.createCodexModelCatalogLifecycle(f.run);
  const rejected = assert.rejects(owner.request(['debug', 'models'], {}), { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  const disposal = owner.dispose({ deadlineMs: 1 });
  await rejected; // Cancelled caller settles even when the child has not closed.
  const result = await disposal;
  assert.equal(result.settled, false); assert.equal(result.pending[0].pid, f.calls[0].child.pid);
  assert.equal(owner.dispose(), disposal);
  f.close(0, new Error('late close'), ''); await rejected;
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.equal(result.settled, false, 'late close does not rewrite deadline receipt');
});
test('Quit between a successful callback and its continuation cannot publish/cache a catalog', async () => {
  const f = pendingRun(), h = harness(f.run), pending = h.listCodexModels();
  const rejected = assert.rejects(pending, { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  f.close(0);
  assert.equal((await h.disposeCodexModelCatalog()).settled, true); await rejected;
  assert.equal(h.logs.some(line => line.includes('catalog resolved')), false);
  assert.equal(f.calls.length, 1);
});
test('a failed own-child signal is not settlement and never grants escalation', async () => {
  const f = pendingRun(), h = harness(f.run), owner = h.createCodexModelCatalogLifecycle(f.run);
  const rejected = assert.rejects(owner.request([], {}), { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  f.calls[0].child.kill = () => { throw Object.assign(new Error('denied'), {code:'EPERM'}); };
  const disposal = owner.dispose({deadlineMs:1}); await rejected;
  assert.equal((await disposal).settled, false);
  assert.ok(h.logs.some(line => line.includes('EPERM')));
  f.close(0); assert.equal(owner.dispose(),disposal);
});
test('changed PID, already exited and already signalled handles never gain new signal authority', async () => {
  for (const mutate of [child => { child.pid++; }, child => { child.exitCode = 0; }, child => { child.killed = true; }]) {
    const f = pendingRun(), h = harness(f.run), owner = h.createCodexModelCatalogLifecycle(f.run);
    const rejected = assert.rejects(owner.request([], {}), { code: 'CODEX_MODEL_CATALOG_CLOSED' });
    mutate(f.calls[0].child); const disposal = owner.dispose();
    assert.deepEqual(f.calls[0].child.signals, []);
    f.close(0); await rejected; assert.equal((await disposal).settled, true);
  }
});
test('spawn errors and success-before-close do not fabricate absence', async () => {
  const f = pendingRun(), h = harness(f.run), owner = h.createCodexModelCatalogLifecycle(f.run);
  const pending = owner.request([], {});
  f.calls[0].callback(null, 'done'); assert.equal(await pending, 'done');
  f.calls[0].child.exitCode = 0;
  const disposal = owner.dispose(); let settled = false; disposal.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  f.calls[0].child.emit('close', 0, null); assert.equal((await disposal).settled, true);
  const broken = h.createCodexModelCatalogLifecycle(() => { throw new Error('spawn failed'); });
  await assert.rejects(broken.request([], {}), /spawn failed/);
  assert.equal((await broken.dispose()).settled, true);
});
test('normal Main Quit revokes catalog at admission and joins it before the final app.quit', () => {
  const main = fs.readFileSync(require.resolve('./main'), 'utf8');
  const start = main.indexOf("app.on('before-quit', async (event) => {");
  const end = main.indexOf("app.on('will-quit'", start);
  const hook = main.slice(start, end);
  assert.equal(hook.match(/disposeCodexModelCatalog\(\)/g)?.length, 1);
  assert.ok(hook.indexOf('event.preventDefault();', hook.indexOf('_gracefulShutdownInProgress = true')) < hook.indexOf('disposeCodexModelCatalog()'));
  assert.ok(hook.indexOf('disposeCodexModelCatalog()') < hook.indexOf('let activeAiSessions'));
  assert.ok(hook.indexOf('await modelCatalogDisposal') < hook.lastIndexOf('app.quit();'));
  assert.ok(hook.includes('owned child close UNKNOWN'));
});
test('finite real Node wrapper forwards termination and joins its own child before close', { timeout: 8000 }, async t => {
  // Faithful signal-forwarding boundary of the inspected npm wrapper, with
  // finite Node substitutes for both Codex processes; no provider/native call.
  const worker = "process.on('SIGTERM',()=>{console.log('OWN_CHILD_EXIT');process.exit(0)});console.log('OWN_CHILD_READY pid='+process.pid);setTimeout(()=>process.exit(3),4000);";
  const wrapper = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--max-old-space-size=16','--max-semi-space-size=1','-e',"
    + JSON.stringify(worker) + "],{stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',(code)=>{console.log('OWN_CHILD_JOINED');process.exit(code)});";
  let handle;
  const h = harness(() => { throw new Error('default subprocess must not run'); });
  const owner = h.createCodexModelCatalogLifecycle((_command, _args, _options, callback) => {
    handle = execFile(process.execPath, ['--max-old-space-size=16', '--max-semi-space-size=1', '-e', wrapper],
      { timeout: 6000, maxBuffer: 65536 }, callback);
    return handle;
  });
  const rejected = assert.rejects(owner.request([], {}), { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  t.after(async () => { await owner.dispose(); });
  let output = '';
  await new Promise((resolve, reject) => {
    handle.stdout.on('data', chunk => { output += chunk; if (output.includes('OWN_CHILD_READY')) resolve(); });
    handle.once('error', reject);
    handle.once('exit', () => { if (!output.includes('OWN_CHILD_READY')) reject(new Error('fixture exited before handshake')); });
  });
  const closed = once(handle, 'close');
  const result = await owner.dispose(); await rejected; const exit = await closed;
  assert.equal(result.settled, true);
  assert.ok(output.includes('OWN_CHILD_EXIT')); assert.ok(output.includes('OWN_CHILD_JOINED'));
  t.diagnostic(JSON.stringify({kind:'OWN_FINITE_NODE_CHILDREN_JOINED',wrapperPid:handle.pid,
    childPid:Number(/OWN_CHILD_READY pid=(\d+)/.exec(output)?.[1]),exit,closed:true,
    providerCalls:0,nativeBinaryCalls:0}));
});
