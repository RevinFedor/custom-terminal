import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestartAfterCoordinator } from './restartAfterCoordinator.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const writes = [], cancellations = [], events = [];
  let allowed = true, blocked = false;
  const runtime = createRestartAfterCoordinator({
    allowed: () => allowed, blocked: () => blocked,
    targets: () => [{ tabId: 'target' }],
    prepare: async () => ({ command: './deploy.sh', finite: true }),
    launch: async (request, prepared, id, current) => { if (current()) writes.push({ request, prepared, id }); return { success: true }; },
    cancel: (...args) => cancellations.push(args), log: (...args) => events.push(args), ...overrides,
  });
  const complete = (n, tabId = 'source') => {
    runtime.busy({ tabId, busy: true }); runtime.busy({ tabId, busy: false, reason: 'task_complete', outcomeTs: n });
  };
  return { runtime, writes, cancellations, events, complete, pause: () => { allowed = false; runtime.reconcile(); }, block: value => { blocked = value; } };
}

test('ten copies of the same completion admit exactly one command, even as repeated busy pairs', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.complete(100);
  await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.runtime.snapshot()[0].pending, false);
});

test('many genuinely new completions during a finite script collapse to one latest repeat', async () => {
  const f = fixture(); f.complete(1); await settle();
  for (let i = 2; i <= 12; i++) f.complete(i, 'source-' + i);
  assert.equal(f.writes.length, 1);
  f.runtime.finished({ tabId: 'target', commandOperationId: f.writes[0].id, exitCode: 0 }); await settle();
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].request.triggerTabId, 'source-12');
  f.runtime.finished({ tabId: 'target', commandOperationId: f.writes[1].id, exitCode: 0 }); await settle();
  assert.equal(f.writes.length, 2); assert.deepEqual(f.runtime.snapshot(), []);
});

test('manual target Stop cancels pending before even a successful stop completion', async () => {
  const f = fixture(); f.complete(1); await settle(); f.complete(2);
  const id = f.writes[0].id; f.runtime.cancel('target');
  f.runtime.finished({ tabId: 'target', commandOperationId: id, exitCode: 0 }); await settle();
  assert.equal(f.writes.length, 1);
  f.complete(3); await settle(); assert.equal(f.writes.length, 2, 'future genuine completion still works');
});

test('Stop during async command lookup cannot send or start a new operation', async () => {
  const gate = deferred(); const f = fixture({ prepare: () => gate.promise });
  f.complete(1); f.runtime.cancel('target'); gate.resolve({ command: './deploy.sh', finite: true }); await settle();
  assert.equal(f.writes.length, 0); assert.deepEqual(f.runtime.snapshot(), []);
});

test('Stop during asynchronous launch preflight prevents its late write', async () => {
  const gate = deferred(), writes = [];
  const f = fixture({ launch: async (_r, _p, id, current) => { await gate.promise; if (current()) writes.push(id); return { success: current() }; } });
  f.complete(1); await settle(); f.runtime.cancel('target'); gate.resolve(); await settle();
  assert.deepEqual(writes, []);
});

test('manual interruption of a source neither launches nor stops an existing target', async () => {
  const f = fixture(); f.complete(1); await settle();
  for (const reason of ['turn_aborted', 'interrupt', 'error', 'manual-stop', 'watchdog', 'codex-no-final-result']) {
    f.runtime.busy({ tabId: 'source', busy: true }); f.runtime.busy({ tabId: 'source', busy: false, reason });
  }
  await settle(); assert.equal(f.writes.length, 1); assert.equal(f.cancellations.length, 0);
});

test('script exit itself never repeats, while a genuine new AI intent survives a build failure', async () => {
  for (const exitCode of [1, 130, 141, 143]) {
    const f = fixture(); f.complete(1); await settle();
    f.runtime.finished({ tabId: 'target', commandOperationId: f.writes[0].id, exitCode }); await settle();
    assert.equal(f.writes.length, 1);
    f.complete(2); await settle(); f.complete(3);
    f.runtime.finished({ tabId: 'target', commandOperationId: f.writes[1].id, exitCode }); await settle();
    assert.equal(f.writes.length, 3);
  }
});

test('late finish from a superseded operation cannot drain the current one', async () => {
  const f = fixture(); f.complete(1); await settle(); const old = f.writes[0].id;
  f.runtime.request({ tabId: 'target', automatic: false, command: 'new' }); await settle(); f.complete(2);
  f.runtime.finished({ tabId: 'target', commandOperationId: old, exitCode: 0 }); await settle();
  assert.equal(f.writes.length, 2); assert.equal(f.runtime.snapshot()[0].pending, true);
});

test('pause or removed subscription cancels pending without an extra launch', async () => {
  const f = fixture(); f.complete(1); await settle(); f.complete(2); f.pause();
  f.runtime.finished({ tabId: 'target', commandOperationId: f.writes[0].id, exitCode: 0 }); await settle();
  assert.equal(f.writes.length, 1);
});

test('orchestration release and busy completion consume the same deferred result once', async () => {
  const f = fixture(); f.block(true); f.complete(1); await settle(); assert.equal(f.writes.length, 0);
  f.block(false); const release = { sourceTabId: 'source', releaseKind: 'success', run: { runId: 'run', createdAt: 0 } };
  for (let i = 0; i < 10; i++) f.runtime.orchestration(release);
  await settle(); assert.equal(f.writes.length, 1); assert.equal(f.runtime.snapshot()[0].pending, false);
});

test('fast script may finish before the submit ACK and still releases one pending run', async () => {
  const gate = deferred(); let id;
  const f = fixture({ launch: async (_r, _p, operationId) => { id = operationId; await gate.promise; return { success: true }; } });
  f.complete(1); await settle(); f.runtime.finished({ tabId: 'target', commandOperationId: id, exitCode: 0 });
  gate.resolve(); await settle(); assert.deepEqual(f.runtime.snapshot(), []);
});

test('rejoining a running finite script after UI reload waits for its exact completion', async () => {
  const f = fixture({ prepare: async () => ({ finite: true, runningOperationId: 'existing' }) });
  f.complete(1); await settle(); assert.equal(f.writes.length, 0);
  assert.equal(f.runtime.snapshot()[0].operationId, 'existing'); assert.equal(f.runtime.snapshot()[0].pending, true);
  f.runtime.cancel('target'); f.runtime.finished({ tabId: 'target', commandOperationId: 'existing', exitCode: 0 }); await settle();
  assert.deepEqual(f.runtime.snapshot(), []);
});

test('development servers still restart on a later natural result', async () => {
  const f = fixture({ prepare: async () => ({ finite: false, command: 'npm run dev' }) });
  f.complete(1); await settle(); f.complete(2); await settle(); assert.equal(f.writes.length, 2);
});

test('new background orchestration remains capable of running after an earlier direct completion', async () => {
  const f = fixture(); f.complete(100); await settle();
  f.runtime.finished({ tabId: 'target', commandOperationId: f.writes[0].id, exitCode: 0 });
  f.runtime.orchestration({ sourceTabId: 'source', releaseKind: 'success', run: { runId: 'old', createdAt: 50 } });
  await settle(); assert.equal(f.writes.length, 1);
  f.runtime.orchestration({ sourceTabId: 'source', releaseKind: 'success', run: { runId: 'new', createdAt: 110 } });
  await settle(); assert.equal(f.writes.length, 2);
});
