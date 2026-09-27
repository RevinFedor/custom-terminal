'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCodexRewindMessageProof,
  classifyCodexHistoryRewriteRecoveryCandidate,
  classifyCodexRewindEntryIdentity,
  classifyCodexRewindUserTurnBoundaries,
  classifyCodexNativeRewindNoMutationRecovery,
  classifyCodexStableSourceRollbackOutcome,
  classifyCodexStableSourceTranscriptRecovery,
  hashCodexRewindTargetText,
} = require('./codex-rewind-target-proof');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

test('native Rewind recovery admits only an exact app-owned history rewrite child', () => {
  const journal = {
    version: 2,
    sourceSessionId: 'source-session',
    actionGeneration: 'rewind-generation',
    actionStartedAtMs: 2_000,
  };
  const historyEvent = {
    eventType: 'fork',
    provider: 'codex',
    sessionId: 'rewrite-child',
    sourceSessionId: 'source-session',
    childSessionId: 'rewrite-child',
    forkMode: 'history_delete',
    origin: 'app',
    isDirect: true,
    snapshotComplete: true,
    occurredAt: 3,
  };

  assert.deepEqual(classifyCodexHistoryRewriteRecoveryCandidate({
    journal,
    currentSessionId: 'rewrite-child',
    historyEvent,
  }), {
    eligible: true,
    reason: 'exact-app-history-rewrite-lineage',
    sessionId: 'rewrite-child',
    sourceSessionId: 'source-session',
    forkMode: 'history_delete',
    occurredAtMs: 3_000,
  });
  assert.equal(classifyCodexHistoryRewriteRecoveryCandidate({
    journal,
    currentSessionId: 'rewrite-child',
    historyEvent: { ...historyEvent, sourceSessionId: 'other-source' },
  }).reason, 'history-rewrite-event-scope-mismatch');
  assert.equal(classifyCodexHistoryRewriteRecoveryCandidate({
    journal,
    currentSessionId: 'rewrite-child',
    historyEvent: { ...historyEvent, forkMode: 'full' },
  }).reason, 'history-rewrite-event-scope-mismatch');
  assert.equal(classifyCodexHistoryRewriteRecoveryCandidate({
    journal,
    currentSessionId: 'rewrite-child',
    historyEvent: { ...historyEvent, occurredAt: 1 },
  }).reason, 'history-rewrite-event-scope-mismatch');
});

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

