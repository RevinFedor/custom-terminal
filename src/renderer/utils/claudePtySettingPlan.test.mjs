import test from 'node:test';
import assert from 'node:assert/strict';
import { planClaudePtySettings } from './claudePtySettingPlan.mjs';

test('skips model and effort only when the active session has exact JSONL proof', () => {
  const plan = planClaudePtySettings({
    requestedModel: 'claude-opus-5[1m]',
    requestedEffort: 'max',
    currentSessionId: 'session-1',
    confirmed: {
      success: true,
      sessionId: 'session-1',
      latestSessionId: 'session-1',
      model: 'claude-opus-5[1m]',
      effort: 'max',
      modelProofAt: 10,
      effortProofAt: 11,
    },
  });
  assert.equal(plan.applyModel, false);
  assert.equal(plan.applyEffort, false);
});

test('a stale session or missing proof never suppresses the setting command', () => {
  const stale = planClaudePtySettings({
    requestedModel: 'claude-opus-5[1m]',
    requestedEffort: 'max',
    currentSessionId: 'session-2',
    confirmed: {
      success: true,
      sessionId: 'session-1',
      latestSessionId: 'session-1',
      model: 'claude-opus-5[1m]',
      effort: 'max',
      modelProofAt: 10,
      effortProofAt: 11,
    },
  });
  assert.equal(stale.applyModel, true);
  assert.equal(stale.applyEffort, true);

  const unproven = planClaudePtySettings({
    requestedModel: 'claude-opus-5[1m]',
    currentSessionId: 'session-1',
    confirmed: {
      success: true,
      sessionId: 'session-1',
      latestSessionId: 'session-1',
      model: 'claude-opus-5[1m]',
      modelProofAt: 0,
    },
  });
  assert.equal(unproven.applyModel, true);
});
