'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createClaudeStartupCoordinator,
  normalizeProof,
  PROOF,
} = require('./claude-startup-transaction');

function makeHarness(overrides = {}) {
  const sends = [];
  const proofs = [];
  const logs = [];
  let clock = 1000;

  const proofScript = overrides.proofScript || (() => ({ outcome: PROOF.FOUND }));
  const sendScript = overrides.sendScript || (() => ({ success: true }));

  const coordinator = createClaudeStartupCoordinator({
    now: () => (clock += 10),
    log: (line) => logs.push(line),
  });

  const sendCommand = async (args) => {
    sends.push(args);
    return sendScript(args, sends.length);
  };
  const proveCommand = async (args) => {
    proofs.push(args);
    return proofScript(args, proofs.length);
  };

  const steps = [
    { phase: 'model', command: '/model haiku', source: 'startup:model', label: 'model' },
    { phase: 'effort', command: '/effort max', source: 'startup:effort', label: 'effort' },
  ];

  return { coordinator, sends, proofs, logs, steps, sendCommand, proveCommand };
}

test('both readiness signals in either order open exactly one transaction', async () => {
  for (const order of [['tui-ready', 'process-started'], ['process-started', 'tui-ready']]) {
    const h = makeHarness();
    const first = h.coordinator.ensureTransaction({
      tabId: 'tab-1', generation: 'pid-100', trigger: order[0],
      steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
    });
    const second = h.coordinator.ensureTransaction({
      tabId: 'tab-1', generation: 'pid-100', trigger: order[1],
      steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
    });

    assert.equal(first.started, true, 'first signal opens the transaction (' + order[0] + ')');
    assert.equal(second.started, false, 'second signal joins, never opens a second owner');
    assert.equal(second.joined, true);

    const result = await first.promise;
    assert.equal(result.status, 'ready');

    // The prod bug: /model from one owner, /effort from another. Every command
    // of one launch must carry the transaction's own sources, exactly once.
    assert.deepEqual(h.sends.map((s) => s.command), ['/model haiku', '/effort max']);
    assert.equal(h.coordinator.snapshot('tab-1').openedBy, order[0]);
  }
});

test('effort is not sent until model is proven (no overlapping paste)', async () => {
  const timeline = [];
  const h = makeHarness({
    sendScript: (args) => { timeline.push('send:' + args.command); return { success: true }; },
    proofScript: (args) => { timeline.push('proof:' + args.command); return { outcome: PROOF.FOUND }; },
  });
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-2', generation: 'pid-1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  await run.promise;

  assert.deepEqual(timeline, [
    'send:/model haiku', 'proof:/model haiku',
    'send:/effort max', 'proof:/effort max',
  ]);
});

test('per-command proof windows do not overlap', async () => {
  const h = makeHarness();
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-3', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  await run.promise;

  const [modelProof, effortProof] = h.proofs;
  assert.ok(effortProof.afterMs > modelProof.afterMs,
    'effort epoch must be captured after model finished, not before it started');
});

test('absent proof triggers exactly one automatic retry, then succeeds', async () => {
  let modelProofs = 0;
  const recovery = { kind: 'submit-existing-input' };
  const h = makeHarness({
    proofScript: (args) => {
      if (args.command === '/model haiku') {
        modelProofs += 1;
        return modelProofs === 1
          ? { outcome: PROOF.ABSENT, recovery }
          : { outcome: PROOF.FOUND };
      }
      return { outcome: PROOF.FOUND };
    },
  });
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-4', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const result = await run.promise;

  assert.equal(result.status, 'ready');
  assert.equal(h.sends.filter((s) => s.command === '/model haiku').length, 2, 'one retry send');
  assert.deepEqual(h.sends[1].recovery, recovery, 'retry executes the proven safe recovery mode');
  assert.ok(h.logs.some((l) => l.includes('[StartupRetry] decision=absent action=auto-retry')));
});

test('same-generation empty proof spends the same single retry budget on a fresh repaste', async () => {
  let effortProofs = 0;
  const recovery = { kind: 'repaste-after-empty' };
  const h = makeHarness({
    proofScript: (args) => {
      if (args.command !== '/effort max') return { outcome: PROOF.FOUND };
      effortProofs += 1;
      return effortProofs === 1
        ? { outcome: PROOF.ABSENT, recovery }
        : { outcome: PROOF.FOUND };
    },
  });
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-empty-repaste', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const result = await run.promise;

  assert.equal(result.status, 'ready');
  const effortSends = h.sends.filter((send) => send.command === '/effort max');
  assert.equal(effortSends.length, 2);
  assert.deepEqual(effortSends[1].recovery, recovery);
});

