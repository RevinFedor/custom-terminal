'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCodexRewindMessageProof,
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
