import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexSessionAdoptionOptionsFromEvent,
  planCarriedCodexSettingsProofApplication,
  projectCodexSettingsProofOwner,
} from './codexSessionAdoption.mjs';
import { resolveCodexEffectiveSettings } from './codexEffectiveSettings.mjs';

test('proven native Rewind event carries live settings proof from writer A to child B', () => {
  const event = {
    tabId: 'tab-1',
    sessionId: 'session-b',
    previousSessionId: 'session-a',
    reason: 'writer-proof-linked',
    writerProven: true,
    carryCodexSettingsProof: true,
  };
  const options = codexSessionAdoptionOptionsFromEvent(event);

  assert.deepEqual(options, {
    carryCodexSettingsProof: true,
    codexSettingsProof: null,
    codexSettingsProofInvalid: false,
  });
  assert.equal(projectCodexSettingsProofOwner({
    currentProofAt: 123,
    currentProofSessionId: 'session-a',
    nextSessionId: event.sessionId,
    ...options,
  }), 'session-b');
});

test('reason text alone cannot carry settings proof for a generic A to B change', () => {
  const event = {
    sessionId: 'session-b',
    previousSessionId: 'session-a',
    reason: 'writer-handoff-looking-but-not-semantic-proof',
    writerProven: true,
  };
  const options = codexSessionAdoptionOptionsFromEvent(event);

  assert.deepEqual(options, {
    carryCodexSettingsProof: false,
    codexSettingsProof: null,
    codexSettingsProofInvalid: false,
  });
  assert.equal(projectCodexSettingsProofOwner({
    currentProofAt: 123,
    currentProofSessionId: 'session-a',
    nextSessionId: event.sessionId,
    ...options,
  }), 'session-a');
});

test('a generic detected session change remains fail-closed until the child proves settings', () => {
  const options = codexSessionAdoptionOptionsFromEvent({
    sessionId: 'session-b',
    reason: 'detected',
    writerProven: true,
    carryCodexSettingsProof: false,
  });

  assert.equal(projectCodexSettingsProofOwner({
    currentProofAt: 123,
    currentProofSessionId: 'session-a',
    nextSessionId: 'session-b',
    ...options,
  }), 'session-a');
});

test('a Resume child does not display its source conversation-only effort until an explicit carry proof exists', () => {
  const sourceProof = projectCodexSettingsProofOwner({
    currentProofAt: 123,
    currentProofSessionId: 'session-a',
    nextSessionId: 'session-b',
    carryCodexSettingsProof: false,
  });

  assert.equal(sourceProof, 'session-a');
  assert.deepEqual(resolveCodexEffectiveSettings({
    codexSessionId: 'session-b',
    codexModel: 'gpt-5.6-sol',
    codexEffort: 'max',
    codexLiveModel: 'gpt-5.6-luna',
    codexLiveEffort: 'ultra',
    codexLiveSettingsSessionId: sourceProof,
  }), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    liveOwned: false,
    source: 'persistent-fallback',
  });

  const carriedProof = projectCodexSettingsProofOwner({
    currentProofAt: 123,
    currentProofSessionId: 'session-a',
    nextSessionId: 'session-b',
    carryCodexSettingsProof: true,
  });
  assert.equal(carriedProof, 'session-b');
});

test('Resume child applies the exact non-Ultra source pair instead of stale tab settings', () => {
  const options = codexSessionAdoptionOptionsFromEvent({
    carryCodexSettingsProof: true,
    requiresExactCodexSettingsProof: true,
    codexSettingsProof: {
      model: 'gpt-5.6-luna',
      effort: 'medium',
      proofAt: 456,
    },
  });
  assert.deepEqual(options, {
    carryCodexSettingsProof: true,
    codexSettingsProof: { model: 'gpt-5.6-luna', effort: 'medium', proofAt: 456 },
    codexSettingsProofInvalid: false,
  });
  assert.deepEqual(planCarriedCodexSettingsProofApplication({
    proof: options.codexSettingsProof,
    nextSessionId: 'child-b',
    currentPersistentEffort: 'max',
  }), {
    allowed: true,
    conversationOnly: false,
    persistentPatch: {
      codexModel: 'gpt-5.6-luna',
      codexEffort: 'medium',
      codexSettingsProofAt: 456,
      codexSettingsProofSessionId: 'child-b',
    },
    livePatch: {
      codexLiveModel: undefined,
      codexLiveEffort: undefined,
      codexLiveSettingsSessionId: undefined,
    },
  });
});

test('Resume child keeps Ultra only in the new writer live overlay', () => {
  const plan = planCarriedCodexSettingsProofApplication({
    proof: { model: 'gpt-5.6-sol', effort: 'ultra', proofAt: 789 },
    nextSessionId: 'child-b',
    currentPersistentEffort: 'ultra',
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.conversationOnly, true);
  assert.deepEqual(plan.persistentPatch, {
    codexEffort: undefined,
    codexSettingsProofAt: 789,
    codexSettingsProofSessionId: 'child-b',
  });
  assert.deepEqual(plan.livePatch, {
    codexLiveModel: 'gpt-5.6-sol',
    codexLiveEffort: 'ultra',
    codexLiveSettingsSessionId: 'child-b',
  });
});

test('missing or invalid carried source settings fail closed', () => {
  const options = codexSessionAdoptionOptionsFromEvent({
    carryCodexSettingsProof: true,
    requiresExactCodexSettingsProof: true,
    codexSettingsProof: { model: 'gpt-5.6-sol', proofAt: 123 },
  });
  assert.deepEqual(options, {
    carryCodexSettingsProof: false,
    codexSettingsProof: null,
    codexSettingsProofInvalid: true,
  });
  assert.deepEqual(planCarriedCodexSettingsProofApplication({
    proof: null,
    nextSessionId: 'child-b',
  }), {
    allowed: false,
    reason: 'carried-codex-settings-proof-invalid',
  });
});