test('unresolved proof is never auto-retried and fails with the command named', async () => {
  const h = makeHarness({
    proofScript: (args) => (args.command === '/effort max'
      ? { outcome: PROOF.UNRESOLVED, reason: 'scan-error' }
      : { outcome: PROOF.FOUND }),
  });
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-5', generation: 'g1', trigger: 'process-started',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const result = await run.promise;

  assert.equal(result.status, 'failed');
  assert.equal(result.failedCommand, '/effort max');
  assert.equal(result.proofOutcome, PROOF.UNRESOLVED);
  assert.equal(result.userRetryable, true);
  assert.equal(h.sends.filter((s) => s.command === '/effort max').length, 1,
    'unresolved delivery must not be re-sent automatically (double-apply risk)');
  assert.ok(h.logs.some((l) => l.includes('[StartupRetry] decision=unresolved action=await-user')));
});

test('paired terminal command rejection surfaces its exact output and never retries', async () => {
  const h = makeHarness({
    proofScript: () => ({
      outcome: PROOF.UNRESOLVED,
      terminal: true,
      reason: 'command-output-rejected',
      outputPreview: "Model 'missing' not found",
    }),
  });

  const opened = h.coordinator.ensureTransaction({
    tabId: 'tab-terminal-failure',
    generation: 'g1',
    trigger: 'tui-ready',
    steps: [{
      phase: 'model',
      command: '/model missing',
      source: 'startup:model',
      label: 'model',
    }],
    sendCommand: h.sendCommand,
    proveCommand: h.proveCommand,
  });
  const result = await opened.promise;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, "Model 'missing' not found");
  assert.equal(h.sends.length, 1);
});

test('absent proof after the retry is used does not retry a second time', async () => {
  const h = makeHarness({ proofScript: () => ({ outcome: PROOF.ABSENT }) });
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-6', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const result = await run.promise;

  assert.equal(result.status, 'failed');
  assert.equal(result.failedCommand, '/model haiku');
  assert.equal(h.sends.length, 2, 'original + exactly one retry, never more');
});

test('a new launch generation supersedes the old transaction', async () => {
  const h = makeHarness();
  const first = h.coordinator.ensureTransaction({
    tabId: 'tab-7', generation: 'pid-1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const second = h.coordinator.ensureTransaction({
    tabId: 'tab-7', generation: 'pid-2', trigger: 'process-started',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });

  assert.equal(second.started, true, 'newer generation opens its own transaction');
  await Promise.all([first.promise, second.promise]);
  assert.equal(h.coordinator.snapshot('tab-7').generation, 'pid-2');
});

test('stale generation cannot close the current transaction', async () => {
  const h = makeHarness();
  h.coordinator.ensureTransaction({
    tabId: 'tab-8', generation: 'old', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const fresh = h.coordinator.ensureTransaction({
    tabId: 'tab-8', generation: 'new', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const result = await fresh.promise;

  assert.equal(result.generation, 'new');
  assert.equal(h.coordinator.snapshot('tab-8').result.generation, 'new');
});

test('duplicate readiness events of the same generation join without re-sending', async () => {
  const h = makeHarness();
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-9', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  for (let i = 0; i < 5; i += 1) {
    h.coordinator.ensureTransaction({
      tabId: 'tab-9', generation: 'g1', trigger: 'tui-ready',
      steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
    });
  }
  await run.promise;
  assert.equal(h.sends.length, 2, 'five duplicate readiness events add zero sends');
  assert.equal(h.coordinator.snapshot('tab-9').joinCount, 5);
});

test('send failure stops the sequence and names the command', async () => {
  const h = makeHarness({
    sendScript: (args) => (args.command === '/model haiku'
      ? { success: false, error: 'no_claude_session' }
      : { success: true }),
  });
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-10', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  const result = await run.promise;

  assert.equal(result.status, 'failed');
  assert.equal(result.failedCommand, '/model haiku');
  assert.equal(result.error, 'no_claude_session');
  assert.equal(h.proofs.length, 0, 'a command that never went out is not proven');
  assert.equal(h.sends.length, 1, 'effort must not be attempted after model send failed');
});

test('clear removes the transaction so the next launch starts clean', async () => {
  const h = makeHarness();
  const run = h.coordinator.ensureTransaction({
    tabId: 'tab-11', generation: 'g1', trigger: 'tui-ready',
    steps: h.steps, sendCommand: h.sendCommand, proveCommand: h.proveCommand,
  });
  await run.promise;
  assert.equal(h.coordinator.clear('tab-11', 'process-exit'), true);
  assert.equal(h.coordinator.snapshot('tab-11'), null);
  assert.equal(h.coordinator.currentGeneration('tab-11'), null);
});

test('normalizeProof maps legacy shapes onto the three-valued contract', () => {
  assert.equal(normalizeProof(true).outcome, PROOF.FOUND);
  assert.equal(normalizeProof(false).outcome, PROOF.ABSENT);
  assert.equal(normalizeProof(null).outcome, PROOF.UNRESOLVED);
  assert.equal(normalizeProof({ success: true }).outcome, PROOF.FOUND);
  assert.equal(normalizeProof({ success: false }).outcome, PROOF.UNRESOLVED,
    'a bare unsuccessful scan is unknown, not proven-absent');
  assert.equal(normalizeProof({ outcome: PROOF.ABSENT }).outcome, PROOF.ABSENT);
});
