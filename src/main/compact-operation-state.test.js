'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CompactOperationRegistry,
  claudeCompactOutcomeFromReason,
  classifyCodexCompactEvidence,
  codexCompactOutcomeFromReason,
  isExactCompactCommand,
} = require('./compact-operation-state');

function makeRegistry(options = {}) {
  let now = 1000;
  const published = [];
  const registry = new CompactOperationRegistry({
    now: () => ++now,
    publish: (value) => published.push(value),
    ...options,
  });
  return { registry, published };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('only the exact accepted /compact command starts the phase', () => {
  assert.equal(isExactCompactCommand('/compact'), true);
  assert.equal(isExactCompactCommand('  /compact\r\n'), true);
  assert.equal(isExactCompactCommand('/compact now'), false);
  assert.equal(isExactCompactCommand('please run /compact'), false);
  assert.equal(isExactCompactCommand('quote: "/compact"'), false);

  const { registry, published } = makeRegistry();
  assert.equal(registry.begin({
    tabId: 'tab-a',
    provider: 'claude',
    command: 'please run /compact',
    operationId: 'quoted-command',
  }), null);
  assert.equal(registry.snapshot('tab-a').active, null);
  assert.deepEqual(published, []);
});

test('Codex rollout evidence distinguishes command, telemetry and durable completion', () => {
  assert.deepEqual(classifyCodexCompactEvidence({
    type: 'event_msg', payload: { type: 'user_message', message: '/compact' },
  }), { kind: 'start', command: '/compact', reason: 'user_message' });
  assert.deepEqual(classifyCodexCompactEvidence({
    type: 'event_msg', payload: { type: 'user_message', message: 'quote /compact' },
  }), { kind: 'none' });
  assert.deepEqual(classifyCodexCompactEvidence({
    type: 'event_msg', payload: { type: 'context_compacted' },
  }), { kind: 'telemetry', reason: 'context_compacted' });
  assert.deepEqual(classifyCodexCompactEvidence({ type: 'compacted', payload: { summary: '...' } }), {
    kind: 'terminal', outcome: 'completed', reason: 'compacted',
  });
  assert.deepEqual(classifyCodexCompactEvidence({
    type: 'event_msg', payload: { type: 'turn_aborted' },
  }), { kind: 'terminal', outcome: 'aborted', reason: 'turn_aborted' });
  assert.deepEqual(classifyCodexCompactEvidence({
    type: 'event_msg', payload: { type: 'task_complete' },
  }), { kind: 'terminal', outcome: 'failed', reason: 'task_complete' });
  assert.deepEqual(classifyCodexCompactEvidence({
    type: 'event_msg', payload: { type: 'error', message: 'provider failed' },
  }), { kind: 'terminal', outcome: 'failed', reason: 'compact-provider-error' });
});

test('completion removes live compacting while retaining an exact handoff receipt', () => {
  const { registry, published } = makeRegistry();
  const active = registry.begin({
    tabId: 'tab-a',
    provider: 'claude',
    command: '/compact',
    operationId: 'claude:7:12',
    sessionId: 'session-a',
    generation: 7,
    handoffId: 'handoff-a',
  });

  assert.equal(active.phase, 'compacting');
  assert.equal(active.active, true);
  const settled = registry.finish({
    tabId: 'tab-a',
    provider: 'claude',
    operationId: 'claude:7:12',
    outcome: claudeCompactOutcomeFromReason('compact_boundary'),
    reason: 'compact_boundary',
  });

  assert.equal(settled.active, false);
  assert.equal(settled.phase, null);
  assert.equal(settled.outcome, 'completed');
  assert.equal(settled.handoffId, 'handoff-a');
  assert.equal(registry.snapshot('tab-a').active, null);
  assert.equal(registry.snapshot('tab-a').settled.length, 1);
  assert.equal(published.length, 2);
});

test('an exact DEV settlement hold keeps compact active until release', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const completions = [];
  const { registry, published } = makeRegistry({
    beforeFinish: ({ active }) => active.operationId === 'held-compact'
      ? {
          hold: true,
          released: held,
          complete: (result) => completions.push(result),
        }
      : null,
  });
  registry.begin({
    tabId: 'tab-a', provider: 'claude', command: '/compact', operationId: 'held-compact',
  });

  const provisional = registry.finish({
    tabId: 'tab-a', provider: 'claude', operationId: 'held-compact',
    outcome: 'completed', reason: 'compact_boundary',
  });
  assert.equal(provisional.active, true);
  assert.equal(registry.snapshot('tab-a').active.operationId, 'held-compact');
  assert.equal(registry.snapshot('tab-a').settled.length, 0);
  assert.equal(published.length, 1);

  // A duplicate callback while held cannot bypass the exact boundary.
  registry.finish({
    tabId: 'tab-a', provider: 'claude', operationId: 'held-compact',
    outcome: 'completed', reason: 'compact_summary',
  });
  assert.equal(registry.snapshot('tab-a').settled.length, 0);

  release({ reason: 'test-release' });
  await nextTurn();
  const snapshot = registry.snapshot('tab-a');
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.settled.length, 1);
  assert.equal(snapshot.settled[0].reason, 'compact_boundary');
  assert.equal(published.length, 2);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stale, false);
});

