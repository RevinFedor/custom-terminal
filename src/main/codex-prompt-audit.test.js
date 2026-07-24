'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  codexAuditRecordIsAfterBoundary,
  codexCanonicalUserMessageMatch,
  normalizeCodexPromptImageSlots,
  partitionCodexPendingPromptAuditsForRetention,
  selectCodexPendingPromptAudit,
} = require('./codex-prompt-audit');

test('same-file identical records before the pre-Enter byte boundary are not causal', () => {
  const audit = {
    sentAt: Date.parse('2026-07-24T16:36:20.000Z'),
    preSubmitBoundary: {
      sessionId: 'writer-a',
      filePath: '/rollouts/writer-a.jsonl',
      fileSize: 1_000,
    },
  };
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'writer-a',
    filePath: '/rollouts/writer-a.jsonl',
    byteOffset: 900,
    timestamp: '2026-07-24T16:36:21.000Z',
  }), false);
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'writer-a',
    filePath: '/rollouts/writer-a.jsonl',
    byteOffset: 1_000,
    timestamp: '2026-07-24T16:36:21.000Z',
  }), true);
});

test('linked-child catch-up rejects copied history and accepts a post-Enter record', () => {
  const audit = {
    sentAt: Date.parse('2026-07-24T16:36:20.000Z'),
    preSubmitBoundary: {
      sessionId: 'source',
      filePath: '/rollouts/source.jsonl',
      fileSize: 5_000,
    },
  };
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'child',
    filePath: '/rollouts/child.jsonl',
    byteOffset: 128,
    timestamp: '2026-07-24T16:30:00.000Z',
  }), false);
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'child',
    filePath: '/rollouts/child.jsonl',
    byteOffset: 10_000,
    timestamp: '2026-07-24T16:36:20.001Z',
  }), true);
});

test('accepts the exact Codex boundary-whitespace normalization seen in production', () => {
  assert.deepEqual(
    codexCanonicalUserMessageMatch(
      { expectedText: ' \nlarge prompt\n\n ' },
      'large prompt',
    ),
    { reason: 'codex_trimmed_boundary_whitespace' },
  );
});

test('accepts leading-only and trailing-only boundary normalization', () => {
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: '\nhello' }, 'hello')?.reason,
    'codex_trimmed_boundary_whitespace',
  );
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: 'hello  \n' }, 'hello')?.reason,
    'codex_trimmed_boundary_whitespace',
  );
});

test('does not hide interior whitespace corruption or truncation', () => {
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: ' hello  world ' }, 'hello world'),
    null,
  );
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: ' complete prompt ' }, 'complete'),
    null,
  );
});

test('keeps image placeholder canonicalization', () => {
  const imagePath = '/tmp/example image.png';
  assert.equal(
    normalizeCodexPromptImageSlots(`before [imagePath: ${imagePath}] after`, [imagePath]),
    'before [Image] after',
  );
  assert.equal(
    codexCanonicalUserMessageMatch(
      {
        expectedText: `before [imagePath: ${imagePath}] after`,
        actualPayload: { local_images: [imagePath] },
      },
      'before [Image #1] after',
    )?.reason,
    'codex_image_placeholder_canonical',
  );
});

test('late A matches its own pending audit after B was staged', () => {
  const auditA = {
    handoffId: 'handoff-a',
    expectedText: 'message A',
    expectedLen: 9,
    expectedHash: 'hash-a',
  };
  const auditB = {
    handoffId: 'handoff-b',
    expectedText: 'message B',
    expectedLen: 9,
    expectedHash: 'hash-b',
  };

  assert.deepEqual(
    selectCodexPendingPromptAudit([auditA, auditB], {
      actualText: 'message A',
      actualHash: 'hash-a',
    }),
    { audit: auditA, canonicalMatch: null },
  );
  assert.deepEqual(
    selectCodexPendingPromptAudit([auditB], {
      actualText: 'message B',
      actualHash: 'hash-b',
    }),
    { audit: auditB, canonicalMatch: null },
  );
});

test('an unrelated user_message does not consume or fail a neighboring audit', () => {
  const audits = [
    {
      handoffId: 'handoff-a',
      expectedText: 'message A',
      expectedLen: 9,
      expectedHash: 'hash-a',
    },
    {
      handoffId: 'handoff-b',
      expectedText: 'message B',
      expectedLen: 9,
      expectedHash: 'hash-b',
    },
  ];
  assert.equal(
    selectCodexPendingPromptAudit(audits, {
      actualText: 'historical message',
      actualHash: 'hash-old',
    }),
    null,
  );
  assert.equal(audits.length, 2);
});

test('selector cannot confirm a new send from an old identical catch-up record', () => {
  const audit = {
    handoffId: 'handoff-new',
    expectedText: 'same prompt',
    expectedLen: 11,
    expectedHash: 'same-hash',
    sentAt: Date.parse('2026-07-24T16:36:20.000Z'),
    preSubmitBoundary: {
      sessionId: 'writer-a',
      filePath: '/rollouts/writer-a.jsonl',
      fileSize: 4_096,
    },
  };
  assert.equal(selectCodexPendingPromptAudit([audit], {
    actualText: 'same prompt',
    actualHash: 'same-hash',
    actualIdentity: {
      sessionId: 'writer-a',
      filePath: '/rollouts/writer-a.jsonl',
      byteOffset: 2_048,
      timestamp: '2026-07-24T16:36:21.000Z',
    },
  }), null);
});

test('unconfirmed audit retention is bounded without classifying delivery as failed', () => {
  const now = 1_000_000;
  const expired = { handoffId: 'expired', sentAt: now - 60_000 };
  const oldestFresh = { handoffId: 'oldest-fresh', sentAt: now - 3_000 };
  const newest = { handoffId: 'newest', sentAt: now - 1_000 };
  const result = partitionCodexPendingPromptAuditsForRetention(
    [expired, oldestFresh, newest],
    { now, maxAgeMs: 30_000, maxPending: 1 },
  );

  assert.deepEqual(result.retained, [newest]);
  assert.deepEqual(result.evicted, [
    { audit: expired, reason: 'age-bound' },
    { audit: oldestFresh, reason: 'count-bound' },
  ]);
  assert.equal('deliveryFailed' in result, false);
});
