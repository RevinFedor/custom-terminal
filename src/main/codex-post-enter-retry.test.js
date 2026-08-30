'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCodexPostEnterRetryAdmission,
  classifyCodexPostEnterRetryCapture,
} = require('./codex-post-enter-retry');

function audit(overrides = {}) {
  return {
    submitWritten: true,
    finished: false,
    enterRetryCount: 0,
    sendAttemptId: 'attempt-1',
    enterRunSeq: 7,
    enterLifecycleGeneration: 'life-1',
    enterInputRevision: 11,
    expectedText: 'hello',
    expectedImagePaths: [],
    ...overrides,
  };
}

function record(overrides = {}) {
  return { attemptId: 'attempt-1', state: 'audit-pending', ...overrides };
}

test('post-Enter retry admission requires the same unresolved attempt and untouched input', () => {
  assert.equal(classifyCodexPostEnterRetryAdmission({
    timeoutResult: { error: 'codex_user_message_audit_timeout' },
    audit: audit(),
    durableRecord: record(),
    terminalSame: true,
    currentRunSeq: 7,
    currentLifecycleGeneration: 'life-1',
    currentInputRevision: 11,
    turnBusy: false,
    writeQueueOwned: true,
  }).retry, true);

  assert.equal(classifyCodexPostEnterRetryAdmission({
    timeoutResult: { error: 'codex_user_message_audit_timeout' },
    audit: audit(),
    durableRecord: record(),
    terminalSame: true,
    currentRunSeq: 7,
    currentLifecycleGeneration: 'life-1',
    currentInputRevision: 12,
    turnBusy: false,
    writeQueueOwned: true,
  }).reason, 'input-ownership-changed');
  assert.equal(classifyCodexPostEnterRetryAdmission({
    timeoutResult: { error: 'codex_user_message_audit_timeout' },
    audit: audit(),
    durableRecord: record(),
    terminalSame: true,
    currentRunSeq: 7,
    currentLifecycleGeneration: 'life-1',
    currentInputRevision: 11,
    turnBusy: true,
    writeQueueOwned: true,
  }).reason, 'turn-started-before-retry');
});

test('exact captured draft authorizes one retry after the owned Ctrl+G transition', () => {
  const result = classifyCodexPostEnterRetryCapture({
    audit: audit(),
    durableRecord: record(),
    capture: {
      success: true,
      terminalIdentityStable: true,
      terminalRunSeq: 7,
      terminalLifecycleGeneration: 'life-1',
      inputRevision: 12,
      text: 'hello',
      images: 0,
      imagePaths: [],
    },
    terminalSame: true,
    turnBusy: false,
    currentInputRevision: 12,
    captureInputRevision: 11,
    currentRunSeq: 7,
    currentLifecycleGeneration: 'life-1',
    writeQueueOwned: true,
  });
  assert.deepEqual(result, {
    retry: true,
    reason: 'exact-draft-still-in-composer',
    canonicalized: false,
  });
});

test('one unchanged image slot may use canonical draft text but multiple unresolved slots fail closed', () => {
  const one = audit({
    expectedText: '/tmp/a.png\nquestion',
    expectedImagePaths: ['/tmp/a.png'],
  });
  const base = {
    audit: one,
    durableRecord: record(),
    terminalSame: true,
    turnBusy: false,
    currentInputRevision: 12,
    captureInputRevision: 11,
    currentRunSeq: 7,
    currentLifecycleGeneration: 'life-1',
    writeQueueOwned: true,
  };
  assert.equal(classifyCodexPostEnterRetryCapture({
    ...base,
    capture: {
      success: true,
      terminalIdentityStable: true,
      terminalRunSeq: 7,
      terminalLifecycleGeneration: 'life-1',
      inputRevision: 12,
      text: '[Image #1]\nquestion',
      images: 1,
      imagePaths: [],
    },
  }).retry, true);

  const multiple = audit({
    expectedText: '/tmp/a.png /tmp/b.png question',
    expectedImagePaths: ['/tmp/a.png', '/tmp/b.png'],
  });
  assert.equal(classifyCodexPostEnterRetryCapture({
    ...base,
    audit: multiple,
    capture: {
      success: true,
      terminalIdentityStable: true,
      terminalRunSeq: 7,
      terminalLifecycleGeneration: 'life-1',
      inputRevision: 12,
      text: '[Image #1] [Image #2] question',
      images: 2,
      imagePaths: [],
    },
  }).reason, 'multiple-image-identity-unresolved');
});

test('capture refuses retry after lifecycle or durable attempt changes', () => {
  const result = classifyCodexPostEnterRetryCapture({
    audit: audit(),
    durableRecord: record({ state: 'confirmed' }),
    capture: { success: true, terminalIdentityStable: true },
    terminalSame: true,
    turnBusy: false,
    currentInputRevision: 12,
    captureInputRevision: 11,
    currentRunSeq: 7,
    currentLifecycleGeneration: 'life-1',
    writeQueueOwned: true,
  });
  assert.equal(result.reason, 'durable-attempt-settled-during-capture');
});