test('a held stale compact owner cannot settle a replacement operation', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const completions = [];
  const { registry } = makeRegistry({
    beforeFinish: ({ active, input }) => (
      active.operationId === 'old'
      && input.reason === 'compact_boundary'
    ) ? {
        hold: true,
        released: held,
        complete: (result) => completions.push(result),
      } : null,
  });
  registry.begin({ tabId: 'tab-a', provider: 'claude', command: '/compact', operationId: 'old' });
  registry.finish({
    tabId: 'tab-a', provider: 'claude', operationId: 'old',
    outcome: 'completed', reason: 'compact_boundary',
  });
  registry.begin({ tabId: 'tab-a', provider: 'claude', command: '/compact', operationId: 'new' });
  assert.equal(registry.snapshot('tab-a').active.operationId, 'new');

  release({ reason: 'late-release' });
  await nextTurn();
  assert.equal(registry.snapshot('tab-a').active.operationId, 'new');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stale, true);
});

test('a fresh registry after app restart cannot resurrect historical compacting', () => {
  const first = makeRegistry().registry;
  first.begin({
    tabId: 'tab-a', provider: 'codex', command: '/compact', operationId: 'codex:1:1',
  });
  first.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'codex:1:1', outcome: 'completed', reason: 'compacted',
  });

  const restarted = makeRegistry().registry;
  assert.deepEqual(restarted.snapshot('tab-a'), {
    success: true,
    tabId: 'tab-a',
    active: null,
    settled: [],
  });
});

test('provider-specific abort and failure proofs settle without pretending success', () => {
  assert.equal(claudeCompactOutcomeFromReason('compact-cancelled'), 'aborted');
  assert.equal(claudeCompactOutcomeFromReason('stop-failure'), 'failed');
  assert.equal(claudeCompactOutcomeFromReason('compact-not-enough-messages'), 'failed');
  assert.equal(claudeCompactOutcomeFromReason('compact-provider-error'), 'failed');
  assert.equal(claudeCompactOutcomeFromReason('auto-compact-boundary'), 'unknown');
  assert.equal(codexCompactOutcomeFromReason('turn_aborted'), 'aborted');
  assert.equal(codexCompactOutcomeFromReason('pty-exit'), 'aborted');
  assert.equal(codexCompactOutcomeFromReason('task_complete'), 'failed');
  assert.equal(codexCompactOutcomeFromReason('command-finished'), 'failed');
  assert.equal(codexCompactOutcomeFromReason('context_compacted'), 'unknown');

  const { registry } = makeRegistry();
  registry.begin({
    tabId: 'tab-a', provider: 'codex', command: '/compact', operationId: 'codex:1:2',
  });
  const settled = registry.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'codex:1:2',
    outcome: codexCompactOutcomeFromReason('turn_aborted'), reason: 'turn_aborted',
  });
  assert.equal(settled.outcome, 'aborted');
  assert.equal(registry.snapshot('tab-a').active, null);
});

test('back-to-back compact closes the older owner and tracks only the new one', () => {
  const { registry, published } = makeRegistry();
  registry.begin({
    tabId: 'tab-a', provider: 'claude', command: '/compact', operationId: 'compact-one',
  });
  registry.begin({
    tabId: 'tab-a', provider: 'claude', command: '/compact', operationId: 'compact-two',
  });

  const snapshot = registry.snapshot('tab-a');
  assert.equal(snapshot.active.operationId, 'compact-two');
  assert.equal(snapshot.settled.length, 1);
  assert.equal(snapshot.settled[0].operationId, 'compact-one');
  assert.equal(snapshot.settled[0].outcome, 'unknown');
  assert.equal(snapshot.settled[0].reason, 'superseded-by-new-compact');
  assert.deepEqual(published.map((item) => item.active), [true, false, true]);
});

