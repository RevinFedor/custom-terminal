'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createClaudeTurnInterrupt } = require('./claude-turn-interrupt');

function harness(overrides = {}, options = {}) {
  const snapshot = {
    terminal: {}, runSeq: 1, lifecycleGeneration: 'pty:1', launchGeneration: 'launch-1',
    processId: '100', busy: true, stopping: false, turnId: 'turn-1', ...overrides,
  };
  const queue = [];
  const writes = [];
  let clockAt = 10_000;
  const interrupt = createClaudeTurnInterrupt({
    now: () => clockAt,
    ...options,
    getSnapshot: () => snapshot,
    withWriteLock: (terminal, work, options) => new Promise((resolve, reject) => {
      queue.push({ terminal, options, flush: () => {
        try { resolve(work()); } catch (error) { reject(error); }
      } });
    }),
    writeEscape: (_tabId, current) => writes.push({ terminal: current.terminal, turnId: current.turnId }),
  });
  return { interrupt, snapshot, queue, writes, flush: () => queue.shift().flush(),
    advanceTime: ms => { clockAt += ms; } };
}

test('P1 idle Claude interrupt performs no PTY write and never claims interruption', async () => {
  const h = harness({ busy: false });
  const result = await h.interrupt('T');
  assert.equal(result.success, true);
  assert.equal(result.status, 'skipped');
  assert.equal(result.interrupted, false);
  assert.equal(result.interruptRequested, false);
  assert.equal(result.interruptConfirmed, false);
  assert.equal(h.queue.length, 0);
  assert.deepEqual(h.writes, []);
});

test('P1 pending Claude request cannot settle before the queue or write to a replacement terminal', async () => {
  const h = harness();
  const originalTerminal = h.snapshot.terminal;
  let settled = false;
  const waiting = h.interrupt('T').then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(h.queue[0].terminal, originalTerminal);
  assert.equal(h.queue[0].options.kind, 'claude-turn-interrupt');
  assert.deepEqual(h.writes, []);
  h.snapshot.terminal = {};
  h.flush();
  assert.equal((await waiting).error, 'claude_terminal_generation_changed');
  assert.deepEqual(h.writes, []);
});

for (const [label, change, error, skip] of [
  ['new shell command', { runSeq: 2 }, 'claude_terminal_generation_changed'],
  ['new lifecycle', { lifecycleGeneration: 'pty:2' }, 'claude_terminal_generation_changed'],
  ['new Claude launch', { launchGeneration: 'launch-2' }, 'claude_terminal_generation_changed'],
  ['new Claude PID', { processId: '200' }, 'claude_terminal_generation_changed'],
  ['process stopping', { stopping: true }, 'claude_stopping'],
  ['missing turn identity', { turnId: null }, 'claude_turn_identity_pending'],
  ['completed turn', { busy: false }, null, 'idle-composer'],
  ['another active turn', { turnId: 'turn-2' }, null, 'target-turn-changed'],
]) {
  test(`queued Claude interrupt rechecks ${label} even when snapshot object is reused`, async () => {
    const h = harness();
    const waiting = h.interrupt('T');
    Object.assign(h.snapshot, change);
    h.flush();
    const result = await waiting;
    assert.equal(result.success, !error);
    if (error) assert.equal(result.error, error);
    if (skip) assert.equal(result.skipped, skip);
    assert.equal(result.interrupted, false);
    assert.equal(result.interruptRequested, false);
    assert.deepEqual(h.writes, []);
  });
}

test('proven Claude turn receives one request even before an idle composer frame', async () => {
  const h = harness({ inputReady: false });
  const first = h.interrupt('T');
  const duplicate = h.interrupt('T');
  h.flush(); h.flush();
  const result = await first;
  assert.equal(result.success, true);
  assert.equal(result.status, 'requested');
  assert.equal(result.interruptRequested, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptConfirmed, false);
  assert.equal((await duplicate).skipped, 'interrupt-already-requested');
  assert.equal(h.writes.length, 1);
  h.snapshot.turnId = 'turn-2';
  const next = h.interrupt('T'); h.flush();
  assert.equal((await next).interruptRequested, true);
  assert.deepEqual(h.writes.map(write => write.turnId), ['turn-1', 'turn-2']);
});

