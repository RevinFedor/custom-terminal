'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyClaudeStartupIntent,
  classifyClaudeStartupDeliveryProof,
  classifyClaudeStartupRetryComposer,
  createClaudeStartupMainRuntime,
  normalizeClaudeStartupIntent,
  resolveClaudeSettingsAcrossForkChain,
  selectClaudeStartupSettingsSession,
} = require('./claude-startup-main-runtime');
const { PROOF } = require('./claude-startup-transaction');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}) {
  let generation = 'launch-1';
  let now = 100;
  const sends = [];
  const gates = [];
  const proofs = [];
  const runtime = createClaudeStartupMainRuntime({
    now: () => ++now,
    log: () => {},
    currentLaunchGeneration: () => generation,
    resolveSettings: async () => ({ model: 'haiku', effort: 'high' }),
    sendCommand: async (payload) => {
      sends.push(payload);
      return { success: true };
    },
    proveCommand: async (payload) => {
      proofs.push(payload);
      return { outcome: PROOF.FOUND };
    },
    publishGate: (gate) => gates.push(gate),
    ...overrides,
  });
  return {
    runtime,
    sends,
    gates,
    proofs,
    setGeneration(next) { generation = next; },
  };
}

test('fresh launch ignores a stale persisted writer while resume keeps explicit identity', () => {
  assert.equal(selectClaudeStartupSettingsSession({
    launchMode: 'fresh',
    readinessSessionId: 'new-bridge-session',
    persistedSessionId: 'stale-stopped-session',
  }), null);
  assert.equal(selectClaudeStartupSettingsSession({
    launchMode: 'resume',
    launchSessionId: 'explicit-resume-session',
    readinessSessionId: 'bridge-session',
    persistedSessionId: 'stale-stopped-session',
  }), 'explicit-resume-session');
  assert.equal(selectClaudeStartupSettingsSession({
    launchMode: 'unknown',
    readinessSessionId: 'bridge-session',
    persistedSessionId: 'stale-stopped-session',
  }), 'bridge-session');
});

test('only a complete Anthropic next-launch pair overrides resolved settings', () => {
  assert.deepEqual(normalizeClaudeStartupIntent({
    type: 'anthropic',
    startupModel: 'haiku',
    startupEffort: 'medium',
  }), { model: 'haiku', effort: 'medium' });
  assert.equal(normalizeClaudeStartupIntent({
    type: 'anthropic',
    startupModel: 'haiku',
  }), null);
  assert.equal(normalizeClaudeStartupIntent({
    type: 'deepseek',
    startupModel: 'haiku',
    startupEffort: 'medium',
  }), null);

  assert.deepEqual(applyClaudeStartupIntent({
    model: 'opus',
    effort: 'high',
    sessionId: 'source-session',
    source: 'session-history',
  }, {
    model: 'haiku',
    effort: 'medium',
  }), {
    model: 'haiku',
    effort: 'medium',
    sessionId: 'source-session',
    source: 'tab-startup-intent',
  });
});

test('compact fork inherits model but never process-local effort from its durable parent', async () => {
  const reads = [];
  const result = await resolveClaudeSettingsAcrossForkChain({
    sessionId: 'compact-child',
    readSettings: async (sessionId) => {
      reads.push(sessionId);
      if (sessionId === 'compact-child') {
        return { success: true, sessionId, model: null, effort: null };
      }
      return {
        success: true,
        sessionId,
        model: 'haiku',
        effort: 'medium',
        effortCurrentRuntime: false,
      };
    },
    getParentSession: (sessionId) => sessionId === 'compact-child'
      ? { source_session_id: 'source-parent' }
      : null,
  });

  assert.deepEqual(reads, ['compact-child', 'source-parent']);
  assert.equal(result.success, true);
  assert.equal(result.model, 'haiku');
  assert.equal(result.effort, null);
  assert.equal(result.modelSessionId, 'source-parent');
  assert.equal(result.effortSessionId, null);
  assert.equal(result.inherited, true);
});