test('terminal proof must belong to the same provider, generation, session and operation', () => {
  const { registry } = makeRegistry();
  registry.begin({
    tabId: 'tab-a', provider: 'codex', command: '/compact', operationId: 'op-a',
    sessionId: 'session-a', generation: 'generation-a',
  });

  assert.equal(registry.finish({
    tabId: 'tab-a', provider: 'claude', operationId: 'op-a', outcome: 'completed',
  }), null);
  assert.equal(registry.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'op-a', sessionId: 'session-b', outcome: 'completed',
  }), null);
  assert.equal(registry.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'op-a', generation: 'generation-b', outcome: 'completed',
  }), null);
  assert.equal(registry.snapshot('tab-a').active.operationId, 'op-a');
});

test('settled identities cannot replay and the remount receipt ledger is count-bounded', () => {
  const { registry } = makeRegistry({ maxSettledPerTab: 2 });
  for (const operationId of ['one', 'two', 'three']) {
    registry.begin({ tabId: 'tab-a', provider: 'codex', command: '/compact', operationId });
    registry.finish({ tabId: 'tab-a', provider: 'codex', operationId, outcome: 'completed', reason: 'compacted' });
  }
  assert.deepEqual(registry.snapshot('tab-a').settled.map((item) => item.operationId), ['two', 'three']);
  assert.equal(registry.begin({
    tabId: 'tab-a', provider: 'codex', command: '/compact', operationId: 'three',
  }), null);
});

test('Codex compacted evidence must be causally after the accepted user_message', () => {
  const { registry } = makeRegistry();
  registry.begin({
    tabId: 'tab-a', provider: 'codex', command: '/compact', operationId: 'op-a',
    sessionId: 'session-a', generation: 'generation-a', sourceByteOffset: 100,
  });
  assert.equal(registry.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'op-a',
    sessionId: 'session-a', generation: 'generation-a', outcome: 'completed',
    reason: 'compacted', completionByteOffset: 99,
  }), null);
  assert.equal(registry.snapshot('tab-a', 'codex').active.operationId, 'op-a');
  const settled = registry.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'op-a',
    sessionId: 'session-a', generation: 'generation-a', outcome: 'completed',
    reason: 'compacted', completionByteOffset: 101,
  });
  assert.equal(settled.outcome, 'completed');
});

const defaultManualTerminal = Object.freeze({ id: 'terminal-a' });

function armManualCodex(registry, extra = {}) {
  return registry.armPending({
    tabId: 'tab-a',
    provider: 'codex',
    command: '/compact',
    operationId: extra.operationId || 'manual-race',
    sessionId: extra.sessionId || 'session-a',
    generation: extra.generation || 'generation-a',
    promptGeneration: extra.promptGeneration ?? 3,
    terminal: extra.terminal || defaultManualTerminal,
    sourceByteOffset: Object.hasOwn(extra, 'sourceByteOffset')
      ? extra.sourceByteOffset
      : 100,
    causalBoundaryEventSequence: extra.causalBoundaryEventSequence ?? 56,
    source: 'manual-xterm-enter',
  });
}

function confirmManualCodex(registry, extra = {}) {
  return registry.confirmStart({
    tabId: 'tab-a',
    provider: 'codex',
    operationId: extra.operationId || 'manual-race',
    sessionId: extra.sessionId || 'session-a',
    generation: extra.generation || 'generation-a',
    promptGeneration: extra.promptGeneration ?? 3,
    terminal: extra.terminal || defaultManualTerminal,
    eventSequence: extra.eventSequence ?? 57,
    sourceByteOffset: Object.hasOwn(extra, 'sourceByteOffset')
      ? extra.sourceByteOffset
      : 100,
    proof: 'task_started',
  });
}

function beginManualCodex(registry, extra = {}) {
  armManualCodex(registry, extra);
  return confirmManualCodex(registry, extra);
}

test('first manual Enter only arms an invisible pending intent', () => {
  const { registry, published } = makeRegistry();
  const pending = armManualCodex(registry, { operationId: 'first-enter' });

  assert.equal(pending.pending, true);
  assert.equal(pending.active, false);
  assert.equal(pending.phase, null);
  assert.equal(pending.promptGeneration, 3);
  assert.equal(pending.sourceByteOffset, 100);
  assert.equal(pending.causalBoundaryEventSequence, 56);
  assert.equal(registry.getPending('tab-a', 'codex').operationId, 'first-enter');
  assert.equal(registry.getActive('tab-a', 'codex'), null);
  assert.deepEqual(registry.snapshot('tab-a', 'codex'), {
    success: true,
    tabId: 'tab-a',
    active: null,
    settled: [],
  });
  assert.deepEqual(published, []);
});

