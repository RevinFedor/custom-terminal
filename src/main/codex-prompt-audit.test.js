'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  codexAuditRecordIsAfterBoundary,
  codexCanonicalUserMessageMatch,
  consumeCodexUserMessageAuditChunk,
  normalizeCodexPromptImageSlots,
  partitionCodexPendingPromptAuditsForRetention,
  selectCodexPendingPromptAudit,
} = require('./codex-prompt-audit');

test('provisional source audit parser finds a user_message without consuming lifecycle rows', () => {
  const prefix = JSON.stringify({
    timestamp: '2026-07-27T04:07:08.094Z',
    type: 'event_msg',
    payload: { type: 'task_started' },
  }) + '\n';
  const user = JSON.stringify({
    timestamp: '2026-07-27T04:07:13.102Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'Reply only C3-AUDIT-070359' },
  }) + '\n';
  const result = consumeCodexUserMessageAuditChunk({
    chunk: prefix + user,
    incomingStartOffset: 119_292,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].record.payload.message, 'Reply only C3-AUDIT-070359');
  assert.equal(result.records[0].byteOffset, 119_292 + Buffer.byteLength(prefix));
  assert.equal(result.partial, '');
});

test('provisional source audit parser carries a split JSONL row with its original byte offset', () => {
  const line = JSON.stringify({
    timestamp: '2026-07-27T04:07:13.102Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'split audit row' },
  });
  const splitAt = 47;
  const first = consumeCodexUserMessageAuditChunk({
    chunk: line.slice(0, splitAt),
    incomingStartOffset: 240_143,
  });
  assert.equal(first.records.length, 0);

  const second = consumeCodexUserMessageAuditChunk({
    chunk: line.slice(splitAt) + '\n',
    incomingStartOffset: 240_143 + Buffer.byteLength(line.slice(0, splitAt)),
    partial: first.partial,
    partialStartOffset: first.partialStartOffset,
  });
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].byteOffset, 240_143);
  assert.equal(second.records[0].record.payload.message, 'split audit row');
  assert.equal(second.partial, '');
});

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

test('12:51 production Resume send admits the 183-char child turn only after Enter', () => {
  const sourceSessionId = '019fc1f7-3c5c-76a1-99af-49b919b412dd';
  const childSessionId = '019fc276-a21a-71f3-98d0-01d2236e0e45';
  const handoffId = '6c6d344a-8d7a-4422-8c8b-dbe3495570f0';
  const prompt = 'P'.repeat(183);
  const assistantAnswer = 'A'.repeat(415);
  const audit = {
    handoffId,
    expectedText: prompt,
    expectedLen: prompt.length,
    expectedHash: 'production-prompt-hash',
    sentAt: Date.parse('2026-08-02T12:51:20.313Z'),
    preSubmitBoundary: {
      sessionId: sourceSessionId,
      filePath: '/rollouts/' + sourceSessionId + '.jsonl',
      fileSize: 97_000,
    },
  };
  assert.equal(selectCodexPendingPromptAudit([audit], {
    actualText: prompt,
    actualHash: audit.expectedHash,
    actualIdentity: {
      sessionId: childSessionId,
      filePath: '/rollouts/' + childSessionId + '.jsonl',
      byteOffset: 12_000,
      timestamp: '2026-08-02T12:51:20.200Z',
    },
  }), null, 'a copied/pre-Enter child row is not causal');
  assert.deepEqual(selectCodexPendingPromptAudit([audit], {
    actualText: prompt,
    actualHash: audit.expectedHash,
    actualIdentity: {
      sessionId: childSessionId,
      filePath: '/rollouts/' + childSessionId + '.jsonl',
      byteOffset: 12_400,
      timestamp: '2026-08-02T12:51:20.504Z',
    },
  }), { audit, canonicalMatch: null });
  assert.equal(prompt.length, 183);
  assert.equal(assistantAnswer.length, 415);
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
