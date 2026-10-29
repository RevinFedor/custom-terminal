'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { sourceHarness, pendingRun, fakeBinding } = require('../../scripts/testing/codex-model-catalog-source-harness.cjs');
const identity = { instanceId: 'owned-main-one', pid: 1234, startedAt: 1000 };
const read = h => JSON.parse(JSON.stringify(h.getCodexModelCatalogLifecycle()));
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('actual owner retains public single-flight/model result and two separate callback/close facts', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run, identity });
  const values = Array.from({ length: 40 }, () => h.listCodexModels());
  assert.equal(f.calls.length, 1); f.spawn(0);
  f.callback(0, null, '[{"slug":"one","default_reasoning_effort":"high","supported_reasoning_efforts":["low","high"]}]');
  const result = await Promise.all(values); assert(result.every(value => value === result[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(result[0])), [{ id: 'one', label: 'one', defaultEffort: 'high', efforts: ['low', 'high'] }]);
  let s = read(h); assert.equal(s.attempts[0].outcome, 'close-unconfirmed'); assert.equal(s.activeHandleCount, 1);
  f.close(0); s = read(h); assert.equal(s.attempts[0].outcome, 'completed-normal');
  assert.equal(s.attempts[0].attemptId, identity.instanceId + ':1'); assert.equal(s.attempts[0].handlePid, 2000);
  assert.equal(s.attempts[0].publication.source, 'live'); assert.equal(s.activeHandleCount, 0);
  assert.equal(await h.listCodexModels(), result[0]); assert.equal(f.calls.length, 1);
  const revision = s.snapshotRevision; for (let i = 0; i < 40; i++) h.getCodexModelCatalogLifecycle();
  assert.equal(read(h).snapshotRevision, revision); assert.equal(f.calls.length, 1);
  assert(Buffer.byteLength(JSON.stringify(s)) <= 12288); assert(Buffer.byteLength(JSON.stringify(s.attempts[0])) <= 4096);
  assert(!JSON.stringify(s).includes('defaultEffort')); assert(!JSON.stringify(s).includes('supported_reasoning_efforts'));
});
test('actual close before callback remains callback-unconfirmed and can settle naturally later', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run, identity }), p = h.listCodexModels();
  f.spawn(0); f.close(0); assert.equal(read(h).attempts[0].outcome, 'callback-unconfirmed');
  f.callback(0); await p; assert.equal(read(h).attempts[0].outcome, 'completed-normal');
});
test('empty live links bundled to the same cycle, and failures preserve builtin fallback', async () => {
  for (const builtin of [false, true]) {
    const f = pendingRun(), h = sourceHarness({ run: f.run, identity }), p = h.listCodexModels();
    f.spawn(0); f.callback(0, null, '[]'); f.close(0); await tick(); assert.equal(f.calls.length, 2);
    f.spawn(1); f.callback(1, builtin ? Object.assign(new Error('private error body'), { code: 'EFAIL' }) : null); f.close(1, builtin ? 1 : 0);
    const result = await p; assert(result.length > 0); const s = read(h);
    assert.equal(s.attemptsStartedTotal, 2); assert.equal(s.maxActiveHandleCount, 1);
    assert.equal(s.attempts[0].phase, 'live'); assert.equal(s.attempts[1].phase, 'bundled');
    assert.equal(s.attempts[1].cycleId, s.attempts[0].cycleId); assert.equal(s.attempts[1].previousAttemptId, s.attempts[0].attemptId);
    assert.equal(s.attempts[1].publication.source, builtin ? 'builtin' : 'bundled');
    assert(!JSON.stringify(s).includes('private error body'));
  }
});
test('bound owner records synchronous throws without fake handle or close', async () => {
  const h = sourceHarness({ run() { throw Object.assign(new Error('private launch body'), { code: 'ENOENT' }); }, identity });
  assert((await h.listCodexModels()).length > 0); const s = read(h);
  assert.equal(s.attemptsStartedTotal, 2); assert(s.attempts.every(r => r.outcome === 'launch-threw' && r.handlePid === null && r.close === null));
  assert(!JSON.stringify(s).includes('private launch body'));
});
test('termination tap preserves receiver/return and code0 cannot erase its attempt', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run, identity }), p = h.listCodexModels(); f.spawn(0);
  assert.equal(f.calls[0].child.kill('SIGTERM'), true); f.callback(0); f.close(0); await p;
  const s = read(h); assert.equal(s.attempts[0].outcome, 'cancelled'); assert.equal(s.attempts[0].termination.count, 1);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
});
test('a stale handle after close does not rewrite completed request facts', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run, identity }), p = h.listCodexModels();
  f.spawn(0); const savedTap = f.calls[0].child.kill; f.callback(0); f.close(0); await p;
  const before = read(h); f.calls[0].child.kill('SIGTERM'); savedTap.call(f.calls[0].child, 'SIGTERM');
  const after = read(h); assert.equal(after.snapshotRevision, before.snapshotRevision);
  assert.equal(after.attempts[0].outcome, 'completed-normal');
});
test('real finite Node execFile timeout is observed even when its child handles SIGTERM and exits0', { timeout: 5000 }, async t => {
  const shell = 'process.on("SIGTERM",()=>process.exit(0));console.log("FINITE_TIMEOUT_READY");setTimeout(()=>process.exit(3),2000)';
  let handle;
  const h = sourceHarness({ run() { throw Error('default runner must not execute'); } });
  const owner = h.createCodexModelCatalogLifecycle((_command, _args, _options, callback) => {
    handle = execFile(process.execPath, ['--max-old-space-size=16', '--max-semi-space-size=1', '-e', shell],
      { timeout: 350, killSignal: 'SIGTERM', maxBuffer: 65536 }, callback);
    return handle;
  }, { observeBinding: fakeBinding });
  owner.bindRuntime(identity); t.after(() => owner.dispose());
  const pending = owner.request(['debug','models'], {});
  const closed = once(handle, 'close'); const stdout = await pending; await closed;
  // execFile can report success when the timeout signal is handled with exit0.
  // Preserve that public result; only the receipt denies natural completion.
  assert(stdout.includes('FINITE_TIMEOUT_READY'));
  const s = owner.snapshot(), r = s.attempts[0];
  assert.equal(r.close.code, 0); assert.equal(r.termination.attempted, true);
  assert.equal(r.termination.count, 1); assert.equal(r.termination.last.source, 'handle-kill');
  assert.notEqual(r.outcome, 'completed-normal'); assert.equal(s.activeHandleCount, 0);
  t.diagnostic(JSON.stringify({ scope:'finite Node substitution, not Electron/Codex', pid:handle.pid,
    closeCode:r.close.code, terminationCount:r.termination.count, providerCalls:0, nativeCodexCalls:0 }));
});
test('dispose cancellation and late close preserve the immutable join deadline outcome', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run, identity }), p = h.listCodexModels(); f.spawn(0);
  const rejection = assert.rejects(p, { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  const d = h.disposeCodexModelCatalog(); assert.equal(h.disposeCodexModelCatalog(), d);
  f.callback(0); f.close(0); await rejection; assert.equal((await d).settled, true);
  assert.equal(read(h).attempts[0].outcome, 'cancelled');
  const g = pendingRun(), k = sourceHarness({ run: g.run });
  const owner = k.createCodexModelCatalogLifecycle(g.run, { observeBinding: fakeBinding }); owner.bindRuntime(identity);
  const q = owner.request(['debug','models'], {}); g.spawn(0); const rejected = assert.rejects(q, { code: 'CODEX_MODEL_CATALOG_CLOSED' });
  const result = await owner.dispose({ deadlineMs: 1 }); await rejected; assert.equal(result.settled, false);
  g.callback(0); g.close(0); const s = owner.snapshot(); assert.equal(s.disposal.deadlineOutcome.settled, false);
  assert.equal(s.disposal.currentPendingCount, 0); assert.equal(result.settled, false); assert.equal(g.calls.length, 1);
});
test('runtime bind is one-time before attempts, getter never binds prior unbound work', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run }), p = h.listCodexModels(); f.spawn(0);
  assert.equal(h.bindCodexModelCatalogRuntime(identity), false); f.callback(0); f.close(0); await p;
  assert.equal(read(h).mainInstanceId, null); assert.notEqual(read(h).attempts[0].outcome, 'completed-normal');
  const j = sourceHarness({ run: f.run, identity }); assert.equal(j.bindCodexModelCatalogRuntime({ ...identity, instanceId: 'different' }), false);
});
test('duplicate/contradictory events and changed handle PID cannot qualify', async () => {
  for (const mutate of [c => c.emit('spawn'), c => { c.pid++; }, c => c.emit('exit', 7, null)]) {
    const f = pendingRun(), h = sourceHarness({ run: f.run, identity }), p = h.listCodexModels(); f.spawn(0); mutate(f.calls[0].child);
    f.callback(0); f.close(0); await p; assert.equal(read(h).attempts[0].outcome, 'inconsistent');
  }
});
test('a third attempt remains visible in counters after two-body retention', async () => {
  const f = pendingRun(), h = sourceHarness({ run: f.run });
  const owner = h.createCodexModelCatalogLifecycle(f.run, { observeBinding: fakeBinding }); owner.bindRuntime(identity);
  for (let i = 0; i < 3; i++) { const p = owner.request(['debug','models'], {}); f.spawn(i); f.callback(i); f.close(i); await p; }
  const s = owner.snapshot(); assert.equal(s.attempts.length, 2); assert.equal(s.attemptsStartedTotal, 3);
  assert.equal(s.evictedThrough, 1); assert.equal(s.firstRetainedSequence, 2); assert.equal(s.lostReceipts, 0);
});
test('binding faults and malformed diagnostics cannot change the public catalog result', async () => {
  for (const binding of [() => { throw Error('secret diagnostics failure'); },
    () => ({ before: { status: 'unqualified' }, finish() { throw Error('private post'); } }),
    () => ({ before: { status: 'qualified', factsDigest: null }, finish: () => ({ status:'qualified', matched:true, factsDigest:null }) }),
    () => ({ before: { status:'qualified',factsDigest:'a'.repeat(64) }, finish: () => ({ status:'unqualified',matched:true,factsDigest:'a'.repeat(64) }) })]) {
    const f = pendingRun(), h = sourceHarness({ run: f.run, identity, binding }), p = h.listCodexModels();
    f.spawn(0); f.callback(0); f.close(0); assert.equal((await p)[0].id, 'fixture-live');
    const s = read(h); assert.notEqual(s.attempts[0].outcome, 'completed-normal'); assert(!JSON.stringify(s).includes('private post'));
  }
});
test('oversize diagnostic bodies and a failed publication keep public results while reporting explicit loss', async () => {
  const f = pendingRun(), h = sourceHarness({ run:f.run, identity, onChange() { throw Error('unavailable receiver'); },
    binding: () => ({before:{status:'qualified',factsDigest:'d'.repeat(64),tooLarge:'private-diagnostic'.repeat(500)},
      finish:()=>({matched:true,factsDigest:'d'.repeat(64),status:'qualified'})}) });
  const p=h.listCodexModels(); f.spawn(0); f.callback(0); f.close(0); assert.equal((await p)[0].id,'fixture-live');
  const s=read(h); assert(s.lostReceipts>0); assert(s.diagnosticErrors>0);
  assert.equal(s.attempts[0].outcome,'diagnostic-incomplete'); assert.equal(s.attempts[0].dataLost,true);
  assert(!JSON.stringify(s).includes('private-diagnostic')); assert.equal(f.calls.length,1);
  assert(Buffer.byteLength(JSON.stringify(s))<=12288);
});
test('Main binds before catalog registration; diagnostic IPC is one pure getter', () => {
  const s = fs.readFileSync(require.resolve('./main'), 'utf8');
  assert(s.indexOf('bindCodexModelCatalogRuntime(appRuntimeIdentity') < s.indexOf('codexDataModule.register('));
  assert.equal(s.split("ipcMain.handle('codex:get-model-catalog-lifecycle'").length - 1, 1);
  assert(s.includes("ipcMain.handle('codex:get-model-catalog-lifecycle', () => codexDataModule._api.getCodexModelCatalogLifecycle())"));
});