test('second Enter task_started at EOF and seq+1 promotes exactly one active operation', () => {
  const { registry, published } = makeRegistry();
  const pending = armManualCodex(registry, {
    operationId: 'two-enter', sourceByteOffset: 81417, causalBoundaryEventSequence: 56,
  });
  // Re-observing the same admitted intent must preserve the original boundary.
  assert.equal(registry.armPending({ ...pending }).sourceByteOffset, 81417);
  assert.deepEqual(published, []);

  const active = confirmManualCodex(registry, {
    operationId: 'two-enter', sourceByteOffset: 81417, eventSequence: 57,
  });
  assert.equal(active.active, true);
  assert.equal(active.phase, 'compacting');
  assert.equal(active.causalStartConfirmed, true);
  assert.equal(active.causalStartByteOffset, 81417);
  assert.equal(registry.getPending('tab-a', 'codex'), null);
  assert.equal(published.length, 1);
  assert.equal(published[0].operationId, 'two-enter');
  assert.equal(Object.hasOwn(published[0], 'terminal'), false);

  assert.equal(confirmManualCodex(registry, {
    operationId: 'two-enter', sourceByteOffset: 81417, eventSequence: 58,
  }).operationId, 'two-enter');
  assert.equal(published.length, 1, 'duplicate task_started must not republish');
});

test('one-Enter provider start promotes on its first causal task_started', () => {
  const { registry, published } = makeRegistry();
  armManualCodex(registry, {
    operationId: 'one-enter', sourceByteOffset: 133304, causalBoundaryEventSequence: 30,
  });
  const active = confirmManualCodex(registry, {
    operationId: 'one-enter', sourceByteOffset: 133304, eventSequence: 31,
  });
  assert.equal(active.operationId, 'one-enter');
  assert.equal(active.startedAt > active.acceptedAt, true);
  assert.deepEqual(published.map((item) => item.active), [true]);
});

test('stale pre-boundary task_started, compacted, and task_complete cannot activate or settle pending', () => {
  const { registry, published } = makeRegistry();
  armManualCodex(registry, {
    operationId: 'stale-before-start', sourceByteOffset: 81417, causalBoundaryEventSequence: 56,
  });
  assert.equal(confirmManualCodex(registry, {
    operationId: 'stale-before-start', sourceByteOffset: 81417, eventSequence: 56,
  }), null);
  assert.equal(confirmManualCodex(registry, {
    operationId: 'stale-before-start', sourceByteOffset: 81416, eventSequence: 57,
  }), null);
  assert.equal(registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'stale-before-start',
    sessionId: 'session-a', generation: 'generation-a', kind: 'compacted',
    rolloutOffset: 81416, eventSequence: 55,
  }), null);
  assert.equal(registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'stale-before-start',
    sessionId: 'session-a', generation: 'generation-a', kind: 'task_complete',
    rolloutOffset: 81416, eventSequence: 56,
  }), null);
  assert.equal(registry.finish({
    tabId: 'tab-a', provider: 'codex', operationId: 'stale-before-start',
    outcome: 'completed', reason: 'compacted', completionByteOffset: 81500,
  }), null);
  assert.equal(registry.getPending('tab-a', 'codex').operationId, 'stale-before-start');
  assert.equal(registry.snapshot('tab-a', 'codex').settled.length, 0);
  assert.deepEqual(published, []);
});

test('ordinary prompts and mentions do not arm, while changed manual content cancels pending privately', () => {
  const { registry, published } = makeRegistry();
  for (const command of ['/compact now', 'please run /compact', 'quote: "/compact"']) {
    assert.equal(registry.armPending({
      tabId: 'tab-a', provider: 'codex', command, operationId: command,
    }), null);
  }
  armManualCodex(registry, { operationId: 'cancel-by-content' });
  const cancelled = registry.cancelPending({
    tabId: 'tab-a', provider: 'codex', operationId: 'cancel-by-content',
    reason: 'manual-content-changed',
  });
  assert.equal(cancelled.cancelReason, 'manual-content-changed');
  assert.equal(registry.getPending('tab-a', 'codex'), null);
  assert.deepEqual(published, []);
});

