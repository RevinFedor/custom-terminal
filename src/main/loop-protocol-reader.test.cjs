'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAgentResponseObservationReader } = require('./agent-response-observation-reader');
function fixture() {
  const context = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 1, processId: null };
  const raw = { revision: 'same-provider-revision', known: true, exists: true, tabId: 'P', toolType: 'codex',
    sessionId: 'S', cwd: '/private', busy: true, transitioning: false, backgroundWorkCount: 0,
    turn: { ...context, active: true, completionEligible: true, intentId: null }, executionContext: context };
  const hooks = { lifecycle: null };
  const reader = createAgentResponseObservationReader({ captureState: () => ({ ...raw, turn: { ...raw.turn } }),
    readLifecycle: async () => { hooks.lifecycle?.(); return { processStatus: 'found', processName: 'codex' }; } });
  return { raw, hooks, reader };
}
test('existing coherent reader publishes exact Loop protocol metadata without changing authority', async () => {
  const h = fixture(), value = await h.reader.getAgentResponseState('P');
  assert.equal(value.known, true); assert.equal(value.currentSubject.targetExecutionContext.turnId, 'T');
  assert.deepEqual(value.loopTaskProtocol, { eligible: true, intentId: null });
  assert.equal(h.raw.turn.active, true);
});
for (const key of ['completionEligible', 'intentId']) test(key + ' changing across lifecycle read cannot publish stale eligibility', async () => {
  const h = fixture(); h.hooks.lifecycle = () => { h.raw.turn[key] = key === 'intentId' ? 'complete-intent' : false; };
  const value = await h.reader.getAgentResponseState('P');
  assert.equal(value.known, false); assert.equal(value.error, 'response_state_changed');
  assert.equal(value.loopTaskProtocol, undefined);
});
