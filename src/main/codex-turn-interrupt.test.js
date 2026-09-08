'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexTurnInterrupt } = require('./codex-turn-interrupt');

function harness(options = {}) {
  const terminal = {};
  let snapshot = { terminal, runSeq: 1, lifecycleGeneration: 'pty:1', inputReady: true, busy: true, turnId: 'turn-1', ...options };
  const writes = [];
  const queue = [];
  const interrupt = createCodexTurnInterrupt({
    getSnapshot: () => snapshot,
    withWriteLock: (_term, work) => new Promise(resolve => queue.push(() => resolve(work()))),
    writeEscape: (_tab, current) => writes.push(current.turnId),
  });
  return { interrupt, writes, flush: () => queue.shift()(), set: change => { snapshot = { ...snapshot, ...change }; } };
}

test('idle API interrupt never writes Escape and repeated busy requests target one turn once', async () => {
  const h = harness({ busy: false });
  const idle = h.interrupt('tab');
  assert.equal((await idle).interrupted, false);
  assert.deepEqual(h.writes, []);
  h.set({ busy: true });
  const first = h.interrupt('tab'), second = h.interrupt('tab');
  h.flush(); h.flush();
  assert.equal((await first).interrupted, true);
  assert.equal((await second).skipped, 'interrupt-already-requested');
  assert.deepEqual(h.writes, ['turn-1']);
  h.set({ turnId: 'turn-2' });
  const next = h.interrupt('tab'); h.flush();
  assert.equal((await next).interrupted, true);
  assert.deepEqual(h.writes, ['turn-1', 'turn-2']);
});

test('turn completion while waiting for PTY prevents the queued Escape', async () => {
  const h = harness();
  const request = h.interrupt('tab');
  h.set({ busy: false }); h.flush();
  assert.equal((await request).reason, 'turn-already-idle');
  assert.deepEqual(h.writes, []);
  const other = harness();
  const queued = other.interrupt('tab');
  other.set({ turnId: 'new-turn' }); other.flush();
  assert.equal((await queued).reason, 'target-turn-finished');
  assert.deepEqual(other.writes, []);
});

test('queued interrupt cannot cross generation or target an uninitialized composer', async () => {
  for (const changed of [{ terminal: {} }, { runSeq: 2 }, { lifecycleGeneration: 'pty:2' }, { inputReady: false }, { stopping: true }, { turnId: null }]) {
    const h = harness();
    const request = h.interrupt('tab'); h.set(changed); h.flush();
    assert.equal((await request).success, false);
    assert.deepEqual(h.writes, []);
  }
});

test('Goal-started turn reconciles stale readiness, never bypasses it or repeats Escape', async () => {
  const terminal = {};
  let state = { terminal, runSeq: 1, lifecycleGeneration: 'L', inputReady: false, busy: true, turnId: 'G' };
  let refreshes = 0, writes = 0;
  const interrupt = createCodexTurnInterrupt({
    getSnapshot: () => state,
    refreshReady: async () => { refreshes++; state = { ...state, inputReady: true }; },
    withWriteLock: (_terminal, work) => work(), writeEscape: () => { writes++; },
  });
  assert.equal((await interrupt('T')).interrupted, true);
  assert.equal((await interrupt('T')).skipped, 'interrupt-already-requested');
  assert.equal(refreshes, 1);
  assert.equal(writes, 1);
});

test('process replacement during readiness reconciliation never receives the old interrupt', async () => {
  let state = { terminal: {}, runSeq: 1, lifecycleGeneration: 'L', inputReady: false, busy: true, turnId: 'G' };
  let writes = 0;
  const interrupt = createCodexTurnInterrupt({ getSnapshot: () => state,
    refreshReady: async () => { state = { ...state, terminal: {}, inputReady: true }; },
    withWriteLock: (_terminal, work) => work(), writeEscape: () => { writes++; } });
  assert.equal((await interrupt('T')).error, 'codex_terminal_generation_changed');
  assert.equal(writes, 0);
});
