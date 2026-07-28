'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOrchestrationProofCoordinator,
  proofSessionKey,
} = require('./orchestration-proof-coordinator');

const quietLog = { log() {}, warn() {} };

test('proof session identity includes provider and exact session id', () => {
  assert.equal(proofSessionKey('claude', 'session-a'), 'claude:session-a');
  assert.equal(proofSessionKey('codex', 'session-a'), 'codex:session-a');
  assert.equal(proofSessionKey('claude', ''), null);
});

test('transcript change wakes only runs bound to that exact session', async () => {
  const wakes = [];
  const coordinator = createOrchestrationProofCoordinator({
    label: 'result',
    subscribe: async () => ({ success: true }),
    unsubscribe: async () => ({ success: true }),
    onWake: async (runId, meta) => wakes.push([runId, meta.version]),
    log: quietLog,
  });
  await coordinator.arm({ runId: 'run-a', toolType: 'claude', sessionId: 'session-a' });
  await coordinator.arm({ runId: 'run-b', toolType: 'claude', sessionId: 'session-b' });

  assert.equal(coordinator.handleTranscriptChanged({
    toolType: 'claude',
    sessionId: 'session-a',
    version: 7,
  }), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wakes, [['run-a', 7]]);
});

test('event fired while subscribe is resolving is not lost', async () => {
  let finishSubscribe;
  const wakes = [];
  const coordinator = createOrchestrationProofCoordinator({
    label: 'result',
    subscribe: () => new Promise((resolve) => { finishSubscribe = resolve; }),
    unsubscribe: async () => ({ success: true }),
    onWake: async (runId) => wakes.push(runId),
    log: quietLog,
  });
  const arming = coordinator.arm({
    runId: 'run-race',
    toolType: 'claude',
    sessionId: 'session-race',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.handleTranscriptChanged({
    toolType: 'claude',
    sessionId: 'session-race',
    version: 2,
  }), 1);
  finishSubscribe({ success: true });
  await arming;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wakes, ['run-race']);
});

test('release removes the exact watcher and unsubscribes its consumer', async () => {
  const unsubscribed = [];
  const coordinator = createOrchestrationProofCoordinator({
    label: 'source',
    subscribe: async () => ({ success: true }),
    unsubscribe: async ({ consumerId }) => { unsubscribed.push(consumerId); },
    onWake: async () => {},
    log: quietLog,
  });
  await coordinator.arm({ runId: 'run-a', toolType: 'codex', sessionId: 'session-a' });
  assert.equal(await coordinator.release('run-a', 'proved'), true);
  assert.deepEqual(unsubscribed, ['orchestration-source:run-a']);
  assert.equal(coordinator.handleTranscriptChanged({
    toolType: 'codex',
    sessionId: 'session-a',
  }), 0);
});

test('bursty transcript edges run one probe plus one trailing probe per run', async () => {
  const wakes = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = createOrchestrationProofCoordinator({
    label: 'result',
    subscribe: async () => ({ success: true }),
    unsubscribe: async () => ({ success: true }),
    onWake: async (_runId, meta) => {
      wakes.push(meta.version);
      if (wakes.length === 1) await firstGate;
    },
    log: { log() {}, warn() {} },
  });
  await coordinator.arm({ runId: 'run-a', toolType: 'claude', sessionId: 'session-a' });

  coordinator.handleTranscriptChanged({ toolType: 'claude', sessionId: 'session-a', version: 1 });
  coordinator.handleTranscriptChanged({ toolType: 'claude', sessionId: 'session-a', version: 2 });
  coordinator.handleTranscriptChanged({ toolType: 'claude', sessionId: 'session-a', version: 3 });
  await Promise.resolve();
  assert.deepEqual(wakes, [1]);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wakes, [1, 3]);
});
