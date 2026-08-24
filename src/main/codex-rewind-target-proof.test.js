'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCodexRewindMessageProof,
  classifyCodexRewindEntryIdentity,
  classifyCodexRewindUserTurnBoundaries,
  classifyCodexNativeRewindNoMutationRecovery,
  classifyCodexStableSourceRollbackOutcome,
  classifyCodexStableSourceTranscriptRecovery,
  hashCodexRewindTargetText,
} = require('./codex-rewind-target-proof');

test('native Rewind target proof uses one durable SHA-256 contract', () => {
  const boundaryHash = hashCodexRewindTargetText('  target prompt  ');
  const projected = buildCodexRewindMessageProof({
    text: 'target prompt',
    images: ['/tmp/image.png'],
    textElements: [{ type: 'text', text: 'target prompt' }],
  });

  assert.match(boundaryHash, /^[a-f0-9]{64}$/);
  assert.equal(projected.textHash, boundaryHash);
  assert.match(projected.signature, /^[a-f0-9]{64}$/);
});

test('message signature distinguishes non-text prompt identity', () => {
  const first = buildCodexRewindMessageProof({
    text: 'same text',
    images: ['/tmp/first.png'],
  });
  const second = buildCodexRewindMessageProof({
    text: 'same text',
    images: ['/tmp/second.png'],
  });

  assert.equal(first.textHash, second.textHash);
  assert.notEqual(first.signature, second.signature);
});

test('Rewind keeps physical and composite transcript identities on separate exact paths', () => {
  assert.deepEqual(classifyCodexRewindEntryIdentity({
    viewOwnerSessionId: 'writer-a',
    writerSessionId: 'writer-a',
  }), {
    valid: true,
    mode: 'physical',
    reason: 'physical-writer-target',
  });
  assert.equal(classifyCodexRewindEntryIdentity({
    viewOwnerSessionId: 'stale-writer',
    writerSessionId: 'writer-a',
  }).reason, 'physical-view-owner-mismatch');

  const composite = {
    viewOwnerSessionId: 'writer-a',
    writerSessionId: 'writer-a',
    expectedContentRevision: 'revision-a',
    targetEntryRef: {
      viewOwnerSessionId: 'writer-a',
      physicalSessionId: 'source-a',
      rawUuid: 'codex-user-source-a-7',
    },
  };
  assert.deepEqual(classifyCodexRewindEntryIdentity(composite), {
    valid: true,
    mode: 'composite',
    reason: 'composite-entry-identity',
  });
  assert.equal(classifyCodexRewindEntryIdentity({
    ...composite,
    expectedContentRevision: null,
  }).reason, 'composite-entry-identity-incomplete');
  assert.equal(classifyCodexRewindEntryIdentity({
    ...composite,
    targetEntryRef: { ...composite.targetEntryRef, viewOwnerSessionId: 'other-view' },
  }).reason, 'composite-entry-owner-mismatch');
});

test('native Rewind distinguishes a provider turn from queued mid-turn input', () => {
  const boundaries = classifyCodexRewindUserTurnBoundaries([
    { __line: 10, type: 'event_msg', payload: { type: 'task_started' } },
    { __line: 11, type: 'event_msg', payload: { type: 'user_message' } },
    { __line: 12, type: 'event_msg', payload: { type: 'user_message' } },
    { __line: 13, type: 'event_msg', payload: { type: 'task_complete' } },
    { __line: 14, type: 'event_msg', payload: { type: 'task_started' } },
    { __line: 15, type: 'event_msg', payload: { type: 'user_message' } },
  ]);

  assert.deepEqual(boundaries.get(11), {
    branchable: true,
    reason: 'provider-turn-boundary',
    taskStartedSourceLine: 10,
  });
  assert.deepEqual(boundaries.get(12), {
    branchable: false,
    reason: 'mid-turn-user-message',
    taskStartedSourceLine: null,
  });
  assert.equal(boundaries.get(15).branchable, true);

  const legacy = classifyCodexRewindUserTurnBoundaries([
    { __line: 1, type: 'event_msg', payload: { type: 'user_message' } },
  ]);
  assert.equal(legacy.get(1).branchable, true, 'legacy rollouts without task events keep capability');
});