test('child-confirmed fields win while a fork parent fills only missing settings', async () => {
  const result = await resolveClaudeSettingsAcrossForkChain({
    sessionId: 'child',
    readSettings: async (sessionId) => sessionId === 'child'
      ? { success: true, sessionId, model: null, effort: 'max', effortCurrentRuntime: true }
      : { success: true, sessionId, model: 'haiku', effort: 'medium', effortCurrentRuntime: false },
    getParentSession: (sessionId) => sessionId === 'child'
      ? { source_session_id: 'parent' }
      : null,
  });

  assert.equal(result.model, 'haiku');
  assert.equal(result.effort, 'max');
  assert.equal(result.modelSessionId, 'parent');
  assert.equal(result.effortSessionId, 'child');
});

test('unknown child settings never fall back to an older fork parent', async () => {
  let parentReads = 0;
  const result = await resolveClaudeSettingsAcrossForkChain({
    sessionId: 'child',
    readSettings: async (sessionId) => {
      if (sessionId !== 'child') parentReads += 1;
      return { success: false, sessionId, reason: 'settings-read-failed' };
    },
    getParentSession: () => ({ source_session_id: 'parent' }),
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'settings-read-failed');
  assert.equal(parentReads, 0);
});

test('only explicit no-Enter plus the exact composer command proves startup non-delivery', () => {
  const scan = {
    success: false,
    outcome: PROOF.UNRESOLVED,
    reason: 'stdout-not-found',
  };
  const emptyComposer = classifyClaudeStartupDeliveryProof({
    scan,
    composer: { success: true, exact: false, empty: true },
  });
  assert.equal(emptyComposer.outcome, PROOF.UNRESOLVED);
  assert.equal(emptyComposer.composerProof, 'empty');

  const unknownComposer = classifyClaudeStartupDeliveryProof({
    scan,
    composer: { success: false, error: 'copy_input_failed' },
  });
  assert.equal(unknownComposer.outcome, PROOF.UNRESOLVED);
  assert.equal(unknownComposer.composerProof, 'unknown');

  const exactComposer = classifyClaudeStartupDeliveryProof({
    scan,
    composer: { success: true, exact: true, empty: false },
    sendResult: { success: true, submitted: false },
  });
  assert.equal(exactComposer.outcome, PROOF.ABSENT);
  assert.equal(exactComposer.reason, 'exact-input-awaiting-submit');
  assert.deepEqual(exactComposer.recovery, { kind: 'submit-existing-input' });
  assert.equal(exactComposer.submitProof, 'not-written');

  const exactButEnterMayHaveBeenWritten = classifyClaudeStartupDeliveryProof({
    scan,
    composer: { success: true, exact: true, empty: false },
    sendResult: { success: true },
  });
  assert.equal(exactButEnterMayHaveBeenWritten.outcome, PROOF.UNRESOLVED);
  assert.equal(exactButEnterMayHaveBeenWritten.composerProof, 'exact');
  assert.equal(exactButEnterMayHaveBeenWritten.submitProof, 'unknown');

  const exactAfterEnterWasWritten = classifyClaudeStartupDeliveryProof({
    scan,
    composer: { success: true, exact: true, empty: false },
    sendResult: { success: true, submitted: true },
  });
  assert.equal(exactAfterEnterWasWritten.outcome, PROOF.UNRESOLVED);
  assert.equal(exactAfterEnterWasWritten.submitProof, 'written');
});

test('a swallowed startup paste is repasted once only after exact empty proof in the same generation', () => {
  const scan = {
    success: false,
    outcome: PROOF.UNRESOLVED,
    reason: 'stdout-not-found',
  };
  const startupPromptProof = {
    terminalRunSeq: 7,
    inputRevision: 12,
    terminalLifecycleGeneration: 'lifecycle:4',
    mirrorGeneration: 'mirror:9',
  };
  const composer = {
    success: true,
    exact: false,
    empty: true,
    terminalIdentityStable: true,
    startupGenerationStable: true,
    terminalRunSeq: 7,
    inputRevision: 13,
    terminalLifecycleGeneration: 'lifecycle:4',
    mirrorGeneration: 'mirror:9',
  };
  const sendResult = {
    success: true,
    submitted: false,
    pasteWritten: true,
    reason: 'claude-startup-command-not-proven-at-enter',
    startupPromptProof,
  };

  const retryable = classifyClaudeStartupDeliveryProof({ scan, composer, sendResult });
  assert.equal(retryable.outcome, PROOF.ABSENT);
  assert.equal(retryable.reason, 'exact-empty-after-paste-before-enter');
  assert.deepEqual(retryable.recovery, { kind: 'repaste-after-empty' });

  for (const changed of [
    { inputRevision: 14 },
    { terminalRunSeq: 8 },
    { terminalLifecycleGeneration: 'lifecycle:5' },
    { mirrorGeneration: 'mirror:10' },
    { startupGenerationStable: false },
    { terminalIdentityStable: false },
  ]) {
    const unresolved = classifyClaudeStartupDeliveryProof({
      scan,
      composer: { ...composer, ...changed },
      sendResult,
    });
    assert.equal(unresolved.outcome, PROOF.UNRESOLVED, JSON.stringify(changed));
  }
  assert.equal(classifyClaudeStartupDeliveryProof({
    scan,
    composer,
    sendResult: { ...sendResult, submitted: true },
  }).outcome, PROOF.UNRESOLVED);
});

test('a delayed exact retry command is transaction-owned and must never enter the user stash', () => {
  assert.deepEqual(classifyClaudeStartupRetryComposer({
    recovery: { kind: 'repaste-after-empty' },
    command: '/effort max',
    composer: {
      proofOutcome: 'found',
      hasDraft: true,
      source: 'headless-main:claude-composer:prompt-cursor-row-923',
      text: '/effort max',
    },
  }), {
    ownership: 'transaction-command',
    action: 'submit-existing-input',
    reason: 'exact-retry-command-restored-before-repaste',
  });

  for (const changed of [
    { recovery: null },
    { command: '/effort high' },
    { composer: { proofOutcome: 'found', hasDraft: true, source: 'renderer', text: '/effort max' } },
    { composer: { proofOutcome: 'found', hasDraft: true, source: 'headless-main:test', text: '/effort max plus user text' } },
  ]) {
    const result = classifyClaudeStartupRetryComposer({
      recovery: { kind: 'repaste-after-empty' },
      command: '/effort max',
      composer: {
        proofOutcome: 'found',
        hasDraft: true,
        source: 'headless-main:test',
        text: '/effort max',
      },
      ...changed,
    });
    assert.notEqual(result.ownership, 'transaction-command', JSON.stringify(changed));
  }

  assert.equal(classifyClaudeStartupRetryComposer({
    recovery: { kind: 'repaste-after-empty' },
    command: '/model claude-opus-5[1m]',
    composer: {
      proofOutcome: 'found',
      hasDraft: true,
      source: 'claude-hook-grab-input',
      exactCapture: true,
      text: '/model claude-opus-5[1m]',
    },
  }).action, 'submit-existing-input');
});

test('both readiness signals join one main-owned sequence', async () => {
  let resolves = 0;
  const h = harness({
    resolveSettings: async () => {
      resolves += 1;
      return { model: 'haiku', effort: 'high' };
    },
  });
  const first = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  const second = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'process-started',
  });
  assert.equal(first.started, true);
  assert.equal(second.joined, true);
  await Promise.all([first.promise, second.promise]);
  assert.equal(resolves, 1);
  assert.deepEqual(h.sends.map((item) => item.command), ['/model haiku', '/effort high']);
  assert.deepEqual(h.gates.map((item) => item.status), ['pending', 'ready']);
});