test('owner/generation mismatch is guarded and Stop, Esc, Ctrl+C clear pending without UI receipts', () => {
  const reasons = [
    'owner-generation-changed', 'manual-stop', 'input-escape', 'input-ctrl-c',
  ];
  for (const reason of reasons) {
    const { registry, published } = makeRegistry();
    armManualCodex(registry, { operationId: reason });
    assert.equal(registry.cancelPending({
      tabId: 'tab-a', provider: 'codex', operationId: reason,
      terminal: { id: 'other-terminal' }, reason,
    }), null);
    assert.equal(registry.getPending('tab-a', 'codex').operationId, reason);
    assert.equal(registry.cancelPending({
      tabId: 'tab-a', provider: 'codex', operationId: reason, reason,
    }).cancelReason, reason);
    assert.equal(registry.getPending('tab-a', 'codex'), null);
    assert.deepEqual(published, []);
  }
});

test('manual Codex causal start rejects a missing offset and stale owner', () => {
  const cases = [
    { name: 'missing-offset', sourceByteOffset: null },
    { name: 'stale-session', sessionId: 'session-b' },
    { name: 'stale-generation', generation: 'generation-b' },
    { name: 'stale-prompt', promptGeneration: 4 },
    { name: 'stale-terminal', terminal: { id: 'terminal-b' } },
  ];
  for (const testCase of cases) {
    const { registry } = makeRegistry();
    armManualCodex(registry, {
      operationId: testCase.name, sourceByteOffset: 81417, causalBoundaryEventSequence: 56,
    });
    assert.equal(confirmManualCodex(registry, {
      operationId: testCase.name,
      sessionId: testCase.sessionId,
      generation: testCase.generation,
      promptGeneration: testCase.promptGeneration,
      terminal: testCase.terminal,
      sourceByteOffset: Object.hasOwn(testCase, 'sourceByteOffset')
        ? testCase.sourceByteOffset
        : 81417,
      eventSequence: 57,
    }), null, testCase.name);
  }
});

test('manual Codex compacted at or before the causal source boundary cannot complete', () => {
  for (const compactedOffset of [81416, 81417]) {
    const { registry } = makeRegistry();
    const operationId = 'boundary-compacted-' + compactedOffset;
    beginManualCodex(registry, {
      operationId, sourceByteOffset: 81417, causalBoundaryEventSequence: 56,
    });
    assert.equal(registry.observeCodexEvidence({
      tabId: 'tab-a', provider: 'codex', operationId,
      sessionId: 'session-a', generation: 'generation-a', kind: 'compacted',
      rolloutOffset: compactedOffset, eventSequence: 58,
    }), null);
    assert.equal(registry.snapshot('tab-a').active.operationId, operationId);
  }
});

test('compacted → context_compacted → task_complete after start completes exactly once', () => {
  const { registry, published } = makeRegistry();
  const owner = {
    tabId: 'tab-a', provider: 'codex', operationId: 'real-sequence',
    sessionId: 'session-a', generation: 'generation-a',
  };
  beginManualCodex(registry, {
    operationId: owner.operationId, sourceByteOffset: 81417,
    causalBoundaryEventSequence: 56,
  });
  registry.observeCodexEvidence({ ...owner, kind: 'compacted', rolloutOffset: 81650, eventSequence: 58 });
  registry.observeCodexEvidence({ ...owner, kind: 'context_compacted', rolloutOffset: 81800, eventSequence: 59 });
  registry.observeCodexEvidence({ ...owner, kind: 'task_complete', rolloutOffset: 81900, eventSequence: 60 });
  const settled = registry.finalizeCodexTaskComplete(owner);
  assert.equal(settled.outcome, 'completed');
  assert.equal(settled.reason, 'compacted');
  assert.equal(registry.finalizeCodexTaskComplete(owner), null);
  assert.equal(published.filter((item) => item.active === false).length, 1);
});

test('compacted → context_compacted → task_complete in one append completes', () => {
  const { registry } = makeRegistry();
  beginManualCodex(registry);
  registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'manual-race',
    sessionId: 'session-a', generation: 'generation-a', kind: 'compacted',
    rolloutOffset: 120, eventSequence: 57,
  });
  registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'manual-race',
    sessionId: 'session-a', generation: 'generation-a', kind: 'task_complete',
    rolloutOffset: 140, eventSequence: 59,
  });
  const settled = registry.finalizeCodexTaskComplete({
    tabId: 'tab-a', provider: 'codex', operationId: 'manual-race',
    sessionId: 'session-a', generation: 'generation-a',
  });
  assert.equal(settled.outcome, 'completed');
  assert.equal(settled.reason, 'compacted');
});