test('manual Rewind recovery proves the stable source from its own next task', () => {
  const sourceSessionId = 'source-session';
  const targetTextHash = hashCodexRewindTargetText('rewound prompt');
  const journal = {
    version: 2,
    phase: 'confirm-enter-boundary',
    sourceSessionId,
    expectedBindingSessionId: sourceSessionId,
    actionGeneration: 'rewind-generation-1',
    actionStartedAtMs: 2000,
    targetUuid: 'codex-user-source-session-40',
    targetSourceLine: 40,
    targetTextHash,
  };
  const base = {
    journal,
    currentSessionId: sourceSessionId,
    discoveryComplete: true,
    descendants: [],
    sourceMessages: [
      {
        uuid: journal.targetUuid,
        sourceLine: 40,
        textHash: targetTextHash,
        timestampMs: 1000,
      },
      {
        uuid: 'codex-user-source-session-44',
        sourceLine: 44,
        textHash: hashCodexRewindTargetText('edited text after rewind'),
        timestampMs: 2100,
      },
    ],
    sourceLifecycleEvents: [
      { type: 'task_started', sourceLine: 42, timestampMs: 2050 },
    ],
  };

  assert.deepEqual(classifyCodexStableSourceTranscriptRecovery(base), {
    proven: true,
    reason: 'stable-source-task-and-user-message',
    sourceSessionId,
    actionGeneration: 'rewind-generation-1',
    targetSourceLine: 40,
    taskStartedSourceLine: 42,
    userMessageSourceLine: 44,
    userMessageTimestampMs: 2100,
  });
  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    descendants: [{ sessionId: 'child-session' }],
  }).reason, 'descendant-present');
  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    currentSessionId: 'other-session',
  }).reason, 'source-binding-not-stable');
  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    sourceLifecycleEvents: [],
  }).reason, 'post-action-source-task-start-missing');
  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    sourceMessages: base.sourceMessages.map((message, index) => (
      index === 0 ? { ...message, textHash: hashCodexRewindTargetText('wrong') } : message
    )),
  }).reason, 'source-target-proof-mismatch');
});

test('stable-source manual Rewind requires the exact durable thread_rolled_back outcome', () => {
  const sourceSessionId = 'source-session';
  const targetTextHash = hashCodexRewindTargetText('rewound prompt');
  const journal = {
    version: 2,
    phase: 'confirm-enter-boundary',
    sourceSessionId,
    expectedBindingSessionId: sourceSessionId,
    actionGeneration: 'rewind-generation-rollback',
    actionStartedAtMs: 2000,
    targetUuid: 'codex-user-source-session-40',
    targetSourceLine: 40,
    targetTextHash,
    rollbackTurns: 2,
  };
  const base = {
    journal,
    currentSessionId: sourceSessionId,
    sourceMessages: [{
      uuid: journal.targetUuid,
      sourceLine: 40,
      textHash: targetTextHash,
      timestampMs: 1000,
    }],
    sourceLifecycleEvents: [{
      type: 'thread_rolled_back',
      sourceLine: 44,
      timestampMs: 2050,
      numTurns: 2,
    }],
  };
  assert.deepEqual(classifyCodexStableSourceRollbackOutcome(base), {
    proven: true,
    reason: 'exact-thread-rolled-back',
    sourceSessionId,
    actionGeneration: 'rewind-generation-rollback',
    targetSourceLine: 40,
    rollbackSourceLine: 44,
    rollbackTurns: 2,
    rollbackTimestampMs: 2050,
  });
  assert.equal(classifyCodexStableSourceRollbackOutcome({
    ...base,
    sourceLifecycleEvents: [],
  }).reason, 'post-action-thread-rollback-missing');
  assert.equal(classifyCodexStableSourceRollbackOutcome({
    ...base,
    sourceLifecycleEvents: [{ ...base.sourceLifecycleEvents[0], numTurns: 1 }],
  }).reason, 'thread-rollback-depth-mismatch');
});

test('stopped Rewind recovery clears only an exact source with no durable mutation', () => {
  const sourceSessionId = 'source-session';
  const targetTextHash = hashCodexRewindTargetText('queued target');
  const journal = {
    version: 2,
    phase: 'confirm-enter-boundary',
    sourceSessionId,
    expectedBindingSessionId: sourceSessionId,
    actionGeneration: 'rewind-no-mutation',
    actionStartedAtMs: 2000,
    targetUuid: 'codex-user-source-session-40',
    targetSourceLine: 40,
    targetTextHash,
  };
  const base = {
    journal,
    currentSessionId: sourceSessionId,
    discoveryComplete: true,
    descendants: [],
    sourceMessages: [{
      uuid: journal.targetUuid,
      sourceLine: 40,
      textHash: targetTextHash,
      timestampMs: 1000,
    }],
    sourceLifecycleEvents: [],
  };

  assert.deepEqual(classifyCodexNativeRewindNoMutationRecovery(base), {
    proven: true,
    reason: 'no-persisted-rewind-mutation',
    sourceSessionId,
    actionGeneration: 'rewind-no-mutation',
    targetSourceLine: 40,
  });
  assert.equal(classifyCodexNativeRewindNoMutationRecovery({
    ...base,
    journal: { ...journal, phase: 'branch-draft-restored' },
  }).proven, true, 'a branch draft lost with its PTY may clear as exact no-mutation');
  assert.equal(classifyCodexNativeRewindNoMutationRecovery({
    ...base,
    sourceLifecycleEvents: [{
      type: 'thread_rolled_back', sourceLine: 41, timestampMs: 2001,
    }],
  }).reason, 'post-action-source-thread_rolled_back-present');
  assert.equal(classifyCodexNativeRewindNoMutationRecovery({
    ...base,
    sourceMessages: [...base.sourceMessages, {
      uuid: 'new-user', sourceLine: 42, textHash: 'a'.repeat(64), timestampMs: 2002,
    }],
  }).reason, 'post-action-source-user-message-present');
  assert.equal(classifyCodexNativeRewindNoMutationRecovery({
    ...base,
    descendants: [{ sessionId: 'child' }],
  }).reason, 'descendant-present');
});
