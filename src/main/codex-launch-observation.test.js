'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeCodexLaunchObservation,
  planCodexLaunchObservation,
} = require('./codex-launch-observation');

test('resume observes the source and a linked child in that order', async () => {
  const calls = [];
  const result = await executeCodexLaunchObservation({
    command: 'codex-c',
    sessionId: 'source-session',
  }, {
    attachSource: async (sessionId) => {
      calls.push(['attach-source', sessionId]);
      return true;
    },
    startDiscovery: (options) => calls.push(['discover', options.sourceSessionId, options.sourceMode]),
  });

  assert.deepEqual(calls, [
    ['attach-source', 'source-session'],
    ['discover', 'source-session', 'resume'],
  ]);
  assert.equal(result.sourceAttached, true);
});

test('fork discovers a linked child without treating the source as live', async () => {
  const calls = [];
  await executeCodexLaunchObservation({
    command: 'codex-f',
    sessionId: 'source-session',
  }, {
    attachSource: async () => calls.push(['attach-source']),
    startDiscovery: (options) => calls.push(['discover', options.sourceSessionId, options.sourceMode]),
  });

  assert.deepEqual(calls, [['discover', 'source-session', 'fork']]);
});

test('new launch uses fresh discovery only', () => {
  assert.deepEqual(planCodexLaunchObservation('codex', null), {
    mode: 'new',
    sourceSessionId: null,
    attachSource: false,
    discoverLinked: false,
    discoverFresh: true,
  });
});