test('task_complete callback before compacted still lets the lower rollout offset win', () => {
  const { registry } = makeRegistry();
  beginManualCodex(registry, { operationId: 'reverse-callbacks' });
  registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'reverse-callbacks',
    sessionId: 'session-a', generation: 'generation-a', kind: 'task_complete',
    rolloutOffset: 140, eventSequence: 59,
  });
  const settled = registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'reverse-callbacks',
    sessionId: 'session-a', generation: 'generation-a', kind: 'compacted',
    rolloutOffset: 120, eventSequence: 57,
  });
  assert.equal(settled.outcome, 'completed');
});

test('task_complete without preceding compacted is failed after catch-up', () => {
  const { registry } = makeRegistry();
  beginManualCodex(registry, { operationId: 'no-provider-proof' });
  registry.observeCodexEvidence({
    tabId: 'tab-a', provider: 'codex', operationId: 'no-provider-proof',
    sessionId: 'session-a', generation: 'generation-a', kind: 'task_complete',
    rolloutOffset: 140, eventSequence: 59,
  });
  const settled = registry.finalizeCodexTaskComplete({
    tabId: 'tab-a', provider: 'codex', operationId: 'no-provider-proof',
    sessionId: 'session-a', generation: 'generation-a',
  });
  assert.equal(settled.outcome, 'failed');
  assert.equal(settled.reason, 'task_complete');
});

test('compacted after task_complete or before source boundary cannot rescue failure', () => {
  for (const compactedOffset of [140, 99]) {
    const { registry } = makeRegistry();
    const operationId = 'invalid-proof-' + compactedOffset;
    beginManualCodex(registry, { operationId });
    registry.observeCodexEvidence({
      tabId: 'tab-a', provider: 'codex', operationId,
      sessionId: 'session-a', generation: 'generation-a', kind: 'task_complete',
      rolloutOffset: 130, eventSequence: 59,
    });
    assert.equal(registry.observeCodexEvidence({
      tabId: 'tab-a', provider: 'codex', operationId,
      sessionId: 'session-a', generation: 'generation-a', kind: 'compacted',
      rolloutOffset: compactedOffset, eventSequence: 60,
    }), null);
    const settled = registry.finalizeCodexTaskComplete({
      tabId: 'tab-a', provider: 'codex', operationId,
      sessionId: 'session-a', generation: 'generation-a',
    });
    assert.equal(settled.outcome, 'failed');
  }
});

test('stale session, generation, and offset evidence is ignored', () => {
  const { registry } = makeRegistry();
  beginManualCodex(registry, { operationId: 'stale-proof' });
  for (const extra of [
    { sessionId: 'session-b' },
    { generation: 'generation-b' },
    { rolloutOffset: 100 },
  ]) {
    assert.equal(registry.observeCodexEvidence({
      tabId: 'tab-a', provider: 'codex', operationId: 'stale-proof',
      sessionId: extra.sessionId || 'session-a',
      generation: extra.generation || 'generation-a', kind: 'compacted',
      rolloutOffset: extra.rolloutOffset ?? 120, eventSequence: 57,
    }), null);
  }
  assert.equal(registry.snapshot('tab-a').active.operationId, 'stale-proof');
});

test('duplicate callbacks do not change the single terminal outcome', () => {
  const { registry, published } = makeRegistry();
  beginManualCodex(registry, { operationId: 'duplicates' });
  const evidence = {
    tabId: 'tab-a', provider: 'codex', operationId: 'duplicates',
    sessionId: 'session-a', generation: 'generation-a', kind: 'compacted',
    rolloutOffset: 120, eventSequence: 57,
  };
  registry.observeCodexEvidence(evidence);
  registry.observeCodexEvidence(evidence);
  registry.observeCodexEvidence({ ...evidence, kind: 'task_complete', rolloutOffset: 140, eventSequence: 59 });
  const settled = registry.finalizeCodexTaskComplete({
    tabId: 'tab-a', provider: 'codex', operationId: 'duplicates',
    sessionId: 'session-a', generation: 'generation-a',
  });
  assert.equal(settled.outcome, 'completed');
  assert.equal(registry.observeCodexEvidence(evidence), null);
  assert.equal(published.filter((item) => item.active === false).length, 1);
});
