'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createClaudeStartupProofSession,
} = require('./claude-startup-proof-session');

const quietLog = { log() {}, warn() {} };

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(overrides = {}) {
  const subscriptions = [];
  const unsubscriptions = [];
  let generation = 'launch-1';
  let binding = { sessionId: 'session-a', cwd: '/tmp/project' };
  let proof = { success: false, outcome: 'unresolved', reason: 'not-yet' };
  const reads = [];
  const owner = createClaudeStartupProofSession({
    subscribe: overrides.subscribe || (async (payload) => {
      subscriptions.push(payload);
      return { success: true };
    }),
    unsubscribe: overrides.unsubscribe || (async (payload) => {
      unsubscriptions.push(payload);
      return { success: true };
    }),
    readProof: overrides.readProof || (async (payload) => {
      reads.push(payload);
      return proof;
    }),
    resolveBinding: overrides.resolveBinding || (async () => binding),
    currentGeneration: () => generation,
    holdSuccessfulProofForTest: overrides.holdSuccessfulProofForTest || null,
    log: quietLog,
  });
  return {
    owner,
    subscriptions,
    unsubscriptions,
    reads,
    setProof(value) { proof = value; },
    setBinding(value) { binding = value; },
    setGeneration(value) { generation = value; },
  };
}

test('wait remains pending beyond arbitrary time until the exact session changes', async () => {
  const h = createHarness();
  let settled = false;
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model claude-opus-5[1m]',
    afterMs: 100,
  }).then((result) => {
    settled = true;
    return result;
  });
  await nextTurn();
  await nextTurn();

  assert.equal(settled, false);
  assert.equal(h.owner.handleTranscriptChanged({
    toolType: 'claude',
    sessionId: 'session-b',
    version: 8,
  }), 0);
  await nextTurn();
  assert.equal(settled, false);

  h.setProof({ success: true, outcome: 'found', reason: 'jsonl-stdout' });
  assert.equal(h.owner.handleTranscriptChanged({
    toolType: 'claude',
    sessionId: 'session-a',
    version: 9,
  }), 1);
  const result = await waiting;

  assert.equal(result.outcome, 'found');
  assert.equal(h.subscriptions.length, 1);
  await nextTurn();
  assert.equal(h.unsubscriptions.length, 1);
});

test('a transcript edge during watcher admission cannot be lost', async () => {
  let finishSubscribe;
  let proof = { success: false, outcome: 'unresolved' };
  const h = createHarness({
    subscribe: () => new Promise((resolve) => { finishSubscribe = resolve; }),
    readProof: async () => proof,
  });
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model opus',
    afterMs: 100,
  });
  await nextTurn();
  proof = { success: true, outcome: 'found', reason: 'jsonl-stdout' };
  assert.equal(h.owner.handleTranscriptChanged({
    toolType: 'claude',
    sessionId: 'session-a',
    version: 2,
  }), 1);
  finishSubscribe({ success: true });

  const result = await waiting;
  assert.equal(result.outcome, 'found');
});

test('a proof can park before session identity exists and bind later by exact hint', async () => {
  const h = createHarness({ resolveBinding: async () => null });
  h.setProof({ success: true, outcome: 'found', reason: 'jsonl-stdout' });
  let settled = false;
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/effort max',
    afterMs: 100,
  }).then((result) => {
    settled = true;
    return result;
  });
  await nextTurn();
  assert.equal(settled, false);

  assert.equal(h.owner.handleBindingChanged('tab-a', {
    sessionId: 'session-new',
    cwd: '/tmp/project',
  }), 1);
  const result = await waiting;
  assert.equal(result.outcome, 'found');
  assert.equal(h.subscriptions[0].sessionId, 'session-new');
});

test('an exact session event just before wait is retained only for that generation', async () => {
  const h = createHarness({ resolveBinding: async () => null });
  h.setProof({ success: true, outcome: 'found', reason: 'jsonl-stdout' });
  assert.equal(h.owner.handleBindingChanged('tab-a', {
    sessionId: 'session-early',
    generation: 'launch-1',
    cwd: '/tmp/project',
  }), 0);

  const result = await h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model opus',
    afterMs: 100,
  });
  assert.equal(result.outcome, 'found');
  assert.equal(h.subscriptions[0].sessionId, 'session-early');
});

test('an exact session hint arriving during an unresolved binding lookup is replayed', async () => {
  let finishResolve;
  let resolveCalls = 0;
  const h = createHarness({
    resolveBinding: () => {
      resolveCalls += 1;
      if (resolveCalls > 1) return null;
      return new Promise((resolve) => { finishResolve = resolve; });
    },
  });
  h.setProof({ success: true, outcome: 'found', reason: 'jsonl-stdout' });
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model opus',
    afterMs: 100,
  });
  await nextTurn();
  assert.equal(h.owner.handleBindingChanged('tab-a', {
    sessionId: 'session-race',
    cwd: '/tmp/project',
  }), 1);
  finishResolve(null);

  const result = await waiting;
  assert.equal(result.outcome, 'found');
  assert.equal(h.subscriptions[0].sessionId, 'session-race');
});

test('a paired explicit command result settles without a retry timer', async () => {
  const h = createHarness();
  h.setProof({
    success: false,
    outcome: 'unresolved',
    terminal: true,
    reason: 'command-output-rejected',
  });
  const result = await h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model missing',
    afterMs: 100,
  });

  assert.equal(result.terminal, true);
  assert.equal(result.reason, 'command-output-rejected');
});

test('new launch generation cancels only its superseded wait', async () => {
  const h = createHarness();
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model opus',
    afterMs: 100,
  });
  await nextTurn();
  h.setGeneration('launch-2');
  assert.equal(h.owner.cancel('tab-a', 'launch-1', 'generation-superseded'), 1);

  const result = await waiting;
  assert.equal(result.outcome, 'unresolved');
  assert.equal(result.reason, 'generation-superseded');
  assert.deepEqual(h.owner.snapshot(), []);
});

test('a real successful proof can be held and released without fabricating its result', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const observed = [];
  const h = createHarness({
    holdSuccessfulProofForTest: async (entry) => {
      observed.push(entry);
      await held;
    },
  });
  const exactProof = {
    success: true,
    outcome: 'found',
    reason: 'jsonl-stdout',
    resultUuid: 'result-a',
  };
  h.setProof(exactProof);
  let settled = false;
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/model opus',
  }).then((result) => {
    settled = true;
    return result;
  });
  await nextTurn();
  await nextTurn();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].id.startsWith('claude-startup:launch-1:'), true);
  assert.equal(settled, false);
  release();
  assert.deepEqual(await waiting, exactProof);
});

test('generation cancellation wins while a successful proof is held', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const h = createHarness({
    holdSuccessfulProofForTest: () => held,
  });
  h.setProof({ success: true, outcome: 'found', reason: 'jsonl-stdout' });
  const waiting = h.owner.wait({
    tabId: 'tab-a',
    generation: 'launch-1',
    command: '/effort max',
  });
  await nextTurn();
  await nextTurn();
  h.setGeneration('launch-2');
  assert.equal(h.owner.cancel('tab-a', 'launch-1', 'generation-superseded'), 1);
  const result = await waiting;
  assert.equal(result.outcome, 'unresolved');
  assert.equal(result.reason, 'generation-superseded');
  release();
  await nextTurn();
  assert.deepEqual(h.owner.snapshot(), []);
});