test('exact settings already confirmed by the resumed session close the gate without re-sending slash commands', async () => {
  const h = harness({
    resolveSettings: async () => ({
      model: 'claude-fable-5[1m]',
      effort: 'max',
      modelAlreadyConfirmed: true,
      effortAlreadyConfirmed: true,
      source: 'session-history',
    }),
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  const result = await run.promise;
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.gates.map((item) => item.status), ['pending', 'ready']);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.via, 'session-history');
  assert.equal(h.runtime.snapshot('tab-a').claims.effort.via, 'session-history');
});

test('an explicit next-launch override still sends when it differs from confirmed session history', async () => {
  const h = harness({
    resolveSettings: async () => ({
      model: 'opus',
      effort: 'high',
      modelAlreadyConfirmed: false,
      effortAlreadyConfirmed: true,
      source: 'tab-startup-intent',
    }),
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  const result = await run.promise;
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.sends.map((item) => item.command), ['/model opus']);
});

test('manual effort selected while model proof is pending wins over default effort', async () => {
  const modelProof = deferred();
  const h = harness({
    proveCommand: async (payload) => {
      if (payload.command.startsWith('/model')) return modelProof.promise;
      return { outcome: PROOF.FOUND };
    },
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await Promise.resolve();
  await Promise.resolve();
  const claim = h.runtime.claimManualSetting('tab-a', '/effort max', 'controlbar:effort');
  assert.ok(claim);
  modelProof.resolve({ outcome: PROOF.FOUND });
  await run.promise;
  assert.deepEqual(h.sends.map((item) => item.command), ['/model haiku']);
  assert.equal(h.gates.at(-1).status, 'ready');
});

test('startup waits for a pending manual proof and skips its default after confirmation', async () => {
  const modelProof = deferred();
  const h = harness({
    proveCommand: async (payload) => {
      if (payload.command.startsWith('/model')) return modelProof.promise;
      return { outcome: PROOF.FOUND };
    },
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await Promise.resolve();
  await Promise.resolve();
  const manual = h.runtime.claimManualSetting(
    'tab-a',
    '/effort max',
    'controlbar:effort',
    { expectsSettlement: true },
  );
  modelProof.resolve({ outcome: PROOF.FOUND });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.gates.at(-1).status, 'pending');
  assert.deepEqual(h.sends.map((item) => item.command), ['/model haiku']);

  assert.equal(
    h.runtime.settleManualClaim('tab-a', manual.claim.id, true, 'jsonl-proof-found'),
    true,
  );
  const result = await run.promise;
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.sends.map((item) => item.command), ['/model haiku']);
});

test('failed pending manual proof makes startup apply the configured default', async () => {
  const modelProof = deferred();
  const h = harness({
    proveCommand: async (payload) => {
      if (payload.command.startsWith('/model')) return modelProof.promise;
      return { outcome: PROOF.FOUND };
    },
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await Promise.resolve();
  await Promise.resolve();
  const manual = h.runtime.claimManualSetting(
    'tab-a',
    '/effort max',
    'controlbar:effort',
    { expectsSettlement: true },
  );
  modelProof.resolve({ outcome: PROOF.FOUND });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.gates.at(-1).status, 'pending');

  assert.equal(
    h.runtime.settleManualClaim('tab-a', manual.claim.id, false, 'jsonl-proof-failed'),
    true,
  );
  const result = await run.promise;
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    h.sends.map((item) => item.command),
    ['/model haiku', '/effort high'],
  );
});

test('renderer loss releases a pending manual proof and resumes the startup default', async () => {
  const modelProof = deferred();
  const h = harness({
    proveCommand: async (payload) => {
      if (payload.command.startsWith('/model')) return modelProof.promise;
      return { outcome: PROOF.FOUND };
    },
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await Promise.resolve();
  await Promise.resolve();
  h.runtime.claimManualSetting(
    'tab-a',
    '/effort max',
    'controlbar:effort',
    { expectsSettlement: true },
  );
  modelProof.resolve({ outcome: PROOF.FOUND });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.runtime.abandonPendingManualClaims('renderer-navigation'), 1);
  const result = await run.promise;
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    h.sends.map((item) => item.command),
    ['/model haiku', '/effort high'],
  );
});

test('a newer manual choice of the same setting survives the older startup proof', async () => {
  const modelProof = deferred();
  const h = harness({
    resolveSettings: async () => ({ model: 'haiku', effort: 'none' }),
    proveCommand: async () => modelProof.promise,
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await Promise.resolve();
  await Promise.resolve();
  h.runtime.claimManualSetting('tab-a', '/model opus', 'controlbar:model');
  modelProof.resolve({ outcome: PROOF.FOUND });
  await run.promise;
  const snapshot = h.runtime.snapshot('tab-a');
  assert.equal(snapshot.claims.model.value, 'opus');
  assert.equal(snapshot.claims.model.via, 'controlbar:model');
});

test('failed newer manual choice rolls back to the already-proven startup setting', async () => {
  const modelProof = deferred();
  const h = harness({
    resolveSettings: async () => ({ model: 'haiku', effort: 'none' }),
    proveCommand: async () => modelProof.promise,
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await Promise.resolve();
  await Promise.resolve();
  const manual = h.runtime.claimManualSetting(
    'tab-a',
    '/model opus',
    'controlbar:model',
    { expectsSettlement: true },
  );
  modelProof.resolve({ outcome: PROOF.FOUND });
  await run.promise;
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'opus');

  assert.equal(
    h.runtime.settleManualClaim('tab-a', manual.claim.id, false, 'jsonl-proof-failed'),
    true,
  );
  const snapshot = h.runtime.snapshot('tab-a');
  assert.equal(snapshot.claims.model.value, 'haiku');
  assert.equal(snapshot.claims.model.via, 'startup-defaults');
});

test('failed manual send can roll its claim back', () => {
  const h = harness();
  const token = h.runtime.claimManualSetting('tab-a', '/model opus', 'controlbar:model');
  assert.ok(token);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'opus');
  assert.equal(h.runtime.rollbackManualClaim(token), true);
  assert.equal(h.runtime.snapshot('tab-a').claims.model, null);
});

test('a later manual proof failure rolls back only its matching pending claim', () => {
  const h = harness();
  const first = h.runtime.claimManualSetting('tab-a', '/model haiku', 'controlbar:model');
  const second = h.runtime.claimManualSetting('tab-a', '/model opus', 'controlbar:model');
  assert.equal(h.runtime.settleManualClaim('tab-a', first.claim.id, false), false);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'opus');
  assert.equal(h.runtime.settleManualClaim('tab-a', second.claim.id, false), true);
  assert.equal(h.runtime.snapshot('tab-a').claims.model, null);
});

test('manual retry keeps proven model and only retries failed effort', async () => {
  let effortAttempts = 0;
  const h = harness({
    proveCommand: async (payload) => {
      if (payload.command.startsWith('/model')) return { outcome: PROOF.FOUND };
      effortAttempts += 1;
      return effortAttempts <= 2
        ? { outcome: PROOF.ABSENT, reason: 'stdout-not-found' }
        : { outcome: PROOF.FOUND };
    },
  });
  const first = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  const firstResult = await first.promise;
  assert.equal(firstResult.status, 'failed');
  assert.deepEqual(
    h.sends.map((item) => item.command),
    ['/model haiku', '/effort high', '/effort high'],
  );
  const retry = h.runtime.retry('tab-a');
  assert.equal(retry.started, true);
  const retryResult = await retry.promise;
  assert.equal(retryResult.status, 'ready');
  assert.deepEqual(
    h.sends.map((item) => item.command),
    ['/model haiku', '/effort high', '/effort high', '/effort high'],
  );
});

test('stale generation cannot start or publish a gate', async () => {
  const h = harness();
  h.setGeneration('launch-2');
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  assert.equal(run.reason, 'stale-generation');
  await run.promise;
  assert.equal(h.sends.length, 0);
  assert.equal(h.gates.length, 0);
});

test('retry source is explicit so first-attempt fault hooks do not swallow it twice', async () => {
  let proofCount = 0;
  const h = harness({
    proveCommand: async () => {
      proofCount += 1;
      return proofCount === 1
        ? { outcome: PROOF.ABSENT }
        : { outcome: PROOF.FOUND };
    },
    resolveSettings: async () => ({ model: 'none', effort: 'high' }),
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  await run.promise;
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[0].source, 'startup-defaults:tui-ready-effort');
  assert.equal(h.sends[1].source, 'startup-defaults:tui-ready-effort:retry');
});

test('unresolved proof publishes an actionable failed gate without auto-retry', async () => {
  const h = harness({
    resolveSettings: async () => ({ model: 'haiku', effort: 'none' }),
    proveCommand: async () => ({
      outcome: PROOF.UNRESOLVED,
      reason: 'session-file-missing',
    }),
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  const result = await run.promise;
  assert.equal(result.status, 'failed');
  assert.equal(h.sends.length, 1);
  assert.equal(h.gates.at(-1).status, 'failed');
  assert.equal(h.gates.at(-1).failedCommand, '/model haiku');
  assert.equal(h.gates.at(-1).proofOutcome, PROOF.UNRESOLVED);
  assert.equal(h.gates.at(-1).userRetryable, true);
});

test('no configured steps still closes the durable gate as ready', async () => {
  const h = harness({
    resolveSettings: async () => ({ model: 'none', effort: 'none' }),
  });
  const run = h.runtime.ensure({
    tabId: 'tab-a',
    generation: 'launch-1',
    trigger: 'tui-ready',
  });
  const result = await run.promise;
  assert.equal(result.status, 'ready');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.gates.map((item) => item.status), ['pending', 'ready']);
});