test('manual Rewind recovery admits a written stable-source submit only by its exact durable identity', () => {
  const sourceSessionId = 'source-session';
  const actionGeneration = 'rewind-generation-written';
  const submittedText = '/compact';
  const expectedHash = promptAuditFingerprint(submittedText);
  const journal = {
    version: 2,
    phase: 'stable-source-submit-written',
    sourceSessionId,
    expectedBindingSessionId: sourceSessionId,
    actionGeneration,
    actionStartedAtMs: 2_000,
    targetUuid: 'codex-user-source-session-40',
    targetSourceLine: 40,
    targetTextHash: hashCodexRewindTargetText('rewound prompt'),
    submitProof: {
      version: 1,
      submitId: 'stable-submit-1',
      sourceSessionId,
      actionGeneration,
      expectedLen: submittedText.length,
      expectedHash,
      sentAtMs: 2_200,
      submitWrittenAtMs: 2_210,
      sourceFilePath: '/tmp/source.jsonl',
      sourceFileSize: 5_000,
      runSeq: 7,
      originPhase: 'stable-source-settled',
    },
  };
  const exactMessage = {
    uuid: 'codex-user-source-session-49',
    sourceLine: 49,
    textHash: hashCodexRewindTargetText(submittedText),
    timestampMs: 2_240,
    byteOffset: 5_400,
    textLength: submittedText.length,
    auditHash: expectedHash,
  };
  const base = {
    journal,
    currentSessionId: sourceSessionId,
    discoveryComplete: true,
    descendants: [],
    sourceMessages: [
      {
        uuid: journal.targetUuid,
        sourceLine: journal.targetSourceLine,
        textHash: journal.targetTextHash,
        timestampMs: 1_000,
        byteOffset: 4_000,
      },
      {
        uuid: 'codex-user-source-session-45',
        sourceLine: 45,
        textHash: hashCodexRewindTargetText('other post-action prompt'),
        timestampMs: 2_225,
        byteOffset: 5_200,
        textLength: 24,
        auditHash: promptAuditFingerprint('other post-action prompt'),
      },
      exactMessage,
    ],
    sourceLifecycleEvents: [
      { type: 'task_started', sourceLine: 44, timestampMs: 2_220, byteOffset: 5_100 },
      { type: 'task_started', sourceLine: 48, timestampMs: 2_235, byteOffset: 5_300 },
    ],
  };

  const proven = classifyCodexStableSourceTranscriptRecovery(base);
  assert.equal(proven.proven, true);
  assert.equal(proven.reason, 'stable-source-exact-submit-task-and-user-message');
  assert.equal(proven.taskStartedSourceLine, 48);
  assert.equal(proven.userMessageSourceLine, 49);
  assert.equal(proven.userMessageAuditHash, expectedHash);
  assert.equal(proven.submitProof.submitId, 'stable-submit-1');

  // Before 24 August, this same v2 journal/v1 submit shape had no
  // originPhase: stable-source-settled was the only supported producer.
  const legacy = {
    ...journal, appliedAtMs: 2_005, stableSourceSettledAtMs: 2_010,
    restoredTextHash: journal.targetTextHash,
    submitProof: { ...journal.submitProof },
  };
  delete legacy.submitProof.originPhase;
  const legacyProof = classifyCodexStableSourceTranscriptRecovery({ ...base, journal: legacy });
  assert.equal(legacyProof.proven, true, 'old exact submit must not become permanently pending after schema extension');
  assert.equal(Object.hasOwn(legacyProof.submitProof, 'originPhase'), false,
    'read compatibility must preserve the original receipt for exact DB compare-and-delete');
  for (const patch of [
    { stableSourceSettledAtMs: null },
    { stableSourceSettledAtMs: 2_300 },
    { appliedAtMs: 1_999 },
    { appliedAtMs: 2_011 },
    { restoredTextHash: 'other' },
    { branchDraftRestoredAtMs: 2_006 },
  ]) {
    assert.equal(classifyCodexStableSourceTranscriptRecovery({
      ...base, journal: { ...legacy, ...patch },
    }).proven, false, JSON.stringify(patch));
  }
  for (const originPhase of [null, '', 'unrecognized']) {
    assert.equal(classifyCodexStableSourceTranscriptRecovery({
      ...base, journal: { ...legacy, submitProof: { ...legacy.submitProof, originPhase } },
    }).proven, false, 'an explicit invalid origin is not legacy absence');
  }
  for (const changed of [
    { discoveryComplete: false }, { descendants: [{ sessionId: 'child' }] },
    { currentSessionId: 'foreign' }, { sourceLifecycleEvents: [] },
    { sourceMessages: base.sourceMessages.slice(0, -1) },
  ]) {
    assert.equal(classifyCodexStableSourceTranscriptRecovery({
      ...base, journal: legacy, ...changed,
    }).proven, false, 'legacy decoding never replaces target/submit/writer proof');
  }

  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    sourceMessages: base.sourceMessages.map((message) => (
      message.sourceLine === exactMessage.sourceLine
        ? { ...message, auditHash: promptAuditFingerprint('mismatch') }
        : message
    )),
  }).reason, 'durable-submit-user-message-missing');
  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    journal: {
      ...journal,
      submitProof: { ...journal.submitProof, submitId: '' },
    },
  }).reason, 'journal-submit-proof-incomplete');
  assert.equal(classifyCodexStableSourceTranscriptRecovery({
    ...base,
    journal: { ...journal, phase: 'stable-source-submit-armed' },
  }).reason, 'journal-boundary-incomplete');
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
    journal: {
      ...journal,
      phase: 'rollback-applied',
      appliedAtMs: 2040,
      restoredTextHash: targetTextHash,
    },
  }).proven, true, 'restart may finish an exact rollback recorded before settlement');
  assert.equal(classifyCodexStableSourceRollbackOutcome({
    ...base,
    journal: { ...journal, phase: 'rollback-applied' },
  }).reason, 'journal-rollback-proof-incomplete');
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
    journal: {
      ...journal,
      phase: 'rollback-applied',
      appliedAtMs: 2010,
      restoredTextHash: targetTextHash,
    },
  }).proven, true, 'legacy false stable-source proof may clear when nothing persisted');
  assert.equal(classifyCodexNativeRewindNoMutationRecovery({
    ...base,
    journal: { ...journal, phase: 'rollback-applied' },
  }).reason, 'journal-rollback-proof-incomplete');
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
