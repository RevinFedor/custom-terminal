'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  runOrchestrationCompletionFlow,
} = require('./orchestration-completion-flow');

test('pending proof subscribes before the second read and then records the completed result', async () => {
  const calls = [];
  const probes = [
    { found: false, complete: false },
    { found: true, complete: true },
  ];
  const result = await runOrchestrationCompletionFlow({
    run: { runId: 'run-1', status: 'completed', resultComplete: false },
    probeResult: async () => {
      calls.push('probe');
      return probes.shift();
    },
    classifyProbe: (probe) => ({ kind: probe.complete ? 'complete' : 'pending' }),
    armProof: async () => {
      calls.push('arm');
      return { success: true };
    },
    markTerminalFailure: async () => assert.fail('must not fail'),
    recordResult: async () => {
      calls.push('record');
      return { runId: 'run-1', status: 'completed', resultComplete: true };
    },
  });

  assert.deepEqual(calls, ['probe', 'arm', 'probe', 'record']);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.flowTrace.map((item) => item.phase), [
    'created',
    'probing-result',
    'arming-proof',
    'recording-result',
    'returned',
  ]);
});

test('definitive result failure does not arm a watcher or record a pending proof', async () => {
  const calls = [];
  const result = await runOrchestrationCompletionFlow({
    run: { runId: 'run-2', status: 'completed', resultComplete: false },
    probeResult: async () => ({ found: false, proofDefinitive: true }),
    classifyProbe: () => ({
      kind: 'terminal-failure',
      code: 'prompt_outside_turn',
      message: 'prompt identity is outside the turn',
    }),
    armProof: async () => {
      calls.push('arm');
      return { success: true };
    },
    markTerminalFailure: async () => {
      calls.push('fail');
      return { runId: 'run-2', status: 'failed', resultComplete: false };
    },
    recordResult: async () => {
      calls.push('record');
      return null;
    },
  });

  assert.deepEqual(calls, ['fail']);
  assert.equal(result.outcome, 'terminal-failure');
  assert.equal(result.run.status, 'failed');
});

test('non-success terminal runs skip provider result probing', async () => {
  let probed = false;
  const run = { runId: 'run-3', status: 'failed' };
  const result = await runOrchestrationCompletionFlow({
    run,
    probeResult: async () => {
      probed = true;
      return null;
    },
  });
  assert.equal(probed, false);
  assert.equal(result.outcome, 'ready');
  assert.equal(result.run, run);
});
