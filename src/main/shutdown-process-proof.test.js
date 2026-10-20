'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureShutdownProcessProof } = require('./shutdown-process-proof');

function fixture(count = 43) {
  let time = 100;
  let reads = 0;
  const targets = Array.from({ length: count }, (_, i) => ({
    tabId: 'saved-' + i, processScope: { terminal: { pid: 100 + i }, generation: 1 },
  }));
  const current = new Map(targets.map(t => [t.tabId, t.processScope]));
  const children = new Map();
  const options = {
    targets,
    now: () => time,
    maxAgeMs: 750,
    isScopeCurrent: (id, scope) => current.get(id) === scope,
    getProcessName: cmd => ['codex', 'claude', 'gemini'].includes(cmd) ? cmd : null,
    readSnapshot: async () => {
      reads += 1;
      return { children, processesByPid: new Map(), createdAt: time };
    },
  };
  return { targets, current, options, children, reads: () => reads, advance: ms => { time += ms; } };
}

test('43 failed targets share one thrown snapshot and stay unknown on repeated reads', async () => {
  const f = fixture();
  let calls = 0;
  f.options.readSnapshot = async () => { calls++; f.advance(2500); throw new Error('ps timeout'); };
  const proof = await captureShutdownProcessProof(f.options);
  assert.deepEqual(proof.summary, { targets: 43, snapshotReads: 1, found: 0, absent: 0, unknown: 43, durationMs: 2500, snapshotError: 'ps timeout' });
  for (const target of f.targets) {
    for (let i = 0; i < 2; i++) {
      const result = proof.lookup(target.tabId);
      assert.equal(result.status, 'unknown');
      assert.equal(result.error.message, 'ps timeout');
      assert.deepEqual(result.matches, []);
    }
  }
  assert.equal(calls, 1);
});

test('one coherent snapshot covers all 43, nested wrappers, both providers and a successful empty subtree', async () => {
  const f = fixture();
  f.children.set(100, [{ pid: 200, ppid: 100, cmd: 'node' }]);
  f.children.set(200, [{ pid: 201, ppid: 200, cmd: 'codex' }]);
  f.children.set(102, [{ pid: 202, ppid: 102, cmd: 'claude' }, { pid: 203, ppid: 102, cmd: 'codex' }]);
  const proof = await captureShutdownProcessProof(f.options);
  assert.equal(f.reads(), 1);
  assert.deepEqual(proof.summary, { targets: 43, snapshotReads: 1, found: 2, absent: 41, unknown: 0, durationMs: 0, snapshotError: null });
  assert.equal(proof.lookup('saved-0').matches[0].depth, 2);
  assert.equal(proof.lookup('saved-1').status, 'absent');
  assert.deepEqual(proof.lookup('saved-2').matches.map(m => m.processName), ['codex', 'claude']);
  assert.equal(proof.lookup('unadmitted').status, 'unknown');
});

test('owner changes during snapshot and after capture never attach old proof to a new owner', async () => {
  const f = fixture(2);
  f.children.set(100, [{ pid: 200, cmd: 'codex' }]);
  f.children.set(101, [{ pid: 201, cmd: 'claude' }]);
  const read = f.options.readSnapshot;
  f.options.readSnapshot = async () => {
    f.current.set('saved-0', { terminal: { pid: 100 }, generation: 2 });
    return read();
  };
  const proof = await captureShutdownProcessProof(f.options);
  assert.equal(proof.lookup('saved-0').status, 'unknown');
  assert.equal(proof.lookup('saved-1').status, 'found');
  f.current.delete('saved-1');
  assert.equal(proof.lookup('saved-1').status, 'unknown');
  assert.equal(f.reads(), 1);
});

test('stale, future, malformed and synchronously thrown snapshots are unknown, never absent', async () => {
  for (const mode of ['old', 'aged', 'future', 'malformed', 'sync-throw']) {
    const f = fixture();
    f.options.readSnapshot = () => {
      if (mode === 'sync-throw') throw new Error('spawn failed');
      const value = { children: new Map(), processesByPid: new Map(), createdAt: 100 };
      if (mode === 'old') value.createdAt = 99;
      if (mode === 'aged') f.advance(750);
      if (mode === 'future') value.createdAt = 101;
      if (mode === 'malformed') value.children = {};
      return value;
    };
    const proof = await captureShutdownProcessProof(f.options);
    assert.equal(proof.summary.unknown, 43, mode);
    for (const target of f.targets) assert.equal(proof.lookup(target.tabId).status, 'unknown', mode);
  }
});

test('empty inventory admits no snapshot', async () => {
  const f = fixture(0);
  const proof = await captureShutdownProcessProof(f.options);
  assert.equal(f.reads(), 0);
  assert.equal(proof.summary.snapshotReads, 0);
});

test('one invalid scope does not truncate the inventory or invoke a new snapshot', async () => {
  const f = fixture();
  f.targets[0].processScope.terminal.pid = null;
  const proof = await captureShutdownProcessProof(f.options);
  assert.equal(proof.summary.targets, 43);
  assert.equal(proof.summary.unknown, 1);
  assert.equal(proof.summary.absent, 42);
  assert.equal(f.reads(), 1);
});