test('explicit Claude retry after the old 700ms debounce can target the still-busy same turn', async () => {
  const h = harness();
  const first = h.interrupt('T'); h.flush();
  assert.equal((await first).interruptRequested, true);
  h.advanceTime(699);
  const duplicate = h.interrupt('T'); h.flush();
  assert.equal((await duplicate).skipped, 'interrupt-already-requested');
  assert.equal(h.writes.length, 1);
  h.advanceTime(1);
  const retry = h.interrupt('T'); h.flush();
  const result = await retry;
  assert.equal(result.interruptRequested, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptConfirmed, false);
  assert.equal(h.snapshot.busy, true);
  assert.deepEqual(h.writes.map(write => write.turnId), ['turn-1', 'turn-1']);
  h.advanceTime(60_000);
  assert.equal(h.writes.length, 2, 'elapsed time does not automatically send another Escape');
});

test('injected Claude debounce duration is deterministic and never extends on a skipped duplicate', async () => {
  const h = harness({}, { dedupMs: 25 });
  const first = h.interrupt('T'); h.flush(); await first;
  h.advanceTime(24);
  const duplicate = h.interrupt('T'); h.flush();
  assert.equal((await duplicate).interruptRequested, false);
  h.advanceTime(1);
  const retry = h.interrupt('T'); h.flush();
  assert.equal((await retry).interruptRequested, true);
  assert.equal(h.writes.length, 2);
});

test('an immediate duplicate stays suppressed even if its PTY slot is delayed past the debounce', async () => {
  const h = harness();
  const first = h.interrupt('T');
  h.advanceTime(1);
  const duplicate = h.interrupt('T');
  h.flush(); await first;
  h.advanceTime(700);
  h.flush();
  assert.equal((await duplicate).skipped, 'interrupt-already-requested');
  assert.equal(h.writes.length, 1);
  const explicitRetry = h.interrupt('T'); h.flush();
  assert.equal((await explicitRetry).interruptRequested, true);
  assert.equal(h.writes.length, 2);
});

test('Claude becoming idle after the first Escape prevents an explicit post-debounce retry write', async () => {
  const h = harness();
  const first = h.interrupt('T'); h.flush(); await first;
  h.advanceTime(700);
  h.snapshot.busy = false;
  const retry = await h.interrupt('T');
  assert.equal(retry.skipped, 'idle-composer');
  assert.equal(retry.interruptRequested, false);
  assert.equal(h.queue.length, 0);
  assert.equal(h.writes.length, 1);
});

test('a queued post-debounce Claude retry cannot interrupt a replacement turn', async () => {
  const h = harness();
  const first = h.interrupt('T'); h.flush(); await first;
  h.advanceTime(700);
  const retry = h.interrupt('T');
  h.snapshot.turnId = 'turn-2';
  h.flush();
  assert.equal((await retry).skipped, 'target-turn-changed');
  assert.deepEqual(h.writes.map(write => write.turnId), ['turn-1']);
});

test('missing initial terminal or turn identity cannot be upgraded while waiting', async () => {
  for (const change of [{ terminal: null }, { turnId: null }, { runSeq: 0 }, { lifecycleGeneration: null }]) {
    const h = harness(change);
    assert.equal((await h.interrupt('T')).success, false);
    assert.equal(h.queue.length, 0);
    assert.deepEqual(h.writes, []);
  }
});

test('actual Claude renderer adapter awaits main receipt and never sends a raw key', async () => {
  const h = harness();
  const exports = {};
  const source = fs.readFileSync(require.resolve('../renderer/utils/claudePtyActions.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    console: { log() {}, warn() {} },
    require: () => ({}),
    window: { require: () => ({ ipcRenderer: {
      send() { assert.fail('programmatic interrupt must not use terminal:input'); },
      invoke(channel, tabId) {
        assert.equal(channel, 'claude:interrupt-turn');
        return h.interrupt(tabId);
      },
    } }) },
  });
  let settled = false;
  const waiting = exports.interruptClaudePtyTurn('T').then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(h.writes, []);
  h.flush();
  const receipt = await waiting;
  assert.equal(receipt.interruptRequested, true);
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.interruptConfirmed, false);
  assert.equal(h.writes.length, 1);
});
